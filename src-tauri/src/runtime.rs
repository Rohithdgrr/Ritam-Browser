//! Phase 2 runtime: tab lifecycle, the single navigation service, and event
//! fan-out to the chrome UI (`contracts/ipc.md`).
//!
//! ## Threading model (why it is shaped like this)
//!
//! Tauri runs webview callbacks (`on_navigation`, `on_page_load`,
//! `on_window_event`) on the UI thread while IPC commands run on worker
//! threads. Dispatcher calls such as `Webview::navigate` block until the UI
//! thread has processed them, so a callback that took the same mutex a
//! command holds would deadlock (command waits for the UI thread, the UI
//! thread waits for the mutex).
//!
//! Therefore:
//!
//! * callbacks **never** lock state — they only enqueue a [`Msg`] on an
//!   unbounded channel (the UI thread must never block);
//! * one drainer thread owns the shared state, applies messages, and emits
//!   coalesced `nav:state` events (contract §1 backpressure);
//! * commands lock the state, mutate it, and issue dispatcher calls while
//!   holding it — safe because no callback ever waits for that lock.

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::webview::{DownloadEvent, PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Emitter, Manager, Webview, WebviewBuilder, WebviewUrl, Wry};
use url::Url;

use ritam_browser_core::nav::{self, NavTarget};

use crate::shell::{content_bounds, relayout};
use crate::state::{
    origin_of, IpcError, NavOutcome, NavState, StateCoalescer, TabHistory, TabId, TabSet,
};

/// App-relative path of the new-tab page (served from the app origin).
pub const HOME_PATH: &str = "newtab.html";

/// How often coalesced `nav:state` events are flushed to the UI.
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// Why the next observed navigation is treated the way it is.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Pending {
    /// Nothing requested: an in-page link click (push onto the stack).
    #[default]
    None,
    /// A typed/programmatic navigation: it replaces the current entry, which
    /// also absorbs redirect hops (each arrives as another navigation).
    Requested,
    /// A back/forward step whose cursor move the command already applied.
    HistoryStep,
}

/// One open tab: published state, runtime-recorded history, webview.
pub struct TabRecord {
    pub state: NavState,
    pub history: TabHistory,
    pub webview: Option<Webview<Wry>>,
    pending: Pending,
}

/// Messages from UI-thread callbacks (never blocking) to the drainer.
pub enum Msg {
    Navigate {
        tab: TabId,
        url: String,
    },
    LoadStart {
        tab: TabId,
        url: String,
    },
    LoadEnd {
        tab: TabId,
        url: String,
    },
    Meta {
        tab: TabId,
        title: String,
        favicon: Option<String>,
    },
    Relayout {
        width: f64,
        height: f64,
    },
}

/// Shared tab state plus the enqueue-only sender used by callbacks.
pub struct Shared {
    rt: Mutex<BrowserRuntime>,
    tx: Sender<Msg>,
    app: AppHandle<Wry>,
}

/// The tab model. Only the drainer thread and IPC commands touch it.
pub struct BrowserRuntime {
    pub tabs: TabSet,
    records: HashMap<TabId, TabRecord>,
    coalescer: StateCoalescer,
}

impl BrowserRuntime {
    fn new() -> Self {
        Self {
            tabs: TabSet::new(),
            records: HashMap::new(),
            coalescer: StateCoalescer::new(),
        }
    }

    pub fn snapshot(&self) -> Vec<NavState> {
        self.tabs
            .order
            .iter()
            .filter_map(|id| self.records.get(id).map(|r| r.state.clone()))
            .collect()
    }

    pub fn state_of(&self, id: TabId) -> Option<NavState> {
        self.records.get(&id).map(|r| r.state.clone())
    }

    fn empty_state(id: TabId) -> NavState {
        NavState {
            tab_id: id,
            url: String::new(),
            title: String::new(),
            origin: None,
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            favicon_url: None,
        }
    }

    /// Reserve a tab id and record; the webview is attached separately.
    fn create(&mut self, url: Option<&str>) -> TabId {
        let id = self.tabs.alloc_id();
        let start = url.unwrap_or("");
        self.tabs.push(id);
        // ROT (PLAN.md item 10): the first tab becomes active immediately, so
        // any `tab_list` read - even one racing setup - reports a live id and
        // never the sentinel 0.
        if self.tabs.order.len() == 1 {
            self.tabs.active = id;
        }
        self.records.insert(
            id,
            TabRecord {
                state: NavState {
                    origin: origin_of(start),
                    ..Self::empty_state(id)
                }
                .with_url(start),
                history: TabHistory::new(),
                webview: None,
                pending: Pending::None,
            },
        );
        id
    }

    fn record_mut(&mut self, id: TabId) -> Result<&mut TabRecord, IpcError> {
        self.records
            .get_mut(&id)
            .ok_or_else(|| IpcError::new("tab_not_found", format!("tab {id} does not exist")))
    }

    /// Start a navigation (URL already resolved and policy-checked).
    fn request_navigation(&mut self, id: TabId, url: &str) -> Result<NavState, IpcError> {
        let rec = self.record_mut(id)?;
        let parsed = Url::parse(url)
            .map_err(|e| IpcError::with_detail("invalid_input", "not a valid URL", e.to_string()))?;
        if !nav::scheme_allows_navigation(&parsed) {
            return Err(IpcError::new(
                "unsupported_scheme",
                format!("the `{}` scheme is not allowed here", parsed.scheme()),
            ));
        }
        let wv = rec.webview.clone().ok_or_else(|| {
            IpcError::new("internal", "tab has no webview attached yet (runtime still starting)")
        })?;
        rec.pending = Pending::Requested;
        rec.state.url = url.to_string();
        rec.state.origin = origin_of(url);
        rec.state.loading = true;
        rec.state.title = String::new();
        rec.state.favicon_url = None;
        let state = rec.state.clone();
        wv.navigate(parsed)
            .map_err(|e| IpcError::with_detail("navigation_failed", "navigate failed", e.to_string()))?;
        Ok(state)
    }

    /// Back/forward: move the recorded cursor first (so the observed
    /// navigation does not push a new entry), rolling back on failure.
    fn step(&mut self, id: TabId, back: bool) -> Result<NavState, IpcError> {
        let rec = self.record_mut(id)?;
        let target = if back {
            rec.history.peek_back().map(str::to_string)
        } else {
            rec.history.peek_forward().map(str::to_string)
        };
        let target = target.ok_or_else(|| {
            IpcError::new(
                "nav_unavailable",
                if back {
                    "no previous page in this tab"
                } else {
                    "no forward page in this tab"
                },
            )
        })?;
        let parsed = Url::parse(&target).map_err(|_| {
            IpcError::with_detail("internal", "history entry is not a valid URL", &target)
        })?;
        let wv = rec
            .webview
            .clone()
            .ok_or_else(|| IpcError::new("internal", "tab has no webview attached yet"))?;
        let previous_url = rec.state.url.clone();
        let previous_origin = rec.state.origin.clone();

        rec.pending = Pending::HistoryStep;
        if back {
            rec.history.move_back();
        } else {
            rec.history.move_forward();
        }
        rec.state.url = target;
        rec.state.origin = origin_of(&rec.state.url);
        rec.state.loading = true;
        let state = rec.state.clone();

        if let Err(e) = wv.navigate(parsed) {
            if back {
                rec.history.move_forward();
            } else {
                rec.history.move_back();
            }
            rec.pending = Pending::None;
            rec.state.url = previous_url;
            rec.state.origin = previous_origin;
            rec.state.loading = false;
            return Err(IpcError::with_detail(
                "navigation_failed",
                "navigate failed",
                e.to_string(),
            ));
        }
        Ok(state)
    }

    fn set_loading(&mut self, id: TabId, url: &str, loading: bool) {
        if let Some(rec) = self.records.get_mut(&id) {
            if !url.is_empty() {
                rec.state.url = url.to_string();
                rec.state.origin = origin_of(url);
            }
            rec.state.loading = loading;
            let state = rec.state.clone();
            self.coalescer.push(state);
        }
    }

    /// Apply an observed navigation to the recorded history (contract §7.1).
    fn apply_navigation(&mut self, id: TabId, url: &str) {
        let Some(rec) = self.records.get_mut(&id) else {
            return;
        };
        match rec.pending {
            Pending::Requested => rec.history.replace_top(url),
            // The command already moved the cursor for an explicit step.
            Pending::HistoryStep => {}
            // In-page navigation. WebView2 exposes no GoBack/GoForward, so a
            // native accelerator (Alt+Left, Backspace) arrives here as well:
            // if the URL matches a neighbouring stack entry, treat it as the
            // history step it really is instead of pushing a duplicate.
            Pending::None => {
                if rec.history.peek_back() == Some(url) {
                    rec.history.move_back();
                } else if rec.history.peek_forward() == Some(url) {
                    rec.history.move_forward();
                } else {
                    rec.history.push(url);
                }
            }
        }
        rec.state.url = url.to_string();
        rec.state.origin = origin_of(url);
        let state = rec.state.clone();
        self.coalescer.push(state);
    }

    fn end_navigation(&mut self, id: TabId) {
        if let Some(rec) = self.records.get_mut(&id) {
            rec.pending = Pending::None;
            rec.state.loading = false;
            let state = rec.state.clone();
            self.coalescer.push(state);
        }
    }

    fn apply_meta(&mut self, id: TabId, title: &str, favicon: Option<String>) {
        if let Some(rec) = self.records.get_mut(&id) {
            rec.state.title = title.to_string();
            rec.state.favicon_url = favicon;
            let state = rec.state.clone();
            self.coalescer.push(state);
        }
    }
}

impl Shared {
    pub fn new(app: AppHandle<Wry>, tx: Sender<Msg>) -> Self {
        Self {
            rt: Mutex::new(BrowserRuntime::new()),
            tx,
            app,
        }
    }

    pub fn lock(&self) -> MutexGuard<'_, BrowserRuntime> {
        self.rt.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Enqueue from anywhere that already holds the shared handle.
    pub fn send(&self, msg: Msg) {
        let _ = self.tx.send(msg);
    }

    fn emit(&self, event: &str, payload: impl serde::Serialize + Clone) {
        // Failures are logged, never swallowed: an emit that does not reach
        // the chrome is a UI-deadness bug (contract §10 found exactly that).
        if let Err(e) = self.app.emit(event, payload) {
            eprintln!("ritam: emit {event} failed: {e}");
        }
    }

    /// Flush every coalesced `nav:state` (contract §1: latest wins per tab).
    pub fn flush(&self) {
        let states = self.lock().coalescer.take_all();
        for state in states {
            self.emit("nav:state", state.clone());
        }
    }

    // --- commands ----------------------------------------------------------

    pub fn create_tab(&self, url: Option<&str>) -> Result<NavState, IpcError> {
        let id = self.lock().create(url);
        let state = self
            .lock()
            .state_of(id)
            .unwrap_or_else(|| BrowserRuntime::empty_state(id));
        // `tab:activated` is emitted by `select_tab`, which every `tab_create`
        // invocation performs right after this (contract §3).
        self.emit("tab:created", json!({ "tab": state }));
        Ok(state)
    }

    /// Create the tab's webview, wire its callbacks, and start navigation.
    /// Callbacks only capture a cloned `Sender` (enqueue-only, never locks).
    pub fn attach(&self, id: TabId) -> Result<NavState, IpcError> {
        let window = self
            .app
            .get_window("main")
            .ok_or_else(|| IpcError::new("internal", "main window is missing"))?;
        let bounds = content_bounds(&window);
        let start_url = {
            let rt = self.lock();
            let rec = rt
                .records
                .get(&id)
                .ok_or_else(|| IpcError::new("tab_not_found", format!("tab {id} does not exist")))?;
            rec.state.url.clone()
        };

        // Choose the initial document: a real URL when one was requested,
        // otherwise the new-tab page served from the app origin.
        let initial = Url::parse(&start_url)
            .ok()
            .filter(|u| nav::scheme_allows_navigation(u));
        if initial.is_some() {
            // The first observed navigation replaces this entry (Pending).
            self.lock().records.get_mut(&id).map(|r| r.pending = Pending::Requested);
        }
        let webview_url = match &initial {
            Some(u) => WebviewUrl::External(u.clone()),
            None => WebviewUrl::App(HOME_PATH.into()),
        };

        let on_nav = {
            let tx = self.tx.clone();
            move |u: &Url| {
                if nav::scheme_allows_navigation(u) {
                    let _ = tx.send(Msg::Navigate {
                        tab: id,
                        url: u.to_string(),
                    });
                    true
                } else {
                    // Contract §4.2: a page may not leave the policy.
                    false
                }
            }
        };
        let on_load = {
            let tx = self.tx.clone();
            move |_wv: Webview<Wry>, payload: PageLoadPayload<'_>| {
                let url = payload.url().to_string();
                let msg = match payload.event() {
                    PageLoadEvent::Started => Msg::LoadStart { tab: id, url },
                    PageLoadEvent::Finished => Msg::LoadEnd { tab: id, url },
                };
                let _ = tx.send(msg);
            }
        };
        // Phase 3 support: real download lifecycle events for the chrome UI
        // and Devi's store. The default destination is left untouched, so the
        // path reported later is WebView2's own real path.
        let on_download = {
            let handle = self.app.clone();
            move |wv: Webview<Wry>, event: DownloadEvent<'_>| {
                let tab_id = tab_id_from_label(wv.label());
                match event {
                    DownloadEvent::Requested { url, destination } => {
                        let filename = destination
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or_default()
                            .to_string();
                        if let Err(e) = handle.emit(
                            "download:started",
                            json!({ "tab_id": tab_id, "url": url.to_string(), "filename": filename }),
                        ) {
                            eprintln!("ritam: emit download:started failed: {e}");
                        }
                    }
                    DownloadEvent::Finished { url, path, success } => {
                        if let Err(e) = handle.emit(
                            "download:finished",
                            json!({
                                "tab_id": tab_id,
                                "url": url.to_string(),
                                "path": path.as_ref().map(|p| p.display().to_string()),
                                "success": success
                            }),
                        ) {
                            eprintln!("ritam: emit download:finished failed: {e}");
                        }
                    }
                    _ => {}
                }
                // Let WebView2 perform the download (returning false cancels
                // it, which we only ever do if the owner asks for that).
                true
            }
        };

        let builder = WebviewBuilder::new(format!("tab-{id}"), webview_url)
            .on_navigation(on_nav)
            .on_page_load(on_load)
            .on_download(on_download);

        let webview = window.add_child(builder, bounds.position, bounds.size).map_err(|e| {
            IpcError::with_detail("internal", "could not create the tab webview", e.to_string())
        })?;

        {
            let mut rt = self.lock();
            let was_active = rt.tabs.active;
            let rec = rt.record_mut(id)?;
            rec.webview = Some(webview);
            // Hidden until selected, so only the active tab is on screen.
            if was_active != id {
                if let Some(wv) = &rec.webview {
                    let _ = wv.hide();
                }
            }
        }

        let state = self
            .lock()
            .state_of(id)
            .unwrap_or_else(|| BrowserRuntime::empty_state(id));
        Ok(state)
    }

    pub fn select_tab(&self, id: TabId) -> Result<NavState, IpcError> {
        let mut rt = self.lock();
        if !rt.tabs.contains(id) {
            return Err(IpcError::new("tab_not_found", format!("tab {id} does not exist")));
        }
        rt.tabs.active = id;
        let mut focusable = Vec::new();
        for (tid, rec) in rt.records.iter_mut() {
            if let Some(wv) = rec.webview.as_ref() {
                if *tid == id {
                    let _ = wv.show();
                    focusable.push(wv.clone());
                } else {
                    let _ = wv.hide();
                }
            }
        }
        let state = rt.state_of(id).expect("checked above");
        drop(rt);
        if let Some(wv) = focusable.first() {
            let _ = wv.set_focus();
        }
        self.emit("tab:activated", json!({ "tab_id": id }));
        Ok(state)
    }

    /// Close a tab. Last-tab safety: closing the final tab opens a fresh
    /// new-tab page instead of leaving the window with zero tabs.
    pub fn close_tab(&self, id: TabId) -> Result<Value, IpcError> {
        let (active, closed_webview, reopened) = {
            let mut rt = self.lock();
            if !rt.tabs.contains(id) {
                return Err(IpcError::new("tab_not_found", format!("tab {id} does not exist")));
            }
            let next = rt.tabs.pick_after_close(id);
            rt.tabs.remove(id);
            let record = rt.records.remove(&id);
            let webview = record.and_then(|r| r.webview);
            let reopened = match next {
                Some(n) => {
                    rt.tabs.active = n;
                    if let Some(wv) = rt.records.get(&n).and_then(|r| r.webview.clone()) {
                        let _ = wv.show();
                        let _ = wv.set_focus();
                    }
                    None
                }
                None => {
                    let nid = rt.create(None);
                    rt.tabs.active = nid;
                    Some(nid)
                }
            };
            (rt.tabs.active, webview, reopened)
        };

        if let Some(wv) = closed_webview {
            let _ = wv.close();
        }
        self.emit("tab:closed", json!({ "tab_id": id }));

        if let Some(nid) = reopened {
            self.attach(nid)?;
            let state = self
                .lock()
                .state_of(nid)
                .unwrap_or_else(|| BrowserRuntime::empty_state(nid));
            self.emit("tab:created", json!({ "tab": state }));
            self.emit("tab:activated", json!({ "tab_id": nid }));
        } else {
            self.emit("tab:activated", json!({ "tab_id": active }));
        }
        Ok(json!({ "closed": id, "active_tab_id": active }))
    }

    pub fn submit(&self, id: TabId, input: &str) -> Result<NavOutcome, IpcError> {
        match nav::classify(input) {
            NavTarget::Navigate { url } => {
                let state = self.lock().request_navigation(id, &url)?;
                Ok(NavOutcome::Navigated { url, state })
            }
            NavTarget::Search { url, query } => {
                let state = self.lock().request_navigation(id, &url)?;
                Ok(NavOutcome::Search { url, query, state })
            }
            NavTarget::External { url, scheme } => Ok(NavOutcome::External {
                origin: origin_of(&url),
                url,
                scheme,
            }),
            NavTarget::Rejected { code, message } => Ok(NavOutcome::Rejected {
                error: IpcError::new(code, message),
            }),
        }
    }

    pub fn go_back(&self, id: TabId) -> Result<NavState, IpcError> {
        self.lock().step(id, true)
    }

    pub fn go_forward(&self, id: TabId) -> Result<NavState, IpcError> {
        self.lock().step(id, false)
    }

    pub fn reload(&self, id: TabId) -> Result<NavState, IpcError> {
        let (wv, state) = {
            let mut rt = self.lock();
            let rec = rt.record_mut(id)?;
            rec.pending = Pending::Requested;
            rec.state.loading = true;
            let state = rec.state.clone();
            let wv = rec
                .webview
                .clone()
                .ok_or_else(|| IpcError::new("internal", "tab has no webview attached yet"))?;
            (wv, state)
        };
        wv.reload()
            .map_err(|e| IpcError::with_detail("navigation_failed", "reload failed", e.to_string()))?;
        {
            let mut rt = self.lock();
            rt.coalescer.push(state.clone());
        }
        self.flush();
        Ok(state)
    }

    pub fn stop(&self, id: TabId) -> Result<NavState, IpcError> {
        // Tauri's WebView2 surface has no Stop(); `window.stop()` is the
        // real document-level stop, invoked in the page being loaded.
        let mut rt = self.lock();
        let rec = rt.record_mut(id)?;
        let wv = rec
            .webview
            .clone()
            .ok_or_else(|| IpcError::new("internal", "tab has no webview attached yet"))?;
        wv.eval("window.stop()")
            .map_err(|e| IpcError::with_detail("navigation_failed", "stop failed", e.to_string()))?;
        Ok(rec.state.clone())
    }

    pub fn home(&self, id: TabId) -> Result<NavState, IpcError> {
        let wv = {
            let mut rt = self.lock();
            let rec = rt.record_mut(id)?;
            rec.pending = Pending::Requested;
            rec.state.loading = true;
            rec.state.title = String::new();
            rec.state.favicon_url = None;
            rec.webview.clone().ok_or_else(|| {
                IpcError::new("internal", "tab has no webview attached yet")
            })?
        };
        // Re-create the webview at the new-tab URL by navigating to the app
        // origin; the observed navigation updates url/origin for real.
        let home = Url::parse(&format!("tauri://localhost/{HOME_PATH}")).map_err(|e| {
            IpcError::with_detail("internal", "home url", e.to_string())
        })?;
        wv.navigate(home)
            .map_err(|e| IpcError::with_detail("navigation_failed", "home failed", e.to_string()))?;
        let state = self.lock().state_of(id).unwrap_or_else(|| {
            BrowserRuntime::empty_state(id)
        });
        {
            let mut rt = self.lock();
            rt.coalescer.push(state.clone());
        }
        self.flush();
        Ok(state)
    }

    // --- drainer -----------------------------------------------------------

    fn handle(&self, msg: Msg) {
        match msg {
            Msg::Navigate { tab, url } => self.lock().apply_navigation(tab, &url),
            Msg::LoadStart { tab, url } => self.lock().set_loading(tab, &url, true),
            Msg::LoadEnd { tab, url } => {
                {
                    let mut rt = self.lock();
                    rt.set_loading(tab, &url, false);
                    rt.end_navigation(tab);
                }
                self.request_meta(tab);
            }
            Msg::Meta { tab, title, favicon } => {
                self.lock().apply_meta(tab, &title, favicon)
            }
            Msg::Relayout { width, height } => {
                let webviews: Vec<Webview<Wry>> = {
                    let rt = self.lock();
                    rt.records.values().filter_map(|r| r.webview.clone()).collect()
                };
                relayout(&self.app, &webviews, width, height);
            }
        }
    }

    /// Read the real document title and page-declared favicon after load.
    fn request_meta(&self, tab: TabId) {
        let webview = self.lock().records.get(&tab).and_then(|r| r.webview.clone());
        let Some(wv) = webview else { return };
        let tx = self.tx.clone();
        let expr = r#"JSON.stringify({t:document.title,f:(document.querySelector('link[rel~="icon"]')||{}).href||null})"#;
        let _ = wv.eval_with_callback(expr, move |raw| {
            let (title, favicon) = parse_page_meta(&raw);
            let _ = tx.send(Msg::Meta {
                tab,
                title,
                favicon,
            });
        });
    }

    /// Re-layout tab webviews after a window resize. `width`/`height` are
    /// physical pixels straight from `WindowEvent::Resized`.
    pub fn queue_relayout(&self, width: f64, height: f64) {
        self.send(Msg::Relayout { width, height });
    }
}

/// Tab id encoded in a content webview label (`tab-3`), or `None` when a
/// label does not follow the convention (never guessed from anything else).
fn tab_id_from_label(label: &str) -> Option<TabId> {
    label.strip_prefix("tab-")?.parse().ok()
}

/// Parse the page-meta payload, tolerating whether the runtime hands the
/// callback a raw string or a JSON-encoded string (Tauri has done both).
fn parse_page_meta(raw: &str) -> (String, Option<String>) {
    let mut current = raw.trim().to_string();
    for _ in 0..2 {
        match serde_json::from_str::<serde_json::Value>(&current) {
            Ok(serde_json::Value::String(inner)) => current = inner,
            Ok(serde_json::Value::Object(map)) => {
                let title = map
                    .get("t")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let favicon = map.get("f").and_then(|v| v.as_str()).map(str::to_string);
                return (title, favicon);
            }
            _ => break,
        }
    }
    (current, None)
}

/// Run the drainer loop: apply messages, flush coalesced events on an
/// interval so the UI receives at most one `nav:state` per tab per tick.
pub fn spawn_drainer(shared: Arc<Shared>, rx: Receiver<Msg>) {
    std::thread::Builder::new()
        .name("ritam-drainer".into())
        .spawn(move || loop {
            match rx.recv_timeout(FLUSH_INTERVAL) {
                Ok(msg) => {
                    shared.handle(msg);
                    shared.flush();
                }
                Err(RecvTimeoutError::Timeout) => shared.flush(),
                Err(RecvTimeoutError::Disconnected) => break,
            }
        })
        .expect("could not start the runtime drainer thread");
}

/// The message type is private to this module; `Shared::new` needs the
/// sender half, so the channel is created here.
pub fn channel() -> (Sender<Msg>, Receiver<Msg>) {
    std::sync::mpsc::channel()
}

impl NavState {
    fn with_url(mut self, url: &str) -> Self {
        self.url = url.to_string();
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_page_meta_handles_both_encodings() {
        let object = r#"{"t":"Title","f":"https://x/y.png"}"#;
        assert_eq!(
            parse_page_meta(object),
            ("Title".to_string(), Some("https://x/y.png".to_string()))
        );
        // JSON-encoded string containing the object
        let encoded = serde_json::to_string(object).unwrap();
        assert_eq!(
            parse_page_meta(&encoded),
            ("Title".to_string(), Some("https://x/y.png".to_string()))
        );
        // plain text fallback
        assert_eq!(
            parse_page_meta("Plain title"),
            ("Plain title".to_string(), None)
        );
    }

    #[test]
    fn requested_navigation_absorbs_redirect_hops() {
        let mut rt = BrowserRuntime::new();
        let id = rt.create(Some("https://a.test"));
        {
            let rec = rt.records.get_mut(&id).unwrap();
            rec.pending = Pending::Requested;
        }
        rt.apply_navigation(id, "https://a.test");
        // a redirect hop from the same logical navigation
        rt.records.get_mut(&id).unwrap().pending = Pending::Requested;
        rt.apply_navigation(id, "https://a.test/landing");

        let rec = rt.records.get(&id).unwrap();
        assert_eq!(rec.state.url, "https://a.test/landing");
        // one logical navigation == one history entry
        assert!(!rec.history.can_go_back());
        assert!(!rec.history.can_go_forward());
    }

    #[test]
    fn link_click_pushes_and_native_back_moves() {
        let mut rt = BrowserRuntime::new();
        let id = rt.create(Some("https://a.test"));
        rt.records.get_mut(&id).unwrap().pending = Pending::Requested;
        rt.apply_navigation(id, "https://a.test");
        rt.end_navigation(id);

        // in-page link click
        rt.apply_navigation(id, "https://b.test");
        rt.end_navigation(id);
        {
            let rec = rt.records.get(&id).unwrap();
            assert!(rec.history.can_go_back());
            assert!(!rec.history.can_go_forward());
        }

        // a native accelerator back arrives with no pending intent and lands
        // on exactly the previous entry: the cursor must move, not push.
        rt.apply_navigation(id, "https://a.test");
        rt.end_navigation(id);
        let rec = rt.records.get(&id).unwrap();
        assert!(!rec.history.can_go_back());
        assert!(rec.history.can_go_forward());
        assert_eq!(rec.state.url, "https://a.test");
    }

    #[test]
    fn explicit_history_step_does_not_push() {
        let mut rt = BrowserRuntime::new();
        let id = rt.create(Some("https://a.test"));
        rt.records.get_mut(&id).unwrap().pending = Pending::Requested;
        rt.apply_navigation(id, "https://a.test");
        rt.end_navigation(id);
        rt.apply_navigation(id, "https://b.test");
        rt.end_navigation(id);

        // the command moves the cursor first, then observes the navigation
        rt.records.get_mut(&id).unwrap().pending = Pending::HistoryStep;
        rt.records.get_mut(&id).unwrap().history.move_back();
        rt.apply_navigation(id, "https://a.test");

        let rec = rt.records.get(&id).unwrap();
        assert!(!rec.history.can_go_back());
        assert!(rec.history.can_go_forward());
        assert_eq!(rec.state.url, "https://a.test");
    }
}

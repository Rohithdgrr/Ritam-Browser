//! The Ritam Browser host (Rohan): window/chrome wiring, the typed command
//! surface of `contracts/ipc.md`, and the Obscura engine handle.
//!
//! Honest by construction (AGENTS.md §6):
//!   * the window is the real configured OS window, the chrome and the tabs
//!     are real child webviews, and geometry comes from real resize events;
//!   * `engine:status` reports what the engine actually did (started or not
//!     with the engine's own reason) — never an assumed "ready";
//!   * `external_open` launches only what the classifier called an external
//!     protocol, and only after the UI showed the §4.3 confirmation dialog.
//!
//! Threading: commands run on worker threads and lock the shared runtime;
//! webview callbacks run on the UI thread and only enqueue messages. The
//! reasoning lives at the top of `runtime.rs`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runtime;
mod shell;
mod state;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Emitter, Manager};

use ritam_browser_core::engine::{
    verify_parity, CdpEngine, CliEngine, EngineStatus, ObscuraEngine,
};
use ritam_browser_core::nav::{self, NavTarget};

use crate::runtime::Shared;
use crate::state::{IpcError, NavOutcome, NavState, TabId};

/// The pinned Obscura binary (AGENTS.md §7). `OBSCURA_BIN` overrides it for
/// tests; otherwise the installed layout wins (the release CI stages the
/// SHA-256-verified engine into `resources/engine/` and Tauri ships it next
/// to the executable), then the dev-checkout copy verified per
/// `docs/DEPENDENCIES.md`.
fn engine_binary_path() -> PathBuf {
    if let Ok(p) = std::env::var("OBSCURA_BIN") {
        return PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let installed = dir.join("resources").join("engine").join("obscura.exe");
            if installed.is_file() {
                return installed;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tools")
        .join("obscura-bin")
        .join("obscura.exe")
}

/// One Obscura integration for the process: the CLI transport plus the single
/// long-lived `obscura serve` CDP server. Started before the window so the
/// first `engine:status` the UI receives is already the truth.
struct EngineState {
    bin: PathBuf,
    cli: CliEngine,
    cdp: Option<Arc<CdpEngine>>,
}

impl EngineState {
    fn start(bin: PathBuf) -> Self {
        let cdp = match CdpEngine::start(bin.clone(), false) {
            Ok(engine) => Some(Arc::new(engine)),
            Err(detail) => {
                // Not fatal: the browser must run without the engine and say so.
                eprintln!("ritam: obscura serve did not start: {detail}");
                None
            }
        };
        let cli = CliEngine::new(bin.clone(), false);
        Self { bin, cli, cdp }
    }

    /// The honest status the UI shows (contract §2 `EngineStatus`).
    fn status(&self) -> EngineStatus {
        match &self.cdp {
            Some(cdp) => cdp.status(),
            None => EngineStatus::Unavailable {
                version: self.cli.version().ok(),
                endpoint: None,
                pid: None,
                detail: "CDP server not running; only the CLI transport is available".into(),
            },
        }
    }
}

// --- commands (contracts/ipc.md §3) ----------------------------------------
//
// `rename_all = "snake_case"` makes the JS argument keys exactly the names
// written in the contract (`tab_id`, `input`, ...).

#[tauri::command(rename_all = "snake_case")]
fn runtime_info(app: AppHandle) -> Value {
    json!({
        "app_version": env!("CARGO_PKG_VERSION"),
        "runtime": "tauri-2",
        "webview2_version": shell::webview2_version(),
        "engine": app.state::<Arc<EngineState>>().status(),
    })
}

#[tauri::command(rename_all = "snake_case")]
fn tab_list(app: AppHandle) -> Value {
    let shared = app.state::<Arc<Shared>>();
    let rt = shared.lock();
    json!({ "tabs": rt.snapshot(), "active_tab_id": rt.tabs.active })
}

/// Webview creation happens inside this command (`attach`), and Tauri runs
/// sync commands on the main thread — creating a WebView2 controller inline
/// inside an in-loop dispatch deadlocks (the completion is never pumped).
/// `async` moves the whole body off the main thread, so `add_child` is
/// marshalled through `run_on_main_thread` like any other queued task.
#[tauri::command(rename_all = "snake_case")]
async fn tab_create(app: AppHandle, url: Option<String>) -> Result<NavState, IpcError> {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let state = tauri::async_runtime::spawn_blocking(move || {
        let state = shared.create_tab(url.as_deref())?;
        // Webview creation can only fail if the window is gone (shutdown); the
        // error is returned as-is — no tab is ever claimed without a webview.
        shared.attach(state.tab_id)?;
        shared.select_tab(state.tab_id)?;
        Ok::<_, IpcError>(state)
    })
    .await
    .map_err(|e| IpcError::with_detail("internal", "tab_create task failed", e.to_string()))??;
    Ok(state)
}

/// Destroys the tab's webview; same main-thread rule as `tab_create`.
#[tauri::command(rename_all = "snake_case")]
async fn tab_close(app: AppHandle, tab_id: TabId) -> Result<Value, IpcError> {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || shared.close_tab(tab_id))
        .await
        .map_err(|e| IpcError::with_detail("internal", "tab_close task failed", e.to_string()))?
}

/// Shows/hides tab webviews; same main-thread rule as `tab_create`.
#[tauri::command(rename_all = "snake_case")]
async fn tab_select(app: AppHandle, tab_id: TabId) -> Result<NavState, IpcError> {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || shared.select_tab(tab_id))
        .await
        .map_err(|e| IpcError::with_detail("internal", "tab_select task failed", e.to_string()))?
}

#[tauri::command(rename_all = "snake_case")]
fn nav_submit(app: AppHandle, tab_id: TabId, input: String) -> Result<NavOutcome, IpcError> {
    app.state::<Arc<Shared>>().submit(tab_id, &input)
}

#[tauri::command(rename_all = "snake_case")]
fn nav_back(app: AppHandle, tab_id: TabId) -> Result<NavState, IpcError> {
    app.state::<Arc<Shared>>().go_back(tab_id)
}

#[tauri::command(rename_all = "snake_case")]
fn nav_forward(app: AppHandle, tab_id: TabId) -> Result<NavState, IpcError> {
    app.state::<Arc<Shared>>().go_forward(tab_id)
}

#[tauri::command(rename_all = "snake_case")]
fn nav_reload(app: AppHandle, tab_id: TabId) -> Result<NavState, IpcError> {
    app.state::<Arc<Shared>>().reload(tab_id)
}

#[tauri::command(rename_all = "snake_case")]
fn nav_stop(app: AppHandle, tab_id: TabId) -> Result<NavState, IpcError> {
    app.state::<Arc<Shared>>().stop(tab_id)
}

#[tauri::command(rename_all = "snake_case")]
fn nav_home(app: AppHandle, tab_id: TabId) -> Result<NavState, IpcError> {
    app.state::<Arc<Shared>>().home(tab_id)
}

#[tauri::command(rename_all = "snake_case")]
fn engine_status(app: AppHandle) -> EngineStatus {
    app.state::<Arc<EngineState>>().status()
}

/// Prove owner rule 3 for the current page: the same expression through the
/// Obscura CLI and over CDP, byte-compared (contract §6). The CLI runs on a
/// worker thread, so the UI thread is never blocked.
#[tauri::command(rename_all = "snake_case")]
async fn engine_verify(app: AppHandle, tab_id: TabId) -> Result<Value, IpcError> {
    let url = {
        let shared = app.state::<Arc<Shared>>();
        let rt = shared.lock();
        rt.state_of(tab_id)
            .ok_or_else(|| IpcError::new("tab_not_found", format!("tab {tab_id} does not exist")))?
            .url
    };
    if url.is_empty() {
        return Err(IpcError::new(
            "invalid_input",
            "this tab has no loaded page to verify yet",
        ));
    }

    let engine = app.state::<Arc<EngineState>>();
    let cdp = engine.cdp.clone().ok_or_else(|| {
        IpcError::new(
            "engine_unavailable",
            "the Obscura CDP server is not running; cannot verify",
        )
    })?;
    let cli = CliEngine::new(engine.bin.clone(), false);

    spawn_blocking(move || {
        let report = verify_parity(&cli, &cdp, &url);
        serde_json::to_value(&report)
            .map_err(|e| IpcError::with_detail("internal", "serialize report", e.to_string()))
    })
    .await
    .map_err(|e| IpcError::with_detail("internal", "verify task join", e.to_string()))?
}

/// Hand an external-protocol address to the OS (contract §4.3). The UI must
/// have shown the confirmation first; this function still re-classifies the
/// input itself, so no `http(s)`/`file:`/`javascript:` address can escape
/// through it even if the UI were wrong.
#[tauri::command(rename_all = "snake_case")]
fn external_open(url: String) -> Result<Value, IpcError> {
    let address = match nav::classify(&url) {
        NavTarget::External { url, .. } => url,
        _ => {
            return Err(IpcError::new(
                "invalid_input",
                "only external-protocol addresses can be opened outside the browser",
            ))
        }
    };
    // Defence against argument smuggling into the OS launcher: the address
    // travels as one argv entry, so quotes/control characters are refused.
    if address.len() > 2048 || address.chars().any(|c| c.is_control() || c == '"') {
        return Err(IpcError::new(
            "invalid_input",
            "refusing to hand a malformed address to the OS",
        ));
    }
    std::process::Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(&address)
        .spawn()
        .map(|_| json!({ "opened": true }))
        .map_err(|e| {
            IpcError::with_detail(
                "internal",
                "the OS refused to open this address",
                e.to_string(),
            )
        })
}

fn main() {
    let engine = Arc::new(EngineState::start(engine_binary_path()));

    tauri::Builder::default()
        .manage(engine)
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            tab_list,
            tab_create,
            tab_close,
            tab_select,
            nav_submit,
            nav_back,
            nav_forward,
            nav_reload,
            nav_stop,
            nav_home,
            engine_status,
            engine_verify,
            external_open,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // The window comes from tauri.conf.json with `create: false`, so
            // it is a bare OS window — the chrome and every tab are child
            // webviews of it (no hidden primary webview renders anything).
            let config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .ok_or("tauri.conf.json defines no window")?;
            let window = tauri::window::WindowBuilder::from_config(&handle, &config)?.build()?;
            shell::attach_chrome(&window)?;

            // Shared runtime state and its drainer thread. Callbacks on the
            // UI thread only enqueue; the drainer owns the state.
            let (tx, rx) = runtime::channel();
            let shared = Arc::new(Shared::new(handle.clone(), tx));
            app.manage(shared.clone());
            runtime::spawn_drainer(shared.clone(), rx);

            // Resizes are queued from the UI thread (which must never take
            // the state lock) and applied by the drainer with real geometry.
            let resize = shared.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(size) = event {
                    resize.queue_relayout(size.width as f64, size.height as f64);
                }
            });

            // First tab: new-tab page, attached, selected.
            let first = shared.create_tab(None)?;
            shared.attach(first.tab_id)?;
            shared.select_tab(first.tab_id)?;

            // Startup events. The chrome also re-reads this state when it
            // loads (tab_list / runtime_info), because early events are lost
            // on any UI that was not listening yet.
            let (tabs, active) = {
                let rt = shared.lock();
                (rt.snapshot(), rt.tabs.active)
            };
            if let Err(e) = handle.emit(
                "runtime:ready",
                json!({ "tabs": tabs, "active_tab_id": active }),
            ) {
                eprintln!("ritam: emit runtime:ready failed: {e}");
            }
            if let Err(e) = handle.emit("engine:status", app.state::<Arc<EngineState>>().status()) {
                eprintln!("ritam: emit engine:status failed: {e}");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Ritam Browser");
}

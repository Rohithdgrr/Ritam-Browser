//! Typed state for the Ritam runtime: the `NavState`, `IpcError`, and
//! `NavOutcome` shapes from `contracts/ipc.md` §2/§3, plus per-tab history.
//!
//! Rohan owns this file. It is pure data + small helpers, no Tauri types, so
//! the contract surface is testable without a window.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use url::Url;

/// Stable tab id. Assigned monotonically; never reused within a process run.
pub type TabId = u64;

/// The one source of truth for omnibox/title/favicon/loading/history.
/// Emitted verbatim on the `nav:state` event.
#[derive(Debug, Clone, Serialize)]
pub struct NavState {
    pub tab_id: TabId,
    pub url: String,
    pub title: String,
    /// Origin of `url`, or `null` for non-web/app/about URLs. Never a
    /// security verdict — the contract carries origin only.
    pub origin: Option<String>,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    /// Page-declared favicon, resolved against the page, or `null`. Never a
    /// fabricated glyph.
    pub favicon_url: Option<String>,
}

/// Typed error returned by every command that can fail (`contracts/ipc.md` §5).
#[derive(Debug, Clone, Serialize)]
pub struct IpcError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

impl IpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(code: &str, message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            detail: Some(detail.into()),
        }
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Lets `?` propagate a typed command error through code paths whose error
/// type is `Box<dyn Error>` (app setup), without losing the code.
impl std::error::Error for IpcError {}

/// Result of `nav_submit` (`contracts/ipc.md` §4.1).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NavOutcome {
    Navigated { url: String, state: NavState },
    Search { url: String, query: String, state: NavState },
    External { url: String, scheme: String, origin: Option<String> },
    Rejected { error: IpcError },
}

/// Per-tab navigation record. History is runtime-recorded (contract §7.1):
/// WebView2 exposes no GoBack/GoForward, so we track the URL stack ourselves.
#[derive(Debug)]
pub struct TabHistory {
    entries: Vec<String>,
    index: usize,
}

impl TabHistory {
    /// Starts empty: entries are only ever recorded from *observed*
    /// navigations, never from an intention that did not happen.
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
            index: 0,
        }
    }

    /// Record a fresh top-level navigation, truncating any forward entries.
    pub fn push(&mut self, url: &str) {
        if self.entries.get(self.index).map(String::as_str) == Some(url) {
            return; // no-op (e.g. reload, or an identical redirect)
        }
        self.entries.truncate(self.index + 1);
        self.entries.push(url.to_string());
        self.index = self.entries.len() - 1;
    }

    /// Replace the entry the cursor is on. Used for a requested navigation
    /// and its redirect hops: one logical navigation, one history entry.
    pub fn replace_top(&mut self, url: &str) {
        if self.entries.is_empty() {
            self.entries.push(url.to_string());
            self.index = 0;
        } else {
            self.entries[self.index] = url.to_string();
        }
    }

    pub fn can_go_back(&self) -> bool {
        self.index > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.index + 1 < self.entries.len()
    }

    /// The URL one step back, if any. Does not move the cursor; the caller
    /// navigates and then calls [`TabHistory::move_back`].
    pub fn peek_back(&self) -> Option<&str> {
        if self.can_go_back() {
            self.entries.get(self.index - 1).map(String::as_str)
        } else {
            None
        }
    }

    pub fn peek_forward(&self) -> Option<&str> {
        if self.can_go_forward() {
            self.entries.get(self.index + 1).map(String::as_str)
        } else {
            None
        }
    }

    pub fn move_back(&mut self) {
        if self.can_go_back() {
            self.index -= 1;
        }
    }

    pub fn move_forward(&mut self) {
        if self.can_go_forward() {
            self.index += 1;
        }
    }
}

/// All open tabs plus the active one. Guards the tab map for the runtime.
pub struct TabSet {
    pub order: Vec<TabId>,
    pub active: TabId,
    next_id: AtomicU64,
}

impl TabSet {
    pub fn new() -> Self {
        Self {
            order: Vec::new(),
            active: 0,
            next_id: AtomicU64::new(1),
        }
    }

    pub fn alloc_id(&self) -> TabId {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn push(&mut self, id: TabId) {
        self.order.push(id);
    }

    pub fn remove(&mut self, id: TabId) {
        self.order.retain(|t| *t != id);
    }

    pub fn contains(&self, id: TabId) -> bool {
        self.order.contains(&id)
    }

    /// After a close: pick the next active tab, preferring the neighbour to
    /// the right. Returns `None` when no tabs remain (last-tab safety is the
    /// caller's job — it must not leave zero tabs).
    pub fn pick_after_close(&self, closed: TabId) -> Option<TabId> {
        let pos = self.order.iter().position(|t| *t == closed)?;
        self.order
            .get(pos + 1)
            .or_else(|| self.order.get(pos.wrapping_sub(1)).filter(|_| pos > 0))
            .copied()
    }
}

/// Compute the `origin` string for a URL per the contract: `null` for
/// non-web and app-internal URLs, otherwise `scheme://host[:port]`.
pub fn origin_of(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    match parsed.scheme() {
        "http" | "https" => {
            let host = parsed.host_str()?;
            match parsed.port() {
                Some(p) => Some(format!("{}://{}:{}", parsed.scheme(), host, p)),
                None => Some(format!("{}://{}", parsed.scheme(), host)),
            }
        }
        _ => None,
    }
}

/// Coalesce `nav:state` events per tab (`contracts/ipc.md` §1): if the UI is
/// falling behind, only the newest state per tab survives. `tab:created` and
/// `tab:closed` are never dropped — they are handled separately by the caller.
pub struct StateCoalescer {
    pending: HashMap<TabId, NavState>,
}

impl StateCoalescer {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
        }
    }

    pub fn push(&mut self, state: NavState) {
        self.pending.insert(state.tab_id, state);
    }

    pub fn take_all(&mut self) -> Vec<NavState> {
        let mut out: Vec<NavState> = self.pending.drain().map(|(_, v)| v).collect();
        out.sort_by_key(|s| s.tab_id);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_push_and_truncate() {
        let mut h = TabHistory::new();
        h.push("https://a.test");
        h.push("https://b.test");
        h.push("https://c.test");
        assert!(h.can_go_back());
        assert!(!h.can_go_forward());
        assert_eq!(h.peek_back(), Some("https://b.test"));

        // Going back then navigating forward-truncates, like a real browser.
        h.move_back();
        assert_eq!(h.peek_forward(), Some("https://c.test"));
        h.push("https://d.test");
        assert!(!h.can_go_forward());
        // [a, b, d] with the cursor on d: one step back is b.
        assert_eq!(h.peek_back(), Some("https://b.test"));
    }

    #[test]
    fn history_ignores_identical_reload() {
        let mut h = TabHistory::new();
        h.push("https://a.test");
        h.push("https://a.test");
        assert!(!h.can_go_back());
        assert_eq!(h.peek_back(), None);
    }

    #[test]
    fn history_at_bounds_is_stable() {
        let mut h = TabHistory::new();
        h.push("https://a.test");
        assert!(!h.can_go_back());
        h.move_back(); // no-op at the start
        assert!(!h.can_go_back());
        assert_eq!(h.peek_back(), None);
        assert_eq!(h.peek_forward(), None);
    }

    #[test]
    fn history_starts_empty_and_replace_top() {
        let mut h = TabHistory::new();
        assert!(!h.can_go_back());
        h.replace_top("https://a.test");
        h.replace_top("https://a.test/redirected");
        assert!(!h.can_go_back());
        assert_eq!(h.peek_back(), None);
        // The entry the cursor sits on now reads as the redirected URL.
        h.push("https://b.test");
        h.move_back();
        assert_eq!(h.peek_forward(), Some("https://b.test"));
    }

    #[test]
    fn origin_only_for_web_schemes() {
        assert_eq!(origin_of("https://example.com/x").as_deref(), Some("https://example.com"));
        assert_eq!(origin_of("http://example.com:8080/").as_deref(), Some("http://example.com:8080"));
        assert_eq!(origin_of("about:blank"), None);
        assert_eq!(origin_of("mailto:a@b.c"), None);
        assert_eq!(origin_of("not a url"), None);
    }

    #[test]
    fn pick_after_close_prefers_right_then_left() {
        let mut ts = TabSet::new();
        for _ in 0..3 {
            let id = ts.alloc_id();
            ts.push(id);
        }
        let ids = ts.order.clone();
        // Closing the middle prefers the one to the right.
        assert_eq!(ts.pick_after_close(ids[1]), Some(ids[2]));
        // Closing the last prefers the one to the left.
        assert_eq!(ts.pick_after_close(ids[2]), Some(ids[1]));
        // Unknown id yields None.
        assert_eq!(ts.pick_after_close(999), None);
    }

    #[test]
    fn coalescer_keeps_newest_per_tab() {
        let mut c = StateCoalescer::new();
        for i in 0..5 {
            c.push(NavState {
                tab_id: 1,
                url: format!("https://x.test/{i}"),
                title: String::new(),
                origin: None,
                loading: i != 4,
                can_go_back: false,
                can_go_forward: false,
                favicon_url: None,
            });
        }
        let out = c.take_all();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].url, "https://x.test/4");
        assert!(c.take_all().is_empty());
    }
}

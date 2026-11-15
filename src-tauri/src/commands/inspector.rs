//! Developer workbench: page-level network, console, error and DOM capture.
//!
//! The engine exposes no DevTools Protocol, so capture is installed *inside the
//! page* at document start (`INSPECTOR_JS`): fetch/XHR are wrapped, resource
//! timings come from `PerformanceObserver`, console calls and JS errors are
//! forwarded, and a DOM snapshot is serialised on demand. The page reports over
//! WebView2's message channel; the shell only ever receives values, never a
//! page-supplied command (see `webview2_blocker::install_message_channel`).
//!
//! Everything lives in memory for the current session: nothing is written to
//! the database, and capture starts only when the user presses Start.
//! Response mocking is applied page-side by the same script, scoped to one tab.
//!
//! Linux/WebKitGTK has no message channel, so the inspector reports itself as
//! unsupported there rather than pretending to capture.

use crate::db::now_ms;
use crate::error::AppError;
use crate::webview::TabWebviewManager;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};

const MAX_REQUESTS: usize = 500;
const MAX_CONSOLE: usize = 300;
const MAX_ERRORS: usize = 100;
const MAX_BODY: usize = 64_000;
const MAX_HEADERS: usize = 40;
const MAX_RULES: usize = 20;
const MAX_DOM: usize = 200_000;
const MAX_REPLAY_BODY: usize = 200_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HeaderPair {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CapturedRequest {
    #[serde(default)]
    pub id: String,
    /// "fetch" | "xhr" | "resource" | "other"
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    /// HTTP status, or 0 when the engine did not report one (static resources).
    #[serde(default)]
    pub status: i64,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub request_headers: Vec<HeaderPair>,
    #[serde(default)]
    pub response_headers: Vec<HeaderPair>,
    #[serde(default)]
    pub request_body: String,
    #[serde(default)]
    pub response_body: String,
    #[serde(default)]
    pub content_type: String,
    #[serde(default)]
    pub size: i64,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub mocked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConsoleMessage {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub level: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub at: i64,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PageError {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub line: i64,
    #[serde(default)]
    pub column: i64,
    #[serde(default)]
    pub at: i64,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DomSnapshot {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub html: String,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub at: i64,
}

/// A page-side mock response. `url_contains` is a literal substring match and
/// `method` may be `*` to match every method.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MockRule {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub url_contains: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub status: i64,
    #[serde(default)]
    pub content_type: String,
    #[serde(default)]
    pub body: String,
}

#[derive(Default)]
struct TabInspector {
    enabled: bool,
    requests: Vec<CapturedRequest>,
    console: Vec<ConsoleMessage>,
    errors: Vec<PageError>,
    rules: Vec<MockRule>,
    snapshot: Option<DomSnapshot>,
    mock_hits: i64,
    dropped: i64,
}

#[derive(Default)]
pub struct InspectorState {
    tabs: Mutex<HashMap<String, TabInspector>>,
}

impl InspectorState {
    fn tabs(&self) -> MutexGuard<'_, HashMap<String, TabInspector>> {
        // A poisoned mutex still holds a valid map — keep serving.
        self.tabs.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Script that brings a freshly loaded page in line with this tab's state:
    /// capture flag plus any active mock rules.
    fn page_script(&self, tab_id: &str) -> String {
        let tabs = self.tabs();
        let tab = tabs.get(tab_id);
        let enabled = tab.map(|entry| entry.enabled).unwrap_or(false);
        let rules = tab
            .map(|entry| serde_json::to_string(&entry.rules).unwrap_or_else(|_| "[]".into()))
            .unwrap_or_else(|| "[]".into());
        format!(
            "window.__govindInspectorSetEnabled && window.__govindInspectorSetEnabled({enabled});\
             window.__govindInspectorSetRules && window.__govindInspectorSetRules({rules});"
        )
    }
}

/// The list view never carries bodies or headers; those are fetched for the one
/// selected request so polling cannot clone megabytes every couple of seconds.
#[derive(Debug, Clone, Serialize)]
pub struct RequestSummary {
    pub id: String,
    pub kind: String,
    pub method: String,
    pub url: String,
    pub status: i64,
    pub duration_ms: i64,
    pub started_at: i64,
    pub content_type: String,
    pub size: i64,
    pub error: String,
    pub mocked: bool,
}

impl From<&CapturedRequest> for RequestSummary {
    fn from(request: &CapturedRequest) -> Self {
        Self {
            id: request.id.clone(),
            kind: request.kind.clone(),
            method: request.method.clone(),
            url: request.url.clone(),
            status: request.status,
            duration_ms: request.duration_ms,
            started_at: request.started_at,
            content_type: request.content_type.clone(),
            size: request.size,
            error: request.error.clone(),
            mocked: request.mocked,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct InspectorRead {
    pub supported: bool,
    pub enabled: bool,
    pub requests: Vec<RequestSummary>,
    pub console: Vec<ConsoleMessage>,
    pub errors: Vec<PageError>,
    pub rules: Vec<MockRule>,
    pub snapshot: Option<DomSnapshot>,
    pub mock_hits: i64,
    /// Newest entries dropped once a buffer reached its cap.
    pub dropped: i64,
}

#[derive(Debug, Serialize)]
pub struct ReplayResult {
    pub status: i64,
    pub final_url: String,
    pub headers: Vec<HeaderPair>,
    pub body: String,
    pub truncated: bool,
    pub duration_ms: i64,
}

/// Windows/WebView2 is the only engine with the message channel the capture
/// script reports through today.
pub fn capture_supported() -> bool {
    cfg!(windows)
}

fn text_value(value: Option<&Value>, max: usize) -> String {
    match value {
        Some(Value::String(text)) => text.chars().take(max).collect(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string().chars().take(max).collect(),
    }
}

fn number_value(value: Option<&Value>) -> i64 {
    value
        .and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|n| n as i64)))
        .unwrap_or(0)
}

fn bool_value(value: Option<&Value>) -> bool {
    value.and_then(Value::as_bool).unwrap_or(false)
}

fn header_pairs(value: Option<&Value>) -> Vec<HeaderPair> {
    let mut out = Vec::new();
    let Some(Value::Array(items)) = value else {
        return out;
    };
    for item in items.iter().take(MAX_HEADERS) {
        let name = text_value(item.get("name"), 200);
        if name.is_empty() {
            continue;
        }
        out.push(HeaderPair {
            name,
            value: text_value(item.get("value"), 1_000),
        });
    }
    out
}

pub(crate) fn clean_rule(mut rule: MockRule) -> Option<MockRule> {
    rule.url_contains = rule.url_contains.trim().chars().take(500).collect();
    if rule.url_contains.is_empty() {
        return None;
    }
    rule.method = rule.method.trim().to_ascii_uppercase();
    if !matches!(
        rule.method.as_str(),
        "" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "*"
    ) {
        return None;
    }
    if rule.method.is_empty() {
        rule.method = "GET".into();
    }
    // The page's Response constructor only accepts 200–599.
    if !(200..=599).contains(&rule.status) {
        rule.status = 200;
    }
    rule.content_type = rule.content_type.trim().chars().take(120).collect();
    if rule.content_type.is_empty() {
        rule.content_type = "text/plain".into();
    }
    rule.body = rule.body.chars().take(100_000).collect();
    if rule.id.trim().is_empty() {
        rule.id = uuid::Uuid::new_v4().to_string();
    }
    Some(rule)
}

fn parse_request(payload: &Value) -> Option<CapturedRequest> {
    let url = text_value(payload.get("url"), 4_000);
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return None;
    }
    let kind = match text_value(payload.get("kind"), 20).as_str() {
        "fetch" => "fetch",
        "xhr" => "xhr",
        "resource" => "resource",
        _ => "other",
    };
    let id = {
        let id = text_value(payload.get("id"), 80);
        if id.is_empty() { uuid::Uuid::new_v4().to_string() } else { id }
    };
    let started_at = number_value(payload.get("started_at")).max(0);
    Some(CapturedRequest {
        id,
        kind: kind.to_string(),
        method: {
            let method = text_value(payload.get("method"), 12).to_ascii_uppercase();
            if method.is_empty() { "GET".into() } else { method }
        },
        url,
        status: number_value(payload.get("status")).clamp(0, 999),
        duration_ms: number_value(payload.get("duration_ms")).clamp(0, 600_000),
        started_at: if started_at == 0 { now_ms() } else { started_at },
        request_headers: header_pairs(payload.get("request_headers")),
        response_headers: header_pairs(payload.get("response_headers")),
        request_body: text_value(payload.get("request_body"), MAX_BODY),
        response_body: text_value(payload.get("response_body"), MAX_BODY),
        content_type: text_value(payload.get("content_type"), 200),
        size: number_value(payload.get("size")).clamp(0, 100_000_000),
        error: text_value(payload.get("error"), 1_000),
        mocked: bool_value(payload.get("mocked")),
    })
}

/// Receive one `govind-capture` message from a page. Only values that make
/// sense are stored, every field is bounded, and capture must be on — except a
/// DOM snapshot, which is always a direct response to a user action.
pub fn ingest(state: &InspectorState, tab_id: &str, message: &Value) {
    let kind = message.get("kind").and_then(Value::as_str).unwrap_or("");
    let payload = message.get("payload").unwrap_or(&Value::Null);
    let mut tabs = state.tabs();
    let tab = tabs.entry(tab_id.to_string()).or_default();

    if kind != "dom" && !tab.enabled {
        return;
    }

    match kind {
        "request" => {
            let Some(request) = parse_request(payload) else {
                return;
            };
            if tab.requests.len() >= MAX_REQUESTS {
                tab.requests.remove(0);
                tab.dropped += 1;
            }
            tab.requests.push(request);
        }
        "console" => {
            let level = text_value(payload.get("level"), 10).to_ascii_lowercase();
            if !matches!(level.as_str(), "log" | "info" | "warn" | "error" | "debug") {
                return;
            }
            let text = text_value(payload.get("text"), 8_000);
            if text.is_empty() {
                return;
            }
            if tab.console.len() >= MAX_CONSOLE {
                tab.console.remove(0);
            }
            tab.console.push(ConsoleMessage {
                id: {
                    let id = text_value(payload.get("id"), 80);
                    if id.is_empty() { uuid::Uuid::new_v4().to_string() } else { id }
                },
                level,
                text,
                at: {
                    let at = number_value(payload.get("at"));
                    if at == 0 { now_ms() } else { at }
                },
                url: text_value(payload.get("url"), 2_000),
            });
        }
        "error" => {
            let message = text_value(payload.get("message"), 2_000);
            if message.is_empty() {
                return;
            }
            if tab.errors.len() >= MAX_ERRORS {
                tab.errors.remove(0);
            }
            tab.errors.push(PageError {
                id: {
                    let id = text_value(payload.get("id"), 80);
                    if id.is_empty() { uuid::Uuid::new_v4().to_string() } else { id }
                },
                message,
                source: text_value(payload.get("source"), 2_000),
                line: number_value(payload.get("line")).clamp(0, 10_000_000),
                column: number_value(payload.get("column")).clamp(0, 10_000_000),
                at: {
                    let at = number_value(payload.get("at"));
                    if at == 0 { now_ms() } else { at }
                },
                url: text_value(payload.get("url"), 2_000),
            });
        }
        "dom" => {
            let html = text_value(payload.get("html"), MAX_DOM);
            tab.snapshot = Some(DomSnapshot {
                url: text_value(payload.get("url"), 4_000),
                title: text_value(payload.get("title"), 500),
                truncated: bool_value(payload.get("truncated")) || html.chars().count() >= MAX_DOM,
                html,
                at: {
                    let at = number_value(payload.get("at"));
                    if at == 0 { now_ms() } else { at }
                },
            });
        }
        "mock" => {
            tab.mock_hits += 1;
        }
        _ => {}
    }
}

/// Re-apply capture state after a navigation. Called from the page-load handler
/// so a page never silently stops being inspected.
pub fn apply_page_state(app: &AppHandle, webview: &tauri::Webview, tab_id: &str) {
    let Some(state) = app.try_state::<InspectorState>() else {
        return;
    };
    let script = state.page_script(tab_id);
    let _ = webview.eval(&script);
}

#[tauri::command]
pub fn inspector_read(state: State<'_, InspectorState>, tab_id: String) -> InspectorRead {
    let tabs = state.tabs();
    let tab = tabs.get(&tab_id);
    InspectorRead {
        supported: capture_supported(),
        enabled: tab.map(|entry| entry.enabled).unwrap_or(false),
        requests: tab
            .map(|entry| entry.requests.iter().map(RequestSummary::from).collect())
            .unwrap_or_default(),
        console: tab.map(|entry| entry.console.clone()).unwrap_or_default(),
        errors: tab.map(|entry| entry.errors.clone()).unwrap_or_default(),
        rules: tab.map(|entry| entry.rules.clone()).unwrap_or_default(),
        snapshot: tab.and_then(|entry| entry.snapshot.clone()),
        mock_hits: tab.map(|entry| entry.mock_hits).unwrap_or(0),
        dropped: tab.map(|entry| entry.dropped).unwrap_or(0),
    }
}

/// Start or stop capture for one tab. Starting clears the previous session so
/// a report never mixes two runs.
#[tauri::command]
pub fn set_network_capture(
    manager: State<'_, TabWebviewManager>,
    state: State<'_, InspectorState>,
    tab_id: String,
    enabled: bool,
) -> bool {
    let script = {
        let mut tabs = state.tabs();
        let tab = tabs.entry(tab_id.clone()).or_default();
        tab.enabled = enabled;
        if enabled {
            tab.requests.clear();
            tab.console.clear();
            tab.errors.clear();
            tab.snapshot = None;
            tab.mock_hits = 0;
            tab.dropped = 0;
        }
        let rules = serde_json::to_string(&tab.rules).unwrap_or_else(|_| "[]".into());
        format!(
            "window.__govindInspectorSetEnabled && window.__govindInspectorSetEnabled({enabled});\
             window.__govindInspectorSetRules && window.__govindInspectorSetRules({rules});"
        )
    };
    manager.eval_in_tab(&tab_id, &script);
    true
}

#[tauri::command]
pub fn inspector_request(
    state: State<'_, InspectorState>,
    tab_id: String,
    request_id: String,
) -> Option<CapturedRequest> {
    let tabs = state.tabs();
    tabs.get(&tab_id)?
        .requests
        .iter()
        .find(|request| request.id == request_id)
        .cloned()
}

#[tauri::command]
pub fn clear_capture(state: State<'_, InspectorState>, tab_id: String) -> bool {
    let mut tabs = state.tabs();
    let tab = tabs.entry(tab_id).or_default();
    tab.requests.clear();
    tab.console.clear();
    tab.errors.clear();
    tab.snapshot = None;
    tab.mock_hits = 0;
    tab.dropped = 0;
    true
}

#[tauri::command]
pub fn set_mock_rules(
    manager: State<'_, TabWebviewManager>,
    state: State<'_, InspectorState>,
    tab_id: String,
    rules: Vec<MockRule>,
) -> Vec<MockRule> {
    let clean: Vec<MockRule> = rules
        .into_iter()
        .take(MAX_RULES)
        .filter_map(clean_rule)
        .collect();
    let script = {
        let mut tabs = state.tabs();
        let tab = tabs.entry(tab_id.clone()).or_default();
        tab.rules = clean.clone();
        let rules_json = serde_json::to_string(&tab.rules).unwrap_or_else(|_| "[]".into());
        format!(
            "window.__govindInspectorSetRules && window.__govindInspectorSetRules({rules_json});"
        )
    };
    manager.eval_in_tab(&tab_id, &script);
    clean
}

#[tauri::command]
pub fn request_dom_snapshot(
    manager: State<'_, TabWebviewManager>,
    tab_id: String,
) -> bool {
    let request_id = uuid::Uuid::new_v4().to_string();
    let script = format!(
        "window.__govindInspectorCaptureDom && window.__govindInspectorCaptureDom({});",
        serde_json::to_string(&request_id).unwrap_or_else(|_| "\"\"".into())
    );
    manager.eval_in_tab(&tab_id, &script)
}

fn validate_replay_url(raw: &str) -> Result<tauri::Url, AppError> {
    let url = tauri::Url::parse(raw.trim())
        .map_err(|_| AppError::InvalidInput("replay URL is not valid".into()))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(AppError::InvalidInput(
            "replay only supports http(s) URLs".into(),
        ));
    }
    Ok(url)
}

/// Replay a captured request from Rust. The response is read with a hard cap so
/// a large download cannot freeze the shell. Forbidden transport headers are
/// dropped instead of failing the whole replay.
#[tauri::command]
pub async fn replay_request(
    method: String,
    url: String,
    headers: Option<Vec<HeaderPair>>,
    body: Option<String>,
) -> Result<ReplayResult, AppError> {
    let target = validate_replay_url(&url)?;
    let method = {
        let method = method.trim().to_ascii_uppercase();
        if method.is_empty() { "GET".into() } else { method }
    };
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| AppError::InvalidInput("unsupported HTTP method".into()))?;
    let body = body.unwrap_or_default().chars().take(MAX_BODY).collect::<String>();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(25))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent("Ritam Browser replay")
            .build()
            .map_err(|error| format!("could not start the request: {error}"))?;

        let mut request = client.request(method.clone(), target.as_str());
        for header in headers.unwrap_or_default().into_iter().take(MAX_HEADERS) {
            let name = header.name.trim().to_ascii_lowercase();
            // Transport headers are owned by the client; sending them back can
            // only break the request.
            if matches!(
                name.as_str(),
                "host"
                    | "content-length"
                    | "connection"
                    | "transfer-encoding"
                    | "upgrade"
                    | "accept-encoding"
            ) {
                continue;
            }
            let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(header.name.trim().as_bytes()),
                reqwest::header::HeaderValue::from_str(&header.value),
            ) else {
                continue;
            };
            request = request.header(name, value);
        }
        if !body.is_empty() && method != reqwest::Method::GET && method != reqwest::Method::HEAD {
            request = request.body(body);
        }

        let started = std::time::Instant::now();
        let response = request
            .send()
            .map_err(|error| format!("request failed: {error}"))?;
        let status = response.status().as_u16() as i64;
        let final_url = response.url().to_string();
        let header_pairs = response
            .headers()
            .iter()
            .take(60)
            .map(|(name, value)| HeaderPair {
                name: name.as_str().to_string(),
                value: value.to_str().unwrap_or("").chars().take(1_000).collect(),
            })
            .collect();

        use std::io::Read;
        let mut bytes = Vec::new();
        response
            .take(MAX_REPLAY_BODY as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("could not read the response: {error}"))?;
        let truncated = bytes.len() >= MAX_REPLAY_BODY;
        Ok::<ReplayResult, String>(ReplayResult {
            status,
            final_url,
            headers: header_pairs,
            body: String::from_utf8_lossy(&bytes).to_string(),
            truncated,
            duration_ms: started.elapsed().as_millis() as i64,
        })
    })
    .await
    .map_err(|error| AppError::InvalidInput(format!("request replay stopped: {error}")))?;

    result.map_err(AppError::InvalidInput)
}

/// The page-side capture script. Installed in every tab at document start and
/// inert until the user enables capture for that tab.
pub const INSPECTOR_JS: &str = r#"
(function () {
  if (window.__govindInspectorInstalled) return;
  window.__govindInspectorInstalled = true;

  var enabled = false;
  var rules = [];
  var seq = 0;

  function nextId(prefix) {
    seq += 1;
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return prefix + '-' + window.crypto.randomUUID();
      }
    } catch (e) { }
    return prefix + '-' + Date.now().toString(36) + '-' + seq;
  }

  function send(kind, payload) {
    try {
      if (window.chrome && chrome.webview && chrome.webview.postMessage) {
        chrome.webview.postMessage(JSON.stringify({
          type: 'govind-capture', kind: kind, payload: payload
        }));
      }
    } catch (e) { }
  }

  function text(value, max) {
    var out;
    if (typeof value === 'string') out = value;
    else if (value instanceof Error) out = value.stack || value.message || String(value);
    else {
      try { out = JSON.stringify(value); } catch (e) { out = String(value); }
    }
    if (out === undefined || out === null) out = String(value);
    return out.slice(0, max || 4000);
  }

  function headersToPairs(headers) {
    var pairs = [];
    try {
      if (!headers) return pairs;
      if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
        headers.forEach(function (value, name) {
          if (pairs.length < 40) pairs.push({ name: String(name), value: String(value).slice(0, 1000) });
        });
        return pairs;
      }
      if (Array.isArray(headers)) {
        headers.forEach(function (pair) {
          if (pairs.length < 40 && pair && pair.length >= 2) {
            pairs.push({ name: String(pair[0]), value: String(pair[1]).slice(0, 1000) });
          }
        });
        return pairs;
      }
      if (typeof headers === 'object') {
        Object.keys(headers).forEach(function (name) {
          if (pairs.length < 40) pairs.push({ name: name, value: String(headers[name]).slice(0, 1000) });
        });
      }
    } catch (e) { }
    return pairs;
  }

  function isTextual(contentType) {
    var ct = String(contentType || '').toLowerCase();
    return ct === '' || ct.indexOf('json') !== -1 || ct.indexOf('text') !== -1 ||
      ct.indexOf('xml') !== -1 || ct.indexOf('javascript') !== -1 ||
      ct.indexOf('x-www-form-urlencoded') !== -1;
  }

  function findRule(method, url) {
    for (var i = 0; i < rules.length; i += 1) {
      var rule = rules[i];
      if (!rule || !rule.url_contains) continue;
      if (String(url || '').indexOf(rule.url_contains) === -1) continue;
      var ruleMethod = String(rule.method || 'GET').toUpperCase();
      if (ruleMethod !== '*' && ruleMethod !== String(method || 'GET').toUpperCase()) continue;
      return rule;
    }
    return null;
  }

  function record(entry) {
    if (!enabled) return;
    send('request', entry);
  }

  function buildMockResponse(rule) {
    var status = Math.max(200, Math.min(599, Number(rule.status) || 200));
    var body = (status === 204 || status === 205 || status === 304) ? null : String(rule.body || '');
    var headers = { 'content-type': rule.content_type || 'text/plain' };
    try {
      return Promise.resolve(new Response(body, { status: status, headers: headers }));
    } catch (e) {
      return Promise.resolve(new Response(body, { status: 200, headers: headers }));
    }
  }

  function applyXhrMock(xhr, rule) {
    var status = Math.max(200, Math.min(599, Number(rule.status) || 200));
    var body = (status === 204 || status === 205 || status === 304) ? '' : String(rule.body || '');
    try {
      Object.defineProperty(xhr, 'readyState', { configurable: true, get: function () { return 4; } });
      Object.defineProperty(xhr, 'status', { configurable: true, get: function () { return status; } });
      Object.defineProperty(xhr, 'statusText', { configurable: true, get: function () { return 'Mocked'; } });
      Object.defineProperty(xhr, 'responseURL', {
        configurable: true,
        get: function () { return (xhr.__govindInspector && xhr.__govindInspector.url) || ''; }
      });
      Object.defineProperty(xhr, 'responseText', { configurable: true, get: function () { return body; } });
      Object.defineProperty(xhr, 'response', {
        configurable: true,
        get: function () {
          if (xhr.responseType === 'json') {
            try { return JSON.parse(body); } catch (e) { return null; }
          }
          if (xhr.responseType === 'arraybuffer' || xhr.responseType === 'blob') return null;
          return body;
        }
      });
      xhr.getAllResponseHeaders = function () {
        return 'content-type: ' + (rule.content_type || 'text/plain') + '\r\n';
      };
      xhr.getResponseHeader = function (name) {
        return String(name || '').toLowerCase() === 'content-type'
          ? (rule.content_type || 'text/plain') : null;
      };
    } catch (e) { }
    setTimeout(function () {
      try {
        xhr.dispatchEvent(new Event('readystatechange'));
        xhr.dispatchEvent(new ProgressEvent('load'));
        xhr.dispatchEvent(new ProgressEvent('loadend'));
      } catch (e) { }
    }, 0);
  }

  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var request = null;
      try { request = new Request(input, init); } catch (e) { request = null; }
      var url = '';
      try {
        url = request ? request.url : (typeof input === 'string' ? input : (input && input.url) || '');
      } catch (e) { }
      var method = String((init && init.method) || (request && request.method) || 'GET').toUpperCase();
      var headers = headersToPairs((init && init.headers) || (request && request.headers));
      var bodyText = '';
      try {
        if (init && typeof init.body === 'string') bodyText = init.body.slice(0, 64000);
      } catch (e) { }
      var started = Date.now();
      var rule = enabled ? findRule(method, url) : null;
      if (rule) {
        record({
          id: nextId('req'), kind: 'fetch', method: method, url: url,
          status: Number(rule.status) || 200, duration_ms: Date.now() - started,
          started_at: started, request_headers: headers,
          response_headers: [{ name: 'content-type', value: rule.content_type || 'text/plain' }],
          request_body: bodyText,
          response_body: (status === 204 || status === 205 || status === 304)
            ? ''
            : String(rule.body || '').slice(0, 64000),
          content_type: rule.content_type || 'text/plain',
          size: (status === 204 || status === 205 || status === 304)
            ? 0
            : String(rule.body || '').length,
          error: '', mocked: true
        });
        send('mock', { url: url, method: method });
        return buildMockResponse(rule);
      }
      return originalFetch.apply(this, arguments).then(function (response) {
        var entry = {
          id: nextId('req'), kind: 'fetch', method: method, url: response.url || url,
          status: response.status, duration_ms: Date.now() - started, started_at: started,
          request_headers: headers, response_headers: headersToPairs(response.headers),
          request_body: bodyText, response_body: '', content_type: '',
          size: 0, error: '', mocked: false
        };
        try {
          var contentType = response.headers.get('content-type') || '';
          entry.content_type = contentType;
          var length = Number(response.headers.get('content-length') || 0);
          if (isTextual(contentType) && (!length || length < 200000) &&
              typeof response.clone === 'function') {
            response.clone().text().then(function (value) {
              entry.response_body = String(value || '').slice(0, 64000);
              entry.size = String(value || '').length;
              record(entry);
            }).catch(function () { record(entry); });
            return response;
          }
        } catch (e) { }
        record(entry);
        return response;
      }, function (error) {
        record({
          id: nextId('req'), kind: 'fetch', method: method, url: url, status: 0,
          duration_ms: Date.now() - started, started_at: started,
          request_headers: headers, response_headers: [], request_body: bodyText,
          response_body: '', content_type: '', size: 0,
          error: text(error, 500), mocked: false
        });
        throw error;
      });
    };
  }

  var XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    var originalOpen = XHR.prototype.open;
    var originalSend = XHR.prototype.send;
    var originalSetHeader = XHR.prototype.setRequestHeader;

    XHR.prototype.open = function (method, url) {
      try {
        var absolute = String(url || '');
        try { absolute = new URL(absolute, location.href).href; } catch (e) { }
        this.__govindInspector = {
          method: String(method || 'GET').toUpperCase(),
          url: absolute,
          headers: [],
          started: 0,
          body: ''
        };
      } catch (e) { }
      return originalOpen.apply(this, arguments);
    };

    XHR.prototype.setRequestHeader = function (name, value) {
      try {
        var state = this.__govindInspector;
        if (state && state.headers.length < 40) {
          state.headers.push({ name: String(name), value: String(value).slice(0, 1000) });
        }
      } catch (e) { }
      return originalSetHeader.apply(this, arguments);
    };

    XHR.prototype.send = function (body) {
      var state = this.__govindInspector;
      if (state) {
        state.started = Date.now();
        state.body = typeof body === 'string' ? body.slice(0, 64000) : '';
        var rule = enabled ? findRule(state.method, state.url) : null;
        if (rule) {
          applyXhrMock(this, rule);
          record({
            id: nextId('req'), kind: 'xhr', method: state.method, url: state.url,
            status: Number(rule.status) || 200, duration_ms: Date.now() - state.started,
            started_at: state.started, request_headers: state.headers,
            response_headers: [{ name: 'content-type', value: rule.content_type || 'text/plain' }],
            request_body: state.body, response_body: String(rule.body || '').slice(0, 64000),
            content_type: rule.content_type || 'text/plain',
            size: String(rule.body || '').length, error: '', mocked: true
          });
          send('mock', { url: state.url, method: state.method });
          return undefined;
        }
        var xhr = this;
        xhr.addEventListener('loadend', function () {
          var responseBody = '';
          var contentType = '';
          try { contentType = xhr.getResponseHeader('content-type') || ''; } catch (e) { }
          if (isTextual(contentType)) {
            try {
              if (!xhr.responseType || xhr.responseType === 'text') {
                responseBody = String(xhr.responseText || '').slice(0, 64000);
              } else if (xhr.responseType === 'json') {
                responseBody = text(xhr.response, 64000);
              }
            } catch (e) { }
          }
          var responseHeaders = [];
          try {
            String(xhr.getAllResponseHeaders() || '').trim().split(/[\r\n]+/).forEach(function (line) {
              var at = line.indexOf(':');
              if (at > 0 && responseHeaders.length < 40) {
                responseHeaders.push({
                  name: line.slice(0, at).trim(),
                  value: line.slice(at + 1).trim().slice(0, 1000)
                });
              }
            });
          } catch (e) { }
          record({
            id: nextId('req'), kind: 'xhr', method: state.method,
            url: xhr.responseURL || state.url, status: xhr.status || 0,
            duration_ms: Date.now() - state.started, started_at: state.started,
            request_headers: state.headers, response_headers: responseHeaders,
            request_body: state.body, response_body: responseBody,
            content_type: contentType, size: responseBody.length, error: '', mocked: false
          });
        });
      }
      return originalSend.apply(this, arguments);
    };
  }

  try {
    if (window.PerformanceObserver) {
      var observer = new PerformanceObserver(function (list) {
        if (!enabled) return;
        list.getEntries().forEach(function (entry) {
          if (!entry || !entry.name || entry.name.indexOf('http') !== 0) return;
          if (entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') return;
          record({
            id: nextId('res'), kind: 'resource', method: 'GET', url: entry.name,
            status: 0, duration_ms: Math.round(entry.duration || 0),
            started_at: Date.now() - Math.round(entry.duration || 0),
            request_headers: [], response_headers: [], request_body: '',
            response_body: '', content_type: '',
            size: entry.transferSize || entry.encodedBodySize || 0,
            error: '', mocked: false
          });
        });
      });
      observer.observe({ type: 'resource', buffered: true });
    }
  } catch (e) { }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        if (enabled) {
          var parts = Array.prototype.map.call(arguments, function (value) {
            return text(value, 4000);
          });
          send('console', {
            id: nextId('log'), level: level,
            text: parts.join(' ').slice(0, 8000), at: Date.now(), url: location.href
          });
        }
      } catch (e) { }
      return typeof original === 'function' ? original.apply(console, arguments) : undefined;
    };
  });

  window.addEventListener('error', function (event) {
    if (!enabled) return;
    try {
      send('error', {
        id: nextId('err'),
        message: text(event.message || (event.error && event.error.message) || 'Script error', 2000),
        source: String(event.filename || '').slice(0, 2000),
        line: event.lineno || 0, column: event.colno || 0,
        at: Date.now(), url: location.href
      });
    } catch (e) { }
  });

  window.addEventListener('unhandledrejection', function (event) {
    if (!enabled) return;
    try {
      var reason = event.reason;
      send('error', {
        id: nextId('err'),
        message: 'Unhandled promise rejection: ' +
          text(reason && reason.message ? reason.message : reason, 2000),
        source: '', line: 0, column: 0, at: Date.now(), url: location.href
      });
    } catch (e) { }
  });

  window.__govindInspectorSetEnabled = function (value) {
    enabled = !!value;
    return enabled;
  };

  window.__govindInspectorSetRules = function (value) {
    rules = Array.isArray(value) ? value.slice(0, 20) : [];
    return rules.length;
  };

  window.__govindInspectorCaptureDom = function (id) {
    try {
      var html = document.documentElement ? document.documentElement.outerHTML : '';
      send('dom', {
        request_id: String(id || ''), url: location.href, title: document.title,
        html: html.slice(0, 200000), truncated: html.length > 200000, at: Date.now()
      });
    } catch (e) { }
  };
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mock_rules_are_bounded_and_normalised() {
        let rule = clean_rule(MockRule {
            id: String::new(),
            url_contains: "  api.example.com  ".into(),
            method: "post".into(),
            status: 5000,
            content_type: String::new(),
            body: "{\"ok\":true}".into(),
        })
        .expect("valid rule");
        assert_eq!(rule.url_contains, "api.example.com");
        assert_eq!(rule.method, "POST");
        assert_eq!(rule.status, 200);
        assert_eq!(rule.content_type, "text/plain");
        assert!(!rule.id.is_empty());

        assert!(clean_rule(MockRule {
            url_contains: "   ".into(),
            ..MockRule::default()
        })
        .is_none());
        assert!(clean_rule(MockRule {
            url_contains: "x".into(),
            method: "TRACE".into(),
            ..MockRule::default()
        })
        .is_none());
    }

    #[test]
    fn capture_is_ignored_until_enabled() {
        let state = InspectorState::default();
        ingest(
            &state,
            "tab-1",
            &json!({
                "kind": "console",
                "payload": { "level": "log", "text": "hello", "at": 1 }
            }),
        );
        let read = inspector_read_for(&state, "tab-1");
        assert!(read.console.is_empty());

        {
            let mut tabs = state.tabs();
            tabs.entry("tab-1".into()).or_default().enabled = true;
        }
        ingest(
            &state,
            "tab-1",
            &json!({
                "kind": "console",
                "payload": { "level": "log", "text": "hello", "at": 1 }
            }),
        );
        let read = inspector_read_for(&state, "tab-1");
        assert_eq!(read.console.len(), 1);
        assert_eq!(read.console[0].text, "hello");
    }

    #[test]
    fn non_http_requests_and_junk_are_not_stored() {
        let state = InspectorState::default();
        {
            let mut tabs = state.tabs();
            let tab = tabs.entry("tab-1".into()).or_default();
            tab.enabled = true;
        }
        for url in ["javascript:alert(1)", "file:///etc/passwd", "data:text/plain,hi"] {
            ingest(
                &state,
                "tab-1",
                &json!({ "kind": "request", "payload": { "url": url, "method": "GET" } }),
            );
        }
        assert!(inspector_read_for(&state, "tab-1").requests.is_empty());

        ingest(
            &state,
            "tab-1",
            &json!({
                "kind": "request",
                "payload": { "url": "https://example.com/api", "method": "post", "status": 9999 }
            }),
        );
        let read = inspector_read_for(&state, "tab-1");
        assert_eq!(read.requests.len(), 1);
        assert_eq!(read.requests[0].method, "POST");
        assert_eq!(read.requests[0].status, 999);
    }

    #[test]
    fn snapshots_are_available_without_enabling_capture() {
        let state = InspectorState::default();
        ingest(
            &state,
            "tab-1",
            &json!({
                "kind": "dom",
                "payload": { "html": "<html><body>hi</body></html>", "title": "Hi", "url": "https://example.com" }
            }),
        );
        let snapshot = inspector_read_for(&state, "tab-1").snapshot.expect("snapshot");
        assert_eq!(snapshot.title, "Hi");
        assert!(snapshot.html.contains("hi"));
    }

    #[test]
    fn capture_support_matches_the_platform() {
        assert_eq!(capture_supported(), cfg!(windows));
    }

    #[test]
    fn the_page_script_reports_values_and_stays_inert() {
        assert!(INSPECTOR_JS.contains("govind-capture"));
        assert!(INSPECTOR_JS.contains("__govindInspectorSetEnabled"));
        assert!(INSPECTOR_JS.contains("__govindInspectorSetRules"));
        assert!(INSPECTOR_JS.contains("__govindInspectorCaptureDom"));
        assert!(INSPECTOR_JS.contains("PerformanceObserver"));
        assert!(INSPECTOR_JS.contains("unhandledrejection"));
        // The page has no command channel and the script never adds one.
        assert!(!INSPECTOR_JS.contains("__TAURI__"));
    }

    #[test]
    fn list_summaries_never_carry_bodies() {
        let request = CapturedRequest {
            id: "req-1".into(),
            method: "POST".into(),
            url: "https://example.com/api".into(),
            request_body: "{\"secret\":true}".into(),
            response_body: "{\"secret\":true}".into(),
            request_headers: vec![HeaderPair { name: "Authorization".into(), value: "token".into() }],
            ..CapturedRequest::default()
        };
        let json = serde_json::to_string(&RequestSummary::from(&request)).expect("summary json");
        assert!(json.contains("req-1"));
        assert!(!json.contains("secret"));
        assert!(!json.contains("Authorization"));
    }

    fn inspector_read_for(state: &InspectorState, tab_id: &str) -> InspectorRead {
        let tabs = state.tabs();
        let tab = tabs.get(tab_id);
        InspectorRead {
            supported: capture_supported(),
            enabled: tab.map(|entry| entry.enabled).unwrap_or(false),
            requests: tab
                .map(|entry| entry.requests.iter().map(RequestSummary::from).collect())
                .unwrap_or_default(),
            console: tab.map(|entry| entry.console.clone()).unwrap_or_default(),
            errors: tab.map(|entry| entry.errors.clone()).unwrap_or_default(),
            rules: tab.map(|entry| entry.rules.clone()).unwrap_or_default(),
            snapshot: tab.and_then(|entry| entry.snapshot.clone()),
            mock_hits: tab.map(|entry| entry.mock_hits).unwrap_or(0),
            dropped: tab.map(|entry| entry.dropped).unwrap_or(0),
        }
    }
}

//! Public records, typed settings, and the validation rules that guard both
//! write and read boundaries. Every field documented in `docs/SCHEMA.md`
//! §3–§4 lives here.

use serde::{Deserialize, Serialize};

use crate::error::StoreError;

// ---------------------------------------------------------------------------
// Limits (single source of truth for validation)
// ---------------------------------------------------------------------------

pub const MAX_URL_LEN: usize = 2048;
pub const MAX_TITLE_LEN: usize = 512;
pub const MAX_FOLDER_NAME_LEN: usize = 120;
pub const MAX_FILENAME_LEN: usize = 255;
pub const MAX_NOTE_TITLE_LEN: usize = 200;
pub const MAX_NOTE_BODY_LEN: usize = 100_000;
pub const MAX_SESSION_TABS: usize = 500;
pub const MAX_SEARCH_LIMIT: usize = 500;
/// 9999-12-31T23:59:59.999Z in epoch milliseconds.
pub const MAX_TIMESTAMP_MS: i64 = 253_402_300_799_999;

/// Unix epoch milliseconds, UTC.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

pub(crate) fn validate_url(field: &str, url: &str) -> Result<(), StoreError> {
    validate_str(field, url, 1, MAX_URL_LEN, false)
}

pub(crate) fn validate_title(field: &str, title: &str) -> Result<(), StoreError> {
    validate_str(field, title, 0, MAX_TITLE_LEN, false)
}

pub(crate) fn validate_timestamp(field: &str, ms: i64) -> Result<(), StoreError> {
    if ms <= 0 || ms > MAX_TIMESTAMP_MS {
        return Err(StoreError::InvalidInput(format!(
            "{field}: timestamp {ms} ms is out of the valid range (1 .. {MAX_TIMESTAMP_MS})"
        )));
    }
    Ok(())
}

/// A time-range **bound** (`from_ms`/`to_ms` of a filter or a
/// clear-browsing-data scope). Unlike an event timestamp, `0` is legal: it
/// is the epoch, meaning "since the beginning" — which is exactly what the
/// settings panel sends for its "All time" clear. Negative and
/// beyond-epoch-max bounds are still rejected.
pub(crate) fn validate_range_bound(field: &str, ms: i64) -> Result<(), StoreError> {
    if !(0..=MAX_TIMESTAMP_MS).contains(&ms) {
        return Err(StoreError::InvalidInput(format!(
            "{field}: {ms} ms is out of the valid range (0 .. {MAX_TIMESTAMP_MS})"
        )));
    }
    Ok(())
}

pub(crate) fn validate_limit(limit: usize) -> Result<usize, StoreError> {
    if limit == 0 || limit > MAX_SEARCH_LIMIT {
        return Err(StoreError::InvalidInput(format!(
            "limit: {limit} is out of range (1 .. {MAX_SEARCH_LIMIT})"
        )));
    }
    Ok(limit)
}

pub(crate) fn validate_str(
    field: &str,
    value: &str,
    min_chars: usize,
    max_chars: usize,
    allow_control: bool,
) -> Result<(), StoreError> {
    let chars = value.chars().count();
    if chars < min_chars || chars > max_chars {
        return Err(StoreError::InvalidInput(format!(
            "{field}: {chars} characters, allowed {min_chars}..{max_chars}"
        )));
    }
    if !allow_control && value.chars().any(char::is_control) {
        return Err(StoreError::InvalidInput(format!(
            "{field}: control characters are not allowed"
        )));
    }
    Ok(())
}

/// An absolute filesystem path, as reported by the runtime. "Real paths
/// only" (DEVI.md): a relative or empty path never becomes a download record.
pub(crate) fn validate_absolute_path(field: &str, path: &str) -> Result<(), StoreError> {
    validate_str(field, path, 1, 32767, false)?;
    if !std::path::Path::new(path).is_absolute() {
        return Err(StoreError::InvalidInput(format!(
            "{field}: `{path}` is not an absolute path"
        )));
    }
    Ok(())
}

/// Lowercased host with the port stripped, for the site filter. URLs
/// without an authority component (e.g. `about:blank`) yield "".
pub(crate) fn host_of(url: &str) -> String {
    let Some((_, rest)) = url.split_once("://") else {
        return String::new();
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or(authority);
    // Drop the port (`host:8443` → `host`); keep IPv6 bracket form intact.
    let host = match host.strip_suffix(|c: char| c.is_ascii_digit()) {
        Some(_) if host.contains(':') && !host.starts_with('[') => {
            host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host)
        }
        _ => host,
    };
    host.to_ascii_lowercase()
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BookmarkFolder {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub position: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bookmark {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub url: String,
    pub title: String,
    pub position: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewBookmark {
    pub url: String,
    pub title: String,
    /// `None` = root (root bookmarks are the sidebar favorites).
    pub folder_id: Option<i64>,
}

impl NewBookmark {
    pub fn validate(&self) -> Result<(), StoreError> {
        validate_url("url", &self.url)?;
        validate_title("title", &self.title)
    }
}

/// Outcome of adding a bookmark: a duplicate url in the same folder is
/// reported honestly, never silently deduplicated and never duplicated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BookmarkAddOutcome {
    Created(Bookmark),
    AlreadyExists(Bookmark),
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transition {
    Typed,
    Link,
    Reload,
    Restore,
}

impl Transition {
    pub fn as_str(self) -> &'static str {
        match self {
            Transition::Typed => "typed",
            Transition::Link => "link",
            Transition::Reload => "reload",
            Transition::Restore => "restore",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "typed" => Some(Transition::Typed),
            "link" => Some(Transition::Link),
            "reload" => Some(Transition::Reload),
            "restore" => Some(Transition::Restore),
            _ => None,
        }
    }
}

/// `Private` visits are never written to normal history.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Visibility {
    Normal,
    Private,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub url: String,
    pub title: String,
    pub host: String,
    pub visited_at_ms: i64,
    /// Only what the runtime reported; `None` means "unknown", never guessed.
    pub duration_ms: Option<i64>,
    pub http_status: Option<i32>,
    pub transition: Transition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewHistoryVisit {
    pub url: String,
    pub title: String,
    pub visited_at_ms: i64,
    pub duration_ms: Option<i64>,
    pub http_status: Option<i32>,
    pub transition: Transition,
    pub visibility: Visibility,
}

impl NewHistoryVisit {
    pub fn validate(&self) -> Result<(), StoreError> {
        validate_url("url", &self.url)?;
        validate_title("title", &self.title)?;
        validate_timestamp("visited_at_ms", self.visited_at_ms)?;
        if let Some(d) = self.duration_ms {
            if d < 0 {
                return Err(StoreError::InvalidInput(format!(
                    "duration_ms: {d} is negative"
                )));
            }
        }
        if let Some(s) = self.http_status {
            if !(100..=599).contains(&s) {
                return Err(StoreError::InvalidInput(format!(
                    "http_status: {s} is not a valid HTTP status"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SkipReason {
    PrivateSession,
    HistoryDisabled,
}

/// Explicit outcome: a skipped visit is visible, not a silent no-op.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HistoryAddOutcome {
    Recorded(i64),
    Skipped(SkipReason),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryFilter {
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub host: Option<String>,
    pub limit: usize,
}

impl Default for HistoryFilter {
    fn default() -> Self {
        HistoryFilter {
            from_ms: None,
            to_ms: None,
            host: None,
            limit: 100,
        }
    }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    InProgress,
    Completed,
    Cancelled,
    Failed,
}

impl DownloadState {
    pub fn as_str(self) -> &'static str {
        match self {
            DownloadState::InProgress => "in_progress",
            DownloadState::Completed => "completed",
            DownloadState::Cancelled => "cancelled",
            DownloadState::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "in_progress" => Some(DownloadState::InProgress),
            "completed" => Some(DownloadState::Completed),
            "cancelled" => Some(DownloadState::Cancelled),
            "failed" => Some(DownloadState::Failed),
            _ => None,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            DownloadState::Completed | DownloadState::Cancelled | DownloadState::Failed
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadRecord {
    pub id: i64,
    pub url: String,
    pub filename: String,
    pub mime_type: Option<String>,
    pub save_path: Option<String>,
    pub state: DownloadState,
    pub bytes_received: i64,
    pub bytes_total: Option<i64>,
    pub error: Option<String>,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub finished_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadStart {
    pub url: String,
    pub filename: String,
    pub mime_type: Option<String>,
}

/// Real runtime download events only. Pause/resume is deliberately absent:
/// the runtime does not provide it, and inventing states would simulate
/// success (AGENTS.md §6).
///
/// `Completed.save_path` and `Failed.error` are optional because the
/// runtime's real finish payload is exactly that shape (contract §9.1):
/// `path` may be `null` even when `success` is true (WebView2 platform
/// limitation), and a failure carries no error text at all. The store
/// records `NULL` for what the runtime did not report — a fabricated path
/// or a fabricated message would be simulated success. When a path *is*
/// present it must be absolute ("real paths only").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DownloadEvent {
    Progress {
        bytes_received: i64,
        bytes_total: Option<i64>,
    },
    Completed {
        /// Absolute destination as reported; `None` keeps `save_path` NULL.
        save_path: Option<String>,
        bytes_total: Option<i64>,
    },
    Failed {
        /// Runtime-reported reason; `None` keeps `error` NULL.
        error: Option<String>,
    },
    Cancelled,
}

// ---------------------------------------------------------------------------
// Scratchpad notes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub url: Option<String>,
    pub revision: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewNote {
    pub title: String,
    pub body: String,
    pub url: Option<String>,
}

impl NewNote {
    pub fn validate(&self) -> Result<(), StoreError> {
        validate_str("title", &self.title, 0, MAX_NOTE_TITLE_LEN, false)?;
        validate_str("body", &self.body, 0, MAX_NOTE_BODY_LEN, true)?;
        match &self.url {
            Some(u) => validate_url("url", u),
            None => Ok(()),
        }
    }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabState {
    pub tab_id: i64,
    pub url: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionState {
    pub active_tab_id: i64,
    pub tabs: Vec<TabState>,
}

impl SessionState {
    pub fn validate(&self) -> Result<(), StoreError> {
        if self.tabs.is_empty() || self.tabs.len() > MAX_SESSION_TABS {
            return Err(StoreError::InvalidInput(format!(
                "session tabs: {} is out of range (1 .. {MAX_SESSION_TABS})",
                self.tabs.len()
            )));
        }
        let mut ids = std::collections::HashSet::new();
        for tab in &self.tabs {
            if !ids.insert(tab.tab_id) {
                return Err(StoreError::InvalidInput(format!(
                    "session: duplicate tab id {}",
                    tab.tab_id
                )));
            }
            validate_url("tab.url", &tab.url)?;
            validate_title("tab.title", &tab.title)?;
        }
        if !ids.contains(&self.active_tab_id) {
            return Err(StoreError::InvalidInput(format!(
                "session: active tab {} is not among the saved tabs",
                self.active_tab_id
            )));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingKey {
    HistoryEnabled,
    HomePage,
    SearchEngine,
    ZoomPercent,
    Theme,
    RestoreSession,
}

impl SettingKey {
    pub fn as_str(self) -> &'static str {
        match self {
            SettingKey::HistoryEnabled => "history_enabled",
            SettingKey::HomePage => "home_page",
            SettingKey::SearchEngine => "search_engine",
            SettingKey::ZoomPercent => "zoom_percent",
            SettingKey::Theme => "theme",
            SettingKey::RestoreSession => "restore_session",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "history_enabled" => Some(SettingKey::HistoryEnabled),
            "home_page" => Some(SettingKey::HomePage),
            "search_engine" => Some(SettingKey::SearchEngine),
            "zoom_percent" => Some(SettingKey::ZoomPercent),
            "theme" => Some(SettingKey::Theme),
            "restore_session" => Some(SettingKey::RestoreSession),
            _ => None,
        }
    }

    pub const ALL: [SettingKey; 6] = [
        SettingKey::HistoryEnabled,
        SettingKey::HomePage,
        SettingKey::SearchEngine,
        SettingKey::ZoomPercent,
        SettingKey::Theme,
        SettingKey::RestoreSession,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchEngine {
    Duckduckgo,
    Google,
    Bing,
    Wikipedia,
}

impl SearchEngine {
    pub fn as_str(self) -> &'static str {
        match self {
            SearchEngine::Duckduckgo => "duckduckgo",
            SearchEngine::Google => "google",
            SearchEngine::Bing => "bing",
            SearchEngine::Wikipedia => "wikipedia",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "duckduckgo" => Some(SearchEngine::Duckduckgo),
            "google" => Some(SearchEngine::Google),
            "bing" => Some(SearchEngine::Bing),
            "wikipedia" => Some(SearchEngine::Wikipedia),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Light,
    Dark,
    System,
}

impl Theme {
    pub fn as_str(self) -> &'static str {
        match self {
            Theme::Light => "light",
            Theme::Dark => "dark",
            Theme::System => "system",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            "system" => Some(Theme::System),
            _ => None,
        }
    }
}

pub const MIN_ZOOM_PERCENT: i64 = 10;
pub const MAX_ZOOM_PERCENT: i64 = 300;
pub const DEFAULT_HOME_PAGE: &str = "about:blank";

/// Typed settings value. Only these keys exist; unknown keys are rejected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SettingValue {
    HistoryEnabled(bool),
    HomePage(String),
    SearchEngine(SearchEngine),
    ZoomPercent(i64),
    Theme(Theme),
    RestoreSession(bool),
}

impl SettingValue {
    pub fn key(&self) -> SettingKey {
        match self {
            SettingValue::HistoryEnabled(_) => SettingKey::HistoryEnabled,
            SettingValue::HomePage(_) => SettingKey::HomePage,
            SettingValue::SearchEngine(_) => SettingKey::SearchEngine,
            SettingValue::ZoomPercent(_) => SettingKey::ZoomPercent,
            SettingValue::Theme(_) => SettingKey::Theme,
            SettingValue::RestoreSession(_) => SettingKey::RestoreSession,
        }
    }

    /// The value in effect when nothing is stored (docs/SCHEMA.md §4).
    pub fn default_of(key: SettingKey) -> SettingValue {
        match key {
            SettingKey::HistoryEnabled => SettingValue::HistoryEnabled(true),
            SettingKey::HomePage => SettingValue::HomePage(DEFAULT_HOME_PAGE.to_string()),
            SettingKey::SearchEngine => SettingValue::SearchEngine(SearchEngine::Duckduckgo),
            SettingKey::ZoomPercent => SettingValue::ZoomPercent(100),
            SettingKey::Theme => SettingValue::Theme(Theme::System),
            SettingKey::RestoreSession => SettingValue::RestoreSession(true),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), StoreError> {
        match self {
            SettingValue::HomePage(url) => validate_url("home_page", url),
            SettingValue::ZoomPercent(z) if !(MIN_ZOOM_PERCENT..=MAX_ZOOM_PERCENT).contains(z) => {
                Err(StoreError::InvalidInput(format!(
                    "zoom_percent: {z} is out of range ({MIN_ZOOM_PERCENT}..={MAX_ZOOM_PERCENT})"
                )))
            }
            _ => Ok(()),
        }
    }

    /// Canonical storage encoding (docs/SCHEMA.md §3 settings.value).
    pub(crate) fn encode(&self) -> String {
        match self {
            SettingValue::HistoryEnabled(v) => v.to_string(),
            SettingValue::HomePage(v) => v.clone(),
            SettingValue::SearchEngine(v) => v.as_str().to_string(),
            SettingValue::ZoomPercent(v) => v.to_string(),
            SettingValue::Theme(v) => v.as_str().to_string(),
            SettingValue::RestoreSession(v) => v.to_string(),
        }
    }

    /// Decode with validation. `Err` marks the row malformed on read.
    pub(crate) fn decode(key: SettingKey, raw: &str) -> Result<SettingValue, StoreError> {
        let out = match key {
            SettingKey::HistoryEnabled => SettingValue::HistoryEnabled(parse_bool(raw)?),
            SettingKey::RestoreSession => SettingValue::RestoreSession(parse_bool(raw)?),
            SettingKey::HomePage => SettingValue::HomePage(raw.to_string()),
            SettingKey::SearchEngine => {
                SettingValue::SearchEngine(SearchEngine::parse(raw).ok_or_else(|| {
                    StoreError::InvalidInput(format!("unknown search engine `{raw}`"))
                })?)
            }
            SettingKey::Theme => SettingValue::Theme(
                Theme::parse(raw)
                    .ok_or_else(|| StoreError::InvalidInput(format!("unknown theme `{raw}`")))?,
            ),
            SettingKey::ZoomPercent => {
                let z: i64 = raw.parse().map_err(|_| {
                    StoreError::InvalidInput(format!("zoom_percent `{raw}` is not a number"))
                })?;
                if !(MIN_ZOOM_PERCENT..=MAX_ZOOM_PERCENT).contains(&z) {
                    return Err(StoreError::InvalidInput(format!(
                        "zoom_percent {z} out of range"
                    )));
                }
                SettingValue::ZoomPercent(z)
            }
        };
        out.validate()?;
        Ok(out)
    }
}

fn parse_bool(raw: &str) -> Result<bool, StoreError> {
    match raw {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(StoreError::InvalidInput(format!(
            "`{raw}` is not a boolean"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Clear-browsing-data and integrity reports
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimeRange {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// Exactly what `clear_browsing_data` removes (docs/SCHEMA.md §5). Bookmarks,
/// notes, and settings are user-owned and are never in this scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClearScope {
    pub history: Option<TimeRange>,
    pub downloads: bool,
    pub session: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ClearReport {
    pub history_deleted: u64,
    pub downloads_deleted: u64,
    pub session_cleared: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct TableCounts {
    pub settings: u64,
    pub bookmark_folders: u64,
    pub bookmarks: u64,
    pub history: u64,
    pub downloads: u64,
    pub notes: u64,
    pub session_tabs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreStats {
    pub counts: TableCounts,
    /// Rows skipped on read because they failed validation. Never silent:
    /// this counter plus `integrity_check` make every skip visible.
    pub malformed_rows_skipped: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MalformedRows {
    pub table: String,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IntegrityReport {
    /// True only when the structure is intact AND no malformed rows exist.
    pub ok: bool,
    pub schema_version: i64,
    /// Raw result of `PRAGMA integrity_check` ("ok" when healthy).
    pub integrity_check: String,
    pub foreign_key_violations: u64,
    pub malformed_rows: Vec<MalformedRows>,
    pub counts: TableCounts,
}

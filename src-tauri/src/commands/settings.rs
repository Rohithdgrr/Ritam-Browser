//! Settings, privacy (clear browsing data / site permissions) and app info.

use crate::commands::profiles::resolve_active_profile;
use crate::db::{now_ms, DbState, SHELL_KEYS};
use crate::error::AppError;
use crate::models::{AppInfo, ClearDataResult, SitePermission};
use rusqlite::params;
use std::collections::HashMap;
use std::time::Duration;
use tauri::{State, Url};

pub(crate) const NVIDIA_API_KEY_KEY: &str = "nvidia_api_key";
pub(crate) const NVIDIA_MODEL_KEY: &str = "nvidia_model";
pub(crate) const NVIDIA_BASE_URL: &str = "https://integrate.api.nvidia.com/v1";
pub(crate) const NVIDIA_MODEL: &str = "nvidia/nemotron-3-super-120b-a12b";
pub(crate) const NVIDIA_MODELS: &[&str] = &[
    NVIDIA_MODEL,
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "nvidia/nemotron-3.5-lightning-30b-a3b",
    "nvidia/llama-3.1-nemotron-51b-instruct",
    "openai/gpt-oss-20b",
];
const SECRET_KEYS: &[&str] = &[NVIDIA_API_KEY_KEY];

const KNOWN_KEYS: &[&str] = &[
    "search_engine",
    "restore_session",
    "https_first",
    "theme",
    "active_workspace_id",
    "custom_search_url",
    "force_dark_websites",
    "translation_endpoint",
    "spellcheck",
    "do_not_track",
    "safe_browsing",
    "network_blocking",
    "adblock_allowlist",
    "safebrowsing_blocklist",
    "content_blocking",
    "cosmetic_filters",
    "recently_closed",
    "muted_sites",
    "tab_sleep_minutes",
    "download_organize",
    "download_name_pattern",
    "download_scan",
    "website_shortcuts",
    "dashboard_widgets",
    "custom_shortcuts",
    NVIDIA_API_KEY_KEY,
    NVIDIA_MODEL_KEY,
];
// Plus dynamic per-domain zoom keys: `zoom:<host>` → factor.
const SEARCH_ENGINES: &[&str] = &["duckduckgo", "google", "bing", "startpage", "custom"];
const THEMES: &[&str] = &["zen-light", "zen-dark"];

const DEFAULTS: &[(&str, &str)] = &[
    ("search_engine", "duckduckgo"),
    ("restore_session", "false"),
    ("https_first", "true"),
    ("theme", "zen-light"),
    ("force_dark_websites", "false"),
    ("translation_endpoint", ""),
    ("spellcheck", "true"),
    ("do_not_track", "false"),
    ("safe_browsing", "true"),
    ("network_blocking", "true"),
    ("adblock_allowlist", ""),
    ("safebrowsing_blocklist", ""),
    ("content_blocking", "false"),
    ("cosmetic_filters", ""),
    ("recently_closed", "[]"),
    ("muted_sites", "[]"),
    ("tab_sleep_minutes", "0"),
    ("download_organize", "false"),
    ("download_name_pattern", ""),
    ("download_scan", "false"),
    ("website_shortcuts", "[]"),
    ("dashboard_widgets", "[\"clock\",\"shortcuts\",\"time\"]"),
    ("custom_shortcuts", "{}"),
    (NVIDIA_MODEL_KEY, NVIDIA_MODEL),
];

pub(crate) fn valid_nvidia_api_key(value: &str) -> bool {
    value.is_empty()
        || (value.len() >= 20
            && value.len() <= 512
            && value.starts_with("nvapi-")
            && value.chars().all(|c| c.is_ascii_graphic()))
}

pub(crate) fn valid_nvidia_model(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.contains('/')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'))
}

pub(crate) fn stored_nvidia_api_key(db: &DbState) -> Option<String> {
    let conn = db.conn();
    crate::db::setting(&conn, NVIDIA_API_KEY_KEY)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn stored_nvidia_model(db: &DbState) -> String {
    let conn = db.conn();
    crate::db::setting(&conn, NVIDIA_MODEL_KEY)
        .filter(|value| valid_nvidia_model(value))
        .unwrap_or_else(|| NVIDIA_MODEL.to_string())
}

/// Ask NVIDIA whether this key can use a specific model.
fn verify_nvidia_model(key: &str, model: &str, timeout: Duration) -> Result<(), AppError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| AppError::Generation(format!("could not prepare NVIDIA verification: {error}")))?;
    // `/v1/models` is public, so a real chat call is the only reliable check
    // that the key is active and can use the configured model.
    let response = client
        .post(format!("{NVIDIA_BASE_URL}/chat/completions"))
        .bearer_auth(key)
        .json(&serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": "Reply with OK" }],
            "max_tokens": 8,
            "temperature": 0,
            "stream": false
        }))
        .send()
        .map_err(|error| {
            AppError::Generation(format!("could not reach NVIDIA to verify the key: {error}"))
        })?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let detail: String = response
        .text()
        .unwrap_or_default()
        .chars()
        .take(240)
        .collect();
    let detail = detail.trim();
    match status.as_u16() {
        401 => Err(AppError::Generation(
            "NVIDIA says Unauthorized (401). The API key is invalid or inactive; copy it again from build.nvidia.com → API Keys.".into(),
        )),
        402 => Err(AppError::Generation(
            "NVIDIA says this key has no remaining credits or its plan does not cover the model (402).".into(),
        )),
        403 => {
            let lower = detail.to_ascii_lowercase();
            if lower.contains("authorization failed")
                || lower.contains("unauthorized")
                || lower.contains("invalid api key")
            {
                Err(AppError::Generation(
                    "NVIDIA says Authorization failed (403). Use an API Catalog key generated at build.nvidia.com → API Keys (not an NGC personal key), and complete account verification. Then try again.".into(),
                ))
            } else {
                Err(AppError::Generation(format!(
                    "NVIDIA says Forbidden (403) for {model}. This key may not have access to that model; try another model.{}",
                    if detail.is_empty() { String::new() } else { format!(" NVIDIA: {detail}") }
                )))
            }
        }
        404 => Err(AppError::Generation(format!(
            "NVIDIA says {model} is unavailable (404). Choose another model.{}",
            if detail.is_empty() { String::new() } else { format!(" NVIDIA: {detail}") }
        ))),
        429 => Err(AppError::Generation(
            "NVIDIA rate-limited the key check. Wait a moment and try again.".into(),
        )),
        _ => Err(AppError::Generation(if detail.is_empty() {
            format!("NVIDIA key verification failed (HTTP {status}) for {model}.")
        } else {
            format!("NVIDIA key verification failed (HTTP {status}) for {model}: {detail}")
        })),
    }
}

#[tauri::command]
pub async fn save_nvidia_api_key(
    db: State<'_, DbState>,
    key: String,
    model: String,
) -> Result<serde_json::Value, AppError> {
    let supplied_key = key.trim().to_string();
    let key = if supplied_key.is_empty() {
        stored_nvidia_api_key(&db).ok_or_else(|| {
            AppError::InvalidInput("paste a complete NVIDIA API key starting with nvapi-".into())
        })?
    } else {
        supplied_key
    };
    if !valid_nvidia_api_key(&key) {
        return Err(AppError::InvalidInput(
            "paste a complete NVIDIA API key starting with nvapi-".into(),
        ));
    }
    let model = if model.trim().is_empty() {
        NVIDIA_MODEL.to_string()
    } else {
        model.trim().to_string()
    };
    if !valid_nvidia_model(&model) {
        return Err(AppError::InvalidInput("invalid NVIDIA model id".into()));
    }
    let key_to_verify = key.clone();
    let model_to_verify = model.clone();
    tauri::async_runtime::spawn_blocking(move || {
        verify_nvidia_model(&key_to_verify, &model_to_verify, Duration::from_secs(45))
    })
    .await
    .map_err(|error| AppError::Generation(format!("NVIDIA verification task failed: {error}")))??;
    {
        let conn = db.conn();
        crate::db::set_setting(&conn, NVIDIA_API_KEY_KEY, &key)?;
        crate::db::set_setting(&conn, NVIDIA_MODEL_KEY, &model)?;
    }
    Ok(serde_json::json!({
        "configured": true,
        "model": model,
        "detail": format!("Verified with NVIDIA. {model} is ready.")
    }))
}

#[tauri::command]
pub async fn test_nvidia_models(
    db: State<'_, DbState>,
    key: Option<String>,
) -> Result<Vec<serde_json::Value>, AppError> {
    let supplied_key = key
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let key = supplied_key.or_else(|| stored_nvidia_api_key(&db)).ok_or_else(|| {
        AppError::InvalidInput("paste a complete NVIDIA API key first".into())
    })?;
    if !valid_nvidia_api_key(&key) {
        return Err(AppError::InvalidInput(
            "paste a complete NVIDIA API key starting with nvapi-".into(),
        ));
    }
    let results = tauri::async_runtime::spawn_blocking(move || {
        NVIDIA_MODELS
            .iter()
            .map(|model| match verify_nvidia_model(&key, model, Duration::from_secs(20)) {
                Ok(()) => serde_json::json!({ "model": model, "ok": true, "detail": "OK" }),
                Err(error) => serde_json::json!({
                    "model": model,
                    "ok": false,
                    "detail": error.to_string()
                }),
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| AppError::Generation(format!("NVIDIA model test failed: {error}")))?;
    Ok(results)
}

fn valid_translation_endpoint(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")),
        _ => false,
    }
}

/// Each line must look like a hostname (letters, digits, dots, hyphens, optional `*.`).
fn valid_blocklist(value: &str) -> bool {
    value.lines().all(|line| {
        let l = line.trim();
        l.is_empty()
            || l.strip_prefix("*.")
                .unwrap_or(l)
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    })
}

/// Cosmetic filters: CSS selectors, one per line. Reject anything containing
/// braces or `@` rules — we only inject a plain selector list.
fn valid_cosmetic_filters(value: &str) -> bool {
    value.lines().all(|line| {
        let l = line.trim();
        l.is_empty() || (!l.contains('{') && !l.contains('}') && !l.starts_with('@') && l.len() <= 500)
    })
}

fn json_array(value: &str) -> Option<Vec<serde_json::Value>> {
    serde_json::from_str::<serde_json::Value>(value)
        .ok()?
        .as_array()
        .cloned()
}

/// Recently closed tab entries: bounded list, newest last entry wins nothing —
/// the shape is validated by the shell, so only the size and ordering matter.
fn valid_recently_closed(value: &str) -> bool {
    value.len() <= 200_000
        && json_array(value)
            .map(|items| items.len() <= 20 && items.iter().all(|item| item.is_object()))
            .unwrap_or(false)
}

/// Muted sites: a bounded list of bare hostnames.
/// Website shortcuts: a bounded list of `{ title, url }` pairs.
fn valid_website_shortcuts(value: &str) -> bool {
    value.len() <= 4_000
        && json_array(value)
            .map(|items| {
                items.len() <= 12
                    && items.iter().all(|item| {
                        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("");
                        let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
                        !title.trim().is_empty()
                            && title.chars().count() <= 40
                            && url.len() <= 500
                            && (url.starts_with("https://") || url.starts_with("http://"))
                    })
            })
            .unwrap_or(false)
}

/// New-tab widgets: known ids only, no duplicates matter (the shell dedupes).
fn valid_dashboard_widgets(value: &str) -> bool {
    const ALLOWED: &[&str] = &["clock", "shortcuts", "time"];
    value.len() <= 200
        && json_array(value)
            .map(|items| {
                items.len() <= ALLOWED.len()
                    && items
                        .iter()
                        .all(|item| item.as_str().map(|id| ALLOWED.contains(&id)).unwrap_or(false))
            })
            .unwrap_or(false)
}

/// `Ctrl+Shift+S`, `Alt+Left`, …: modifiers plus one key, nothing exotic.
fn valid_shortcut_combo(combo: &str) -> bool {
    if combo.len() > 40 {
        return false;
    }
    let parts: Vec<&str> = combo.split('+').map(str::trim).filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return false;
    }
    let (key, modifiers) = parts.split_last().expect("at least one part");
    let key_ok = if key.chars().count() == 1 {
        // Single printable symbol keys (Ctrl+, / Ctrl+-) are valid accelerators.
        key.chars().next().map(|c| !c.is_whitespace() && c != '+').unwrap_or(false)
    } else {
        key.chars().count() <= 3 && key.chars().all(|c| c.is_ascii_alphanumeric())
    };
    key_ok && modifiers.iter().all(|m| matches!(*m, "Ctrl" | "Alt" | "Shift" | "Meta"))
}

/// Custom shortcuts: `{ action: "Ctrl+Shift+S" }` for actions the shell knows.
fn valid_custom_shortcuts(value: &str) -> bool {
    const ACTIONS: &[&str] = &[
        "new-tab", "close-tab", "split-view", "undo-close", "find", "reader-mode",
        "focus-omnibar", "reload", "downloads", "bookmark", "history", "settings",
        "tab-search", "statistics", "bookmarks", "palette", "autofill", "mute-tab", "print",
        "fullscreen", "next-tab", "prev-tab", "zoom-in", "zoom-out", "zoom-reset",
    ];
    if value.len() > 4_000 {
        return false;
    }
    let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(value) else {
        return false;
    };
    map.len() <= 40
        && map.iter().all(|(action, combo)| {
            ACTIONS.contains(&action.as_str())
                && combo.as_str().map(valid_shortcut_combo).unwrap_or(false)
        })
}

fn valid_muted_sites(value: &str) -> bool {
    value.len() <= 20_000
        && json_array(value)
            .map(|items| {
                items.len() <= 200
                    && items.iter().all(|item| {
                        item.as_str()
                            .map(|host| {
                                !host.is_empty()
                                    && host.len() <= 253
                                    && host
                                        .chars()
                                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
                            })
                            .unwrap_or(false)
                    })
            })
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_shortcuts_require_known_actions_and_modifiers() {
        assert!(valid_custom_shortcuts(r#"{"split-view":"Ctrl+Shift+S"}"#));
        assert!(valid_custom_shortcuts(r#"{"new-tab":"Meta+T"}"#));
        assert!(!valid_custom_shortcuts(r#"{"not-an-action":"Ctrl+Z"}"#));
        assert!(!valid_custom_shortcuts(r#"{"new-tab":"T"}"#));
        assert!(!valid_custom_shortcuts(r#"{"new-tab":"Hyper+T"}"#));
        assert!(!valid_custom_shortcuts("[]"));
    }

    #[test]
    fn shortcuts_are_rejected_when_they_are_not_pairs() {
        assert!(valid_shortcut_combo("Ctrl+Shift+K"));
        assert!(valid_shortcut_combo("Ctrl+,"));
        assert!(valid_shortcut_combo("Ctrl+-"));
        assert!(!valid_shortcut_combo("Ctrl+Shift+Enter"));
        assert!(!valid_shortcut_combo("Ctrl+"));
        assert!(!valid_shortcut_combo("+K"));
    }

    #[test]
    fn website_shortcuts_must_be_web_urls() {
        assert!(valid_website_shortcuts(r#"[{"title":"Mail","url":"https://mail.example.com"}]"#));
        assert!(!valid_website_shortcuts(r#"[{"title":"Mail","url":"file:///tmp/x"}]"#));
        assert!(!valid_website_shortcuts(r#"[{"title":"","url":"https://example.com"}]"#));
    }

    #[test]
    fn nvidia_models_are_safe_ids() {
        assert!(valid_nvidia_model("nvidia/nemotron-3-super-120b-a12b"));
        assert!(valid_nvidia_model("openai/gpt-oss-20b"));
        assert!(!valid_nvidia_model("no-slash"));
        assert!(!valid_nvidia_model("nvidia/model with space"));
        assert!(!valid_nvidia_model("nvidia/model?x"));
    }

    #[test]
    fn nvidia_keys_must_look_like_nvapi_tokens() {
        assert!(valid_nvidia_api_key(""));
        assert!(valid_nvidia_api_key("nvapi-abcdefghijklmnopqrstuvwxyz012345"));
        assert!(!valid_nvidia_api_key("sk-abcdefghijklmnopqrstuvwxyz012345"));
        assert!(!valid_nvidia_api_key("nvapi-short"));
        assert!(!valid_nvidia_api_key("nvapi-abcdefghijklmnop qrstuvwxyz"));
    }

    #[test]
    fn dashboard_widgets_are_from_the_known_set() {
        assert!(valid_dashboard_widgets(r#"["clock","shortcuts"]"#));
        assert!(!valid_dashboard_widgets(r#"["weather"]"#));
    }
}

pub(crate) fn valid_setting_value(key: &str, value: &str) -> bool {
    match key {
        "search_engine" => SEARCH_ENGINES.contains(&value),
        "theme" => THEMES.contains(&value),
        "restore_session" | "https_first" | "force_dark_websites" | "spellcheck"
        | "do_not_track" | "safe_browsing" | "network_blocking" | "content_blocking"
        | "download_organize" => value == "true" || value == "false",
        "download_scan" => value == "true" || value == "false",
        "website_shortcuts" => valid_website_shortcuts(value),
        "dashboard_widgets" => valid_dashboard_widgets(value),
        "custom_shortcuts" => valid_custom_shortcuts(value),
        key if key == NVIDIA_API_KEY_KEY => valid_nvidia_api_key(value),
        key if key == NVIDIA_MODEL_KEY => valid_nvidia_model(value),
        "tab_sleep_minutes" => value
            .parse::<u32>()
            .map(|minutes| minutes <= 240)
            .unwrap_or(false),
        "download_name_pattern" => {
            value.len() <= 120
                && !value.contains('/')
                && !value.contains('\\')
                && !value.chars().any(char::is_control)
        }
        "active_workspace_id" => value.len() <= 128 && !value.contains(char::is_whitespace),
        "custom_search_url" => {
            let lower = value.to_ascii_lowercase();
            (lower.starts_with("https://") || lower.starts_with("http://")) && value.len() <= 500
        }
        "translation_endpoint" => value.len() <= 2048 && valid_translation_endpoint(value),
        "safebrowsing_blocklist" => value.len() <= 20_000 && valid_blocklist(value),
        "adblock_allowlist" => value.len() <= 20_000 && valid_blocklist(value),
        "cosmetic_filters" => value.len() <= 50_000 && valid_cosmetic_filters(value),
        "recently_closed" => valid_recently_closed(value),
        "muted_sites" => valid_muted_sites(value),
        _ if key.starts_with("zoom:") => value
            .parse::<f64>()
            .map(|f| (0.25..=3.0).contains(&f))
            .unwrap_or(false),
        _ => false,
    }
}

#[tauri::command]
pub fn get_settings(db: State<'_, DbState>) -> Result<HashMap<String, String>, AppError> {
    let conn = db.conn();
    let mut map: HashMap<String, String> =
        DEFAULTS.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    if let Some(profile) = resolve_active_profile(&conn) {
        let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE profile_id = ?1")?;
        let rows = stmt.query_map([&profile], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (k, v) = row?;
            map.insert(k, v);
        }
    }
    for key in SHELL_KEYS {
        if let Some(value) = crate::db::shell_state(&conn, key) {
            map.insert((*key).to_string(), value);
        }
    }
    let nvidia_key_set = map
        .get(NVIDIA_API_KEY_KEY)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    for key in SECRET_KEYS {
        map.remove(*key);
    }
    map.insert(
        format!("{NVIDIA_API_KEY_KEY}_set"),
        nvidia_key_set.to_string(),
    );
    Ok(map)
}

#[tauri::command]
pub fn set_setting(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    key: String,
    value: String,
) -> Result<serde_json::Value, AppError> {
    let known = KNOWN_KEYS.contains(&key.as_str()) || key.starts_with("zoom:");
    if !known {
        return Err(AppError::InvalidInput(format!("unknown setting key: {key}")));
    }
    if !valid_setting_value(&key, &value) {
        return Err(AppError::InvalidInput(format!("invalid value for setting: {key}")));
    }
    {
        let conn = db.conn();
        if SHELL_KEYS.contains(&key.as_str()) {
            crate::db::set_shell_state(&conn, &key, &value)?;
        } else {
            crate::db::set_setting(&conn, &key, &value)?;
        }
    }
    // Rebuild the native accelerator table when the user changes key combos.
    // The lock above is released first: registration reads the same database.
    if key == "custom_shortcuts" {
        crate::register_shortcuts(&app);
    }
    if SECRET_KEYS.contains(&key.as_str()) {
        return Ok(serde_json::json!({ "key": key, "saved": true }));
    }
    Ok(serde_json::json!({ "key": key, "value": value }))
}

#[tauri::command]
pub fn clear_browsing_data(
    db: State<'_, DbState>,
    categories: Vec<String>,
) -> Result<ClearDataResult, AppError> {
    let conn = db.conn();
    let Some(profile) = resolve_active_profile(&conn) else {
        return Ok(ClearDataResult { history: 0, downloads: 0, site_permissions: 0 });
    };
    let mut result = ClearDataResult { history: 0, downloads: 0, site_permissions: 0 };
    for category in categories {
        match category.as_str() {
            "history" => {
                result.history = conn
                    .execute("DELETE FROM history WHERE profile_id = ?1", params![profile])? as i64
            }
            "downloads" => {
                result.downloads = conn
                    .execute("DELETE FROM downloads WHERE profile_id = ?1", params![profile])? as i64
            }
            "site_permissions" => {
                result.site_permissions = conn
                    .execute("DELETE FROM site_permissions WHERE profile_id = ?1", params![profile])?
                    as i64
            }
            // Bookmarks and notes are intentionally never cleared here.
            _ => {}
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn list_site_permissions(db: State<'_, DbState>) -> Result<Vec<SitePermission>, AppError> {
    let conn = db.conn();
    let Some(profile) = resolve_active_profile(&conn) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT id, origin, permission, decision, updated_at FROM site_permissions
         WHERE profile_id = ?1 ORDER BY origin ASC",
    )?;
    let rows = stmt.query_map([&profile], |r| {
        Ok(SitePermission {
            id: r.get(0)?,
            origin: r.get(1)?,
            permission: r.get(2)?,
            decision: r.get(3)?,
            updated_at: r.get(4)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[tauri::command]
pub fn set_site_permission(
    db: State<'_, DbState>,
    origin: String,
    permission: String,
    decision: String,
) -> Result<SitePermission, AppError> {
    let clean_origin: String = origin.trim().chars().take(200).collect();
    let lower = clean_origin.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err(AppError::InvalidInput("origin must start with http:// or https://".into()));
    }
    let clean_permission: String = permission.trim().to_lowercase().chars().take(64).collect();
    if clean_permission.is_empty() {
        return Err(AppError::InvalidInput("permission is required".into()));
    }
    let clean_decision = decision.trim().to_lowercase();
    if !matches!(clean_decision.as_str(), "ask" | "allow" | "deny") {
        return Err(AppError::InvalidInput("decision must be ask, allow or deny".into()));
    }

    let conn = db.conn();
    let Some(profile) = resolve_active_profile(&conn) else {
        return Err(AppError::InvalidInput("no active profile".into()));
    };
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO site_permissions (id, profile_id, origin, permission, decision, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(profile_id, origin, permission) DO UPDATE SET
           decision = excluded.decision,
           updated_at = excluded.updated_at",
        params![id, profile, clean_origin, clean_permission, clean_decision, now],
    )?;
    let perm = conn.query_row(
        "SELECT id, origin, permission, decision, updated_at FROM site_permissions
         WHERE profile_id = ?1 AND origin = ?2 AND permission = ?3",
        params![profile, clean_origin, clean_permission],
        |r| {
            Ok(SitePermission {
                id: r.get(0)?,
                origin: r.get(1)?,
                permission: r.get(2)?,
                decision: r.get(3)?,
                updated_at: r.get(4)?,
            })
        },
    )?;
    Ok(perm)
}

#[tauri::command]
pub fn clear_site_permissions(db: State<'_, DbState>, origin: Option<String>) -> Result<i64, AppError> {
    let conn = db.conn();
    let Some(profile) = resolve_active_profile(&conn) else { return Ok(0) };
    let changed = match origin {
        Some(o) => conn.execute(
            "DELETE FROM site_permissions WHERE profile_id = ?1 AND origin = ?2",
            params![profile, o],
        )?,
        None => conn.execute(
            "DELETE FROM site_permissions WHERE profile_id = ?1",
            params![profile],
        )?,
    };
    Ok(changed as i64)
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        name: "Ritam Browser".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        milestone: "Milestone 1 — Browser Shell".to_string(),
        engine: "System WebView2 via Tauri 2".to_string(),
        engine_detail: "Window-embedded child webviews with native request hook for ad blocking. Uses EasyList, EasyPrivacy, and uBlock Origin filter lists.".to_string(),
        ui: "Vanilla HTML/CSS/JavaScript (no build step)".to_string(),
        storage: "SQLite (rusqlite) in OS app-data directory".to_string(),
        privacy: "Local-first, zero telemetry, no accounts. Private tabs use WebView2 InPrivate storage.".to_string(),
        platforms: "Windows (primary), Linux (WebKitGTK)".to_string(),
        license: "MIT".to_string(),
        telemetry: "disabled".to_string(),
        repository: "Open source - https://github.com/ritam-browser".to_string(),
        description: "A fast, privacy-first desktop browser built with Tauri 2 and Rust. All data stays on your device.".to_string(),
    }
}

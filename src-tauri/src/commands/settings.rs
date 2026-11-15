//! Settings, privacy (clear browsing data / site permissions) and app info.

use crate::db::{now_ms, DbState};
use crate::error::AppError;
use crate::models::{AppInfo, ClearDataResult, SitePermission};
use rusqlite::params;
use std::collections::HashMap;
use tauri::{State, Url};

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
    "autofill_profiles",
    "recently_closed",
    "muted_sites",
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
    ("autofill_profiles", "[]"),
    ("recently_closed", "[]"),
    ("muted_sites", "[]"),
];

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

fn valid_autofill_profiles(value: &str) -> bool {
    if value == "[]" {
        return true;
    }
    serde_json::from_str::<serde_json::Value>(value)
        .map(|v| v.is_array() && v.as_array().map(|a| a.len() <= 50).unwrap_or(false))
        .unwrap_or(false)
}

pub(crate) fn valid_setting_value(key: &str, value: &str) -> bool {
    match key {
        "search_engine" => SEARCH_ENGINES.contains(&value),
        "theme" => THEMES.contains(&value),
        "restore_session" | "https_first" | "force_dark_websites" | "spellcheck"
        | "do_not_track" | "safe_browsing" | "network_blocking" | "content_blocking" => {
            value == "true" || value == "false"
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
        "autofill_profiles" => value.len() <= 100_000 && valid_autofill_profiles(value),
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
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        map.insert(k, v);
    }
    Ok(map)
}

#[tauri::command]
pub fn set_setting(db: State<'_, DbState>, key: String, value: String) -> Result<serde_json::Value, AppError> {
    let known = KNOWN_KEYS.contains(&key.as_str()) || key.starts_with("zoom:");
    if !known {
        return Err(AppError::InvalidInput(format!("unknown setting key: {key}")));
    }
    if !valid_setting_value(&key, &value) {
        return Err(AppError::InvalidInput(format!("invalid value for setting: {key}")));
    }
    let conn = db.conn();
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(serde_json::json!({ "key": key, "value": value }))
}

#[tauri::command]
pub fn clear_browsing_data(
    db: State<'_, DbState>,
    categories: Vec<String>,
) -> Result<ClearDataResult, AppError> {
    let conn = db.conn();
    let mut result = ClearDataResult { history: 0, downloads: 0, site_permissions: 0 };
    for category in categories {
        match category.as_str() {
            "history" => result.history = conn.execute("DELETE FROM history", [])? as i64,
            "downloads" => result.downloads = conn.execute("DELETE FROM downloads", [])? as i64,
            "site_permissions" => {
                result.site_permissions = conn.execute("DELETE FROM site_permissions", [])? as i64
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
    let mut stmt = conn.prepare(
        "SELECT id, origin, permission, decision, updated_at FROM site_permissions ORDER BY origin ASC",
    )?;
    let rows = stmt.query_map([], |r| {
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
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO site_permissions (id, origin, permission, decision, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(origin, permission) DO UPDATE SET
           decision = excluded.decision,
           updated_at = excluded.updated_at",
        params![id, clean_origin, clean_permission, clean_decision, now],
    )?;
    let perm = conn.query_row(
        "SELECT id, origin, permission, decision, updated_at FROM site_permissions WHERE origin = ?1 AND permission = ?2",
        params![clean_origin, clean_permission],
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
    let changed = match origin {
        Some(o) => conn.execute("DELETE FROM site_permissions WHERE origin = ?1", params![o])?,
        None => conn.execute("DELETE FROM site_permissions", [])?,
    };
    Ok(changed as i64)
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        name: "Govind Browser".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        milestone: "Milestone 1 — Browser shell".to_string(),
        engine: "System WebView2 via Tauri 2 (interim window-embedded WebViews)".to_string(),
        storage: "SQLite at the OS app-data directory".to_string(),
        telemetry: "disabled".to_string(),
    }
}

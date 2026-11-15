//! Encrypted, manual browser-data transfer. Encryption is performed by Web
//! Crypto in the trusted shell; this module handles the local database and
//! the user-selected encrypted file only.

use crate::db::{now_ms, DbState};
use crate::error::AppError;
use crate::models::{
    Bookmark, Download, HistoryEntry, Note, ReadingItem, SitePermission, Tab, Workspace,
};
use crate::navigation::{validate_navigation_url, validate_saved_url};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use tauri::{AppHandle, State};

const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES: usize = 48 * 1024 * 1024;
const MAX_ROWS_PER_TABLE: usize = 50_000;
const KDF_ITERATIONS: u64 = 600_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserBackup {
    version: u32,
    exported_at: i64,
    workspaces: Vec<Workspace>,
    tabs: Vec<Tab>,
    bookmarks: Vec<Bookmark>,
    history: Vec<HistoryEntry>,
    notes: Vec<Note>,
    downloads: Vec<Download>,
    reading_list: Vec<ReadingItem>,
    site_permissions: Vec<SitePermission>,
    settings: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupImportSummary {
    workspaces: usize,
    tabs: usize,
    bookmarks: usize,
    history: usize,
    notes: usize,
    downloads: usize,
    reading_list: usize,
    site_permissions: usize,
    settings: usize,
}

fn collect_rows<T>(
    conn: &Connection,
    sql: &str,
    params: &[&dyn rusqlite::ToSql],
    mut map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, AppError> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(params, |row| map(row))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// A backup holds exactly one profile's data — the one the user is on. Other
/// profiles are never written into the archive.
fn read_snapshot(conn: &Connection) -> Result<BrowserBackup, AppError> {
    let profile = crate::commands::profiles::resolve_active_profile(conn)
        .ok_or_else(|| AppError::InvalidInput("no active profile".into()))?;
    let scope: &[&dyn rusqlite::ToSql] = &[&profile];
    let workspaces = collect_rows(
        conn,
        "SELECT id, name, color, sort_order, created_at FROM workspaces WHERE profile_id = ?1",
        scope,
        |r| {
            Ok(Workspace {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                sort_order: r.get(3)?,
                created_at: r.get(4)?,
            })
        },
    )?;
    let tabs = collect_rows(
        conn,
        "SELECT id, workspace_id, url, title, favicon_url, is_pinned, group_name, sort_order, created_at, last_active_at
         FROM tabs WHERE workspace_id IN (SELECT id FROM workspaces WHERE profile_id = ?1)",
        scope,
        |r| {
            Ok(Tab {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                url: r.get(2)?,
                title: r.get(3)?,
                favicon_url: r.get(4)?,
                is_pinned: r.get(5)?,
                group_name: r.get(6)?,
                sort_order: r.get(7)?,
                created_at: r.get(8)?,
                last_active_at: r.get(9)?,
            })
        },
    )?;
    let bookmarks = collect_rows(
        conn,
        "SELECT id, title, url, is_favorite, sort_order, created_at FROM bookmarks WHERE profile_id = ?1",
        scope,
        |r| {
            Ok(Bookmark {
                id: r.get(0)?,
                title: r.get(1)?,
                url: r.get(2)?,
                is_favorite: r.get(3)?,
                sort_order: r.get(4)?,
                created_at: r.get(5)?,
            })
        },
    )?;
    let history = collect_rows(
        conn,
        "SELECT id, url, title, visited_at, visit_count FROM history WHERE profile_id = ?1",
        scope,
        |r| {
            Ok(HistoryEntry {
                id: r.get(0)?,
                url: r.get(1)?,
                title: r.get(2)?,
                visited_at: r.get(3)?,
                visit_count: r.get(4)?,
            })
        },
    )?;
    let notes = collect_rows(
        conn,
        "SELECT id, workspace_id, content, created_at, updated_at FROM notes WHERE profile_id = ?1",
        scope,
        |r| {
            Ok(Note {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                content: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
            })
        },
    )?;
    let downloads = collect_rows(
        conn,
        "SELECT id, url, filename, destination, mime_type, total_bytes, received_bytes, status, created_at, completed_at
         FROM downloads WHERE profile_id = ?1",
        scope,
        |r| {
            Ok(Download {
                id: r.get(0)?,
                url: r.get(1)?,
                filename: r.get(2)?,
                destination: r.get(3)?,
                mime_type: r.get(4)?,
                total_bytes: r.get(5)?,
                received_bytes: r.get(6)?,
                status: r.get(7)?,
                created_at: r.get(8)?,
                completed_at: r.get(9)?,
            })
        },
    )?;
    let reading_list = collect_rows(
        conn,
        "SELECT id, url, title, snapshot_text, note, created_at FROM reading_list WHERE profile_id = ?1",
        scope,
        |r| {
            Ok(ReadingItem {
                id: r.get(0)?,
                url: r.get(1)?,
                title: r.get(2)?,
                snapshot_text: r.get(3)?,
                note: r.get(4)?,
                created_at: r.get(5)?,
            })
        },
    )?;
    let site_permissions = collect_rows(
        conn,
        "SELECT id, origin, permission, decision, updated_at FROM site_permissions WHERE profile_id = ?1",
        scope,
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
    let settings = {
        let mut statement = conn.prepare("SELECT key, value FROM settings WHERE profile_id = ?1")?;
        let rows = statement.query_map(scope, |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>()?
    };

    Ok(BrowserBackup {
        version: 1,
        exported_at: now_ms(),
        workspaces,
        tabs,
        bookmarks,
        history,
        notes,
        downloads,
        reading_list,
        site_permissions,
        settings,
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn valid_text(value: &str, max_chars: usize) -> bool {
    value.chars().count() <= max_chars && !value.contains('\0')
}

fn validate_backup_saved_url(url: &str) -> Result<(), AppError> {
    let target = validate_saved_url(url)?;
    if target.starts_with("govind://") {
        validate_navigation_url(url)?;
    }
    if target == crate::navigation::HOME_URL {
        return Err(AppError::InvalidInput(
            "home page cannot be imported as saved data".into(),
        ));
    }
    Ok(())
}

fn validate_snapshot(
    conn: &Connection,
    backup: &BrowserBackup,
) -> Result<HashSet<String>, AppError> {
    if backup.version != 1
        || backup.exported_at < 0
        || [
            backup.workspaces.len(),
            backup.tabs.len(),
            backup.bookmarks.len(),
            backup.history.len(),
            backup.notes.len(),
            backup.downloads.len(),
            backup.reading_list.len(),
            backup.site_permissions.len(),
            backup.settings.len(),
        ]
        .iter()
        .any(|count| *count > MAX_ROWS_PER_TABLE)
    {
        return Err(AppError::InvalidInput(
            "unsupported or oversized browser backup".into(),
        ));
    }

    let mut workspace_ids = {
        let mut statement = conn.prepare("SELECT id FROM workspaces")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<HashSet<_>, _>>()?
    };
    for workspace in &backup.workspaces {
        if !valid_id(&workspace.id)
            || !valid_text(&workspace.name, 80)
            || workspace.name.trim().is_empty()
            || workspace.color.len() != 7
            || !workspace.color.starts_with('#')
            || !workspace.color[1..]
                .chars()
                .all(|ch| ch.is_ascii_hexdigit())
            || workspace.created_at < 0
        {
            return Err(AppError::InvalidInput(
                "invalid workspace in browser backup".into(),
            ));
        }
        workspace_ids.insert(workspace.id.clone());
    }

    for tab in &backup.tabs {
        validate_navigation_url(&tab.url)?;
        if !valid_id(&tab.id)
            || !workspace_ids.contains(&tab.workspace_id)
            || !valid_text(&tab.title, 500)
            || !matches!(tab.is_pinned, 0 | 1)
            || tab
                .group_name
                .as_deref()
                .is_some_and(|s| !valid_text(s, 40))
            || tab.created_at < 0
            || tab.last_active_at < 0
        {
            return Err(AppError::InvalidInput(
                "invalid tab in browser backup".into(),
            ));
        }
        if let Some(icon) = &tab.favicon_url {
            validate_saved_url(icon)?;
            if !(icon.starts_with("https://") || icon.starts_with("http://")) {
                return Err(AppError::InvalidInput(
                    "invalid favicon URL in browser backup".into(),
                ));
            }
        }
    }
    for bookmark in &backup.bookmarks {
        validate_backup_saved_url(&bookmark.url)?;
        if !valid_id(&bookmark.id)
            || !valid_text(&bookmark.title, 500)
            || !matches!(bookmark.is_favorite, 0 | 1)
            || bookmark.created_at < 0
        {
            return Err(AppError::InvalidInput(
                "invalid bookmark in browser backup".into(),
            ));
        }
    }
    for item in &backup.history {
        validate_backup_saved_url(&item.url)?;
        if !valid_id(&item.id)
            || !valid_text(&item.title, 500)
            || item.visited_at < 0
            || item.visit_count < 1
        {
            return Err(AppError::InvalidInput(
                "invalid history entry in browser backup".into(),
            ));
        }
    }
    for note in &backup.notes {
        if !valid_id(&note.id)
            || note
                .workspace_id
                .as_deref()
                .is_some_and(|id| !workspace_ids.contains(id))
            || !valid_text(&note.content, 20_000)
            || note.created_at < 0
            || note.updated_at < 0
        {
            return Err(AppError::InvalidInput(
                "invalid note in browser backup".into(),
            ));
        }
    }
    for download in &backup.downloads {
        validate_backup_saved_url(&download.url)?;
        if !valid_id(&download.id)
            || !valid_text(&download.filename, 500)
            || download
                .destination
                .as_deref()
                .is_some_and(|s| !valid_text(s, 1_024))
            || download
                .mime_type
                .as_deref()
                .is_some_and(|s| !valid_text(s, 200))
            || download.total_bytes.is_some_and(|n| n < 0)
            || download.received_bytes < 0
            || !valid_text(&download.status, 40)
            || download.created_at < 0
            || download.completed_at.is_some_and(|n| n < 0)
        {
            return Err(AppError::InvalidInput(
                "invalid download entry in browser backup".into(),
            ));
        }
    }
    for item in &backup.reading_list {
        validate_backup_saved_url(&item.url)?;
        if !valid_id(&item.id)
            || !valid_text(&item.title, 500)
            || item
                .snapshot_text
                .as_deref()
                .is_some_and(|s| !valid_text(s, 200_000))
            || item.note.as_deref().is_some_and(|s| !valid_text(s, 20_000))
            || item.created_at < 0
        {
            return Err(AppError::InvalidInput(
                "invalid reading-list entry in browser backup".into(),
            ));
        }
    }
    for permission in &backup.site_permissions {
        let origin = tauri::Url::parse(&permission.origin).map_err(|_| {
            AppError::InvalidInput("invalid site permission origin in backup".into())
        })?;
        if !valid_id(&permission.id)
            || !matches!(origin.scheme(), "http" | "https")
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || !valid_text(&permission.permission, 64)
            || !matches!(permission.decision.as_str(), "ask" | "allow" | "deny")
        {
            return Err(AppError::InvalidInput(
                "invalid site permission in browser backup".into(),
            ));
        }
    }
    for (key, value) in &backup.settings {
        if !crate::commands::settings::valid_setting_value(key, value)
            || (key == "active_workspace_id" && !workspace_ids.contains(value))
        {
            return Err(AppError::InvalidInput(
                "invalid setting in browser backup".into(),
            ));
        }
    }
    Ok(workspace_ids)
}

fn merge_snapshot(
    conn: &mut Connection,
    backup: BrowserBackup,
) -> Result<BackupImportSummary, AppError> {
    validate_snapshot(conn, &backup)?;
    let profile = crate::commands::profiles::resolve_active_profile(conn)
        .ok_or_else(|| AppError::InvalidInput("no active profile".into()))?;
    let tx = conn.transaction()?;
    let mut summary = BackupImportSummary {
        workspaces: 0,
        tabs: 0,
        bookmarks: 0,
        history: 0,
        notes: 0,
        downloads: 0,
        reading_list: 0,
        site_permissions: 0,
        settings: 0,
    };

    for row in &backup.workspaces {
        summary.workspaces += tx.execute(
            "INSERT OR IGNORE INTO workspaces (id, name, color, sort_order, created_at, profile_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![row.id, row.name, row.color, row.sort_order, row.created_at, profile],
        )?;
    }
    for row in &backup.tabs {
        summary.tabs += tx.execute(
            "INSERT OR IGNORE INTO tabs (id, workspace_id, url, title, favicon_url, is_pinned, group_name, sort_order, created_at, last_active_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![row.id, row.workspace_id, row.url, row.title, row.favicon_url, row.is_pinned, row.group_name, row.sort_order, row.created_at, row.last_active_at],
        )?;
    }
    for row in &backup.bookmarks {
        summary.bookmarks += tx.execute(
            "INSERT OR IGNORE INTO bookmarks (id, profile_id, title, url, is_favorite, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![row.id, profile, row.title, row.url, row.is_favorite, row.sort_order, row.created_at],
        )?;
    }
    for row in &backup.history {
        summary.history += tx.execute(
            "INSERT OR IGNORE INTO history (id, profile_id, url, title, visited_at, visit_count) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(profile_id, url) DO UPDATE SET
               title = CASE WHEN excluded.visited_at > history.visited_at THEN excluded.title ELSE history.title END,
               visited_at = MAX(history.visited_at, excluded.visited_at),
               visit_count = MAX(history.visit_count, excluded.visit_count)
             WHERE excluded.visited_at > history.visited_at OR excluded.visit_count > history.visit_count",
            params![row.id, profile, row.url, row.title, row.visited_at, row.visit_count],
        )?;
    }
    for row in &backup.notes {
        summary.notes += tx.execute(
            "INSERT OR IGNORE INTO notes (id, profile_id, workspace_id, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![row.id, profile, row.workspace_id, row.content, row.created_at, row.updated_at],
        )?;
    }
    for row in &backup.downloads {
        summary.downloads += tx.execute(
            "INSERT OR IGNORE INTO downloads (id, profile_id, url, filename, destination, mime_type, total_bytes, received_bytes, status, created_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![row.id, profile, row.url, row.filename, row.destination, row.mime_type, row.total_bytes, row.received_bytes, row.status, row.created_at, row.completed_at],
        )?;
    }
    for row in &backup.reading_list {
        summary.reading_list += tx.execute(
            "INSERT OR IGNORE INTO reading_list (id, profile_id, url, title, snapshot_text, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![row.id, profile, row.url, row.title, row.snapshot_text, row.note, row.created_at],
        )?;
    }
    for row in &backup.site_permissions {
        summary.site_permissions += tx.execute(
            "INSERT OR IGNORE INTO site_permissions (id, profile_id, origin, permission, decision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![row.id, profile, row.origin, row.permission, row.decision, row.updated_at],
        )?;
    }
    for (key, value) in &backup.settings {
        summary.settings += tx.execute(
            "INSERT OR IGNORE INTO settings (profile_id, key, value) VALUES (?1, ?2, ?3)",
            params![profile, key, value],
        )?;
    }
    tx.commit()?;
    Ok(summary)
}

#[tauri::command]
pub fn export_browser_backup_snapshot(db: State<'_, DbState>) -> Result<String, AppError> {
    let conn = db.conn();
    let snapshot = read_snapshot(&conn)?;
    let json = serde_json::to_string(&snapshot)
        .map_err(|error| AppError::InvalidInput(format!("could not serialize backup: {error}")))?;
    if json.len() > MAX_SNAPSHOT_BYTES {
        return Err(AppError::InvalidInput(
            "browser data is too large to export".into(),
        ));
    }
    Ok(json)
}

#[tauri::command]
pub fn import_browser_backup_snapshot(
    db: State<'_, DbState>,
    snapshot_json: String,
) -> Result<BackupImportSummary, AppError> {
    if snapshot_json.len() > MAX_SNAPSHOT_BYTES {
        return Err(AppError::InvalidInput("browser backup is too large".into()));
    }
    let backup: BrowserBackup = serde_json::from_str(&snapshot_json)
        .map_err(|_| AppError::InvalidInput("invalid browser backup data".into()))?;
    let mut conn = db.conn();
    merge_snapshot(&mut conn, backup)
}

#[tauri::command]
pub fn save_encrypted_browser_backup(
    app: AppHandle,
    encrypted_file: String,
) -> Result<(), AppError> {
    use tauri_plugin_dialog::DialogExt;

    validate_envelope(&encrypted_file)?;
    let file_path = app
        .dialog()
        .file()
        .add_filter("Encrypted Ritam backup", &["gbak"])
        .set_file_name("ritam-browser-backup.gbak")
        .blocking_save_file()
        .ok_or_else(|| AppError::InvalidInput("backup export cancelled".into()))?;
    let path = file_path
        .into_path()
        .map_err(|error| AppError::InvalidInput(format!("bad backup path: {error}")))?;
    std::fs::write(path, encrypted_file)?;
    Ok(())
}

#[tauri::command]
pub fn open_encrypted_browser_backup(app: AppHandle) -> Result<String, AppError> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .add_filter("Encrypted Ritam backup", &["gbak", "json"])
        .blocking_pick_file()
        .ok_or_else(|| AppError::InvalidInput("backup import cancelled".into()))?;
    let path = file_path
        .into_path()
        .map_err(|error| AppError::InvalidInput(format!("bad backup path: {error}")))?;
    read_encrypted_file(&path)
}

fn read_encrypted_file(path: &Path) -> Result<String, AppError> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > MAX_BACKUP_FILE_BYTES as u64 {
        return Err(AppError::InvalidInput(
            "encrypted backup file is too large".into(),
        ));
    }
    let text = std::fs::read_to_string(path)?;
    validate_envelope(&text)?;
    Ok(text)
}

fn validate_envelope(file: &str) -> Result<(), AppError> {
    if file.len() > MAX_BACKUP_FILE_BYTES {
        return Err(AppError::InvalidInput(
            "encrypted backup file is too large".into(),
        ));
    }
    let value: serde_json::Value = serde_json::from_str(file)
        .map_err(|_| AppError::InvalidInput("invalid encrypted backup file".into()))?;
    let valid = value.get("format").and_then(|v| v.as_str()) == Some("govind-encrypted-backup")
        && value.get("version").and_then(|v| v.as_u64()) == Some(1)
        && value.get("kdf").and_then(|v| v.as_str()) == Some("PBKDF2-SHA-256")
        && value.get("iterations").and_then(|v| v.as_u64()) == Some(KDF_ITERATIONS)
        && value.get("cipher").and_then(|v| v.as_str()) == Some("AES-256-GCM")
        && value
            .get("salt")
            .and_then(|v| v.as_str())
            .is_some_and(|v| v.len() == 24)
        && value
            .get("iv")
            .and_then(|v| v.as_str())
            .is_some_and(|v| v.len() == 16)
        && value
            .get("ciphertext")
            .and_then(|v| v.as_str())
            .is_some_and(|v| v.len() >= 24 && v.len() <= MAX_BACKUP_FILE_BYTES);
    if !valid {
        return Err(AppError::InvalidInput(
            "unsupported encrypted backup format".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../migrations/0001_init.sql"))
            .unwrap();
        crate::db::apply_profile_scope(&conn, None).unwrap();
        crate::commands::profiles::ensure_default_profile(&conn).unwrap();
        conn
    }

    fn sample() -> BrowserBackup {
        BrowserBackup {
            version: 1,
            exported_at: 10,
            workspaces: vec![Workspace {
                id: "ws-1".into(),
                name: "Personal".into(),
                color: "#4A6B5D".into(),
                sort_order: 0,
                created_at: 1,
            }],
            tabs: vec![Tab {
                id: "tab-1".into(),
                workspace_id: "ws-1".into(),
                url: "https://example.com".into(),
                title: "Example".into(),
                favicon_url: None,
                is_pinned: 0,
                group_name: None,
                sort_order: 0,
                created_at: 1,
                last_active_at: 2,
            }],
            bookmarks: vec![Bookmark {
                id: "bookmark-1".into(),
                title: "Example".into(),
                url: "https://example.com".into(),
                is_favorite: 1,
                sort_order: 0,
                created_at: 1,
            }],
            history: vec![HistoryEntry {
                id: "history-1".into(),
                url: "https://example.com".into(),
                title: "Example".into(),
                visited_at: 2,
                visit_count: 2,
            }],
            notes: vec![],
            downloads: vec![],
            reading_list: vec![],
            site_permissions: vec![],
            settings: HashMap::from([("active_workspace_id".into(), "ws-1".into())]),
        }
    }

    #[test]
    fn backup_merge_is_idempotent_and_preserves_existing_data() {
        let mut conn = test_connection();
        let first = merge_snapshot(&mut conn, sample()).unwrap();
        let second = merge_snapshot(&mut conn, sample()).unwrap();
        assert_eq!(first.workspaces, 1);
        assert_eq!(first.tabs, 1);
        assert_eq!(first.bookmarks, 1);
        assert_eq!(second.workspaces, 0);
        assert_eq!(second.tabs, 0);
        assert_eq!(second.bookmarks, 0);
        assert_eq!(second.history, 0);
        let history: i64 = conn
            .query_row(
                "SELECT visit_count FROM history WHERE url = ?1",
                ["https://example.com"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(history, 2);
    }

    #[test]
    fn invalid_snapshot_is_rejected_before_any_rows_are_written() {
        let mut conn = test_connection();
        let mut backup = sample();
        backup.tabs[0].url = "javascript:alert(1)".into();
        assert!(merge_snapshot(&mut conn, backup).is_err());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn existing_bookmark_wins_url_conflicts() {
        let mut conn = test_connection();
        let profile = crate::commands::profiles::resolve_active_profile(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, name, color, sort_order, created_at, profile_id) VALUES ('ws-1', 'Local', '#4A6B5D', 0, 1, ?1)",
            [&profile],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO bookmarks (id, profile_id, title, url, is_favorite, sort_order, created_at)
             VALUES ('local-bookmark', ?1, 'Keep this title', 'https://example.com', 0, 0, 1)",
            [&profile],
        )
        .unwrap();
        let summary = merge_snapshot(&mut conn, sample()).unwrap();
        assert_eq!(summary.bookmarks, 0);
        let title: String = conn
            .query_row(
                "SELECT title FROM bookmarks WHERE url = ?1",
                ["https://example.com"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Keep this title");
    }
}

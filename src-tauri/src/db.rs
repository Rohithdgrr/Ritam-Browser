use crate::error::AppError;
use rusqlite::Connection;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager};

/// Embedded so the exact schema ships inside the binary.
const SCHEMA: &str = include_str!("../migrations/0001_init.sql");

pub struct DbState {
    conn: Mutex<Connection>,
}

impl DbState {
    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        // A poisoned mutex still holds a valid connection — keep serving.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

pub fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        [key, value],
    )?;
    Ok(())
}

pub fn active_profile_id(conn: &Connection) -> Option<String> {
    setting(conn, "active_profile_id")
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    Ok(names
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Open (creating if needed) the SQLite database and apply the schema.
pub fn init(app: &AppHandle) -> Result<DbState, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(format!("could not resolve app data dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    let db_path = dir.join("govind.db");
    log::info!("opening SQLite at {}", db_path.display());

    let conn = Connection::open(&db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(SCHEMA)?;
    if !has_column(&conn, "tabs", "group_name")? {
        conn.execute("ALTER TABLE tabs ADD COLUMN group_name TEXT", [])?;
    }
    // Profiles own workspaces; databases created before profiles existed get the
    // column here and are claimed by the default profile below.
    if !has_column(&conn, "workspaces", "profile_id")? {
        conn.execute("ALTER TABLE workspaces ADD COLUMN profile_id TEXT", [])?;
    }
    crate::commands::profiles::ensure_default_profile(&conn)?;

    // First-run seeding: one workspace, no tabs (a home tab opens in the UI),
    // three removable favorites.
    let workspace_count: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?;
    if workspace_count == 0 {
        let ws_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO workspaces (id, name, color, sort_order, created_at) VALUES (?1, 'Personal', '#4A6B5D', 0, ?2)",
            rusqlite::params![ws_id, now_ms()],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('active_workspace_id', ?1)",
            rusqlite::params![ws_id],
        )?;
        for (i, (title, url)) in [
            ("Wikipedia", "https://www.wikipedia.org"),
            ("MDN Web Docs", "https://developer.mozilla.org"),
            ("GitHub", "https://github.com"),
        ]
        .iter()
        .enumerate()
        {
            conn.execute(
                "INSERT OR IGNORE INTO bookmarks (id, title, url, is_favorite, sort_order, created_at)
                 VALUES (?1, ?2, ?3, 1, ?4, ?5)",
                rusqlite::params![uuid::Uuid::new_v4().to_string(), title, url, i as i64, now_ms()],
            )?;
        }
    }

    Ok(DbState { conn: Mutex::new(conn) })
}

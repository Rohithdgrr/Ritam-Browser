use crate::error::AppError;
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager};

/// Embedded so the exact schema ships inside the binary.
const SCHEMA: &str = include_str!("../migrations/0001_init.sql");
/// Bumped when `migrate_profile_scope` has reshaped the database.
const SCHEMA_VERSION: i64 = 4;
/// Settings keys that describe the app, not a profile: they live in
/// `shell_state` so switching profiles can never lose the active id.
pub const SHELL_KEYS: &[&str] = &["active_profile_id", "active_workspace_id"];

pub struct DbState {
    conn: Mutex<Connection>,
}

impl DbState {
    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        // A poisoned mutex still holds a valid connection — keep serving.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// App-wide state (active profile/workspace, theme bootstrap).
pub fn shell_state(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM shell_state WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

pub fn set_shell_state(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    conn.execute(
        "INSERT OR REPLACE INTO shell_state (key, value) VALUES (?1, ?2)",
        [key, value],
    )?;
    Ok(())
}

/// A setting of the profile the shell is currently on.
pub fn setting(conn: &Connection, key: &str) -> Option<String> {
    let profile = active_profile_id(conn)?;
    setting_for(conn, &profile, key)
}

pub fn setting_for(conn: &Connection, profile_id: &str, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE profile_id = ?1 AND key = ?2",
        [profile_id, key],
        |r| r.get(0),
    )
    .ok()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    let profile = active_profile_id(conn)
        .ok_or_else(|| AppError::InvalidInput("no active profile".into()))?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (profile_id, key, value) VALUES (?1, ?2, ?3)",
        [&profile, key, value],
    )?;
    Ok(())
}

pub fn active_profile_id(conn: &Connection) -> Option<String> {
    shell_state(conn, "active_profile_id")
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    Ok(names
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column))
}

/// Every workspace owns exactly one fixed AI workspace tab. It is kept first
/// (pinned, sort -1) and the tab commands refuse to close or move it.
pub fn ensure_ai_tab(conn: &Connection, workspace_id: &str) -> Result<(), AppError> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT id FROM tabs WHERE workspace_id = ?1 AND url = ?2 ORDER BY sort_order ASC",
        )?;
        let rows = stmt.query_map([workspace_id, crate::navigation::AI_URL], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };

    if let Some((keep, extras)) = ids.split_first() {
        conn.execute(
            "UPDATE tabs SET title = 'AI Workspace', is_pinned = 1, sort_order = -1 WHERE id = ?1",
            [keep],
        )?;
        for id in extras {
            conn.execute("DELETE FROM tabs WHERE id = ?1", [id])?;
        }
        return Ok(());
    }

    conn.execute(
        "INSERT INTO tabs (id, workspace_id, url, title, favicon_url, is_pinned, group_name, sort_order, created_at, last_active_at)
         VALUES (?1, ?2, ?3, 'AI Workspace', NULL, 1, NULL, -1, ?4, 0)",
        rusqlite::params![uuid::Uuid::new_v4().to_string(), workspace_id, crate::navigation::AI_URL, now_ms()],
    )?;
    Ok(())
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
    apply_profile_scope(&conn, Some(&db_path))?;
    if !has_column(&conn, "tabs", "group_name")? {
        conn.execute("ALTER TABLE tabs ADD COLUMN group_name TEXT", [])?;
    }
    // Profiles own workspaces; databases created before profiles existed get the
    // column here and are claimed by the default profile below.
    if !has_column(&conn, "workspaces", "profile_id")? {
        conn.execute("ALTER TABLE workspaces ADD COLUMN profile_id TEXT", [])?;
    }
    if !has_column(&conn, "profiles", "avatar")? {
        conn.execute("ALTER TABLE profiles ADD COLUMN avatar TEXT", [])?;
    }
    crate::commands::profiles::ensure_default_profile(&conn)?;

    // First-run seeding: one workspace with its fixed AI tab, three removable favorites.
    let workspace_count: i64 = conn.query_row("SELECT COUNT(*) FROM workspaces", [], |r| r.get(0))?;
    // Existing databases get the fixed AI tab too; it is rewritten in place on
    // every launch so its title and first position cannot drift.
    let workspaces: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM workspaces ORDER BY sort_order ASC")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    for workspace_id in &workspaces {
        ensure_ai_tab(&conn, workspace_id)?;
    }

    if workspace_count == 0 {
        let ws_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO workspaces (id, name, color, sort_order, created_at) VALUES (?1, 'Personal', '#4A6B5D', 0, ?2)",
            rusqlite::params![ws_id, now_ms()],
        )?;
        ensure_ai_tab(&conn, &ws_id)?;
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

/// One-time reshape (schema v2): every row that used to be global belongs to
/// the profile that was active at upgrade time. Runs inside a transaction and
/// leaves a `.bak-0002` copy of the previous database next to it.
pub fn apply_profile_scope(conn: &Connection, db_path: Option<&Path>) -> Result<(), AppError> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 2 {
        apply_v2(conn, db_path)?;
    }
    if version < 3 {
        apply_v3(conn)?;
    }
    if version < 4 {
        apply_v4(conn)?;
    }
    Ok(())
}

/// Additive schema v4: bookmarks gain a folder name so search can cover the
/// folder a bookmark was filed under. Nothing is rewritten.
fn apply_v4(conn: &Connection) -> Result<(), AppError> {
    if !has_column(conn, "bookmarks", "folder")? {
        conn.execute(
            "ALTER TABLE bookmarks ADD COLUMN folder TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

/// Additive schema v3: bookmark tags and notes, download scan status, and the
/// per-site time ledger behind the statistics page. Nothing is rewritten, so
/// no backup copy is needed.
fn apply_v3(conn: &Connection) -> Result<(), AppError> {
    for (table, column) in [
        ("bookmarks", "tags"),
        ("bookmarks", "notes"),
        ("downloads", "scan_status"),
    ] {
        if !has_column(conn, table, column)? {
            conn.execute(
                &format!("ALTER TABLE {table} ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"),
                [],
            )?;
        }
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS site_time (
           profile_id TEXT NOT NULL, host TEXT NOT NULL, day TEXT NOT NULL,
           seconds INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (profile_id, host, day));",
    )?;
    conn.pragma_update(None, "user_version", 3)?;
    Ok(())
}

fn apply_v2(conn: &Connection, db_path: Option<&Path>) -> Result<(), AppError> {
    if let Some(path) = db_path {
        let backup = path.with_extension("db.bak-0002");
        if path.exists() && !backup.exists() {
            std::fs::copy(path, &backup)?;
        }
    }
    let active: String = conn
        .query_row(
            "SELECT id FROM profiles ORDER BY sort_order ASC, created_at ASC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or_default();

    conn.execute_batch("CREATE TABLE IF NOT EXISTS shell_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
    conn.execute(
        "INSERT OR REPLACE INTO shell_state (key, value)
         SELECT key, value FROM settings WHERE key IN ('active_profile_id', 'active_workspace_id')",
        [],
    )?;
    // `autofill_profiles` was a single global blob; v2 keeps auto-fill in a
    // per-profile file instead.
    conn.execute(
        "DELETE FROM settings WHERE key IN ('active_profile_id', 'active_workspace_id', 'autofill_profiles')",
        [],
    )?;

    let tx = conn.unchecked_transaction()?;
    rebuild_table(
        &tx,
        "CREATE TABLE bookmarks_v2 (
           id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
           is_favorite INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL, UNIQUE (profile_id, url))",
        "INSERT INTO bookmarks_v2 (id, profile_id, title, url, is_favorite, sort_order, created_at)
           SELECT id, ?1, title, url, is_favorite, sort_order, created_at FROM bookmarks",
        "bookmarks",
        &active,
    )?;
    rebuild_table(
        &tx,
        "CREATE TABLE history_v2 (
           id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
           visited_at INTEGER NOT NULL, visit_count INTEGER NOT NULL DEFAULT 1,
           UNIQUE (profile_id, url))",
        "INSERT INTO history_v2 (id, profile_id, url, title, visited_at, visit_count)
           SELECT id, ?1, url, title, visited_at, visit_count FROM history",
        "history",
        &active,
    )?;
    tx.execute_batch("CREATE INDEX idx_history_visited ON history(visited_at DESC)")?;
    rebuild_table(
        &tx,
        "CREATE TABLE reading_list_v2 (
           id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
           snapshot_text TEXT, note TEXT, created_at INTEGER NOT NULL,
           UNIQUE (profile_id, url))",
        "INSERT INTO reading_list_v2 (id, profile_id, url, title, snapshot_text, note, created_at)
           SELECT id, ?1, url, title, snapshot_text, note, created_at FROM reading_list",
        "reading_list",
        &active,
    )?;
    tx.execute_batch("CREATE INDEX idx_reading_list_created ON reading_list(created_at DESC)")?;
    rebuild_table(
        &tx,
        "CREATE TABLE site_permissions_v2 (
           id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, origin TEXT NOT NULL,
           permission TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('ask', 'allow', 'deny')),
           updated_at INTEGER NOT NULL, UNIQUE (profile_id, origin, permission))",
        "INSERT INTO site_permissions_v2 (id, profile_id, origin, permission, decision, updated_at)
           SELECT id, ?1, origin, permission, decision, updated_at FROM site_permissions",
        "site_permissions",
        &active,
    )?;
    rebuild_table(
        &tx,
        "CREATE TABLE settings_v2 (
           profile_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
           PRIMARY KEY (profile_id, key))",
        "INSERT INTO settings_v2 (profile_id, key, value) SELECT ?1, key, value FROM settings",
        "settings",
        &active,
    )?;
    for table in ["downloads", "notes"] {
        if !has_column(&tx, table, "profile_id")? {
            tx.execute(&format!("ALTER TABLE {table} ADD COLUMN profile_id TEXT NOT NULL DEFAULT ''"), [])?;
            tx.execute(&format!("UPDATE {table} SET profile_id = ?1"), [&active])?;
        }
    }
    tx.pragma_update(None, "user_version", 2)?;
    tx.commit()?;
    Ok(())
}

fn rebuild_table(
    conn: &Connection,
    create_sql: &str,
    copy_sql: &str,
    table: &str,
    active: &str,
) -> Result<(), AppError> {
    conn.execute_batch(create_sql)?;
    conn.execute(copy_sql, [active])?;
    conn.execute_batch(&format!(
        "DROP TABLE {table}; ALTER TABLE {table}_v2 RENAME TO {table}"
    ))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ai_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, color TEXT, sort_order INTEGER, created_at INTEGER, profile_id TEXT);
             CREATE TABLE tabs (
               id TEXT PRIMARY KEY, workspace_id TEXT, url TEXT, title TEXT, favicon_url TEXT,
               is_pinned INTEGER DEFAULT 0, group_name TEXT, sort_order INTEGER DEFAULT 0,
               created_at INTEGER, last_active_at INTEGER
             );
             INSERT INTO workspaces VALUES ('ws', 'Personal', '#000', 0, 1, NULL);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn ai_tab_is_created_once_and_stays_first() {
        let conn = ai_test_db();
        ensure_ai_tab(&conn, "ws").unwrap();
        ensure_ai_tab(&conn, "ws").unwrap();
        let (count, title, pinned, order): (i64, String, i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(title), MAX(is_pinned), MAX(sort_order) FROM tabs WHERE workspace_id = 'ws'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(title, "AI Workspace");
        assert_eq!(pinned, 1);
        assert_eq!(order, -1);
    }

    #[test]
    fn duplicate_ai_tabs_are_collapsed_to_one() {
        let conn = ai_test_db();
        ensure_ai_tab(&conn, "ws").unwrap();
        conn.execute(
            "INSERT INTO tabs (id, workspace_id, url, title, is_pinned, sort_order, created_at, last_active_at)
             VALUES ('dupe', 'ws', ?1, 'ai', 0, 5, 1, 1)",
            [crate::navigation::AI_URL],
        )
        .unwrap();
        ensure_ai_tab(&conn, "ws").unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tabs WHERE url = ?1", [crate::navigation::AI_URL], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}

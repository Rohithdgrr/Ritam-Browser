//! Versioned migrations: every step has an `up` and a `down`, recorded in
//! the `migrations` table. `Store::open` migrates up; `Store::downgrade`
//! applies down steps in reverse so ROT's gates can prove reversibility.

use rusqlite::{Connection, Transaction};

use crate::error::StoreError;

pub(crate) const LATEST_VERSION: i64 = 1;

pub(crate) struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub up: fn(&Transaction) -> Result<(), StoreError>,
    pub down: fn(&Transaction) -> Result<(), StoreError>,
}

const V1_UP: &str = "
CREATE TABLE settings (
    key           TEXT PRIMARY KEY,
    value         TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE bookmark_folders (
    id            INTEGER PRIMARY KEY,
    parent_id     INTEGER REFERENCES bookmark_folders(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    position      INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE bookmarks (
    id            INTEGER PRIMARY KEY,
    folder_id     INTEGER REFERENCES bookmark_folders(id) ON DELETE CASCADE,
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,
    position      INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
-- A duplicate is the same url in the same folder; root (NULL) counts as 0
-- because SQLite treats NULLs as distinct in unique indexes.
CREATE UNIQUE INDEX bookmarks_folder_url ON bookmarks(url, IFNULL(folder_id, 0));

CREATE TABLE history (
    id            INTEGER PRIMARY KEY,
    url           TEXT NOT NULL,
    title         TEXT NOT NULL,
    host          TEXT NOT NULL,
    visited_at_ms INTEGER NOT NULL,
    duration_ms   INTEGER,
    http_status   INTEGER,
    transition    TEXT NOT NULL
);
CREATE INDEX history_visited_at ON history(visited_at_ms DESC);
CREATE INDEX history_host ON history(host);

CREATE VIRTUAL TABLE history_fts USING fts5(
    url, title, host, content='history', content_rowid='id'
);
CREATE TRIGGER history_fts_insert AFTER INSERT ON history BEGIN
    INSERT INTO history_fts(rowid, url, title, host)
    VALUES (new.id, new.url, new.title, new.host);
END;
CREATE TRIGGER history_fts_delete AFTER DELETE ON history BEGIN
    INSERT INTO history_fts(history_fts, rowid, url, title, host)
    VALUES ('delete', old.id, old.url, old.title, old.host);
END;
CREATE TRIGGER history_fts_update AFTER UPDATE ON history BEGIN
    INSERT INTO history_fts(history_fts, rowid, url, title, host)
    VALUES ('delete', old.id, old.url, old.title, old.host);
    INSERT INTO history_fts(rowid, url, title, host)
    VALUES (new.id, new.url, new.title, new.host);
END;

CREATE TABLE downloads (
    id              INTEGER PRIMARY KEY,
    url             TEXT NOT NULL,
    filename        TEXT NOT NULL,
    mime_type       TEXT,
    save_path       TEXT,
    state           TEXT NOT NULL,
    bytes_received  INTEGER NOT NULL DEFAULT 0,
    bytes_total     INTEGER,
    error           TEXT,
    started_at_ms   INTEGER NOT NULL,
    updated_at_ms   INTEGER NOT NULL,
    finished_at_ms  INTEGER
);
CREATE INDEX downloads_updated_at ON downloads(updated_at_ms DESC);

CREATE TABLE notes (
    id            INTEGER PRIMARY KEY,
    title         TEXT NOT NULL DEFAULT '',
    body          TEXT NOT NULL,
    url           TEXT,
    revision      INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE TABLE session_state (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    active_tab_id  INTEGER NOT NULL,
    tab_count      INTEGER NOT NULL,
    updated_at_ms  INTEGER NOT NULL
);

CREATE TABLE session_tabs (
    tab_id   INTEGER PRIMARY KEY,
    url      TEXT NOT NULL,
    title    TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL
);
";

const V1_DOWN: &str = "
DROP TABLE session_tabs;
DROP TABLE session_state;
DROP TABLE notes;
DROP TABLE downloads;
DROP TRIGGER history_fts_update;
DROP TRIGGER history_fts_delete;
DROP TRIGGER history_fts_insert;
DROP TABLE history_fts;
DROP TABLE history;
DROP TABLE bookmarks;
DROP TABLE bookmark_folders;
DROP TABLE settings;
";

fn v1_up(tx: &Transaction) -> Result<(), StoreError> {
    tx.execute_batch(V1_UP)?;
    Ok(())
}

fn v1_down(tx: &Transaction) -> Result<(), StoreError> {
    tx.execute_batch(V1_DOWN)?;
    Ok(())
}

pub(crate) const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "v1_core",
    up: v1_up,
    down: v1_down,
}];

pub(crate) fn current_version(conn: &Connection) -> Result<i64, StoreError> {
    // The migrations table may not exist yet on first open; that is version 0.
    let has_table: bool = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'migrations'",
        [],
        |r| r.get(0),
    )?;
    if !has_table {
        return Ok(0);
    }
    let version: Option<i64> =
        conn.query_row("SELECT MAX(version) FROM migrations", [], |r| r.get(0))?;
    Ok(version.unwrap_or(0))
}

pub(crate) fn migrate_up(conn: &Connection, target: i64) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS migrations (
            version       INTEGER PRIMARY KEY,
            name          TEXT NOT NULL,
            applied_at_ms INTEGER NOT NULL
        );",
    )?;
    let mut version = current_version(conn)?;
    while version < target {
        let m = MIGRATIONS
            .iter()
            .find(|m| m.version == version + 1)
            .ok_or_else(|| {
                StoreError::Sqlite(format!("no migration for version {}", version + 1))
            })?;
        let tx = conn.unchecked_transaction()?;
        (m.up)(&tx)?;
        tx.execute(
            "INSERT INTO migrations (version, name, applied_at_ms) VALUES (?1, ?2, ?3)",
            rusqlite::params![m.version, m.name, crate::model::now_ms()],
        )?;
        tx.commit()?;
        version = m.version;
    }
    Ok(())
}

pub(crate) fn migrate_down(conn: &Connection, target: i64) -> Result<(), StoreError> {
    if target < 0 {
        return Err(StoreError::InvalidInput(format!(
            "downgrade target {target} is negative"
        )));
    }
    let mut version = current_version(conn)?;
    while version > target {
        let m = MIGRATIONS
            .iter()
            .find(|m| m.version == version)
            .ok_or_else(|| StoreError::Sqlite(format!("no migration for version {version}")))?;
        let tx = conn.unchecked_transaction()?;
        (m.down)(&tx)?;
        tx.execute("DELETE FROM migrations WHERE version = ?1", [m.version])?;
        tx.commit()?;
        version -= 1;
    }
    Ok(())
}

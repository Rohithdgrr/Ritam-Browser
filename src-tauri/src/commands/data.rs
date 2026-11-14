//! Bookmarks, history, notes and downloads — plain SQL over the local database.

use crate::db::{now_ms, DbState};
use crate::error::AppError;
use crate::models::{Bookmark, Download, HistoryEntry, Note};
use crate::navigation::validate_saved_url;
use rusqlite::params;
use tauri::State;

// ── Bookmarks ─────────────────────────────────────────────────────────

fn row_to_bookmark(row: &rusqlite::Row) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: row.get(0)?,
        title: row.get(1)?,
        url: row.get(2)?,
        is_favorite: row.get(3)?,
        sort_order: row.get(4)?,
        created_at: row.get(5)?,
    })
}
const BOOKMARK_COLS: &str = "id, title, url, is_favorite, sort_order, created_at";

#[tauri::command]
pub fn list_bookmarks(db: State<'_, DbState>) -> Result<Vec<Bookmark>, AppError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(&format!(
        "SELECT {BOOKMARK_COLS} FROM bookmarks ORDER BY is_favorite DESC, sort_order ASC, created_at DESC"
    ))?;
    let rows = stmt.query_map([], row_to_bookmark)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[tauri::command]
pub fn save_bookmark(
    db: State<'_, DbState>,
    title: Option<String>,
    url: String,
    is_favorite: Option<i64>,
) -> Result<Bookmark, AppError> {
    let target = validate_saved_url(&url)?;
    if target == crate::navigation::HOME_URL {
        return Err(AppError::InvalidInput("cannot bookmark the internal home page".into()));
    }
    let favorite = i64::from(is_favorite.unwrap_or(0) != 0);
    let clean_title: String = title
        .as_deref()
        .unwrap_or(&target)
        .chars()
        .take(500)
        .collect();

    let conn = db.conn();
    let order: i64 =
        conn.query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM bookmarks", [], |r| r.get(0))?;
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO bookmarks (id, title, url, is_favorite, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title,
           is_favorite = MAX(bookmarks.is_favorite, excluded.is_favorite)",
        params![id, clean_title, target, favorite, order, now_ms()],
    )?;
    let bookmark = conn.query_row(
        &format!("SELECT {BOOKMARK_COLS} FROM bookmarks WHERE url = ?1"),
        params![target],
        row_to_bookmark,
    )?;
    Ok(bookmark)
}

#[tauri::command]
pub fn delete_bookmark(db: State<'_, DbState>, bookmark_id: String) -> Result<bool, AppError> {
    let conn = db.conn();
    let changed = conn.execute("DELETE FROM bookmarks WHERE id = ?1", params![bookmark_id])?;
    Ok(changed > 0)
}

#[tauri::command]
pub fn toggle_favorite(db: State<'_, DbState>, bookmark_id: String) -> Result<Bookmark, AppError> {
    let conn = db.conn();
    let changed = conn.execute(
        "UPDATE bookmarks SET is_favorite = 1 - is_favorite WHERE id = ?1",
        params![bookmark_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("bookmark not found".into()));
    }
    let bookmark = conn.query_row(
        &format!("SELECT {BOOKMARK_COLS} FROM bookmarks WHERE id = ?1"),
        params![bookmark_id],
        row_to_bookmark,
    )?;
    Ok(bookmark)
}

// ── History ───────────────────────────────────────────────────────────

fn row_to_history(row: &rusqlite::Row) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        visited_at: row.get(3)?,
        visit_count: row.get(4)?,
    })
}

#[tauri::command]
pub fn search_history(
    db: State<'_, DbState>,
    query: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<HistoryEntry>, AppError> {
    let q = query.unwrap_or_default().trim().to_lowercase();
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let conn = db.conn();
    let mut out = Vec::new();
    if q.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT id, url, title, visited_at, visit_count FROM history ORDER BY visited_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], row_to_history)?;
        for row in rows { out.push(row?); }
    } else {
        let pattern = format!("%{}%", q.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = conn.prepare(
            "SELECT id, url, title, visited_at, visit_count FROM history
             WHERE lower(url) LIKE ?1 ESCAPE '\\' OR lower(title) LIKE ?1 ESCAPE '\\'
             ORDER BY visited_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], row_to_history)?;
        for row in rows { out.push(row?); }
    }
    Ok(out)
}

#[tauri::command]
pub fn add_history_entry(
    db: State<'_, DbState>,
    url: String,
    title: Option<String>,
) -> Result<Option<HistoryEntry>, AppError> {
    let Ok(target) = validate_saved_url(&url) else { return Ok(None) };
    if target == crate::navigation::HOME_URL {
        return Ok(None);
    }
    let clean_title: String = title.as_deref().unwrap_or(&target).chars().take(500).collect();
    let conn = db.conn();
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO history (id, url, title, visited_at, visit_count) VALUES (?1, ?2, ?3, ?4, 1)
         ON CONFLICT(url) DO UPDATE SET
           visited_at = excluded.visited_at,
           visit_count = history.visit_count + 1,
           title = excluded.title",
        params![id, target, clean_title, now_ms()],
    )?;
    let entry = conn.query_row(
        "SELECT id, url, title, visited_at, visit_count FROM history WHERE url = ?1",
        params![target],
        row_to_history,
    )?;
    Ok(Some(entry))
}

#[tauri::command]
pub fn delete_history_entry(db: State<'_, DbState>, history_id: String) -> Result<bool, AppError> {
    let conn = db.conn();
    let changed = conn.execute("DELETE FROM history WHERE id = ?1", params![history_id])?;
    Ok(changed > 0)
}

// ── Notes (scratchpad) ────────────────────────────────────────────────

fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        content: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

#[tauri::command]
pub fn save_note(
    db: State<'_, DbState>,
    note_id: Option<String>,
    content: String,
    workspace_id: Option<String>,
) -> Result<Note, AppError> {
    let clean: String = content.chars().take(20_000).collect();
    if clean.trim().is_empty() {
        return Err(AppError::InvalidInput("note content is required".into()));
    }
    let conn = db.conn();
    if let Some(id) = note_id {
        let changed = conn.execute(
            "UPDATE notes SET content = ?1, updated_at = ?2 WHERE id = ?3",
            params![clean, now_ms(), id],
        )?;
        if changed == 0 {
            return Err(AppError::NotFound("note not found".into()));
        }
        let note = conn.query_row(
            "SELECT id, workspace_id, content, created_at, updated_at FROM notes WHERE id = ?1",
            params![id],
            row_to_note,
        )?;
        return Ok(note);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO notes (id, workspace_id, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, workspace_id, clean, now],
    )?;
    let note = conn.query_row(
        "SELECT id, workspace_id, content, created_at, updated_at FROM notes WHERE id = ?1",
        params![id],
        row_to_note,
    )?;
    Ok(note)
}

#[tauri::command]
pub fn list_notes(db: State<'_, DbState>, workspace_id: Option<String>) -> Result<Vec<Note>, AppError> {
    let conn = db.conn();
    let mut stmt;
    let rows = match &workspace_id {
        Some(ws) => {
            stmt = conn.prepare(
                "SELECT id, workspace_id, content, created_at, updated_at FROM notes
                 WHERE workspace_id = ?1 OR workspace_id IS NULL
                 ORDER BY updated_at DESC",
            )?;
            stmt.query_map(params![ws], row_to_note)?.collect::<Result<Vec<_>, _>>()?
        }
        None => {
            stmt = conn.prepare(
                "SELECT id, workspace_id, content, created_at, updated_at FROM notes ORDER BY updated_at DESC",
            )?;
            stmt.query_map([], row_to_note)?.collect::<Result<Vec<_>, _>>()?
        }
    };
    Ok(rows)
}

#[tauri::command]
pub fn delete_note(db: State<'_, DbState>, note_id: String) -> Result<bool, AppError> {
    let conn = db.conn();
    let changed = conn.execute("DELETE FROM notes WHERE id = ?1", params![note_id])?;
    Ok(changed > 0)
}

// ── Downloads ─────────────────────────────────────────────────────────

fn row_to_download(row: &rusqlite::Row) -> rusqlite::Result<Download> {
    Ok(Download {
        id: row.get(0)?,
        url: row.get(1)?,
        filename: row.get(2)?,
        destination: row.get(3)?,
        mime_type: row.get(4)?,
        total_bytes: row.get(5)?,
        received_bytes: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        completed_at: row.get(9)?,
    })
}
const DOWNLOAD_COLS: &str =
    "id, url, filename, destination, mime_type, total_bytes, received_bytes, status, created_at, completed_at";

#[tauri::command]
pub fn list_downloads(db: State<'_, DbState>) -> Result<Vec<Download>, AppError> {
    let conn = db.conn();
    let mut stmt = conn.prepare(&format!(
        "SELECT {DOWNLOAD_COLS} FROM downloads ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map([], row_to_download)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Record a completed download entry. Used by the UI for user-initiated downloads;
/// engine-level download interception is a spike item (docs/ENGINE_SPIKE.md).
#[tauri::command]
pub fn record_download(
    db: State<'_, DbState>,
    url: String,
    filename: String,
    destination: Option<String>,
    total_bytes: Option<i64>,
    mime_type: Option<String>,
) -> Result<Download, AppError> {
    let target = validate_saved_url(&url)?;
    let clean_name: String = filename.chars().take(500).collect();
    let clean_mime: Option<String> = mime_type.map(|m| m.chars().take(200).collect());
    let clean_dest: Option<String> = destination
        .map(|d| d.chars().take(1024).collect())
        .filter(|d: &String| !d.is_empty());
    let conn = db.conn();
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO downloads (id, url, filename, destination, mime_type, total_bytes, received_bytes, status, created_at, completed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'completed', ?7, ?7)",
        params![id, target, clean_name, clean_dest, clean_mime, total_bytes.unwrap_or(0), now],
    )?;
    let d = conn.query_row(
        &format!("SELECT {DOWNLOAD_COLS} FROM downloads WHERE id = ?1"),
        params![id],
        row_to_download,
    )?;
    Ok(d)
}

#[tauri::command]
pub fn clear_downloads(db: State<'_, DbState>) -> Result<i64, AppError> {
    let conn = db.conn();
    let changed = conn.execute("DELETE FROM downloads", [])?;
    Ok(changed as i64)
}

/// Remove a single entry from the download list (the file itself is kept).
#[tauri::command]
pub fn remove_download(db: State<'_, DbState>, download_id: String) -> Result<bool, AppError> {
    let conn = db.conn();
    let changed = conn.execute("DELETE FROM downloads WHERE id = ?1", params![download_id])?;
    Ok(changed > 0)
}

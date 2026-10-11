//! Bookmarks and folders: CRUD, folders, ordering, duplicate handling.

use rusqlite::{params, OptionalExtension};

use crate::error::StoreError;
use crate::model::{
    validate_str, validate_timestamp, validate_url, Bookmark, BookmarkAddOutcome, BookmarkFolder,
    NewBookmark, MAX_FOLDER_NAME_LEN,
};
use crate::ops::count_skip;
use crate::Actor;

const BOOKMARK_COLS: &str = "id, folder_id, url, title, position, created_at_ms, updated_at_ms";
const FOLDER_COLS: &str = "id, parent_id, name, position, created_at_ms, updated_at_ms";

struct RawBookmark {
    id: i64,
    folder_id: Option<i64>,
    url: String,
    title: String,
    position: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl RawBookmark {
    fn into_valid(self) -> Result<Bookmark, StoreError> {
        validate_url("url", &self.url)?;
        validate_title_on_read(&self.title)?;
        validate_timestamp("created_at_ms", self.created_at_ms)?;
        validate_timestamp("updated_at_ms", self.updated_at_ms)?;
        Ok(Bookmark {
            id: self.id,
            folder_id: self.folder_id,
            url: self.url,
            title: self.title,
            position: self.position,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
        })
    }
}

fn validate_title_on_read(title: &str) -> Result<(), StoreError> {
    validate_str("title", title, 0, crate::model::MAX_TITLE_LEN, false)
}

struct RawFolder {
    id: i64,
    parent_id: Option<i64>,
    name: String,
    position: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl RawFolder {
    fn into_valid(self) -> Result<BookmarkFolder, StoreError> {
        validate_str("name", &self.name, 1, MAX_FOLDER_NAME_LEN, false)?;
        validate_timestamp("created_at_ms", self.created_at_ms)?;
        validate_timestamp("updated_at_ms", self.updated_at_ms)?;
        Ok(BookmarkFolder {
            id: self.id,
            parent_id: self.parent_id,
            name: self.name,
            position: self.position,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
        })
    }
}

fn map_bookmark(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawBookmark> {
    Ok(RawBookmark {
        id: row.get(0)?,
        folder_id: row.get(1)?,
        url: row.get(2)?,
        title: row.get(3)?,
        position: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

fn map_folder(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawFolder> {
    Ok(RawFolder {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        position: row.get(3)?,
        created_at_ms: row.get(4)?,
        updated_at_ms: row.get(5)?,
    })
}

fn is_unique_violation(e: &rusqlite::Error) -> bool {
    matches!(
        e,
        rusqlite::Error::SqliteFailure(e, _) if e.code == rusqlite::ErrorCode::ConstraintViolation
    )
}

fn ensure_folder(actor: &Actor, folder_id: Option<i64>) -> Result<(), StoreError> {
    let Some(id) = folder_id else { return Ok(()) };
    let found: Option<i64> = actor
        .conn
        .query_row("SELECT id FROM bookmark_folders WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    match found {
        Some(_) => Ok(()),
        None => Err(StoreError::NotFound {
            entity: "bookmark_folder",
            id,
        }),
    }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

pub(crate) fn folder_create(
    actor: &mut Actor,
    name: &str,
    parent_id: Option<i64>,
) -> Result<BookmarkFolder, StoreError> {
    validate_str("name", name, 1, MAX_FOLDER_NAME_LEN, false)?;
    ensure_folder(actor, parent_id)?;
    let now = crate::model::now_ms();
    actor.conn.execute(
        "INSERT INTO bookmark_folders (parent_id, name, position, created_at_ms, updated_at_ms)
         VALUES (?1, ?2,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM bookmark_folders WHERE parent_id IS ?1),
                 ?3, ?3)",
        params![parent_id, name, now],
    )?;
    let id = actor.conn.last_insert_rowid();
    folder_get(actor, id)
}

pub(crate) fn folder_get(actor: &mut Actor, id: i64) -> Result<BookmarkFolder, StoreError> {
    let rows: Vec<rusqlite::Result<RawFolder>> = {
        let mut stmt = actor.conn.prepare(&format!(
            "SELECT {FOLDER_COLS} FROM bookmark_folders WHERE id = ?1"
        ))?;
        let mapped = stmt.query_map([id], map_folder)?;
        mapped.collect()
    };
    let row = rows.into_iter().next().transpose()?;
    let Some(raw) = row else {
        return Err(StoreError::NotFound {
            entity: "bookmark_folder",
            id,
        });
    };
    raw.into_valid()
}

pub(crate) fn folder_list(actor: &mut Actor) -> Result<Vec<BookmarkFolder>, StoreError> {
    let rows: Vec<rusqlite::Result<RawFolder>> = {
        let mut stmt = actor.conn.prepare(&format!(
            "SELECT {FOLDER_COLS} FROM bookmark_folders ORDER BY parent_id, position, id"
        ))?;
        let mapped = stmt.query_map([], map_folder)?;
        mapped.collect()
    };
    let mut out = Vec::new();
    for row in rows {
        if let Ok(raw) = row {
            if let Some(f) = count_skip(actor, raw.into_valid()) {
                out.push(f);
            }
        } else {
            actor.malformed_rows_skipped += 1;
        }
    }
    Ok(out)
}

pub(crate) fn folder_rename(
    actor: &mut Actor,
    id: i64,
    name: &str,
) -> Result<BookmarkFolder, StoreError> {
    validate_str("name", name, 1, MAX_FOLDER_NAME_LEN, false)?;
    let changed = actor.conn.execute(
        "UPDATE bookmark_folders SET name = ?1, updated_at_ms = ?2 WHERE id = ?3",
        params![name, crate::model::now_ms(), id],
    )?;
    if changed == 0 {
        return Err(StoreError::NotFound {
            entity: "bookmark_folder",
            id,
        });
    }
    folder_get(actor, id)
}

/// Deletes the folder, its subfolders, and everything in them (ON DELETE
/// CASCADE). The cascade size is reported so the UI can confirm honestly.
pub(crate) fn folder_delete(actor: &mut Actor, id: i64) -> Result<u64, StoreError> {
    let changed = actor
        .conn
        .execute("DELETE FROM bookmark_folders WHERE id = ?1", [id])?;
    if changed == 0 {
        return Err(StoreError::NotFound {
            entity: "bookmark_folder",
            id,
        });
    }
    Ok(actor.conn.changes())
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

pub(crate) fn add(actor: &mut Actor, req: NewBookmark) -> Result<BookmarkAddOutcome, StoreError> {
    req.validate()?;
    ensure_folder(actor, req.folder_id)?;
    let now = crate::model::now_ms();
    let inserted = actor.conn.execute(
        "INSERT INTO bookmarks (folder_id, url, title, position, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3,
                 (SELECT COALESCE(MAX(position) + 1, 0) FROM bookmarks WHERE folder_id IS ?1),
                 ?4, ?4)",
        params![req.folder_id, req.url, req.title, now],
    );
    match inserted {
        Ok(_) => {
            let id = actor.conn.last_insert_rowid();
            Ok(BookmarkAddOutcome::Created(get(actor, id)?))
        }
        Err(e) if is_unique_violation(&e) => {
            let existing: Option<i64> = actor
                .conn
                .query_row(
                    "SELECT id FROM bookmarks WHERE url = ?1 AND folder_id IS ?2",
                    params![req.url, req.folder_id],
                    |r| r.get(0),
                )
                .optional()?;
            match existing {
                Some(existing_id) => {
                    Ok(BookmarkAddOutcome::AlreadyExists(get(actor, existing_id)?))
                }
                None => Err(StoreError::Sqlite(format!(
                    "unique index fired but no existing row found: {e}"
                ))),
            }
        }
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn get(actor: &mut Actor, id: i64) -> Result<Bookmark, StoreError> {
    let rows: Vec<rusqlite::Result<RawBookmark>> = {
        let mut stmt = actor.conn.prepare(&format!(
            "SELECT {BOOKMARK_COLS} FROM bookmarks WHERE id = ?1"
        ))?;
        let mapped = stmt.query_map([id], map_bookmark)?;
        mapped.collect()
    };
    let row = rows.into_iter().next().transpose()?;
    let Some(raw) = row else {
        return Err(StoreError::NotFound {
            entity: "bookmark",
            id,
        });
    };
    raw.into_valid().map_err(|e| {
        // The row exists but is corrupt; do not pretend it is missing.
        StoreError::Sqlite(format!(
            "bookmark {id} failed validation: {e}; run integrity_check"
        ))
    })
}

pub(crate) fn list(actor: &mut Actor, folder_id: Option<i64>) -> Result<Vec<Bookmark>, StoreError> {
    let rows: Vec<rusqlite::Result<RawBookmark>> = {
        let mut stmt = actor.conn.prepare(&format!(
            "SELECT {BOOKMARK_COLS} FROM bookmarks WHERE folder_id IS ?1 ORDER BY position, id"
        ))?;
        let mapped = stmt.query_map(params![folder_id], map_bookmark)?;
        mapped.collect()
    };
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(raw) => {
                if let Some(b) = count_skip(actor, raw.into_valid()) {
                    out.push(b);
                }
            }
            Err(_) => actor.malformed_rows_skipped += 1,
        }
    }
    Ok(out)
}

pub(crate) fn update(
    actor: &mut Actor,
    id: i64,
    title: Option<String>,
    url: Option<String>,
) -> Result<Bookmark, StoreError> {
    let existing = get(actor, id)?;
    let new_title = title.unwrap_or(existing.title);
    let new_url = url.unwrap_or(existing.url);
    validate_url("url", &new_url)?;
    validate_title_on_read(&new_title)?;
    actor.conn.execute(
        "UPDATE bookmarks SET title = ?1, url = ?2, updated_at_ms = ?3 WHERE id = ?4",
        params![new_title, new_url, crate::model::now_ms(), id],
    )?;
    get(actor, id)
}

/// Move to another folder (or root), appended to the end of the target.
pub(crate) fn move_to(
    actor: &mut Actor,
    id: i64,
    folder_id: Option<i64>,
) -> Result<Bookmark, StoreError> {
    get(actor, id)?;
    ensure_folder(actor, folder_id)?;
    actor.conn.execute(
        "UPDATE bookmarks
         SET folder_id = ?1,
             position = (SELECT COALESCE(MAX(position) + 1, 0) FROM bookmarks WHERE folder_id IS ?1),
             updated_at_ms = ?2
         WHERE id = ?3",
        params![folder_id, crate::model::now_ms(), id],
    )?;
    get(actor, id)
}

pub(crate) fn delete(actor: &mut Actor, id: i64) -> Result<(), StoreError> {
    let changed = actor
        .conn
        .execute("DELETE FROM bookmarks WHERE id = ?1", [id])?;
    if changed == 0 {
        return Err(StoreError::NotFound {
            entity: "bookmark",
            id,
        });
    }
    Ok(())
}

pub(crate) fn scan_malformed(actor: &mut Actor) -> Result<u64, StoreError> {
    let rows: Vec<rusqlite::Result<RawBookmark>> = {
        let mut stmt = actor
            .conn
            .prepare(&format!("SELECT {BOOKMARK_COLS} FROM bookmarks"))?;
        let mapped = stmt.query_map([], map_bookmark)?;
        mapped.collect()
    };
    let mut bad = 0;
    for row in rows {
        match row {
            Ok(raw) => {
                if raw.into_valid().is_err() {
                    bad += 1;
                }
            }
            Err(_) => bad += 1,
        }
    }
    Ok(bad)
}

/// Assign positions 0..n inside one folder from the given id order. Every
/// id must exist in that folder; anything else is a typed error and no
/// position changes.
pub(crate) fn reorder(
    actor: &mut Actor,
    folder_id: Option<i64>,
    ids: &[i64],
) -> Result<(), StoreError> {
    ensure_folder(actor, folder_id)?;
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(*id) {
            return Err(StoreError::InvalidInput(format!(
                "reorder: duplicate id {id}"
            )));
        }
        let found: Option<i64> = actor
            .conn
            .query_row(
                "SELECT id FROM bookmarks WHERE id = ?1 AND folder_id IS ?2",
                params![id, folder_id],
                |r| r.get(0),
            )
            .optional()?;
        if found.is_none() {
            return Err(StoreError::InvalidInput(format!(
                "reorder: bookmark {id} is not in the target folder"
            )));
        }
    }
    let now = crate::model::now_ms();
    let tx = actor.conn.unchecked_transaction()?;
    for (position, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE bookmarks SET position = ?1, updated_at_ms = ?2 WHERE id = ?3",
            params![position as i64, now, id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

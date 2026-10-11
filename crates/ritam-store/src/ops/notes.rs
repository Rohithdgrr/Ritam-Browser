//! Scratchpad notes with optimistic-concurrency autosave semantics: a stale
//! save is a typed `Conflict`, never a silent last-write-wins overwrite.

use rusqlite::params;

use crate::error::StoreError;
use crate::model::{
    validate_limit, validate_str, validate_url, NewNote, Note, MAX_NOTE_BODY_LEN,
    MAX_NOTE_TITLE_LEN,
};
use crate::ops::count_skip;
use crate::Actor;

const COLS: &str = "id, title, body, url, revision, created_at_ms, updated_at_ms";

struct RawNote {
    id: i64,
    title: String,
    body: String,
    url: Option<String>,
    revision: i64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl RawNote {
    fn into_valid(self) -> Result<Note, StoreError> {
        validate_str("title", &self.title, 0, MAX_NOTE_TITLE_LEN, false)?;
        validate_str("body", &self.body, 0, MAX_NOTE_BODY_LEN, true)?;
        if let Some(u) = &self.url {
            validate_url("url", u)?;
        }
        if self.revision < 1 {
            return Err(StoreError::InvalidInput(format!(
                "note {} has revision {}",
                self.id, self.revision
            )));
        }
        Ok(Note {
            id: self.id,
            title: self.title,
            body: self.body,
            url: self.url,
            revision: self.revision,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
        })
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawNote> {
    Ok(RawNote {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        url: row.get(3)?,
        revision: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
    })
}

fn fetch(actor: &mut Actor, id: i64) -> Result<Note, StoreError> {
    let rows: Vec<rusqlite::Result<RawNote>> = {
        let mut stmt = actor
            .conn
            .prepare(&format!("SELECT {COLS} FROM notes WHERE id = ?1"))?;
        let mapped = stmt.query_map([id], map_row)?;
        mapped.collect()
    };
    let row = rows.into_iter().next().transpose()?;
    let Some(raw) = row else {
        return Err(StoreError::NotFound { entity: "note", id });
    };
    raw.into_valid().map_err(|e| {
        StoreError::Sqlite(format!(
            "note {id} failed validation: {e}; run integrity_check"
        ))
    })
}

pub(crate) fn create(actor: &mut Actor, req: NewNote) -> Result<Note, StoreError> {
    req.validate()?;
    let now = crate::model::now_ms();
    actor.conn.execute(
        "INSERT INTO notes (title, body, url, revision, created_at_ms, updated_at_ms)
         VALUES (?1, ?2, ?3, 1, ?4, ?4)",
        params![req.title, req.body, req.url, now],
    )?;
    fetch(actor, actor.conn.last_insert_rowid())
}

pub(crate) fn get(actor: &mut Actor, id: i64) -> Result<Note, StoreError> {
    fetch(actor, id)
}

pub(crate) fn list(actor: &mut Actor, limit: usize) -> Result<Vec<Note>, StoreError> {
    let limit = validate_limit(limit)?;
    let rows: Vec<rusqlite::Result<RawNote>> = {
        let mut stmt = actor.conn.prepare(&format!(
            "SELECT {COLS} FROM notes ORDER BY updated_at_ms DESC, id DESC LIMIT ?1"
        ))?;
        let mapped = stmt.query_map([limit as i64], map_row)?;
        mapped.collect()
    };
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(raw) => {
                if let Some(n) = count_skip(actor, raw.into_valid()) {
                    out.push(n);
                }
            }
            Err(_) => actor.malformed_rows_skipped += 1,
        }
    }
    Ok(out)
}

pub(crate) fn search(
    actor: &mut Actor,
    query: &str,
    limit: usize,
) -> Result<Vec<Note>, StoreError> {
    let limit = validate_limit(limit)?;
    if query.trim().is_empty() {
        return list(actor, limit);
    }
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let rows: Vec<rusqlite::Result<RawNote>> = {
        let mut stmt = actor.conn.prepare(&format!(
            "SELECT {COLS} FROM notes
             WHERE body LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\'
             ORDER BY updated_at_ms DESC, id DESC LIMIT ?2"
        ))?;
        let mapped = stmt.query_map(params![pattern, limit as i64], map_row)?;
        mapped.collect()
    };
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(raw) => {
                if let Some(n) = count_skip(actor, raw.into_valid()) {
                    out.push(n);
                }
            }
            Err(_) => actor.malformed_rows_skipped += 1,
        }
    }
    Ok(out)
}

/// Autosave with optimistic concurrency: `expected_revision` must match the
/// stored revision or the call fails with `Conflict` and changes nothing.
pub(crate) fn update(
    actor: &mut Actor,
    id: i64,
    title: Option<String>,
    body: String,
    expected_revision: i64,
) -> Result<Note, StoreError> {
    let existing = fetch(actor, id)?;
    if existing.revision != expected_revision {
        return Err(StoreError::Conflict {
            entity: "note",
            id,
            expected: expected_revision,
            current: existing.revision,
        });
    }
    let new_title = title.unwrap_or(existing.title);
    validate_str("title", &new_title, 0, MAX_NOTE_TITLE_LEN, false)?;
    validate_str("body", &body, 0, MAX_NOTE_BODY_LEN, true)?;
    actor.conn.execute(
        "UPDATE notes SET title = ?1, body = ?2, revision = revision + 1, updated_at_ms = ?3 WHERE id = ?4",
        params![new_title, body, crate::model::now_ms(), id],
    )?;
    fetch(actor, id)
}

pub(crate) fn delete(actor: &mut Actor, id: i64) -> Result<(), StoreError> {
    let changed = actor
        .conn
        .execute("DELETE FROM notes WHERE id = ?1", [id])?;
    if changed == 0 {
        return Err(StoreError::NotFound { entity: "note", id });
    }
    Ok(())
}

/// The single source for the UI's saved-note count.
pub(crate) fn count(actor: &mut Actor) -> Result<u64, StoreError> {
    crate::ops::table_count(&actor.conn, "notes")
}

pub(crate) fn scan_malformed(actor: &mut Actor) -> Result<u64, StoreError> {
    let rows: Vec<rusqlite::Result<RawNote>> = {
        let mut stmt = actor.conn.prepare(&format!("SELECT {COLS} FROM notes"))?;
        let mapped = stmt.query_map([], map_row)?;
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

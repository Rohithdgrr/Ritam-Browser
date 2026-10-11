//! Downloads: records fed only by real runtime events, with an enforced
//! state machine. Pause/resume is deliberately not modeled (the runtime
//! does not provide it).

use rusqlite::{params, OptionalExtension};

use crate::error::StoreError;
use crate::model::{
    validate_absolute_path, validate_str, validate_timestamp, validate_url, DownloadEvent,
    DownloadRecord, DownloadStart, DownloadState, MAX_FILENAME_LEN,
};
use crate::ops::count_skip;
use crate::Actor;

const COLS: &str = "id, url, filename, mime_type, save_path, state, bytes_received, bytes_total, error, started_at_ms, updated_at_ms, finished_at_ms";

struct RawDownload {
    id: i64,
    url: String,
    filename: String,
    mime_type: Option<String>,
    save_path: Option<String>,
    state: String,
    bytes_received: i64,
    bytes_total: Option<i64>,
    error: Option<String>,
    started_at_ms: i64,
    updated_at_ms: i64,
    finished_at_ms: Option<i64>,
}

impl RawDownload {
    fn into_valid(self) -> Result<DownloadRecord, StoreError> {
        validate_url("url", &self.url)?;
        validate_str("filename", &self.filename, 1, MAX_FILENAME_LEN, false)?;
        if let Some(p) = &self.save_path {
            validate_absolute_path("save_path", p)?;
        }
        let state = DownloadState::parse(&self.state).ok_or_else(|| {
            StoreError::InvalidInput(format!("unknown download state `{}`", self.state))
        })?;
        if self.bytes_received < 0 {
            return Err(StoreError::InvalidInput(format!(
                "bytes_received {} is negative",
                self.bytes_received
            )));
        }
        validate_timestamp("started_at_ms", self.started_at_ms)?;
        validate_timestamp("updated_at_ms", self.updated_at_ms)?;
        // `save_path` on completed / `error` on failed may be NULL: the
        // runtime's finish payload reports no path (even on success) and no
        // error text (contract §9.1). Present values are validated above /
        // below; absent values are recorded as absent, never invented.
        Ok(DownloadRecord {
            id: self.id,
            url: self.url,
            filename: self.filename,
            mime_type: self.mime_type,
            save_path: self.save_path,
            state,
            bytes_received: self.bytes_received,
            bytes_total: self.bytes_total,
            error: self.error,
            started_at_ms: self.started_at_ms,
            updated_at_ms: self.updated_at_ms,
            finished_at_ms: self.finished_at_ms,
        })
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawDownload> {
    Ok(RawDownload {
        id: row.get(0)?,
        url: row.get(1)?,
        filename: row.get(2)?,
        mime_type: row.get(3)?,
        save_path: row.get(4)?,
        state: row.get(5)?,
        bytes_received: row.get(6)?,
        bytes_total: row.get(7)?,
        error: row.get(8)?,
        started_at_ms: row.get(9)?,
        updated_at_ms: row.get(10)?,
        finished_at_ms: row.get(11)?,
    })
}

fn fetch(actor: &mut Actor, id: i64) -> Result<DownloadRecord, StoreError> {
    let rows: Vec<rusqlite::Result<RawDownload>> = {
        let mut stmt = actor
            .conn
            .prepare(&format!("SELECT {COLS} FROM downloads WHERE id = ?1"))?;
        let mapped = stmt.query_map([id], map_row)?;
        mapped.collect()
    };
    let row = rows.into_iter().next().transpose()?;
    let Some(raw) = row else {
        return Err(StoreError::NotFound {
            entity: "download",
            id,
        });
    };
    raw.into_valid().map_err(|e| {
        StoreError::Sqlite(format!(
            "download {id} failed validation: {e}; run integrity_check"
        ))
    })
}

/// Begin recording a download. A second start for the same url while one is
/// already in progress is a duplicate, reported with the existing id.
pub(crate) fn start(actor: &mut Actor, req: DownloadStart) -> Result<DownloadRecord, StoreError> {
    validate_url("url", &req.url)?;
    validate_str("filename", &req.filename, 1, MAX_FILENAME_LEN, false)?;
    if let Some(m) = &req.mime_type {
        validate_str("mime_type", m, 1, 255, false)?;
    }
    let active: Option<i64> = actor
        .conn
        .query_row(
            "SELECT id FROM downloads WHERE url = ?1 AND state = 'in_progress'",
            [&req.url],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(existing_id) = active {
        return Err(StoreError::Duplicate {
            entity: "in_progress download for this url",
            existing_id,
        });
    }
    let now = crate::model::now_ms();
    actor.conn.execute(
        "INSERT INTO downloads (url, filename, mime_type, save_path, state, bytes_received, bytes_total, error, started_at_ms, updated_at_ms, finished_at_ms)
         VALUES (?1, ?2, ?3, NULL, 'in_progress', 0, NULL, NULL, ?4, ?4, NULL)",
        params![req.url, req.filename, req.mime_type, now],
    )?;
    fetch(actor, actor.conn.last_insert_rowid())
}

fn current_state(actor: &Actor, id: i64) -> Result<DownloadState, StoreError> {
    let state: Option<String> = actor
        .conn
        .query_row("SELECT state FROM downloads WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    let state = state.ok_or(StoreError::NotFound {
        entity: "download",
        id,
    })?;
    DownloadState::parse(&state)
        .ok_or_else(|| StoreError::Sqlite(format!("download {id} has unknown state `{state}`")))
}

fn ensure_transition(from: DownloadState, to: DownloadState) -> Result<(), StoreError> {
    let allowed = matches!(
        (from, to),
        (DownloadState::InProgress, DownloadState::Completed)
            | (DownloadState::InProgress, DownloadState::Cancelled)
            | (DownloadState::InProgress, DownloadState::Failed)
    );
    if allowed {
        Ok(())
    } else {
        Err(StoreError::InvalidTransition {
            from: from.as_str().to_string(),
            to: to.as_str().to_string(),
        })
    }
}

pub(crate) fn event(
    actor: &mut Actor,
    id: i64,
    event: DownloadEvent,
) -> Result<DownloadRecord, StoreError> {
    let state = current_state(actor, id)?;
    let now = crate::model::now_ms();
    match event {
        DownloadEvent::Progress {
            bytes_received,
            bytes_total,
        } => {
            if state != DownloadState::InProgress {
                return Err(StoreError::InvalidTransition {
                    from: state.as_str().to_string(),
                    to: "progress".to_string(),
                });
            }
            if bytes_received < 0 {
                return Err(StoreError::InvalidInput(format!(
                    "bytes_received {bytes_received} is negative"
                )));
            }
            if let Some(total) = bytes_total {
                if total < 0 {
                    return Err(StoreError::InvalidInput(format!(
                        "bytes_total {total} is negative"
                    )));
                }
            }
            actor.conn.execute(
                "UPDATE downloads SET bytes_received = ?1, bytes_total = COALESCE(?2, bytes_total), updated_at_ms = ?3 WHERE id = ?4",
                params![bytes_received, bytes_total, now, id],
            )?;
        }
        DownloadEvent::Completed {
            save_path,
            bytes_total,
        } => {
            ensure_transition(state, DownloadState::Completed)?;
            if let Some(p) = &save_path {
                // Real paths only: present ⇒ absolute. Absent ⇒ stays NULL.
                validate_absolute_path("save_path", p)?;
            }
            actor.conn.execute(
                "UPDATE downloads SET state = 'completed', save_path = ?1, bytes_total = COALESCE(?2, bytes_total), bytes_received = COALESCE(?2, bytes_received), updated_at_ms = ?3, finished_at_ms = ?3 WHERE id = ?4",
                params![save_path, bytes_total, now, id],
            )?;
        }
        DownloadEvent::Failed { error } => {
            ensure_transition(state, DownloadState::Failed)?;
            if let Some(e) = &error {
                validate_str("error", e, 1, 1000, true)?;
            }
            actor.conn.execute(
                "UPDATE downloads SET state = 'failed', error = ?1, updated_at_ms = ?2, finished_at_ms = ?2 WHERE id = ?3",
                params![error, now, id],
            )?;
        }
        DownloadEvent::Cancelled => {
            ensure_transition(state, DownloadState::Cancelled)?;
            actor.conn.execute(
                "UPDATE downloads SET state = 'cancelled', updated_at_ms = ?1, finished_at_ms = ?1 WHERE id = ?2",
                params![now, id],
            )?;
        }
    }
    fetch(actor, id)
}

pub(crate) fn list(actor: &mut Actor) -> Result<Vec<DownloadRecord>, StoreError> {
    let rows: Vec<rusqlite::Result<RawDownload>> = {
        let mut stmt = actor.conn.prepare(&format!(
            "SELECT {COLS} FROM downloads ORDER BY updated_at_ms DESC, id DESC"
        ))?;
        let mapped = stmt.query_map([], map_row)?;
        mapped.collect()
    };
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(raw) => {
                if let Some(d) = count_skip(actor, raw.into_valid()) {
                    out.push(d);
                }
            }
            Err(_) => actor.malformed_rows_skipped += 1,
        }
    }
    Ok(out)
}

/// Remove a download *record*. The file on disk is never touched.
pub(crate) fn delete(actor: &mut Actor, id: i64) -> Result<(), StoreError> {
    let changed = actor
        .conn
        .execute("DELETE FROM downloads WHERE id = ?1", [id])?;
    if changed == 0 {
        return Err(StoreError::NotFound {
            entity: "download",
            id,
        });
    }
    Ok(())
}

/// Clear finished records only; in-progress downloads are never touched.
pub(crate) fn clear_completed(actor: &mut Actor) -> Result<u64, StoreError> {
    let changed = actor
        .conn
        .execute("DELETE FROM downloads WHERE state != 'in_progress'", [])?;
    Ok(changed as u64)
}

pub(crate) fn scan_malformed(actor: &mut Actor) -> Result<u64, StoreError> {
    let rows: Vec<rusqlite::Result<RawDownload>> = {
        let mut stmt = actor
            .conn
            .prepare(&format!("SELECT {COLS} FROM downloads"))?;
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

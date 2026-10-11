//! History: record visits (privacy-aware), FTS5 search, time/host filters,
//! deletion. The store records exactly what it is given; unknown facts stay
//! `None`.

use rusqlite::{params, OptionalExtension};

use crate::error::StoreError;
use crate::model::{
    host_of, validate_limit, validate_range_bound, validate_timestamp, validate_title,
    validate_url, HistoryAddOutcome, HistoryEntry, HistoryFilter, NewHistoryVisit, SkipReason,
    Transition, Visibility,
};
use crate::ops::count_skip;
use crate::Actor;

const COLS: &str = "id, url, title, host, visited_at_ms, duration_ms, http_status, transition";

struct RawEntry {
    id: i64,
    url: String,
    title: String,
    host: String,
    visited_at_ms: i64,
    duration_ms: Option<i64>,
    http_status: Option<i32>,
    transition: String,
}

impl RawEntry {
    fn into_valid(self) -> Result<HistoryEntry, StoreError> {
        validate_url("url", &self.url)?;
        validate_title("title", &self.title)?;
        validate_timestamp("visited_at_ms", self.visited_at_ms)?;
        let transition = Transition::parse(&self.transition).ok_or_else(|| {
            StoreError::InvalidInput(format!("unknown transition `{}`", self.transition))
        })?;
        Ok(HistoryEntry {
            id: self.id,
            url: self.url,
            title: self.title,
            host: self.host,
            visited_at_ms: self.visited_at_ms,
            duration_ms: self.duration_ms,
            http_status: self.http_status,
            transition,
        })
    }
}

fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawEntry> {
    Ok(RawEntry {
        id: row.get(0)?,
        url: row.get(1)?,
        title: row.get(2)?,
        host: row.get(3)?,
        visited_at_ms: row.get(4)?,
        duration_ms: row.get(5)?,
        http_status: row.get(6)?,
        transition: row.get(7)?,
    })
}

fn history_enabled(actor: &Actor) -> Result<bool, StoreError> {
    let raw: Option<String> = actor
        .conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'history_enabled'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match raw {
        Some(v) => crate::model::SettingValue::decode(crate::model::SettingKey::HistoryEnabled, &v)
            .map(|sv| match sv {
                crate::model::SettingValue::HistoryEnabled(b) => b,
                _ => true,
            }),
        // Not stored yet: the documented default is enabled.
        None => Ok(true),
    }
}

pub(crate) fn add(
    actor: &mut Actor,
    visit: NewHistoryVisit,
) -> Result<HistoryAddOutcome, StoreError> {
    visit.validate()?;
    if visit.visibility == Visibility::Private {
        // Private-mode sessions never write to normal history (storage law).
        return Ok(HistoryAddOutcome::Skipped(SkipReason::PrivateSession));
    }
    if !history_enabled(actor)? {
        return Ok(HistoryAddOutcome::Skipped(SkipReason::HistoryDisabled));
    }
    let host = host_of(&visit.url);
    actor.conn.execute(
        "INSERT INTO history (url, title, host, visited_at_ms, duration_ms, http_status, transition)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            visit.url,
            visit.title,
            host,
            visit.visited_at_ms,
            visit.duration_ms,
            visit.http_status,
            visit.transition.as_str()
        ],
    )?;
    Ok(HistoryAddOutcome::Recorded(actor.conn.last_insert_rowid()))
}

pub(crate) fn list(
    actor: &mut Actor,
    filter: &HistoryFilter,
) -> Result<Vec<HistoryEntry>, StoreError> {
    let limit = validate_limit(filter.limit)?;
    if let Some(from) = filter.from_ms {
        validate_range_bound("from_ms", from)?;
    }
    if let Some(to) = filter.to_ms {
        validate_range_bound("to_ms", to)?;
    }
    if let (Some(from), Some(to)) = (filter.from_ms, filter.to_ms) {
        if from > to {
            return Err(StoreError::InvalidInput(format!(
                "from_ms {from} is after to_ms {to}"
            )));
        }
    }
    let mut sql = format!("SELECT {COLS} FROM history WHERE 1=1");
    let mut binds: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(from) = filter.from_ms {
        sql.push_str(" AND visited_at_ms >= ?");
        binds.push(Box::new(from));
    }
    if let Some(to) = filter.to_ms {
        sql.push_str(" AND visited_at_ms <= ?");
        binds.push(Box::new(to));
    }
    if let Some(host) = &filter.host {
        validate_url("host", host)?;
        sql.push_str(" AND host = ?");
        binds.push(Box::new(host.to_ascii_lowercase()));
    }
    sql.push_str(" ORDER BY visited_at_ms DESC, id DESC LIMIT ?");
    binds.push(Box::new(limit as i64));
    let params_ref: Vec<&dyn rusqlite::ToSql> = binds.iter().map(|b| b.as_ref()).collect();
    let rows: Vec<rusqlite::Result<RawEntry>> = {
        let mut stmt = actor.conn.prepare(&sql)?;
        let mapped = stmt.query_map(params_ref.as_slice(), map_row)?;
        mapped.collect()
    };
    Ok(collect(actor, rows))
}

fn collect(actor: &mut Actor, rows: Vec<rusqlite::Result<RawEntry>>) -> Vec<HistoryEntry> {
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(raw) => {
                if let Some(e) = count_skip(actor, raw.into_valid()) {
                    out.push(e);
                }
            }
            Err(_) => actor.malformed_rows_skipped += 1,
        }
    }
    out
}

/// Escape a user token so FTS5 metacharacters in the query cannot cause a
/// syntax error (a bad query must degrade, never crash).
fn fts_token(token: &str) -> String {
    format!("\"{}\"", token.replace('"', "\"\""))
}

fn like_pattern(query: &str) -> String {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub(crate) fn search(
    actor: &mut Actor,
    query: &str,
    limit: usize,
) -> Result<Vec<HistoryEntry>, StoreError> {
    let limit = validate_limit(limit)?;
    let tokens: Vec<String> = query
        .split_whitespace()
        .take(32)
        .map(fts_token)
        .filter(|t| t.len() > 2)
        .collect();
    if tokens.is_empty() {
        // Nothing searchable; an empty result is the honest answer.
        return Ok(Vec::new());
    }
    let match_expr = tokens.join(" AND ");
    let fts_rows: Result<Vec<rusqlite::Result<RawEntry>>, rusqlite::Error> = (|| {
        let mut stmt = actor.conn.prepare(&format!(
            "SELECT {COLS_PREFIX} FROM history_fts f JOIN history h ON h.id = f.rowid
             WHERE f MATCH ?1
             ORDER BY h.visited_at_ms DESC, h.id DESC LIMIT ?2"
        ))?;
        let mapped = stmt.query_map(params![match_expr, limit as i64], map_row)?;
        Ok(mapped.collect())
    })();
    match fts_rows {
        Ok(rows) => Ok(collect(actor, rows)),
        // FTS rejected the query (e.g. exotic input); degrade to a LIKE scan.
        Err(_) => {
            let pattern = like_pattern(query);
            let rows: Vec<rusqlite::Result<RawEntry>> = {
                let mut stmt = actor.conn.prepare(&format!(
                    "SELECT {COLS_PREFIX} FROM history h
                     WHERE h.url LIKE ?1 ESCAPE '\\' OR h.title LIKE ?1 ESCAPE '\\'
                     ORDER BY h.visited_at_ms DESC, h.id DESC LIMIT ?2"
                ))?;
                let mapped = stmt.query_map(params![pattern, limit as i64], map_row)?;
                mapped.collect()
            };
            Ok(collect(actor, rows))
        }
    }
}

// Columns prefixed with `h.` for joined/aliased queries.
const COLS_PREFIX: &str =
    "h.id, h.url, h.title, h.host, h.visited_at_ms, h.duration_ms, h.http_status, h.transition";

pub(crate) fn delete(actor: &mut Actor, id: i64) -> Result<(), StoreError> {
    let changed = actor
        .conn
        .execute("DELETE FROM history WHERE id = ?1", [id])?;
    if changed == 0 {
        return Err(StoreError::NotFound {
            entity: "history_entry",
            id,
        });
    }
    Ok(())
}

pub(crate) fn clear_range(actor: &mut Actor, from_ms: i64, to_ms: i64) -> Result<u64, StoreError> {
    // Range bounds, not event times: from_ms = 0 means "all time" and must
    // be accepted (the settings panel's exact call shape).
    validate_range_bound("from_ms", from_ms)?;
    validate_range_bound("to_ms", to_ms)?;
    if from_ms > to_ms {
        return Err(StoreError::InvalidInput(format!(
            "from_ms {from_ms} is after to_ms {to_ms}"
        )));
    }
    let changed = actor.conn.execute(
        "DELETE FROM history WHERE visited_at_ms >= ?1 AND visited_at_ms <= ?2",
        params![from_ms, to_ms],
    )?;
    Ok(changed as u64)
}

pub(crate) fn count(actor: &mut Actor) -> Result<u64, StoreError> {
    crate::ops::table_count(&actor.conn, "history")
}

/// Used by integrity_check to find malformed history rows.
pub(crate) fn scan_malformed(actor: &mut Actor) -> Result<u64, StoreError> {
    let rows: Vec<rusqlite::Result<RawEntry>> = {
        let mut stmt = actor.conn.prepare(&format!("SELECT {COLS} FROM history"))?;
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

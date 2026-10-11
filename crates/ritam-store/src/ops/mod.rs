//! Domain operations executed by the writer actor. Each function takes the
//! actor (connection + malformed-row counter) and returns typed results.
//! Nothing here logs; nothing here invents data.
//!
//! Read pattern used everywhere: fetch raw rows first (the statement's
//! borrow of the connection ends), then validate rows while holding `&mut
//! Actor`. Rows that fail validation are skipped and counted, never fatal.

pub(crate) mod bookmarks;
pub(crate) mod downloads;
pub(crate) mod history;
pub(crate) mod notes;
pub(crate) mod session;
pub(crate) mod settings;

use rusqlite::Connection;

use crate::error::StoreError;
use crate::Actor;

/// Validate one already-fetched row; on failure, count a skip and return
/// `None` so the caller keeps going with the remaining rows.
pub(crate) fn count_skip<T>(actor: &mut Actor, row: Result<T, StoreError>) -> Option<T> {
    match row {
        Ok(v) => Some(v),
        Err(_) => {
            actor.malformed_rows_skipped += 1;
            None
        }
    }
}

pub(crate) fn table_count(conn: &Connection, table: &str) -> Result<u64, StoreError> {
    // Table names are internal constants, never user input.
    let n: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
    Ok(n.max(0) as u64)
}

/// Run a scalar count SQL statement (internal constant strings only).
pub(crate) fn one_count(conn: &Connection, sql: &str) -> Result<u64, StoreError> {
    let n: i64 = conn.query_row(sql, [], |r| r.get(0))?;
    Ok(n.max(0) as u64)
}

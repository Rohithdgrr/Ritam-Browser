//! Session state: exactly one logical session, saved atomically, restored
//! with validation. A corrupt session degrades to "nothing to restore" and
//! is counted — restore never crashes the app.

use rusqlite::params;

use crate::error::StoreError;
use crate::model::{SessionState, TabState};
use crate::Actor;

const TAB_COLS: &str = "tab_id, url, title, position";

pub(crate) fn save(actor: &mut Actor, state: SessionState) -> Result<(), StoreError> {
    state.validate()?;
    let now = crate::model::now_ms();
    let tx = actor.conn.unchecked_transaction()?;
    tx.execute("DELETE FROM session_tabs", [])?;
    tx.execute("DELETE FROM session_state", [])?;
    tx.execute(
        "INSERT INTO session_state (id, active_tab_id, tab_count, updated_at_ms) VALUES (1, ?1, ?2, ?3)",
        params![state.active_tab_id, state.tabs.len() as i64, now],
    )?;
    for (position, tab) in state.tabs.iter().enumerate() {
        tx.execute(
            "INSERT INTO session_tabs (tab_id, url, title, position) VALUES (?1, ?2, ?3, ?4)",
            params![tab.tab_id, tab.url, tab.title, position as i64],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Validate the stored session shape; `Ok(None)` = unusable (absent or
/// corrupt, counted as malformed when corrupt).
fn load_checked(actor: &mut Actor) -> Result<Option<SessionState>, StoreError> {
    let header: Option<(i64, i64)> = actor
        .conn
        .query_row(
            "SELECT active_tab_id, tab_count FROM session_state WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((active_tab_id, tab_count)) = header else {
        return Ok(None);
    };
    if tab_count < 1 || tab_count > crate::model::MAX_SESSION_TABS as i64 {
        actor.malformed_rows_skipped += 1;
        return Ok(None);
    }
    let rows: Vec<rusqlite::Result<TabState>> = {
        let mut stmt = actor.conn.prepare(&format!(
            "SELECT {TAB_COLS} FROM session_tabs ORDER BY position, tab_id"
        ))?;
        let mapped = stmt.query_map([], |row| {
            Ok(TabState {
                tab_id: row.get(0)?,
                url: row.get(1)?,
                title: row.get(2)?,
            })
        })?;
        mapped.collect()
    };
    let mut tabs = Vec::new();
    for row in rows {
        match row {
            Ok(tab) => tabs.push(tab),
            Err(_) => {
                actor.malformed_rows_skipped += 1;
                return Ok(None);
            }
        }
    }
    if tabs.len() as i64 != tab_count {
        actor.malformed_rows_skipped += 1;
        return Ok(None);
    }
    let state = SessionState {
        active_tab_id,
        tabs,
    };
    match state.validate() {
        Ok(()) => Ok(Some(state)),
        Err(_) => {
            actor.malformed_rows_skipped += 1;
            Ok(None)
        }
    }
}

pub(crate) fn load(actor: &mut Actor) -> Result<Option<SessionState>, StoreError> {
    load_checked(actor)
}

pub(crate) fn clear(actor: &mut Actor) -> Result<bool, StoreError> {
    let tabs = actor.conn.execute("DELETE FROM session_tabs", [])?;
    let header = actor.conn.execute("DELETE FROM session_state", [])?;
    Ok(tabs + header > 0)
}

pub(crate) fn scan_malformed(actor: &mut Actor) -> Result<u64, StoreError> {
    // Peek without counting into the live counter: run the check, then undo.
    let before = actor.malformed_rows_skipped;
    let _ = load_checked(actor)?;
    let found = actor.malformed_rows_skipped - before;
    actor.malformed_rows_skipped = before;
    Ok(found)
}

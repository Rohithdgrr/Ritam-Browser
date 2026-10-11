//! Typed errors. Every failure a caller can see is one of these; no command
//! panics on bad data and no command reports success for work that did not
//! happen (AGENTS.md §6).

use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// Input failed validation. The string names the field and the rule.
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// Referenced entity does not exist.
    #[error("{entity} {id} not found")]
    NotFound { entity: &'static str, id: i64 },

    /// Adding a record that already exists (same url in the same scope).
    #[error("{entity} already exists (existing id {existing_id})")]
    Duplicate {
        entity: &'static str,
        existing_id: i64,
    },

    /// Optimistic-concurrency failure (scratchpad autosave).
    #[error("{entity} {id}: expected revision {expected}, current revision {current}")]
    Conflict {
        entity: &'static str,
        id: i64,
        expected: i64,
        current: i64,
    },

    /// Download state machine rejected the transition.
    #[error("invalid download state transition: {from} -> {to}")]
    InvalidTransition { from: String, to: String },

    /// The store worker thread is gone (store closed or panicked).
    #[error("store actor has stopped")]
    ActorStopped,

    /// Database-level failure that is not one of the typed cases above.
    #[error("database error: {0}")]
    Sqlite(String),
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e.to_string())
    }
}

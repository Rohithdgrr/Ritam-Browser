//! # ritam-store — Ritam Browser local persistence
//!
//! One SQLite database (WAL), versioned migrations with up **and** down,
//! and a **single writer actor**: every read and write is a typed command
//! sent over a bounded channel to one thread that owns the only connection.
//! Nothing else in the app ever touches the database.
//!
//! Storage law (AGENTS.md §6, `docs/SCHEMA.md`):
//! - what was saved is what comes back, or the failure is stated plainly;
//! - malformed rows degrade gracefully (skipped + counted), never crash;
//! - private sessions never write to normal history;
//! - no secrets or page content are logged — this crate logs nothing.
//!
//! The API is blocking from the caller's thread; the IPC layer above must
//! call it off the UI thread (see `contracts/ipc.md`, PLAN.md requests).

mod error;
mod migrations;
mod model;
mod ops;

pub use error::StoreError;
pub use model::*;

use std::path::Path;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Mutex;
use std::thread::JoinHandle;

use rusqlite::Connection;

/// Bounded command queue: backpressure, never unbounded growth.
const CHANNEL_CAPACITY: usize = 64;

/// The actor's state: the only connection plus the malformed-skip counter
/// that makes every read-path degradation visible.
pub(crate) struct Actor {
    pub(crate) conn: Connection,
    pub(crate) malformed_rows_skipped: u64,
}

type Job = Box<dyn FnOnce(&mut Actor) + Send>;

struct Request {
    job: Job,
}

/// Handle to the persistence actor. Cheap to clone? No — one handle, one
/// actor; share it via `&Store` or wrap it in an `Arc` in the host app.
pub struct Store {
    tx: Option<SyncSender<Request>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Store {
    /// Open (creating if needed) the database at `path` and migrate to the
    /// latest version. The file's directory must exist.
    pub fn open(path: impl AsRef<Path>) -> Result<Store, StoreError> {
        let mut conn = Connection::open(path.as_ref())?;
        Self::finish_open(&mut conn)?;
        Ok(Self::spawn(conn))
    }

    /// In-memory database for tests and dry runs. Same code path, same
    /// migrations, same validation.
    pub fn open_in_memory() -> Result<Store, StoreError> {
        let mut conn = Connection::open_in_memory()?;
        Self::finish_open(&mut conn)?;
        Ok(Self::spawn(conn))
    }

    fn finish_open(conn: &mut Connection) -> Result<(), StoreError> {
        // WAL first: it is the journal mode for the file database and a
        // harmless no-op ("memory") for :memory: databases.
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;",
        )?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        migrations::migrate_up(conn, migrations::LATEST_VERSION)?;
        Ok(())
    }

    fn spawn(conn: Connection) -> Store {
        let (tx, rx) = mpsc::sync_channel::<Request>(CHANNEL_CAPACITY);
        let worker = std::thread::Builder::new()
            .name("ritam-store".to_string())
            .spawn(move || Self::run(rx, conn))
            .expect("failed to spawn store actor thread");
        Store {
            tx: Some(tx),
            worker: Mutex::new(Some(worker)),
        }
    }

    fn run(rx: Receiver<Request>, conn: Connection) {
        let mut actor = Actor {
            conn,
            malformed_rows_skipped: 0,
        };
        for request in rx {
            (request.job)(&mut actor);
        }
    }

    /// Send one command and wait for its typed reply. `send` blocks when
    /// the queue is full (backpressure); `recv` fails only if the actor is
    /// gone. Never panics on bad data.
    fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Actor) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let tx = self.tx.as_ref().ok_or(StoreError::ActorStopped)?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        tx.send(Request {
            job: Box::new(move |actor| {
                let _ = reply_tx.send(f(actor));
            }),
        })
        .map_err(|_| StoreError::ActorStopped)?;
        reply_rx.recv().map_err(|_| StoreError::ActorStopped)?
    }

    /// Stop the actor and wait for it. Idempotent; also called by `Drop`.
    pub fn close(&mut self) {
        self.tx.take(); // dropping the sender ends the actor loop
        if let Ok(mut guard) = self.worker.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    /// Effective value: stored value, or the documented default when unset.
    pub fn settings_get(&self, key: SettingKey) -> Result<SettingValue, StoreError> {
        self.call(move |a| ops::settings::get(a, key))
    }

    pub fn settings_set(&self, value: SettingValue) -> Result<(), StoreError> {
        self.call(move |a| ops::settings::set(a, value))
    }

    /// All six typed keys with their effective values.
    pub fn settings_list(&self) -> Result<Vec<SettingValue>, StoreError> {
        self.call(ops::settings::list)
    }

    /// Forget all stored settings; they return to defaults. Reports rows
    /// removed so the UI states what actually happened.
    pub fn settings_reset(&self) -> Result<u64, StoreError> {
        self.call(ops::settings::reset)
    }

    // -----------------------------------------------------------------------
    // Bookmarks and folders
    // -----------------------------------------------------------------------

    pub fn bookmark_add(&self, req: NewBookmark) -> Result<BookmarkAddOutcome, StoreError> {
        self.call(move |a| ops::bookmarks::add(a, req))
    }

    pub fn bookmark_get(&self, id: i64) -> Result<Bookmark, StoreError> {
        self.call(move |a| ops::bookmarks::get(a, id))
    }

    /// `folder_id = None` lists root bookmarks — the sidebar favorites.
    pub fn bookmark_list(&self, folder_id: Option<i64>) -> Result<Vec<Bookmark>, StoreError> {
        self.call(move |a| ops::bookmarks::list(a, folder_id))
    }

    pub fn bookmark_update(
        &self,
        id: i64,
        title: Option<String>,
        url: Option<String>,
    ) -> Result<Bookmark, StoreError> {
        self.call(move |a| ops::bookmarks::update(a, id, title, url))
    }

    /// Move to another folder (or root), appended to the end.
    pub fn bookmark_move(&self, id: i64, folder_id: Option<i64>) -> Result<Bookmark, StoreError> {
        self.call(move |a| ops::bookmarks::move_to(a, id, folder_id))
    }

    pub fn bookmark_delete(&self, id: i64) -> Result<(), StoreError> {
        self.call(move |a| ops::bookmarks::delete(a, id))
    }

    /// Assign positions from the given order inside one folder. Validates
    /// every id first; on any error, no position changes.
    pub fn bookmark_reorder(
        &self,
        folder_id: Option<i64>,
        ids: Vec<i64>,
    ) -> Result<(), StoreError> {
        self.call(move |a| ops::bookmarks::reorder(a, folder_id, &ids))
    }

    pub fn folder_create(
        &self,
        name: String,
        parent_id: Option<i64>,
    ) -> Result<BookmarkFolder, StoreError> {
        self.call(move |a| ops::bookmarks::folder_create(a, &name, parent_id))
    }

    pub fn folder_rename(&self, id: i64, name: String) -> Result<BookmarkFolder, StoreError> {
        self.call(move |a| ops::bookmarks::folder_rename(a, id, &name))
    }

    /// Deletes the folder, its subfolders, and everything in them. Returns
    /// the number of folders removed so the UI can confirm honestly.
    pub fn folder_delete(&self, id: i64) -> Result<u64, StoreError> {
        self.call(move |a| ops::bookmarks::folder_delete(a, id))
    }

    pub fn folder_list(&self) -> Result<Vec<BookmarkFolder>, StoreError> {
        self.call(ops::bookmarks::folder_list)
    }

    // -----------------------------------------------------------------------
    // History
    // -----------------------------------------------------------------------

    /// Records a visit unless it is private or history is disabled — both
    /// reported as `Skipped`, never as success.
    pub fn history_add(&self, visit: NewHistoryVisit) -> Result<HistoryAddOutcome, StoreError> {
        self.call(move |a| ops::history::add(a, visit))
    }

    /// Newest-first list with optional time range and site (host) filter.
    pub fn history_list(&self, filter: HistoryFilter) -> Result<Vec<HistoryEntry>, StoreError> {
        self.call(move |a| ops::history::list(a, &filter))
    }

    /// FTS5 search over title/url/host, newest first.
    pub fn history_search(
        &self,
        query: String,
        limit: usize,
    ) -> Result<Vec<HistoryEntry>, StoreError> {
        self.call(move |a| ops::history::search(a, &query, limit))
    }

    pub fn history_delete(&self, id: i64) -> Result<(), StoreError> {
        self.call(move |a| ops::history::delete(a, id))
    }

    /// Deletes visits inside `[from_ms, to_ms]`; returns rows removed.
    pub fn history_clear_range(&self, from_ms: i64, to_ms: i64) -> Result<u64, StoreError> {
        self.call(move |a| ops::history::clear_range(a, from_ms, to_ms))
    }

    pub fn history_count(&self) -> Result<u64, StoreError> {
        self.call(ops::history::count)
    }

    // -----------------------------------------------------------------------
    // Downloads (runtime events only)
    // -----------------------------------------------------------------------

    /// Start recording a download. A duplicate in-progress url returns
    /// `Duplicate` with the existing id.
    pub fn download_start(&self, req: DownloadStart) -> Result<DownloadRecord, StoreError> {
        self.call(move |a| ops::downloads::start(a, req))
    }

    /// Feed one real runtime event. Transitions outside
    /// `in_progress → completed | cancelled | failed` are rejected.
    pub fn download_event(
        &self,
        id: i64,
        event: DownloadEvent,
    ) -> Result<DownloadRecord, StoreError> {
        self.call(move |a| ops::downloads::event(a, id, event))
    }

    pub fn download_list(&self) -> Result<Vec<DownloadRecord>, StoreError> {
        self.call(ops::downloads::list)
    }

    /// Removes a download *record*; never touches the file on disk.
    pub fn download_delete(&self, id: i64) -> Result<(), StoreError> {
        self.call(move |a| ops::downloads::delete(a, id))
    }

    /// Removes finished records only; returns rows removed.
    pub fn downloads_clear_completed(&self) -> Result<u64, StoreError> {
        self.call(ops::downloads::clear_completed)
    }

    // -----------------------------------------------------------------------
    // Scratchpad notes
    // -----------------------------------------------------------------------

    pub fn note_create(&self, req: NewNote) -> Result<Note, StoreError> {
        self.call(move |a| ops::notes::create(a, req))
    }

    pub fn note_get(&self, id: i64) -> Result<Note, StoreError> {
        self.call(move |a| ops::notes::get(a, id))
    }

    pub fn note_list(&self, limit: usize) -> Result<Vec<Note>, StoreError> {
        self.call(move |a| ops::notes::list(a, limit))
    }

    pub fn note_search(&self, query: String, limit: usize) -> Result<Vec<Note>, StoreError> {
        self.call(move |a| ops::notes::search(a, &query, limit))
    }

    /// Autosave with optimistic concurrency. `expected_revision` mismatch
    /// returns `Conflict` and changes nothing — the UI must show unsaved.
    pub fn note_update(
        &self,
        id: i64,
        title: Option<String>,
        body: String,
        expected_revision: i64,
    ) -> Result<Note, StoreError> {
        self.call(move |a| ops::notes::update(a, id, title, body, expected_revision))
    }

    pub fn note_delete(&self, id: i64) -> Result<(), StoreError> {
        self.call(move |a| ops::notes::delete(a, id))
    }

    /// Single source for the saved-note count.
    pub fn note_count(&self) -> Result<u64, StoreError> {
        self.call(ops::notes::count)
    }

    // -----------------------------------------------------------------------
    // Session
    // -----------------------------------------------------------------------

    /// Replace the saved session atomically after validation.
    pub fn session_save(&self, state: SessionState) -> Result<(), StoreError> {
        self.call(move |a| ops::session::save(a, state))
    }

    /// `None` when there is nothing to restore, including when the stored
    /// session is corrupt (counted, reported by `integrity_check`).
    pub fn session_load(&self) -> Result<Option<SessionState>, StoreError> {
        self.call(ops::session::load)
    }

    // -----------------------------------------------------------------------
    // Clear data, integrity, lifecycle
    // -----------------------------------------------------------------------

    /// Deletes exactly the scoped data (docs/SCHEMA.md §5) and reports what
    /// was removed. Bookmarks, notes, and settings are never in scope here.
    pub fn clear_browsing_data(&self, scope: ClearScope) -> Result<ClearReport, StoreError> {
        self.call(move |a| {
            let mut report = ClearReport::default();
            if let Some(range) = scope.history {
                report.history_deleted = ops::history::clear_range(a, range.from_ms, range.to_ms)?;
            }
            if scope.downloads {
                report.downloads_deleted = ops::downloads::clear_completed(a)?;
            }
            if scope.session {
                report.session_cleared = ops::session::clear(a)?;
            }
            Ok(report)
        })
    }

    /// Structural check plus per-table malformed-row counts. `ok` is true
    /// only when the database is intact *and* contains no malformed rows.
    pub fn integrity_check(&self) -> Result<IntegrityReport, StoreError> {
        self.call(|a| {
            let integrity_check: String = a
                .conn
                .query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            // pragma_foreign_key_check yields one row per violation, so a
            // clean database has zero rows: count them instead of query_row.
            let foreign_key_violations =
                ops::one_count(&a.conn, "SELECT COUNT(*) FROM pragma_foreign_key_check")?;
            let malformed = vec![
                ("settings", ops::settings::scan_malformed(a)?),
                ("bookmarks", scan_bookmarks(a)?),
                ("history", ops::history::scan_malformed(a)?),
                ("downloads", ops::downloads::scan_malformed(a)?),
                ("notes", ops::notes::scan_malformed(a)?),
                ("session", ops::session::scan_malformed(a)?),
            ];
            let malformed_rows: Vec<MalformedRows> = malformed
                .into_iter()
                .filter(|(_, n)| *n > 0)
                .map(|(table, count)| MalformedRows {
                    table: table.to_string(),
                    count,
                })
                .collect();
            let counts = TableCounts {
                settings: ops::one_count(&a.conn, "SELECT COUNT(*) FROM settings")?,
                bookmark_folders: ops::one_count(&a.conn, "SELECT COUNT(*) FROM bookmark_folders")?,
                bookmarks: ops::one_count(&a.conn, "SELECT COUNT(*) FROM bookmarks")?,
                history: ops::one_count(&a.conn, "SELECT COUNT(*) FROM history")?,
                downloads: ops::one_count(&a.conn, "SELECT COUNT(*) FROM downloads")?,
                notes: ops::one_count(&a.conn, "SELECT COUNT(*) FROM notes")?,
                session_tabs: ops::one_count(&a.conn, "SELECT COUNT(*) FROM session_tabs")?,
            };
            let schema_version = migrations::current_version(&a.conn)?;
            let ok =
                integrity_check == "ok" && foreign_key_violations == 0 && malformed_rows.is_empty();
            Ok(IntegrityReport {
                ok,
                schema_version,
                integrity_check,
                foreign_key_violations,
                malformed_rows,
                counts,
            })
        })
    }

    /// Row counts and the malformed-skip counter (what reads have degraded
    /// since the database was opened).
    pub fn stats(&self) -> Result<StoreStats, StoreError> {
        self.call(|a| {
            Ok(StoreStats {
                counts: TableCounts {
                    settings: ops::one_count(&a.conn, "SELECT COUNT(*) FROM settings")?,
                    bookmark_folders: ops::one_count(
                        &a.conn,
                        "SELECT COUNT(*) FROM bookmark_folders",
                    )?,
                    bookmarks: ops::one_count(&a.conn, "SELECT COUNT(*) FROM bookmarks")?,
                    history: ops::one_count(&a.conn, "SELECT COUNT(*) FROM history")?,
                    downloads: ops::one_count(&a.conn, "SELECT COUNT(*) FROM downloads")?,
                    notes: ops::one_count(&a.conn, "SELECT COUNT(*) FROM notes")?,
                    session_tabs: ops::one_count(&a.conn, "SELECT COUNT(*) FROM session_tabs")?,
                },
                malformed_rows_skipped: a.malformed_rows_skipped,
            })
        })
    }

    /// Current migration version (0 = fresh, empty database).
    pub fn schema_version(&self) -> Result<i64, StoreError> {
        self.call(|a| migrations::current_version(&a.conn))
    }

    /// Apply down-migrations in reverse until `target` is reached. Every
    /// step has a down path; ROT's gates use this to prove reversibility.
    pub fn downgrade(&self, target: i64) -> Result<(), StoreError> {
        self.call(move |a| migrations::migrate_down(&a.conn, target))
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        self.close();
    }
}

fn scan_bookmarks(a: &mut Actor) -> Result<u64, StoreError> {
    ops::bookmarks::scan_malformed(a)
}

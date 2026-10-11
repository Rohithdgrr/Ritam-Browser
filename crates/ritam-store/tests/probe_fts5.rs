//! Capability probe: does the bundled SQLite build ship FTS5?
//! Result decides the history/bookmark search design in docs/SCHEMA.md.
use rusqlite::Connection;

#[test]
fn bundled_sqlite_reports_fts5() {
    let conn = Connection::open_in_memory().expect("open");
    let enabled: bool = conn
        .query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |r| {
            r.get(0)
        })
        .unwrap_or(false);
    let can_create = conn
        .execute_batch("CREATE VIRTUAL TABLE probe_fts USING fts5(a, b);")
        .is_ok();
    let sqlite_version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .unwrap();
    println!("SQLite {sqlite_version}; FTS5 compileoption: {enabled}, create-virtual-table ok: {can_create}");
    assert!(enabled && can_create, "bundled SQLite lacks FTS5");
}

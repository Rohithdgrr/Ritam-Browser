//! Malformed rows on disk must degrade gracefully: skipped on read, counted,
//! and reported by integrity_check — never a crash, never a silent pass.

use ritam_store::*;
use rusqlite::Connection;

/// Corrupt a few rows behind the store's back (second connection, WAL allows
/// it), then prove reads survive and the damage is visible.
#[test]
fn malformed_rows_are_skipped_counted_and_reported() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("malformed.sqlite");

    let mut store = Store::open(&path).expect("open");
    store
        .history_add(NewHistoryVisit {
            url: "https://good.example".into(),
            title: "good".into(),
            visited_at_ms: 1_700_000_000_000,
            duration_ms: None,
            http_status: None,
            transition: Transition::Typed,
            visibility: Visibility::Normal,
        })
        .expect("history");
    store
        .history_add(NewHistoryVisit {
            url: "https://will-be-broken.example".into(),
            title: "broken".into(),
            visited_at_ms: 1_700_000_001_000,
            duration_ms: None,
            http_status: None,
            transition: Transition::Typed,
            visibility: Visibility::Normal,
        })
        .expect("history");
    store
        .settings_set(SettingValue::ZoomPercent(120))
        .expect("setting");
    store.close();

    // Corrupt one history row (bogus transition) and the zoom setting value
    // (out-of-range garbage written behind the store's back).
    {
        let conn = Connection::open(&path).expect("raw open");
        conn.pragma_update(None, "busy_timeout", 5000)
            .expect("busy");
        conn.execute(
            "UPDATE history SET transition = 'teleport' WHERE url = 'https://will-be-broken.example'",
            [],
        )
        .expect("corrupt history");
        conn.execute(
            "UPDATE settings SET value = 'banana' WHERE key = 'zoom_percent'",
            [],
        )
        .expect("corrupt settings");
        conn.execute(
            "INSERT INTO settings (key, value, updated_at_ms) VALUES ('not_a_real_key', 'x', 1)",
            [],
        )
        .expect("unknown setting key");
    }

    let store = Store::open(&path).expect("reopen");

    // The good row reads; the broken one is skipped, not fatal.
    let entries = store.history_list(HistoryFilter::default()).expect("list");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].url, "https://good.example");
    assert!(
        store
            .history_search("broken".into(), 50)
            .expect("search")
            .is_empty(),
        "malformed row must not surface in search"
    );

    // A garbled setting falls back to its default instead of failing.
    let zoom = store.settings_get(SettingKey::ZoomPercent).expect("get");
    assert_eq!(zoom, SettingValue::ZoomPercent(100));
    let all = store.settings_list().expect("list");
    assert_eq!(all.len(), 6);

    // The degradation is counted, never silent.
    let stats = store.stats().expect("stats");
    assert!(
        stats.malformed_rows_skipped >= 2,
        "expected skips to be counted, got {}",
        stats.malformed_rows_skipped
    );

    // And integrity_check names the damaged tables with ok = false.
    let report = store.integrity_check().expect("integrity");
    assert!(!report.ok, "corrupt database must not report ok");
    assert_eq!(report.integrity_check, "ok"); // structure itself is fine
    let tables: Vec<&str> = report
        .malformed_rows
        .iter()
        .map(|m| m.table.as_str())
        .collect();
    assert!(
        tables.contains(&"history"),
        "history damage reported: {tables:?}"
    );
    assert!(
        tables.contains(&"settings"),
        "settings damage reported: {tables:?}"
    );
    assert_eq!(report.counts.history, 2); // both rows still exist on disk
}

/// An intact database reports ok and no malformed tables.
#[test]
fn intact_database_reports_clean_integrity() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("clean.sqlite");
    let store = Store::open(&path).expect("open");
    store
        .bookmark_add(NewBookmark {
            url: "https://example.com".into(),
            title: "Example".into(),
            folder_id: None,
        })
        .expect("add");
    let report = store.integrity_check().expect("integrity");
    assert!(report.ok, "{report:?}");
    assert!(report.malformed_rows.is_empty());
    assert_eq!(report.schema_version, 1);
    assert_eq!(report.integrity_check, "ok");
    assert_eq!(report.foreign_key_violations, 0);
    assert_eq!(report.counts.bookmarks, 1);
}

/// Closed store: every command fails honestly instead of hanging or
/// pretending success.
#[test]
fn commands_after_close_fail_with_typed_error() {
    let mut store = Store::open_in_memory().expect("open");
    store.close();
    let err = store.bookmark_list(None).expect_err("closed store");
    assert!(matches!(err, StoreError::ActorStopped));
    // close() is idempotent
    store.close();
}

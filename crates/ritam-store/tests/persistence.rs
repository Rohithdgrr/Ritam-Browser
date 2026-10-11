//! Restart survival, migration up/down reversibility, session restore,
//! clear-browsing-data scopes, and malformed-data degradation.

use ritam_store::*;

/// Reopen the same on-disk file: what was saved is what comes back.
#[test]
fn data_survives_restart() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("ritam-store.sqlite");

    {
        let store = Store::open(&path).expect("open");
        let BookmarkAddOutcome::Created(b) = store
            .bookmark_add(NewBookmark {
                url: "https://example.com".into(),
                title: "Example".into(),
                folder_id: None,
            })
            .expect("add")
        else {
            panic!("expected Created");
        };
        store
            .history_add(NewHistoryVisit {
                url: "https://example.com".into(),
                title: "Example".into(),
                visited_at_ms: 1_700_000_000_000,
                duration_ms: None,
                http_status: Some(200),
                transition: Transition::Typed,
                visibility: Visibility::Normal,
            })
            .expect("history");
        store
            .note_create(NewNote {
                title: "note".into(),
                body: "body".into(),
                url: None,
            })
            .expect("note");
        store
            .settings_set(SettingValue::ZoomPercent(125))
            .expect("setting");
        store
            .session_save(SessionState {
                active_tab_id: 7,
                tabs: vec![TabState {
                    tab_id: 7,
                    url: "https://example.com".into(),
                    title: "Example".into(),
                }],
            })
            .expect("session");
        assert_eq!(b.title, "Example");
        // Store closed by drop.
    }

    let store = Store::open(&path).expect("reopen");
    let bookmarks = store.bookmark_list(None).expect("list");
    assert_eq!(bookmarks.len(), 1);
    assert_eq!(bookmarks[0].url, "https://example.com");
    assert_eq!(store.history_count().expect("count"), 1);
    assert_eq!(store.note_count().expect("count"), 1);
    assert_eq!(
        store.settings_get(SettingKey::ZoomPercent).expect("get"),
        SettingValue::ZoomPercent(125)
    );
    let session = store.session_load().expect("session").expect("restored");
    assert_eq!(session.active_tab_id, 7);
    assert_eq!(session.tabs[0].url, "https://example.com");
    let report = store.integrity_check().expect("integrity");
    assert!(report.ok, "integrity failed: {report:?}");
}

/// Down-then-up must round-trip and leave working storage behind it.
#[test]
fn migrations_round_trip_down_then_up() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("mig.sqlite");

    let mut store = Store::open(&path).expect("open");
    assert_eq!(store.schema_version().expect("version"), 1);
    store
        .bookmark_add(NewBookmark {
            url: "https://example.com".into(),
            title: "Example".into(),
            folder_id: None,
        })
        .expect("add");

    // Down to zero: every table of v1 is gone.
    store.downgrade(0).expect("downgrade");
    assert_eq!(store.schema_version().expect("version"), 0);
    let err = store.bookmark_list(None).expect_err("tables must be gone");
    assert!(matches!(err, StoreError::Sqlite(_)));
    store.close();

    // Reopening the file re-applies pending up-migrations cleanly.
    let store = Store::open(&path).expect("reopen");
    assert_eq!(store.schema_version().expect("version"), 1);
    let BookmarkAddOutcome::Created(b) = store
        .bookmark_add(NewBookmark {
            url: "https://example.com".into(),
            title: "Example 2".into(),
            folder_id: None,
        })
        .expect("add after re-upgrade")
    else {
        panic!("expected Created");
    };
    assert_eq!(b.title, "Example 2");
    let report = store.integrity_check().expect("integrity");
    assert!(report.ok, "integrity failed: {report:?}");
}

#[test]
fn downgrade_below_zero_is_rejected() {
    let store = Store::open_in_memory().expect("open");
    let err = store.downgrade(-1).expect_err("negative target");
    assert!(matches!(err, StoreError::InvalidInput(_)));
}

#[test]
fn clear_browsing_data_reports_exactly_what_it_removed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("clear.sqlite");
    let store = Store::open(&path).expect("open");

    for i in 0..3 {
        store
            .history_add(NewHistoryVisit {
                url: format!("https://example.com/{i}"),
                title: format!("page {i}"),
                visited_at_ms: 1_700_000_000_000 + i * 1000,
                duration_ms: None,
                http_status: None,
                transition: Transition::Typed,
                visibility: Visibility::Normal,
            })
            .expect("history");
    }
    let d = store
        .download_start(DownloadStart {
            url: "https://example.com/f".into(),
            filename: "f.bin".into(),
            mime_type: None,
        })
        .expect("download");
    store
        .download_event(d.id, DownloadEvent::Cancelled)
        .expect("cancel");
    store
        .note_create(NewNote {
            title: "keep me".into(),
            body: "keep me".into(),
            url: None,
        })
        .expect("note");
    store
        .bookmark_add(NewBookmark {
            url: "https://example.com".into(),
            title: "keep me".into(),
            folder_id: None,
        })
        .expect("bookmark");
    store
        .session_save(SessionState {
            active_tab_id: 1,
            tabs: vec![TabState {
                tab_id: 1,
                url: "https://example.com".into(),
                title: "t".into(),
            }],
        })
        .expect("session");

    // Scope: history in the first second only, downloads, session.
    let report = store
        .clear_browsing_data(ClearScope {
            history: Some(TimeRange {
                from_ms: 1,
                to_ms: 1_700_000_000_500,
            }),
            downloads: true,
            session: true,
        })
        .expect("clear");
    assert_eq!(report.history_deleted, 1);
    assert_eq!(report.downloads_deleted, 1);
    assert!(report.session_cleared);

    // What was removed is gone; what was out of scope survived untouched.
    assert_eq!(store.history_count().expect("count"), 2);
    assert!(store.download_list().expect("downloads").is_empty());
    assert!(store.session_load().expect("load").is_none());
    assert_eq!(store.note_count().expect("count"), 1);
    assert_eq!(store.bookmark_list(None).expect("bookmarks").len(), 1);
    assert_eq!(
        store.settings_get(SettingKey::ZoomPercent).expect("get"),
        SettingValue::ZoomPercent(100)
    );
    let report = store.integrity_check().expect("integrity");
    assert!(report.ok, "integrity failed: {report:?}");
}

#[test]
fn session_validation_rejects_inconsistent_state() {
    let store = Store::open_in_memory().expect("open");
    // active tab not in the tab list
    let err = store
        .session_save(SessionState {
            active_tab_id: 99,
            tabs: vec![TabState {
                tab_id: 1,
                url: "https://example.com".into(),
                title: "t".into(),
            }],
        })
        .expect_err("inconsistent");
    assert!(matches!(err, StoreError::InvalidInput(_)));

    // zero tabs
    let err = store
        .session_save(SessionState {
            active_tab_id: 1,
            tabs: vec![],
        })
        .expect_err("empty");
    assert!(matches!(err, StoreError::InvalidInput(_)));

    // nothing saved yet loads as None, not an error
    assert!(store.session_load().expect("load").is_none());
}

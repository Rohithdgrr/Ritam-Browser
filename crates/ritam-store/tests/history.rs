//! History: privacy rules, FTS search, filters, deletion.

use ritam_store::*;

fn store() -> Store {
    Store::open_in_memory().expect("open")
}

fn visit(url: &str, title: &str, at_ms: i64) -> NewHistoryVisit {
    NewHistoryVisit {
        url: url.to_string(),
        title: title.to_string(),
        visited_at_ms: at_ms,
        duration_ms: Some(120),
        http_status: Some(200),
        transition: Transition::Typed,
        visibility: Visibility::Normal,
    }
}

const T0: i64 = 1_700_000_000_000;

#[test]
fn normal_visit_is_recorded_and_readable() {
    let store = store();
    let outcome = store
        .history_add(visit("https://Example.COM/page", "Example Page", T0))
        .expect("add");
    let HistoryAddOutcome::Recorded(id) = outcome else {
        panic!("expected Recorded, got {outcome:?}");
    };
    let entries = store.history_list(HistoryFilter::default()).expect("list");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].id, id);
    assert_eq!(entries[0].url, "https://Example.COM/page");
    // Host is normalized for the site filter; url is stored verbatim.
    assert_eq!(entries[0].host, "example.com");
    assert_eq!(entries[0].http_status, Some(200));
}

#[test]
fn private_visits_never_write_to_normal_history() {
    let store = store();
    let mut v = visit("https://secret.example", "Secret", T0);
    v.visibility = Visibility::Private;
    let outcome = store.history_add(v).expect("add");
    assert_eq!(
        outcome,
        HistoryAddOutcome::Skipped(SkipReason::PrivateSession)
    );
    assert_eq!(store.history_count().expect("count"), 0);
    assert!(store
        .history_list(HistoryFilter::default())
        .expect("list")
        .is_empty());
}

#[test]
fn history_disabled_setting_skips_recording_explicitly() {
    let store = store();
    store
        .settings_set(SettingValue::HistoryEnabled(false))
        .expect("disable");
    let outcome = store
        .history_add(visit("https://example.com", "Example", T0))
        .expect("add");
    assert_eq!(
        outcome,
        HistoryAddOutcome::Skipped(SkipReason::HistoryDisabled)
    );
    assert_eq!(store.history_count().expect("count"), 0);

    // Re-enabling records again.
    store
        .settings_set(SettingValue::HistoryEnabled(true))
        .expect("enable");
    let outcome = store
        .history_add(visit("https://example.com", "Example", T0))
        .expect("add");
    assert!(matches!(outcome, HistoryAddOutcome::Recorded(_)));
}

#[test]
fn search_finds_by_title_and_url_newest_first() {
    let store = store();
    for (url, title, at) in [
        ("https://rust-lang.org", "Rust Programming", T0),
        ("https://example.com/rust", "An Example", T0 + 1000),
        ("https://unrelated.dev", "Nothing Here", T0 + 2000),
    ] {
        store.history_add(visit(url, title, at)).expect("add");
    }
    let hits = store.history_search("rust".into(), 50).expect("search");
    assert_eq!(hits.len(), 2);
    // Newest first.
    assert_eq!(hits[0].url, "https://example.com/rust");
    assert_eq!(hits[1].url, "https://rust-lang.org");

    // Multi-token AND semantics.
    let hits = store
        .history_search("rust programming".into(), 50)
        .expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].url, "https://rust-lang.org");

    // FTS5 operators inside user input must not error or match everything.
    let hits = store
        .history_search("rust OR *".into(), 50)
        .expect("search");
    assert!(hits.iter().all(|h| h.url.contains("rust")));
}

#[test]
fn filter_by_time_range_and_host() {
    let store = store();
    for (url, at) in [
        ("https://a.example/1", T0),
        ("https://a.example/2", T0 + 60_000),
        ("https://b.example/3", T0 + 120_000),
    ] {
        store.history_add(visit(url, "t", at)).expect("add");
    }
    let in_range = store
        .history_list(HistoryFilter {
            from_ms: Some(T0),
            to_ms: Some(T0 + 60_000),
            ..Default::default()
        })
        .expect("range");
    assert_eq!(in_range.len(), 2);

    let site = store
        .history_list(HistoryFilter {
            host: Some("a.example".into()),
            ..Default::default()
        })
        .expect("host");
    assert_eq!(site.len(), 2);
    assert!(site.iter().all(|e| e.host == "a.example"));
}

#[test]
fn delete_entry_and_clear_range() {
    let store = store();
    for i in 0..4 {
        store
            .history_add(visit(
                &format!("https://example.com/{i}"),
                "t",
                T0 + i * 1000,
            ))
            .expect("add");
    }
    let entries = store.history_list(HistoryFilter::default()).expect("list");
    // List is newest-first: entries[0] is T0+3000, entries[3] is T0.
    store.history_delete(entries[0].id).expect("delete");
    assert_eq!(store.history_count().expect("count"), 3);

    let deleted = store
        .history_clear_range(T0, T0 + 1000)
        .expect("clear range");
    assert_eq!(deleted, 2);
    assert_eq!(store.history_count().expect("count"), 1);

    // FTS stays in sync after deletions: a cleared term finds nothing.
    let hits = store.history_search("t".into(), 50).expect("search");
    assert_eq!(hits.len(), 1);
}

#[test]
fn invalid_history_inputs_are_rejected() {
    let store = store();
    let mut v = visit("https://example.com", "t", T0);
    v.http_status = Some(999);
    assert!(matches!(
        store.history_add(v).expect_err("bad status"),
        StoreError::InvalidInput(_)
    ));

    let mut v = visit("https://example.com", "t", T0);
    v.visited_at_ms = -5;
    assert!(matches!(
        store.history_add(v).expect_err("bad timestamp"),
        StoreError::InvalidInput(_)
    ));

    assert!(matches!(
        store
            .history_list(HistoryFilter {
                from_ms: Some(T0 + 10),
                to_ms: Some(T0),
                ..Default::default()
            })
            .expect_err("from > to"),
        StoreError::InvalidInput(_)
    ));

    assert!(matches!(
        store.history_search("q".into(), 0).expect_err("zero limit"),
        StoreError::InvalidInput(_)
    ));
}

/// `from_ms: 0` is a legal **range bound** meaning "all time" — the exact
/// shape the settings panel sends for its "All time" clear
/// (`chrome.js` → `clear_browsing_data {scope.history:{from_ms:0,to_ms:now}}`).
/// Regression: range bounds were once validated with the event-timestamp
/// rule (`> 0`), which rejected `0` and failed that clear. Event timestamps
/// themselves stay strict; negative bounds are still rejected.
#[test]
fn range_bounds_accept_zero_epoch_and_reject_negative() {
    let store = store();
    for i in 0..3 {
        store
            .history_add(visit(
                &format!("https://example.com/{i}"),
                "t",
                T0 + i * 1000,
            ))
            .expect("add");
    }

    // Filter with an epoch lower bound sees every row.
    let all = store
        .history_list(HistoryFilter {
            from_ms: Some(0),
            ..Default::default()
        })
        .expect("filter from epoch");
    assert_eq!(all.len(), 3);

    // Clear with from_ms = 0 removes every row (UI "All time" shape).
    let deleted = store
        .history_clear_range(0, 200_000_000_000_000)
        .expect("clear all");
    assert_eq!(deleted, 3);
    assert_eq!(store.history_count().expect("count"), 0);

    // Negative bounds are still invalid input.
    assert!(matches!(
        store
            .history_clear_range(-1, 100)
            .expect_err("negative from"),
        StoreError::InvalidInput(_)
    ));
    assert!(matches!(
        store
            .history_list(HistoryFilter {
                from_ms: Some(-1),
                ..Default::default()
            })
            .expect_err("negative filter bound"),
        StoreError::InvalidInput(_)
    ));
}

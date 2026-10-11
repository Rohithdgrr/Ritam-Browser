//! Downloads: real-event state machine, duplicates, clear-completed.

use ritam_store::*;

fn store() -> Store {
    Store::open_in_memory().expect("open")
}

fn start(store: &Store, url: &str, filename: &str) -> DownloadRecord {
    store
        .download_start(DownloadStart {
            url: url.to_string(),
            filename: filename.to_string(),
            mime_type: Some("application/pdf".into()),
        })
        .expect("start")
}

const PROGRESS: i64 = 1_024;

#[test]
fn full_lifecycle_in_progress_to_completed() {
    let store = store();
    let d = start(&store, "https://example.com/file.pdf", "file.pdf");
    assert_eq!(d.state, DownloadState::InProgress);
    assert_eq!(d.bytes_received, 0);
    assert_eq!(d.save_path, None);

    let d = store
        .download_event(
            d.id,
            DownloadEvent::Progress {
                bytes_received: PROGRESS,
                bytes_total: Some(PROGRESS * 2),
            },
        )
        .expect("progress");
    assert_eq!(d.state, DownloadState::InProgress);
    assert_eq!(d.bytes_received, PROGRESS);
    assert_eq!(d.bytes_total, Some(PROGRESS * 2));

    let save_path = std::env::temp_dir().join("ritam-test-file.pdf");
    let d = store
        .download_event(
            d.id,
            DownloadEvent::Completed {
                save_path: Some(save_path.to_string_lossy().into_owned()),
                bytes_total: Some(PROGRESS * 2),
            },
        )
        .expect("complete");
    assert_eq!(d.state, DownloadState::Completed);
    assert_eq!(d.bytes_total, Some(PROGRESS * 2));
    assert!(d.finished_at_ms.is_some());
}

#[test]
fn failed_carries_error_cancelled_is_terminal() {
    let store = store();
    let a = start(&store, "https://example.com/a", "a.bin");
    let failed = store
        .download_event(
            a.id,
            DownloadEvent::Failed {
                error: Some("disk full".into()),
            },
        )
        .expect("fail");
    assert_eq!(failed.state, DownloadState::Failed);
    assert_eq!(failed.error.as_deref(), Some("disk full"));

    let b = start(&store, "https://example.com/b", "b.bin");
    let cancelled = store
        .download_event(b.id, DownloadEvent::Cancelled)
        .expect("cancel");
    assert_eq!(cancelled.state, DownloadState::Cancelled);
}

#[test]
fn transitions_outside_the_state_machine_are_rejected() {
    let store = store();
    let d = start(&store, "https://example.com/c", "c.bin");
    store
        .download_event(d.id, DownloadEvent::Cancelled)
        .expect("cancel");

    // A terminal download cannot receive more events.
    let err = store
        .download_event(
            d.id,
            DownloadEvent::Progress {
                bytes_received: 10,
                bytes_total: None,
            },
        )
        .expect_err("progress after cancel");
    assert!(matches!(err, StoreError::InvalidTransition { .. }));

    let err = store
        .download_event(d.id, DownloadEvent::Cancelled)
        .expect_err("double cancel");
    assert!(matches!(err, StoreError::InvalidTransition { .. }));
}

#[test]
fn completed_requires_absolute_path() {
    let store = store();
    let d = start(&store, "https://example.com/d", "d.bin");
    let err = store
        .download_event(
            d.id,
            DownloadEvent::Completed {
                save_path: Some("relative/path.bin".into()),
                bytes_total: None,
            },
        )
        .expect_err("relative path");
    assert!(matches!(err, StoreError::InvalidInput(_)));
    // Still in progress: the rejected event changed nothing.
    let list = store.download_list().expect("list");
    assert_eq!(list[0].state, DownloadState::InProgress);
}

#[test]
fn duplicate_active_download_is_reported() {
    let store = store();
    let d = start(&store, "https://example.com/e", "e.bin");
    let err = store
        .download_start(DownloadStart {
            url: "https://example.com/e".into(),
            filename: "e (1).bin".into(),
            mime_type: None,
        })
        .expect_err("duplicate active");
    match err {
        StoreError::Duplicate { existing_id, .. } => assert_eq!(existing_id, d.id),
        other => panic!("expected Duplicate, got {other:?}"),
    }
    assert_eq!(store.download_list().expect("list").len(), 1);
}

#[test]
fn re_download_after_finish_is_allowed() {
    let store = store();
    let d = start(&store, "https://example.com/f", "f.bin");
    store
        .download_event(d.id, DownloadEvent::Cancelled)
        .expect("cancel");
    // Finished record does not block a fresh download of the same url.
    let again = start(&store, "https://example.com/f", "f.bin");
    assert_eq!(again.state, DownloadState::InProgress);
    assert_eq!(store.download_list().expect("list").len(), 2);
}

#[test]
fn clear_completed_keeps_active_records() {
    let store = store();
    let a = start(&store, "https://example.com/1", "1.bin");
    let b = start(&store, "https://example.com/2", "2.bin");
    let c = start(&store, "https://example.com/3", "3.bin");
    store
        .download_event(a.id, DownloadEvent::Cancelled)
        .expect("cancel");
    store
        .download_event(
            b.id,
            DownloadEvent::Failed {
                error: Some("boom".into()),
            },
        )
        .expect("fail");
    // c stays in_progress.

    let cleared = store.downloads_clear_completed().expect("clear");
    assert_eq!(cleared, 2);
    let list = store.download_list().expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].id, c.id);
    assert_eq!(list[0].state, DownloadState::InProgress);

    // Deleting a record reports NotFound when it is already gone.
    store.download_delete(c.id).expect("delete");
    let err = store.download_delete(c.id).expect_err("gone");
    assert!(matches!(
        err,
        StoreError::NotFound {
            entity: "download",
            ..
        }
    ));
}

/// The runtime's real finish payload (contract §9.1) may carry
/// `path: null` on success and never carries error text on failure.
/// Recording those as NULL is honest; refusing them would force the host
/// to fabricate a path or a message (simulated success). The records must
/// read back cleanly and must NOT be flagged malformed.
#[test]
fn unreported_path_and_error_are_recorded_as_null_not_fabricated() {
    let store = store();

    // success = true, path = null → completed with save_path NULL.
    let a = start(&store, "https://example.com/nopath", "n.bin");
    let d = store
        .download_event(
            a.id,
            DownloadEvent::Completed {
                save_path: None,
                bytes_total: None,
            },
        )
        .expect("finish without a reported path");
    assert_eq!(d.state, DownloadState::Completed);
    assert!(
        d.save_path.is_none(),
        "no path reported → NULL, never invented"
    );
    assert!(d.finished_at_ms.is_some());

    // success = false, no error text → failed with error NULL.
    let b = start(&store, "https://example.com/notext", "t.bin");
    let f = store
        .download_event(b.id, DownloadEvent::Failed { error: None })
        .expect("fail without reported text");
    assert_eq!(f.state, DownloadState::Failed);
    assert!(f.error.is_none(), "no text reported → NULL, never invented");
    assert!(f.finished_at_ms.is_some());

    // Both rows read back through the normal path…
    let list = store.download_list().expect("list");
    assert_eq!(list.len(), 2);
    // …and integrity_check must not call them malformed.
    let report = store.integrity_check().expect("integrity");
    assert!(report.ok, "honest NULLs must not be malformed: {report:?}");
    assert_eq!(report.counts.downloads, 2);

    // A path that IS present must still be absolute.
    let c = start(&store, "https://example.com/rel", "r.bin");
    let err = store
        .download_event(
            c.id,
            DownloadEvent::Completed {
                save_path: Some("relative.bin".into()),
                bytes_total: None,
            },
        )
        .expect_err("relative path still rejected");
    assert!(matches!(err, StoreError::InvalidInput(_)));

    // And an empty-string error is still invalid input (present but useless).
    let e = start(&store, "https://example.com/empty-err", "e.bin");
    let err = store
        .download_event(
            e.id,
            DownloadEvent::Failed {
                error: Some(String::new()),
            },
        )
        .expect_err("empty error text");
    assert!(matches!(err, StoreError::InvalidInput(_)));
}

//! Store-side contract lock for the IPC wire shapes.
//!
//! `docs/SCHEMA.md` §6 "Wire shapes" promises exact JSON field names and
//! enum spellings to Rohan's `contracts/ipc.md`, and `browser/ui/chrome.js`
//! reads exactly those keys. This test pins them: if a field is renamed, an
//! enum spelling changes, or an error message the UI matches on is reworded,
//! the store's own gate goes red here first — before any panel breaks at
//! runtime.

use ritam_store::*;
use serde_json::json;

#[test]
fn clear_report_matches_the_keys_chrome_reads() {
    // chrome.js clearBrowsingData: report.history_deleted / downloads_deleted / session_cleared
    let v = serde_json::to_value(ClearReport {
        history_deleted: 3,
        downloads_deleted: 1,
        session_cleared: true,
    })
    .expect("serialize");
    assert_eq!(
        v,
        json!({
            "history_deleted": 3,
            "downloads_deleted": 1,
            "session_cleared": true
        })
    );
}

#[test]
fn integrity_report_matches_the_keys_chrome_reads() {
    // chrome.js runIntegrityCheck: r.ok, r.schema_version, r.foreign_key_violations,
    // r.malformed_rows[].table/.count, r.integrity_check
    let report = IntegrityReport {
        ok: false,
        schema_version: 1,
        integrity_check: "ok".into(),
        foreign_key_violations: 0,
        malformed_rows: vec![MalformedRows {
            table: "history".into(),
            count: 2,
        }],
        counts: TableCounts::default(),
    };
    let v = serde_json::to_value(&report).expect("serialize");
    assert_eq!(v["ok"], json!(false));
    assert_eq!(v["schema_version"], json!(1));
    assert_eq!(v["foreign_key_violations"], json!(0));
    assert_eq!(v["integrity_check"], json!("ok"));
    assert_eq!(
        v["malformed_rows"],
        json!([{"table": "history", "count": 2}])
    );
    assert!(v["counts"].is_object());
    assert_eq!(
        v.as_object().expect("object").len(),
        6,
        "IntegrityReport gained or lost a field — update SCHEMA.md §6 and chrome.js together"
    );
}

#[test]
fn history_entry_matches_the_keys_chrome_reads() {
    // chrome.js loadHistory: h.id, h.title, h.url, h.host, h.visited_at_ms
    let entry = HistoryEntry {
        id: 7,
        url: "https://example.com/page".into(),
        title: "Page".into(),
        host: "example.com".into(),
        visited_at_ms: 1_700_000_000_000,
        duration_ms: None,
        http_status: Some(200),
        transition: Transition::Typed,
    };
    let v = serde_json::to_value(&entry).expect("serialize");
    assert_eq!(
        v,
        json!({
            "id": 7,
            "url": "https://example.com/page",
            "title": "Page",
            "host": "example.com",
            "visited_at_ms": 1_700_000_000_000_i64,
            "duration_ms": null,
            "http_status": 200,
            "transition": "typed"
        })
    );
    // The transition spellings the wire table documents.
    for (t, s) in [
        (Transition::Typed, "typed"),
        (Transition::Link, "link"),
        (Transition::Reload, "reload"),
        (Transition::Restore, "restore"),
    ] {
        assert_eq!(serde_json::to_value(t).expect("ser"), json!(s));
        assert_eq!(t.as_str(), s);
    }
}

#[test]
fn download_record_matches_the_keys_chrome_reads() {
    // chrome.js loadDownloads: d.filename, d.url, d.state, d.bytes_received,
    // d.bytes_total, d.save_path, d.error
    let rec = DownloadRecord {
        id: 2,
        url: "https://example.com/f.bin".into(),
        filename: "f.bin".into(),
        mime_type: None,
        save_path: Some("C:\\Users\\x\\Downloads\\f.bin".into()),
        state: DownloadState::Completed,
        bytes_received: 1024,
        bytes_total: Some(1024),
        error: None,
        started_at_ms: 1_700_000_000_000,
        updated_at_ms: 1_700_000_001_000,
        finished_at_ms: Some(1_700_000_001_000),
    };
    let v = serde_json::to_value(&rec).expect("serialize");
    assert_eq!(v["filename"], json!("f.bin"));
    assert_eq!(v["state"], json!("completed"));
    assert_eq!(v["bytes_received"], json!(1024));
    assert_eq!(v["bytes_total"], json!(1024));
    assert_eq!(v["save_path"], json!("C:\\Users\\x\\Downloads\\f.bin"));
    assert_eq!(v["error"], json!(null));
    for (st, s) in [
        (DownloadState::InProgress, "in_progress"),
        (DownloadState::Completed, "completed"),
        (DownloadState::Cancelled, "cancelled"),
        (DownloadState::Failed, "failed"),
    ] {
        assert_eq!(serde_json::to_value(st).expect("ser"), json!(s));
        assert_eq!(st.as_str(), s);
    }
}

#[test]
fn note_bookmark_folder_and_session_shapes() {
    // chrome.js: note.id/.title/.body/.revision/.updated_at_ms,
    // bookmark id/url/title/folder_id, session active_tab_id/tabs[].*
    let note = Note {
        id: 1,
        title: "Untitled note".into(),
        body: String::new(),
        url: None,
        revision: 1,
        created_at_ms: 1,
        updated_at_ms: 2,
    };
    assert_eq!(
        serde_json::to_value(&note).expect("ser"),
        json!({
            "id": 1, "title": "Untitled note", "body": "", "url": null,
            "revision": 1, "created_at_ms": 1, "updated_at_ms": 2
        })
    );

    let bookmark = Bookmark {
        id: 1,
        folder_id: None,
        url: "https://example.com".into(),
        title: "Example".into(),
        position: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    assert_eq!(
        serde_json::to_value(&bookmark).expect("ser"),
        json!({
            "id": 1, "folder_id": null, "url": "https://example.com",
            "title": "Example", "position": 0,
            "created_at_ms": 1, "updated_at_ms": 1
        })
    );

    let folder = BookmarkFolder {
        id: 5,
        parent_id: None,
        name: "Work".into(),
        position: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    assert_eq!(
        serde_json::to_value(&folder).expect("ser"),
        json!({
            "id": 5, "parent_id": null, "name": "Work", "position": 1,
            "created_at_ms": 1, "updated_at_ms": 1
        })
    );

    let session = SessionState {
        active_tab_id: 1,
        tabs: vec![TabState {
            tab_id: 1,
            url: "about:blank".into(),
            title: String::new(),
        }],
    };
    assert_eq!(
        serde_json::to_value(&session).expect("ser"),
        json!({"active_tab_id": 1, "tabs": [
            {"tab_id": 1, "url": "about:blank", "title": ""}
        ]})
    );

    // ClearScope arg shape chrome.js sends for clear_browsing_data.
    let scope = ClearScope {
        history: Some(TimeRange {
            from_ms: 0,
            to_ms: 1_700_000_000_000,
        }),
        downloads: true,
        session: false,
    };
    assert_eq!(
        serde_json::to_value(&scope).expect("ser"),
        json!({
            "history": {"from_ms": 0, "to_ms": 1_700_000_000_000_i64},
            "downloads": true,
            "session": false
        })
    );
}

#[test]
fn settings_vocabulary_matches_the_wire_coercion_table() {
    // SCHEMA.md §6 coercion table / chrome.js settingControls keys: the
    // serde spelling and as_str() must agree, or the wire layer maps a key
    // the store does not know.
    for key in SettingKey::ALL {
        assert_eq!(
            serde_json::to_value(key).expect("ser"),
            json!(key.as_str()),
            "serde spelling drifted from as_str for {key:?}"
        );
    }
    let keys: Vec<&str> = SettingKey::ALL.iter().map(|k| k.as_str()).collect();
    assert_eq!(
        keys,
        [
            "history_enabled",
            "home_page",
            "search_engine",
            "zoom_percent",
            "theme",
            "restore_session"
        ]
    );

    // Closed-enum vocabularies the settings <select> offers.
    for (e, s) in [
        (SearchEngine::Duckduckgo, "duckduckgo"),
        (SearchEngine::Google, "google"),
        (SearchEngine::Bing, "bing"),
        (SearchEngine::Wikipedia, "wikipedia"),
    ] {
        assert_eq!(serde_json::to_value(e).expect("ser"), json!(s));
        assert_eq!(e.as_str(), s);
    }
    for (t, s) in [
        (Theme::Light, "light"),
        (Theme::Dark, "dark"),
        (Theme::System, "system"),
    ] {
        assert_eq!(serde_json::to_value(t).expect("ser"), json!(s));
        assert_eq!(t.as_str(), s);
    }
}

#[test]
fn bookmark_add_outcome_serializes_as_documented() {
    // SCHEMA.md §6: {"Created": Bookmark} / {"AlreadyExists": Bookmark}
    // (externally-tagged enum) — Rohan pins this in ipc.md.
    let b = Bookmark {
        id: 9,
        folder_id: None,
        url: "https://example.com".into(),
        title: "Example".into(),
        position: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
    };
    let created = serde_json::to_value(BookmarkAddOutcome::Created(b.clone())).expect("ser");
    assert_eq!(created["Created"]["id"], json!(9));
    let dup = serde_json::to_value(BookmarkAddOutcome::AlreadyExists(b)).expect("ser");
    assert_eq!(dup["AlreadyExists"]["id"], json!(9));
}

#[test]
fn conflict_message_keeps_the_text_the_ui_falls_back_to() {
    // chrome.js saveNote: (e.code || "").includes("conflict") ||
    // (e.message || "").includes("revision") — the message half must keep
    // saying "revision" even if wire codes change.
    let err = StoreError::Conflict {
        entity: "note",
        id: 3,
        expected: 4,
        current: 5,
    };
    let msg = err.to_string();
    assert!(
        msg.contains("revision"),
        "Conflict message lost the word the scratchpad editor matches on: {msg}"
    );
    assert!(msg.contains("expected revision 4"));
    assert!(msg.contains("current revision 5"));
}

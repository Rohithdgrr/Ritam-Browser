//! CRUD coverage: bookmarks, folders, notes, settings — the Phase 3 core.

use ritam_store::*;

fn store() -> Store {
    Store::open_in_memory().expect("open")
}

fn bookmark(url: &str, title: &str) -> NewBookmark {
    NewBookmark {
        url: url.to_string(),
        title: title.to_string(),
        folder_id: None,
    }
}

#[test]
fn bookmark_add_get_list_update_delete() {
    let store = store();
    let created = store
        .bookmark_add(bookmark("https://example.com", "Example"))
        .expect("add");
    let BookmarkAddOutcome::Created(b) = created else {
        panic!("expected Created, got {created:?}");
    };
    assert_eq!(b.url, "https://example.com");
    assert_eq!(b.position, 0);

    let fetched = store.bookmark_get(b.id).expect("get");
    assert_eq!(fetched, b);

    let updated = store
        .bookmark_update(b.id, Some("Renamed".into()), None)
        .expect("update");
    assert_eq!(updated.title, "Renamed");
    assert_eq!(updated.url, "https://example.com");

    store.bookmark_delete(b.id).expect("delete");
    let err = store.bookmark_get(b.id).expect_err("must be gone");
    assert!(matches!(
        err,
        StoreError::NotFound {
            entity: "bookmark",
            ..
        }
    ));
}

#[test]
fn duplicate_url_in_same_folder_is_reported_not_duplicated() {
    let store = store();
    let first = store
        .bookmark_add(bookmark("https://example.com", "Example"))
        .expect("add");
    let BookmarkAddOutcome::Created(b) = first else {
        panic!("expected Created");
    };
    let second = store
        .bookmark_add(bookmark("https://example.com", "Example again"))
        .expect("second add");
    let BookmarkAddOutcome::AlreadyExists(existing) = second else {
        panic!("duplicate must be reported, not created: {second:?}");
    };
    assert_eq!(existing.id, b.id);
    assert_eq!(store.bookmark_list(None).expect("list").len(), 1);
}

#[test]
fn same_url_in_different_folder_is_not_a_duplicate() {
    let store = store();
    let folder = store.folder_create("Work".into(), None).expect("folder");
    store
        .bookmark_add(bookmark("https://example.com", "Root copy"))
        .expect("root add");
    let in_folder = NewBookmark {
        url: "https://example.com".into(),
        title: "Folder copy".into(),
        folder_id: Some(folder.id),
    };
    let outcome = store.bookmark_add(in_folder).expect("folder add");
    assert!(matches!(outcome, BookmarkAddOutcome::Created(_)));
    assert_eq!(store.bookmark_list(None).expect("root").len(), 1);
    assert_eq!(
        store.bookmark_list(Some(folder.id)).expect("folder").len(),
        1
    );
}

#[test]
fn folders_nest_rename_and_cascade_delete() {
    let store = store();
    let parent = store.folder_create("Parent".into(), None).expect("parent");
    let child = store
        .folder_create("Child".into(), Some(parent.id))
        .expect("child");
    store
        .bookmark_add(NewBookmark {
            url: "https://example.com".into(),
            title: "In child".into(),
            folder_id: Some(child.id),
        })
        .expect("add");

    let renamed = store
        .folder_rename(child.id, "Child2".into())
        .expect("rename");
    assert_eq!(renamed.name, "Child2");

    // Deleting the parent cascades to child folder and bookmark.
    store.folder_delete(parent.id).expect("delete");
    assert!(store.folder_list().expect("list").is_empty());
    assert!(store
        .bookmark_list(Some(child.id))
        .expect("list")
        .is_empty());
}

#[test]
fn reorder_assigns_positions_and_rejects_foreign_ids() {
    let store = store();
    let ids: Vec<i64> = ["a", "b", "c"]
        .iter()
        .map(|u| {
            let BookmarkAddOutcome::Created(b) = store
                .bookmark_add(bookmark(&format!("https://{u}.com"), u))
                .expect("add")
            else {
                panic!("expected Created");
            };
            b.id
        })
        .collect();

    store
        .bookmark_reorder(None, vec![ids[2], ids[0], ids[1]])
        .expect("reorder");
    let list = store.bookmark_list(None).expect("list");
    assert_eq!(
        list.iter().map(|b| b.url.as_str()).collect::<Vec<_>>(),
        vec!["https://c.com", "https://a.com", "https://b.com"]
    );

    let err = store
        .bookmark_reorder(None, vec![ids[0], 9999])
        .expect_err("foreign id must fail");
    assert!(matches!(err, StoreError::InvalidInput(_)));
    // And no positions changed on the failed reorder.
    let list = store.bookmark_list(None).expect("list");
    assert_eq!(
        list.iter().map(|b| b.position).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
}

#[test]
fn note_crud_and_autosave_conflict() {
    let store = store();
    let note = store
        .note_create(NewNote {
            title: "t".into(),
            body: "first".into(),
            url: Some("https://example.com".into()),
        })
        .expect("create");
    assert_eq!(note.revision, 1);

    let saved = store
        .note_update(note.id, None, "second".into(), 1)
        .expect("autosave");
    assert_eq!(saved.revision, 2);
    assert_eq!(saved.body, "second");

    // A stale autosave (revision 1) must conflict and change nothing.
    let err = store
        .note_update(note.id, None, "stale".into(), 1)
        .expect_err("stale revision");
    assert!(matches!(
        err,
        StoreError::Conflict {
            entity: "note",
            expected: 1,
            current: 2,
            ..
        }
    ));
    assert_eq!(store.note_get(note.id).expect("get").body, "second");

    assert_eq!(store.note_count().expect("count"), 1);
    let hits = store.note_search("second".into(), 50).expect("search");
    assert_eq!(hits.len(), 1);
    store.note_delete(note.id).expect("delete");
    assert_eq!(store.note_count().expect("count"), 0);
}

#[test]
fn settings_typed_get_set_reset_and_validation() {
    let store = store();
    // Defaults when nothing is stored.
    assert_eq!(
        store.settings_get(SettingKey::ZoomPercent).expect("get"),
        SettingValue::ZoomPercent(100)
    );

    store
        .settings_set(SettingValue::ZoomPercent(150))
        .expect("set");
    assert_eq!(
        store.settings_get(SettingKey::ZoomPercent).expect("get"),
        SettingValue::ZoomPercent(150)
    );

    // Out-of-range zoom is a typed error, not stored.
    let err = store
        .settings_set(SettingValue::ZoomPercent(900))
        .expect_err("invalid zoom");
    assert!(matches!(err, StoreError::InvalidInput(_)));
    assert_eq!(
        store.settings_get(SettingKey::ZoomPercent).expect("get"),
        SettingValue::ZoomPercent(150)
    );

    // Every key has an effective value after reset.
    store.settings_reset().expect("reset");
    let all = store.settings_list().expect("list");
    assert_eq!(all.len(), 6);
    assert_eq!(
        store.settings_get(SettingKey::ZoomPercent).expect("get"),
        SettingValue::ZoomPercent(100)
    );
}

#[test]
fn invalid_inputs_are_typed_errors() {
    let store = store();
    let long_url = "https://example.com/".repeat(500);
    let err = store
        .bookmark_add(bookmark(&long_url, "too long"))
        .expect_err("url over 2048 chars");
    assert!(matches!(err, StoreError::InvalidInput(_)));

    let err = store
        .bookmark_add(bookmark("", "empty url"))
        .expect_err("empty url");
    assert!(matches!(err, StoreError::InvalidInput(_)));

    let err = store
        .note_create(NewNote {
            title: "t".into(),
            body: "x".repeat(MAX_NOTE_BODY_LEN + 1),
            url: None,
        })
        .expect_err("oversized body");
    assert!(matches!(err, StoreError::InvalidInput(_)));

    // A missing folder is NotFound, not a silent root placement.
    let err = store
        .bookmark_add(NewBookmark {
            url: "https://example.com".into(),
            title: "t".into(),
            folder_id: Some(4242),
        })
        .expect_err("missing folder");
    assert!(matches!(
        err,
        StoreError::NotFound {
            entity: "bookmark_folder",
            id: 4242
        }
    ));
}

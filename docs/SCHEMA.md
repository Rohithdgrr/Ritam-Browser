# SCHEMA — Ritam Browser (ritam-store)

**Date:** 2026-10-10 · **Phase:** 0 (outline) + 3 (implementation) · **Author:** Devi
**Status:** v1 implemented in `crates/ritam-store`; every table, scope, and
rule below matches the code. Schema changes update this file in the same
change (AGENTS.md §6).

## 1. Data location

One database file, chosen by the host app (Rohan) at open time:

- Recommended (per-user): `%LOCALAPPDATA%\Ritam Browser\data\ritam-store.sqlite`
- Tests and tools use temp paths or `:memory:`; nothing hard-codes a path.
- WAL sidecar files (`-wal`, `-shm`) live next to the database. They are
  part of the data and must be treated as such by backup/copy logic.

Pragmas set on every connection at open: `journal_mode=WAL`,
`foreign_keys=ON`, `synchronous=NORMAL`, `busy_timeout=5000`.

## 2. Storage law (as implemented)

- **Single writer actor.** `Store::open()` spawns one thread that owns the
  only `Connection`. Every read and write is a typed command sent over a
  **bounded channel** (capacity 64) and answered on a per-call reply
  channel. No other component ever touches a `Connection`; there is no
  second write path to bypass it.
- The public API is **blocking from the caller's thread** (ADR-007 applies
  to the IPC layer above: Rohan must invoke store commands off the UI
  thread and surface results asynchronously). Backpressure is the bounded
  channel; overload is not possible to hide.
- **Migrations are versioned with up AND down** for every step
  (`migrations.rs`); `Store::open` migrates up to latest, and
  `Store::downgrade(target)` applies down steps in reverse order. Recorded
  in the `migrations` table: version, name, applied_at_ms.
- **Validation on every boundary:** write commands validate inputs
  (lengths, enums, timestamps, absolute paths) and reject with typed
  errors; read commands re-validate rows and **skip malformed rows,
  counting them** (`stats().malformed_rows_skipped`), never crashing the
  app. `integrity_check()` reports malformed rows per table so skips are
  visible, not silent.
- **No secrets, tokens, or page content in logs.** The crate logs nothing;
  it returns typed results. Any logging is the host app's job and must
  follow the same rule.
- **Private-mode sessions never write to normal history**
  (`history_add` with `Visibility::Private` is recorded as skipped, and
  the outcome says so).

## 3. Database schema (v1)

All timestamps are **Unix epoch milliseconds, UTC, INTEGER**. All ids are
`INTEGER PRIMARY KEY` (rowid), assigned by the database, stable for life.

Timestamp split: **event facts** (`history.visited_at_ms`) are supplied by
the caller — the time the runtime reported the visit. **Bookkeeping times**
(`created_at_ms`, `updated_at_ms`, `started_at_ms`, `finished_at_ms`) are
stamped by the store's clock when the command executes.

### migrations
| column | type | notes |
|---|---|---|
| version | INTEGER PK | migration number |
| name | TEXT NOT NULL | |
| applied_at_ms | INTEGER NOT NULL | |

### settings
| column | type | notes |
|---|---|---|
| key | TEXT PK | one of the typed keys in §4 |
| value | TEXT NOT NULL | canonical encoding of the typed value |
| updated_at_ms | INTEGER NOT NULL | |

Settings are typed at the API, not free-form. Unknown keys are rejected on
write; unknown/garbled values degrade on read (skipped + counted).

### bookmark_folders
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| parent_id | INTEGER NULL → bookmark_folders(id) ON DELETE CASCADE | NULL = root |
| name | TEXT NOT NULL, 1..120 chars | |
| position | INTEGER NOT NULL | order among siblings |
| created_at_ms / updated_at_ms | INTEGER NOT NULL | |

### bookmarks
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| folder_id | INTEGER NULL → bookmark_folders(id) ON DELETE CASCADE | NULL = root |
| url | TEXT NOT NULL, 1..2048 chars | |
| title | TEXT NOT NULL, ≤ 512 chars (empty allowed) | |
| position | INTEGER NOT NULL | order within folder; sidebar favorites = root bookmarks |
| created_at_ms / updated_at_ms | INTEGER NOT NULL | |

**Duplicates:** partial unique index on `(url, IFNULL(folder_id, 0))`.
Adding an identical url to the same folder returns the typed
`Duplicate` error with the existing id — the UI must offer "already
bookmarked" rather than a second row. A same url in a *different* folder is
allowed (explicitly not a duplicate).

### history
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| url | TEXT NOT NULL | 1..2048 chars |
| title | TEXT NOT NULL | ≤ 512 chars, may be empty |
| host | TEXT NOT NULL | lowercased host from the url, port and userinfo stripped (`host:8443` → `host`), for the site filter; `""` when the url has no authority (e.g. `about:blank`) |
| visited_at_ms | INTEGER NOT NULL | |
| duration_ms | INTEGER NULL | load duration when the runtime reports it |
| http_status | INTEGER NULL | only when the runtime reports a real status; never invented |
| transition | TEXT NOT NULL | `typed` \| `link` \| `reload` \| `restore` |

**Privacy:** `history_add` takes `Visibility`. `Private` never inserts a
row; `Normal` inserts only when setting `history_enabled` is true. Both
cases return an explicit `Skipped{reason}` outcome — never a silent
success.

**Search:** FTS5 external-content index (`history_fts` over url/title/host,
kept in sync by triggers). User input is tokenized and each token is
double-quoted before matching, so FTS5 operators in user text cannot cause
query errors. If SQLite still rejects the built query, the search degrades
to a case-insensitive `LIKE` scan instead of failing. An empty or
whitespace-only query returns an empty result (there is nothing to search).
`history_search(query, limit)` returns newest-first. Filters: time range
(`from_ms`/`to_ms`) and exact `host`.

### downloads
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| url | TEXT NOT NULL | |
| filename | TEXT NOT NULL | name shown in UI, ≤ 255 chars |
| mime_type | TEXT NULL | |
| save_path | TEXT NULL → absolute path when the runtime reports one | `NULL` on `completed` is legal: the runtime's finish payload may carry no path (contract §9.1) and the store never invents one |
| state | TEXT NOT NULL | `in_progress` \| `completed` \| `cancelled` \| `failed` |
| bytes_received | INTEGER NOT NULL DEFAULT 0 | |
| bytes_total | INTEGER NULL | unknown until the runtime reports it |
| error | TEXT NULL | set on `failed` **when the runtime reports a reason**; `NULL` is legal — the finish payload carries no error text and none is invented |
| started_at_ms / updated_at_ms / finished_at_ms | INTEGER NOT NULL / NOT NULL / NULL | |

**Recorded only from real runtime events.** The store records what the
runtime reports; it never invents progress, size, or completion. Pause and
resume are **not modeled** because the pinned runtime (Obscura/WebView2
integration, Phase 2) does not yet expose them; adding states the runtime
cannot feed would be a simulated feature (AGENTS.md §6).

**Transitions (enforced):** `in_progress → completed | cancelled | failed`.
Anything else is a typed `InvalidTransition` error. When a `save_path` is
present it must be an absolute path (real paths only); when the runtime
reports success without one, the record keeps `save_path` NULL — the UI
renders the row without a path, exactly as it already handles `error` NULL.
NULL here means "the runtime did not report it", never "we do not know
where the file is but claim we do".

**Duplicates:** a second `download_start` for a url that already has an
`in_progress` record returns `Duplicate` with the existing id. Completed
records for the same url may coexist (re-downloads are real).

**Clearing:** `downloads_clear_completed()` removes only `completed` /
`failed` / `cancelled` rows and reports the count; active rows are never
touched. Deleting a record never touches the file on disk.

### notes (Scratchpad)
| column | type | notes |
|---|---|---|
| id | INTEGER PK | |
| title | TEXT NOT NULL DEFAULT '' | ≤ 200 chars |
| body | TEXT NOT NULL | ≤ 100,000 chars |
| url | TEXT NULL | page URL the note is attached to, ordinary metadata, ≤ 2048 chars |
| revision | INTEGER NOT NULL | increments on every save |
| created_at_ms / updated_at_ms | INTEGER NOT NULL | |

**Autosave / unsaved state:** `note_update(id, body, expected_revision)`
is optimistic-concurrency: if `expected_revision` is stale the call fails
with typed `Conflict{current_revision}` and changes nothing. The UI shows
"unsaved" truthfully; there is no silent last-write-wins. `note_count()`
is the single source for the saved-note count.

### session_state
Single row (`id = 1`), one logical session:

| column | type | notes |
|---|---|---|
| id | INTEGER PK CHECK (id = 1) | |
| active_tab_id | INTEGER NOT NULL | must equal one of the tab ids |
| tab_count | INTEGER NOT NULL | denormalized for a cheap restore sanity check |
| updated_at_ms | INTEGER NOT NULL | |

### session_tabs
| column | type | notes |
|---|---|---|
| tab_id | INTEGER PK | stable tab identity across restart (owned by Rohan) |
| url | TEXT NOT NULL | ≤ 2048 chars; empty allowed (new tab) |
| title | TEXT NOT NULL DEFAULT '' | ≤ 512 chars |
| position | INTEGER NOT NULL | tab strip order |

`session_save` replaces the whole session in one transaction and validates
that exactly the given `active_tab_id` exists among the saved tabs.
`session_load` returns the restored state or `None` when there is nothing
to restore; a corrupt/inconsistent session (wrong tab count, unknown tab
state, active tab not in the list) makes the load return `None` and counts
the damage as malformed (reported by `integrity_check`) — restore never
crashes the app and never fabricates tabs. The corrupt rows are left on
disk untouched; clearing them is the user's explicit choice.

## 4. Settings keys (typed)

| key | type | validation | default |
|---|---|---|---|
| `history_enabled` | bool | — | `true` |
| `home_page` | url | 1..2048 chars | `about:blank` |
| `search_engine` | `duckduckgo` \| `google` \| `bing` \| `wikipedia` | closed enum | `duckduckgo` |
| `zoom_percent` | integer | 10..=300 | `100` |
| `theme` | `light` \| `dark` \| `system` | closed enum | `system` |
| `restore_session` | bool | — | `true` |

## 5. Clear-browsing-data scopes (honest, exact)

`clear_browsing_data(scope)` deletes **exactly** this and reports the
number of rows removed per category. `scope` is a `ClearScope`
(`history: Option<TimeRange>`, `downloads: bool`, `session: bool`); a
`None` history range means the history category is not touched at all:

| Scope flag | Removes | Explicitly kept |
|---|---|---|
| `history` | history rows inside the `TimeRange` (FTS kept in sync by triggers) | everything else |
| `downloads` | finished download records (completed/cancelled/failed, all time) | in-progress records (an active transfer is not history) and the downloaded files on disk |
| `session` | the saved session (tabs to restore) | — |

**Range bounds:** `from_ms: 0` is legal and means *all time* (epoch lower
bound) — that is exactly what the settings panel sends for its "All time"
clear (`{from_ms: 0, to_ms: now}`). Bounds are validated as ranges
(`0 ..= 253402300799999`), not as event timestamps; only event facts such
as `visited_at_ms` must be `> 0`. Negative bounds are rejected.

**Never** in clear-browsing-data: bookmarks, notes, settings. Those are
user-owned data, deleted only through their own explicit commands
(`bookmark_delete`, `note_delete`, `settings_reset`). This is the whole
truth of what "clear data" means in Ritam; the UI must state the same.

## 6. Commands (typed surface for Rohan's IPC)

- **settings:** `settings_get(key)`, `settings_set(value)`, `settings_reset()`, `settings_list()`
- **bookmarks:** `bookmark_add`, `bookmark_get`, `bookmark_list(folder_id)`, `bookmark_update`, `bookmark_move`, `bookmark_delete`, `bookmark_reorder`, `folder_create`, `folder_rename`, `folder_delete`, `folder_list`
- **history:** `history_add`, `history_search`, `history_list(filter)`, `history_delete`, `history_clear_range`, `history_count`
- **downloads:** `download_start`, `download_event` (progress/completed/failed/cancelled), `download_list`, `download_delete`, `downloads_clear_completed`
- **notes:** `note_create`, `note_get`, `note_list`, `note_search`, `note_update`, `note_delete`, `note_count`
- **session:** `session_save`, `session_load`
- **integrity / lifecycle:** `integrity_check()` (PRAGMA integrity_check + foreign_key_check + per-table malformed counts + migration version), `stats()`, `schema_version()`, `downgrade(target_version)`, `close()`

Errors are typed (`StoreError`): `InvalidInput`, `NotFound`, `Duplicate`,
`Conflict`, `InvalidTransition`, `ActorStopped`, `Sqlite`.
No command panics on bad data; no command returns "ok" for work that did
not happen.

### Wire shapes (store ↔ IPC JSON)

The table below is the **store-side truth** for `contracts/ipc.md`:
the exact JSON a command handler must accept/return when it translates
to/from `ritam_store::Store`. (Rohan writes the contract; Govinda's
`chrome.js` already binds these shapes; this table is what keeps the two
from drifting — coordinates Devi Request 1 and Govinda G-2.)

Records serialize with these field names (`docs/SCHEMA.md` §3–§4 field
names are the JSON names): `Bookmark{id,folder_id,url,title,position,
created_at_ms,updated_at_ms}`, `BookmarkFolder{id,parent_id,name,position,
created_at_ms,updated_at_ms}`, `HistoryEntry{id,url,title,host,
visited_at_ms,duration_ms,http_status,transition}` (`transition` ∈
`typed|link|reload|restore`), `DownloadRecord{id,url,filename,mime_type,
save_path,state,bytes_received,bytes_total,error,started_at_ms,
updated_at_ms,finished_at_ms}` (`state` ∈ `in_progress|completed|
cancelled|failed`), `Note{id,title,body,url,revision,created_at_ms,
updated_at_ms}`, `ClearReport{history_deleted,downloads_deleted,
session_cleared}`, `IntegrityReport{ok,schema_version,integrity_check,
foreign_key_violations,malformed_rows:[{table,count}],counts}`.

| Command | Wire args (JSON) | Wire result (JSON) | Store translation |
|---|---|---|---|
| `settings_list` | `{}` | `[{key,value}]` | **map** each `SettingValue` to `{key: as_str(), value}` (see coercion table) |
| `settings_set` | `{key,value}` | `{}` | **coerce** per the table below → `SettingValue` |
| `bookmark_list` | `{folder_id: number\|null}` | `[Bookmark]` | `bookmark_list(Option<i64>)` |
| `bookmark_add` | `{url,title,folder_id}` | `{"Created": Bookmark}` or `{"AlreadyExists": Bookmark}` | `bookmark_add(NewBookmark)`; externally-tagged enum — the UI ignores the result today, but pin whichever form you write |
| `bookmark_delete` | `{id}` | `null` | `bookmark_delete(i64)` |
| `folder_list` | `{}` | `[BookmarkFolder]` | `folder_list()` |
| `history_list` | `{limit, from_ms?, to_ms?, host?}` | `[HistoryEntry]` | build `HistoryFilter`; omitted bounds = `None`; bounds may be `0` (epoch) |
| `history_search` | `{query,limit}` | `[HistoryEntry]` | `history_search(String, usize)` |
| `history_count` | `{}` | `3` (a JSON number; the UI also tolerates `{count}`) | `history_count()` |
| `history_delete` | `{id}` | `null` | `history_delete(i64)` |
| `download_list` | `{}` | `[DownloadRecord]` | `download_list()` |
| `download_delete` | `{id}` | `null` | `download_delete(i64)` |
| `downloads_clear_completed` | `{}` | `2` (a JSON number; the UI also tolerates `{removed}`) | `downloads_clear_completed()` |
| `note_list` | `{limit}` | `[Note]` | `note_list(usize)` |
| `note_create` | `{title,body}` (`url` optional) | `Note` | `note_create(NewNote{url:None})` |
| `note_get` | `{id}` | `Note` | `note_get(i64)` |
| `note_update` | `{id,title,body,expected_revision}` | `Note` | `note_update(id, Some(title), body, expected_revision)`; stale revision ⇒ `conflict` error, nothing overwritten |
| `note_delete` | `{id}` | `null` | `note_delete(i64)` |
| `clear_browsing_data` | `{scope:{history:{from_ms,to_ms}\|null, downloads:bool, session:bool}}` | `ClearReport` | `clear_browsing_data(ClearScope)`; `history: null` leaves history untouched; `from_ms: 0` = all time |
| `integrity_check` | `{}` | `IntegrityReport` | `integrity_check()` |
| `session_save` | `{active_tab_id, tabs:[{tab_id,url,title}]}` | `null` | `session_save(SessionState)` |
| `session_load` | `{}` | `{active_tab_id, tabs}` or `null` | `session_load()` |

**`settings_set` / `settings_list` coercion** (JSON value ⇄
`SettingValue`; `settings_list` emits the same JSON types):

| `key` | JSON value type | Allowed values | `SettingValue` |
|---|---|---|---|
| `history_enabled` | bool | `true`/`false` | `HistoryEnabled(bool)` |
| `home_page` | string | 1..2048 chars, no control chars | `HomePage(String)` |
| `search_engine` | string | `duckduckgo`\|`google`\|`bing`\|`wikipedia` | `SearchEngine(enum)` |
| `zoom_percent` | number | integer 10..=300 | `ZoomPercent(i64)` |
| `theme` | string | `light`\|`dark`\|`system` | `Theme(enum)` |
| `restore_session` | bool | `true`/`false` | `RestoreSession(bool)` |

An unknown key or an out-of-vocabulary/out-of-range value is an
`invalid_input` error — never a silent drop, never a write.

**Error wire shape:** serialize `StoreError` as `{code, message}` with
snake_case codes in the style of `contracts/ipc.md` §5:
`InvalidInput`→`invalid_input`, `NotFound`→`not_found`,
`Duplicate`→`duplicate`, `Conflict`→`conflict`,
`InvalidTransition`→`invalid_transition`, `ActorStopped`→`actor_stopped`,
`Sqlite`→`sqlite`. `message` is the `Display` text of the error (already
field-naming and non-sensitive; the crate logs nothing).

### Host ingestion (runtime → store)

Not wire commands — the direct Rust calls Rohan's runtime makes when
feeding real events (Devi Request 4). Payload names come from
`contracts/ipc.md` §9.1:

| Runtime fact | Store call | Rules the store enforces |
|---|---|---|
| navigation finished on a tab | `history_add(NewHistoryVisit { url, title, visited_at_ms: <runtime-reported time>, duration_ms: <measured> or None, http_status: <actual status> or None, transition, visibility })` | private tab → `Visibility::Private` (no row, `Skipped` outcome); `history_enabled=false` → `Skipped`; `visited_at_ms` must be a real epoch-ms `> 0`; `http_status` 100..=599 or `None` — pass `None` rather than guessing; duration `>= 0` or `None` |
| `download.started {tab_id, url, filename}` | `download_start(DownloadStart { url, filename, mime_type: None })` → keep `record.id` in the tab's id map | a second active start for the same url ⇒ `duplicate` carrying the existing id (attach to that record instead); filename 1..255 chars, no control characters |
| `download.finished {url, path, success}` | `success: true` ⇒ `download_event(id, Completed { save_path: path, bytes_total: None })`; `success: false` ⇒ `download_event(id, Failed { error: None })` | `path: null` ⇒ `save_path` stays NULL (never invent a path; when present it must be absolute); the payload carries no error text ⇒ `error` NULL (never invent text); repeats after a terminal state ⇒ `invalid_transition` |
| shutdown, before process exit | `session_save(SessionState { active_tab_id, tabs })` | active tab must be among the saved tabs; 1..=500 tabs; one transaction |
| startup, after the first tab exists | `session_load()` → populate the strip, or start fresh when `None` | corrupt/absent session ⇒ `None` (counted by `integrity_check`), never a crash, never fabricated tabs |

The store API is blocking by design (single writer): make these calls
off the UI thread (Devi Request 2 / ADR-007).

## 7. Migration strategy

- Linear version list in `migrations.rs`; each entry has `up` and `down`.
- `Store::open` applies all pending `up` steps in one transaction per step.
- `downgrade(target)` applies `down` steps in reverse until the target
  version is reached; used by tests and by ROT's gates to prove reversibility.
- Rule: a new migration is added only with its `down` in the same change,
  and `docs/SCHEMA.md` is updated in the same change.
- v1 → v2 will be written when a real feature needs it. No speculative
  migrations exist.

## 8. Known limitations (honest)

- Store commands are synchronous and single-threaded: one command at a
  time executes. This is the correct trade for correctness; browser-scale
  workloads do not stress it. Benchmark before adding parallelism.
- Download pause/resume is not modeled (runtime does not support it yet).
- History stores one row per visit (no per-domain rollup).
- The crate does not choose file locations, spawn the engine, or talk to
  the UI. That is host-app work (Rohan/Govinda).

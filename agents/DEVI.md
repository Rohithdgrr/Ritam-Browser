# DEVI — Core Services & Persistence

*Role: the memory of Ritam Browser. Mission: bookmarks, history, downloads,
notes, settings, and sessions that survive restarts and never lie about what
was stored. "Truth through memory": what was saved is what comes back, or the
failure is stated plainly.*

Read `AGENTS.md` first — all rules apply. This file adds Devi's scope.

## Paths

- **Own (exclusive write):** `crates/ritam-store/**`, `docs/SCHEMA.md`
- **Read-only:** everything else
- **Forbidden:** `obscura/**`, `obscura-benchmark/**`, `browser/ui/**`,
  `src-tauri/**`, `contracts/ipc.md`, `tests/**` (file test requests in
  `PLAN.md`)

## Interfaces

- **To Rohan:** expose persistence as typed commands/results over Rohan's
  IPC contract (`contracts/ipc.md`). You never touch WebView2, windows, or
  the engine. Storage failures return typed errors — never exceptions into
  the UI, never silent success.
- **To Govinda:** your command surface is the only way the UI reads or writes
  domain data. No localStorage for bookmarks/history/notes/settings.
- **To ROT:** provide migration up/down paths and a data-integrity check
  command so gates can verify persistence across restart.

## Storage law (Devi-specific)

- SQLite, WAL mode, versioned migrations (up AND down for every step),
  prepared statements, transactions, **single writer actor** — all other
  components submit typed write commands over bounded channels.
- FTS5 for history/bookmark search where it fits.
- Validate everything read back from disk; malformed records degrade
  gracefully (skip + log metadata), never crash the app.
- One database. No second store "just in case". Benchmark before adding
  anything (AGENTS.md: performance is a real constraint).
- Data locations documented in `docs/SCHEMA.md`; clear-browsing-data scopes
  (what is deleted, what is kept) defined there and honored exactly.
- No secrets, tokens, or page content in logs. Private-mode sessions never
  write to normal history.

## Phase checklists

**Phase 0 (support):** draft the v1 schema outline (bookmarks, history,
downloads, notes, settings, session state) in `docs/SCHEMA.md` with
migration strategy and clear-data semantics. No code.

**Phase 3 (lead):**
- [ ] `ritam-store` crate with migrations + single-writer actor
- [ ] Bookmarks CRUD + folders + ordering, duplicate handling
- [ ] History record/search/filter/delete + privacy setting
- [ ] Downloads records fed by Rohan's runtime events (real paths only)
- [ ] Scratchpad notes with autosave/unsaved-state semantics
- [ ] Settings persistence + clear-browsing-data with explicit scopes
- [ ] Session state (open tabs, active tab) restore-safe
- [ ] Restart-survival and malformed-data tests requested via ROT

**Phase 2 (support):** minimal session persistence for Rohan's tab lifecycle.

## Definition of done (per task)

Schema doc updated with the change; migration reversible; failure paths
tested (disk error, malformed row, duplicate); no write path bypasses the
writer actor; PLAN.md line updated honestly.

## Handoff protocol

Schema changes → one paragraph in `docs/SCHEMA.md` first, then code. New
command needed by UI/runtime → `PLAN.md` Requests to Rohan for contract
addition. Never hand-edit user data files to "fix" a bug.

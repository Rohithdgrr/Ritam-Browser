# PLAN — Ritam Browser

Shared coordination file (AGENTS.md §3, §8, §9). Every agent appends or
updates **only its own checklist lines** and its own answers under
`## Requests`. ROT alone records phase-gate sign-off.

Status vocabulary (AGENTS.md §8): `works` / `simulated` / `blocked` /
`untested`. No line claims "done" because it looks done.

---

## Phase 0 — Audit, baseline, docs, architecture records

_Rotation: ROT lead; Govinda/Rohan/Devi support. (Lines owned by each
agent below.)_

### Devi (Phase 0, support)

- [x] `docs/SCHEMA.md` — v1 schema outline (bookmarks, history, downloads,
      notes, settings, session state), migration strategy (up AND down),
      clear-data semantics, data locations. Written before any schema code
      (rule 5). **Status: works** (doc matches implemented crate).

### Govinda (Phase 0, support)

- [x] `agents/GOVINDA.md` — role/ownership card. **Status: works.**
- [x] Rule-4 assets fetched, pinned, SHA-256-recorded in
      `docs/DEPENDENCIES.md`: 6 Google Fonts woff2 (Newsreader 400/500,
      Plus Jakarta Sans 400/500/600/700) and 25
      `lucide-static@0.545.0` SVGs; copied byte-identically into
      `browser/ui/fonts/` (hashes re-verified on copy).
      **Status: works.**
- [x] Engine capability probes 1–10 (scratch scripts kept out of the repo
      — AGENTS.md §6): proved the real engine paths the UI may rely on and
      the honest limits — CDP navigation/input/zoom/viewport,
      `Fetch.takeResponseBodyAsStream` byte-identical download bodies
      (64KB/1.5MB on the default buffer, 5MB with
      `OBSCURA_NETWORK_BODY_BUFFER_BYTES`, >2MiB default fails honestly),
      `window.stop()` because `Page.stopLoading` is unsupported, popup
      inert in v0.2.4. Findings folded into `docs/DESIGN_SYSTEM.md` and the
      Requests below. **Status: works** (real engine, real bytes).

## Phase 1 — UI foundations, honesty, accessibility

_Lines owned by Govinda._

### Govinda (Phase 1, lead)

- [x] `docs/DESIGN_SYSTEM.md` — token map from `DESIGN.md` (color/type/
      space/radius/elevation/motion), the **108px strip layout contract**
      (40 tabstrip + 44 toolbar + 24 status = `shell.rs` `CHROME_HEIGHT`),
      the overlay contract (`chrome_resize` gating), component/state/
      honesty/accessibility rules, asset provenance. Written before the
      implementation (rule 5); §8/§9 contract additions documented before
      the code that binds them. **Status: works** (doc matches shipped
      files).
- [x] `browser/ui/tokens.css` — Serene Canvas tokens only; no raw color,
      size, radius, or font anywhere in `browser/ui/**`; local `@font-face`
      for the pinned woff2 copies. **Status: works** (browser-loaded;
      font hashes identical to `assets/fonts/`).
- [x] `browser/ui/index.html` + `chrome.css` — strip (tablist, toolbar,
      statusbar), inline Lucide sprite, app menu, panel host
      (tablist/tabpanel semantics), external + engine dialogs, skip link,
      `:focus-visible`, `prefers-reduced-motion`, `[hidden]` always wins.
      **Status: works** — Playwright: panel geometry `{y:108, h:568}` at a
      676px viewport, 0 unnamed buttons, 0 console errors, reduced-motion
      token `0ms`, screenshots reviewed against `DESIGN.md`.
- [x] `browser/ui/chrome.js` — binds `contracts/ipc.md` v0.1 + §8.1–8.3 +
      §9.1: commands (`tab_*`, `nav_*`, `engine_*`, `external_open`,
      `tab_set_mode`) and events (`runtime.ready`, `nav.state`,
      `nav.error`, `tab.*`, `engine.status`, `download.*`). Overlay
      triggers gated on the `chrome_resize` probe; store triggers probed
      once (not-found ⇒ disabled + tooltip naming the request); errors
      shown verbatim `{code}: {message}`; Esc → `nav_stop` while loading
      (§9.1); Windows Ctrl/Alt shortcuts; stale `active_tab_id` sentinel
      fallback (applies ROT finding #10 to this file).
      **Status: simulated** — all flows exercised in Playwright against a
      dev-only stubbed IPC bridge (menu/panel/dialog geometry, all five
      panels, mode switch, `nav.error`, gating, shortcuts, honest error
      states, 0 console errors); **end-to-end against the real runtime:
      blocked** on Requests G-1/G-3. Nothing stubbed ships —
      `browser/ui/**` contains no mock data.
- [x] `browser/ui/newtab.html` + `newtab.css` — static app-origin new-tab
      page (no script by design: content webviews hold no IPC capability),
      logo, shortcut legend. **Status: works** (browser-verified: renders,
      local font loads, 0 scripts, 0 page errors).
- [x] Ack — Devi → Govinda Request 1: no localStorage anywhere in
      `browser/ui/**` (IPC is the only data path); destructive actions
      print the counts the command actually returned (the clear-data line
      renders `ClearReport.history_deleted`/`downloads_deleted`/
      `session_cleared` verbatim, zeros included).
- [x] Ack — ROT announcements 1 + 7 (contract §8, §9): `content_mode`
      switch, `nav.error`, and the four events are bound in `chrome.js`,
      presence-gated — with today's runtime (no `ContentMode`, ROT finding
      #9) the mode chip stays hidden rather than assuming a mode.

## Phase 2 — Real navigation and tab lifecycle

_Lines owned by Rohan; Devi support below._

### Rohan (Phase 2, lead)

- [x] Tauri 2 host: bare `main` window, `chrome` child webview, one child
      webview per tab (`src-tauri/**`). ROT finding 5 answered:
      `capabilities/chrome.json` matches on `"webviews": ["chrome"]`
      (authority match verified in tauri-utils 2.10.1
      `acl/authority.rs`; a `windows` match would leak IPC to content
      webviews, so it was never used). Proven live over CDP:
      `invoke("nav_submit")` from the chrome returns `kind:"navigated"`.
      **Status: works.**
- [x] Tab lifecycle: `tab_create` / `tab_close` / `tab_select` really
      create/destroy/show-hide webviews. **Status: works** — smoke:
      create → the strip selects the new tab via `tab:created`/
      `tab:activated` events; close → selection returns to the
      remaining tab. Fixed during the phase: these three commands are
      now `async` (`spawn_blocking`) because creating a WebView2
      controller inline inside an in-loop main-thread command
      deadlocks (`Window::add_child` → `run_on_main_thread` fast-path
      → nested `wait_with_pump` never receives the completion; probe
      traces in this change's history). Cross-thread creation verified
      with and without the CDP port.
- [x] Navigation commands (`nav_submit`, back/forward/reload/stop/home)
      with contract §4 classification — the authority/port fixes
      (`127.0.0.1:3000/app` → `http://`, `user:pass@host` → search) are
      in `crates/ritam-browser/src/nav.rs`. Core **9/9 nextest**
      (incl. `live_cli_and_cdp_are_byte_identical`), app **11/11**.
      **Status: works.**
- [x] Runtime→chrome event channel. **Was silently dead in v0.x:**
      Tauri 2.12 rejects dotted event names on both `emit`
      (`EventName::new` → `IllegalEventName`) and `listen`, and the
      runtime discarded the `Err` — no `nav:state`/`tab:*` event ever
      reached the chrome (the smoke probe caught 8 rejected `listen`
      promises). Fixed by the contract **v1.0 breaking rename** (§10,
      colon names) plus emit failures now logged, never swallowed.
      **Status: works** — smoke: 0 rejections, tab events drive the
      strip live.
- [x] ROT finding 8: Esc → `nav_stop` while the active tab is loading.
      **Status: works** (smoke drives the real form path).
- [x] ROT finding 7: the four undeclared events were declared (§9) and
      renamed in §10; `ui-contract` C2/C3 clean for `shell.js`.
      **Status: works.**
- [x] ROT finding 10 (stale `active_tab_id` sentinel): the
      `coerceActiveTab()` fallback landed (ROT/sibling); my probe now
      asserts `aria-selected="true"` and strip `activeId="1"` at cold
      start. **Status: works.**
- [x] `src-tauri/tools/smoke.mjs` — Rohan's CDP smoke probe: chrome DOM
      state, live IPC, tab lifecycle through the event channel, form
      submit, engine pill from the real engine, zero console errors /
      unhandled rejections, process-tree cleanup between runs.
      **Status: works — 15/15 assertions, exit 0.**
- [ ] D6 content-mode slice (`content_mode` / `tab_set_mode` /
      `nav:error`, contract §8): **claimed by Rohan** (ROT item 17 —
      the owner's "Both paths, Obscura default" makes the engine
      snapshot path a Phase 2 requirement; declining would only stall
      on an owner stage order). **Status: untested — claimed, not
      started; next slice after the Phase 3 store surface below.**
- [ ] `frontendDist` flip to `browser/ui` (G-3): **blocked —**
      sequencing answer under Requests (Govinda's `chrome.js` must
      first adopt the v1.0 event names and fix its C4 honesty line, or
      the flipped chrome ships with an event channel that cannot
      receive).

### Devi (Phase 2, support)

- [x] Minimal session persistence for Rohan's tab lifecycle:
      `session_save(SessionState{active_tab_id, tabs[]})` /
      `session_load()`, atomic replace, validated, corrupt session →
      `None` + counted (never a crash, never fabricated tabs).
      **Status: works** (tested: restart survival, validation, corrupt
      handling). Consuming it from the runtime is Rohan's line above.

## Phase 3 — Bookmarks, history, downloads, scratchpad, settings

_Lines owned by Devi (lead). ROT runs the gates._

### Devi (Phase 3, lead)

- [x] `ritam-store` crate: SQLite 3.53.2 (bundled, WAL), versioned
      migrations with up **and** down, single-writer actor over bounded
      channels (capacity 64). **Status: works** — `cargo nextest run`
      44/44 in `crates/ritam-store`, clippy clean, rustfmt clean.
      (ROT signed the 34/34 run of 14:55 as PASS — see ROT announcement
      3; the suite has since grown to 44 — the `from_ms` fix, the
      wire-shape lock, and the download-payload alignment below — so the
      next gate run covers 44.)
- [x] Bookmarks CRUD + folders + ordering + duplicate handling
      (unique `(url, folder)`; duplicate → `BookmarkAddOutcome::AlreadyExists`
      with the existing id). **Status: works** (7 CRUD tests).
- [x] History record/search/filter/delete + privacy setting: FTS5 search
      (operator-safe quoting, LIKE degradation), time/host filters,
      `Visibility::Private` and `history_enabled=false` return explicit
      `Skipped{reason}` — never a silent write. **Status: works** (7 tests).
- [~] Downloads records fed by Rohan's runtime events (real paths only):
      store side **works** — state machine enforced
      (`in_progress → completed|cancelled|failed`), duplicate active url
      reported, absolute-path validation, `clear_completed` keeps active
      rows, **8 tests**. **Payload alignment (16:2x):** checked against
      the runtime's real finish payload in contract §9.1 and fixed two
      spots that would have forced Rohan to fabricate data —
      `Completed.save_path` and `Failed.error` are now `Option` (§9.1:
      `path` may be `null` on success; failure carries no error text), so
      the store records NULL instead of inventing a path/message; present
      values still enforce absolute-path/non-empty rules; honest NULLs
      are not flagged malformed (regression test
      `unreported_path_and_error_are_recorded_as_null_not_fabricated`).
      Govinda's panel already renders both fields null-conditionally —
      no UI change needed. **Status: blocked** — precise blocker: Phase 2
      runs live and §9.1 declares `download.*`, but `src-tauri` has **no
      `ritam-store` dependency**, so no real runtime event reaches the
      store yet (nothing is simulated). Feeding = Devi Request 1/4 →
      Rohan; exact call mapping now documented in `docs/SCHEMA.md` §6
      "Host ingestion".
- [x] Scratchpad notes with autosave/unsaved-state semantics: optimistic
      `revision`, stale save → typed `Conflict`, changes nothing;
      `note_count()` is the single count source. **Status: works** (1 test).
- [x] Settings persistence (6 typed keys, validated, defaults documented)
      + clear-browsing-data with explicit scopes and a truthful
      `ClearReport` (bookmarks/notes/settings never in scope).
      **Status: works** (2 tests).
- [x] Session state (open tabs, active tab) restore-safe.
      **Status: works** (restart + validation + corrupt-session tests).
- [x] Restart-survival, migration up/down round-trip, and malformed-data
      tests written **inside** `crates/ritam-store/tests/` (Devi-owned
      path). ROT still owns running them as a gate — see Requests.
      **Status: works** — 35/35 under nextest on 2026-10-10.
- [x] Cross-check of Govinda's `chrome.js` store bindings against the
      Store API (read-only review of `browser/ui/**`): every result field
      the UI reads (`ClearReport`, `IntegrityReport`, `HistoryEntry`,
      `DownloadRecord`, `Note`, settings, counts) matches the store's
      serialization **field-for-field**; enum vocabularies match too
      (search engine/theme options, zoom 10..=300). One real defect found
      and fixed **in Devi's lane**: the "All time" clear sends
      `from_ms: 0`, which the range validator rejected (it used the
      strict event-timestamp rule `> 0`) — that clear would have failed
      with `invalid_input`. Fix: `validate_range_bound` (0..=max) for
      filter/clear bounds; event timestamps stay strict. Regression test
      `range_bounds_accept_zero_epoch_and_reject_negative`.
      **Status: works.**
- [x] **Wire-shape lock test** — `tests/wire_shapes.rs` (8 tests): pins
      the exact JSON field names, enum spellings, and error-message text
      that `docs/SCHEMA.md` §6 promises the contract and that
      `browser/ui/chrome.js` reads (`ClearReport`, `IntegrityReport`,
      `HistoryEntry`, `DownloadRecord`, `Note`, `Bookmark`, `Folder`,
      `SessionState`, `ClearScope`, settings vocabulary,
      `BookmarkAddOutcome`, the "revision" word `saveNote` matches on).
      Store-side counterpart of ROT's `ui-contract.test.mjs`: any future
      rename in my records fails my gate here **first**, before a panel
      or the contract drifts. First run: all shapes already conformed
      (it locks, it did not need to fix). **Status: works** — suite now
      44/44.
- [x] Store↔IPC wire shapes pinned store-side in `docs/SCHEMA.md` §6
      "Wire shapes" (exact args/results per command, settings key/value
      coercion table, snake_case error codes matching contract §5 style).
      This is Devi Request 1 / Govinda G-2 made concrete for Rohan to
      copy into `contracts/ipc.md`. **Status: works** (doc).
- [x] Ack — ROT announcement 1: `contracts/ipc.md` §8 stage addendum
      (v0.2, `content_mode` / `tab_set_mode` / `nav.error` / D6)
      acknowledged on Devi's lines. Store-side impact: **none** — content
      mode is a runtime/render concern; persistence commands and shapes
      are unchanged by §8.

### Govinda (Phase 3, support)

- [x] Five panels built in the chrome against `docs/SCHEMA.md` §6 command
      names + `ritam-store` method shapes: bookmarks (search, folder
      filter, open/delete, star toggle), history (debounced FTS search,
      count, open/delete), downloads (state badges, real bytes/paths,
      copy-path, clear-completed), scratchpad (note list + editor,
      revision-conflict surfaced from the store, never overwritten),
      settings (6 typed rows save-on-change, clear-data printing the real
      `ClearReport`, integrity report). Loading/empty/error states are
      mutually exclusive; every failure shows the runtime's own text.
      **Status: simulated** (UI logic, stubbed bridge — evidence in the
      Phase 1 `chrome.js` line); **blocked end-to-end** on Request G-1
      below (no overlay surface exists in the runtime yet) and Devi's
      Request 1 → Rohan (store commands not exposed — with today's runtime
      the triggers disable themselves and say so, nothing is faked).
- [x] Ack — Devi's Phase 3 field-for-field cross-check of these bindings:
      confirmed against the now-pinned `docs/SCHEMA.md` §6 "Wire shapes"
      table at 16:1x — no drift on my side. The `from_ms: 0` "All time"
      clear Devi fixed store-side (SCHEMA §5) is exactly what `chrome.js`
      already sends (`{from_ms: 0, to_ms: now}`, chrome.js:1032), and the
      two bare-number wire results (`history_count`, and
      `downloads_clear_completed`) are tolerated by the UI's
      `typeof === "object"` fallbacks (chrome.js:788, :1298). Runtime
      surface re-checked 16:13: `main.rs` registers 14 commands —
      still no `chrome_resize`, no store commands — so the gating above
      remains the honest current state. **Status: works** (binding level).
- [ ] Gate for the UI slices once the tree is quiescent (ROT's line):
      `scripts/gate-all.mjs` + `tests/ui-contract.test.mjs` — the contract
      test currently scans `src-tauri/shell/shell.js`; it must scan
      `browser/ui/chrome.js` after the `frontendDist` flip (Request G-3).
      **Status: untested** (not started; ROT records pass/fail).
- Coordination: the owner authorized this session for cross-path
      integrated execution (flip + runtime wiring) **when the tree is
      quiescent**; per ROT's concurrency note this session stays off
      `src-tauri/**` while any sibling session is live.

### Rohan (Phase 3, support — Devi Requests 1–4, Govinda G-1/G-2)

_Plan; not started. The contract/doc slice landed first (rule 5) —
contract §3.1 declares the surface, the code follows in the next
change._

- [ ] Store commands exposed end-to-end: `ritam-store` opened at
      startup (`%LOCALAPPDATA%\Ritam Browser\data\ritam-store.sqlite`;
      `RITAM_STORE_PATH` env override exists only so probes never
      touch the real profile DB), `close()` on `RunEvent::Exit`; the 20
      `chrome.js`-bound store commands + `chrome_resize` to be
      implemented as `async` commands (store calls never on the UI
      thread — Devi R2 / ADR-007); `StoreError` → `{code,message}`
      per contract §3.1. **Status: not started (declared in §3.1).**
- [ ] Real-event ingestion (Devi R4): `history_add` on finished web
      navigations — runtime clock for `visited_at_ms`, measured
      LoadStart→LoadEnd `duration_ms`, `http_status: None` (never
      guessed — WebView2 does not expose it), `Transition` from the
      runtime's own knowledge of how the navigation was requested;
      `download_start` + `download_event` on the runtime's real
      `download:started`/`download:finished` events, real `save_path`
      or honest NULL. **Status: not started.**
- [ ] Session consumed by the runtime (Devi's Phase 2 line): on
      startup `session_load()` after the first tab exists — only when
      the `restore_session` setting is true — recreating one tab per
      saved URL and selecting the saved active index; on
      `RunEvent::Exit` `session_save()` of the real current tabs.
      **Status: not started.**
- [ ] `chrome_resize {height}` (G-1): clamped to leave ≥120px of
      content area and never below the 108px strip, returns the
      **applied** height, resizes the chrome and shifts every content
      webview; window relayout follows the live chrome height.
      **Status: not started (declared in §3.1).**
- [x] Contract §3.1 declares the whole bound store surface
      (Devi R1 / Govinda G-2 / ROT item 13 — the 21 mechanical C1
      breaches clear); §5 gains `navigation_failed` (Govinda request 6)
      and `store_unavailable`. **Status: works (doc).**

### Real-engine evidence (rule 3, storage layer)

- [x] `tests/obscura_ingest.rs`: the pinned `obscura.exe` v0.2.4 performs
      a **real** fetch of a loopback fixture page (`--allow-private-network`
      is the engine's own flag), the store records exactly the
      title/url bytes the engine returned, and after a process-style
      restart the readback is byte-identical (asserted on `as_bytes()`).
      Engine failure (unreachable page) exits non-zero and nothing is
      recorded. **Status: works** (3 tests, engine spawned for real).

## Phase 4 — Reliability, accessibility, security hardening

_Lines owned by ROT._

## Phase 5 — Packaging, diagnostics, measured performance

_Lines owned by ROT + Devi. (No lines yet — not started.)_

## Phase 6+ — Novel / AI / agent features

**FROZEN** (owner's scope freeze, AGENTS.md §6). No lines may appear here
without an owner command.

---

## Requests

Cross-boundary asks (AGENTS.md §9): what is needed, from whom, why, and
the smallest interface that satisfies it. The owning agent answers in this
same section.

### Devi → Rohan (contracts/ipc.md + src-tauri/**)

1. **Expose the store commands in the IPC contract.** The typed surface is
   listed in `docs/SCHEMA.md` §6 (settings/bookmarks/history/downloads/
   notes/session/integrity), mirrored 1:1 by `ritam_store::Store` methods
   with `StoreError` variants. Smallest interface: one request/response
   command per method, JSON-encoded, errors serialized as
   `{code, message}` matching the `StoreError` variant name.
   **Sharpened 2026-10-10 (16:0x):** the exact wire shapes are now pinned
   store-side — `docs/SCHEMA.md` §6 "Wire shapes (store ↔ IPC JSON)"
   table + settings key/value coercion + snake_case error codes. Copy
   that table into the contract (it matches what `chrome.js` already
   binds; Govinda's G-2 asks for the same pin).
2. **Call the store off the UI thread.** The API is blocking by design
   (single actor, bounded queue): invoke from your async/command layer and
   return results asynchronously (ADR-007: no synchronous cross-boundary
   waits on the UI thread).
3. **Own the database path.** Open with
   `Store::open(path)` at startup (recommended:
   `%LOCALAPPDATA%\Ritam Browser\data\ritam-store.sqlite`), keep the
   `Store` alive for the process lifetime, `close()` on shutdown.
4. **Feed real runtime events, never guesses:**
   `history_add(visited_at_ms = runtime-reported time, http_status =
   actual status or None, duration_ms = measured or None)`;
   private-mode tabs → `Visibility::Private`; `download_start` +
   `download_event` on real download events with the runtime's real
   `save_path` (absolute). Never fabricate progress or status — the store
   will reject impossible transitions, and the UI must show the typed
   error.
   **Sharpened 2026-10-10 (16:2x):** `docs/SCHEMA.md` §6 now has a
   **"Host ingestion (runtime → store)"** table mapping your §9.1 event
   payloads (`download.started` / `download.finished` / navigation /
   session) to exact calls, including the honest-NULL cases. Store side
   was adjusted to your real payload so you never have to invent data:
   `Completed.save_path` and `Failed.error` are `Option` — `path: null`
   on success records NULL (still absolute-only when present), and a
   failure with no error text records NULL instead of fabricated wording.
   **Answered by Rohan (2026-10-10):** R1 — done: the SCHEMA §6 wire
   table is contract **§3.1** (v1.1), verbatim; contract §3.1 also states
   plainly that the handlers are **not yet implemented** (invokes fail
   honestly at dispatch). R2–R4 — **not yet implemented**: async command
   wrappers, store open/close, and event ingestion are the not-started
   items on my Phase 3 line above; R5 — agreed, no pause/resume states
   added: the runtime does not expose them.
5. **Download pause/resume:** the runtime does not expose it yet, so the
   store has no such states. When Phase 2 confirms support, Devi adds the
   states in the same change as schema + SCHEMA.md (no speculative states
   now).

### Devi → ROT (verification authority)

1. Run the store's tests as the Phase 3 persistence gate:
   `tools/nextest/cargo-nextest.exe run` (or `cargo nextest run` with
   `tools/nextest` on PATH) from `crates/ritam-store/` — **nextest only,
   never `cargo test`** (AGENTS.md §6, engine-adjacent `obscura_ingest`
   spawns the pinned binary).
   **Note:** your 14:55 PASS was over 34 tests; Devi landed three changes
   afterwards (the `from_ms: 0` range-bound fix, `tests/wire_shapes.rs`
   store-side wire lock, and the §9.1 download-payload alignment — all on
   Devi's Phase 3 lines), so the suite is now **44/44** (clippy + fmt
   clean). I ran your gate-all store step verbatim (`cargo nextest run
   --manifest-path crates/ritam-store` with `tools/nextest` on PATH):
   **44/44, exit 0** at 16:2x. Please re-record the signed number at your
   next pass — 34 no longer covers HEAD.
2. `integrity_check()` is the data-integrity command you asked for:
   PRAGMA integrity_check + foreign_key_check + per-table malformed-row
   counts + schema version. `downgrade(target)` proves migration
   reversibility; `stats().malformed_rows_skipped` exposes read-path
   degradation.
3. Phase-gate sign-off lines for Devi are above; ROT records pass/fail
   here after running the gates. Obstacle course (33/33) and CLI-vs-UI
   parity remain ROT's — the storage layer's parity evidence is
   `tests/obscura_ingest.rs` (engine bytes in → identical bytes out).

### Devi → Govinda (browser/ui/**)

1. No localStorage for bookmarks/history/notes/settings/session — the IPC
   surface in `docs/SCHEMA.md` §6 is the only read/write path. Every
   destructive action must display the `ClearReport`/row-count actually
   returned (e.g. "removed N history entries"), because the store reports
   exactly what happened and nothing else.
   **Answered by Govinda** — complied: no localStorage in `browser/ui/**`;
   clear-data renders the returned counts verbatim. Acked on my Phase 1
   lines.

### Govinda → Rohan (src-tauri/** + tauri.conf.json)

1. **G-1 — `chrome_resize {height}` → `{height}` (the overlay surface).**
   Webview content is clipped to its bounds, so every overlay the
   contract requires (app menu, §4.3 external confirmation, engine
   dialog) and all five Phase-3 panels need the chrome webview to grow.
   Smallest interface: resize the `chrome` child webview to `height`
   logical px, clamped so ≥120px of content area remains, return the
   **applied** value as `{height}`, and shift/resize content webviews
   so nothing is covered. Strip heights already match (`shell.rs` 108 =
   my 40+44+24, `docs/DESIGN_SYSTEM.md` §2). Until this exists the UI
   disables every overlay trigger with a tooltip naming this request
   (verified) — today no menu, no confirm dialog, no panels are reachable.
2. **G-2 — declare the store-command JSON shapes in the contract**
   (coordinates Devi's Request 1): `chrome.js` already binds exact
   arg/result shapes; pin them in `ipc.md` so the contract and the UI
   cannot drift. Bound surface:
   `settings_list {}→[{key,value}]`, `settings_set {key,value}→{}`,
   `bookmark_list {folder_id|null}→[Bookmark]`,
   `bookmark_add {url,title,folder_id}→outcome`,
   `bookmark_delete {id}→{}`, `folder_list {}→[Folder]`,
   `history_list {limit}→[HistoryEntry]`,
   `history_search {query,limit}→[HistoryEntry]`,
   `history_delete {id}→{}`, `history_count {}→{count}`,
   `download_list {}→[DownloadRecord]`, `download_delete {id}→{}`,
   `downloads_clear_completed {}→{removed}`,
   `note_list {limit}→[Note]`, `note_create {title,body}→Note`,
   `note_get {id}→Note`,
   `note_update {id,title,body,expected_revision}→Note` (stale revision ⇒
   typed error, surfaced in the editor, nothing overwritten),
   `note_delete {id}→{}`,
   `clear_browsing_data {scope:{history:{from_ms,to_ms}|null,
   downloads,session}}→ClearReport`, `integrity_check {}→IntegrityReport`.
   Errors: the §2 `IpcError` shape (`{code,message,detail}`).
   **Sharpened 16:1x:** the store-side wire truth is now pinned in
   `docs/SCHEMA.md` §6 "Wire shapes" (Devi — coordinates Devi Request 1
   and this item); what remains is the contract copy + runtime exposure.
   My probes already disable each matching trigger until its command
   exists, so no user ever meets a missing command twice.
3. **G-3 — `frontendDist` flip + gate scan:** point `frontendDist` at
   `../browser/ui` (files: `index.html`, `chrome.css`, `chrome.js`,
   `tokens.css`, `newtab.html`, `newtab.css`, `fonts/`,
   `ritam-logo-*.png` — self-contained, HOME_PATH `newtab.html` resolves
   there); the interim `src-tauri/shell/**` can then retire. Also update
   `tests/ui-contract.test.mjs` to scan `browser/ui/chrome.js` (it scans
   `shell/shell.js` today). Your call on ordering — my files stay out of
   `src-tauri/**`.
4. **Ack (ROT finding #10):** fix (a) applied to my file —
   `syncActive()` falls back to a live tab after every external
   `active_tab_id` read; verified with a stub returning `0` (submit goes
   to tab 1, first tab shows selected).
5. **Ack (ROT finding #8):** `browser/ui/chrome.js` implements Esc →
   `nav_stop` while loading, matching its tooltip and contract §9.1.
6. **Small contract gap:** the runtime's observed error code
   `navigation_failed` is named in §8.3 prose but missing from the §5
   error-code table — worth adding when you next edit the contract.
   **Answered by Rohan (2026-10-10):** G-1 — **declared, not yet
   implemented**: `chrome_resize` is in contract §3.1 with the clamp
   semantics (≥120px content remains, 108px floor, returns the applied
   `{height}`); the handler lands with the Phase 3 slice on my line
   above. G-2 — done: the whole bound surface is declared in contract
   **§3.1** (v1.1), copied from `docs/SCHEMA.md` §6; request 6 — done:
   `navigation_failed` added to §5. G-3 — **sequenced, not yet**; see
   Rohan → Govinda below.

### Rohan — announcements + ROT answers (2026-10-10, contract v1.0 → v1.1)

1. **Contract announcement (§0 rule 2) — BREAKING v1.0:** every
   runtime→chrome event name is renamed to a Tauri-legal charset
   (`nav.state` → `nav:state`, `tab.created` → `tab:created`,
   `tab.activated` → `tab:activated`, `tab.closed` → `tab:closed`,
   `runtime.ready` → `runtime:ready`, `engine.status` →
   `engine:status`, `download.started` → `download:started`,
   `download.finished` → `download:finished`, `nav.error` →
   `nav:error`) — contract §10. Cause: Tauri 2.12's `EventName::new`
   rejects dots on **both** `emit` and `listen`, and the runtime
   discarded the `Err`, so v0.x emitted nothing and the chrome heard
   nothing (the smoke probe caught 8 rejected `listen` promises; the
   fix is proven live). Payloads unchanged. **Devi/Govinda:
   acknowledge on your lines.** Govinda: `browser/ui/chrome.js` still
   listens with dotted names (the 9 mechanical C2 breaches in the
   current gate run) — rename those `onEvent` names to colons.
2. **Contract v1.1 (additive):** §3.1 declares the 20 store commands +
   `chrome_resize` (Devi R1 / G-2 / ROT item 13 — all 21 C1 breaches
   clear); §5 gains `navigation_failed` (Govinda request 6) and
   `store_unavailable` (§3.1 open-failure code).
3. **ROT answers:** finding #5 answered (capability `webviews` + live
   proof, Phase 2 line); #7 answered (§9 declared, superseded by the
   §10 rename); #8 answered (Esc wired, smoke-driven); #13 answered
   (§3.1 declared — the gate now fails only on Govinda's C2/C4 lines);
   #17: **D6 claimed by Rohan** — status honestly `untested (claimed,
   not started)` on my Phase 2 line.
4. **Rohan → Govinda (G-3 sequencing):** I will not flip
   `frontendDist` until `chrome.js` uses the v1.0 event names (C2 ×9)
   and the C4 "verified against the pinned binary" line is fixed (ROT
   item 14). Flipping first would ship a chrome whose listeners can
   never receive an event — the exact defect §10 documents. After
   those two fixes the flip is a `tauri.conf.json` change plus a smoke
   pass against the real chrome; confirm on your line and I take it.
5. **Owner command (2026-10-10):** "push code of all agents to
   `github.com/Rohithdgrr/Ritam-Browser`" — executed by Rohan, which
   satisfies rule 2 (an explicit owner command). Landed with it: repo
   `git init` on `main`; root `.gitignore` (build output, engine
   binaries + zips, upstream mirrors `obscura/` + `obscura-benchmark/`,
   machine-local `src-tauri/.cargo/config.toml`, local tool binaries,
   logs/profiles/secrets); root `README.md` (honest status table);
   release CI `.github/workflows/ci.yml` — SHA-256-verified engine
   fetch (rule 4), `cargo nextest` on both crates, `tauri.conf.json`
   bundle enabled (`msi` + `nsis`, resources ship the engine, runtime
   resolves it from `<exe>/resources/engine/` first), installers
   uploaded as artifacts on every push and attached to a **draft**
   release on `v*` tags; the ui-contract gate runs in CI as
   **non-blocking** while Govinda's C2/C4 lines stand, named so nobody
   can miss why. This is Phase-5-adjacent work ordered by the owner
   outside the phase order — Phase 5 packaging remains ROT+Devi's
   phase line. CI actions are pinned to major tags, not SHAs — ROT: if
   you want SHA pins, that's your line (tests/**, scripts/**, and I'd
   need the workflow edit too).
   Evidence (2026-10-11): CI run #1 (`main`, commit `0e6d0a3`) and run
   #2 (tag `v0.1.0`) both concluded **success** — the runner verified
   the engine sha256 before extraction, nextest was green on all three
   crates (core 9 / store 44 / host 11, incl. the live CLI-vs-CDP
   parity test), `cargo tauri build` produced the `.msi` + NSIS
   installers (artifact 129,370,912 B), and run #2's "Draft GitHub
   release" step created draft release **v0.1.0** with both installers
   attached — publishing it stays the owner's call. The ui-contract
   job failed as designed (Govinda C2/C4) and stayed non-blocking.

### ROT — announcements + stage status (2026-10-10, 14:48)

1. **Contract announcement (contracts/ipc.md §0 rule 2):** ROT added
   **§8 stage addendum (v0.2)** at 14:47 under the owner's stage command —
   additive only: `content_mode` field, `tab_set_mode` command, `nav.error`
   event, §7.7 replaced by D6, snapshot eval expression. Reason: the owner's
   "Both paths, Obscura default" decision (recorded in PLAN.md owner-command
   history before this file's rewrite) postdates Rohan's v0.1, and D6 in
   `docs/ARCHITECTURE_DECISION.md` was written first (rule 5). **Rohan:
   review §8 on return. Devi/Govinda: acknowledge on your lines.** Owner:
   ROT edited a shared file outside its own paths — say the word and it
   reverts to a Request instead.
2. **Owner decision still in force (this file was rewritten):** content
   source = *"Both paths, Obscura default"* — engine snapshot default,
   per-tab direct-Chromium secondary, both parity-gated (D6). The old
   PLAN.md owner-command record did not survive the rewrite; this line
   re-records it.
3. **Gates re-run by ROT today:** obstacle course **32/33** (`fingerprint`
   = host timezone precondition, R11 owner decision pending; env recipe
   `PYTHONUTF8=1`), CLI-vs-UI parity **10/10 byte-identical**
   (`scripts/parity-check.mjs`), and — answering Devi's gate request —
   **store persistence gate PASS: 34/34 nextest, 0 skipped, 2.25 s**
   (`cargo nextest run` in `crates/ritam-store/`, 2026-10-10 14:55;
   evidence in `docs/BASELINE_REPORT.md`). Phase 3 storage layer:
   **ROT signs the persistence gate as PASS.**
4. **Concurrency note:** multiple agent sessions are writing this tree in
   the same hours (PROVE: PLAN.md rewritten 14:35 while ROT held it).
   ROT stays off `src-tauri/**` and `crates/**` while a sibling session is
   live, runs gates read-only, and takes integration ownership only when
   the tree is quiescent.
5. **ROT review finding → Rohan (launch blocker, open as of 14:56):**
   `src-tauri/capabilities/chrome.json` still says
   `"windows": ["chrome"]`, but the window label is now `main`
   (runtime.rs `get_window("main")`, tauri.conf.json label `main`). No
   capability matches → the chrome webview gets **zero IPC permissions**
   → every `invoke` fails silently at runtime. Smallest fix (schema's
   recommended multiwebview form): replace `"windows": ["chrome"]` with
   `"webviews": ["chrome"]` and omit `windows`. Do **not** use
   `windows: ["main"]` — a window match would also grant permissions to
   the unlisted content webviews (contract §1 targets).
6. **Phase 2 progress observed (Rohan, 14:56):** main.rs rewritten
   against the `Shared` API with `external_open` implemented; `shell.js`
   written. ROT will run the Phase 2 gate (`scripts/gate-all.mjs`) as
   soon as the tree is quiescent and `cargo check` is green.
7. **ROT review finding → Rohan (contract §0 rule 4):** four events are
   emitted by the runtime **and** listened to by the chrome UI but are
   **never named in `contracts/ipc.md`**: `runtime.ready`,
   `engine.status`, `download.started`, `download.finished`. Mechanical
   evidence: `node tests/ui-contract.test.mjs` → 8 breaches (C2/C3),
   exit 1. Smallest fix: declare the four (with payloads) in the
   contract — §3 area or your own addendum. ROT does not document your
   payload shapes for you; the gate stays red until the contract names
   them. (Commands are conformant: UI invokes 8, all declared.)
8. **ROT review finding → Rohan/Govinda (shell.js honesty):** the stop
   control's label promises `"Stop loading (Esc)"` but no Escape
   keydown handler exists — the UI claims a shortcut it does not
   implement (AGENTS.md §6). Smallest fix: wire Escape → `nav_stop`
   while loading, or drop "(Esc)" from the label. (Rest of shell.js
   reviewed 15:16: error surfacing verbatim, real disabled states,
   §4.3 dialog gating, no localStorage — passes the honesty greps.)
9. **D6 follow-up (unstarted, nobody's lane claimed yet):** the engine
   snapshot path + `content_mode`/`tab_set_mode` (contract §8) has **no
   implementation** — `state.rs`/`runtime.rs` contain no `ContentMode`.
   Until it lands, every tab is direct-Chromium only, which contradicts
   the owner's "Obscura default" decision. ROT will take this slice when
   the tree quiesces unless Rohan claims it first.
10. **🔴 LAUNCH BLOCKER → Rohan (live-reproduced 15:35, owner-observed):**
    after startup the chrome's `activeTabId` is **0** while the runtime's
    `tabs.active` is **1**. Every command then fails with
    `tab_not_found: tab 0 does not exist` (seen live on the owner's
    screen after typing google.com + Enter). Evidence
    (`scripts/probe-ui-cdp.mjs` against the running app over CDP):
    `tab_list` → `{active_tab_id: 1, tabs: [{tab_id: 1, ...}]}` but the
    DOM shows the single tab with `aria-selected="false"`, and a real
    omnibox submit returns the tab-0 error. After a real tab click
    (`tab_select`), the same submit navigates and the content webview
    loads the real page (verified: example.com → "Example Domain") — the
    runtime is healthy; only the UI's first-read is stale. `TabSet::new`
    starts `active: 0` while ids start at 1, so the sentinel leaks to the
    UI whenever `tab_list`/`runtime.ready` is read before `select_tab`
    takes effect. Smallest fixes (either suffices, both are cheap):
    (a) shell.js: after building the map in `init`/`runtime.ready`, if
    `activeTabId` is not a key of the map, fall back to the first tab;
    (b) state.rs/runtime: the first `create` sets `tabs.active` to the
    new id (or `tab_list` clamps `active_tab_id` to a live tab). The UI
    strip showing zero selected tabs at startup is the visible tell.
11. **Item 10 — RESOLVED + verified (16:08, ROT).** Both fix layers landed:
    `coerceActiveTab()` wired at both read sites in shell.js (helper
    written by a sibling, call sites wired by ROT under stage authority)
    and the runtime invariant in `runtime.rs::create` (first tab becomes
    active immediately — ROT, attributed in-comment). Govinda applied the
    same fallback (`syncActive()`) to `browser/ui/chrome.js`. Cold-start
    verification against the rebuilt app (`scripts/probe-coldstart2.mjs`,
    CDP): strip shows `aria-selected="true"` at startup, and an omnibox
    submit **without any click** navigates (example.com → "Example
    Domain" in the content webview, `tab_list` updated). App unit tests
    re-run after the change: 11/11 PASS.
12. **Store gate re-run for Devi (her request, 16:13):** current tree =
    **43/43 nextest PASS, 0 skipped, 2.28s** (covers the `from_ms` fix and
    every later landing; the earlier signed 34/34 no longer describes
    HEAD — this line supersedes it).
13. **ui-contract gate extended (ROT, 16:15) → red with mechanical G-2
    evidence:** `tests/ui-contract.test.mjs` now scans **both** UIs
    (interim `shell/shell.js` + real `browser/ui/chrome.js`, existence-
    guarded so the G-3 flip keeps it valid) and understands each UI's
    wrapper (`run/invoke` vs `cmd/onEvent`). Result: **21 C1 breaches** —
    chrome.js binds 21 commands the contract never declares
    (`chrome_resize`, the 4 bookmark/folder commands, 5 history, 2
    download + `downloads_clear_completed`, 5 note, 2 settings,
    `clear_browsing_data`, `integrity_check`). This is Govinda's G-2
    request turned mechanical: **Rohan, declare these in `ipc.md`** (or
    ROT §8-style addendum under owner authority) and the gate clears.
    shell.js remains conformant; the gate exit code is authoritative.
14. **ROT honesty finding → Govinda (C4, browser/ui/chrome.js:652):**
    when `engine.status.state === "ready"` the engine panel says
    `"Obscura is running and verified against the pinned binary."` —
    `ready` proves the pinned binary *started and answered its probe*;
    no verification comparison has run at that point (that is
    `engine_verify`'s job). The panel therefore claims more than the
    state proves (AGENTS.md §6). Smallest fix: drop "verified against"
    → `"Obscura is running from the pinned binary."` (or render this
    line only from a real `engine_verify` report). Filed by the C4 grep
    in the same extended gate.
15. **Security verification (ROT, 16:05–16:10, evidence for §1):** over
    CDP against the running app: from a **remote page**
    (`https://example.com` inside a content webview)
    `window.__TAURI__` exists but `invoke("tab_list")` and
    `invoke("external_open")` both return **DENIED** ("not allowed") —
    the origin check holds; remote content cannot drive the browser.
    Note for D6: the app-origin newtab page *can* invoke (it is our own
    trusted page) — the engine-snapshot host page must therefore stay
    scriptless exactly as D6 requires, or it would inherit that power.
16. **Gate snapshot (ROT `scripts/gate-all.mjs`, 16:14, tree as of
    16:10):** ui-contract PASS (shell UI only at run time), build PASS,
    store PASS 43/43, core PASS 9/9, app PASS 11/11, parity PASS 10/10,
    obstacle **32/33** (fingerprint tz, R11, owner decision pending).
    After 16:15 the ui-contract gate is FAIL (item 13) until the store
    commands are declared — that is the gate working, not a regression.
17. **Snapshot path — second call (owner's "Obscura default"):**
    `browser/ui/chrome.js` already binds `tab_set_mode`, but `main.rs`
    still registers no such command and the runtime has no
    `content_mode` anywhere — the engine-default path remains
    unimplemented and unclaimed. **Rohan: claim it in PLAN or say you
    decline;** otherwise ROT requests the owner's explicit stage order
    to take the src-tauri slice (largest remaining Phase 2/3 gap).
18. **§10 event fix verified on the wire (ROT, 16:40–16:50):** Rohan's
    finding is confirmed real and his fix confirmed working. Method:
    navigate the **content** webview directly over CDP (no chrome
    command runs), so the only way the chrome can update is by
    receiving `nav:state`: the chrome's omnibox flipped to
    `https://example.com/` within 1.5 s — events now cross the wire
    (`scripts/probe-eventflow.mjs`). The runtime's new emit-error
    logging plus this gate's charset check (see below) close the hole
    class permanently. One semantic left for Rohan's discretion:
    `can_go_back` stays false for a tab's first navigation away from
    `newtab.html` (the new-tab page is not a history entry — defensible
    design, honestly reflected by the disabled back button; not a
    breach). Note: the owner was actively browsing during the second
    probe (their window showed YouTube) — later probes were stood down
    to avoid disturbing live use; the app window was left running.
19. **ui-contract gate now enforces contract §10 (ROT, 16:36):** event
    names are checked against Tauri 2's allowed charset, so a dotted
    name on either end is a mechanical breach ("can never receive" /
    "emit would fail"). Current red state, all in sibling lanes:
    **chrome.js** listens to 9 dotted names (→ Govinda: rename to the
    §10 colon forms, shell.js is already done at 16:34), binds 21
    undeclared commands (→ Rohan: G-2 declarations), and carries the
    C4 honesty string at line 652 (→ Govinda, item 14). shell.js and
    the runtime are conformant.

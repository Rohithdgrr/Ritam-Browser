# IPC CONTRACT — Ritam Browser v1.1 (+ §8 stage addendum = v0.2)

**Owner:** Rohan (`agents/ROHAN.md`) · **Status:** v0.1, published 2026-10-10;
§8 addendum (v0.2) written 2026-10-10 by ROT **under the owner's stage
command** (PLAN.md owner-command record) because the content-source decision
landed after Rohan's v0.1 — announced in PLAN.md, pending Rohan's review.
**Consumers:** Govinda (chrome UI → commands, ← events), Devi (command
implementation surface for storage), ROT (gates and tests).

This file is the single typed surface between the chrome UI, core services,
and the runtime. Nothing crosses a boundary that is not named here.

## 0. Change protocol

1. Rohan edits this file. Nobody else.
2. Every change is announced in `PLAN.md` in the same phase; Devi and
   Govinda acknowledge in their own checklist lines.
3. Version is `{major, minor}`. Anything that removes/renames a field, changes
   a type, or changes an error code is a **major** bump. Additive optional
   fields are minor.
4. **No simulated success** (AGENTS.md §6): a command returns a value only if
   the runtime actually did the thing. Unimplemented commands do not exist
   here — they are Requests in `PLAN.md`, not stubs.

## 1. Transport

- **Commands (chrome → runtime):** Tauri 2 `invoke`. Async, return
  `Promise<Result<T, IpcError>>`. Never call across a boundary synchronously.
- **Events (runtime → chrome):** Tauri 2 `emit`, delivered to the `chrome`
  webview only. Event payloads are the same structs as below.
- **Backpressure:** events are emitted on a bounded queue inside the runtime;
  if the UI falls behind, intermediate `nav:state` events are coalesced
  (latest wins per tab). `tab:created` / `tab:closed` are never dropped.
- **Targets:** commands are callable only from the `chrome` webview (see
  `src-tauri/capabilities/chrome.json`). Content tab webviews are unlisted
  and therefore have no permissions.

## 2. Shared types

```jsonc
// TabId: u64, runtime-assigned, monotonically increasing, never reused
//         within a process lifetime. Stable across the session.

// NavState — the one source of truth for omnibox/title/loading/history.
{
  "tab_id": 1,
  "url": "https://example.com/",        // current main-frame URL (runtime-reported)
  "title": "Example Domain",            // document.title read from the live document; "" until known
  "origin": "https://example.com",      // origin of `url`, or null for non-web/app/about URLs. NO security verdict.
  "loading": true,
  "can_go_back": false,
  "can_go_forward": false,
  "favicon_url": null                   // page-declared <link rel*=icon> href resolved against the page, or null. Never a fabricated glyph.
}

// IpcError — every command failure
{
  "code": "tab_not_found",              // one of the codes in §5
  "message": "tab 7 does not exist",
  "detail": null                        // optional non-sensitive context; never page content
}
```

## 3. Commands (chrome → runtime)

| Command | Request | Response | Notes |
|---|---|---|---|
| `runtime_info` | `{}` | `{ app_version, runtime: "tauri-2", webview2_version: string\|null, engine: EngineStatus }` | `webview2_version` is read from the runtime at startup or is `null` — never assumed. |
| `tab_list` | `{}` | `{ tabs: NavState[], active_tab_id: TabId }` | |
| `tab_create` | `{ url?: string }` | `NavState` | `url` omitted → new-tab page (app origin). Emits `tab:created` + `tab:activated`. |
| `tab_close` | `{ tab_id }` | `{ closed: TabId, active_tab_id: TabId }` | Last-tab safety: closing the final tab opens a fresh new-tab page instead of leaving zero tabs. |
| `tab_select` | `{ tab_id }` | `NavState` | Emits `tab:activated`. |
| `nav_submit` | `{ tab_id, input: string }` | `NavOutcome` | The URL-vs-search decision point (§4). |
| `nav_back` | `{ tab_id }` | `NavState` | Error `nav_unavailable` when `can_go_back` is false. |
| `nav_forward` | `{ tab_id }` | `NavState` | Error `nav_unavailable` when `can_go_forward` is false. |
| `nav_reload` | `{ tab_id }` | `NavState` | |
| `nav_stop` | `{ tab_id }` | `NavState` | Only meaningful while `loading` is true; otherwise a no-op that still returns real state. |
| `nav_home` | `{ tab_id }` | `NavState` | Home = the Ritam new-tab page (app origin) in v0.1. No configurable home page yet (not requested). |
| `engine_status` | `{}` | `EngineStatus` | |
| `engine_verify` | `{ tab_id }` | `EngineVerify` | Runs the **same** expression through the Obscura CLI and through `obscura serve` CDP and reports both results plus equality (rule 3, §6). |
| `external_open` | `{ url }` | `{ opened: true }` | **May only be called after the UI showed the §4.3 confirmation.** Launches the OS handler for the scheme. |

```jsonc
// NavOutcome — result of nav_submit
{ "kind": "navigated", "url": "https://example.com/", "state": NavState }
{ "kind": "search",    "url": "https://duckduckgo.com/?q=rust%20tauri", "query": "rust tauri", "state": NavState }
{ "kind": "external",  "url": "mailto:a@b.c", "scheme": "mailto", "origin": null }  // UI must confirm → then external_open
{ "kind": "rejected",  "error": IpcError }                                          // nothing was navigated

// EngineStatus
{ "state": "ready",       "version": "0.2.4", "endpoint": "http://127.0.0.1:52341", "pid": 1234, "detail": null }
{ "state": "starting",    "version": null,    "endpoint": null, "pid": 1234, "detail": null }
{ "state": "unavailable", "version": null,    "endpoint": null, "pid": null, "detail": "obscura.exe not found at tools/obscura-bin/obscura.exe" }

// EngineVerify — real engine output, both paths, byte-compared
{
  "url": "https://example.com/",
  "identical": true,               // cli.value == cdp.value (byte-for-byte)
  "cli": { "ok": true,  "value": "{\"title\":\"Example Domain\",...}", "bytes": 214, "duration_ms": 1180, "error": null },
  "cdp": { "ok": true,  "value": "{\"title\":\"Example Domain\",...}", "bytes": 214, "duration_ms": 902,  "error": null },
  "checked_at": "2026-10-10T14:03:11Z"
}
```

### 3.1 Store + chrome commands (v1.1, 2026-10-10)

Added by Rohan for Devi Request 1 / Govinda G-2 / ROT item 13. Shapes
are copied 1:1 from `docs/SCHEMA.md` §6 "Wire shapes (store ↔ IPC JSON)"
— that table is the store-side truth and wins any disagreement. Each
command will run `async` (store calls are blocking-by-design and never
run on the UI thread — ADR-007). Record field names are pinned in
`docs/SCHEMA.md` §6: `Bookmark`, `BookmarkFolder`, `HistoryEntry`,
`DownloadRecord`, `Note`, `ClearReport`, `IntegrityReport`.

**Implementation status (2026-10-10):** declared, **not yet
implemented**. Invoking any command below currently fails honestly at
the Tauri dispatch layer (no handler exists) — never a stub, never a
simulated success. The handlers land in the Phase 3 slice tracked on
`PLAN.md` → "Rohan (Phase 3, support)".

| Command | Args (JSON) | Result (JSON) | Notes |
|---|---|---|---|
| `settings_list` | `{}` | `[{ key, value }]` | All 6 typed keys, values already coerced per SCHEMA §6. |
| `settings_set` | `{ key, value }` | `{}` | Unknown key or out-of-vocabulary/out-of-range value → `invalid_input`; never a silent drop. |
| `bookmark_list` | `{ folder_id: number\|null }` | `[Bookmark]` | `null`/omitted → root. |
| `bookmark_add` | `{ url, title, folder_id }` | `{ "Created": Bookmark }` \| `{ "AlreadyExists": Bookmark }` | Duplicate url in the same folder → `AlreadyExists` carrying the existing record (externally-tagged enum, exactly as serialized). |
| `bookmark_delete` | `{ id }` | `null` | |
| `folder_list` | `{}` | `[BookmarkFolder]` | |
| `history_list` | `{ limit?, from_ms?, to_ms?, host? }` | `[HistoryEntry]` | Bounds may be `0` (epoch = all time); omitted → `None`. |
| `history_search` | `{ query, limit }` | `[HistoryEntry]` | FTS5, operator-safe quoting (LIKE degradation store-side). |
| `history_count` | `{}` | `3` (JSON number) | |
| `history_delete` | `{ id }` | `null` | |
| `download_list` | `{}` | `[DownloadRecord]` | Real rows only; `save_path`/`error` are `null` when the runtime never reported them. |
| `download_delete` | `{ id }` | `null` | |
| `downloads_clear_completed` | `{}` | `2` (JSON number) | Keeps `in_progress` rows. |
| `note_list` | `{ limit }` | `[Note]` | |
| `note_create` | `{ title, body }` | `Note` | `url` optional, omitted → `null`. |
| `note_get` | `{ id }` | `Note` | |
| `note_update` | `{ id, title, body, expected_revision }` | `Note` | Stale `expected_revision` → `conflict`, nothing overwritten. |
| `note_delete` | `{ id }` | `null` | |
| `clear_browsing_data` | `{ scope: { history: {from_ms, to_ms}\|null, downloads: bool, session: bool } }` | `ClearReport` | `history: null` leaves history untouched; `from_ms: 0` = all time; bookmarks/notes/settings are never in scope (SCHEMA §5). |
| `integrity_check` | `{}` | `IntegrityReport` | PRAGMA integrity_check + foreign_key_check + per-table malformed counts + schema version. |
| `chrome_resize` | `{ height }` | `{ height: number }` | **Applied** logical px: clamped so at least 120px of content area remains and never below the 108px strip; content webviews shift down by the applied value. Requesting a different height returns what actually happened, not what was asked. |

**Store error mapping:** `StoreError` serializes as the §2 `IpcError`
shape with snake_case codes: `invalid_input`, `not_found`, `duplicate`,
`conflict`, `invalid_transition`, `actor_stopped`, `sqlite` (the
`message` is the store's own `Display` text, verbatim). One additional
host-level code: `store_unavailable` — the database failed to open at
startup (or is already closed); every store command then fails with
that code and the open failure's real message. No store command ever
returns an empty success when the database is not there.

**Not wire commands (host ingestion, Devi R4):** `history_add`,
`download_start`, `download_event`, `session_save`, `session_load` are
direct Rust calls made by the runtime from its own real events
(`docs/SCHEMA.md` §6 "Host ingestion"). The UI never invokes them.

## 4. URL policy

### 4.1 Input classification (`nav_submit`)

Applied in order to the trimmed input:

1. **Scheme present** (`^[a-zA-Z][a-zA-Z0-9+.-]*:`) → parse.
   - `http`, `https` → `navigated`.
   - `about:` — only `about:blank` is allowed (handled as a real blank
     document); anything else `rejected` (`unsupported_scheme`).
   - `mailto`, `tel`, `sms`, `ftp`, `bitcoin`, any other scheme →
     `external` (never auto-launched; §4.3).
   - `file`, `javascript`, `data`, `vbscript` → `rejected`
     (`unsupported_scheme`). These are never reachable from the omnibox.
2. **Looks like a host** — no whitespace, contains a `.`, and its first label
   is not a bare word with no dot; or it is `localhost` / `localhost:PORT` /
   an RFC1918 host with a port → `https://` prefixed → `navigated`.
   `http://` is used instead when the input explicitly starts with it or the
   host is loopback/private and the user typed a port.
3. **Otherwise** → search. `https://duckduckgo.com/?q=<urlencoded>` (the
   default engine, overridable later by a Devi-owned setting — not in v0.1).

Classification is pure and unit-tested in `crates/ritam-browser/src/nav.rs`;
the same function backs the runtime, so the omnibox and the policy cannot
disagree.

### 4.2 Enforcement in the webviews

The classification above is the front door. The same policy is re-applied in
each content webview's navigation handler (defense in depth): a page may not
navigate its tab to `file:`/`javascript:`/`data:`/non-`about:blank` `about:`
URLs; the navigation is cancelled and a `nav:state` event carries the real
resulting URL.

### 4.3 External protocol confirmation

`nav_submit` returns `kind:"external"` and **launches nothing**. The UI shows
the full URL, the scheme, and the origin (or "no origin") and asks. Only a
confirmed click may call `external_open`. There is no auto-launch path, no
"remember my choice" in v0.1.

## 5. Error codes

| Code | Meaning |
|---|---|
| `invalid_input` | empty/unusable input |
| `unsupported_scheme` | scheme blocked by §4.1 |
| `tab_not_found` | tab id unknown or already closed |
| `nav_unavailable` | back/forward requested at the end of the history stack |
| `engine_unavailable` | Obscura did not start or is not connected |
| `engine_timeout` | engine operation exceeded its deadline |
| `engine_error` | engine returned a failure (message carries the engine's own text) |
| `navigation_failed` | the navigation itself failed after classification accepted it (DNS, TLS, refused connection — message carries WebView2's own error text) |
| `store_unavailable` | the store database failed to open or is already closed (§3.1); message carries the real open failure |
| `internal` | runtime failure; message is non-sensitive |

## 6. Engine surface (rule 3)

The runtime owns exactly one Obscura integration, isolated in
`crates/ritam-browser` behind the `ObscuraEngine` trait:

- `CliEngine` — spawns the pinned binary (`obscura fetch … --eval …`).
- `CdpEngine` — spawns `obscura serve` once per app run and drives it over
  CDP (`Target.createTarget` → `Runtime.evaluate` → `Target.closeTarget`).

Both implement the same typed operation and the same expression, so
`engine_verify` can prove — per URL, on demand — that the CDP path returns
**byte-identical** output to the CLI. A non-identical result is a rule-3
violation: the integration is wrong, and the fix is in this layer, never in
the engine (`obscura/` and `obscura-benchmark/` stay pristine).

ROT's independent gate for the same invariant is `scripts/parity-check.mjs`,
re-run at every phase boundary.

## 7. Known limitations of v0.1 (honest, not hidden)

1. **History is runtime-recorded.** WebView2 exposes no GoBack/GoForward, so
   the runtime keeps a per-tab URL stack from real navigation events.
   Consequences: same-document (hash) navigations are not recorded, and a
   back/forward step re-requests the URL instead of restoring the in-memory
   document (form state may be lost).
2. **Title and favicon are read from the live document** after load; before
   load ends they are `""` / `null`. Absence is shown as absence.
3. **Popup / new-window policy is not enforced** (`target="_blank"`,
   `window.open`): WebView2 default behavior applies. Owner decision pending
   — `PLAN.md` Request 5.
4. **Session persistence is not implemented**: it is Devi's surface and does
   not exist yet (`PLAN.md` Request 1). Tabs do not survive a restart in
   v0.1.
5. **Timeouts and offline pages are WebView2's own real error pages.** The
   runtime never substitutes a synthetic page and never claims success.
6. **No security verdicts.** The contract carries `origin` only; it never
   carries "secure", "verified", or "trusted" (AGENTS.md §6).
7. **Engine scope:** the Obscura engine does not render visible tabs
   (ARCHITECTURE_DECISION D1). It is the isolated automation runtime, and
   `engine_verify` is how the UI proves the engine's real response.
   *(Amended by §8 — superseded by D6, the owner's two-path decision.)*

## 8. Stage addendum v0.2 (2026-10-10) — content sources (D6)

Written by ROT under the owner's stage command (announced in PLAN.md;
additive only — no v0.1 field, type, or error code changes; **reviewed and
accepted by Rohan 2026-10-10, see §9** — no revert requested). Reason: the
owner decided **"Both paths, Obscura default"** after
v0.1 was published, and D6 was written before this code (rule 5).

### 8.1 Additive type: `content_mode`

```jsonc
// NavState gains one field (serde default "engine"):
"content_mode": "engine" | "direct"
// "engine"  — page bytes fetched by Obscura, rendered scriptless (D6.1)
// "direct"  — WebView2 navigated the URL itself (D6.2)
```

### 8.2 Additive commands

| Command | Request | Response | Notes |
|---|---|---|---|
| `tab_set_mode` | `{ tab_id, mode: "engine"\|"direct" }` | `NavState` | Switches the tab's content source and re-renders the current URL through the chosen path. Emits `nav:state`. |
| `external_open` | *(v0.1 §3, now implemented)* | `{ opened: true }` | Unchanged semantics: only after the §4.3 confirmation. |

### 8.3 Additive event: `nav:error`

```jsonc
{ "tab_id": 3, "error": IpcError }
```
Emitted when a navigation cannot complete **after** it was accepted —
today only the engine snapshot path can produce this (engine unavailable,
engine error, page too large for snapshot, `navigation_failed` mid-fetch).
`loading` is set back to `false` first; the tab keeps its last real state.
Never emitted for a success.

### 8.4 §7.7 replacement

v0.1 §7.7 ("the Obscura engine does not render visible tabs") is replaced
by **D6**: the engine snapshot path *is* the default content source; the
direct path is the secondary mode; the UI labels the active mode honestly
(R3). The parity gate scope follows D6.

### 8.5 Snapshot transport

The engine fetch uses the **same eval surface the parity gate proves**
(`ObscuraEngine::eval`, CLI vs CDP byte-compared by `verify_parity` and
`scripts/parity-check.mjs`):

```js
JSON.stringify({ u: location.href, t: document.title,
                 d: document.documentElement.outerHTML })
```
Parsed defensively (both observed CLI/CDP encodings). The runtime prepends
`<!DOCTYPE html>` before rendering (the eval surface does not emit a
doctype) and injects `<base href="<final-url>" target="_top">` so relative
resources resolve and link clicks route through the runtime (D6).

## 9. Stage addendum v0.3 (2026-10-10) — runtime events + §4.1 wording (Rohan)

Written by Rohan (contract owner, §0 rule 1), announced in PLAN.md. Additive
only. Two things: four events the runtime already emits and the chrome
already listens to are now named with their real payloads (ROT finding,
PLAN.md "ROT announcements" item 7), and one §4.1 rule-1 wording
refinement that matches the classifier as shipped and tested. ROT's §8
addendum: **accepted as written** (see §8 header).

### 9.1 Additive events

| Event | Payload | Emitted when |
|---|---|---|
| `runtime:ready` | `{ tabs: NavState[], active_tab_id: TabId }` | Once, after setup created the first tab. Emitted before the chrome may be listening — the chrome therefore re-reads `tab_list`/`runtime_info` on load and treats this event as an update, not the source of truth. |
| `engine:status` | `EngineStatus` (§2) | Once after `runtime:ready`. Carries only what the engine actually reported (started, with its own endpoint/pid — or `unavailable` with the engine's reason). |
| `download:started` | `{ tab_id: TabId \| null, url: string, filename: string }` | WebView2 reports a download request on a tab webview. `filename` is the default destination's file name as given by WebView2 (the runtime never picks the destination itself). `tab_id` is `null` only if the emitting webview's label is not `tab-<n>`. |
| `download:finished` | `{ tab_id: TabId \| null, url: string, path: string \| null, success: boolean }` | WebView2 reports the download finished. `path` is WebView2's reported save path and may be `null` even when `success` is true (platform limitation, mirrored honestly); `success` is the only claim about the outcome. |

The chrome's stop control documents `Esc` and implements it (keydown →
`nav_stop` while the active tab is loading); no other shortcut is claimed
that is not wired.

### 9.2 §4.1 rule 1 refinement (clarification, not a wire change)

Unknown schemes classify as `external` **only** when the body after the
colon is URL-shaped — starts with `//`, `/`, or `\` (`myapp://open`,
`C:/Users/x`). An opaque body (`user:pass@host`) is not a protocol:
classification falls through to rule 3 and searches it, matching normal
browser behaviour. The `host:port` guard (which keeps `example.com:8080`
out of the external branch) and the rule-2 port detection read the
**authority only**, so `127.0.0.1:3000/app` still gets the loopback `http://`
exception. No command, field, type, or error code changed.

## 10. Breaking addendum v1.0 (2026-10-10) — event names (Rohan)

**BREAKING** per §0 rule 3: every runtime→chrome event name is renamed,
because Tauri 2.12 rejects the old dotted names on **both** ends of the
channel. `tauri::Manager::emit` validates via `EventName::new` and returns
`IllegalEventName` for anything outside `[alnum - / : _]`, and the `listen`
command deserializes the name through the same validation — so
`nav.state`-style names silently never left the runtime (the old code
discarded the `Err`) and the chrome's `listen("nav.state", …)` promises all
rejected. The smoke probe caught it as 8 unhandled rejections; nothing
event-driven in the UI had ever run.

| v0.x name | v1.0 name |
|---|---|
| `runtime.ready` | `runtime:ready` |
| `engine.status` | `engine:status` |
| `nav.state` | `nav:state` |
| `nav.error` (§8.3) | `nav:error` |
| `tab.created` | `tab:created` |
| `tab.activated` | `tab:activated` |
| `tab.closed` | `tab:closed` |
| `download.started` | `download:started` |
| `download.finished` | `download:finished` |

Payloads and semantics are unchanged. The runtime now **logs** emit failures
instead of discarding them, so a future name mistake is visible rather than
silent. (Contract version tracks this file's wire surface only; it makes no
claim about product version.)

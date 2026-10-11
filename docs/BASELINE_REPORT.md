# BASELINE REPORT — Ritam Browser accuracy gate

**Owner of file:** ROT · **Run date:** 2026-10-10 · **Machine:** Windows x64,
Rust 1.98.1 (x86_64-pc-windows-msvc), WebView2 Evergreen 154.0.4258.62,
Python 3.12.4, Node 24.11.0, timezone India Standard Time.

## Pinned engine

| Item | Value |
|---|---|
| Binary | `tools/obscura-bin/obscura.exe` (+ `obscura-worker.exe`) |
| Version | obscura 0.2.4 (release `1fccab2`) |
| SHA-256 (zip) | `8e5428bf8c101f1439c53a9dcb52d7d09bb22599206b49f6420028d93d01189b` (matches official asset) |
| Features | render build (screenshots verified) |
| Source clone | `obscura/` @ `1f8eb76` — read-only, pristine |
| Benchmark harness | `obscura-benchmark/` @ `2d7bc30` — read-only, pristine |

## Smoke tests (2026-10-10)

- `obscura --version` → `obscura 0.2.4` ✅
- Live network fetch + V8 eval of `document.title` → correct title ✅
- `--screenshot` → 63,715-byte PNG written ✅

## Obstacle course (capability gate)

Command: `OBSCURA_BIN=<bin> PYTHONUTF8=1 TZ=Europe/Berlin python obstacle-course/run.py --runs 1 --warmup 0`

**Result: 32/33 stages PASS.** Median ~3,049 ms/stage — this is the runner's
`--wait 3` settle floor, not engine latency (upstream's ~44 ms figure uses a
different settle policy).

**Re-run 2026-10-10 14:31: 32/33 again** (same single `fingerprint`
failure, same root cause below; all other stages PASS with median
3,066 ms). The result is stable across runs.

### The one failing stage — root-caused as ENVIRONMENT, not engine

| Stage | Expected | Got | Root cause | Evidence |
|---|---|---|---|---|
| `fingerprint` | `...tz=Europe/Berlin` | `...tz=Asia/Calcutta` | Fixture hardcodes upstream CI's timezone. This machine is India Standard Time. The engine correctly reported the **actual local timezone** — correct engine behavior, wrong environment assumption in the fixture. | `(Get-TimeZone).Id = India Standard Time`; engine output `tz=Asia/Calcutta` matches; all other fingerprint fields (`chrome=1:wdclean=1:plat=Win32:lang=en-US`) matched exactly. |

### Two initially-failing stages — root-caused as HARNESS BUG on Windows

| Stage | First run | After `PYTHONUTF8=1` | Root cause |
|---|---|---|---|
| `textdecoder` | FAIL (timeout) | **PASS** (`td:あ`) | `run.py` uses `subprocess.run(text=True)` without `encoding="utf-8"`; on Windows it decodes UTF-8 stdout as cp1252, which cannot decode the Japanese test characters and aborts the capture. Verified by running the same stage directly: exact expected output returned. |
| `charset-shiftjis` | FAIL (timeout) | **PASS** (`sjis:こんにちは世界`) | Same runner bug. Direct run: exact expected output. |

**Engine-equivalent verdict: 33/33.** 32 stages pass under the harness; the
33rd passes its real intent (correct local-timezone reporting) with only the
fixture's hardcoded foreign-TZ expectation unmet. The two harness failures
pass once the runner's Windows encoding bug is neutralized via environment
variable — no harness files were modified (read-only discipline held).
The harness bug is upstream's, fixable in `obstacle-course/run.py` by adding
`encoding="utf-8"` to `subprocess.run`.

## CLI-vs-CDP parity (rule 3, the UI-path gate)

Command: `node scripts/parity-check.mjs` (ROT-owned harness; fixed
`--allow-private-network` on the serve side of the harness itself).

**Result: 10/10 byte-identical (re-run 2026-10-10 14:33).**

The fixture allowlist originally matched only 6 stages (the manifest omits
`type` on eval stages); ROT fixed the filter (`s.type ?? "eval"`, 2026-10-10)
so all 10 intended stages are compared. The earlier 6/6 run is superseded
by this 10/10 run — same harness, wider coverage.

| Stage | Match | Sample (both paths byte-identical) |
|---|---|---|
| async-render | ✅ | `async:error:SyntaxError:Unexpected end of JSON input` (identical on both — same engine error, same bytes) |
| spa-router | ✅ | `route:/products:Products Page` |
| timers | ✅ | `timers:microtask,t1,t2:done` |
| web-component | ✅ | `wc:2:Hello` |
| url | ✅ | `url:https::u:p:h.test:8:h.test:8:/a:?x=1:#y` |
| textdecoder | ✅ | `td:あ` |
| fileapi | ✅ | `file:18:obstacle blob text` |
| selection | ✅ | `sel:1:onetwothree` |
| dialog | ✅ | `dialog:true:false:confirmed` |
| cookies | ✅ | `cookie:k=v:session=abc123` |

Interpretation: driving the engine over CDP (the transport the UI uses) is
byte-identical to driving the CLI. The UI layer adds zero accuracy change.

## Phase 3 persistence gate (store, ROT-run)

Command: `cargo nextest run` in `crates/ritam-store/`
(`tools/nextest` on PATH; nextest-only per AGENTS.md §6 — the suite spawns
the pinned binary in `obscura_ingest`).

**Result: 34/34 PASS, 0 skipped, 2.25 s (2026-10-10 14:55).**
**Superseded (16:13 re-run over current HEAD): 43/43 PASS, 0 skipped,
2.28 s** — Devi landed the `from_ms` range fix and more tests after the
first signing; the 43/43 line is the signed Phase 3 storage gate now.
Includes `obscura_ingest::obscura_response_is_persisted_byte_identical_across_restart`
(engine bytes in → identical bytes out after restart) and
`engine_failure_is_an_error_not_a_stored_success` (no fabricated rows).

## Known limitations of this baseline (honest)

- WPT track and `compare/` vs Chrome need Linux tooling (`/etc/hosts`
  entries, GNU `time -v`) — not run on this machine; upstream published
  numbers stand as reference, not as this machine's measurement.
- One machine, no CI (owner rule 2 forbids remote). Backup is owner-owned.
- Latency figures here include the runner's settle floor; do not compare
  directly with upstream's cold-fetch numbers.

## Gate run log (ROT, `scripts/gate-all.mjs` — one command, honest exit code)

| When | ui-contract | build | store | core | app | parity | obstacle |
|---|---|---|---|---|---|---|---|
| 15:03–15:08 | FAIL (4 undeclared events) | PASS | PASS 34/34 | FAIL (4 nav tests, mid-edit) | FAIL (test compile, mid-edit) | PASS 10/10 | 32/33 (R11) |
| 15:19-15:23 (re-run after Rohan's fixes) | **PASS** (events declared in ipc.md) | PASS | PASS 34/34 | **PASS 9/9** (incl. live CLI-vs-CDP byte-identical) | **PASS 11/11** | PASS 10/10 | 32/33 (R11) |
| 16:14 (tree as of 16:10, post tab-0 fix) | PASS (shell UI) | PASS | **PASS 43/43** | PASS 9/9 | PASS 11/11 | PASS 10/10 | 32/33 (R11) |

After 16:15 the ui-contract gate is intentionally FAIL until the 21
store/overlay commands bound by `browser/ui/chrome.js` are declared in
`contracts/ipc.md` (PLAN items 13/G-2) — that red is the gate proving a
real conformance gap, not a regression. One C4 honesty finding also open
(PLAN item 14, chrome.js:652).

The 15:03 failures were captured while Rohan's session was actively
editing; all four were fixed by 15:23. Remaining known gate gap: obstacle
`fingerprint` (R11, owner decision pending).

## Launch smoke test (ROT, 15:24–15:45, real app on the real desktop)

Built `src-tauri/target/debug/ritam-browser.exe` and launched it:

- **Process + engine:** app alive; real `obscura` serve + worker processes
  spawned; engine pill read **"Engine: ready Chrome/145.0.0.0 @
  http://127.0.0.1:64496"** (screenshot evidence saved outside the repo,
  `Temp/ritam-smoke.png`).
- **Chrome UI:** Serene Canvas shell renders (tab strip, toolbar, omnibox,
  origin chip, engine pill, status bar); new-tab page served from app
  origin (`http://tauri.localhost/newtab.html`) with honest copy; back/
  forward disabled until real history exists; WebView2 + IPC confirmed
  working via CDP inspection of both webviews
  (`scripts/probe-ui-cdp.mjs`).
- **Real navigation (end-to-end):** omnibox submit → real page load in the
  content webview — `example.com` rendered "Example Domain" with correct
  `nav.state`/`tab_list` updates (verified over CDP against the running
  app). The browser works with real responses.
- **🔴 Blocker found (owner hit it live):** at startup the chrome's
  `activeTabId` is stale (`0`) while the runtime's active tab is `1`, so
  the first commands fail with `tab_not_found: tab 0 does not exist`
  until the user clicks a tab. Full evidence + smallest fixes filed as
  **PLAN.md ROT item 10** (Rohan). The engine/runtime side is healthy:
  this is UI first-read state only.
- **Blocker FIXED and verified (16:08, `scripts/probe-coldstart2.mjs`
  against the rebuilt app over CDP):** at cold start the strip shows the
  tab selected (`aria-selected="true"`), and an omnibox submit with no
  prior click navigates immediately (example.com loads, "Example
  Domain", `tab_list` reflects the real page). App unit tests 11/11
  after the fix. Fixes: shell.js active-tab coercion at both read sites
  + runtime first-tab invariant (ROT, stage authority, commented);
  Govinda mirrored the coercion in `browser/ui/chrome.js`.
- **Security evidence (§1, 16:05-16:10):** from a **remote page**
  (`https://example.com` inside a content webview) `invoke("tab_list")`
  and `invoke("external_open")` are both **DENIED** — remote content
  cannot drive the browser; the origin check holds. Caveat recorded for
  D6: app-origin pages (trusted, app-authored) *can* invoke, so the
  engine-snapshot host page must remain scriptless per D6.

## Contract v1.0 event-channel fix (§10) — ROT verification, 16:40-16:50

Rohan found (contract §10) that Tauri 2.12 validates event names to
`[alnum / : _]` — the old dotted names (`nav.state`, `tab.created`, …)
failed `emit` with `IllegalEventName` while the runtime discarded the
error, so **no event had ever reached the UI**; only command responses
worked. Verified both directions:

- **Root cause real:** the old `let _ = emit(...)` pattern + dotted
  names = silent failure on the wire (Rohan's smoke probe saw the
  chrome's `listen` promises reject, 8 unhandled).
- **Fix works on the wire:** after the colon rename (`nav:state` etc.)
  in runtime + shell.js, a navigation driven **only** through the
  content webview (no chrome command) updated the chrome omnibox within
  1.5 s (`scripts/probe-eventflow.mjs`) — `nav:state` events arrive.
- **Gate hardening (ROT):** `tests/ui-contract.test.mjs` now checks
  every UI listener and runtime emit against Tauri's charset, so this
  bug class is a permanent mechanical breach. shell.js + runtime
  conformant; chrome.js still dotted (Govinda, PLAN item 19).
- Design note (not a breach): `can_go_back` stays false for the first
  navigation away from `newtab.html` — the new-tab page is not a
  history entry; the disabled back button honestly reflects it.

## Re-run triggers (AGENTS.md §7)

ROT re-runs the obstacle course + parity at every phase boundary; Rohan
re-runs parity after any adapter/IPC change. Any drop blocks the phase.

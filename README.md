# Ritam Browser

**Cosmic truth and universal order.**

A conventional desktop browser for Windows built on **Tauri 2 + WebView2**,
with the [Obscura engine](https://github.com/h4ckf0r0day/obscura) as its
isolated automation runtime. Serene Canvas design system, and an honest UI:
the app never reports success for work it did not actually do
(`AGENTS.md` §6).

## Status (honest)

| Works today | Not yet |
|---|---|
| Multi-tab lifecycle (create / close / select, live tab strip) | Bookmarks / history / downloads / scratchpad panels — wire surface declared in `contracts/ipc.md` §3.1, runtime wiring is the next slice |
| Omnibox (real URL-vs-search classification), back / forward / reload / stop / home | D6 content modes (`tab_set_mode`, engine-snapshot rendering) — claimed, not started |
| Runtime→UI state events (`nav:state`, `tab:*`, `engine:status`, …) | Code signing for installers |
| Engine status + CLI-vs-CDP byte-parity verification | |
| Keyboard reachability, visible focus, accessible names | |

Progress, owners and gates live in [`PLAN.md`](PLAN.md); the binding rules
in [`AGENTS.md`](AGENTS.md); the typed IPC surface in
[`contracts/ipc.md`](contracts/ipc.md) (v1.1).

## Install

Grab `Ritam Browser_*.msi` or `Ritam Browser_*-setup.exe` from the
**Releases** page (or the workflow artifacts of a green run). Requires
Windows 10+; the installer bootstraps the WebView2 Evergreen runtime if it
is missing.

Both installers are currently **unsigned** — Windows SmartScreen may show
"Windows protected your PC": *More info → Run anyway* (no certificate has
been procured yet; see `docs/RELEASE_CHECKLIST.md`).

## Build from source

Prerequisites: Rust (MSVC toolchain), Node.js (Tauri CLI), WebView2
Evergreen runtime.

```powershell
# dev build + run
cargo run --manifest-path src-tauri/Cargo.toml

# installers (.msi + NSIS), outputs to src-tauri/target/release/bundle/
npm install -g @tauri-apps/cli@^2
cd src-tauri
tauri build
```

The Obscura engine binary is **not** committed. Tests and installer builds
fetch the pinned v0.2.4 release and verify its SHA-256 exactly as recorded
in [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md); the release CI does this
automatically, for a local bundle stage the files into
`src-tauri/resources/engine/` first (see the README there).

## Tests

```powershell
cargo nextest run --manifest-path crates/ritam-browser/Cargo.toml  # 9 tests, incl. CLI-vs-CDP parity (needs the engine)
cargo nextest run --manifest-path src-tauri/Cargo.toml             # 11 tests
node tests/ui-contract.test.mjs                                    # IPC contract conformance gate
node src-tauri/tools/smoke.mjs                                     # live CDP smoke probe (local, needs WebView2)
```

Use **`cargo nextest run`, never `cargo test`** — a single V8 isolate per
process makes `cargo test` invalid for engine-adjacent tests.

## CI / releases

`.github/workflows/ci.yml` (GitHub Actions, `windows-latest`):

- **every push / PR** — SHA-256-verifies the pinned engine, runs both
  nextest suites, builds the `.msi` + NSIS installers as downloadable
  artifacts, and runs the ui-contract gate (currently non-blocking while
  `browser/ui/chrome.js` finishes adopting contract v1.0 — tracked in
  `PLAN.md`);
- **tag `v*`** — additionally opens a **draft GitHub Release** with both
  installers attached, for review before publishing.

Obstacle-course and parity gate runs (`scripts/`, `obscura-benchmark/`)
stay local ROT gates; the CI covers compile + unit + contract + packaging.

## Repo map

| Path | Owner (`AGENTS.md` §3) |
|---|---|
| `src-tauri/` | Rohan — host, IPC commands, smoke probe |
| `crates/ritam-browser/` | Rohan — nav classification, engine bridge |
| `crates/ritam-store/` | Devi — SQLite store (WAL, migrations) |
| `browser/ui/` | Govinda — chrome UI (Serene Canvas) |
| `tests/`, `scripts/` | ROT — gates and verification |
| `contracts/ipc.md` | typed IPC contract (v1.1) |
| `docs/` | schema, decisions, baseline, risks, dependencies |

No license file has been issued yet — all rights reserved
(`Cargo.toml` declares `license = "Proprietary"`).

# DEPENDENCIES — Ritam Browser

Rule 4 record: everything cloned/downloaded for this project, with source,
version, and verification. Keep current; append-only.

## Fetched 2026-10-10 (Phase 0, ROT)

| What | Source | Version / pin | Verification | Local path |
|---|---|---|---|---|
| Obscura engine binary (render build, Windows x64) | `github.com/h4ckf0r0day/obscura` releases | v0.2.4 (`1fccab2`) | SHA-256 `8e5428bf8c101f1439c53a9dcb52d7d09bb22599206b49f6420028d93d01189b` — matches official release asset; smoke-tested: `--version` OK, live `fetch https://example.com --eval` OK, `--screenshot` OK (63,715 B PNG) | `tools/obscura-x86_64-windows.zip`, extracted to `tools/obscura-bin/` (`obscura.exe`, `obscura-worker.exe`) |
| obscura-benchmark harness | `github.com/h4ckf0r0day/obscura-benchmark` | commit `2d7bc30` (depth-1 clone, main) | clone succeeded; `obstacle-course/run.py` present (stdlib-only Python) | `obscura-benchmark/` |
| Obscura source clone (pre-existing, read-only pin) | `github.com/h4ckf0r0day/obscura` | commit `1f8eb76` (main) | clean tree, remote = upstream | `obscura/` |

## Fetched 2026-10-10 (Phase 3 store, Devi)

| What | Source | Version / pin | Verification | Local path |
|---|---|---|---|---|
| `cargo-nextest` (prebuilt Windows binary) | `get.nexte.st/latest/windows` (nextest release 0.9.148, 2026-10-07) | 0.9.148 | SHA-256 `d9dd12a3d5dd67d5b8ca9315fa9f3c2384d1d47f4e324039ba634af36e2862d8` (exe), archive SHA-256 `7a931b4a9123fe5e641dd0f2b73d897f64bcf77bb06f080db17cb434b7eac782`; `--version` OK; required by AGENTS.md §6 (engine-adjacent tests must run under nextest, never `cargo test`) | `tools/nextest/cargo-nextest.exe` |
| Rust crates for `crates/ritam-store` | crates.io (cargo, `Cargo.lock` committed) | rusqlite 0.40.2 (`bundled`, SQLite 3.53.2, FTS5 verified present by `tests/probe_fts5.rs`), libsqlite3-sys 0.38.2, serde 1.0.229, serde_json 1.0.151, thiserror 2.0.21; dev: tempfile 3.27.0 | resolved and locked; `cargo nextest run` 34/34 pass, `cargo clippy --all-targets` clean, `cargo fmt --check` clean | `crates/ritam-store/Cargo.lock` (SHA-256 `59f04e077edadc8ad99e50ae62e7fdee284da9bab6024b98ef994935b65f0c0f`) |

## Pre-existing toolchain (verified, not fetched)

| Tool | Version | Status |
|---|---|---|
| Rust (MSVC host `x86_64-pc-windows-msvc`) | 1.98.1 | OK for Tauri 2 + WebView2 |
| Node.js | 24.11.0 | OK |
| npm | 11.6.1 | OK |
| Python | 3.12.4 / 3.14.7 | OK for benchmark runners |
| git | 2.52.0.windows.1 | OK |
| WebView2 Evergreen Runtime | 154.0.4258.62 | Present — satisfies ADR-008 consumer default |

## Fetched by the release CI (2026-10-10, Rohan — owner-ordered push)

| What | Source | Version / pin | Verification | Where |
|---|---|---|---|---|
| Obscura engine re-fetch (tests + installer bundles) | `https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.4/obscura-x86_64-windows.zip` | v0.2.4 — the same asset as the Phase 0 fetch | SHA-256 compared against `8e5428bf8c101f1439c53a9dcb52d7d09bb22599206b49f6420028d93d01189b` in `.github/workflows/ci.yml` **before** extraction; `obscura.exe --version` executed in the test job | CI runner: `tools/obscura-bin/` (tests), `src-tauri/resources/engine/` (bundle staging; gitignored) |
| `cargo-nextest` | `taiki-e/install-action@cargo-nextest` (official prebuilt installer action) | latest stable at run time | official distribution; suites run under nextest per AGENTS.md §6 (never `cargo test`) | CI only |
| `@tauri-apps/cli` | `npm install -g @tauri-apps/cli@^2` | v2 latest at run time | official Tauri prebuilt distribution; drives `tauri build` → `.msi` + NSIS | CI only |
| GitHub Actions | `actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`, `dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`, `softprops/action-gh-release@v2` | major tags | used as published; no repo-local modifications | `.github/workflows/ci.yml` |

## Not yet needed (fetch only on first use, then record here)

- Tauri 2 CLI / crates — first scaffold is Phase 1/2 (Govinda/Rohan)
- Lucide icons, `@preact/signals-core`, fonts (Newsreader, Plus Jakarta
  Sans) — Phase 1 (Govinda)
- WPT checkout — Linux/CI only; documented as out-of-scope for this machine

## Rules for entries

- Pin exact versions; record hashes where the source publishes them.
- Nothing is fetched without a phase need; nothing is fetched twice.
- Upstream repos (`obscura/`, `obscura-benchmark/`) stay pristine — no
  edits, no commits, no pushes (AGENTS.md §3).

## Phase 1 UI assets (fetched 2026-10-10, Govinda task)

Fonts fetched via the Google Fonts CSS2 API with a modern-browser
User-Agent so the response carries woff2 URLs (a plain UA returns TTF).
Only the `latin` faces (unicode-range starting `U+0000-00FF`) were kept;
latin-ext / vietnamese / cyrillic faces were skipped. Google serves these
two families as **variable-font woff2**, so all requested weights of a
family resolve to one URL — the per-weight files below are byte-identical
copies of that single variable file (same SHA-256 within a family). That
is expected, not a duplicate-download error. The raw CSS response is kept
for provenance.

| What | Source | Version / pin | Verification | Local path |
|---|---|---|---|---|
| Newsreader latin woff2, weight 400 | Google Fonts CSS2 `https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap` (file URL `fonts.gstatic.com/s/newsreader/v26/...NJYQ.woff2`) | Newsreader v26 (latin face, `U+0000-00FF` range) | SHA-256 `62981321d9a3cc7a61a73792729043703fd6112da86e8ec848bb57f088578757` — magic bytes `wOF2` OK (58,084 B) | `assets/fonts/newsreader-400.woff2` |
| Newsreader latin woff2, weight 500 | same CSS2 URL as above | Newsreader v26 (same variable file as 400) | SHA-256 `62981321d9a3cc7a61a73792729043703fd6112da86e8ec848bb57f088578757` — magic bytes `wOF2` OK (58,084 B; identical to 400) | `assets/fonts/newsreader-500.woff2` |
| Plus Jakarta Sans latin woff2, weight 400 | same CSS2 URL as above (file URL `fonts.gstatic.com/s/plusjakartasans/v12/...Ko20yw.woff2`) | Plus Jakarta Sans v12 (latin face, `U+0000-00FF` range) | SHA-256 `153fc85b70298beeb1d61a5f723331649e7f23bb77302a66e61cb3e2fbdb5e79` — magic bytes `wOF2` OK (27,348 B) | `assets/fonts/plus-jakarta-sans-400.woff2` |
| Plus Jakarta Sans latin woff2, weight 500 | same CSS2 URL as above | Plus Jakarta Sans v12 (same variable file as 400) | SHA-256 `153fc85b70298beeb1d61a5f723331649e7f23bb77302a66e61cb3e2fbdb5e79` — magic bytes `wOF2` OK (27,348 B; identical to 400) | `assets/fonts/plus-jakarta-sans-500.woff2` |
| Plus Jakarta Sans latin woff2, weight 600 | same CSS2 URL as above | Plus Jakarta Sans v12 (same variable file as 400) | SHA-256 `153fc85b70298beeb1d61a5f723331649e7f23bb77302a66e61cb3e2fbdb5e79` — magic bytes `wOF2` OK (27,348 B; identical to 400) | `assets/fonts/plus-jakarta-sans-600.woff2` |
| Plus Jakarta Sans latin woff2, weight 700 | same CSS2 URL as above | Plus Jakarta Sans v12 (same variable file as 400) | SHA-256 `153fc85b70298beeb1d61a5f723331649e7f23bb77302a66e61cb3e2fbdb5e79` — magic bytes `wOF2` OK (27,348 B; identical to 400) | `assets/fonts/plus-jakarta-sans-700.woff2` |
| Raw CSS2 response (provenance) | same CSS2 URL as above | response as served 2026-10-10, contains woff2 URLs | SHA-256 `c41a708d0896a7acc36a8f76c7d22c3fea70e744b01ad04497f945beb8c2b169` — 9,316 B, contains `woff2` src URLs | `assets/fonts/fonts-source.css` |

Fonts are local files only: the privileged chrome UI never loads a remote
font (AGENTS.md §6, local-first). The `@font-face` CSS that consumes them
must point at these app-origin paths.

Byte-identical copies of the same six files also live in
`browser/ui/fonts/` (same names), because `browser/ui/` is the chrome
webview's document root once `frontendDist` flips there (PLAN.md Request
G-3). Re-hashed pair-by-pair against `assets/fonts/` at 2026-10-10 16:03:
all six IDENTICAL to the hashes above. `assets/fonts/` remains the
canonical fetch record; the `browser/ui/fonts/` copies are duplicates for
app-origin serving, not new downloads.

### Icon files (lucide-static 0.545.0)

| What | Source | Version / pin | Verification | Local path |
|---|---|---|---|---|
| 25 Lucide static icon SVGs (arrow-left, arrow-right, rotate-cw, square, house, star, menu, plus, x, search, bookmark, history, download, notebook-pen, settings, globe, loader-circle, chevron-down, lock, more-horizontal, trash-2, folder, file-text, panel-left-open, circle-alert) | `https://unpkg.com/lucide-static@0.545.0/icons/<name>.svg` | lucide-static 0.545.0 (exact version pinned in URL) | all 25 fetched (no 404s); each contains `<svg` and parses as XML; per-file SHA-256 below | `assets/icons/lucide-<name>.svg` (25 files) |

#### Icon SHA-256 list (one per downloaded file)

| File | SHA-256 |
|---|---|
| `assets/icons/lucide-arrow-left.svg` | `629672e0132e9a9e403b24cb7f59cd22260081feb843ecfd7abf1d6cb17176b4` |
| `assets/icons/lucide-arrow-right.svg` | `599c7fe2de44758f2d9e3c1323cd044fb47ef33b44c34d1f5abf6e79b0db2aef` |
| `assets/icons/lucide-rotate-cw.svg` | `75d448e4bc9af296a135b92a1715f648aa8d3d7ed6550ac0a8f513108ef66dd8` |
| `assets/icons/lucide-square.svg` | `68d32231a3cd504fd3cad35ea3e584878cee847daf04267db6bee90d52cc4235` |
| `assets/icons/lucide-house.svg` | `1bee3ccfc51c01a692a10ab8620b7d317f709ca17e92910f5eafb8cd0c64a25b` |
| `assets/icons/lucide-star.svg` | `9d55a89ec0e38a36807c935f470aec28b1a7bdde25f67a72076c402fbf471b57` |
| `assets/icons/lucide-menu.svg` | `e4293da9ae253cad3fff1c09c2087c68cb62ea6f970fab71dd38483bcb7b9ab4` |
| `assets/icons/lucide-plus.svg` | `44fd5c308004a84553ad6d5985f129e80cf5950807bcb3351059d477bb8d0028` |
| `assets/icons/lucide-x.svg` | `b7c8e403e30cdf74f3a423f2ccf6725c6608937fc9bd3f28198987de64a56855` |
| `assets/icons/lucide-search.svg` | `2e98f3176b085f35bf4098ae2dfd8ba480a2429ecce23f72cb04417d5f283eb1` |
| `assets/icons/lucide-bookmark.svg` | `64eaface5d1ddba8a78c8b9c4452edd102351e01410ddbebe3673d982a7f6bab` |
| `assets/icons/lucide-history.svg` | `8d2b920720502a3cee84a87a171246217b147806c9bbe9cbb195fff443b8f184` |
| `assets/icons/lucide-download.svg` | `be113b9758283ce79766be386952e45433d34c0f46ac7a246c9851ac48d8ef0a` |
| `assets/icons/lucide-notebook-pen.svg` | `79523862cd0384f84fa72b189d5cedf4de8c3df90a6ba061f7f32729ae201712` |
| `assets/icons/lucide-settings.svg` | `c743cddd8e9bba85376c0b381861ce793f9257412f83f163a6f5e475d43e2e49` |
| `assets/icons/lucide-globe.svg` | `8a00643bd457ba0c5b01fe35413a86f485d8f510e3ab5c18632ae2deda17f071` |
| `assets/icons/lucide-loader-circle.svg` | `65c11a7d5884d5c0cc14ed0cc7bdb1c110ce1073922b403f29069a2e120f8120` |
| `assets/icons/lucide-chevron-down.svg` | `a017a312d2722a765040ea88d562be5a89d8a51c4a6231d72e07e8292415bf83` |
| `assets/icons/lucide-lock.svg` | `7a563c8360720a31bbe8dcc105832485facdfa31792e753748f602bf08e12bd2` |
| `assets/icons/lucide-more-horizontal.svg` | `3a0b61083e48bdf23f831251db34ff2a481e1a8508d0530dd3c844edde9596ff` |
| `assets/icons/lucide-trash-2.svg` | `43ddbac7cde49401e8a1154785215ff76c60dde31c626d104c3cbe0947bcbd6e` |
| `assets/icons/lucide-folder.svg` | `178b9ce68f51bad55f77c681494e5034a13328d0cf9e50de26a499bbd044e776` |
| `assets/icons/lucide-file-text.svg` | `3652533d3889a5e06260dba492c8fa6a7b6eb04e1d68d66ed29802466e2bfd31` |
| `assets/icons/lucide-panel-left-open.svg` | `ba0b9c3dd9a007b87bee380e1ebd2974782839b2a8f2d37dacfce926472b352c` |
| `assets/icons/lucide-circle-alert.svg` | `6123d6e81c58923bc610c269fc33f562ff5876534e9b86622b4d3d8aed5f487f` |

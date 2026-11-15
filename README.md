# Govind Browser

> *A fast browser that shows you how the internet works.*

**Status: Milestone 1 — browser shell.** A real Tauri 2 + Rust desktop app with a
plain HTML/CSS/vanilla-JS UI (no frontend build step, no CDN at runtime). Local-first:
SQLite on your disk, zero telemetry, no accounts. Page text is sent to a
translation server only when you explicitly translate a page.

## What works (and what doesn't)

| Area | Status |
|---|---|
| Browser shell UI (Zen theme) | ✅ Working |
| Tabs: create / close / switch / pin / reorder / persist | ✅ Working |
| Workspaces: create / switch / rename / delete, per-workspace tabs | ✅ Working |
| Bookmarks (add / delete / favorite) + sidebar & home favorites | ✅ Working |
| History (record / search / delete / clear) | ✅ Working |
| Scratchpad notes (local) | ✅ Working |
| Downloads: engine interception, list, per-item delete, clear all | ✅ Working |
| Settings: search engine, HTTPS-first, theme, website dark mode, translation endpoint | ✅ Working |
| Privacy: clear history / downloads / site permissions, permission decisions | ✅ Working |
| Command palette (Ctrl+K), keyboard shortcuts (also while a page has focus) | ✅ Working |
| **Real page browsing** | ✅ Embedded webviews (one per tab, single window) |
| **Search from the address bar** | ✅ Built-in engines + custom engine URL template |
| **Internal pages** `govind://history`, `/downloads`, `/bookmarks`, `/settings` | ✅ Working (full-screen, chrome:// style) |
| Page titles from the live page, live omnibar URL, zoom, print | ✅ Working |
| Find in page (Ctrl+F) with match count, fullscreen (F11), per-domain zoom memory | ✅ Working (the count needs the Windows/WebView2 message channel) |
| Reading list with offline text snapshots (`govind://reading-list`) | ✅ Working |
| Tab search / quick switcher (Ctrl+Shift+A) | ✅ Working |
| New-tab shortcut tiles (bookmark favorites) and custom search URL template | ✅ Working |
| Picture-in-Picture (Alt+Shift+P), per-tab audio mute + speaker indicators (Alt+Shift+M) | ✅ Working (mute is remembered per site across restarts) |
| In-app media controls across loaded tabs (top-level audio/video, including private tabs) | ✅ Working |
| Forced dark mode for websites (Alt+Shift+D), page translation through a configured LibreTranslate endpoint (Alt+Shift+T) | ✅ Working |
| Read Aloud with current-word highlighting (Alt+Shift+R) | ✅ Working |
| Spell check in web forms, print / save-as-PDF (Ctrl+P) | ✅ Working |
| Form autofill profiles (names, addresses, cards — Settings → Autofill) | ✅ Working |
| Secure password generation on focused password fields | ✅ Working |
| Guest mode (all-new-tabs-private session), task manager page | ✅ Working |
| Safe-browsing blocklist warnings, Do Not Track, cosmetic filters, EasyList/EasyPrivacy/uBlock network and cosmetic blocking | ✅ Windows/WebView2 (each filter list refreshes on its upstream 12-hour to 7-day schedule) |
| Forget site data: matching cookies (including HttpOnly), origin storage, IndexedDB, Cache Storage, service workers | ✅ Working (site must be open; reload after) |
| Real favicons from the page, tab context menu (duplicate, pin, mute, close others / right / except pinned) | ✅ Working |
| Bookmarks import / export (Netscape HTML, works with Chrome/Firefox/Edge) | ✅ Working (native OS file dialog, Rust-side parsing) |
| Encrypted browser-data backup / merge restore (`.gbak`) | ✅ Working (PBKDF2 + AES-256-GCM; manual transfer, not automatic sync) |
| Page DevTools (Inspect page), auto-play blocking | ✅ Working |
| PDF viewing | ✅ Handled natively by the system WebView |
| Reader mode, persistent named/collapsible tab groups | ✅ Working |
| Recently closed tabs / undo close (Ctrl+Shift+T) | ✅ Working, persisted across restarts (last 20, never private tabs) |
| Private tabs (Ctrl+Shift+N) | ✅ Incognito webviews; not saved in history or the tab database |
| Protocol Lab | ⏭️ Skipped per product decision (was in milestone 1 scope) |
| Split view, tab sleeping, download resume | ❌ Not in this milestone |
| Media casting, Web Share integration, site push notifications, device emulation | ❌ Not supported by the current WebView2 integration |
| Per-tab identity/cookie isolation, CDP access, extension support | ❌ Needs a Chromium engine (PRD §31) |

### The honest part: web content today

Pages render in **embedded child webviews** — one per tab, created with
`Window::add_child` inside the main window (`src-tauri/src/webview.rs`,
ADR-007). The whole browser is one native window: no stray taskbar entries,
page state survives tab switches, and the engine reports real page titles,
navigation and downloads.

Known limitations (each tracked in `docs/ENGINE_SPIKE.md`):

1. The child-webview API is still marked *unstable* by Tauri, so the desktop
   shell depends on the `unstable` Cargo feature.
2. Creating a WebView2 controller must not happen on the UI thread on Windows,
   so `navigate_tab` is an `async` command (Tauri's async runtime).
3. A page takes the keyboard focus when clicked, so most browser shortcuts are
   registered globally only while the Govind window is focused. PiP uses a
   page-side shortcut so its request retains the video's user gesture.
4. No certificate inspection: "secure connection" in the UI reflects the URL
   scheme only. It is labeled as such in the app.
5. Regular tabs share one WebView2 profile, so per-tab identity/cookie isolation
   is not available yet. Private tabs use WebView2 InPrivate storage and are
   excluded from session restore and the app's history/download records.
6. There is no CDP or general-purpose request mocking. Windows/WebView2 tabs
   install a native request hook for EasyList/EasyPrivacy and uBlock Origin ad,
   tracker, scriptlet and cosmetic filtering. Full list snapshots are shipped
   in the app, so blocking works offline on first launch; the local cache is
   refreshed from the list hosts on each list's declared schedule (uBlock
   quick fixes every 12 hours, EasyList/EasyPrivacy every 4 days). `$removeparam`
   tracking parameters are stripped from document and XHR requests. The hook is
   not available on WebKitGTK or other platforms, does not rewrite response
   bodies, and does not provide Chrome DevTools Protocol features.
7. Reader mode extracts text from common article/main elements; it is a
   lightweight reader view, not a full readability parser. Recently closed
   entries persist in the local database (last 20, private tabs excluded).
8. Forced dark mode uses a CSS filter on pages that appear light; some sites
   may render oddly. Tab mute state is remembered per site for future visits
   and covers page media and Web Audio contexts, but may not control
   cross-origin frames.
9. Translation requires a configured LibreTranslate-compatible server. The
   app sends extracted text only after you start translation; remote endpoints
   require HTTPS and receive the page text. Translation is shown in a simple
   text layout, not the original page layout; authenticated endpoints/API keys
   are not supported.
10. Picture-in-Picture uses the page's video API, so start it with the PiP
    button shown over a video or `Alt+Shift+P` while the page has focus.
11. Read Aloud uses WebView2's installed speech voices and highlights words
    where the engine supports the CSS Custom Highlight API. The password
    generator creates a 24-character password locally on explicit click and
    fills only the focused password field; Govind does not save generated
    passwords.
12. Browser-data transfer is a manual encrypted file, not live cross-device
    sync. It uses a passphrase you must retain; Govind cannot recover it.
    Import merges records and keeps existing conflicting data. Private tabs and
    downloaded file contents are never included.

### Chrome parity boundaries

The installed app uses the system WebView2 runtime, not a separately controlled
Chromium build. Web APIs such as WebCodecs, text fragments, Credential Management, Payment
Request, clipboard, file access, and hardware-device access are runtime-, OS-,
origin-, and policy-dependent; Govind does not emulate Chrome or promise
feature parity for them.
Test those APIs against the supported WebView2 runtime instead of treating
them as app-owned browser features.

Some items are not app features at all but engine components that WebView2 does
not expose to its host, so they cannot be added without replacing the engine
with a full Chromium/CEF build: CDP-driven request mocking and device emulation,
per-tab cookie/identity isolation, Chromecast/Media Router, Web Push, the
accessibility inspector tree, and bfcache control. Others need a provider or
platform service Govind does not ship: cross-device sync, neural TTS voices,
cloud PDF storage, offline translation, and system-level (SMTC) media controls.

The current shell does not expose browser-engine controls for DoH, process/site
isolation policy, bfcache, automatic tab freezing/discard, CDP network mocking,
or extension side panels. The built-in network blocker is limited to Windows
WebView2 and public EasyList/EasyPrivacy rules; it is not real-time cloud threat
detection and cannot guarantee playback on anti-adblock sites.
Cloud-backed threat intelligence,
password-breach monitoring, AI/history services, Google Drive, and cloud speech
voices also need provider integrations that Govind does not currently have.
PDF annotation, full-resource offline archives, and live captions are separate
product subsystems and remain unimplemented; Protocol Lab remains skipped per
product decision.

The blocker uses Brave's `adblock` Rust engine (MPL-2.0) with the public
[EasyList](https://easylist.to/easylist/easylist.txt),
[EasyPrivacy](https://easylist.to/easylist/easyprivacy.txt), and uBlock Origin
filter/scriptlet lists (uBlock filters, quick fixes, unbreak, badware, privacy,
resource abuse). Upstream list headers and attribution are retained in the local
cache and in `src-tauri/filter-assets/manifest.json`.

The custom CSS selector setting remains separate from the built-in network
and cosmetic blocker, which is available only on Windows/WebView2.
Fingerprint randomization and third-party-cookie blocking are not implemented.
“Forget this site” deletes matching HTTP-only and script-visible cookies, then
clears storage for the current origin; some storage deletion can be blocked by
open pages, and the current tab must reload. It does not clear browsing history
or guarantee removal of in-memory page state.

`webview.rs` remains the single engine seam: everything else talks to typed
IPC commands.

## Repository layout

```
govind-browser/
├── ui/                     # The whole frontend — no build step
│   ├── index.html          #   shell: titlebar, sidebar, toolbar, views, panels
│   ├── styles/             #   tokens.css (CSS variables) · app.css (vanilla)
│   ├── js/                 #   ES modules: services/ipc.js routes to Tauri or fallback
│   │   ├── views/internal.js  # govind://history, /downloads, /bookmarks, /settings
│   │   └── views/settings.js  # the settings page (category rail + cards)
│   └── assets/             #   self-hosted fonts, icon, welcome kit
├── src-tauri/              # Rust backend
│   ├── src/webview.rs      #   tab webview manager — the engine seam (ADR-007)
│   ├── src/adblocker.rs    #   filter engine, bundled lists, cache + list updates
│   ├── src/webview2_blocker.rs  # Windows request hook, cosmetic script injection
│   ├── src/commands/       #   typed IPC commands (tabs, workspaces, data, settings,
│   │                       #   backup, bookmarks_io, menu)
│   ├── src/db.rs           #   SQLite (rusqlite bundled) + first-run seed
│   ├── migrations/         #   0001_init.sql (WAL, foreign keys, indexes)
│   ├── filter-assets/      #   offline filter lists + uBlock scriptlet resources
│   └── capabilities/       #   least-privilege: window controls + shell open only
├── tests/                  # node:test unit tests — 53 across 10 files, no npm deps
├── tools/serve.mjs         # zero-dep static server for UI preview
├── tools/build-filter-assets.mjs  # regenerates src-tauri/filter-assets/
└── docs/                   # PRD, engine spike, ADR-006/ADR-007
```

## Internal pages

Like `chrome://` URLs, Govind renders a few pages itself (no webview, no
network):

| URL | Page |
|---|---|
| `govind://history` | Browsing history grouped by day (or by site), with search |
| `govind://downloads` | Download history grouped by day, open file / remove |
| `govind://bookmarks` | Saved bookmarks and favourites |
| `govind://reading-list` | Reading list with offline text snapshots |
| `govind://recently-closed` | Tabs closed during this app session |
| `govind://task-manager` | Observable per-tab state |
| `govind://media-controls` | Audio/video playing across loaded tabs |
| `govind://settings` | Settings: general, appearance, privacy, permissions, about |

Type one into the address bar or use the sidebar / the ⋮ menu.

## Project documentation

- [Feature list and current limitations](feature-list.md)
- [Build and development setup](working.md)
- [Engineering process](process.md)
- [Development workflow](workflow.md)
- [Known problems and current solutions](problems-solutions.md)
- [Backend architecture and privacy boundaries](backend.md)
- [Product requirements](docs/PRD_v2.md)

## Run the UI preview (no Rust needed)

```bash
node tools/serve.mjs        # → http://localhost:8081
npm test                    # 53 unit tests
```

In the browser preview, pages load in an `<iframe>` (sites that forbid framing
won't render — a banner offers "Open in system browser"). All app features,
persistence (via localStorage), theming and the palette work exactly as in the
installed app; the same command names are served by a localStorage fallback.

## Build the real app (Windows target)

Prereqs: Rust (`rustup default stable`), Node 20+, and WebView2 (evergreen —
preinstalled on Windows 11 and recent Windows 10).

```bash
npm install                 # installs @tauri-apps/cli only
npm run tauri:dev           # run in dev mode
npm run tauri:build         # produces an NSIS/MSI installer
```

On Linux, install `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev
libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev
build-essential pkg-config libssl-dev` and `npm run tauri:build` works there too
(the engine tracks the system WebView — WebKitGTK).

### Verifying the Rust side

```bash
cd src-tauri
cargo test                  # 33 tests: URL validation and IPC data commands,
                            #   plus the bundled filter lists and real ad hosts
cargo check
```

`cargo test` builds the ad-blocker engine from the shipped snapshots and asserts
that known ad hosts are blocked, that `cnn.com` and `youtube.com` resolve their
cosmetic rules and scriptlets, and that ordinary first-party requests pass.
The UI side is covered by `npm test` (pure modules) — the command surface itself
is verified by `ui/js/services/fallback-db.js` implementing every command the
shell invokes.

### Driving the real app over CDP

WebView2 exposes Chrome DevTools Protocol when it is started with a debug port,
which makes end-to-end checks possible without any test harness inside the app:

```bash
cd src-tauri
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" \
  ./target/debug/govind-browser.exe
# http://127.0.0.1:9223/json/list lists the shell (http://tauri.localhost/) and
# every open tab as separate page targets.
```

The debug port is off unless that variable is set. Keep it off for normal use:
anything that can reach the port can script every page.

This is how the find-in-page match counter, the persisted recently-closed list
and per-site mute were verified: search a page with a known number of
occurrences (`1 / 8`, advancing to `2 / 8`, `3 / 8`), close a tab and confirm the
entry lands in `settings.recently_closed`, mute a site and confirm
`settings.muted_sites` holds its hostname, then restart and confirm the count
resets to `1 / 8`, the closed tab is still listed, and the site comes back
muted.

## IPC security model

- The trusted UI window holds a **least-privilege capability set**: window
  minimize/maximize/close, `outer-position`/`scale-factor` (to place tab
  webviews), and `shell:allow-open` (open-in-system-browser). Nothing else.
- Remote web content lives in **child webviews with no IPC access** — they load
  remote origins, and Tauri grants the app's commands to local origins only, so
  a page cannot invoke a single Govind command.
- Every command validates input in Rust; URLs are allowlisted to `http(s)://`
  (+ the internal `govind://` pages) — `javascript:`, `file:`, `data:` are
  rejected.
- No telemetry. History, notes, downloads and permissions live only in the local
  SQLite database (`%APPDATA%/com.govind.browser/govind.db` on Windows).
- Browser-data backups are encrypted on-device before the save dialog receives
  their contents. The archive is not uploaded; manually move it between
  devices and keep its passphrase separate.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/Cmd + T | New tab |
| Ctrl/Cmd + W | Close tab |
| Ctrl/Cmd + B | Toggle sidebar |
| Ctrl/Cmd + K | Command palette |
| Ctrl/Cmd + L | Focus address bar |
| Ctrl/Cmd + R | Reload |
| Ctrl/Cmd + D | Bookmark this page |
| Ctrl/Cmd + , | Settings |
| Ctrl/Cmd + H | History page |
| Ctrl/Cmd + J | Downloads page |
| Ctrl/Cmd + 1…9 | Jump to tab N (9 = last) |
| Ctrl/Cmd + Tab / Shift+Tab | Cycle tabs |
| Alt + ← / → | Back / forward |
| Esc | Close palette / panels / menus |

Shortcuts are registered globally **while the Govind window is focused** (a page
has the keyboard focus otherwise) and released when it loses focus, so they
never shadow the same keys in other applications.

## License

MIT. See PRD (`docs/PRD_v2.md`) for the product roadmap and phase gates.

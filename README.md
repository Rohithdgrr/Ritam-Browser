# Govind Browser

> *A fast browser that shows you how the internet works.*

**Status: Milestone 1 — browser shell.** A real Tauri 2 + Rust desktop app with a
plain HTML/CSS/vanilla-JS UI (no frontend build step, no CDN at runtime). Local-first:
SQLite on your disk, zero telemetry, no accounts.

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
| Settings: search engine, HTTPS-first, theme (light/dark), restore-session flag | ✅ Working |
| Privacy: clear history / downloads / site permissions, permission decisions | ✅ Working |
| Command palette (Ctrl+K), keyboard shortcuts (also while a page has focus) | ✅ Working |
| **Real page browsing** | ✅ Embedded webviews (one per tab, single window) |
| **Search from the address bar** | ✅ DuckDuckGo / Google / Bing / Startpage |
| **Internal pages** `govind://history`, `/downloads`, `/bookmarks`, `/settings` | ✅ Working (full-screen, chrome:// style) |
| Page titles from the live page, live omnibar URL, zoom, print | ✅ Working |
| Protocol Lab | ⏭️ Skipped per product decision (was in milestone 1 scope) |
| Reader mode, split view, undo center, finds-in-page | ❌ Not in this milestone |
| Bookmark favicons from the network | ⚠️ Monogram letters only (by design for now) |
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
3. A page takes the keyboard focus when clicked, so browser shortcuts are
   registered as global shortcuts **while the Govind window is focused** and
   released when it loses focus — they never shadow the same keys elsewhere.
4. No certificate inspection: "secure connection" in the UI reflects the URL
   scheme only. It is labeled as such in the app.
5. All tabs share one WebView2 profile, so per-tab identity/cookie isolation is
   not available yet.
6. No CDP access, request interception or response mocking — those need the
   Chromium engine discussed in PRD §31.

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
│   ├── src/commands/       #   typed IPC commands (tabs, workspaces, data, settings)
│   ├── src/db.rs           #   SQLite (rusqlite bundled) + first-run seed
│   ├── migrations/         #   0001_init.sql (WAL, foreign keys, indexes)
│   └── capabilities/       #   least-privilege: window controls + shell open only
├── tests/                  # node:test unit tests (no npm deps needed)
├── tools/serve.mjs         # zero-dep static server for UI preview
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
| `govind://settings` | Settings: general, appearance, privacy, permissions, about |

Type one into the address bar or use the sidebar / the ⋮ menu.

## Run the UI preview (no Rust needed)

```bash
node tools/serve.mjs        # → http://localhost:8081
npm test                    # 27 unit tests
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
cargo test                  # unit tests (URL validation boundary)
cargo check
```

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

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/Cmd + T | New tab |
| Ctrl/Cmd + W | Close tab |
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

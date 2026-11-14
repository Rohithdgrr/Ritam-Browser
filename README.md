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
| Downloads list (record / clear / open folder not yet) | ✅ Working, see caveats |
| Settings: search engine, HTTPS-first, theme (light/dark), restore-session flag | ✅ Working |
| Privacy: clear history / downloads / site permissions, permission decisions | ✅ Working |
| Command palette (Ctrl+K), keyboard shortcuts | ✅ Working |
| **Real page browsing** | ⚠️ Interim engine (see below) |
| Protocol Lab | ⏭️ Skipped per product decision (was in milestone 1 scope) |
| Reader mode, split view, undo center, finds-in-page | ❌ Not in this milestone |
| Bookmark favicons from the network | ⚠️ Monogram letters only (by design for now) |

### The honest part: web content today

Milestone 1 renders pages in **frameless native windows positioned over the app's
content region** (`src-tauri/src/webview.rs`) — the only approach built on stable
Tauri 2 APIs. It works: pages navigate, back/forward/reload work via injected JS,
tab switching hides/shows windows.

Known limitations (each tracked in `docs/ENGINE_SPIKE.md`):

1. Keyboard focus can sit in either the chrome window or the page window.
2. Tab pages are separate native windows — they do not minimize with the main
   window on every platform and can linger on the desktop.
3. No certificate inspection: "secure connection" in the UI reflects the URL
   scheme only. It is labeled as such in the app.
4. Download interception is not wired to the webview yet — the Downloads panel
   records user-initiated downloads (e.g. the welcome kit) and reflects what the
   app has downloaded.
5. Tab titles/favicons are derived from the URL, not the live page, until the
   engine exposes them.

**This is deliberate.** PRD §6/§31 requires a multi-webview feasibility spike
*before* committing to child webviews (single window, embedded views) or a
Chromium-based engine. The spike is documented in `docs/ENGINE_SPIKE.md` and
`docs/ADR-006-engine-strategy.md`. `webview.rs` is the single seam to change.

## Repository layout

```
govind-browser/
├── ui/                     # The whole frontend — no build step
│   ├── index.html          #   shell: titlebar, sidebar, toolbar, views, panels, modals
│   ├── styles/             #   tokens.css (CSS variables) · app.css (vanilla)
│   ├── js/                 #   ES modules: services/ipc.js routes to Tauri or fallback
│   └── assets/             #   self-hosted fonts, icon, welcome kit
├── src-tauri/              # Rust backend
│   ├── src/webview.rs      #   tab window manager — the engine seam
│   ├── src/commands/       #   typed IPC commands (tabs, workspaces, data, settings)
│   ├── src/db.rs           #   SQLite (rusqlite bundled) + first-run seed
│   ├── migrations/         #   0001_init.sql (WAL, foreign keys, indexes)
│   └── capabilities/       #   least-privilege: window controls + shell open only
├── tests/                  # node:test unit tests (no npm deps needed)
├── tools/serve.mjs         # zero-dep static server for UI preview
└── docs/                   # PRD, engine spike plan, ADR-006
```

## Run the UI preview (no Rust needed)

```bash
node tools/serve.mjs        # → http://localhost:8081
node --test tests/          # 27 unit tests
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
  minimize/maximize/close, `outer-position`/`scale-factor` (to place tab windows),
  and `shell:allow-open` (open-in-system-browser). Nothing else.
- Remote web content lives in **separate windows with no IPC access** — it cannot
  invoke a single Govind command.
- Every command validates input in Rust; URLs are allowlisted to
  `http(s)://` (+ `govind://home`) — `javascript:`, `file:`, `data:` are rejected.
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
| Ctrl/Cmd + 1…9 | Jump to tab N (9 = last) |
| Ctrl/Cmd + Tab / Shift+Tab | Cycle tabs |
| Alt + ← / → | Back / forward |
| Esc | Close palette / settings / panels / menus |

## License

MIT. See PRD (`docs/PRD_v2.md`) for the product roadmap and phase gates.

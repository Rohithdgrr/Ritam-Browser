# Backend Architecture

## Overview

The desktop backend is a Rust library hosted by Tauri 2. The frontend uses
typed command invocations; native browser pages are managed by a dedicated
webview adapter. Persistent application data is stored in a local SQLite
database.

```text
Trusted shell UI (ui/)
        |
        | Tauri invoke / events
        v
Rust commands (src-tauri/src/commands/)
        |                         |
        v                         v
SQLite (db.rs, migrations/)   TabWebviewManager (webview.rs)
                                  |
                                  v
                         Native system webview per tab
```

## Main components

- `src-tauri/src/lib.rs`: application setup, managed state, event wiring, IPC
  command registration, and global shortcuts.
- `src-tauri/src/commands/`: typed command handlers grouped by responsibility:
  tabs, workspaces, data, settings, backups, bookmarks import/export, and
  native menus.
- `src-tauri/src/webview.rs`: creates, positions, shows, hides, navigates, and
  closes native child webviews; handles page events and browser integrations.
- `src-tauri/src/adblocker.rs`: network and cosmetic filter engine (Brave's
  `adblock` crate), the bundled list snapshots, the engine cache, per-list
  upstream refresh, and the block / stub / re-target decision for a request.
- `src-tauri/src/webview2_blocker.rs` (Windows only): the WebView2 request hook,
  document-start script injection for cosmetic rules and scriptlets, and the
  class/id report channel that resolves generic selectors.
- `src-tauri/filter-assets/`: offline EasyList, EasyPrivacy and uBlock Origin
  snapshots plus the uBlock scriptlet/redirect resources and a manifest with
  upstream attribution. `tools/build-filter-assets.mjs` regenerates it.
- `src-tauri/src/db.rs`: resolves the application data directory, opens SQLite,
  enables WAL and foreign keys, applies the embedded schema, and seeds initial
  workspace/bookmark data.
- `src-tauri/migrations/0001_init.sql`: tables for workspaces, tabs,
  bookmarks, history, notes, downloads, settings, site permissions, and the
  reading list.
- `ui/js/services/ipc.js`: frontend command wrapper and local preview fallback.

## Data and privacy

The database file is `govind.db` in Tauri's application data directory
(`%APPDATA%/com.govind.browser/govind.db` on Windows). The app has no telemetry
or account service. Web browsing itself necessarily connects to the sites the
user visits. Translation additionally sends extracted page text to the
configured translation endpoint only after the user requests translation.

Private tabs use the WebView2 InPrivate profile and are not written to the
application's tab, history, or download records. This does not make a private
session invisible to websites, network providers, or operating-system
monitoring. Regular tabs share the default webview profile.

Browser-data portability is manual, not cloud sync. The trusted shell encrypts
the database snapshot with PBKDF2-HMAC-SHA-256 (600,000 iterations) and
AES-256-GCM using a random salt and IV before passing the archive to native
file I/O. Import decrypts locally, validates the versioned payload in Rust,
then merges it in one SQLite transaction. Existing records win ID/URL
conflicts; history uses the newest visit time and larger visit count. Private
tabs and downloaded file contents are excluded. The passphrase is never saved
or recoverable.

## Trust boundaries

- App commands are registered for the trusted local shell, not remote
  websites.
- Rust commands validate inputs before database or native operations.
- Navigation accepts supported web URLs and the application's internal
  `govind://` pages; unsafe schemes are rejected.
- Bookmark import parses Netscape-format HTML in the backend and uses the
  native file dialog for file selection.
- Native feature availability and behavior can vary with WebView2 on Windows
  and WebKitGTK on Linux.

## Engine constraints

The app uses the system webview, not an embedded full Chromium distribution.
The current integration does not provide Chromium DevTools Protocol, extension
compatibility, or per-tab CPU/memory reporting. Request handling is limited to
a Windows/WebView2 hook that can block a request, serve an inert stand-in, or
re-target its URL; it cannot rewrite a response body, inject CSP headers, or
intercept WebSocket frames. The embedded child-webview API is enabled
through Tauri's `unstable` feature. See `docs/ADR-007-embedded-webviews.md`
and `docs/ENGINE_SPIKE.md` for rationale and open measurements.

## Ad and tracker blocking

The blocker is on-device and list-driven. Full EasyList, EasyPrivacy and uBlock
Origin snapshots are compiled into the binary, so a fresh install filters
before it makes any network request. On launch the cached lists in the
application data directory (`filter-lists/`) are validated and used when they
are still current; a background updater re-fetches a list only when its own
`! Expires:` header says it is due (12 hours for uBlock quick fixes, up to
7 days for others) and rebuilds the engine once per change.

The serialized engine is cached as `engine.dat` with a key that covers the list
contents, the uBlock resource bodies and the engine version, so changed
scriptlets invalidate it. Only the uBlock lists are parsed with the permission
bit that allows trusted scriptlets; EasyList and EasyPrivacy are parsed without
permissions. Blocking, `$removeparam` re-targeting and cosmetic updates apply to
open tabs without a reload, while paused blocking or a per-site allowlist entry
takes effect immediately.

All decisions stay in the browser process: lists are fetched from their public
hosts, no page URL is reported anywhere, and blocked/redirected counters are
per-session only. The network hook exists only on Windows/WebView2; other
platforms keep the custom CSS cosmetic filter and no network filtering.

## Frontend preview

`ui/js/services/ipc.js` selects a localStorage-backed fallback when running
outside Tauri. This keeps most shell features usable during UI development,
but it cannot reproduce native webview lifecycle, permissions, popup menus,
downloads, or platform engine behavior.

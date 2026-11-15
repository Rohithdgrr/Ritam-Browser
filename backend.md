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
The current integration does not provide Chromium DevTools Protocol, general
request interception, response mocking, extension compatibility, or
per-tab CPU/memory reporting. The embedded child-webview API is enabled
through Tauri's `unstable` feature. See `docs/ADR-007-embedded-webviews.md`
and `docs/ENGINE_SPIKE.md` for rationale and open measurements.

## Frontend preview

`ui/js/services/ipc.js` selects a localStorage-backed fallback when running
outside Tauri. This keeps most shell features usable during UI development,
but it cannot reproduce native webview lifecycle, permissions, popup menus,
downloads, or platform engine behavior.

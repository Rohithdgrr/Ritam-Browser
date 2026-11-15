# Backend Architecture

> Technical documentation for the Ritam Browser Rust backend.

---

## 1. Architecture Overview

The Ritam Browser backend is a Rust library built on Tauri 2. It provides a secure bridge between the frontend UI and native platform features, including webview management, data persistence, and ad blocking.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Trusted Shell UI (ui/)                       │
│                    HTML/CSS/JavaScript Frontend                  │
└─────────────────────────────────────────────────────────────────┘
                                │
                    Tauri invoke / events
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│                    Rust Commands (src-tauri/)                    │
│           tabs │ workspaces │ settings │ data │ profiles        │
└─────────────────────────────────────────────────────────────────┘
                │                                       │
                v                                       v
┌──────────────────────────┐       ┌────────────────────────────────┐
│      SQLite Database     │       │    TabWebviewManager           │
│     (db.rs + migrations) │       │       (webview.rs)             │
│                          │       │                                │
│  Workspaces, tabs,       │       │  Creates, positions, shows,    │
│  bookmarks, history,     │       │  hides, navigates native       │
│  downloads, settings     │       │  child webviews per tab        │
└──────────────────────────┘       └────────────────────────────────┘
```

---

## 2. Component Reference

### 2.1 Core Application

| File | Responsibility |
|------|----------------|
| `src-tauri/src/lib.rs` | Application setup, managed state, event wiring, IPC command registration, global shortcuts |

### 2.2 Command Handlers

| File | Responsibility |
|------|----------------|
| `src-tauri/src/commands/*.rs` | Typed command handlers grouped by domain: tabs, workspaces, data, settings, backups, bookmarks import/export, native menus |

### 2.3 Webview Management

| File | Responsibility |
|------|----------------|
| `src-tauri/src/webview.rs` | Creates, positions, shows, hides, navigates, and closes native child webviews; handles page events and browser integrations |

### 2.4 Profiles & Workspaces

| File | Responsibility |
|------|----------------|
| `src-tauri/src/commands/profiles.rs` | Local profiles (name, email label, colour), default-profile bootstrap, workspace scoping for per-profile tab sessions |

### 2.5 Ad Blocking

| File | Responsibility |
|------|----------------|
| `src-tauri/src/adblocker.rs` | Network and cosmetic filter engine (Brave's `adblock` crate), bundled list snapshots, cache management, per-list refresh, block/stub/redirect decisions |
| `src-tauri/src/webview2_blocker.rs` | Windows-only: WebView2 request hook, document-start script injection, class/id resolution for generic selectors |

### 2.6 Data Layer

| File | Responsibility |
|------|----------------|
| `src-tauri/src/db.rs` | Resolves app data directory, opens SQLite, enables WAL and foreign keys, applies schema, seeds initial data |
| `src-tauri/migrations/0001_init.sql` | Database schema: workspaces, tabs, bookmarks, history, notes, downloads, settings, site permissions, reading list |
| `src-tauri/filter-assets/` | Offline EasyList, EasyPrivacy, uBlock Origin snapshots; uBlock scriptlet/redirect resources; manifest with upstream attribution |

### 2.7 Frontend Service

| File | Responsibility |
|------|----------------|
| `ui/js/services/ipc.js` | Frontend command wrapper with localStorage-backed fallback for UI preview |

---

## 3. Data & Privacy Model

### 3.1 Storage Location

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%/com.govind.browser/govind.db` |
| Linux | `~/.local/share/com.govind.browser/govind.db` |

### 3.2 Privacy Principles

- **No Telemetry:** The application sends no usage data to external servers
- **No Accounts:** No sign-in, no cloud sync, no account-related network calls
- **Local Storage:** All data persisted in local SQLite database
- **Translation:** Page text sent to configured endpoint only when user requests translation

### 3.3 Private Tabs

Private tabs utilize WebView2 InPrivate profile with the following characteristics:

| Behavior | Regular Tabs | Private Tabs |
|----------|--------------|--------------|
| Stored in tab database | Yes | No |
| Recorded in history | Yes | No |
| Appears in downloads | Yes | No |
| WebView2 profile | Default | InPrivate |

> **Note:** Private tabs do not make sessions invisible to websites, network providers, or OS-level monitoring.

### 3.4 Profile System

| Aspect | Behavior |
|--------|----------|
| Profile Storage | Local records in `profiles` table |
| Workspace Link | `workspaces.profile_id` foreign key |
| Active Profile | `settings.active_profile_id` |
| Email Column | Display label only; no network calls |
| Data Sharing | Bookmarks, history, downloads, reading list are global across profiles |

### 3.5 Session State Persistence

The following state survives restarts via the settings table:

| Setting | Purpose | Limit |
|---------|---------|-------|
| `recently_closed` | Last 20 closed tabs | Private tabs never recorded |
| `muted_sites` | User-muted hostnames | Capped at 200 entries |

---

## 4. Platform Support

### 4.1 Supported Platforms

| Platform | Web Engine | Network Filtering | Status |
|----------|------------|-------------------|--------|
| **Windows** | WebView2 | Yes (request hook) | Primary |
| **Linux** | WebKitGTK | No | Secondary |
| **Android** | Not supported | N/A | Not available |
| **iOS** | Not supported | N/A | Not available |

### 4.2 Platform-Specific Notes

**Windows:**
- Uses WebView2 with native request hook for ad blocking
- Supports cosmetic filter injection via scriptlets

**Linux:**
- Uses WebKitGTK
- Custom CSS cosmetic filters work
- Network-level blocking not available (no hook)

### 4.3 Build Targets

The engine seam uses Tauri's multi-webview API (`Window::add_child`), which is only available for desktop targets. This is why Android and iOS builds are not supported.

---

## 5. Release & CI/CD

### 5.1 Build Pipeline

| Trigger | Platforms | Outputs |
|---------|-----------|---------|
| Push/PR (main branch) | Windows, Ubuntu | Test results |
| Release tag (`v*`) | Windows, Ubuntu | `.exe`, `.msi`, `.deb`, `.AppImage` |

### 5.2 Workflow Files

| Workflow | File | Purpose |
|----------|------|---------|
| CI | `.github/workflows/ci.yml` | Run tests on Windows and Ubuntu |
| Release | `.github/workflows/release.yml` | Build and publish installers |

---

## 6. Security Model

### 6.1 Trust Boundaries

| Boundary | Implementation |
|----------|----------------|
| Command Registration | App commands registered for trusted local shell only |
| Input Validation | Rust commands validate all inputs before database or native operations |
| URL Validation | Navigation accepts `http://`, `https://`, and `govind://` pages; unsafe schemes rejected |
| Bookmark Import | Parses Netscape-format HTML in backend; uses native file dialog |
| Web Content | Child webviews have no IPC access to app commands |

### 6.2 Data Portability

Browser data export uses encrypted archives rather than cloud sync:

| Aspect | Implementation |
|--------|----------------|
| Encryption | PBKDF2-HMAC-SHA-256 (600,000 iterations) + AES-256-GCM |
| Salt/IV | Randomly generated for each archive |
| Import | Decrypts locally, validates versioned payload, merges in single transaction |
| Conflict Resolution | Existing records win ID/URL conflicts; history uses newest visit time |
| Exclusions | Private tabs and downloaded file contents never included |

---

## 7. Engine Constraints

The browser uses the system webview, not an embedded Chromium distribution.

### 7.1 Available Features

| Feature | Windows | Linux |
|---------|---------|-------|
| Child webviews (multi-tab) | ✅ | ✅ |
| Navigation events | ✅ | ✅ |
| Download interception | ✅ | ✅ |
| Permission handling | ✅ | ✅ |
| Page titles | ✅ | ✅ |

### 7.2 Unavailable Features

| Feature | Reason |
|---------|--------|
| Chromium DevTools Protocol | Not exposed by WebView2/WebKitGTK |
| Extension Support | Requires Chromium engine |
| Per-Tab CPU/Memory Reporting | Not available |
| Response Body Rewrite | Hook cannot modify responses |
| CSP Header Injection | Not supported |
| WebSocket Frame Interception | Not available |
| bfcache Control | Not exposed by engine |

### 7.3 Unstable API

The embedded child-webview API requires Tauri's `unstable` feature. This is documented in `docs/ADR-007-embedded-webviews.md`.

---

## 8. Ad & Content Blocking

### 8.1 Filter Lists

The blocker ships with these pre-compiled lists:

| List | Update Frequency | Type |
|------|------------------|------|
| EasyList | Up to 7 days | Network + cosmetic |
| EasyPrivacy | Up to 7 days | Network |
| uBlock Filters | 12 hours | Network + cosmetic |
| uBlock Quick Fixes | 12 hours | Network |
| uBlock Unbreak | As scheduled | Network |
| uBlock Badware | As scheduled | Network |

### 8.2 Blocking Mechanism

| Component | Windows | Linux |
|-----------|---------|-------|
| Network blocking | ✅ (WebView2 hook) | ❌ |
| Cosmetic filters | ✅ | ✅ (CSS only) |
| Scriptlet injection | ✅ | ❌ |
| `$removeparam` | ✅ | ❌ |

### 8.3 Caching Strategy

1. **First Launch:** Uses compiled-in list snapshots (works offline)
2. **Subsequent Launches:** Validates cached lists against upstream `! Expires:` headers
3. **Background Update:** Re-fetches only when cache is stale
4. **Engine Cache:** Serialized as `engine.dat` with content key; invalidated on list changes

### 8.4 Blocking Behavior

- Decisions made entirely in-browser process
- No page URLs reported externally
- Blocked/redirected counters are session-only
- Updates apply to open tabs without reload
- Per-site allowlist takes effect immediately

---

## 9. Frontend Preview Mode

### 9.1 Local Development

When running outside Tauri (e.g., `npm run dev`), the frontend uses a localStorage fallback:

| Feature | Tauri Mode | Preview Mode |
|---------|------------|--------------|
| Native webview | ✅ | ❌ |
| Tab lifecycle | ✅ | Limited |
| Downloads | ✅ | ❌ |
| Permissions | ✅ | ❌ |
| Popup menus | ✅ | ❌ |
| Platform behavior | ✅ | ❌ |

### 9.2 Command Compatibility

Most shell commands work identically in both modes. Native-specific features (webview management, downloads, platform dialogs) gracefully degrade in preview mode.

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [Feature List](feature-list.md) | Complete feature inventory |
| [Product Requirements](docs/PRD_v2.md) | Product roadmap |
| [Engine Strategy ADR](docs/ADR-006-engine-strategy.md) | Engine architecture decision |
| [Embedded WebViews ADR](docs/ADR-007-embedded-webviews.md) | WebView integration design |
| [Engine Spike](docs/ENGINE_SPIKE.md) | Feasibility analysis |

---

*Last Updated: November 2026*
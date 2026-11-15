# Ritam Browser — Feature Implementation Status

> **Document Version:** 1.0  
> **Last Updated:** November 2026  
> **Product Name:** Ritam Browser  
> **Technology Stack:** Tauri 2, Rust, Vanilla HTML/CSS/JavaScript (No Build Step)

---

## Executive Summary

This document provides a comprehensive inventory of all features planned for Ritam Browser, categorized by their current implementation status. The browser is built as a local-first, privacy-oriented desktop application using Tauri 2 with Rust backend and a vanilla JavaScript frontend.

---

## Part I: Fully Implemented Features

### 1. Core Browser Functionality

| Feature | Description | Status |
|---------|-------------|--------|
| **Embedded WebViews** | Native child webviews (one per tab) within a single window using Tauri's `Window::add_child` API | ✅ Complete |
| **Tab Management** | Create, activate, close, duplicate, pin, reorder, and group tabs | ✅ Complete |
| **Tab Context Menu** | Right-click actions: reload, duplicate, open in private, pin/unpin, mute/unmute, add to group, remove from group, close, close others, close to the right | ✅ Complete |
| **Split View** | Two tabs side by side; the right pane follows the most recently used other tab and can be swapped | ✅ Complete |
| **Tab Sleeping** | Idle tabs release their webview after a user-set interval and reload when activated | ✅ Complete |
| **Recently Closed Tabs** | Persisted across restarts (last 20 entries; private tabs never recorded); undo centre restores tab and group | ✅ Complete |
| **Smart Tab Suggestions** | Suggests grouping three or more loose tabs from one site, and closing duplicate URLs | ✅ Complete |
| **Navigation Controls** | Back, forward, reload, home buttons in toolbar | ✅ Complete |
| **Address Bar (Omnibar)** | Real-time URL display, search integration, engine selection | ✅ Complete |
| **Page Titles** | Live page titles displayed in tabs and window | ✅ Complete |
| **Favicons** | Real favicons fetched from pages with fallback to generated monograms | ✅ Complete |
| **Fullscreen Mode** | F11 toggle to hide all browser chrome | ✅ Complete |
| **Find in Page** | Ctrl+F search with live match count display | ✅ Complete |
| **Zoom Controls** | Per-domain zoom memory, zoom in/out/reset shortcuts | ✅ Complete |
| **Print / Save as PDF** | Ctrl+P for printing and PDF export | ✅ Complete |
| **Controlled Pop-ups** | Open as browser tabs (not new windows) | ✅ Complete |
| **PDF Viewing** | Handled natively by system WebView | ✅ Complete |
| **Page Inspection** | DevTools support via Inspect page action | ✅ Complete |

### 2. Privacy & Security

| Feature | Description | Status |
|---------|-------------|--------|
| **HTTPS-First Mode** | Automatic upgrade to secure connections | ✅ Complete |
| **Private Tabs** | WebView2 InPrivate storage; excluded from history/downloads | ✅ Complete |
| **Guest Mode** | All new tabs open privately for the session | ✅ Complete |
| **Clear Browsing Data** | Clear history, downloads, cookies, permissions | ✅ Complete |
| **Forget This Site** | Delete matching cookies, origin storage, IndexedDB, Cache Storage, service workers | ✅ Complete |
| **Website Permissions** | Per-site permission decisions (camera, microphone, etc.) | ✅ Complete |
| **Do Not Track** | Header sent with requests | ✅ Complete |
| **No Telemetry** | Zero data sent to external servers | ✅ Complete |
| **Safe Browsing** | Blocklist warnings for known threats | ✅ Complete |
| **Security Indicator** | URL scheme-based (http/https) displayed in address bar | ✅ Complete |

### 3. Ad & Content Blocking

| Feature | Description | Status |
|---------|-------------|--------|
| **Network Filtering** | Windows/WebView2 request hook for EasyList, EasyPrivacy | ✅ Complete |
| **Cosmetic Filters** | CSS selector-based element hiding | ✅ Complete |
| **Scriptlet Injection** | uBlock Origin scriptlets for advanced blocking | ✅ Complete |
| **Filter List Updates** | Scheduled refresh (uBlock quick fixes: 12hr, EasyList/EasyPrivacy: 4 days) | ✅ Complete |
| **Per-Site Allowlist** | Disable blocking for specific domains | ✅ Complete |
| **Session Pause** | Toggle to temporarily disable all blocking | ✅ Complete |

### 4. Organization & Productivity

| Feature | Description | Status |
|---------|-------------|--------|
| **Workspaces** | Create, switch, rename, delete; each with independent tabs | ✅ Complete |
| **Bookmarks** | Add, delete, favorite with sidebar and home page display | ✅ Complete |
| **Bookmark Tags** | Up to 8 comma-separated tags per bookmark, edited from `govind://bookmarks` | ✅ Complete |
| **Bookmark Notes** | A personal note (1000 characters) attached to any bookmark | ✅ Complete |
| **Bookmark Folders** | Optional folder label per bookmark; Chromium/Safari imports keep their folder path | ✅ Complete |
| **Bookmark Search** | One search box matches title, URL, tags, notes and folder, with a folder filter | ✅ Complete |
| **Favorites** | Quick-access grid on home page | ✅ Complete |
| **History** | Recorded, searchable, deletable, clearable | ✅ Complete |
| **Advanced History Search** | Keyword, domain and date-range filters, grouped by day or domain | ✅ Complete |
| **Downloads** | Engine interception, list view, per-item delete, clear all, download again | ✅ Complete |
| **Download Scan Integration** | Windows Defender scans finished files on request or before opening; threats warn and block the open, nothing is deleted | ✅ Complete (Windows) |
| **Website Time Tracking** | 30-second heartbeat per active-tab site while the window has focus, stored per profile and day | ✅ Complete |
| **Browsing Statistics** | `govind://statistics` shows today / 7-day / 30-day totals, a per-day breakdown and the busiest sites | ✅ Complete |
| **Custom New Tab Dashboard** | Clock, time-today and website-shortcut widgets; search stays in the page | ✅ Complete |
| **Website Shortcuts** | Up to 12 custom quick buttons shown on the new-tab page | ✅ Complete |
| **Scratchpad** | Local notes saved to device | ✅ Complete |
| **Reading List** | Offline text snapshots of pages | ✅ Complete |
| **Tab Groups** | Named, collapsible, persistent tab grouping | ✅ Complete |
| **Quick Popovers** | Anchored panels for downloads, history, bookmarks, media, print | ✅ Complete |
| **Command Palette** | Ctrl+K for commands, tabs, bookmarks, history search | ✅ Complete |
| **Tab Search** | Ctrl+Shift+A for quick tab switching | ✅ Complete |

### 5. Profiles & Accounts

| Feature | Description | Status |
|---------|-------------|--------|
| **Local Profiles** | Name, optional Gmail-style label, color | ✅ Complete |
| **Profile Switcher** | Chrome-style chip and dropdown in toolbar | ✅ Complete |
| **Profile Isolation** | Workspaces, tabs, bookmarks, history, reading list, notes, downloads, site permissions, settings and auto-fill data scoped by `profile_id`; each profile also gets its own engine data folder | ✅ Complete |
| **Inline Profile Creation** | Create profiles without leaving the UI | ✅ Complete |
| **Profiles Page** | `govind://profiles`: rename, set default, switch, delete (with its data) | ✅ Complete |
| **Browser Import** | Bookmarks and history from Chrome, Edge, Brave, Firefox (Safari on macOS); source opened read-only from a temp copy and never written; partial imports reported per category | ✅ Complete |
| **Password Import** | Never attempted: source stores are encrypted — reported as skipped in the import result | ⏭️ Skipped |
| **Profile Sync** | No account service exists to sync through | ⏭️ Skipped |

### 6. Reading & Accessibility

| Feature | Description | Status |
|---------|-------------|--------|
| **Reader Mode** | Text extraction from article elements | ✅ Complete |
| **Read Aloud** | Text-to-speech with word highlighting | ✅ Complete |
| **Picture-in-Picture** | Alt+Shift+P to float video | ✅ Complete |
| **Translation** | Via configured LibreTranslate endpoint | ✅ Complete |
| **Spell Check** | System spellcheck in web forms | ✅ Complete |
| **Forced Dark Mode** | CSS filter for light-themed websites | ✅ Complete |

### 7. Media & Audio

| Feature | Description | Status |
|---------|-------------|--------|
| **Audio Indicators** | Speaker icon on tabs with audio | ✅ Complete |
| **Per-Tab Mute** | Alt+Shift+M toggle | ✅ Complete |
| **Per-Site Mute Memory** | Remember muted sites across restarts | ✅ Complete |
| **Media Controls Page** | `govind://media-controls` for all playing media | ✅ Complete |
| **Cross-Tab Audio** | Control audio/video across all loaded tabs | ✅ Complete |

### 8. Forms & Passwords

| Feature | Description | Status |
|---------|-------------|--------|
| **Form Autofill** | Names, emails, phones and addresses per profile (`govind://autofill`) | ✅ Complete |
| **Fill On Request** | Ctrl+Shift+L pushes this profile's entries into the focused tab only; the page script discards a payload whose origin differs from the tab URL Rust read | ✅ Complete |
| **Password Generator** | 24-character secure password generation on click | ✅ Complete |
| **Autofill Storage** | `autofill.json` in the profile folder, 0600 on Unix, **not encrypted** — stated in the UI | ✅ Complete |
| **Payment Card Autofill** | Card number fields are no longer recognised or stored | ⏭️ Skipped |
| **Password Manager** | Needs an encrypted vault; not built | ⏭️ Skipped |

### 9. Data Management

| Feature | Description | Status |
|---------|-------------|--------|
| **Bookmark Import** | Netscape HTML format (Chrome/Firefox/Edge compatible) | ✅ Complete |
| **Bookmark Export** | Netscape HTML format | ✅ Complete |
| **Encrypted Backup** | `.gbak` files with PBKDF2 + AES-256-GCM | ✅ Complete |
| **Backup Restore** | Merge restore with conflict handling | ✅ Complete |
| **Backup Coverage** | Bookmarks (including tags, notes and folders), history, tabs, notes, downloads and settings | ✅ Complete |
| **Task Manager** | `govind://task-manager` showing per-tab states | ✅ Complete |

### 10. Settings & Configuration

| Feature | Description | Status |
|---------|-------------|--------|
| **Unified Settings Page** | `govind://settings` with all sections | ✅ Complete |
| **Search Engine Config** | Built-in engines + custom URL template | ✅ Complete |
| **Theme Toggle** | Light/dark mode switch | ✅ Complete |
| **Settings Search** | Filter box to find settings quickly | ✅ Complete |
| **Jump Rail Navigation** | Left-side navigation for settings sections | ✅ Complete |
| **Download Settings** | Sort files into folders, rename with `{name}`/`{ext}`/`{host}`/`{date}`, scan on open | ✅ Complete |
| **New Tab Settings** | Choose dashboard widgets and manage website shortcuts | ✅ Complete |
| **Keyboard Settings** | Record custom combos for browser actions, validated by the backend | ✅ Complete |

### 11. Internal Pages

| Page | URL | Status |
|------|-----|--------|
| History | `govind://history` | ✅ Complete |
| Downloads | `govind://downloads` | ✅ Complete |
| Bookmarks | `govind://bookmarks` | ✅ Complete |
| Reading List | `govind://reading-list` | ✅ Complete |
| Undo Centre | `govind://recently-closed` | ✅ Complete |
| Statistics | `govind://statistics` | ✅ Complete |
| Inspector | `govind://inspector` | ✅ Complete (Windows/WebView2) |
| Task Manager | `govind://task-manager` | ✅ Complete |
| Media Controls | `govind://media-controls` | ✅ Complete |
| Settings | `govind://settings` | ✅ Complete |

### 12. Responsive Design

| Feature | Description | Status |
|---------|-------------|--------|
| **Sidebar Collapse** | Drawer mode below 700px | ✅ Complete |
| **Bottom Sheet Panels** | Below 520px width | ✅ Complete |
| **Window Minimum** | 480×420 pixels | ✅ Complete |
| **Home Page Reflow** | Favorites grid adapts to viewport | ✅ Complete |

### 13. Keyboard Shortcuts

| Shortcut | Action | Status |
|----------|--------|--------|
| Ctrl+T | New tab | ✅ Complete |
| Ctrl+W | Close tab | ✅ Complete |
| Ctrl+Shift+T | Reopen closed tab | ✅ Complete |
| Ctrl+B | Toggle sidebar | ✅ Complete |
| Ctrl+K | Command palette | ✅ Complete |
| Ctrl+L | Focus address bar | ✅ Complete |
| Ctrl+R | Reload | ✅ Complete |
| Ctrl+D | Bookmark | ✅ Complete |
| Ctrl+, | Settings | ✅ Complete |
| Ctrl+H | History | ✅ Complete |
| Ctrl+J | Downloads | ✅ Complete |
| Ctrl+1-9 | Jump to tab | ✅ Complete |
| Ctrl+Tab | Next tab | ✅ Complete |
| Ctrl+Shift+Tab | Previous tab | ✅ Complete |
| Alt+←/→ | Back/Forward | ✅ Complete |
| F11 | Fullscreen | ✅ Complete |
| Esc | Close palette/panels/menus | ✅ Complete |
| Custom combos | Settings → Keyboard records a combo, shows the built-in as a placeholder, rejects conflicts, and registers the override as a native accelerator so it also works while a page has focus | ✅ Complete |

### 14. Developer Workbench

| Feature | Description | Status |
|---------|-------------|--------|
| **Network Inspector** | `govind://inspector` lists fetch, XHR and resource requests for a chosen tab, newest first | ✅ Complete (Windows/WebView2) |
| **Request Details** | Method, URL, status, duration, type, content type, size and start time | ✅ Complete |
| **Response Viewer** | Captured text/JSON bodies are shown with JSON pretty-printing | ✅ Complete |
| **cURL Export** | Copy a captured request as a shell-safe cURL command | ✅ Complete |
| **Fetch Export** | Copy a captured request as a JavaScript `fetch()` call | ✅ Complete |
| **API Request Replay** | Replay a captured method/URL/headers/body from Rust with a 25-second timeout and a 200 KB response cap | ✅ Complete |
| **Request Mocking** | Per-tab URL-substring rules return a synthetic status/body for fetch and XHR while capture is on | ✅ Complete |
| **Console Capture** | `console.log/info/warn/error/debug` output is recorded with level and time | ✅ Complete |
| **Error Monitoring** | Uncaught exceptions and unhandled promise rejections appear in the Errors tab | ✅ Complete |
| **DOM Snapshot** | Serialises the rendered DOM (up to 200 KB) as display-only text | ✅ Complete |

### 15. Local File Viewer

| Feature | Description | Status |
|---------|-------------|--------|
| **File Previews** | `govind://viewer` opens images, video, PDF, DOCX, XLSX, PPTX, CSV, JSON, Markdown and text; files are read through a 64 MB, extension-allowlisted Rust command | ✅ Complete |
| **Office Parsing** | DOCX and XLSX are parsed in the renderer with a small built-in ZIP reader; PPTX shows a slide-by-slide text outline (not slide design) | ✅ Complete |
| **File Picker** | Native dialog filtered to viewable extensions; preview mode explains that local files need the installed app | ✅ Complete |

---

## Part II: Partially Implemented Features

### 1. Network Filtering

| Feature | Limitation | Status |
|---------|------------|--------|
| **Ad Blocking** | Windows/WebView2 only; Linux uses WebKitGTK without hook | 🟡 Partial |
| **Response Body Rewrite** | Hook cannot rewrite response bodies; `$replace` rules limited | 🟡 Partial |
| **YouTube Ads** | Partial coverage; scriptlets required for player rewrite | 🟡 Partial |

**Note:** Network filtering relies on a Windows-specific request hook that is not available on Linux or other platforms. The hook does not support response body modification.

### 2. WorkAny Generation

| Feature | Limitation | Status |
|---------|------------|--------|
| **Generation Dialog** | Prompt, type picker (PPTX/XLSX/DOCX/website), progress and cancel; reachable from the palette and viewer | 🟡 Scaffold |
| **Native Supervisor** | Rust can supervise a hardened loopback sidecar, stream SSE progress, stage output and promote the artifact atomically | 🟡 Scaffold |
| **Engine Availability** | No WorkAny binary is bundled. Generation reports “Not available” until `RITAM_WORKANY_API` or a loopback service is supplied; upstream must add loopback binding, bearer auth, CORS removal and path containment first | 🟡 Blocked upstream |

**Note:** See [ADR-008](docs/ADR-008-workany-generation.md). The UI never claims generation works when the engine is absent, and no provider keys cross into the renderer.

### 3. Certificate Security

| Feature | Limitation | Status |
|---------|------------|--------|
| **Security Indicator** | Based on URL scheme only; no certificate inspection | 🟡 Partial |

**Note:** The browser does not inspect TLS certificates presented by servers. The security indicator reflects HTTP vs HTTPS in the URL.

### 4. Per-Tab Isolation

| Feature | Limitation | Status |
|---------|------------|--------|
| **Tab Cookie/Identity** | Regular tabs share one WebView2 profile | 🟡 Partial |
| **Profile Data Sharing** | Bookmarks, history and site data are now per profile; hovering between profiles needs a full reload of the shell | 🟡 Partial |

**Note:** Private tabs use WebView2 InPrivate storage with full isolation. Regular tabs share storage within a profile.

### 5. Translation

| Feature | Limitation | Status |
|---------|------------|--------|
| **Page Translation** | Requires user-configured LibreTranslate endpoint | 🟡 Partial |
| **Endpoint Authentication** | API keys and authenticated endpoints not supported | 🟡 Partial |

### 6. Reader Mode

| Feature | Limitation | Status |
|---------|------------|--------|
| **Text Extraction** | Lightweight extraction from common article elements | 🟡 Partial |

**Note:** Reader mode extracts text from common `<article>`, `<main>`, and similar elements. It is not a complete readability parser.

### 7. Find in Page

| Feature | Limitation | Status |
|---------|------------|--------|
| **Match Count** | Requires Windows/WebView2 message channel | 🟡 Partial |

### 8. Developer Workbench

| Feature | Limitation | Status |
|---------|------------|--------|
| **Capture Scope** | Requests are recorded by page instrumentation, so browser-level loads that never reach JavaScript and requests made before capture starts are not listed | 🟡 Partial |
| **Header Visibility** | Only headers visible to page JavaScript are captured; `Cookie` and other forbidden request headers are hidden by the engine | 🟡 Partial |
| **Response Bodies** | Only fetch/XHR responses smaller than the 64 KB per-request cap and of a textual type are captured; static resources have timings but no body | 🟡 Partial |
| **Platform Support** | Capture needs WebView2's web-message channel, so the inspector is unavailable on Linux and mobile | 🟡 Partial |
| **Replay Identity** | Replay runs from the Ritam process, not the page, so page cookies and origin are not used | 🟡 Partial |

---

## Part III: Not Yet Implemented

### 1. Core Browser Features

| Feature | Priority | Notes |
|---------|----------|-------|
| **Download Resume** | Not implemented | An interrupted transfer can be started again, but not resumed byte-for-byte |

### 2. Platform & Integration

| Feature | Priority | Notes |
|---------|----------|-------|
| **Android App** | Not available | Tab engine requires desktop multi-webview API |
| **iOS App** | Not available | Requires separate single-webview shell |
| **macOS Build** | Not primary target | Windows/Linux prioritized |
| **Media Casting** | Not supported | WebView2 does not expose casting APIs |
| **Web Share API** | Not supported | Platform integration not available |
| **Push Notifications** | Not supported | Web Push not available in WebView2 |
| **Device Emulation** | Not supported | Requires CDP access |

### 3. Engine-Level Features

| Feature | Priority | Notes |
|---------|----------|-------|
| **Chrome Extensions** | Not supported | Requires Chromium engine |
| **CDP Access** | Not available | Chrome DevTools Protocol not exposed |
| **Per-Tab Cookie Isolation** | Not available | Requires engine-level support |
| **bfcache Control** | Not available | Not exposed by WebView2 |
| **Automatic Tab Discard** | Not available | Requires additional engine hooks |

### 4. Sync & Cloud

| Feature | Priority | Notes |
|---------|----------|-------|
| **Cloud Sync** | Not available | Manual encrypted backup only |
| **Cross-Device Sync** | Not available | Encrypted archives for manual transfer |
| **Account Sign-In** | Not available | Local-only operation |

### 5. Advanced Features

| Feature | Priority | Notes |
|---------|----------|-------|
| **Protocol Lab** | Skipped | Per product decision |
| **Full DevTools Parity** | Not available | No CDP access; the workbench is page-level only |
| **Real-Time Threat Intelligence** | Not available | Uses community filter lists only |
| **Password Breach Monitoring** | Not available | No cloud connectivity |
| **AI Features** | Not available | No AI services integrated |

### 6. Privacy Features

| Feature | Priority | Notes |
|---------|----------|-------|
| **Third-Party Cookie Blocking** | Not implemented | Not in current scope |
| **Fingerprint Randomization** | Not implemented | Not in current scope |

---

## Part IV: Technical Architecture

### Frontend Stack
- **UI Framework:** Vanilla HTML/CSS/JavaScript (no build step)
- **Styling:** CSS Custom Properties, Zen theme
- **Fonts:** Self-hosted (no CDN)
- **Module System:** ES Modules

### Backend Stack
- **Framework:** Tauri 2
- **Language:** Rust
- **Database:** SQLite (rusqlite)
- **Ad Blocking:** Brave's `adblock` Rust engine

### Engine Integration
- **Windows:** WebView2 (with request hook for ad blocking)
- **Linux:** WebKitGTK (without network filtering hook)

---

## Part V: Known Limitations

1. **Child WebView API:** Uses Tauri's unstable `Window::add_child` API
2. **Threading:** WebView2 controller creation must be async on Windows
3. **Keyboard Focus:** Page takes focus when clicked; global shortcuts work only when window is focused
4. **Certificate Inspection:** Not available; security indicator reflects URL scheme only
5. **Translation:** Requires external LibreTranslate-compatible endpoint
6. **PDF Annotation:** Not supported; handled by system WebView
7. **Forced Dark Mode:** May render some sites incorrectly
8. **Storage Deletion:** Some storage may be blocked by open pages
9. **Inspector Capture:** Page-level instrumentation cannot see requests made before Start, browser-level loads, or bodies over the per-request cap; Linux has no capture channel
10. **Download Scanning:** Uses Microsoft Defender on Windows only; other platforms report scanning as unavailable
11. **Bookmark Folders:** Assigned in Ritam or read from Chromium/Safari imports; Netscape HTML and Firefox imports arrive unfiled
12. **Request Mocking:** Applies to fetch/XHR in the target tab while capture is on; it cannot rewrite responses the engine fetches itself

---

## Appendix A: File Structure

```
ritam-browser/
├── ui/                          # Frontend (no build step)
│   ├── index.html               # Main shell
│   ├── styles/                  # CSS (tokens.css, app.css)
│   ├── js/                      # ES modules
│   │   ├── views/               # View components
│   │   ├── services/            # IPC and API services
│   │   └── state/               # State management
│   └── assets/                  # Fonts, icons
├── src-tauri/                   # Rust backend
│   ├── src/
│   │   ├── webview.rs           # Tab webview manager
│   │   ├── adblocker.rs         # Filter engine
│   │   ├── commands/            # IPC commands
│   │   └── db.rs                # SQLite operations
│   └── filter-assets/           # Bundled filter lists
├── docs/                        # Documentation
└── tests/                       # Unit tests
```

---

## Appendix B: Related Documentation

| Document | Description |
|----------|-------------|
| `README.md` | Setup, shortcuts, and architecture overview |
| `backend.md` | Implementation boundaries and privacy model |
| `docs/PRD_v2.md` | Product requirements and roadmap |
| `docs/ENGINE_SPIKE.md` | Engine feasibility analysis |
| `docs/ADR-006-engine-strategy.md` | Engine architecture decision |
| `docs/ADR-007-embedded-webviews.md` | WebView integration design |
| `docs/ADR-008-workany-generation.md` | WorkAny generation decision and security gates |

---

*This document is maintained as a living reference. Features marked as complete represent functionality currently shipping in the product.*
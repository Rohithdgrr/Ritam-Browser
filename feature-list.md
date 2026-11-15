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
| **Recently Closed Tabs** | Persisted across restarts (last 20 entries; private tabs never recorded) | ✅ Complete |
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
| **Favorites** | Quick-access grid on home page | ✅ Complete |
| **History** | Recorded, searchable, deletable, clearable | ✅ Complete |
| **Downloads** | Engine interception, list view, per-item delete, clear all | ✅ Complete |
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
| **Task Manager** | `govind://task-manager` showing per-tab states | ✅ Complete |

### 10. Settings & Configuration

| Feature | Description | Status |
|---------|-------------|--------|
| **Unified Settings Page** | `govind://settings` with all sections | ✅ Complete |
| **Search Engine Config** | Built-in engines + custom URL template | ✅ Complete |
| **Theme Toggle** | Light/dark mode switch | ✅ Complete |
| **Settings Search** | Filter box to find settings quickly | ✅ Complete |
| **Jump Rail Navigation** | Left-side navigation for settings sections | ✅ Complete |

### 11. Internal Pages

| Page | URL | Status |
|------|-----|--------|
| History | `govind://history` | ✅ Complete |
| Downloads | `govind://downloads` | ✅ Complete |
| Bookmarks | `govind://bookmarks` | ✅ Complete |
| Reading List | `govind://reading-list` | ✅ Complete |
| Recently Closed | `govind://recently-closed` | ✅ Complete |
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

---

## Part II: Partially Implemented Features

### 1. Network Filtering

| Feature | Limitation | Status |
|---------|------------|--------|
| **Ad Blocking** | Windows/WebView2 only; Linux uses WebKitGTK without hook | 🟡 Partial |
| **Response Body Rewrite** | Hook cannot rewrite response bodies; `$replace` rules limited | 🟡 Partial |
| **YouTube Ads** | Partial coverage; scriptlets required for player rewrite | 🟡 Partial |

**Note:** Network filtering relies on a Windows-specific request hook that is not available on Linux or other platforms. The hook does not support response body modification.

### 2. Certificate Security

| Feature | Limitation | Status |
|---------|------------|--------|
| **Security Indicator** | Based on URL scheme only; no certificate inspection | 🟡 Partial |

**Note:** The browser does not inspect TLS certificates presented by servers. The security indicator reflects HTTP vs HTTPS in the URL.

### 3. Per-Tab Isolation

| Feature | Limitation | Status |
|---------|------------|--------|
| **Tab Cookie/Identity** | Regular tabs share one WebView2 profile | 🟡 Partial |
| **Profile Data Sharing** | Bookmarks, history and site data are now per profile; hovering between profiles needs a full reload of the shell | 🟡 Partial |

**Note:** Private tabs use WebView2 InPrivate storage with full isolation. Regular tabs share storage within a profile.

### 4. Translation

| Feature | Limitation | Status |
|---------|------------|--------|
| **Page Translation** | Requires user-configured LibreTranslate endpoint | 🟡 Partial |
| **Endpoint Authentication** | API keys and authenticated endpoints not supported | 🟡 Partial |

### 5. Reader Mode

| Feature | Limitation | Status |
|---------|------------|--------|
| **Text Extraction** | Lightweight extraction from common article elements | 🟡 Partial |

**Note:** Reader mode extracts text from common `<article>`, `<main>`, and similar elements. It is not a complete readability parser.

### 6. Find in Page

| Feature | Limitation | Status |
|---------|------------|--------|
| **Match Count** | Requires Windows/WebView2 message channel | 🟡 Partial |

---

## Part III: Not Yet Implemented

### 1. Core Browser Features

| Feature | Priority | Notes |
|---------|----------|-------|
| **Split View** | Not in current milestone | Side-by-side tab view |
| **Tab Sleeping** | Not in current milestone | Automatic tab resource release |
| **Download Resume** | Not in current milestone | Resume interrupted downloads |

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
| **Network Request Mocking** | Not available | Requires CDP |
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

---

*This document is maintained as a living reference. Features marked as complete represent functionality currently shipping in the product.*
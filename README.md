# Ritam Browser

> A fast, privacy-first desktop browser built with Tauri 2 and Rust.

**Status:** Production (Milestone 1 — Browser Shell)  
**Platform:** Windows (primary), Linux (secondary)  
**Architecture:** Local-first, zero telemetry, no accounts required

---

## Overview

Ritam Browser is a local-first desktop browser that prioritizes user privacy and productivity. Built on Tauri 2 with a Rust backend and vanilla HTML/CSS/JavaScript frontend, it offers a clean, lightweight browsing experience without the overhead of traditional browsers.

### Key Principles

- **Local-First:** All data stored locally on your device
- **Privacy by Default:** No telemetry, no accounts, no cloud sync
- **Lightweight:** No build step for UI, minimal resource usage
- **Transparent:** Clear boundaries between browser and web content

---

## Features

### Core Browsing
- Embedded child webviews (one per tab)
- Tab management: create, close, pin, reorder, group
- Navigation: back, forward, reload, home
- Address bar with search integration
- Page titles and real-time URL display
- Fullscreen mode (F11)
- Find in page with match count
- Print and PDF export
- PDF viewing (native system WebView)

### Privacy & Security
- Private tabs (WebView2 InPrivate storage)
- Guest mode (all tabs private for session)
- HTTPS-first policy
- Clear browsing data
- Per-site permissions
- Do Not Track header
- No telemetry

### Content Control
- Network-level ad blocking (Windows/WebView2)
- EasyList, EasyPrivacy, and uBlock Origin filters
- Cosmetic filters and scriptlet injection
- Per-site allowlisting
- Safe browsing warnings

### Organization
- Workspaces (multiple workspaces per profile)
- Bookmarks with favorites
- Browsing history
- Downloads manager
- Scratchpad (local notes)
- Reading list with offline snapshots
- Tab groups (named, collapsible)

### Productivity
- Command palette (Ctrl+K)
- Tab search / quick switcher (Ctrl+Shift+A)
- Quick popovers for downloads, history, bookmarks
- Reader mode
- Read Aloud with word highlighting
- Picture-in-Picture
- Page translation (LibreTranslate endpoint)
- Forced dark mode for websites

### Profiles
- Local profiles with name, label, and color
- Chrome-style profile switcher
- Per-profile workspaces and tabs

### Data Management
- Bookmark import/export (Netscape HTML)
- Encrypted backup and restore (.gbak)
- Task manager (per-tab state view)

---

## Quick Start

### Prerequisites

- **Windows:** Rust, Node.js 20+, WebView2 (pre-installed on Windows 11/10)
- **Linux:** Rust, Node.js 20+, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, etc.

### Installation

```bash
# Clone the repository
git clone https://github.com/your-repo/ritam-browser.git
cd ritam-browser

# Install dependencies
npm install

# Run in development mode
npm run tauri:dev

# Build for production
npm run tauri:build
```

### UI Preview (No Rust Required)

```bash
npm run dev        # Starts local server at http://localhost:8081
npm test           # Runs 58 unit tests
```

---

## Project Structure

```
ritam-browser/
├── ui/                     # Frontend (no build step)
│   ├── index.html          # Main shell
│   ├── styles/             # CSS (tokens.css, app.css)
│   ├── js/                 # ES modules
│   │   ├── views/          # View components
│   │   ├── services/       # IPC and API services
│   │   └── state/          # State management
│   └── assets/             # Fonts, icons
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── webview.rs      # Tab webview manager
│   │   ├── adblocker.rs    # Filter engine
│   │   ├── commands/       # IPC commands
│   │   └── db.rs           # SQLite operations
│   └── filter-assets/      # Bundled filter lists
├── docs/                   # Documentation
├── tests/                  # Unit tests
└── tools/                  # Build tools
```

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Shift+T` | Reopen closed tab |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+K` | Command palette |
| `Ctrl+L` | Focus address bar |
| `Ctrl+R` | Reload page |
| `Ctrl+D` | Bookmark page |
| `Ctrl+,` | Open settings |
| `Ctrl+H` | History page |
| `Ctrl+J` | Downloads page |
| `Ctrl+1-9` | Switch to tab N |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |
| `Alt+←` | Go back |
| `Alt+→` | Go forward |
| `F11` | Toggle fullscreen |
| `Ctrl+F` | Find in page |
| `Esc` | Close palette/panels/menus |

---

## Internal Pages

Access these by typing in the address bar:

| Page | URL |
|------|-----|
| History | `govind://history` |
| Downloads | `govind://downloads` |
| Bookmarks | `govind://bookmarks` |
| Reading List | `govind://reading-list` |
| Recently Closed | `govind://recently-closed` |
| Task Manager | `govind://task-manager` |
| Media Controls | `govind://media-controls` |
| Settings | `govind://settings` |

---

## Technical Architecture

### Frontend
- **Framework:** Vanilla HTML/CSS/JavaScript (no build step)
- **Styling:** CSS Custom Properties, Zen theme
- **Module System:** ES Modules

### Backend
- **Framework:** Tauri 2
- **Language:** Rust
- **Database:** SQLite (rusqlite)

### Engine Integration
- **Windows:** WebView2 with request hook for ad blocking
- **Linux:** WebKitGTK (network filtering not available)

---

## Known Limitations

1. **Tab Isolation:** Regular tabs share one WebView2 profile; private tabs have full isolation
2. **Certificate Inspection:** Not available; security indicator reflects URL scheme only
3. **Network Filtering:** Windows-only (WebView2 hook not available on Linux)
4. **Translation:** Requires external LibreTranslate-compatible endpoint
5. **Extensions:** Not supported (requires Chromium engine)
6. **CDP Access:** Not available (Chrome DevTools Protocol not exposed)

---

## Documentation

| Document | Description |
|----------|-------------|
| [Feature List](feature-list.md) | Complete feature inventory with implementation status |
| [Product Requirements](docs/PRD_v2.md) | Product roadmap and requirements |
| [Backend Architecture](backend.md) | Implementation boundaries and privacy model |
| [Engine Analysis](docs/ENGINE_SPIKE.md) | Browser engine feasibility study |

---

## Building & Testing

### Rust Tests

```bash
cd src-tauri
cargo test        # 36 tests: URL validation, filtering, commands
cargo check       # Compile check
```

### UI Tests

```bash
npm test          # 58 unit tests across 11 files
```

### Debug Mode

```bash
cd src-tauri
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223" \
  ./target/debug/govind-browser.exe
# Access DevTools at http://127.0.0.1:9223/json/list
```

---

## License

MIT License — See LICENSE file for details.

---

## Contributing

Contributions are welcome. Please ensure:
- All tests pass (`npm test` and `cargo test`)
- Code follows existing conventions
- New features are documented

---

*Last Updated: November 2026*
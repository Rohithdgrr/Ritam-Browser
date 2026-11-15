# Working on Ritam Browser

> Setup guide and development commands.

---

## 1. Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 20+ | For frontend and build tools |
| Rust | stable | For Tauri backend |
| WebView2 | Evergreen | Pre-installed on Windows 11/10 |

### Linux Prerequisites

```bash
# Ubuntu/Debian
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev \
  build-essential pkg-config libssl-dev patchelf
```

---

## 2. Quick Start

### Install Dependencies

```bash
npm install
```

### Run UI Preview (No Rust Required)

```bash
# Run tests
npm test

# Start preview server
npm run dev
```

The preview server runs at `http://localhost:8081`.

> **Note:** Preview mode uses localStorage instead of the Rust backend. Remote sites load in an iframe; some sites prohibit framing.

### Run Desktop Application

```bash
npm run tauri:dev
```

### Build for Production

```bash
npm run tauri:build
```

Output installers are located in:
- Windows: `src-tauri/target/release/bundle/{nsis,msi}/`
- Linux: `src-tauri/target/release/bundle/{deb,appimage}/`

---

## 3. Rust Development

### From Repository Root

```bash
# Run Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Check compilation
cargo check --manifest-path src-tauri/Cargo.toml

# Run tests from src-tauri directory
cd src-tauri
cargo test
```

### Frontend Tests

```bash
# All tests
npm test

# Or use Node directly
node --test tests/*.test.mjs
```

---

## 4. Project Structure Reference

| Path | Description |
|------|-------------|
| `ui/index.html` | Main browser shell |
| `ui/styles/` | CSS files (tokens.css, app.css) |
| `ui/js/` | JavaScript modules |
| `ui/js/services/ipc.js` | Tauri command boundary + preview fallback |
| `src-tauri/src/commands/` | Rust IPC command handlers |
| `src-tauri/src/webview.rs` | Native webview lifecycle |
| `src-tauri/src/db.rs` | SQLite setup and schema |
| `src-tauri/migrations/` | Database migrations |
| `tests/` | Frontend and fallback tests |
| `tools/serve.mjs` | Lightweight preview server |
| `docs/` | Architecture decisions and PRD |

---

## 5. Additional Resources

| Document | Description |
|----------|-------------|
| [Feature List](feature-list.md) | Feature implementation status |
| [Backend Architecture](backend.md) | Technical architecture |
| [Engineering Process](process.md) | Development principles |
| [Development Workflow](workflow.md) | Day-to-day procedures |

---

## 6. Common Issues

### WebView2 Not Found

If you see a WebView2 error on Windows, install the [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

### Port Already in Use

If port 8081 is in use, stop the existing server or use a different port by modifying `tools/serve.mjs`.

### Rust Compilation Errors

Ensure you're using stable Rust:
```bash
rustup default stable
rustup update
```

---

*Last Updated: November 2026*
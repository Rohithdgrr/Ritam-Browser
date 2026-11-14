# Working on Govind Browser

## Requirements

- Node.js 20 or later.
- Rust stable for the desktop application.
- WebView2 Runtime on Windows (normally present on Windows 11 and recent
  Windows 10 installations).
- Tauri platform prerequisites for the target operating system.

## Run the UI preview

The preview needs Node.js but does not build the Rust application:

```powershell
npm test
npm run dev
```

Open the address printed by `tools/serve.mjs` (currently
`http://localhost:8081`). The preview uses local storage in place of the Rust
backend and loads remote sites in an iframe; some sites prohibit framing.

## Run the desktop app

```powershell
npm install
npm run tauri:dev
```

Build a distributable installer with:

```powershell
npm run tauri:build
```

## Rust checks

Run these from the repository root:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

The frontend test suite is `node --test tests/*.test.mjs` (also available as
`npm test`). Tests use Node's built-in test runner.

## Repository map

- `ui/index.html`, `ui/styles/`, `ui/js/`: browser shell and UI.
- `ui/js/services/ipc.js`: frontend-to-Tauri command boundary and preview
  fallback selection.
- `src-tauri/src/commands/`: Rust IPC command handlers.
- `src-tauri/src/webview.rs`: native page webview lifecycle and engine adapter.
- `src-tauri/src/db.rs`, `src-tauri/migrations/`: local SQLite setup/schema.
- `tests/`: frontend and fallback behavior tests.
- `tools/serve.mjs`: dependency-light preview server.
- `docs/`: product and architecture decisions.

For feature status, see `feature-list.md`. For implementation conventions and
the delivery loop, see `process.md` and `workflow.md`.

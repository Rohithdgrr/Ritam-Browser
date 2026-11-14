# ADR-006: Engine strategy for tab webviews

**Status:** accepted (interim) · **Date:** 2026-11-13 · **Supersedes:** —

## Context

Govind needs multiple independent web content views inside one browser window.
Tauri 2 does not provide stable child-WebView support; `WebviewWindow` creates a
separate window per view. The PRD (§6.2, §31) requires an engine decision backed by
a spike before committing.

## Decision (interim)

Ship milestone 1 with **frameless, taskbar-less native windows** positioned over the
main window's web region (`src-tauri/src/webview.rs`, `TabWindowManager`). Tabs are
created/closed/switched by the Rust shell; the UI only talks to typed IPC commands.

Consequences, accepted deliberately:

- Pages navigate and back/forward/reload work (via `eval`).
- Stray-window and focus quirks are documented user-facing limitations.
- No certificate inspection, no response capture, no native downloads yet.
- Migrating to child WebViews or CEF touches exactly one module.

## Alternatives considered

- **Child WebViews (`unstable`)** — the likely next step; gated on the spike
  (`docs/ENGINE_SPIKE.md`). Rejected *for now* because shipping an unvalidated
  unstable API as the foundation violates PRD Gate A.
- **CEF / Chromium fork** — strongest control; far too heavy for milestone 1 and
  premature without measured requirements (PRD §31 decision recommendation applies
  only if the developer-workbench features become committed scope).
- **WebViewWindow with full decorations** — works but produces bizarre duplicate
  chrome; rejected on UX grounds.

## What would reopen this ADR

Measured spike results, a Tauri stable release of embedded WebViews, or an explicit
product decision to commit to the CEF/Chromium route (which also reopens the
extension-compatibility program, PRD §22).

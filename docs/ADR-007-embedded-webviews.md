# ADR-007: Embedded child webviews as the browser core

**Status:** accepted · **Date:** 2026-11-14 · **Supersedes:** ADR-006 (interim)

## Context

Govind needs multiple independent web content views inside **one** browser window.
Tauri 2's stable `WebviewWindow` API creates one native window per view, so
ADR-006 shipped an interim hack: frameless, taskbar-less windows positioned over
the main window. That produced the documented limitations (stray windows on the
desktop, focus quirks, no real per-tab state, `webview.rs` recreating a window
on every navigation).

Tauri 2.12 exposes the multi-webview API — `Window::add_child` with
`WebviewBuilder` — behind the `unstable` Cargo feature. `docs/ENGINE_SPIKE.md`
lists "child webviews in one window" as the first option under test, and it is
the only route that delivers real browser behaviour (tab state, page titles,
navigation events, downloads, permissions) on the system WebView.

## Decision

Use **child webviews inside the main window** as the browser core.

- `src-tauri/src/webview.rs` owns one `Webview` per tab, created with
  `Window::add_child` and positioned over the shell's web-content region.
- Tabs switch by showing/hiding those views; the region geometry is pushed from
  the shell (`sync_tab_windows`) and re-applied on resize.
- A tab's webview is created lazily on its first web navigation and reused
  afterwards, so page state (scroll, forms) survives navigations.
- `govind://…` internal pages (history, downloads, bookmarks, settings) are
  rendered by the shell; they never create a webview.

### Consequences

Accepted deliberately:

- The `unstable` Cargo feature is now a hard dependency of the browser core.
  It is the documented Tauri 2 multi-webview API; the alternative was the
  separate-window hack this ADR replaces.
- Creating a WebView2 controller from inside a webview message handler
  deadlocks on Windows, so `navigate_tab` is an `async` command that runs on
  Tauri's async runtime (see the Tauri docs for `Window::add_child`).
- A child webview takes the keyboard focus when the user clicks a page, so the
  shell no longer receives key events. Browser shortcuts are therefore
  registered as **global shortcuts** (`tauri-plugin-global-shortcut`) while the
  Govind window is focused and unregistered when it loses focus, so they never
  shadow the same keys in other applications.
- Remote content keeps zero IPC access: a child webview shares the parent
  window's label, but Tauri grants the app's commands only to *local* origins,
  so a remote page cannot invoke a single Govind command.

### Capabilities gained

- Real page titles (`on_document_title_changed`) instead of URL-derived titles.
- Real navigation tracking (`on_navigation`) → live omnibar, history entries.
- Native download interception (`on_download`) → the Downloads page.
- Native reload, print, zoom and per-tab page state.

## Alternatives considered

- **Keep the ADR-006 separate-window strategy** — rejected: it cannot deliver
  tab state, titles, downloads or a single-window UX, and it leaves stray
  windows on the desktop.
- **CEF / Chromium shell** — still the right long-term answer if the developer
  workbench (request interception, response mocking, device emulation,
  extensions) becomes committed scope (PRD §31). Not needed for milestone 1 and
  far too heavy for it.

## What would reopen this ADR

A stable Tauri release of embedded webviews, or an explicit product decision to
commit to the CEF/Chromium route (which also reopens the extension
compatibility program, PRD §22).

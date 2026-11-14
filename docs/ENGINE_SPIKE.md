# Engine Feasibility Spike (PRD Phase 0 — Gate A)

Status: **executed for the embedded-webview option (ADR-007).** The remaining
items are the measurements that must be recorded before the engine decision is
final.

## Why

Milestone 1 originally rendered pages in *frameless native windows positioned
over the app's content region* (`src-tauri/src/webview.rs`) — the only stable
Tauri 2 route at the time. The PRD forbids building the rest of the browser on
a fragile tab implementation (PRD §6.2, §18, §31), so the spike was required
before going further.

## Outcome

**Option 1 — child webviews in one window — is implemented and shipped.**
`src-tauri/src/webview.rs` now creates one child webview per tab with
`Window::add_child` (Tauri `unstable` feature) inside the main window.
See `docs/ADR-007-embedded-webviews.md`.

## Proofs — status

| # | Required proof | Status |
|---|---|---|
| 1 | Three independent website views in one window; switch without losing page state | ✅ implemented; views are hidden/shown, not recreated |
| 2 | Navigation, back/forward/reload; pop-ups handled; downloads intercepted | ✅ navigation/reload/print native; pop-ups open as tabs; `on_download` records downloads |
| 3 | Cookie/storage isolation between tabs; per-origin permission decisions | ⚠️ tabs share one webview profile (WebView2 user data folder); per-origin permissions are stored and shown, but the engine does not yet enforce per-tab identity |
| 4 | CDP (or equivalent) access: request lifecycle, console, DOM snapshot, emulation | ❌ not exposed by the system WebView — this is the argument for a Chromium engine if the developer workbench ships |
| 5 | Trusted app IPC unreachable from remote content | ✅ child webviews get a remote origin; Tauri grants app commands to local origins only |
| 6 | Memory at 1/5/10/20 tabs; idle CPU; tab-switch latency; cold startup | ⬜ **to be measured** — record numbers in ADR-007 |
| 7 | Licensing, updater strategy, engine CVE cadence, fork maintenance cost | ⬜ open — relevant only if the CEF/Chromium route is taken |
| 8 | Linux (WebKitGTK) and Windows (WebView2) delta assessment | ⬜ open — the child-webview API is available on both, but positions/sizes need checking on Linux |

## Acceptance for closing the milestone-1 engine caveat

- [x] 3+ independent views, state preserved across switches
- [x] Single-window UX (no stray windows visible to the OS taskbar)
- [x] Focus routing: Ctrl+K/T/W/L work while a page has the keyboard focus
      (global shortcuts, registered only while the Govind window is focused)
- [x] Downloads intercepted with destination + progress (file written by the engine)
- [ ] Memory report attached to the ADR (1/5/10/20 tabs)

## Remaining risk

The child-webview API is still marked *unstable* by Tauri. It is isolated
behind `TabWebviewManager` in `src-tauri/src/webview.rs`, so a future engine
change (stable embedded webviews or a Chromium shell) touches that module and
the engine adapter only.

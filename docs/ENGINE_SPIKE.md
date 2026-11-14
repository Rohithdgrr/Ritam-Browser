# Engine Feasibility Spike (PRD Phase 0 — Gate A)

Status: **planned, not yet executed.** This document is the contract for the work that
must happen before the interim window-embedded webview strategy is replaced.

## Why

`src-tauri/src/webview.rs` (milestone 1) uses one frameless native window per tab.
That is the only stable-API route in Tauri 2, and it works, with known limitations
(see README → "The honest part"). The PRD forbids building the rest of the browser on
a fragile tab implementation (PRD §6.2, §18, §31).

## Options under test

| Option | Pros | Risks |
|---|---|---|
| Child WebViews in one window (`tauri::webview::WebviewBuilder::add_child`, `unstable` cargo feature) | True single-window tabs; matches normal browser UX; no focus trap | API is documented unstable in Tauri 2; lifecycle/z-order/hit-testing unknowns |
| CEF / maintained Chromium shell | Real engine control: CDP, interception, emulation, extensions | Huge distribution, update machinery, maintenance burden |
| Keep interim windows + mitigate (parent windows, shared taskbar group) | Zero code churn from milestone 1 | Focus and minimize limitations persist |

## Required proofs (each is pass/fail, with measurements)

1. Three independent website views in one window; switch without losing page state.
2. Navigation, back/forward/reload; pop-ups handled; downloads intercepted natively.
3. Cookie/storage isolation between tabs; per-origin permission decisions enforced.
4. CDP (or equivalent) access: request lifecycle, console, DOM snapshot, emulation.
5. Trusted app IPC unreachable from remote content (exploit attempt documented).
6. Memory at 1/5/10/20 tabs; idle CPU; tab-switch latency; cold startup.
7. Licensing, updater strategy, engine CVE cadence, fork maintenance cost.
8. Linux (WebKitGTK) and Windows (WebView2) delta assessment.

## Decision record

Write the outcome as `docs/ADR-006-engine-strategy.md` (template in place) with
measured numbers, then migrate `webview.rs` behind the existing `TabWindowManager`
interface. **Nothing outside `webview.rs` should change.**

## Acceptance for closing the milestone-1 engine caveat

- [ ] 3+ independent views, state preserved across switches
- [ ] Single-window UX (no stray windows visible to the OS taskbar)
- [ ] Focus routing: Ctrl+K/T/W/L behave identically with page focused
- [ ] Downloads intercepted with destination + progress
- [ ] Memory report attached to the ADR

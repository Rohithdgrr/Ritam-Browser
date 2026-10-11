# ARCHITECTURE DECISION — Ritam Browser

**Date:** 2026-10-10 · **Phase 0** · **Author:** ROT (decisions by the owner)
**Status:** decided by owner 2026-10-10; evidence gates marked where the
blueprint requires empirical proof later.

## Context

Ritam Browser is a conventional Windows desktop browser with a custom chrome
UI, using the Obscura headless engine ecosystem. The blueprint v3.2 left two
decisions evidence-gated (ADR-001 desktop host, ADR-002 visible runtime);
the owner closed both for speed, with the blueprint's risks recorded below.

## D1 — Visible pages render in WebView2 (Chromium)

**Decision:** WebView2/Chromium is the visible browsing runtime. Obscura is
the isolated agent/automation runtime (CDP/MCP), never the visible renderer.

**Rationale (owner, 2026-10-10):** best site compatibility for daily
browsing; Obscura's accuracy surface is untouched because the engine is
isolated behind the adapter boundary — this is the strongest possible
guarantee for owner rule 3 (accuracy cannot drop in the UI if the UI never
altersthe engine's execution path).

**Recorded risks (from blueprint ADR-002, accepted by owner):**
- Two rendering worlds exist (Chromium visible, Obscura agent); results can
  legitimately differ between them. The parity gate (AGENTS.md §7) governs
  the Obscura path; the WebView2 path is governed by Chromium fidelity.
- WebView2 is not a complete browser product: find-in-page, error pages,
  popups, permissions, downloads, context menus, print need explicit design
  (blueprint §6 checklist) — phases 2–4 scope, already in the plan.

**Follow-ups (evidence gates, not assumptions):**
- [ ] Verify WebView2 distribution/EULA permits standalone browser embedding;
      record conclusion in `docs/DEPENDENCIES.md` (blueprint ADR-008 legal
      gate). Until public distribution, internal use only.
- [ ] Pin WebView2 SDK version in Phase 2 scaffold; runtime floor check runs
      at app startup with honest fallback message.

## D2 — Desktop host: Tauri 2

**Decision:** Tauri 2 hosts the app: Rust core, system WebView2 for chrome
UI and pages, maintained packaging/IPC surface.

**Rationale (owner, 2026-10-10):** fastest path to a real, maintainable
Windows app; the blueprint's direct-host default (ADR-001) optimizes for
maximum control at the cost of owning windowing/packaging/updater ourselves
— rejected as unnecessary for a conventional browser.

**Recorded risks (from blueprint ADR-001, accepted by owner):**
- Multi-webview + multi-window behavior must be proven, not assumed
  (Tauri's normal app model is single-view). **Gate:** Phase 2 opens ≥3
  tabs as real webviews with correct lifecycle; if Tauri cannot, the
  fallback is `tao`/`wry` (already in ADR-014 shortlist) — decision point
  recorded here so the fallback is a plan step, not a surprise.
- Custom frameless chrome (the floating-pill look in `screen.png`) is NOT
  in scope for MVP: ADR-010's decorated-frame baseline applies. The design
  still reads as Serene Canvas inside a standard window.

**Follow-ups:**
- [ ] Phase 2 spike: multiple WebView2 controllers inside Tauri 2 (tab
      lifecycle, popup policy, focus routing chrome↔content).
- [ ] Verify Per-Monitor-V2 DPI handling under Tauri on mixed-DPI monitors.

## D3 — Engine integration boundary (supports owner rule 3)

**Decision:** the UI project consumes Obscura only through (a) the CDP
server (`obscura serve`) and (b) the MCP server — both already stable,
documented surfaces of the pinned v0.2.4 binary. The `obscura/` source tree
and `obscura-benchmark/` stay pristine; no engine patches, ever.

**Parity invariant:** any operation exposed to users/agents through Ritam's
UI must return results identical to the same operation driven directly
against the pinned binary. Mechanically enforced by the CLI-vs-UI parity
fixtures (ROT, `scripts/`), re-run at every phase gate.

## D4 — Local persistence, IPC, secrets (adopted from blueprint, unchanged)

- SQLite WAL + versioned migrations + single writer actor (ADR-005) —
  Devi's `ritam-store`.
- Typed, schema-first IPC; bounded channels; no synchronous cross-boundary
  waits (ADR-007). Chrome UI served from app origin, never `file://`
  (ADR-010).
- No secrets in v1 scope (no accounts, no sync) — DPAPI/keyring work (ADR-013)
  deferred until a feature actually needs it (rule 6: no speculative work).

## D5 — UI stack (adopted from blueprint, unchanged)

HTML5 + vanilla CSS (design tokens) + ES modules + `@preact/signals-core`;
Lucide icons; Playwright for UI tests. No React/Vue for the chrome (ADR-004).

## D6 — Content sources: engine snapshot default, direct Chromium secondary

**Decision (owner, 2026-10-10, this stage — supersedes D1's "rejected"
note):** visible content has **two paths per tab**, chosen when asked how page
content is produced ("Both paths, Obscura default"):

1. **Engine snapshot (default).** The *document* — HTML, final URL, title —
   is fetched by the pinned Obscura engine (`obscura` eval surface, the same
   CLI-vs-CDP byte-compared transport the parity gate proves) and rendered
   into a **scriptless sandboxed frame** on the app origin. Link navigation
   is routed back through the engine: the runtime cancels the display
   webview's top-level navigation attempt and re-fetches through the engine.
2. **Direct (secondary, per-tab opt-in: "Open directly (Chromium)").** The
   WebView2 content webview navigates the URL itself (D1's original path).
   Full fidelity: page scripts run, Chromium's real error pages apply.

**Honesty rules for the snapshot path (AGENTS.md §6):**
- The UI **labels which mode produced the page** (R3): an engine badge
  shows `Obscura snapshot` or `Direct (Chromium)` — never a silent switch.
- Snapshot mode executes **no page scripts and no form submission**
  (sandbox without `allow-scripts`/`allow-same-origin`/`allow-forms`); this
  is stated in the UI, not discovered by the user.
- Subresources (images, CSS, fonts) are fetched by the display webview for
  **rendering only**; the document bytes shown as "the page" are the
  engine's response, and the status/title/final URL come from the engine.
- If the engine is unavailable, snapshot navigation fails **honestly**
  (`nav.error` with the engine's own message); the runtime never silently
  falls back to a direct fetch while showing an engine badge.

**Parity scope:** the engine path is governed by AGENTS.md §7 (CLI-vs-UI
byte parity on the eval/dump surface). The direct path is a different
renderer by design and is *not* claimed byte-identical to the engine —
that divergence is the documented purpose of having two paths (R3).

**Amends:** D1's rejection note ("Obscura rendering visible tabs —
rejected") — the owner re-opened and decided the two-path model in this
stage; the isolation rationale in D1 now governs the *direct* path only.

**Follow-ups (evidence gates):**
- [ ] Engine snapshot passes `scripts/parity-check.mjs` with the snapshot
      expression included in the fixture set (ROT, at the Phase 2 gate).
- [ ] Multi-tab snapshot + direct mix proven with ≥3 tabs open (D2 gate).

## What was explicitly rejected

- **Obscura rendering visible tabs** (owner considered, rejected): strongest
  rule-3 alignment, but independent-engine rendering gaps would degrade
  daily browsing; isolation chosen instead. *(Superseded in part by D6 —
  the owner re-opened this in the 2026-10-10 stage: engine snapshot became
  the default content path with a direct-Chromium secondary.)*
- **Electron:** contradicts the lightweight positioning; extra Chromium.
- **Direct webview2-com host (MVP):** maximum control, highest maintenance
  cost; revisit only if the Tauri multi-webview gate fails.

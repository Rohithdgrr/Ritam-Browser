# DESIGN SYSTEM — Ritam Browser (Serene Canvas, working software)

**Owner:** Govinda (`agents/GOVINDA.md`) · **Status:** written 2026-10-10
before the Phase 1 chrome implementation (rule 5).
**Source of law:** `DESIGN.md` at the repo root. This file does not invent
tokens; it maps the law to CSS custom properties, components, states, and
accessibility rules, and it records the layout contract the runtime depends
on. Where `DESIGN.md` and this file disagree, `DESIGN.md` wins.

---

## 1. Tokens (`browser/ui/tokens.css`)

All values below come from `DESIGN.md` (front-matter color roles + prose
constraints). Components may only reference `var(--…)`. No ad-hoc hex, no
ad-hoc sizes, no ad-hoc fonts anywhere in `browser/ui/**`.

### 1.1 Color (light, the only palette in the law)

| Token | Value | Role |
|---|---|---|
| `--canvas` | `#faf9f5` | app background |
| `--surface-1` | `#f4f2ec` | panels, menu, cards |
| `--surface-2` | `#e8e5dc` | hover fills, inset areas |
| `--border` | `#e2ddd3` | hairline separators (1px) |
| `--ink` | `#1e2321` | primary text |
| `--ink-muted` | `#68706b` | secondary text, placeholders |
| `--primary` | `#4a6b5d` | buttons, active tab, focus ring, links |
| `--primary-strong` | `#3d5a4e` | primary hover/pressed |
| `--danger` | `#a4322b` | destructive actions, real errors only |

Honesty rule: `--danger` and the lock/verified vocabulary are never used to
manufacture a security verdict. Colors never claim what the runtime did not
report.

### 1.2 Type

- Editorial (page headings inside panels/new tab): `Newsreader`, weights
  400/500.
- UI (everything interactive): `Plus Jakarta Sans`, weights 400/500/600/700.
- Scale: `12px` (status/meta), `13px` (tab titles, list rows), `14px`
  (controls, body), `16px` (panel titles), `20px`/`24px` (new-tab heading).
- Line heights: `1.2` controls, `1.5` body, `1.15` headings.
- Fonts are served locally: `browser/ui/fonts/*.woff2` are byte-identical
  copies of the pinned downloads in `assets/fonts/` (same SHA-256, recorded
  in `docs/DEPENDENCIES.md`). No remote font or script may ever load in the
  privileged chrome.

### 1.3 Space, radius, elevation, motion

- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 px (`--space-1 … --space-6`).
- Radius: `8px` controls (`--radius`), `16px` cards/panels/dialogs
  (`--radius-lg`), `999px` pills (omnibox, chips).
- Borders: always `1px solid var(--border)`.
- Elevation: one ambient shadow token only (`--shadow`): soft, low-contrast
  (`0 8px 24px rgba(30,35,33,.10)`); dialogs use `--shadow-lg`
  (`0 16px 48px rgba(30,35,33,.16)`). No hard drop shadows, no glows.
- Motion: `120ms ease` for hover/fade, `180ms ease` for open/close. All
  animation lives inside `@media (prefers-reduced-motion: no-preference)`;
  with reduced motion everything is instant (rule: accessibility is a
  release requirement).

## 2. Layout contract (the runtime depends on this)

The chrome document fills a child webview pinned by `src-tauri/src/shell.rs`
to a **108 logical px** strip. That constant is split exactly as:

| Strip row | Height | Contents |
|---|---|---|
| Tab strip | `40px` | tabs (`role=tablist`), new-tab button |
| Toolbar | `44px` | back, forward, reload/stop, home, omnibox, star, menu |
| Status bar | `24px` | status text (left), engine pill (right) |

Any change to these heights is a cross-boundary change: Govinda updates this
document and `browser/ui/**` in the same change, and requests the
`shell.rs` constant update from Rohan (PLAN.md Requests).

### 2.1 Overlay contract (needs runtime support)

Webview content is clipped to its bounds, so every overlay (app menu,
dialogs, side panels) must be able to grow the strip. The chrome therefore
calls `chrome_resize { height }` before showing an overlay and resets it to
`108` on close (`PLAN.md` Request G-1). Behavior when the command does not
exist (current runtime):

- overlay-triggering controls are **disabled in the DOM** with a tooltip
  naming the missing surface (`Panel menu — requires the runtime's
  chrome_resize command (PLAN.md G-1)`);
- keyboard shortcuts for those overlays are inert and report the same
  message in the status bar;
- nothing is faked, nothing renders half-clipped (AGENTS.md §6).

If `chrome_resize` returns a height that leaves no room (small window), the
overlay does not open and the status bar says so.

## 3. Components

- **Button** (`.btn`): heights 28/32, radius `--radius`, hairline border,
  `--surface-1` fill; primary variant `--primary` fill, white text;
  destructive variant `--danger` text on transparent fill.
- **Icon button** (`.icon-btn`): 32×32, 16px Lucide glyph (inline SVG
  sprite, `assets/icons/lucide-static@0.545.0` provenance), accessible name
  required (`aria-label`), tooltip via `title` including the Windows
  shortcut.
- **Tab** (`.tab`): min 96px, max 220px, truncating title, close button
  with `aria-label="Close tab"`, active tab = `--surface-1` fill + `--primary`
  2px bottom indicator; loading tab shows the spinner glyph (reduced-motion:
  static glyph + `aria-busy`).
- **Omnibox** (`.omnibox`): pill field, `role=combobox`-free plain
  `<form>`; shows a neutral origin chip — the chip is text only (origin from
  `nav.state`), **never** a colored "secure/verified" badge (contract §6).
- **Status bar**: one live region (`role=status`, `aria-live=polite`) for
  real runtime messages including `{code}: {message}` — this includes
  `nav.error` (contract §8.3), which is shown verbatim prefixed with its
  tab id when the error is not on the active tab; an engine pill button
  showing `engine.status` verbatim (`starting… / ready / stopped / error —
  <reason>`), opens the engine dialog; and a **mode switch** button that
  exists only while `NavState.content_mode` is present (contract §8.1) —
  it displays the honest mode label and invokes `tab_set_mode` (§8.2) to
  flip the tab between Obscura snapshot and direct rendering. Absent
  `content_mode` ⇒ no chip, no switch (never assume).
- **List row** (`.row`): 44px min height, hairline bottom border, title +
  muted secondary line (URL/host/time), trailing icon buttons. Empty states
  are plain sentences (`No bookmarks yet.`), never illustrations with
  fabricated counts.
- **Panel** (`.panel`): fills the expanded strip below row 108; header row
  (title + view switcher + close), scrollable body, `--surface-1` fill,
  top radius 16px.
- **Dialog**: native `<dialog>` + `showModal()` (focus trap, Escape, inert
  background for free), radius `--radius-lg`, `--shadow-lg`.
- **Settings rows**: label + control + honest hint; typed controls match the
  schema (`docs/SCHEMA.md` §4): toggle (bool), text (url), select (closed
  enums), number (zoom 10..300).
- **Danger zone** (clear data): scope checkboxes exactly mirroring
  `docs/SCHEMA.md` §5 with the schema's own wording; result area prints the
  real `ClearReport` counts (`history_deleted`, `downloads_deleted`,
  `session_cleared`) — if a count is 0, it shows 0.

## 4. Honest states (AGENTS.md §6 mapping)

1. A control whose command fails shows the runtime's real
   `{ code, message }` in the status bar or panel inline error — the UI
   never retries silently and never reports success it did not get.
2. A command the runtime does not expose ⇒ the trigger is `disabled` with a
   `title` that names the gap and the PLAN.md request that closes it.
   Store-backed triggers are probed once at startup
   (`bookmark_list`, `history_list`, `download_list`, `note_list`,
   `settings_list`); only a *not-found* rejection disables the matching
   trigger — any other failure leaves it enabled so the runtime's real
   error surfaces on use. Overlay triggers (menu, engine dialog, panels)
   are gated on the `chrome_resize` probe the same way.
3. Loading states appear only when a command is in flight (`aria-busy`,
   spinner glyph); lists start in "Loading…" and end in data, empty, or
   error — one of the three, always.
4. The engine mode chip renders **only** when `NavState.content_mode` is
   actually present in the event; absent field ⇒ no chip (never assume).
   When present it doubles as the `tab_set_mode` switch (contract §8.2),
   and `nav.error` (contract §8.3) is surfaced in the status bar verbatim.
5. No toast-only features, no mock rows, no placeholder counts, no fabricated
   badges anywhere in `browser/ui/**` (ROT greps this).

## 5. Accessibility rules (release requirement)

- Every interactive element: reachable by Tab in visual order, `:focus-visible`
  ring `2px var(--primary)` with 2px offset, accessible name (visible label
  or `aria-label`), 32×32 minimum target in the strip (44px in panels).
- Tabs: `role=tablist/tab`, `aria-selected`, `aria-controls` to the content
  webview label; ArrowLeft/Right within the strip.
- Overlays: native `<dialog>` semantics; on close, focus returns to the
  trigger element.
- Live regions: status bar (`role=status`) for command results; panel errors
  `role=alert`.
- Shortcut labels use Windows conventions (Ctrl/Alt), shown in tooltips.
- Contrast: `--ink` on `--canvas` = 14.9:1, `--ink-muted` on `--canvas` =
  5.0:1, white on `--primary` = 6.4:1 — all ≥ WCAG AA for their sizes; new
  pairings must be checked before use.
- `prefers-reduced-motion` disables all transitions/animations.
- Text scaling: panel and menu body text uses `rem` so 200% OS text scaling
  does not clip; strip controls are fixed-height by the layout contract and
  keep 4.5:1 contrast at every supported scale.

## 6. Asset provenance

- Fonts: `assets/fonts/` (Google Fonts downloads, SHA-256 in
  `docs/DEPENDENCIES.md`), copied byte-identically into `browser/ui/fonts/`.
- Icons: `assets/icons/lucide-*.svg` (lucide-static@0.545.0, SHA-256
  recorded), inlined as an SVG `<symbol>` sprite in `index.html` — no icon
  font, no remote icon set.
- Logo: `assets/brand/ritam-logo-*.png` (cropped from the owner's R-logo,
  square box only), copied into `browser/ui/` where used (new tab, about
  area of the engine dialog).
- Favicon display: when `nav.state.favicon_url` is absent the tab shows the
  neutral globe glyph — absence is shown as absence.

## 7. Files

| File | Role |
|---|---|
| `browser/ui/tokens.css` | tokens + @font-face (section 1) |
| `browser/ui/index.html` | chrome document + icon sprite |
| `browser/ui/chrome.css` | layout + components + states + a11y |
| `browser/ui/chrome.js` | contract binding (commands/events), panels |
| `browser/ui/newtab.html` + `newtab.css` | app-origin new tab (static, no script — content webviews hold no IPC permission) |
| `browser/ui/fonts/`, `browser/ui/ritam-logo-*.png` | pinned assets (section 6) |

# IMPLEMENTATION AUDIT — Ritam Browser

**Date:** 2026-10-10 · **Phase 0** · **Author:** ROT (inventory by Govinda)
**Subject:** `code.html` (1,329 lines, "Arc Zen Minimalist Browser" visual
prototype) and the repository baseline. Rule 5 evidence: this audit precedes
any implementation.

## Verdict

`code.html` is a **visual mock only**. It is not a browser, hosts no runtime,
and every visible capability is simulated. It is a valuable design reference
(the Serene Canvas look in motion) and nothing else. Production work starts
from a clean Tauri 2 app; no code is carried over from the prototype except
design intent.

## Quantified simulated surface (measured, not guessed)

| Signal | Count | Meaning |
|---|---|---|
| `onclick=` handlers | 74 | every one routes to local JS functions; none reaches any engine |
| `showToast(...)` calls | 45 | toasts are the sole "result" of most actions — fake success per AGENTS.md §6 |
| `loadSite(...)` calls | 30 | navigation swaps hard-coded in-page content; no HTTP, no DOM of real sites |
| `localStorage` uses | 0 | no persistence at all; notes/favorites/tabs vanish on reload |

## Control inventory (real / partial / simulated / absent)

### Window & chrome
| Control | State | Evidence |
|---|---|---|
| Traffic-light window buttons (close/min/max) | **simulated** | decorative spans; no OS window action |
| Sidebar collapse | partial (visual only) | toggles CSS class; works as UI demo, no persistence |
| Zen focus toggle | simulated | CSS state only |

### Navigation
| Control | State | Evidence |
|---|---|---|
| Back / Forward | **simulated** | operate on an in-memory array of mock site IDs; disabled-state logic exists (reusable pattern) |
| Reload | simulated | spins icon, re-renders mock content |
| Home | simulated | calls `loadSite('wikipedia')` |
| Omnibox (input) | simulated | accepts text; Enter → `loadSite()` if text matches a mock site key, else shows a toast; no URL-vs-search logic, no real navigation |
| Omnibox suggestions dropdown | simulated | filtered from a hard-coded array |
| Favicon / lock icon | **fabricated** | static glyphs; hard-coded HTTPS lock regardless of any real connection — banned by AGENTS.md §6 |
| Copy URL | simulated | copies the mock URL string (this one is honest enough) |
| Star (bookmark) | simulated | toggles icon state; no data store |
| Reader mode | simulated | swaps mock content styling |
| Loading / read-progress bars | simulated | CSS animation on mock loads |

### Tabs & spaces
| Control | State | Evidence |
|---|---|---|
| Tab list (sidebar) | simulated | 5 hard-coded tabs; click switches mock content |
| New tab (+) | absent as real | opens mock new-tab content |
| Close tab | absent | not implemented at all |
| Spaces (Research/Studio) | simulated | switches hard-coded favorites/tabs sets |

### Panels
| Control | State | Evidence |
|---|---|---|
| Downloads dropdown | **fabricated** | sample rows with fake sizes/statuses; badge dot hard-coded |
| Extensions dropdown | **fabricated** | sample extension cards; enable toggles are CSS |
| History dropdown | **fabricated** | populated from mock navigation array; not real history |
| More menu (zoom ±, find, print…) | simulated | zoom changes mock font size only; find/print are toasts |
| Scratchpad | simulated | in-memory notes, "Saved locally" label is a **false claim** (0 localStorage) |
| DevTools panel | **fabricated** | shows decorative pseudo-HTML; no inspection of anything |
| "Peer Reviewed" / "Verified" badges in page content | **fabricated** | part of mock page content; explicitly banned |

### Bottom bar
Zen Studio label, download/settings/sidebar buttons — all simulated or CSS
toggles.

## What is genuinely reusable from the prototype

- Design intent only: layout proportions, palette feel, micro-interaction
  timing (cubic-bezier curves), sidebar/header/viewport structure. These
  become reference material for Govinda's Phase 1 token extraction from the
  authoritative `DESIGN.md` — the prototype is secondary to the token file.

## Repository baseline (runnable state)

| Item | State |
|---|---|
| `obscura/` engine clone @ `1f8eb76` | present, clean, read-only pin |
| Engine binary v0.2.4 (Windows x64, render) | downloaded, hash-verified, smoke-tested: `--version`, live `fetch --eval`, `--screenshot` all pass |
| `obscura-benchmark/` @ `2d7bc30` | cloned, read-only; obstacle course executed for baseline (see `docs/BASELINE_REPORT.md`) |
| Tauri 2 app | **absent** — first scaffold is Phase 1 (Govinda) / Phase 2 (Rohan); no app code exists yet by design (rule 5) |
| WebView2 Evergreen Runtime 154.0.4258.62 | present on the target machine |
| Rust 1.98.1 (x86_64-pc-windows-msvc), Node 24.11.0, npm 11.6.1, Python 3.12 | present |

## Conclusions feeding the plan

1. No existing runtime to preserve — the "browser host" is greenfield.
2. The prototype's disabled-state logic and layout structure are the only
   code-adjacent assets; everything else is discarded per the no-simulated-
   success rule.
3. All Phase 1–3 features are "absent" (not "partial") at baseline: the
   honest inventory the phase-wise plan demands is: **real=0, partial=0,
   simulated=many, absent=all core features**.

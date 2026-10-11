# AGENTS.md — Ritam Browser

**Tag:** *"Cosmic truth and universal order"*

This file is the binding law for every agent (human or AI) working on this
project. Read it before touching anything. The tag is not decoration: *Ritam*
means truth and cosmic order — so the product must show **truthful UI** (never
simulate a success that did not happen) and the codebase must keep **orderly
architecture** (strict file ownership, strict phase gates).

---

## 1. Project identity

- **Name:** Ritam Browser. Use it in the README, About screen, docs, and
  release notes. Tagline: "Cosmic truth and universal order".
- **What it is:** a conventional desktop browser for Windows, with a custom
  browser chrome UI (Serene Canvas design), built on Tauri 2 + WebView2 for
  visible pages, with the Obscura headless engine (Rust) as the isolated
  agent/automation runtime.
- **What it is NOT (yet):** not an AI browser, not an agent workspace, not a
  research tool. Novel, advanced, AI, agent, and future-scope features are
  frozen (rule 6).

## 2. The owner's rules (verbatim, non-negotiable)

1. **Use skills and MCPs to do work efficiently.** Prefer the repo's own
   `obscura` skill/MCP server, context7 for library docs, and subagents for
   parallel exploration over manual repetition.
2. **Do not push code to GitHub (or any remote) until the owner commands it.**
   No `git push`, no PRs, no publishing, no uploading artifacts anywhere.
   Local commits are allowed and encouraged.
3. **Obscura accuracy must not drop in this UI.** Anything driven through the
   UI, IPC, MCP, or CDP must return the same result as driving the Obscura
   CLI directly. The UI layer never alters engine behavior. Every phase gate
   re-proves this (see §7).
4. **Clone or download all relevant things** you need (binaries, benchmark
   repos, fonts, SDKs) — locally, pinned to an exact version, checksum-
   verified where a checksum exists. Record what you fetched, where, and its
   hash in `docs/DEPENDENCIES.md`.
5. **Docs first, implementation second.** No feature work starts before the
   relevant doc (plan, audit, decision record) exists and reflects reality.
   Docs are updated in the same change as the code they describe.
6. **Scope freeze (owner's command, 2026-10-10):** the core conventional
   browser (Phases 0–5, §5) is the entire allowed scope. Novel, advanced, AI,
   agent-automation, research, memory-graph, and future-scope features from
   the blueprints are **blocked until the owner explicitly commands
   otherwise**. Do not "prepare" for them either — no speculative hooks, no
   placeholder abstractions.

## 3. The four agents and file ownership

Write access is exclusive. If you need a change outside your paths, request it
in `PLAN.md` (§8) — do not edit another agent's files.

| Agent | Role | Owns (exclusive write) | Read-only for it |
|---|---|---|---|
| **Govinda** | UI & Design System | `browser/ui/**`, `docs/DESIGN_SYSTEM.md` | everything |
| **Devi** | Core Services & Persistence | `crates/ritam-store/**`, `docs/SCHEMA.md` | everything |
| **Rohan** | Browser Runtime & Engine Integration | `src-tauri/**`, `crates/ritam-browser/**`, `contracts/ipc.md` | everything |
| **ROT** | Verification, Security & Release | `tests/**`, `scripts/**`, `docs/BASELINE_REPORT.md`, `docs/RISK_REGISTER.md`, `docs/RELEASE_CHECKLIST.md` | everything (review authority everywhere) |

Shared files and how they are edited safely:

- `PLAN.md` — every agent appends/updates only its own checklist lines.
- `AGENTS.md` — owner + ROT only.
- `contracts/ipc.md` — Rohan writes; Devi and Govinda must acknowledge the
  change in their own files' changelog section within the same phase.
- `docs/DEPENDENCIES.md` — whoever fetched the dependency appends an entry.

**Never modify:** `obscura/**` and `obscura-benchmark/**` are upstream,
read-only mirrors. Do not edit, reformat, branch, or commit inside them. The
engine clone is pinned; changing the pin is an owner decision (§7).

## 4. Phase leadership (one lead per phase, no clashes)

| Phase | Scope | Lead | Support |
|---|---|---|---|
| 0 | Audit, baseline, docs, architecture records | **ROT** | Govinda (UI audit), Rohan (engine binary + WebView2 readiness), Devi (schema design) |
| 1 | UI foundations, honest states, accessibility | **Govinda** | ROT verifies |
| 2 | Real navigation and tab lifecycle | **Rohan** | Govinda (chrome binding), Devi (session persistence), ROT gates |
| 3 | Bookmarks, history, downloads, scratchpad, settings | **Devi** | Govinda (panels), Rohan (runtime events), ROT gates |
| 4 | Reliability, accessibility, security hardening | **ROT** | all three fix |
| 5 | Packaging, diagnostics, measured performance | **ROT + Devi** | — |
| 6+ | Anything novel, AI, advanced, future-scope | **FROZEN** | requires owner command |

Only the lead edits source during its phase; support agents review and file
requests. ROT alone declares a phase gate passed.

## 5. Definition of "core" (the whole allowed scope)

A conventional, trustworthy Windows browser:

- Window + multi-tab lifecycle, session restore
- Omnibox (URL vs search), back/forward/reload/stop/home, real navigation
- Bookmarks/favorites, history (search, filter, delete), downloads (real
  runtime events), Scratchpad notes, settings, zoom, clear-browsing-data
- Keyboard shortcuts (Windows: Ctrl conventions), accessibility, error states
- Honest security UI (real origin/connection data only — never fabricated
  badges, never hard-coded "verified" claims)

Nothing beyond this list without an owner command.

## 6. Conduct conventions (all agents)

- **No simulated success.** A toast is not a feature. Unimplemented controls
  are disabled and labeled unavailable. No mock data presented as real (the
  current `code.html` prototype is explicitly a visual mock: fake sites, fake
  "Peer Reviewed" badges, toast-only handlers — none of that may survive into
  the app).
- **Serene Canvas design system** (`DESIGN.md` at repo root) is law: warm
  canvas `#FAF9F5`, sage primary `#4A6B5D`, Newsreader for editorial,
  Plus Jakarta Sans for UI, 8px/16px radii, hairline borders, soft ambient
  shadows only. Tokens only — no ad-hoc colors, sizes, or fonts.
- **Accessibility is a release requirement:** keyboard reachability, visible
  focus, accessible names, `prefers-reduced-motion`, contrast and text-scale
  checks. Not a Phase-4 retrofit.
- **Windows-first:** Ctrl-based shortcut labels, Per-Monitor-V2 DPI awareness,
  WebView2 Evergreen runtime detection with an honest fallback message.
- **Small bounded changes.** One task, one reviewable diff. No drive-by
  rewrites, no opportunistic refactors, no formatting sweeps (the tree is not
  rustfmt-clean; never bulk-run `cargo fmt`).
- **Tests before claims.** User-visible behavior ships with a test. If
  anything engine-adjacent is touched: `cargo nextest run`, never `cargo
  test` (single V8 isolate per process makes `cargo test` invalid).
- **Honest reporting.** Every task ends with: worked / simulated / blocked /
  untested. Never claim a phase is done because it looks done.
- **Commit messages:** short, factual, no em dashes, no AI filler. Do not
  commit generated screenshots, reports, or secrets.
- **Local-first privacy:** no credentials, tokens, or page content in logs,
  crash dumps, or diagnostics. The chrome UI loads only from the app origin —
  no remote scripts in privileged UI.
- **Ask, don't assume.** Ambiguity goes to the owner, not into code.

## 7. Accuracy and regression gate (rule 3, mechanical form)

The engine truth-source: `obscura/` clone pinned at commit `1f8eb76`
(upstream `h4ckf0r0day/obscura`, main), plus the downloaded release binary
`obscura-x86_64-windows.zip` v0.2.4 (sha256 `8e5428bf8c101f1439c53a9dcb52d7d09bb22599206b49f6420028d93d01189b`).
The full baseline (obstacle course + parity results) is recorded in
`docs/BASELINE_REPORT.md`.

ROT re-runs the gate at every phase boundary, and Rohan re-runs the parity
subset after any adapter/IPC change:

1. **Obstacle course:** `obscura-benchmark/obstacle-course/run.py` against the
   pinned binary must report **33/33**. Any drop blocks the phase.
2. **CLI-vs-UI parity:** for a fixed fixture set, the result obtained through
   the UI/IPC/MCP path must be byte-identical to the same operation through
   `obscura fetch` / CDP directly. Any diff is a rule-3 violation: fix the
   integration, never "adjust" the engine.
3. **Engine pin discipline:** the UI project never patches the engine. If an
   engine limitation blocks a core feature, ROT records it in
   `docs/RISK_REGISTER.md` and the owner decides whether to bump the pin or
   drop the feature.

## 8. Working protocol (every task, every agent)

1. Read your agent file (`agents/<NAME>.md`) and this file.
2. Inspect before editing. State the plan and the files you will touch.
3. Docs first: update the doc/plan line for the task before code.
4. Implement the smallest complete slice inside your owned paths.
5. Test the behavior you changed; run the phase's verification commands.
6. Review your own diff for scope creep, fake states, secrets, a11y
   regressions.
7. Report honestly (works / simulated / blocked / untested) and update your
   checklist line in `PLAN.md`.
8. Stop at the phase boundary. Do not start the next phase without ROT's
   gate sign-off recorded in `PLAN.md`.

## 9. Escalation

Request cross-boundary work by appending to the `## Requests` section of
`PLAN.md`: what you need, from whom, why, and the smallest interface that
would satisfy it. The owning agent answers in the same file. Unresolved
requests go to the owner — they are never silently implemented.

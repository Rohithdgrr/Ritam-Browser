# RISK REGISTER — Ritam Browser

**Owner of file:** ROT · **Updated:** 2026-10-10 (Phase 0)
Severity: H(igh) / M(edium) / L(ow). Owner-decision items are marked ⚑.

| # | Risk | Sev | Status / mitigation |
|---|---|---|---|
| R1 | Tauri 2 may not support the multi-webview tab model we need | H | Phase 2 spike gate (see ARCHITECTURE_DECISION D2). Fallback: `tao`/`wry` direct host, already shortlisted. Not discovered late — first week of Phase 2. |
| R2 | WebView2 EULA/distribution terms for a standalone browser unverified | H | ⚑ Owner: internal use now; legal-source check required before ANY public distribution (blueprint ADR-008 gate). Tracked here so it cannot be forgotten. |
| R3 | Two rendering worlds (Chromium visible vs Obscura agent) may confuse expectations | M | Accepted by design (D1). Parity gate governs the Obscura path; UI must label which runtime produced a result when both are exposed. |
| R4 | Obscura engine limitations (IndexedDB persistence bug #1093, no service workers, media gaps) leak into user-visible agent features | M | Engine is isolated; features that depend on broken engine surfaces are held back rather than shipped broken. Pin bump is an owner decision (AGENTS.md §7.3). |
| R5 | Windows build of anything engine-adjacent unproven (V8-from-source build not yet attempted here) | L | Mitigated: official v0.2.4 Windows binary works (smoke-tested). Source build only needed if we ever build the engine — currently never (D3). |
| R6 | Obstacle course / benchmark harness is Linux-flavored (bash wrappers, GNU time, /etc/hosts for WPT) | L | `obstacle-course/run.py` is stdlib Python and runs on Windows (verified this phase). WPT track stays Linux/CI-only; documented, not silently skipped. |
| R7 | `code.html` prototype's fake affordances creeping into the real UI | M | Audit done (`IMPLEMENTATION_AUDIT.md`); no code carried over; Govinda's Phase 1 exit gate explicitly includes "no mock remnants". |
| R8 | Scope creep into frozen AI/novel features (blueprint pressure) | M | Rule 6 freeze + ROT scope-police duty at every gate. Blueprints stay reference-only. |
| R9 | Single dev machine = single point of failure; no CI, no remote (by owner rule 2) | M | Accepted while rule 2 stands. Local commits frequent; backup of `C:\Users\rohit\Downloads\RITAM BROWSER` is the owner's responsibility — flagged, not solved by us. |
| R10 | Pinned engine binary may diverge from cloned source (v0.2.4 vs `1f8eb76` main) | L | Both recorded with hashes; parity baseline measured against the binary we ship. Pin move = owner decision. |
| R11 | Obstacle course `fingerprint` stage expects `tz=Europe/Berlin`; this host is `India Standard Time` and the engine's `OBSCURA_TIMEZONE` pin only sets `TZ`, which V8/ICU ignores on Windows — the gate reads **32/33**, not 33/33 | H | ⚑ Owner decision pending (PLAN.md → Requests): (a) one-time admin elevation to switch the machine tz for gate runs and restore after, or (b) owner amends AGENTS.md §7 in writing with the timezone precondition. ROT will not relax the 33/33 criterion unilaterally. Gate otherwise re-confirmed 32/33 on 2026-10-10 14:31 with `PYTHONUTF8=1`. |
| R12 | Multiple agent sessions write this working tree concurrently (observed 2026-10-10: PLAN.md fully rewritten by one session at 14:35 while another held it; `src-tauri/**` edited by a sibling within seconds of ROT inspection) | M | ROT does not edit another agent's paths while that session is live; gates run read-only; every ROT edit to shared files is announced in PLAN.md. Lost-update risk is real — owners of a file re-read before writing. No git repo exists (owner rule 2 allows local commits; a local-only repo would make concurrent edits recoverable — flagged to owner as an open suggestion, not implemented). |

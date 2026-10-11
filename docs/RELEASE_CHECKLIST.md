# RELEASE CHECKLIST — Ritam Browser

**Owner of file:** ROT (Phase 5 co-lead with Devi, ROT.md).
**Status:** v0.1 — created 2026-10-10. Boxes are checked only with
evidence (command + result recorded in `docs/BASELINE_REPORT.md` or the
linked file). An unchecked box is work not done, not work assumed done.

## 1. Accuracy gates (AGENTS.md §7 — re-run at every release candidate)

- [ ] Obstacle course **33/33** against the pinned binary
      (`PYTHONUTF8=1 python obscura-benchmark/obstacle-course/run.py`).
      Current: **32/33** — `fingerprint` blocked on host timezone
      (RISK_REGISTER R11, owner decision pending).
- [ ] CLI-vs-UI parity **100% byte-identical** on the fixture set
      (`node scripts/parity-check.mjs`). Current: **10/10 (2026-10-10)**.
- [ ] In-app `engine_verify` reports `identical: true` on a live page
      through the packaged binary (not the dev checkout).
- [ ] Engine pin unchanged, or pin bump recorded by the owner in
      `AGENTS.md` §7 + `docs/DEPENDENCIES.md` with new hash.

## 2. Test suites (nextest only — never `cargo test`, AGENTS.md §6)

- [ ] `crates/ritam-store` nextest green (Phase 3 persistence gate).
- [ ] `src-tauri` unit tests green (state/history/coalescer/runtime).
- [ ] `crates/ritam-browser` tests green (nav policy; live tests under
      `OBSCURA_LIVE=1`).
- [ ] Chrome UI tests (`tests/`) green: no fake states, disabled-until-
      implemented controls, honest error rendering.

## 3. Honesty audit (AGENTS.md §6 — ROT checklist)

- [ ] No simulated success anywhere: every toast/status backed by a real
      command result; every unimplemented control disabled + labeled.
- [ ] No fabricated security UI: origin only, no "verified/secure" badges.
- [ ] Engine mode badge shows the real content source (`Obscura snapshot`
      vs `Direct (Chromium)`); snapshot mode states its no-scripts/no-forms
      limits visibly.
- [ ] Engine-unavailable states show the engine's own message; no silent
      fallback while an engine badge is shown.
- [ ] No mock data from `code.html` prototype survives (`docs/IMPLEMENTATION_AUDIT.md`).

## 4. Security & privacy (ROT checklist, every gate)

- [ ] No secrets/credentials/page content in logs, diagnostics, crash dumps.
- [ ] Chrome UI loads from app origin only; no remote scripts in privileged
      UI (CSP enforced, `withGlobalTauri` surface audited).
- [ ] Content webviews unlisted in capabilities (zero IPC permissions) —
      verified against `src-tauri/gen/schemas/acl-manifests.json`.
- [ ] External-protocol handoff only after UI confirmation
      (`nav_submit` → dialog → `external_open`); blocked schemes enforced.
- [ ] Clear-browsing-data scopes honest; `ClearReport` row counts shown to
      the user match the store's return byte-for-byte.
- [ ] Local-first: no telemetry, no remote calls except user-navigated
      pages and the engine's own fetches.

## 5. Legal / distribution (owner decisions — RISK_REGISTER R2)

- [ ] WebView2 EULA/redistribution terms verified for standalone
      distribution (blueprint ADR-008 gate). **Internal use only until
      this is checked.**
- [ ] `docs/DEPENDENCIES.md` lists every shipped dependency with version
      + hash (engine zip, fonts, SDKs).

## 6. Packaging & metadata (Phase 5, ROT + Devi)

- [ ] Reproducible build: pinned toolchain (`rustc -V` recorded), locked
      dependencies, build command documented and re-run from a clean tree.
- [ ] Version/About: app version, engine version (`obscura --version`),
      WebView2 runtime version, build date shown on the About screen —
      all read at runtime, never hard-coded.
- [ ] Icon/branding assets from `assets/brand/` only.
- [ ] Installer/bundle path documented; artifacts NOT pushed anywhere
      (owner rule 2 — local only until commanded).

## 7. Diagnostics & measured performance (Phase 5 — numbers, not guesses)

- [ ] Startup time measured (cold + warm, 3 runs, median recorded here
      and in BASELINE_REPORT).
- [ ] Memory with 3 tabs open measured (working set, recorded).
- [ ] First-navigation responsiveness measured (omnibox enter →
      loading state visible).
- [ ] Diagnostics bundle: redaction verified (no URLs' query strings,
      no page content, no history bodies in logs).

## 8. Sign-off

- [ ] Every box above checked with evidence, or explicitly waived by the
      owner **in writing in `AGENTS.md`** (ROT may not waive).
- [ ] ROT sign-off line in `PLAN.md` naming the evidence files.
- [ ] Owner command received before any push/upload (rule 2).

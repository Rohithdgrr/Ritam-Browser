# Obscura-Based AI-Native Browser
## Consolidated Product, Architecture and Execution Plan — v3.0

**Status:** Consolidated engineering baseline incorporating three audit rounds  
**Date:** 10 October 2026  
**Target:** Windows desktop first  
**Audience:** Product owner, frontend/backend engineers, systems engineers, AI/automation engineers, security reviewers and enterprise stakeholders

---

# 0. Executive Decision

Build a **privacy-conscious, resumable, auditable browser workspace**, not a general-purpose browser engine from scratch.

The browser should combine:
- Familiar browser controls and multi-window/tab management.
- A low-overhead custom browser-chrome UI.
- A visible Windows web runtime.
- A separately permissioned agent/automation layer.
- Local-first task memory and search.
- Read-only AI assistance before mutating automation.
- A single action registry shared by toolbar controls, keyboard shortcuts, command palette and MCP.
- A staged route to developer and enterprise features.

The original plan was strong as a feature catalogue but not sufficiently decisive about the engine, desktop host, session boundaries, and delivery scope. This consolidated version is the single source of truth. It incorporates closure items from the third-pass audits, removes patch-layer addenda, and freezes feature scope through v1.1. Decisions that require empirical proof remain evidence-gated.

## 0.1 Core architectural decision

**Default architecture to prove first:** native Windows host + WebView2 for visible browsing, with a rendering/automation adapter boundary. Evaluate Obscura and headless Chromium as isolated agent runtimes. Do not require Obscura to render the user's visible tabs.

**Do not assume that WebView2 automatically provides a complete consumer-browser experience.** Browser features such as find-in-page, error interstitials, popup handling, permission prompts, context menus, print, downloads, profiles, accessibility, and extension support need explicit design and testing.

## 0.2 Release strategy

- **MVP:** conventional browsing shell, multiple windows and tabs, local persistence, privacy/profile basics, command palette, and a reliable event-handler implementation.
- **v1.0:** add Task Memory, Tab Overload Autopilot, and Web Portability; add read-only AI summary/extraction only after privacy and reliability gates pass.
- **v1.1+:** workflow recording/replay, form assistance, shopping comparisons, privacy radar, truth checking, subscription reminders, and advanced enterprise management as separate feature tracks.

## 0.3 What this plan will not claim

It will not claim that the browser is automatically faster, lighter, safer, more private, or more compatible than major browsers. Those are outcomes to establish with controlled benchmarks and independent security review.

---

# 1. Product Definition

## 1.1 Problem statement

People use the browser as their main workspace, but their work is fragmented across tabs, sites, documents, forms, and repeated actions. They struggle to resume complex tasks, locate information across many open tabs, preserve useful evidence, compare sources, and automate repetitive work without losing control of their accounts or data.

Enterprise users add requirements around managed configuration, identity separation, data handling, auditing, deployment, and security. Developers need inspection and reproducible workflows. Everyday users need simple navigation, predictable behavior, accessibility, and privacy controls.

## 1.2 Aim

Create a Windows-first AI-native browser that reduces repetitive web work and makes browsing tasks resumable, searchable, explainable, and safely automatable without compromising ordinary browsing reliability.

## 1.3 Product principles

1. **Ordinary browsing first:** the browser remains useful when AI, MCP, or Obscura is unavailable.
2. **Local-first:** history, bookmarks, task notes, and preferences stay local by default.
3. **No silent session sharing:** agent contexts are isolated unless the user explicitly approves a safe, scoped handoff.
4. **Visible automation:** show the active task, context, action, risk level, and stop control.
5. **One action contract:** UI, keyboard, command palette and MCP call the same validated action registry.
6. **Least privilege:** the AI/agent process never receives unrestricted access to OS secrets or arbitrary shell commands.
7. **Evidence over confidence theater:** summaries and research outputs expose sources and uncertainty.
8. **Progressive capability:** read-only tools first; page mutation later.
9. **Measured performance:** optimize from repeatable measurements rather than assumptions.
10. **Enterprise optionality:** enterprise services must not impose needless overhead on personal users.

## 1.4 Target users

| User segment | Main needs | Initial value |
|---|---|---|
| Everyday users | Simple browser, tab recovery, quick search, privacy | Reliable shell, tab search, task restore |
| Students/researchers | Save sources, compare information, resume research | Task Memory, Web Portability, source links |
| Developers | Inspect pages, repeat test flows, debug automation | DevTools, command palette, workflow trace |
| Engineers | Documentation search, technical comparison, exports | Searchable workspaces and evidence-preserving exports |
| Enterprise employees | Profile separation, managed AI, predictable retention | Isolated profiles, policies and audit controls |
| IT/security administrators | Policy, deployment, updates, auditability | Managed configuration and signed releases |
| Automation developers | Stable API, reproducible runs, safe tools | Action registry, MCP and capability matrix |

## 1.5 Non-goals for initial release

- Building a new rendering engine.
- Full Chrome extension compatibility.
- DRM/Widevine parity with mainstream browsers.
- Automatic purchases, payments, account deletion, or message submission.
- Bypassing CAPTCHAs, paywalls, authentication controls, rate limits, or website access restrictions.
- Guaranteed anonymity or perfect tracker/fingerprint protection.
- Formal compliance certification without independent assessment.
- Cross-platform parity in the first Windows release.
- Password-manager replacement in v1.0.

---

# 2. Scope and Feature Prioritization

- v1 inherits WebView2's native autofill/password-suggestion behavior as-is, with a visible settings toggle to disable it. The product does not build or sync its own password store in v1.

## 2.1 The 18 expected browser controls

All applicable actions must be available from visible UI and the command palette. Keyboard shortcuts are provided for common actions and must be configurable where conflicts arise.

| # | Control | v1 priority | Implementation notes |
|---:|---|---|---|
| 1 | Back | P0 | Current tab navigation history |
| 2 | Forward | P0 | Current tab navigation history |
| 3 | Reload / Stop | P0 | State-aware button; loading and cancellation states |
| 4 | Omnibox | P0 | URL/search classification, safe normalization, configured search provider |
| 5 | New Tab | P0 | Tab manager; default new-tab page |
| 6 | Close Tab | P0 | Recovery metadata; confirmation only when necessary |
| 7 | Tab Switcher / Search | P0 | Fuzzy title/URL search and keyboard navigation |
| 8 | Bookmarks / Star | P0 | Local storage, folders, duplicate handling |
| 9 | History | P0 | Search, retention and delete controls |
| 10 | Downloads | P0 | Native download events, progress, cancel/open/reveal |
| 11 | Extensions / Add-ons | Deferred | Explicitly state no Chrome parity; revisit after threat model |
| 12 | Settings / Main Menu | P0 | Schema-backed settings where practical |
| 13 | Profile Switcher | P1 | Separate profile data and permissions |
| 14 | Find in Page | P1 | Implement and test custom find UI; do not assume built-in API parity |
| 15 | Zoom / Text Size | P1 | WebView zoom plus accessibility preferences |
| 16 | Privacy Controls | P1 | Private context, site permissions, tracker policy if supported |
| 17 | DevTools / Inspector | P1 | WebView2 DevTools integration; gated behind developer setting |
| 18 | AI Assistant / Agent Panel | P1 read-only | Summary/extraction first; mutation disabled until safety gate |

**P0** means necessary for the initial usable browser. **P1** means a target for the first stable release, provided the core is reliable. **Deferred** means it must not block the first release.

## 2.2 Secondary features

Home, Reader Mode, Share, Print, Translate, Voice Search, QR Scanner, Cast, Save Page, page source, tab pinning, split view, recently closed tabs, and site-data clearing.

- **Cast:** remove from v1 scope unless a real, supportable platform integration is proven.
- **Reader Mode:** likely feasible through content extraction, but dynamic pages and protected content need fallback behavior.
- **Print / PDF:** implement through supported WebView2 printing capabilities and test real-world layouts.
- **Translate:** treat as a provider/model integration with clear privacy disclosure.
- **Voice Search / QR Scanner:** later optional features; do not block browser reliability work.

## 2.3 Nine proposed differentiators

These remain the long-term feature portfolio, not a single release commitment.

### F1. Task Memory — v1.0
Save task names, selected tabs, titles, URLs, notes, safe snapshots and next steps. Restore context without replaying consequential actions. Allow export and deletion. Do not store passwords, payment fields, or sensitive form values by default.

### F2. True-Cost Shopping Agent — later
Compare equivalent products and surface visible price, shipping, taxes where available, recurring charges, delivery, warranty and return conditions. Show missing data. No automatic checkout. Legal and accuracy review required before launch.

### F3. Tab Overload Autopilot — v1.0
Cluster tabs by title/domain and optionally semantic similarity; find duplicates; recommend archive/close actions. Always provide undo or recoverable snapshots. No automatic bulk closing without explicit opt-in.

### F4. Form Rescue and Autofill — later
Explain required fields and validation errors; suggest user-approved values; mask sensitive values; require confirmation before submission. Not a password manager.

### F5. Cross-Site Truth Checker — later/experimental
Extract claims, compare dated sources, show supporting and contradictory passages, and distinguish evidence from inference. No unqualified “true/false” output. Requires an evaluation dataset and counsel review for the intended use.

### F6. Personal Data Leak Radar — later
Explain observed third-party requests and permission prompts, with supported remediation actions. Do not claim complete leak detection. Reports remain local by default.

### F7. Subscription and Free-Trial Guardian — later
Create reminders from user-confirmed renewal information and approved sources. Show source and time zone. Never claim cancellation without a provider confirmation.

### F8. Teach-Once, Replay-Anywhere — later
Record approved workflows, use resilient locators and assertions, provide dry-run mode, pause on page changes, and require approval for high-impact actions. This depends on the mature action permission and trace system.

### F9. Universal Web Portability — v1.0
Export accessible content to Markdown, text, PDF, or JSON where supported. Preserve title, source URL, capture time and citations. Do not guarantee fidelity for dynamic, DRM-protected or inaccessible content.

## 2.4 Recommended unique features to evaluate later

These are hypotheses, not guaranteed market-first claims:
- **Live Tab Content Search:** search text across open tabs and jump to a highlighted result.
- **Domain Eraser:** one action to remove selected site's history, permissions, bookmarks and task artifacts, with a clear preview.
- **Local Semantic Memory:** optional local embeddings for bookmarks, notes and task summaries.
- **Page Diff Watcher:** compare scheduled, authorized page captures and notify on changes.
- **Branching History:** visually recover navigation branches.
- **Consent Assistant:** manage cookie banners only through reviewed rules and user policy.
- **LAN Task Handoff:** transfer a task between trusted devices without cloud sync.
- **AI Spend Meter:** display estimated and actual AI cost by task where provider data permits.
- **Evidence Ledger:** preserve source URLs, capture time, content hash and export manifest; cryptographic timestamping is a later feature requiring a trusted timestamp provider.
- **Reader Queue:** offline read-later archive with full-text search.

Choose new features using user research, reliability, cost, and support burden—not novelty alone.

---

# 3. Architecture Decisions and Decision Gates

## ADR-001 — Desktop Host

**Candidate A: Direct native WebView2 host**
- Pros: precise control over windows, multiple controllers, native events, profile selection and tab lifecycle.
- Cons: more native integration and maintenance; more responsibilities for accessibility, packaging, updates, and window behavior.

**Candidate B: Tauri 2**
- Pros: maintained application framework, IPC/capability model, build and packaging support.
- Cons: the browser's multi-webview and profile requirements may not align with its normal app model; verify exact supported behavior before committing.

**Decision rule:** perform a 3–5 day prototype with two windows, multiple tab controllers, profiles, popups, downloads, keyboard routing, DevTools, and custom chrome UI. Pick the host that passes the acceptance checklist with the least custom glue. Do not combine both approaches in production unless a specific, measured need justifies it.

**Working default:** direct WebView2 host for the prototype because multi-window, multi-tab, and controller lifecycle are central to a browser. This is a provisional default, not a final claim that Tauri cannot work.

**Maintenance-surface rubric:** alongside prototype correctness, explicitly compare who owns ongoing fixes for windowing, WebView2 integration, IPC, packaging/signing, updates, and rollback. If a direct host requires assembling four or more primitives that Tauri already maintains, record that as evidence in Tauri's favor; a working 3–5 day prototype does not prove lower year-two cost.

This decision is finalized jointly with ADR-010 (chrome hosting) and ADR-014 (library shortlist). The spike chooses which crate owns window/event lifecycle; the decorated-frame MVP and app-local WebView2 chrome controller are already the product baseline.

## ADR-002 — Rendering and automation runtime

Run a 2–3 week competitive spike:
1. WebView2-based agent context, separate from visible tabs.
2. Obscura pinned to a specific upstream repository, version, commit and license.
3. Pinned headless Chromium managed through a maintained CDP client.

Define a `RenderingAdapter` interface such as:
- `create_context`
- `navigate`
- `wait_for`
- `extract_readable_content`
- `find_element`
- `click`
- `fill`
- `capture_screenshot`
- `get_session_capabilities`
- `close_context`

Not every adapter needs to support every method. Return typed `CAPABILITY_UNAVAILABLE` results rather than silently pretending parity.

**Selection criteria:** compatibility, correctness, startup, peak/steady-state memory, CPU, isolation, session model, maintainability, license, Windows behavior, and test burden.

**Default product policy:** WebView2 for visible browsing. Agent contexts use a separate context by default. Obscura remains optional until it demonstrates a clear measured advantage for supported tasks. Do not use anti-detection capabilities to bypass access controls or site policies.

**Agent-process privilege gate:** evaluate restricted tokens, Low Integrity, or AppContainer isolation for headless/Obscura child processes in addition to Job Objects. Job Objects are resource/lifecycle controls, not privilege isolation. Record engine support and limitations in the weighted scorecard; do not claim sandboxing unless filesystem, registry, network and token restrictions are verified.

## ADR-003 — Session and profile model

- Personal, work, private, and agent contexts are separate by default.
- No automatic copying of cookies, local storage, or authentication tokens.
- A future opt-in handoff must be origin-scoped, time-limited, auditable, revocable and visible.
- Never allow session sharing for banking, payment, identity-provider/SSO, or other configured high-risk origins.
- Session sharing does not promise identical browser fingerprints or site behavior.
- The UI must say when an agent is acting under the user's logged-in identity.

## ADR-004 — Frontend state

Keep HTML, Vanilla CSS and ES modules as requested, but use a small signal-based state layer such as `@preact/signals-core` after bundle/license review. Use explicit component mount/unmount contracts and a shared event bus only where needed.

Do not build a custom virtual DOM, global pub/sub framework, or template engine. If component complexity grows beyond the measured maintenance budget, benchmark Svelte or SolidJS as a deliberate migration decision.

## ADR-005 — Local persistence

Use SQLite with WAL mode, schema migrations, prepared statements, transactions, and a single write actor/task in the Rust host. All other components submit typed write commands over bounded channels. Use FTS5 for full-text search where it fits.

Do not add a second database just to handle hypothetical audit volume. Benchmark first. Add a separate append-only store only if measured load justifies its operational complexity.

## ADR-006 — Local agent transport

Use Windows Named Pipes with current-user ACLs for local MCP communication. Enroll clients explicitly, record client identity where the OS permits, use per-client capabilities, rate limits and revocation. Do not expose CDP or MCP over a network interface by default. If a TCP mode is ever required, it must be opt-in, authenticated, bound narrowly, and documented as a separate threat model.

## ADR-007 — Security and supply chain

- UI served from a custom application origin/scheme where supported, not an unrestricted `file://` origin.
- Strict Content Security Policy; no remote scripts in the privileged chrome UI.
- Schema-first IPC with generated bindings and contract tests.
- CI gates for dependency audit, license policy and SBOM generation.
- Release signing through a protected CI signing service; do not store signing keys on developer workstations.
- Build provenance and reproducible build effort according to team capability.
- No claim of formal SLSA level or compliance certification unless the required controls are actually met.

---

## ADR-008 — WebView2 Runtime Distribution

**Decision:** Evergreen WebView2 Runtime is the consumer default. Microsoft manages runtime security updates, reducing the browser team's patch burden. The installer must detect whether the runtime is present and provide a clear bootstrap/install path when needed.

**Enterprise/offline option:** Fixed Version is a separately packaged enterprise deployment mode only when a customer has a documented offline or compatibility requirement. It increases installer size and transfers runtime patching responsibility to the product team; every fixed-runtime release must have a published patch SLA and upgrade mechanism.

**Required evidence and controls**
- Record WebView2 runtime version, app version, OS build, and relevant feature flags in local diagnostic reports; transmit only with explicit opt-in.
- Include Evergreen and any supported Fixed Version in the compatibility matrix.
- Test first-run installation with network available, network blocked, runtime missing, and runtime update occurring.
- Re-evaluate this ADR if Microsoft distribution policy or enterprise deployment requirements change.

**Multi-profile capability floor:** Phase 0 must pin the exact WebView2 SDK version and verify the minimum Evergreen Runtime version required by the chosen profile APIs. At startup, run a capability check; if the runtime is below the supported floor, explain the requirement and block profile isolation-dependent features rather than silently falling back to a shared profile. Include the version and capability result in local diagnostics.

**Legal gate:** verify current Microsoft WebView2 distribution/EULA terms explicitly permit embedding in a standalone browser product. Record the source, date, conclusion and counsel review status in `DEPENDENCIES.md` before public distribution.

## ADR-009 — Installer, Updater and Distribution

**Decision:** use a signed Windows installer package suitable for a consumer desktop app (EXE bootstrapper or MSI selected in Phase 0 after install/upgrade/uninstall tests). Do not make MSIX the default without proving that its packaging, protocol association, WebView2 data location, update, and debugging constraints fit the product.

**Updater:** use a signed manifest containing app version, minimum supported version, artifact hashes, release channel, and rollout eligibility. Stage releases in versioned directories; do not overwrite a running executable. Use a pending swap completed at next launch when locked, retain a last-known-good directory, and test interrupted swaps. Verify signatures and hashes before installation. Use a simple HTTPS release host first; staged rollout and delta updates are follow-on optimizations, not MVP blockers.

**Safety requirements**
- Update checks are deferred until after first paint and are user-configurable.
- Never execute an update artifact based solely on an unsigned URL or response.
- Support rollback to the last known-good app version where technically safe; test interrupted update, corrupted package, signature failure, and rollback.
- Keep runtime updates (Evergreen) distinct from app updates.
- Enterprise update endpoints and pinned release channels belong to Phase 6.

**Install scope:** per-user installation is the consumer default (no elevation for routine install/update); per-machine installation is an enterprise option. Phase 0 must test per-user protocol/default-browser registration and the Windows Settings handoff.

**In-place update mechanics:** stage each version in a versioned directory and use a small updater/bootstrapper to switch versions safely. Do not overwrite a running executable in place. If a process/file lock prevents the swap, record a pending update and complete it at next launch; retain the last known-good version for rollback. Test updates while the app is running, while closed, and interrupted mid-swap.

**Metered connections:** query Windows network-cost information. Defer non-critical update checks/downloads on metered connections unless the user opts in; security-critical notices must remain visible, with download timing handled according to the user's policy.

## ADR-010 — Chrome Hosting, Focus and Window Chrome

**Decision:** the first implementation uses a standard decorated native Windows frame to avoid making custom non-client behavior an MVP dependency. The browser chrome (tabs, omnibox, toolbar, command palette) is app-local HTML/CSS/JS hosted in a dedicated WebView2 controller. Map bundled assets to a reserved virtual origin such as `https://app.local/` using `SetVirtualHostNameToFolderMapping`; never load privileged chrome from `file://`.

**Custom chrome is gated:** if a frameless title bar is required for the intended visual identity, prototype it with `tao` or `winit` plus the selected WebView2 host binding. These libraries help with window creation and event handling but do not, by themselves, prove complete Windows Snap Layout or custom hit-test correctness.

**Acceptance tests**
- Keyboard focus moves predictably between chrome and content controllers; define `MoveFocus`, accelerator routing, Tab-boundary semantics, and Escape behavior.
- Screen-reader focus remains intelligible across chrome/content UI Automation trees.
- Verify `WM_NCHITTEST`/non-client behavior only if custom chrome is enabled; test drag regions, resize edges, Snap Layout hover affordance, snap/restore, taskbar thumbnail/Aero Peek, and multi-window behavior.
- Declare Per-Monitor-V2 DPI awareness in the manifest. Handle live `WM_DPICHANGED` so window chrome and WebView2 bounds remain aligned across mixed-DPI monitors.
- Test Windows 11 rounded corners/shadow/Mica only where supported; degrade gracefully.
- A chrome-controller crash must not corrupt browser data; a watchdog may restart the chrome UI while preserving the core host when safe.

**Virtual-host safety:** if `SetVirtualHostNameToFolderMapping` is used, its mapped directory must contain only public, read-only UI assets—never configuration, credentials, diagnostics, or user data. Phase 0 should evaluate `SetCustomSchemeRegistration` as an alternative and record secure-context, CORS, navigation, and debugging behavior. Do not change the origin primitive without a passing prototype and threat-model review.

## ADR-011 — OS Integration and Single-Instance Behavior

**Decision:** implement single-instance behavior with a named mutex plus a validated URL/message handoff to the existing process. Treat all handed-off URLs as untrusted input and route them through the same URL/protocol policy as omnibox navigation.

**Default-browser registration:** support the documented Windows registration flow and provide a clear deep link/instruction to Windows Settings when user confirmation is required. Do not attempt to bypass Windows' protected UserChoice mechanism.

**Protocol and taskbar integration**
- Handle `http`/`https` associations, registered file types only if explicitly supported, and `mailto:` or custom schemes through a confirmation policy.
- Show the requesting page/origin and scheme in prompts for external protocol launches.
- Add taskbar download progress and basic Jump List support only after the shell, install, and association flows are stable.
- Test multiple launches, malformed handoff payloads, concurrent startup, default-browser changes, uninstall cleanup, and external protocol spoofing.

## ADR-012 — Supported Windows Versions

**Decision:** Windows 11 is the primary and fully tested v1 target. Windows 10 support is not implied. Support it only if Phase 0 demonstrates acceptable WebView2/runtime, DPI, installer, and security behavior and the project publishes a separate support statement. As of the plan date (October 2026), Windows 10 is past standard support; customers using eligible Extended Security Updates are a distinct support consideration.

**Compatibility reporting:** every test record includes Windows build, architecture, WebView2 runtime version, display scaling, and GPU/hardware-acceleration state.

## ADR-013 — Local Secrets and Artifact Encryption

**Decision:** store provider credentials in Windows Credential Manager via an audited keyring abstraction. Generate a random local data-encryption key; protect the key with Windows DPAPI (`CryptProtectData`/`CryptUnprotectData`) and use AES-256-GCM for sensitive artifact blobs. Keep keys out of logs, crash dumps, IPC payloads, and workflow exports.

**Caveats:** DPAPI user-scope protection does not protect against malware running as that same user or a compromised logged-in session. Encryption is not a substitute for access controls, deletion, or consent. Enterprise HSM-backed key management is a Phase 6 option.

**Key lifecycle**
- Use a key ring with a current key identifier and support reads of older key versions during rotation; re-encrypt old blobs lazily on access or in bounded idle-time batches.
- Choose and document key scope (per-install vs per-profile) before Phase 2. Profile deletion must delete that profile's key material and artifacts according to the published retention policy.
- Profile export must decrypt locally and re-encrypt under a user-supplied passphrase or a separately supported portable format; never export DPAPI-wrapped blobs as if they were portable.
- Do not place bulk snapshots in roaming profile locations. Document local storage paths and roaming behavior.
- If DPAPI decryption fails after an account/password recovery event, preserve bookmarks/history where available, mark encrypted artifacts unavailable, avoid crashing, and explain recovery limitations.
- Phase 2 tests cover rotation, profile deletion, export/import on another Windows account, DPAPI failure, and recovery from an older key.

## ADR-014 — Dependency and Contract Tooling Defaults

**Initial defaults, subject to Phase 0 license/maintenance verification**
- Window host: `webview2-com`/`windows` for the direct-host spike; `wry` if it materially reduces integration risk. `tao`/`winit` are candidates for window lifecycle, not a promise of complete custom chrome.
- Frontend state: `@preact/signals-core`, with explicit component lifecycle conventions.
- Rust/TypeScript contracts: `schemars` for JSON Schema and one selected generator (`specta` or `ts-rs`) with CI contract tests; avoid two generators unless a spike proves a need.
- SQLite: `rusqlite` with bundled SQLite and FTS5, behind a single-writer actor.
- Headless CDP candidate: `chromiumoxide`; keep it out of the shipped default unless it wins the Phase 0 gate.
- MCP: `rmcp`; host-side named pipe and permission broker remain authoritative.
- URL/omnibox: `url`, `idna`, and a maintained public-suffix implementation; palette scoring: `nucleo`.
- Localization: Fluent (`fluent-rs`/`fluent-bundle`) after a small pluralization and fallback prototype.
- Tracker filtering: Brave's `adblock` crate after verifying crate status and list licensing/attribution; do not ship a custom matcher.
- AI network: `reqwest`, `governor`, and `backoff`; secrets: `keyring`; blob encryption: `aes-gcm`; compression: `zstd`.
- Testing/supply chain: `proptest`, `cargo-audit`, `cargo-deny`, and `cargo-cyclonedx`. Use DOMPurify for untrusted AI-panel HTML and axe-core for automated accessibility checks.
- Reader mode: prefer Mozilla Readability (`@mozilla/readability`) in the JS layer; HTML-to-Markdown export may use `htmd` or `fast_html2md` after output-quality and license tests.
- Future semantic search: benchmark ONNX Runtime plus a small quantized embedding model and `usearch`/`hnsw_rs` or `sqlite-vec`; do not include embeddings in v1 without a demonstrated need.

**Rule:** a package name in this list is a shortlist, not a license or maintenance guarantee. Phase 0 must record exact version, repository, license, last meaningful release, open security issues, platform constraints, and replacement plan in `DEPENDENCIES.md`.

# 4. Proposed System Architecture

```text
[Native decorated Windows frame + app-local chrome WebView2 controller]
                 │ typed IPC / async event bridge
                 ▼
[Core host: Window/Tab/Action/Policy/Permission/MCP broker]
                 │
                 ├── STA UI thread + Win32 message pump + all WebView2 COM calls
                 │             ⇅ bounded, non-blocking channels
                 │      [Tokio runtime: IPC, AI gateway, agent adapters]
                 │             ⇅ typed persistence commands
                 │      [SQLite single-writer actor] ⇄ [BackupService]
                 │
                 ├── [Visible WebView2 content controllers]
                 │
                 └── [Restricted agent child process under Job Object +
                      reduced privilege where supported; chosen adapter only]

[Optional external services] are reachable only through explicit privacy/policy boundaries.
```

## 4.1 Process boundaries

Minimum separation:
- **Core host:** owns window lifecycle, action permissions, persistent state, and access to platform secret storage.
- **Visible web runtime:** renders untrusted sites with the narrowest supported host privileges.
- **Agent/AI service:** receives scoped tasks and sanitized context; it does not directly access OS secrets or arbitrary filesystem paths. Headless children run under Job Objects and, where supported and verified, a restricted token/Low Integrity/AppContainer. Job Objects alone are not a security sandbox.
- **MCP server and permission broker:** live in the privileged core host, not in the agent process. The agent receives only pre-authorized task payloads. Validate the pipe client PID and executable path at enrollment; use a discovery name to locate a randomized per-session pipe, and document named-object squatting as a residual local threat.

The exact number of processes is chosen during the host spike. Isolation must not be asserted merely because modules are in separate folders. Use process boundaries where they materially reduce impact and can be maintained.

## 4.2 Services

### Mandatory thread/process boundaries

- **STA UI thread:** owns the Windows message pump and every WebView2 COM object/controller call. No WebView2 controller call is made directly from a Tokio worker.
- **Tokio runtime:** handles named-pipe IPC, database commands, AI gateway requests, policy evaluation that does not touch COM, and agent adapters.
- **Bounded channels:** all requests crossing between the STA UI thread and Tokio services use bounded command/reply channels with explicit cancellation, timeout, and shutdown behavior. Queue saturation must be observable and must not freeze the UI.
- **SQLite writer actor:** receives typed persistence commands and owns the only normal write connection. `BackupService` coordinates online backups and migrations through this actor; no second service writes around it.
- **Agent child processes:** headless browser/Obscura candidates run under Windows Job Objects so child processes are terminated or supervised when the owning task/host exits.

```text
[STA UI thread + Win32 message pump + WebView2 controllers]
                     ⇅ bounded typed channels
[TOKIO runtime: IPC / policy / AI gateway / agent adapters]
                     ⇅ persistence commands
[SQLite single-writer actor] ⇄ [BackupService + integrity checks]
```

The exact crate boundary may change during the host spike, but the threading invariant may not. **Deadlock rule:** the STA side must never synchronously wait for a Tokio result if that result may require a callback on the STA thread. Replies are posted back to the message pump; no synchronous cross-boundary waits. Stress-test queue saturation and concurrent UI/agent requests.

### Supporting services

- `BackupService`: pre-migration snapshots, rotating local backups, integrity checks, restore workflow, and backup-age reporting.
- `UpdateService`: signed manifest verification, download staging, rollback, and runtime-version diagnostics.
- `WindowChromeService`: only if custom chrome is enabled; owns hit-testing, DPI-change coordination, snap/restore behavior, and its test suite.
- `FeatureFlagService`: local JSON/SQLite-backed flags loaded at startup. Consumer flags are local-only; remote policy overrides are reserved for managed enterprise builds.

- `WindowService`: create, close, focus and restore windows; own per-window tab collections.
- `TabService`: tab creation, selection, ordering, pinning, close and recovery.
- `NavigationService`: URL normalization, search routing, navigation events and errors.
- `ProfileService`: personal/work/private/agent profiles and data boundaries.
- `ActionRegistry`: schema validation, permissions, execution, cancellation and audit classification.
- `CapabilityMatrixService`: per-adapter/per-capability support and test results.
- `SessionBrokerService`: blocks by default; handles approved, safe, time-boxed origin-specific handoffs if implemented later.
- `PermissionBroker`: site permissions, agent tool permissions and approvals.
- `DownloadService`: progress, cancel, path validation and safe file handling.
- `HistoryService` / `BookmarkService`: CRUD, indexing, retention and deletion.
- `TaskMemoryService`: named tasks, workspaces, snapshots, notes and resume state.
- `ContentClassifierService`: sensitivity classification for stored artifacts and AI-bound content.
- `AIService`: provider routing, privacy tiers, structured-output validation, and hard per-task/daily spend ceilings enforced before provider dispatch; ceiling breach fails closed with a typed error unless the user explicitly overrides.
- `MCPService`: client enrollment, named-pipe transport, tool schemas and rate limits.
- `AuditService`: redacted, tamper-evident event records where practical.
- `PolicyService`: user settings and managed organization policies.

---

# 5. Frontend, UI/UX and Accessibility

## 5.1 Layout

Main window:
1. Native title bar and window controls.
2. Tab strip with new-tab control, pinning and overflow.
3. Navigation toolbar: Back, Forward, Reload/Stop, Omnibox, Bookmark, Privacy, Profile, AI, Menu.
4. Optional workspace strip.
5. Web page viewport.
6. Download/loading/automation status.
7. Optional AI panel.
8. Optional DevTools dock.

## 5.2 Omnibox routing

Classify input in this order:
1. Explicit command prefix or palette command.
2. Valid normalized URL or host-like input.
3. Configured search query.
4. Explicit AI prompt command or user-selected AI mode.

Do not silently send arbitrary omnibox text to an external model. Show when a prompt will send context to a cloud provider. Use established URL, IDNA and public-suffix libraries rather than hand-rolling URL parsing.

## 5.3 Command palette

- Fuzzy-search actions, tabs, bookmarks, history and recent tasks.
- Display keyboard shortcuts and permission requirements.
- Separate read-only, mutating and destructive commands.
- Use the same action IDs as toolbar buttons and MCP tools.
- Keep results virtualized for large lists.
- Avoid triggering actions merely because a search result is selected; require explicit execute input.

## 5.4 AI panel

- Context selection: current page, selected text, selected tabs, named workspace, or no page.
- Privacy indicator: local-only, redacted cloud, or user-approved full context.
- States: idle, reading, waiting for approval, executing, completed, failed, cancelled.
- Show sources and extracted passages.
- Provide stop/cancel and clear task controls.
- Use a structured result schema rather than rendering arbitrary model HTML.
- Sanitize Markdown/HTML output before display.
- Page content cannot grant permissions or invoke tools.

## 5.5 Design system

- CSS design tokens for colors, spacing, typography, radii, elevations and motion.
- Light, dark and system themes.
- High-contrast and reduced-motion support.
- System font stack by default; avoid shipping large webfonts in the chrome UI.
- Avoid expensive blur/acrylic effects until GPU profiling proves acceptable.
- Visible focus states and accessible labels for icon-only controls.
- Important security states must not be hover-only.

## 5.6 Accessibility and localization

- Target WCAG 2.2 AA for browser chrome as a product goal, validated by testing rather than self-declared.
- Full keyboard navigation and screen-reader status updates.
- Text scaling and reduced motion.
- Add localization infrastructure early; Fluent is a candidate pending integration/license review.
- Support Unicode, locale-aware dates, right-to-left layouts and time zones.
- English-only initial content may be acceptable, but string literals should not be scattered through components.

---

# 6. WebView2 Integration Compliance Checklist

The browser must explicitly handle and test the applicable events and user-facing flows. Exact APIs and event names must be checked against the pinned WebView2 SDK version.

| Area | Required behavior |
|---|---|
| New window / `_blank` | Decide open-in-new-tab vs new-window policy; preserve opener semantics where needed |
| Navigation | Validate scheme, update omnibox, update Back/Forward state, handle redirects |
| Page title / favicon | Update tab metadata and accessibility labels |
| Loading / failure | Loading indicator, stop control, retry, custom error interstitial |
| TLS/certificate failures | Clear, secure error page; no casual “bypass anyway” flow |
| JavaScript dialogs | Handle alert, confirm, prompt with correct origin attribution |
| Permissions | Explicit geolocation, camera, microphone, notifications and other permission UX |
| File chooser | Safe open/save dialog, path validation and cancellation |
| Downloads | Intercept start, choose path, show progress, cancel and report failures |
| Print / PDF | User-visible dialog, destination validation and test for large documents |
| Context menu | Useful browser actions, selection-aware behavior and origin context |
| Find in page | Correct matching, next/previous, match count, selection and cleanup |
| Zoom | Persist by site/profile if desired; test reset and accessibility |
| Keyboard | Browser shortcuts vs page shortcuts; focus handling and input controls |
| Drag/drop | URL/text/file handling with explicit path policy |
| Clipboard | Respect OS behavior; no silent clipboard reading |
| Media | Play/pause state and permission UX; document codec/DRM limitations |
| Crash | Detect renderer/process failure, offer reload and preserve safe tab metadata |
| Profiles | Correct cookies, permissions, cache and storage separation |
| Private windows | Separate context and defined cleanup semantics |
| DevTools | Controlled opening, correct target association and disabled remote exposure |
| Shutdown | Flush persistence safely and close controllers without corrupting state |
| Window chrome / Snap Layouts | MVP uses decorated native frame; if custom chrome is enabled, test hit-testing, drag/resize, Snap Layouts, shadow/corners and taskbar previews |
| DPI / monitor changes | Per-Monitor-V2 awareness; live `WM_DPICHANGED` keeps chrome and WebView2 bounds aligned on mixed-DPI displays |
| Fullscreen / PiP | Test F11, Escape, `ContainsFullScreenElement`, Picture-in-Picture entry/exit and tab suspension interaction |
| `beforeunload` | Test leave-site prompts separately from JavaScript dialogs |
| Spellcheck / IME | Spellcheck toggle and dictionary behavior; omnibox IME composition without losing or double-committing text |
| Media keys | Test hardware media keys and media-session behavior where supported |
| Autofill | Expose a setting to disable inherited WebView2 autofill/password suggestions; no custom password store in v1 |
| Download resume / MOTW | Test interrupted/resumed downloads where supported; apply Mark-of-the-Web using `IAttachmentExecute` through the `windows` crate, deriving the zone from the source URL; verify `Zone.Identifier`, SmartScreen, Protected View, and AppLocker/WDAC behavior in a disposable VM |
| WebAuthn / passkeys | Verify platform authenticator/Windows Hello, security keys, passkey creation/sign-in, conditional mediation and documented fallback |
| Popup policy | Block unsolicited popups by default; allow only attributable user gestures or explicit site policy; agent opens are visibly labelled |
| RDP / GPU fallback | Test RDP rendering, disabled hardware acceleration/software fallback, and hybrid-GPU switching |
| Virtual host mapping | Mapped folder contains public read-only assets only; verify custom scheme alternative before finalizing chrome origin |

Every row needs an automated test where feasible and a manual test case for behavior that cannot be reliably automated.

---

# 7. Backend, Storage and Data Lifecycle

- AI panel state transitions are announced through an ARIA live region (`polite` by default; assertive for failures only), so screen-reader users receive status updates without polling visually.

## 7.1 SQLite schema outline

| Table | Purpose |
|---|---|
| `profiles` | Profile metadata and policy linkage |
| `windows` | Window geometry, state and active tab |
| `tabs` | Tab URL/title, order, pinned state and last active time |
| `workspaces` | Named browsing/task spaces |
| `workspace_items` | Tab references, position and snapshot references |
| `bookmarks` | URL, title, folder, timestamps |
| `history_visits` | Visit metadata with profile and retention policy |
| `downloads` | Download state, URL and safe path metadata |
| `tasks` | Goal, status, next step, timestamps and workspace |
| `task_artifacts` | Artifact metadata, sensitivity, content reference and source |
| `workflows` | Workflow metadata, version and permission scope |
| `workflow_steps` | Action IDs, validated arguments and assertions |
| `action_runs` | Status, duration, result code and task reference |
| `site_permissions` | Profile, origin, permission and decision |
| `settings` | Versioned user and profile settings |
| `audit_events` | Actor, event type, result, timestamp, schema_version and keyed target identifier |

## 7.2 SQLite rules

- Enable WAL mode and use transactions.
- Use one Rust writer actor/task with a bounded command queue.
- Batch non-urgent history and audit writes.
- Never block the UI on database operations.
- Use prepared statements and parameterized queries.
- Use FTS5 for local full-text search where it fits.
- Define migrations and crash-recovery tests.
- Run FTS rebuild/reconciliation after detected inconsistency.
- Do not add a second database until a benchmark demonstrates a bottleneck.
- Use keyed HMAC for sensitive target identifiers in audit records; plain hashes of predictable URLs are not sufficient privacy protection.

## Database backup, integrity and restore

`BackupService` uses SQLite's online backup API (or a tested equivalent); copying a live database file while WAL is active is not the default. Before each schema migration, create and verify a consistent backup, retaining the latest three known-good migration snapshots subject to a documented disk cap. On startup, run `PRAGMA integrity_check` asynchronously after first paint. If corruption is detected, stop normal writes, preserve the damaged DB for diagnostics, and offer restoration from the newest verified backup with a clear warning about changes since that backup. Check free disk space before backups and downloads; warn before a write and refuse new backup work below a configurable floor rather than failing mid-write. Test corruption injection, disk-full behavior, interrupted migration, restore failure and backup deletion.

## 7.4 Content-addressed artifact store

For larger page snapshots, screenshots, exports and workflow evidence:
- Store content separately from relational metadata.
- Normalize only where safe and preserve the original capture metadata.
- Compress snapshots (for example, zstd) and deduplicate by content hash.
- Reference objects through stable IDs and integrity checks.
- Garbage-collect unreferenced objects according to retention rules.
- Tag every artifact with sensitivity, source, capture time, profile, task, retention and encryption state.
- Generate a random data-encryption key; protect it with Windows DPAPI and encrypt sensitive blobs with AES-256-GCM. Apply the key lifecycle and export rules in ADR-013.
- Do not assume an artifact is safe just because its audit event is redacted.

## 7.5 Data deletion and export

- “Forget this site” must preview exactly what will be deleted: history, bookmarks, permissions, cached artifacts and task references.
- Deletion must update database rows, search indexes and artifact references.
- Exports must disclose included data and exclude secrets by default.
- Private-mode audit records may retain necessary security events but must avoid history-linkable page identifiers and page content.
- Enterprise audit retention must be disclosed and governed by policy.
- A deleted item should not reappear from a stale search index or cache.

---

# 8. API, IPC and MCP

## 8.1 Contract design

Use schema-first IPC. Define request/result schemas once and generate or validate Rust and UI bindings in CI. Pin schema versions and run contract tests on every change.

Every action envelope includes:
- `version`
- `request_id`
- `action_id`
- `profile_id`
- `window_id` and/or `tab_id` where relevant
- `arguments`
- `caller` (UI, keyboard, palette, MCP, workflow)
- `task_id` if applicable
- cancellation/deadline metadata

Results include:
- `ok`
- typed `result`
- stable `error_code`
- safe user-facing message
- duration and trace reference where appropriate

### Action and workflow schema evolution

Every action registry entry carries a stable `action_id`, `schema_version`, risk class, argument schema and output schema. Persist the schema version with each saved workflow step. The registry must validate the exact historical schema or apply an explicit, tested migration. If no migration path exists, replay fails closed with `WORKFLOW_SCHEMA_STALE`; never guess or coerce ambiguous arguments. IPC envelopes, audit events and opt-in telemetry events carry independent schema versions, with compatibility tests in CI.

## 8.3 Action risk classes

- **R0 — Read-only local:** list tabs, search bookmarks. Navigation that changes the active page is R2 (reversible UI mutation), not R0.
- **R1 — Read-only page:** extract selected page text, summarize a page.
- **R2 — Reversible UI mutation:** open/close tab, add bookmark.
- **R3 — Page mutation:** click, fill, navigate through a workflow.
- **R4 — Consequential:** submit form, send message, change account, purchase, delete user data.

R3 requires explicit task scope and policy checks. R4 requires explicit user confirmation immediately before execution and must remain unavailable to unattended workflows in the first release.

## 8.4 Proposed action catalogue

| Action ID | Purpose | Risk |
|---|---|---|
| `browser.back` / `browser.forward` | Navigate history | R2 |
| `browser.reload` / `browser.stop` | Reload or stop | R2 |
| `window.create` / `window.close` | Window lifecycle | R2 |
| `tab.open` / `tab.close` / `tab.select` | Tab lifecycle | R2 |
| `tabs.search` | Search open tabs | R0 |
| `bookmark.add` / `bookmark.remove` | Bookmark management | R2 |
| `history.search` | Search allowed history | R1 |
| `history.clear` | Delete history | R4 |
| `downloads.list` / `downloads.cancel` | Download management | R1/R2 |
| `page.extract` | Extract selected content | R1 |
| `page.summarize` | Summarize under privacy policy | R1 + transfer policy |
| `page.find` | Search text in page | R0 |
| `page.capture` | Capture screenshot/snapshot | R1 |
| `page.click` / `page.fill` | Page interaction | R3 |
| `task.save` / `task.restore` | Task memory | R2 |
| `workflow.dry_run` | Validate workflow without mutation | R1 |
| `workflow.run` | Execute approved workflow | R3/R4 by step |
| `privacy.clear_site_data` | Clear origin data | R4 |
| `export.content` | Export selected content | R2 |

These are internal contracts, not claimed existing method names from WebView2 or Obscura.

## 8.5 MCP transport and tools

- Use Windows Named Pipes with ACLs restricting access to the current user.
- Require explicit client enrollment and per-client scopes.
- Revoke client permissions independently of browser profile permissions.
- Rate-limit each tool and cap concurrent operations.
- Keep read-only tools separate from mutating tools.
- Never expose an unauthenticated CDP endpoint.
- Do not forward arbitrary AI-generated shell commands.
- Show which client is requesting an action when identity information is available.

Initial MCP tools:
- `list_windows`
- `list_tabs`
- `search_tabs`
- `extract_page_content`
- `summarize_page`
- `find_text_on_page`
- `capture_page`
- `open_tab`
- `save_task_note`
- `export_selected_content`
- `workflow_dry_run`

Mutating workflow tools are gated until the security milestone passes.

---

# 9. AI, Agent Safety and Prompt Injection

## 9.1 Read-only first

The first AI release may:
- Summarize selected page content.
- Extract structured facts from a user-selected source.
- Answer questions with source links and quoted/located evidence.
- Search open tabs and saved task notes.
- Export a summary with provenance.

It may not autonomously submit forms, buy products, change account settings, delete data, send messages or execute arbitrary scripts.

## 9.2 Content handling pipeline

1. User chooses page/context scope.
2. Browser extracts structured DOM content and metadata using a reader pipeline where possible.
3. Content is treated as untrusted data and separated from system instructions.
4. Sensitive-data classifier identifies likely credentials, personal data and financial data.
5. Redaction policy is applied according to privacy tier.
6. AI gateway checks provider policy, budget, timeout and output schema.
7. Output is validated, sanitized and rendered through safe UI components.
8. Source references are attached to claims where available.
9. Stored artifacts use the same sensitivity and retention pipeline as audit metadata.
10. User can inspect and delete the task data.

## 9.3 Prompt-injection defense

No single prompt pattern, regex, or secondary classifier can guarantee prevention. Use defense in depth:
- Separate page data from instructions structurally.
- Do not let page content grant tool permissions.
- Do not auto-execute tool calls returned by a model.
- Use explicit allowlisted tools with narrow schemas.
- Keep secrets outside the AI process.
- Require user approval for page-mutating or consequential actions.
- Add an adversarial corpus of malicious pages, fake system markers, hidden text, misleading tool requests and redirect cases.
- Run this corpus in CI as a regression gate.
- Use heuristics/classifiers as warning signals, not as the security boundary. Classifier output is best-effort enrichment and never proves that content is safe or redacted.
- Record blocked attempts without storing unnecessary page text.
- Provide a global stop control and cancellation propagation.

## 9.4 Privacy tiers

- **Tier 0 — Local only:** no page content leaves the device; use deterministic extraction and optional local models.
- **Tier 1 — Redacted cloud:** selected content may be sent only after explicit user consent, regardless of classifier result; classifier output is best-effort and cannot authorize transfer.
- **Tier 2 — User-approved context:** broader content transfer requires explicit consent and provider disclosure.
- Managed organizations may disable tiers or restrict providers.
- Search suggestions are off by default; each provider requires explicit opt-in with a clear explanation of what typed terms may leave the device.
- Per-Origin AI Rules allow `Tier 0 only`, `never summarize`, or `ask every time`. Banking, identity and SSO origins default to Tier 0-only; high-risk agent actions may remain hard-blocked.
- Clearly show provider, context scope and expected cost where available.
- Enforce configurable per-task and daily hard spend ceilings before dispatching any provider call. On breach, fail closed with a typed error and require explicit user override; cost dashboards alone are insufficient.

## 9.5 Claims and uncertainty UI

For high-consequence features such as shopping comparisons, subscription reminders and truth checking:
- Show evidence/source, capture time, unknown fields and uncertainty.
- Use shared claim components with `Verified from source`, `Supported`, `Conflicting evidence`, `Unverified` or similar labels.
- Do not present an LLM-generated confidence score as a calibrated probability unless evaluated and calibrated.
- Require legal and product review before shipping features that could affect financial or consequential decisions.

---

# 10. Security and Privacy Requirements

## 10.1 Threat model

Threats include malicious web pages, renderer compromise, prompt injection, malicious local MCP clients, profile leakage, SSRF, DNS rebinding, secret leakage, unsafe workflow replay, malicious downloads, dependency compromise and unsafe updates.

## 10.2 Mandatory controls

- Strict CSP and a privileged chrome origin isolated from arbitrary web navigation.
- Typed IPC and least-privilege native APIs.
- URL parsing using established libraries; validate every redirect hop in agent fetches.
- Block loopback, private, link-local and cloud metadata targets for remote/agent fetches unless an explicitly approved use case requires them.
- Resolve and validate DNS/IP destinations at connection time to mitigate rebinding; enforce network policy at the actual connection boundary where feasible.
- Never treat page HTML as trusted instructions.
- Encrypt sensitive stored artifacts with platform-protected keys.
- Keep secrets out of logs and AI prompts unless specifically authorized.
- Restrict Named Pipe ACLs and MCP client capabilities.
- Separate browser profiles and private contexts.
- Require approval for high-impact actions.
- Sign releases and validate update signatures before installation.
- Maintain a dependency inventory, SBOM, vulnerability scanning and license policy.
- Crash reports are disabled by default or explicitly opt-in; prefer self-hosted or region-configurable Sentry, scrub URLs/tokens/user data before upload, and never include page content, cookies or form values by default.
- Provide a vulnerability reporting and response process.

## 10.3 Tracker blocking

Use an established filter engine/library only after verifying maintenance, API, license and filter-list licenses. Do not claim perfect blocking. Distinguish:
- Network request blocking.
- Cookie/storage isolation.
- Permission control.
- Fingerprinting resistance.

These are different protections and should be described accurately.

## 10.4 Private mode semantics

- Separate ephemeral context.
- No normal history/task memory by default.
- Security audit events may remain in a minimized, non-history-linkable form.
- Downloads and explicitly saved exports may persist; tell the user.
- Private mode does not hide browsing from websites, networks, employers, or ISPs.

## 10.5 Supply-chain and release security

- `cargo-audit`, `cargo-deny`, formatting/tests and license checks in CI.
- Generate an SBOM with a maintained tool.
- Pin dependencies and use locked builds.
- Sign release artifacts through protected CI signing infrastructure.
- Restrict signing permissions and log release approvals.
- Test signature verification, staged rollout and rollback.
- Evaluate SmartScreen/antivirus reputation before public launch.
- Do not claim a formal supply-chain assurance level unless the corresponding controls and evidence exist.

---

# 11. Performance and Resource Strategy

## 11.1 Performance principles

- The UI bundle is not the same as total browser memory.
- Web content, WebView2 child processes, active tabs, GPU surfaces, agent contexts, downloads and local models dominate resource usage.
- Do not create a separate user-data folder for every tab without a measured reason.
- Reuse environments and use profiles under a shared user-data folder where supported.
- Bound agent concurrency and queue overflow work.
- Lazy-load AI, history, downloads and settings panels.
- Batch IPC events and avoid high-frequency polling.
- Transfer screenshots and snapshots as binary/file-backed payloads, not large base64 JSON messages.
- Avoid unnecessary blur, large shadows and long animations.
- Use virtualization for long lists.
- Cache extraction by content freshness/hash, not URL alone.
- Use token budgets and show cloud-AI cost where the provider exposes it.

## 11.2 Tab lifecycle policy

Do not assume every hidden tab can be suspended safely.

Initial policy:
- Never automatically discard a tab with active audio/video, active download, active agent task, explicit keep-awake setting, or known unsaved form state.
- Treat dirty-form detection as heuristic, not perfect.
- Preserve URL, title, scroll position when available, and safe snapshot metadata.
- Show a suspended/discarded indicator and restore on activation.
- Provide per-site and global controls.
- Never claim that suspension preserves every page's JavaScript state.
- Use WebView2-supported suspension APIs only after validating the exact runtime behavior.

## 11.3 Agent resource governor

- Start with a maximum of 1–2 concurrent agent contexts for desktop MVP.
- Make the limit configurable only after memory testing.
- Queue extra tasks and expose queue state.
- Enforce per-task deadlines, cancellation and bounded retries.
- Recycle failed or stale contexts.
- Keep agent runtime off by default until a task needs it.
- Do not run a local LLM in the background by default.

## 11.4 Numeric benchmark plan

Set baseline hardware and OS during Phase 0. Initial goals are hypotheses:
- Local chrome action latency: p95 below 100 ms on reference hardware, excluding website/network delay.
- Cold launch: measure first; target under 2 seconds for chrome shell on reference hardware if achievable.
- No sustained high CPU while idle after startup settles.
- No unbounded growth in memory during a 24-hour soak test.
- Tab-switch latency measured at 1, 10, 25 and 50 tabs.
- Measure separate deltas for app process, WebView2 process group, agent contexts and local AI.
- Do not publish a “lighter than Chrome” claim until an equivalent workload comparison supports it.

## 11.5 Benchmark scenarios

- Empty launch and warm restart.
- 1/10/25/50 real pages.
- 500 placeholder tab records for UI registry and IPC stress only.
- Several agent contexts with bounded concurrency.
- Large documentation pages, SPAs, infinite scroll and iframe pages.
- Downloads in progress.
- Long history and bookmark databases.
- AI summary/extraction.
- Idle for 10 minutes.
- 24-hour soak test and crash recovery.
- Memory pressure, rapid tab creation/closure, and multiple windows.

Report p50/p95 latency, steady-state and peak memory, CPU, failure rate, crash rate, and power impact where measurable.

---

# 12. Developer Setup and Repository Structure

## 12.1 Prerequisites

- Supported Windows 11 (primary supported target); Windows 10 only if separately validated and explicitly supported.
- Git and a pinned Rust toolchain.
- WebView2 SDK/runtime for the selected host.
- Node.js only for UI tooling/tests if needed; no frontend framework is required by the architecture.
- A pinned Obscura build for the feasibility spike.
- Optional AI credentials supplied through secure local configuration, never committed.
- CI with tests, dependency scanning and artifact signing access.

## 12.2 Proposed repository layout

```text
obscura-ai-browser/
├── app/
│   ├── chrome-ui/
│   │   ├── index.html
│   │   ├── styles/
│   │   │   ├── tokens.css
│   │   │   ├── layout.css
│   │   │   ├── components.css
│   │   │   └── themes.css
│   │   └── src/
│   │       ├── main.js
│   │       ├── state/
│   │       ├── components/
│   │       ├── commands/
│   │       ├── services/
│   │       └── accessibility/
│   ├── native-host/
│   │   ├── src/
│   │   │   ├── main.rs
│   │   │   ├── windows/
│   │   │   ├── webview/
│   │   │   ├── ipc/
│   │   │   ├── actions/
│   │   │   ├── storage/
│   │   │   ├── security/
│   │   │   └── policy/
│   │   └── Cargo.toml
│   ├── agent-runtime/
│   │   ├── adapter/
│   │   ├── capability_matrix/
│   │   ├── ai_gateway/
│   │   └── mcp/
├── schemas/
├── migrations/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── browser-compat/
│   ├── security/
│   ├── adversarial/
│   └── performance/
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   ├── capability-matrix.md
│   ├── compatibility-matrix.md
│   ├── data-retention.md
│   └── decisions/
├── scripts/
├── Cargo.toml
├── README.md
└── LICENSES.md
```

## 12.3 Setup order

1. Create repository and architecture decision records.
2. Pin SDK/runtime versions and license inventory.
3. Build a minimal native window with local chrome UI.
4. Implement safe UI-to-host IPC and generated contracts.
5. Create two windows and multiple WebView2 controllers.
6. Implement navigation and all required event handlers.
7. Add tab/profile/window lifecycle and crash recovery.
8. Add SQLite WAL, migrations and single writer.
9. Add command palette and shared action registry.
10. Add the rendering adapter spike in an isolated process.
11. Add read-only AI gateway and MCP read-only tools.
12. Add the three v1 differentiators.
13. Add signing, update, compatibility, performance and security gates.

---

# 13. Test Strategy and Acceptance Criteria

## 13.1 Unit tests
- URL classification and normalization.
- Action schema validation and permission decisions.
- SQLite migrations and deletion cascades.
- Profile/window/tab state transitions.
- Artifact sensitivity classification and retention.
- Command palette ranking.
- Error-code mapping and cancellation.

## 13.2 Integration tests
- Multiple windows and tabs.
- Popup/new-window handling.
- JS dialogs, file chooser, downloads, print and permissions.
- Profile separation and private-mode cleanup.
- Renderer crash and recovery.
- Task save/restore.
- Named Pipe authentication/enrollment and revocation.
- MCP read-only tools and denial of unauthorized tools.
- Obscura/headless adapter capability tests.

## 13.3 Browser compatibility suite
Include representative fixtures for:
- Static HTML.
- JavaScript-heavy SPA.
- Cross-origin iframe.
- Shadow DOM.
- Infinite scrolling.
- File upload/download.
- JS dialog.
- New window and redirects.
- Authentication flow in a test environment.
- Canvas/WebGL page.
- Media playback where supported.
- Certificate/network failure.
- Large document and print.

Do not use real credentials in automated tests. A capability matrix should record pass/partial/fail by runtime, browser version and fixture.

## 13.4 Security tests
- Prompt injection and hidden text.
- Page text attempting to invoke tools.
- Malicious redirects and private IP/metadata targets.
- DNS rebinding scenarios where testable.
- Cross-profile cookie/storage leakage.
- MCP unauthorized client and privilege escalation.
- Sensitive artifact/log inspection.
- Malformed IPC and oversized payloads.
- Unsafe download paths.
- Update signature failure and rollback.
- Data deletion across tables, indexes and artifact store.

## 13.5 Release acceptance
- All P0 browser controls work.
- Multiple windows and tab restore work after restart.
- WebView2 event-handler compliance checklist passes.
- No known critical/high security issue remains unresolved.
- No unauthenticated MCP/CDP network listener exists by default.
- Performance baseline and 24-hour soak report exist.
- All AI features expose context and privacy state.
- v1 differentiators pass failure and deletion tests.
- Update and rollback path is tested.
- User-facing limitations and privacy disclosures are published.

---

# 14. Revised Phase-Wise Roadmap

The estimates below assume a small experienced team. A solo developer should expect a longer schedule. These are planning ranges, not promises. Feature acceptance gates take precedence over dates.

## Phase 0 — Feasibility and architecture (3–5 weeks)

**Work**
- Confirm exact Obscura repository, license, version, API surface and maintenance status.
- Verify WebView2 standalone-browser embedding/EULA terms and record the result in `DEPENDENCIES.md`.
- Pin the minimum WebView2 SDK/runtime version needed for multi-profile support; implement a startup capability check.
- Prototype STA/Tokio channel saturation and no-sync-wait behavior.
- Evaluate reduced-integrity/AppContainer support for the selected agent runtime.
- Verify WebAuthn/passkeys, RDP/software rendering, hybrid-GPU behavior and current WebView2 policy interactions.
- Build three-way rendering/automation spike: WebView2 agent context, Obscura, headless Chromium/CDP.
- Compare direct WebView2 host and Tauri 2 for multiple windows/controllers, profiles, events, packaging and UI integration.
- Test session isolation and define the non-sharing default.
- Build representative browser compatibility fixtures.
- Measure startup, memory, latency, and test failure rate.
- Create ADRs, threat model, capability matrix and `DEPENDENCIES.md`.
- Start code-signing certificate procurement early; record expected lead time and protected signing design.

**Exit gate**
- Chosen host passes multi-window/tab prototype.
- Chosen agent runtime supports required MVP tasks with acceptable reliability.
- License, EULA and maintenance risks are documented.
- Host selection records the total long-term maintenance surface, not only prototype glue time.
- Weighted engine scoring is completed only after mandatory session/security tests pass.
- Team can explain session semantics clearly.
- No major architecture decision remains implicit.

**Stop/go:** If no agent runtime provides enough value for the initial release, ship the browser shell first and postpone agent automation.

## Phase 1 — Reliable browser shell (6–10 weeks)

**Work**
- Windows and tabs.
- Back/Forward/Reload/Stop and omnibox.
- New tab, close tab, tab search, bookmarks and history.
- Downloads, settings, keyboard routing and command palette.
- Navigation/title/favicon/loading/error state.
- Popups, dialogs, file chooser, print, context menu, permissions and crash recovery.
- SQLite WAL, migrations, single writer and safe persistence.
- Initial performance baseline and daily internal dogfooding.
- `BackupService`, migration snapshots, integrity check, disk-space handling and corruption recovery pass.
- Single-instance URL handoff, STA/Tokio stress test, mixed-DPI, WebAuthn and MOTW download-security tests pass.

**Exit gate**
- Core browsing works on representative websites.
- Multi-window state survives restart.
- No critical event-handler checklist gaps.
- Basic performance and stability targets are measured.

## Phase 2 — Profiles, privacy and security foundation (4–7 weeks)

**Work**
- Personal/work/private contexts.
- Site permission UI and data clearing.
- Typed IPC, schema generation and action risk classes.
- Named Pipe service and client enrollment foundation.
- Content classification and secure artifact storage.
- Dependency/license scanning and signed test builds.
- Per-user installation and default-browser/protocol registration are tested.
- Key rotation, profile deletion, portable export/import and DPAPI failure behavior are tested.
- Private-mode and retention semantics.

**Exit gate**
- Profile isolation tests pass.
- Sensitive data is not present in normal logs.
- Local client authorization and revocation tests pass.
- Private-mode behavior is documented and verified.

## Phase 3A — Read-only AI foundation (4–6 weeks)

**Work**
- AI gateway and provider abstraction.
- Page context selection and content extraction.
- Summary and structured extraction.
- Source links, privacy tiers, hard pre-call spend ceilings and error states.
- Safe rendering and output schema validation.
- MCP read-only tools.
- Adversarial prompt-injection regression suite.

**Exit gate**
- AI never receives context outside the selected scope.
- No page content can invoke a tool without policy authorization.
- Privacy and provider disclosure are clear.
- Failure and cancellation are handled safely.

## Phase 3B — Mutating automation safety (6–10 weeks, only if justified)

**Work**
- Capability matrix and safe action executor.
- Dry-run and visual action preview.
- Approval UX, global stop, trace logs and cancellation.
- Limited page click/fill workflows in a test environment.
- Human approval before any consequential action.
- Security red-team and workflow failure tests.

**Exit gate**
- Unauthorized mutations are blocked.
- Stale page state pauses execution.
- All actions are auditable and cancellable.
- Do not ship if tests reveal unreliable or misleading behavior.

## Phase 4 — v1 differentiators (6–10 weeks)

Ship only:
1. Task Memory.
2. Tab Overload Autopilot.
3. Universal Web Portability.

**Work**
- Task snapshots, safe restore and deletion.
- Duplicate tab detection and recoverable archive.
- Markdown/text/PDF/JSON exports where supported.
- Search indexing and artifact retention.
- User studies to validate time saved and task-resume success.

**Exit gate**
- Each feature has explicit success metrics.
- Task deletion clears linked content and indexes.
- No feature silently closes tabs or replays actions.

## Phase 5 — Hardening and public beta (4–8 weeks)

**Work**
- 24-hour soak and memory regression testing.
- Accessibility and localization pass.
- Signed installer, update verification, rollback and recovery.
- License and SBOM review.
- Compatibility documentation and support workflow.
- Crash reporting with explicit consent and redaction.
- Public beta feedback and bug triage.

**Exit gate**
- No unresolved critical/high issues.
- Release and rollback are reproducible.
- Compatibility limitations are visible.
- Support and security response processes are in place.

## Phase 6 — Enterprise readiness (separate 8–16+ week track)

**Work**
- Managed policy configuration and startup detection of applicable WebView2/Edge Group Policy overrides; surface conflicts with the product's PolicyService rather than silently implying product settings won.
- OIDC/SSO integration if required.
- Organization-approved AI providers and data retention.
- Audit export, admin controls, deployment tooling and policy conflict handling.
- Security review and any compliance work required by target customers.
- Detect applicable WebView2/Edge Group Policy conflicts with product policy and explain them to the admin/user.
- Document AppLocker/WDAC interactions with Mark-of-the-Web and managed downloads.

**Exit gate**
- Enterprise requirements are defined by real pilot customers.
- Identity, policy and audit behavior is tested end to end.
- Legal/security review is complete for the target deployment.

## Phase 7 — Later feature tracks

Each requires separate discovery and acceptance:
- Shopping Agent.
- Truth Checker.
- Privacy Leak Radar.
- Subscription Guardian.
- Form Rescue.
- Workflow marketplace.
- Cross-platform host.
- Local LLM and semantic memory.
- LAN handoff and page diff watcher.

---

# 15. Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Obscura's capabilities/API change or are insufficient | Critical | Pin exact version; adapter boundary; go/no-go spike |
| Tauri cannot meet multi-controller needs efficiently | High | Host spike before committing; direct WebView2 provisional default |
| Session sharing causes account/security issues | Critical | Isolated default; safe-origin allowlist; explicit approval and TTL |
| WebView2 behavior differs from a full browser | High | Event-handler checklist, capability docs, compatibility suite |
| Prompt injection leads to unsafe actions | Critical | Read-only first, allowlisted tools, approvals, adversarial CI |
| UI state diverges from host state | High | Rust source of truth, generated contracts, coalesced events |
| SQLite locks under concurrent writes | Medium | WAL, single writer actor, bounded queues, benchmark |
| Sensitive page content remains in artifacts | Critical | Unified classification, encryption, retention and deletion pipeline |
| Too many features delay launch | Critical | Three differentiators in v1; separate future tracks |
| False truth/shopping/subscription claims | High | Evidence UI, uncertainty, evaluation and legal review |
| High memory from multiple runtimes/contexts | High | Bounded pool, reuse environments, benchmark and governor |
| Extension expectations are unmet | High | Explicit non-goal and user-facing compatibility statement |
| Update or signing compromise | Critical | Protected signing service, provenance, verification, rollback |
| Antivirus false positives | Medium | Early signed builds and pre-release reputation testing |
| Internationalization retrofit becomes expensive | Medium | Add localization framework and string extraction early |
| User approval fatigue | High | Risk tiers, narrow scopes, batch read-only approvals; never blanket approval for high-impact actions |
| Legal/license issues in filters/models/libraries | High | License inventory and legal review before shipping |
| Download security attribution/MOTW is missing | Critical | Use Windows attachment-execution APIs; verify Zone.Identifier, SmartScreen and AppLocker/WDAC behavior in disposable VM |
| DPAPI key lifecycle breaks export/recovery | High | Key ring, rotation, per-profile deletion, passphrase-based portable export, DPAPI failure tests |
| STA/Tokio cross-boundary deadlock | Critical | No synchronous cross-boundary waits; bounded channels, posted replies, stress test |
| Agent renderer compromise reaches user data | Critical | Job Objects plus verified restricted token/AppContainer where supported; score support as a security gate |
| WebView2 runtime/profile API mismatch | High | Pin SDK/runtime floor and fail closed if required multi-profile capability is unavailable |
| WebView2/Edge Group Policy conflicts | Medium | Detect applicable managed policies and surface conflicts in enterprise builds |
| Updater cannot swap locked binaries safely | High | Versioned staging, pending swap, last-known-good rollback and interrupted-update tests |
| Named-object squatting intercepts handoff | Medium | Validate client PID/path, randomized session pipe, untrusted handoff validation and documented residual risk |
| Excess feature growth delays v1 | Critical | Freeze scope through v1.1; feature bank stays separate until dogfood evidence justifies re-ranking |

---

# 16. Metrics and Product Success

Track the following from the MVP onward.

| Metric | Method |
|---|---|
| Core UI latency | p50/p95 action latency on reference hardware |
| Startup | Cold/warm launch under controlled conditions |
| Memory | App, WebView2 process group, agent runtime and local AI measured separately |
| Stability | Crash-free sessions and recovery success |
| Browser compatibility | Pass rate by fixture/runtime version |
| Task resume success | Percentage resumed without manual reconstruction |
| Tab retrieval time | Time to find a known tab with 10/25/50 tabs |
| Automation reliability | Success rate by action and failure category |
| Unsafe action rate | Unintended or unauthorized actions; target zero known unauthorized high-impact actions |
| Prompt-injection resistance | Regression suite pass rate |
| AI cost | Cost per task/active user; hard daily/task ceiling breach count; cache hit rate |
| Source traceability | Share of generated factual claims linked to sources |
| Privacy | Unauthorized transfer incidents and policy blocks; classifier miss rate from sampled manual review |
| Approval fatigue | Approval frequency and user override patterns, interpreted carefully |
| Maintenance | Dependency age, vulnerabilities, release regression rate |

Do not use “approval time decreased” as a standalone success measure; it can indicate users are rubber-stamping. Pair it with error reports and comprehension checks.

---

# 17. Maintenance and Operations

- Pin and regularly update dependencies.
- Maintain software bill of materials and license inventory.
- Track WebView2 runtime, Obscura, CDP client and MCP protocol compatibility.
- Keep CI gates for formatting, tests, dependency vulnerabilities, license policy and schema drift.
- Use signed releases, staged rollout and tested rollback.
- Maintain database migrations and artifact garbage-collection tests.
- Publish supported Windows versions and known limitations.
- Keep opt-in telemetry minimized; never collect page contents by default.
- Scrub crash dumps and diagnostics before upload.
- Maintain a security disclosure process and response SLA.
- Use weekly internal dogfooding builds starting in Phase 1.
- Track crash regressions, compatibility failures and performance changes for every release.
- Re-evaluate whether optional AI and automation modules still justify their resource and maintenance cost.

---

# 18. Future Scope

**Feature freeze:** no new feature candidates enter v1.0 or v1.1. The two supplied F10–F18 documents contain different candidate portfolios; keep both as research inputs outside this PRD, do not merge conflicting definitions or treat any candidate as committed scope. Re-rank only after dogfooding. No feature is added merely because it is easy to describe.

1. Local semantic search using a small embedding model and local vector index.
2. Optional local LLM for selected tasks, with model size and memory clearly disclosed.
3. Cross-platform host after Windows reliability is established.
4. Enterprise-managed policy and approved AI gateway.
5. Team workspaces with permission-aware sync.
6. Workflow recording/replay and time-travel debugging.
7. Page diff monitoring for authorized sources.
8. Offline documentation and reader archive.
9. Evidence manifests and optional trusted timestamps.
10. More language support and offline translation after license review.
11. Extension ecosystem only if there is a defensible compatibility and security model.
12. Advanced privacy controls and reviewed tracker filter updates.

---

# 19. Immediate 30-Day Action Plan

This is a decision-first plan, not a promise to complete a full browser in 30 days.

## Week 1 — Architecture proof
- Pin the exact Obscura repository and revision.
- Create the WebView2 and Tauri host prototypes.
- Implement two windows and multiple tabs.
- Test title/favicon, popup, download, permissions and DevTools behavior.
- Write ADR-001 and ADR-002 with results.

## Week 2 — Runtime and session proof
- Run WebView2 agent-context, Obscura and headless Chromium comparisons.
- Test static pages, SPA, iframe, shadow DOM, file interactions and login test fixtures.
- Compare resource usage and task correctness.
- Document session boundaries and supported/unsupported capabilities.
- Make the engine go/no-go decision.

## Week 3 — Core shell foundation
- Implement host event loop, navigation and tab lifecycle.
- Add typed IPC and action registry.
- Add SQLite WAL and the single writer.
- Implement command palette and keyboard routing.
- Add the WebView2 event compliance test matrix.

## Week 4 — Stability gate
- Implement bookmarks/history and crash restore.
- Run compatibility and performance baselines.
- Add CI dependency/license checks and schema contract tests.
- Publish an architecture decision log and a prioritized backlog.
- Decide whether AI integration begins next or core browsing needs more time.

At day 30, success means **the engine and host choices are evidence-based and the core shell architecture is proven**, not that all planned features are finished.

---

# 20. Final Implementation Order

1. Validate the desktop host and rendering runtime.
2. Define window/tab/profile/session contracts.
3. Build reliable conventional browsing and event handling.
4. Add persistence, recovery, permissions and privacy controls.
5. Implement the shared action registry and command palette.
6. Add read-only AI and MCP tools.
7. Add Task Memory, Tab Autopilot and Web Portability.
8. Add safe mutating automation only after a dedicated security gate.
9. Add enterprise controls based on real customer requirements.
10. Expand the feature portfolio only when performance, reliability and user value justify it.

**Final recommendation:** keep the ambition, reduce the number of simultaneous moving parts, and make the first milestone prove the architecture rather than showcase AI features. The strongest product is not the browser with the most agents; it is the browser that reliably preserves context, makes information easy to recover, and lets users delegate work without losing control.

---

# Appendix A — External technical references to verify during implementation

These links are starting points, not substitutes for checking the exact SDK/runtime version pinned by the project.

- Microsoft WebView2 user-data folder and sharing behavior: https://learn.microsoft.com/microsoft-edge/webview2/concepts/user-data-folder
- Microsoft WebView2 multiple profiles: https://learn.microsoft.com/microsoft-edge/webview2/concepts/multi-profile-support
- WebView2 Win32 reference: https://learn.microsoft.com/microsoft-edge/webview2/
- Obscura upstream project (confirm exact repository, license, release and current API before use): https://github.com/h4ckf0r0day/obscura
- Tauri 2 documentation: https://v2.tauri.app/
- RustSec advisory database: https://rustsec.org/
- SQLite WAL documentation: https://sqlite.org/wal.html
- SQLite FTS5 documentation: https://sqlite.org/fts5.html
- Model Context Protocol documentation: https://modelcontextprotocol.io/

---

# Appendix B — Definition of Done for v1.0

The v1.0 browser is ready only when:
- Ordinary browsing works on the declared supported Windows environment.
- Multi-window and tab lifecycle is stable.
- Core controls, omnibox, command palette, bookmarks, history and downloads work.
- WebView2 event handling is complete for the supported feature set.
- Profiles and private mode have tested, documented semantics.
- Local storage and artifact deletion are consistent.
- Read-only AI features show selected context, provider and source provenance.
- MCP is restricted to enrolled clients and approved tools.
- Task Memory, Tab Autopilot and Web Portability pass acceptance tests.
- No known critical/high security findings remain open.
- Performance, compatibility and soak-test reports are available.
- Installer signing, update verification and rollback are tested.
- Privacy disclosures, known limitations and support/security reporting paths are published.

## Appendix C — Crash-Domain Acceptance Matrix

| Crash domain | Expected user experience | Recovery action | Owning test |
|---|---|---|---|
| Chrome controller | Chrome may briefly reload; core host and persisted state survive | Watchdog restarts chrome controller if safe | Kill chrome controller during navigation and during save |
| Content renderer | Tab reports failure; other tabs remain usable | Offer reload; preserve safe title/URL metadata | Crash renderer in one tab while another remains active |
| GPU process | Rendering may degrade or restart | Runtime recovery/software fallback; show actionable diagnostic if persistent | Force GPU crash and disable hardware acceleration |
| Agent child | Agent task fails with typed result; normal browsing remains usable | Capture scrubbed diagnostics/minidump where feasible; terminate via Job Object | Kill agent child mid-task |
| SQLite writer | Mutations may queue/fail visibly; no silent success | Restart/reopen writer, integrity check, recover from backup if needed | Kill writer during transaction and simulate disk-full |
| Whole host | Browser restarts to safe state | Restore lazy tab placeholders; avoid automatically re-running workflows | Terminate host during persistence and update |
| Updater | Previous version remains launchable | Resume or roll back staged update | Interrupt swap at each update phase |

## Appendix D — Startup Phase Budgets

Measure on named reference hardware using ETW/WPR phase markers. Budgets are initial targets to validate in Phase 0, not promises:

| Phase | Initial target | Notes |
|---|---:|---|
| Process start to native window | ≤ 500 ms p95 | Separate OS cold-start effects |
| Native window to interactive chrome | ≤ 1.5 s p95 | Chrome assets local; no AI/MCP initialization |
| First content controller ready | ≤ 2.5 s p95 | Runtime state and cache must be recorded |
| Restored window with lazy tab placeholders | ≤ 2.0 s p95 after chrome ready | Do not navigate all tabs eagerly |
| AI panel first-open | ≤ 300 ms p95 to responsive UI | Provider/model boot can continue asynchronously |
| Background service initialization | After first paint unless required | MCP, indexing, update checks and AI gateway are lazy |

These targets must be reported as measured p50/p95 with runtime version, Windows build, hardware, display scaling and warm/cold conditions; revise only through a documented ADR backed by measurements.

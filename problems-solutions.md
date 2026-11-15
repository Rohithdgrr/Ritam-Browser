# Problems and Solutions

> Known constraints and implementation approaches in Ritam Browser.

---

## 1. Architecture & Platform

### 1.1 Multi-Tab Window Management

| Problem | Solution | Limitation |
|---------|----------|------------|
| Separate native window per tab breaks browser-like behavior | Use one Tauri window with child webview per tab via `TabWebviewManager` | Tauri's multi-webview API requires `unstable` feature |

### 1.2 Security Boundaries

| Problem | Solution | Limitation |
|---------|----------|------------|
| Remote pages must not access app commands | Keep shell trusted; grant capabilities to local origins only; run remote pages in child webviews | Continue treating all remote content as untrusted |

### 1.3 Keyboard Focus

| Problem | Solution | Limitation |
|---------|----------|------------|
| Web content takes keyboard focus, shadowing browser shortcuts | Register shortcuts while window is focused; use page-side activation where web gesture required | Some shortcuts constrained by system webview |

### 1.4 DOM Overlay on Native Webviews

| Problem | Solution | Limitation |
|---------|----------|------------|
| HTML dropdown cannot cover native page webview | Use OS-native popup menu in desktop mode; keep HTML overlay for preview | Native menu styling OS-controlled; requires app rebuild for visual changes |

### 1.5 WebView2 Threading

| Problem | Solution | Limitation |
|---------|----------|------------|
| Creating WebView2 controller on UI thread can deadlock | Make tab navigation async; perform creation through Tauri's async runtime | Platform-specific behavior needs native testing |

### 1.6 Document Generation Engine

| Problem | Solution | Limitation |
|---------|----------|------------|
| WorkAny is a full Tauri app, not an npm library, and its API is unauthenticated on all interfaces | Supervise it as an optional loopback sidecar only after upstream adds loopback binding, bearer auth, CORS removal and path containment; otherwise report generation unavailable | No engine is bundled yet; scaffold is shipped and disabled |
| Generated files must not escape the app data directory | Stage per job, select only allowlisted extensions, reject symlinks/escapes, cap at 64 MB and promote with an atomic rename | Website serving still needs a scoped origin |

---

## 2. Privacy & Data

### 2.1 Tab Isolation

| Problem | Solution | Limitation |
|---------|----------|------------|
| Regular tabs share cookies and identity | Use WebView2 InPrivate storage for private tabs; keep them out of persistent records | Per-tab or profile isolation for regular tabs unavailable |

### 2.2 Certificate Validation

| Problem | Solution | Limitation |
|---------|----------|------------|
| Secure URL does not prove certificate validity | Label security state as derived from URL scheme only | Issuer, certificate chain, TLS details not inspected |

### 2.3 Per-Profile Data

| Problem | Solution | Limitation |
|---------|----------|------------|
| Bookmarks, history and settings were global while profiles pretended to be separate | Migrate to `PRAGMA user_version = 2`: `profile_id` on every table, active profile in `shell_state`, `.bak-0002` copy kept | Existing rows all become the active profile's; there is no undo beyond the backup copy |
| Profiles shared one cookie/site-data jar | Give tab webviews a per-profile `data_directory` under `profiles/{id}/webview` | macOS WebView2 equivalent needs a data-store identifier and is not wired |
| Deleting a profile could leave orphan rows | Delete refuses the active profile and removes every scoped row plus the folder in one transaction | Unreferenced engine folders from failed deletes are not swept |

### 2.4 Auto-fill Trust Boundary

| Problem | Solution | Limitation |
|---------|----------|------------|
| A page could call an app command to read saved data | No page→Rust command is exposed; the shell pushes data on Ctrl+Shift+L only | A page cannot trigger auto-fill itself |
| Values could be filled on the wrong site | Rust reads the tab's real URL, tags the payload with its origin, and the injected script rejects any other origin and clears itself after one fill | The check is against the tab URL, not the form's `action`; cross-origin form posts are the site's business |
| Saved data is not encrypted | `autofill.json` is 0600 on Unix and the UI says it is unencrypted | Full-disk encryption is the user's job; password storage was skipped rather than half-built |

### 2.5 Importing From Another Browser

| Problem | Solution | Limitation |
|---------|----------|------------|
| Other browsers hold `History` / `places.sqlite` open (WAL locks) | Copy the file and its `-wal` / `-shm` companions to a temp dir, open read-only, delete the copy | Very large profiles take a moment to copy |
| Arbitrary paths could exfiltrate or clobber files | Only paths returned by `detect_installed_browsers` are accepted; writes go to the active profile only | A profile created after detection needs a re-scan |
| Passwords cannot be read (DPAPI / Keychain / NSS) | Report passwords as skipped with the reason in the UI and in the report | Password import would require reimplementing each OS crypto store |
| A source can be partly malformed | Each category reports imported/skipped counts and warnings instead of failing the whole import | No per-item log of skipped URLs |
| Bookmark folders were flattened by import | Chromium and Safari parsers carry the folder path; Ritam stores it on the bookmark row and includes it in search and export | Netscape HTML and Firefox imports arrive unfiled |

---

## 3. Engine Limitations

### 3.1 Chromium Tooling

| Problem | Solution | Limitation |
|---------|----------|------------|
| System WebView does not expose full Chromium tooling | Provide a page-level inspector (`govind://inspector`): fetch/XHR capture, console, errors, DOM snapshots, explicit native replay and page-side mock rules | No CDP or browser-level interception; forbidden headers, pre-start requests and non-JavaScript loads are invisible, and Linux has no capture channel |

### 3.2 Developer Workbench

| Problem | Solution | Limitation |
|---------|----------|------------|
| A page could feed fake data into the inspector | Capture is off until the user starts it; the page can report values but never invoke a command; every field is bounded and non-http(s) URLs are dropped | A malicious page can still emit misleading values while capture is on — treat the report as untrusted input |
| Capturing everything would fill memory or disk | Bounded in-memory buffers (500 requests, 300 console, 100 errors, 64 KB bodies, 200 KB DOM), cleared when capture starts and never persisted | Older entries are dropped once a buffer is full |
| Replay could be abused to reach internal services | Replay is explicit, http(s)-only, runs from the app process with a timeout and size cap, and does not inherit page cookies | It is still a native request made on the user's behalf; it is not a sandbox |
| Mocking responses without an interception engine | Patch fetch/XHR page-side with per-tab URL-substring rules and a visible active-state counter | Only JavaScript-initiated requests in the target tab, and only while capture is on |

### 3.3 Translation Service

| Problem | Solution | Limitation |
|---------|----------|------------|
| Translation requires sending page text to external service | Make endpoint configurable; send extracted text only after explicit user action; require HTTPS | Endpoint receives translated text; authentication not supported |

### 3.4 Content Rendering

| Problem | Solution | Limitation |
|---------|----------|------------|
| Forced dark mode may render sites incorrectly | Use lightweight CSS-based darkening | Rendering quality varies by site |
| Reader mode may not work on all sites | Extract from common article/main elements | Extraction quality varies by site structure |

---

## 4. Development & Testing

### 4.1 Preview Limitations

| Problem | Solution | Limitation |
|---------|----------|------------|
| Preview cannot reproduce native WebView behavior | Provide localStorage-backed fallback for UI development | Cannot display sites blocking iframes; cannot validate native behavior |

---

## 5. Summary Table

| Category | Issue Count | Primary Solution |
|----------|-------------|------------------|
| Architecture | 6 | Child webviews, async operations, native menus, gated generation sidecar |
| Privacy/Data | 6 | InPrivate storage, URL-scheme labels, profile-scoped schema, origin-gated auto-fill, read-only imports |
| Engine | 4 | Observable state, page-level inspector, configurable services, CSS fallbacks |
| Development | 1 | localStorage fallback |

---

## Related Documentation

| Document | Description |
|----------|-------------|
| [Engine Strategy ADR](docs/ADR-006-engine-strategy.md) | Engine architecture decision |
| [Embedded WebViews ADR](docs/ADR-007-embedded-webviews.md) | WebView integration design |
| [Engine Spike](docs/ENGINE_SPIKE.md) | Feasibility analysis |
| [Feature List](feature-list.md) | Complete feature inventory |

---

*Last Updated: November 2026*
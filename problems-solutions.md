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

---

## 3. Engine Limitations

### 3.1 Chromium Tooling

| Problem | Solution | Limitation |
|---------|----------|------------|
| System WebView does not expose full Chromium tooling | Provide supported inspection and task state observable to shell | CDP, request interception, response mocking, extensions, per-tab CPU/memory need different engine |

### 3.2 Translation Service

| Problem | Solution | Limitation |
|---------|----------|------------|
| Translation requires sending page text to external service | Make endpoint configurable; send extracted text only after explicit user action; require HTTPS | Endpoint receives translated text; authentication not supported |

### 3.3 Content Rendering

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
| Architecture | 5 | Child webviews, async operations, native menus |
| Privacy/Data | 2 | InPrivate storage, URL-scheme labels |
| Engine | 3 | Observable state, configurable services, CSS fallbacks |
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
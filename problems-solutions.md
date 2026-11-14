# Problems and Solutions

This document records recurring constraints and the implementation approach
used by the current code. It is not a claim that every limitation has been
eliminated.

| Problem | Current approach | Remaining limitation |
|---|---|---|
| A separate native window per tab breaks browser-like tab behavior | Use one Tauri window with a child webview per web tab; keep lifecycle and geometry in `TabWebviewManager` | Tauri's multi-webview API is behind the `unstable` feature |
| Remote pages must not access app commands | Keep the shell trusted and grant app capabilities to local origins only; remote pages run in child webviews | Continue treating navigation and all remote content as untrusted |
| Web content takes keyboard focus | Register browser shortcuts while the Govind window is focused; use page-side activation where a web gesture is required | Some shortcuts and gestures are constrained by the system webview |
| A DOM dropdown cannot cover a native page webview | Use an OS-native popup menu in desktop mode and keep an HTML overlay for the preview | Native menu styling is OS-controlled and requires a rebuilt app for visual verification |
| Creating a WebView2 controller on the UI thread can deadlock | Make tab navigation asynchronous and perform creation through Tauri's async runtime | Platform-specific engine behavior still needs native-app testing |
| Regular tabs share cookies and identity | Use WebView2 InPrivate storage for private tabs and keep them out of persistent app records | Per-tab or named-profile isolation for regular tabs is unavailable |
| A secure-looking URL does not prove certificate validity | Label current security state as derived from the URL scheme | Issuer, certificate chain, and negotiated TLS details are not inspected |
| System WebView does not expose full Chromium tooling | Provide supported webview inspection and task state observable to the shell | CDP, general request inspection/interception, response mocking, extensions,
  and accurate per-tab CPU/memory metrics need a different engine or APIs |
| Translation requires sending page text to an external service | Make the endpoint configurable and send extracted text only after explicit user action; require HTTPS for remote endpoints | The endpoint receives translated page text; authentication is not supported |
| Sites may behave differently under forced dark mode or reader extraction | Use lightweight CSS-based darkening and extraction from common article/main elements | Rendering/extraction quality varies by site |
| Preview cannot reproduce native WebView behavior | Provide a localStorage-backed command fallback for UI development | Iframes cannot display sites that block framing and do not validate native-only behavior |

For the architectural decision and engine trade-offs, see
`docs/ADR-007-embedded-webviews.md` and `docs/ENGINE_SPIKE.md`.

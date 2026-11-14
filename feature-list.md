# Feature List

Govind is a local-first desktop browser built with Tauri 2, Rust, and a
vanilla HTML/CSS/JavaScript interface. This list describes the current
implementation; the product roadmap in `docs/PRD_v2.md` is aspirational and
does not imply that every planned feature is available.

## Available

### Browsing and tabs

- Embedded web pages, one child webview per tab in a single native window.
- Create, activate, close, duplicate, pin, reorder, and group tabs.
- Tab context actions, including close other tabs, close to the right, and
  close all except pinned tabs.
- Private tabs backed by WebView2 InPrivate storage; private pages are excluded
  from persistent tabs and application history/download records.
- Guest mode that opens new tabs privately.
- Back, forward, reload, zoom, print, and find in page.
- Fullscreen, page titles, live address-bar URL, and page favicons.
- Controlled pop-ups, which open as browser tabs.
- Built-in PDF display where the system webview supports it.
- Page inspection through the webview's DevTools support.

### Organization and productivity

- Workspaces, bookmarks, favorites, and a customizable search URL template.
- Local browsing history, downloads, scratchpad notes, and site permissions.
- Reading list with locally stored text snapshots.
- Recently closed tabs for the current application session.
- Tab search / quick switcher and command palette.
- Reader mode, Read Aloud, and page translation through a configured
  LibreTranslate-compatible service.
- Picture-in-Picture, audio indicators and mute, forced dark mode, and
  per-domain zoom memory.
- Form autofill profiles and on-demand local password generation.
- Import/export bookmarks in Netscape HTML format.
- Task Manager page showing observable per-tab states.

### Privacy, safety, and settings

- HTTPS-first, website appearance, spellcheck, Do Not Track, safe-browsing
  warnings, and cosmetic content filters.
- Clear history, downloads, permissions, and per-site cookies/site data.
- Website permission decisions for supported permission types.
- No built-in telemetry; application data is stored locally.

## Limitations and not supported

- Regular tabs share the same webview profile; per-tab cookie/identity
  isolation is not available.
- The app does not inspect TLS certificates. The security indicator is based
  on the URL scheme and is labeled accordingly.
- The system webview does not expose Chromium DevTools Protocol, general
  request interception, response mocking, extensions, or per-tab CPU/memory
  measurements.
- Split view, tab sleeping, and interrupted-download resume are not
  implemented.
- Media casting, Web Share integration, site push notifications, and device
  emulation are not supported by the current integration.
- Translation needs a user-configured compatible endpoint; page text is sent
  only when translation is requested.
- Reader mode is a lightweight extraction, not a complete readability engine.
- Recently closed tabs and mute state do not persist across app restarts.
- Forced dark mode can render some sites incorrectly; site behavior can vary.
- PDF support depends on the platform webview.

See `README.md` for setup and shortcuts, `backend.md` for implementation
boundaries, and `docs/PRD_v2.md` for the longer-term product plan.

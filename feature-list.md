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
- Back, forward, reload, zoom, print, and find in page with a live match count.
- Fullscreen, page titles, live address-bar URL, and page favicons.
- Controlled pop-ups, which open as browser tabs.
- Built-in PDF display where the system webview supports it.
- Page inspection through the webview's DevTools support.

### Organization and productivity

- Workspaces, bookmarks, favorites, and a customizable search URL template.
- Local browsing history, downloads, scratchpad notes, and site permissions.
- Reading list with locally stored text snapshots.
- Recently closed tabs, persisted across restarts (last 20; private tabs are
  never recorded).
- Tab search / quick switcher and command palette.
- Reader mode, Read Aloud, and page translation through a configured
  LibreTranslate-compatible service.
- Picture-in-Picture, audio indicators and per-site remembered mute, forced
  dark mode, and per-domain zoom memory.
- Form autofill profiles and on-demand local password generation.
- Import/export bookmarks in Netscape HTML format.
- Passphrase-encrypted browser-data backup and merge restore (`.gbak`) for
  manual transfer between devices.
- Task Manager page showing observable per-tab states.

### Privacy, safety, and settings

- HTTPS-first, website appearance, spellcheck, Do Not Track, safe-browsing
  warnings, and cosmetic content filters.
- Built-in network, cosmetic and scriptlet ad/tracker blocking from bundled
  EasyList, EasyPrivacy and uBlock Origin lists, with per-list refresh
  schedules, a session pause toggle and a per-site allowlist.
- Clear history, downloads, permissions, and per-site cookies/site data.
- Website permission decisions for supported permission types.
- No built-in telemetry; application data is stored locally.

## Limitations and not supported

- Regular tabs share the same webview profile; per-tab cookie/identity
  isolation is not available.
- The app does not inspect TLS certificates. The security indicator is based
  on the URL scheme and is labeled accordingly.
- The system webview does not expose Chromium DevTools Protocol, extensions,
  or per-tab CPU/memory measurements. Request handling is limited to the
  Windows/WebView2 hook used by the ad blocker.
- Network filtering is Windows/WebView2 only. The hook cannot rewrite response
  bodies, so `$replace`-style anti-adblock rules and server-inserted ads are
  only partially handled and some sites (notably YouTube) may still show ads.
- Filter lists are public community lists refreshed on their own schedules; the
  blocker is not real-time cloud threat intelligence.
- Split view, tab sleeping, and interrupted-download resume are not
  implemented.
- Media casting, Web Share integration, site push notifications, and device
  emulation are not supported by the current integration.
- Translation needs a user-configured compatible endpoint; page text is sent
  only when translation is requested.
- Reader mode is a lightweight extraction, not a complete readability engine.
- Engine components WebView2 does not expose to its host cannot be added
  without replacing the engine: CDP request mocking and device emulation,
  per-tab cookie isolation, casting, Web Push, bfcache control, and the
  accessibility inspector tree. See README for the full boundary.
- There is no automatic cloud/account sync. Encrypted archives must be moved
  manually; losing the passphrase makes the archive unrecoverable.
- Forced dark mode can render some sites incorrectly; site behavior can vary.
- PDF support depends on the platform webview.

See `README.md` for setup and shortcuts, `backend.md` for implementation
boundaries, and `docs/PRD_v2.md` for the longer-term product plan.

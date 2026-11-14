# Engineering Process

## Principles

- Keep changes small, scoped to the requested behavior, and consistent with
  neighboring code.
- Reuse existing IPC commands, UI components, and storage patterns before
  introducing new abstractions or dependencies.
- Keep page-engine operations behind the `TabWebviewManager` boundary in
  `src-tauri/src/webview.rs`.
- Treat remote page content as untrusted. Do not expose application commands
  or privileged capabilities to remote origins.
- Be explicit about unsupported platform or webview behavior; do not present
  a URL-scheme heuristic as certificate verification or estimates as measured
  resource usage.
- Keep user data local unless a feature explicitly sends data to a configured
  service after the user initiates the action.

## Making a change

1. Read the relevant UI, IPC, Rust command, persistence, and test code before
   editing.
2. Trace the behavior end-to-end: user action, shell state, IPC, native
   operation, persisted data, and visible result.
3. Make the smallest complete change, including directly affected callers and
   focused regression tests for non-trivial behavior.
4. Run the smallest relevant test set, then run `npm test` and the relevant
   Rust checks when the change crosses those layers.
5. Review the diff for scope, formatting, accidental data/config changes, and
   consistency between user-facing documentation and actual behavior.

## UI changes

- Preserve keyboard operation, clear focus indicators, useful accessible
  names for icon-only controls, and touch-friendly targets.
- Check the layout at narrow and wide viewport sizes when changing responsive
  UI.
- Native child webviews are separate native surfaces; shell DOM stacking
  cannot cover them. Use a native popup or another native surface when an
  overlay must appear above a page.

## Persistence and privacy

- Keep durable browser data in SQLite for the desktop app and maintain the
  localStorage fallback where the feature is expected to work in preview.
- Validate values at Rust command boundaries, especially URLs, settings, and
  imported data.
- Private tabs must not enter persistent tab/session records or application
  history/download records. Do not imply this hides activity from websites,
  networks, or other system-level observers.
- Update `feature-list.md` and `README.md` when a change materially changes
  supported features or limitations.

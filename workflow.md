# Development Workflow

## Feature lifecycle

```text
Issue or request
      |
      v
Inspect requirements, current behavior, and engine/platform constraints
      |
      v
Identify UI, IPC, storage, documentation, and test touchpoints
      |
      v
Implement the smallest complete change
      |
      v
Run focused tests and relevant frontend/Rust checks
      |
      v
Review the diff, update docs, and commit
      |
      v
Push the intended branch and verify the remote result
```

## Local checks

From the repository root:

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
git diff --check
```

Run checks that cover the code changed; the UI preview can be started with
`npm run dev`, and the native application with `npm run tauri:dev`.

## Data flow for a browser feature

1. The shell UI handles the interaction in `ui/js/` and updates relevant state.
2. `ui/js/services/ipc.js` invokes a typed Tauri command in desktop mode.
3. The command validates inputs, coordinates SQLite or `TabWebviewManager`, and
   returns a result or explicit error.
4. The frontend renders the result. The preview implementation uses the
   fallback service for supported local features.
5. Focused tests cover the behavior and relevant documentation records
   support boundaries.

## Change and release hygiene

- Inspect `git status` before staging; preserve unrelated user changes.
- Stage only intended files, review `git diff --cached`, and avoid committing
  machine-specific paths, credentials, generated output, or local data.
- Use a descriptive commit message. Push only the intended branch to the
  configured repository after local checks and review.
- Native UI changes that depend on the operating system should be verified in
  a rebuilt desktop app when possible; a browser preview cannot validate
  native-window behavior.

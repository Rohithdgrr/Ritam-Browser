# Engineering Process

> Development guidelines and principles for Ritam Browser.

---

## 1. Core Principles

| Principle | Description |
|-----------|-------------|
| **Small Changes** | Keep changes scoped and focused on requested behavior |
| **Code Reuse** | Use existing IPC commands, UI components, and patterns before adding new ones |
| **Engine Boundary** | Keep page-engine operations behind `TabWebviewManager` in `src-tauri/src/webview.rs` |
| **Zero Trust** | Treat remote page content as untrusted; never expose app commands to remote origins |
| **Be Explicit** | Document unsupported behavior clearly; don't misrepresent URL schemes as certificate validation |
| **Local-First** | Keep user data local; only send data to external services when user explicitly initiates action |

---

## 2. Making a Change

### Step-by-Step Process

1. **Understand the Code**
   - read_file relevant UI, IPC, Rust command, persistence, and test code
   - Trace behavior end-to-end: user action → shell state → IPC → native operation → persisted data → visible result

2. **Implement the Change**
   - Make the smallest complete change
   - Include directly affected callers
   - Add focused regression tests for non-trivial behavior

3. **Verify and Review**
   - Run smallest relevant test set
   - Run `npm test` and Rust checks when crossing those layers
   - Review diff for scope, formatting, and accidental changes

4. **Document**
   - Update `feature-list.md` when support boundaries change
   - Keep `README.md` in sync with actual behavior

---

## 3. UI Development Guidelines

### Accessibility
- Preserve keyboard operation
- Use clear focus indicators
- Provide accessible names for icon-only controls
- Ensure touch-friendly target sizes

### Responsive Design
- Check layout at narrow (≤520px) and wide (>700px) viewport sizes
- Test sidebar behavior (drawer mode at ≤700px)

### Native Integration
- Native child webviews are separate native surfaces
- Shell DOM stacking cannot cover them
- Use native popup or surface when overlay must appear above a page

---

## 4. Persistence & Privacy

### Data Storage
| Store | Use Case |
|-------|----------|
| SQLite | Desktop app persistent data |
| localStorage | Preview mode fallback |

### Validation Requirements
- Validate all values at Rust command boundaries
- Especially: URLs, settings, imported data

### Privacy Rules
- Private tabs must NOT enter persistent tab/session records
- Private tabs must NOT enter application history/download records
- Do not imply private tabs hide activity from websites, networks, or OS-level observers

---

## 5. Quality Standards

### Before Committing

```bash
# Frontend tests
npm test

# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Rust check
cargo check --manifest-path src-tauri/Cargo.toml

# Git check
git diff --check
```

### What to Verify
- [ ] Tests pass
- [ ] Code compiles without warnings
- [ ] No unintended file changes
- [ ] Documentation reflects actual behavior
- [ ] No credentials or secrets committed

---

## 6. Related Documents

| Document | Description |
|----------|-------------|
| [Workflow](workflow.md) | Day-to-day development procedures |
| [Working Guide](working.md) | Setup and running the project |
| [Feature List](feature-list.md) | Feature implementation status |
| [Backend Architecture](backend.md) | Technical architecture |

---

*Last Updated: November 2026*
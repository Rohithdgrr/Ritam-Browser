# Development Workflow

> Standard procedures for developing Ritam Browser.

---

## 1. Feature Development Lifecycle

```
┌─────────────────┐
│  Issue/Request  │
└────────┬────────┘
         │
         v
┌─────────────────────────────┐
│  Analyze Requirements       │
│  - Current behavior         │
│  - Engine constraints       │
│  - Platform limitations     │
└────────┬────────────────────┘
         │
         v
┌─────────────────────────────┐
│  Identify Touchpoints       │
│  - UI components            │
│  - IPC commands             │
│  - Storage/schema           │
│  - Tests                    │
│  - Documentation            │
└────────┬────────────────────┘
         │
         v
┌─────────────────────────────┐
│  Implement Smallest Complete│
│  Change                     │
└────────┬────────────────────┘
         │
         v
┌─────────────────────────────┐
│  Test & Verify              │
│  - Focused tests            │
│  - Frontend/Rust checks     │
└────────┬────────────────────┘
         │
         v
┌─────────────────────────────┐
│  Review & Commit            │
│  - Diff review              │
│  - Documentation updates    │
└────────┬────────────────────┘
         │
         v
┌─────────────────────────────┐
│  Push & Verify Remote       │
└─────────────────────────────┘
```

---

## 2. Local Development Commands

### From Repository Root

```bash
# Frontend tests
npm test

# Rust tests
cargo test --manifest-path src-tauri/Cargo.toml

# Rust compilation check
cargo check --manifest-path src-tauri/Cargo.toml

# Git lint check
git diff --check
```

### Running the Application

```bash
# UI preview only (no Rust)
npm run dev

# Full desktop application
npm run tauri:dev

# Production build
npm run tauri:build
```

---

## 3. Data Flow for a Browser Feature

### End-to-End Flow

```
1. User Action
       │
       ▼
2. Shell UI (ui/js/)
   - Handles user interaction
   - Updates relevant state
       │
       ▼
3. IPC Layer (ui/js/services/ipc.js)
   - Invokes typed Tauri command
   - Falls back to localStorage in preview mode
       │
       ▼
4. Rust Command Handler (src-tauri/src/commands/)
   - Validates inputs
   - Coordinates SQLite or TabWebviewManager
   - Returns result or error
       │
       ▼
5. Frontend Rendering
   - Updates UI with result
   - Preview uses fallback service
       │
       ▼
6. Tests
   - Focused tests for behavior
   - Documentation for support boundaries
```

---

## 4. Change & Release Hygiene

### Before Staging

```bash
# Check what changed
git status

# Review unstaged changes
git diff

# Review staged changes
git diff --cached
```

### What NOT to Commit

| Item | Reason |
|------|--------|
| Machine-specific paths | Breaks cross-machine builds |
| Credentials/secrets | Security risk |
| Generated output | Should be rebuilt |
| Local data files | User-specific |
| Unrelated changes | Scope creep |

### Commit Guidelines

- Use descriptive commit messages
- Stage only intended files
- Push only the intended branch
- Verify remote result after push

### Native UI Verification

Native window behavior cannot be validated in browser preview. When making OS-native UI changes:
- Rebuild the desktop app
- Test in the actual application
- Verify on target OS

---

## 5. Related Documents

| Document | Description |
|----------|-------------|
| [Engineering Process](process.md) | Development principles and guidelines |
| [Working Guide](working.md) | Setup and environment |
| [Feature List](feature-list.md) | Feature implementation status |
| [Backend Architecture](backend.md) | Technical architecture |

---

*Last Updated: November 2026*
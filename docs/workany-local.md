# Local WorkAny sidecar

Ritam uses a locally built, hardened WorkAny API binary. The binary is not
committed; `src-tauri/binaries/` is ignored.

## Installed locations

| Purpose | Path |
|---|---|
| Dev discovery | `src-tauri/binaries/workany-api-x86_64-pc-windows-msvc.exe` |
| Installed-app discovery | `%APPDATA%\com.ritam.browser\workany\workany-api-x86_64-pc-windows-msvc.exe` |
| Runtime data | `%APPDATA%\com.ritam.browser\workany\` (`WORKANY_HOME`) |

`find_sidecar()` also honours `RITAM_WORKANY_API` for an explicit binary path.

## Hardening applied to upstream `dev`

The source lives in the ignored `.freebuff/workany` clone. Changes:

- `WORKANY_TOKEN` is mandatory; every route except `/health` requires
  `Authorization: Bearer <token>`.
- The server binds `127.0.0.1` explicitly.
- The wildcard CORS middleware is removed.
- `WORKANY_HOME` overrides the data directory. Logs, sessions, config, skills and
  MCP config all use it instead of `~/.workany`.
- `/files`, `/preview`, `/sandbox` and `/mcp` are not registered. Ritam only
  needs `/health`, `/agent` and `/agent/stop/:sessionId`.
- The pkg build no longer crashes on `import.meta.url` in the skills loader.

## Rebuild

```bash
git clone --depth 1 --branch dev https://github.com/workany-ai/workany.git .freebuff/workany
cd .freebuff/workany
git apply ../../docs/workany-hardening.patch
pnpm install
```

Then:

```bash
pnpm --filter workany-api build:binary:windows
cp src-api/dist/workany-api-x86_64-pc-windows-msvc.exe ../../src-tauri/binaries/
```

With pnpm 12 the workspace file needs `allowBuilds: { esbuild: true }`, or the
install stops with `ERR_PNPM_IGNORED_BUILDS`.## Provider key

The sidecar does not include a model provider key. This build is for local
development; do not redistribute it without checking WorkAny's license terms.

In Ritam, use the **NVIDIA NIM** field on the fixed **AI Workspace** tab, or
open **Settings → AI generation**. Paste an NVIDIA key (`nvapi-...`), pick a
model, and choose **Save & verify**. Use **Test models** on the AI Workspace tab
to check the key against the built-in model list and select the first one that
responds. Ritam sends a one-token chat request to the selected model on
`https://integrate.api.nvidia.com/v1`; the key is stored only after NVIDIA
accepts it. Ritam never returns the saved key to the renderer and excludes it
from encrypted backups.

A `401`, or a `403` with `Authorization failed`, means the key itself is invalid,
inactive, scoped for NGC rather than the API Catalog, or the account is not
verified. A `403`/`404` for one model while others work means the key does not
have access to that model; try another model.
Built-in choices: Nemotron 3 Super 120B, Nemotron 70B Instruct, Nemotron 3.5
Lightning 30B, Nemotron 51B Instruct and GPT-OSS 20B.

The key is stored per profile in the normal settings table. For a manual build,
the equivalent `%APPDATA%\com.ritam.browser\workany\config.json` form is:

```json
{
  "providers": {
    "sandbox": { "category": "sandbox", "type": "codex" },
    "agent": {
      "category": "agent",
      "type": "codeany",
      "config": {
        "apiKey": "<your NVIDIA key>",
        "baseUrl": "https://integrate.api.nvidia.com/v1",
        "apiType": "openai-completions",
        "model": "nvidia/nemotron-3-super-120b-a12b"
      }
    }
  }
}
```

## Verify

```bash
WORKANY_TOKEN=test WORKANY_HOME=/tmp/workany PORT=26211 \
  ./src-tauri/binaries/workany-api-x86_64-pc-windows-msvc.exe
```

- `GET /health` → 200 without a token.
- `GET /` → 401 without a token, 200 with it.
- `POST /files/read` → 404 even with the token (route is not registered).
- `POST /agent` → `text/event-stream` beginning with a `session` event.

## Uninstall

Delete the binary from `src-tauri/binaries/` and
`%APPDATA%\com.ritam.browser\workany\`. Remove the app-data directory only if
you also want to delete sessions, logs and provider config.

# ADR-008: WorkAny as the document-generation engine

**Status:** accepted; hardened local sidecar installed for development, not bundled in installers · **Date:** 2026-11-15

## Context

Ritam needs to generate PPTX, XLSX, DOCX and websites from a prompt. WorkAny
(github.com/workany-ai/workany) already contains that agent runtime, but it is a
desktop application, not an embeddable npm package. Its Hono backend is packaged
as a `pkg` Node binary and shipped by WorkAny itself through Tauri `externalBin`,
so invoking it as a local sidecar is the smallest realistic integration.

Ritam's shell is plain ES modules (`ui/js/`), not React/TypeScript. Its local
viewer reads DOCX/XLSX today but has no PPTX renderer, and there is no file
manager or `write_viewer_file` command. The generation UI therefore hangs off the
viewer header and command palette, and generated files are written by a new
atomic Rust writer.

## Decision

Use **Path A: a local WorkAny sidecar**, with two hard gates:

1. **Security.** The upstream API as observed on `dev` has no authentication,
   uses `cors({ origin: '*' })`, and calls `serve({ port })` without a host, so
   it listens on all interfaces. It also exposes `/files/read*` and
   `/files/open*`. Bundling that unchanged would create an unauthenticated local
   file/shell surface. Ship only after upstream (or a licensed derivative)
   provides:
   - binding to `127.0.0.1`;
   - `Authorization: Bearer <WORKANY_TOKEN>` on every route except `/health`;
   - no wildcard CORS;
   - `WORKANY_HOME` so prompts/logs/config stay under Ritam's app data;
   - a guaranteed session identifier (`X-Session-Id`) for cancellation;
   - canonical path checks that keep `/files/*` inside the job staging root.
2. **Sandbox.** `/providers/sandbox/available` must report a working provider in
   the packaged binary on a clean machine. If not, generation is disabled. Ritam
   never falls back to unsandboxed shell execution.

If WorkAny will not take those changes and a commercial redistribution license
is not available, the fallback is a Rust-native generation service (Path B), not
an unmodified sidecar.

For local development Ritam builds the sidecar from the upstream `dev` source
with those gates applied. The local build also leaves the file, preview, sandbox
and MCP HTTP routes unregistered. See [workany-local.md](workany-local.md).

## Why not the other paths

- **Path B (port the runtime):** a full Rust agent port is far larger and would
  duplicate sandbox/tool-execution behaviour that WorkAny already maintains.
- **Path C (MCP):** WorkAny exposes an MCP *client* and a sandbox MCP server,
  not the generation agent as an MCP server. Path C would require a new wrapper
  plus a separate WorkAny installation.

## Sidecar contract (Rust → loopback)

All requests include `Authorization: Bearer <token>`; the token is generated per
process, passed by environment (never argv), and never logged.

### Generate

`POST /agent`

```json
{
  "prompt": "Create a six-slide deck… Save the .pptx in the workspace.",
  "workDir": "<app-data>/generations/<job>/staging",
  "language": "en-US",
  "modelConfig": {
    "apiKey": "<NVIDIA key from Settings; never logged>",
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "apiType": "openai-completions",
    "providerId": "nvidia",
    "model": "nvidia/nemotron-3-super-120b-a12b"
  },
  "sandboxConfig": { "enabled": true, "provider": "codex" },
  "skillsConfig": { "enabled": false, "userDirEnabled": false, "appDirEnabled": false },
  "mcpConfig": { "enabled": false, "userDirEnabled": false, "appDirEnabled": true }
}
```

Response is `text/event-stream`:

```
data: {"type":"session","sessionId":"..."}
data: {"type":"text","content":"...","isDelta":true}
data: {"type":"tool_use","name":"Write","input":{...}}
data: {"type":"tool_result","output":"...","isError":false}
data: {"type":"result","cost":0.12,"duration":12345}
data: {"type":"done"}
```

Errors are an HTTP 4xx/5xx JSON body or an SSE `{"type":"error","message":"…"}`
followed by `done`. The response also carries `X-Session-Id`.

### Cancel

`POST /agent/stop/<sessionId>` → `{"status":"stopped"}`.

### Artifact discovery

Rust runs on the same machine as the sidecar, so it does **not** call
`/files/read-binary` (that route exposes an unnecessary base64 file API). After
`done`, Rust lists the job staging directory itself, rejects symlinks and paths
outside that directory, picks the newest matching allowlisted extension, and
enforces the 64 MB cap before reading. Website output is the `index.html` entry
plus its sibling assets.

### Config / MCP

- `GET /providers/config` — provider and model only; **Rust strips `apiKey`**
  before anything reaches the renderer.
- `GET`/`POST /mcp/config` — `{ "mcpServers": { … } }`, capped and validated.
- `GET /health` — readiness.

## Process lifecycle

Rust reserves a loopback port, spawns the sidecar with `HOST=127.0.0.1`, `PORT`,
`WORKANY_TOKEN`, `WORKANY_HOME` and `RITAM_MODE=1`, then polls `/health` for up to 30 seconds.
The child handle lives in `GenerationState`; shutdown kills it on app exit.
Crashes disable generation until the next request, which retries once. Ritam must
never kill a process by port (WorkAny's current fallback can kill unrelated
processes).

## Output handling

- Prompt: trimmed, 1–8,000 chars.
- Types: `pptx`, `xlsx`, `docx`, `website`.
- Staging: `<app-data>/generations/<job>/staging`; the sidecar writes only here.
- Rust selects the newest matching artifact (or `index.html` for a website),
  validates containment and size, then writes through `atomic::write_atomic`
  (temp sibling → `sync_all` → rename). Existing files are never overwritten.
- Website assets remain in the generated directory. In-app website serving needs
  a scoped origin and is not part of this scaffold; the current UI offers "Open
  folder" for a website result.

## Status in this repository

Implemented now:

- hardened local sidecar (loopback bind, bearer token, no wildcard CORS,
  `WORKANY_HOME`, `/health` + `/agent` routes only), installed for development;
- atomic writer;
- Rust generation client/supervisor with allowlist, staging, SSE parsing,
  cancellation, staging-directory artifact discovery, and atomic final write;
- IPC wrappers and preview fallback;
- generation dialog/reducer and palette/viewer entry points;
- NVIDIA NIM key entry in Settings with a server-side verification call, secret
  redaction and backup exclusion;
- PPTX text-outline preview (not a faithful slide renderer);
- tests for validation, SSE, path containment and dialog state.

Not yet shippable:

- the hardened WorkAny binary as a signed `externalBin` bundle in installers;
- sandbox preflight on a clean machine;
- scoped website serving (current result opens the folder);
- MCP editor;
- real-generation E2E with an actual NVIDIA key on a clean machine.

## Risks

| Risk | Mitigation |
|---|---|
| Unauthenticated API / all interfaces | Upstream bind + token + CORS removal; fail closed. |
| WorkAny Community License | Keep the binary unmodified if upstream accepts the patch; otherwise obtain a commercial derivative license and include notices. No WorkAny branding. |
| Sandbox unavailable | Preflight; disable generation rather than run unsandboxed. |
| Installer size | One target binary per installer; lazy spawn; measure. |
| Orphan processes | Managed child + kill on exit; process-tree cleanup on Windows. |
| Prompt leakage | Provider-only transmission; WorkAny data under app data; never in backups; API keys redacted. |
| Generated HTML is untrusted | Future scoped origin, loaded in a child webview with no Tauri capabilities. |
| PPTX expectations | Text-outline preview (title + body text), explicitly not Univer/PDF fidelity; the original file remains available on disk. |
| Provider cost | Show provider/model and a cost warning; display WorkAny's reported cost after completion. |

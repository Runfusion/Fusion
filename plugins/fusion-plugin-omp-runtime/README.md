# fusion-plugin-omp-runtime

Oh My Pi (`omp`) CLI-backed provider/runtime plugin for Fusion. Agent sessions use **native ACP** (`omp acp`) for realtime streaming, tool visibility, and multi-turn reuse.

## Install

This plugin is staged with Fusion runtime plugins. It shells out to an **operator-installed** `omp` binary on PATH — Fusion never downloads or bundles the CLI itself.

### External integration evidence

Per `AGENTS.md` (External-integration evidence):

- **Canonical upstream repo URL:** https://github.com/can1357/oh-my-pi
- **Docs / homepage URL:** https://omp.sh/ · https://omp.sh/docs/acp
- **Release / download URL:** https://github.com/can1357/oh-my-pi/releases · installer `curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh` · npm `@oh-my-pi/pi-coding-agent`
- **Binary / CLI name:** `omp`
- **Checksum:** `upstream-pending-verification` (operator-installed binary; Fusion does not pin/download it)
- **ACP protocol:** https://agentclientprotocol.com · https://github.com/zed-industries/agent-client-protocol
- **ACP TypeScript SDK:** `@agentclientprotocol/sdk` `0.24.0`

## Contract summary

| Item | Value |
| --- | --- |
| Plugin ID | `fusion-plugin-omp-runtime` |
| Runtime ID | `omp` |
| Provider ID | `omp-cli` |
| Binary probe | `omp --version` |
| ACP launch | `omp acp` (equiv. `omp --mode acp`) |
| Optional model | `omp --model <id> acp` |
| Auth | omp `agent` method — reuses `~/.omp` provider keys / OAuth |

## Agent session path — ACP (primary)

`OmpRuntimeAdapter` drives omp’s native ACP server with a **vendored** ACP client (copied under `src/acp/`, not imported from `fusion-plugin-acp-runtime`):

```bash
omp acp
# optional model:
omp --model claude-sonnet-4 acp
```

- **Realtime streaming** — ACP `session/update` notifications map to Fusion `onText` / `onThinking` / `onToolStart` / `onToolEnd`.
- **Multi-turn** — one `createSession` keeps the ACP connection; each `promptWithFallback` is a `session/prompt` on the same session.
- **Permissions** — omp tool calls surface as `session/request_permission` and go through Fusion’s per-category action gate.
- **Auth** — after `initialize`, Fusion prefers the `agent` auth method (credentials under `~/.omp`). Terminal/TUI login is not preferred for headless Fusion.
- **Env** — subprocess env is allow-listed (`HOME`/`PATH`/XDG + common provider key names). Full `process.env` is never inherited.

See https://omp.sh/docs/acp for the upstream protocol surface (slash commands, `_omp/*` extensions, wire debugging).

## Enable in Fusion

1. Install & authenticate `omp` (`omp --version`; credentials under `~/.omp`).
2. Install/enable this plugin (staged bundled runtime).
3. **Settings → Authentication → Oh My Pi — via omp ACP** → Enable (optional binary path).
4. Either:
   - Agent → **Runtime Source: Runtime** → **OMP Runtime** (`runtimeHint: "omp"`), or
   - Pick an `omp-cli/*` model when the toggle is on (from `omp models`).

## Fusion tools (`fn_*`)

Engine `customTools` (board/task/agent tools such as `fn_task_list`) are exposed to
omp as MCP server **`fusion-custom-tools`**:

1. `OmpRuntimeAdapter` starts a **loopback HTTP bridge** holding the in-process
   `ToolDefinition.execute` closures.
2. Session `session/new.mcpServers` includes a stdio MCP child
   (`mcp-schema-server.cjs`) that implements `tools/list` + `tools/call` and
   POSTs calls to the bridge (`FUSION_OMP_TOOL_BRIDGE_URL`).
3. Operator-configured MCP servers are forwarded alongside (stdio/http/sse).
4. System rules tell omp to prefer `fusion-custom-tools` for Fusion board ops.

## Known v1 gaps

| Gap | Status |
| --- | --- |
| Auto-route `omp-cli/*` without explicit Runtime Source | **Partial** — models surface when Enable is on; prefer `runtimeHint: "omp"` for agent lanes |
| Mid-session Fusion model picker changes | **Not wired** — model is fixed at `omp --model … acp` spawn |

## Settings (ACP spawn bag)

Built internally by `buildOmpAcpRuntimeSettings`:

| Key | Default | Meaning |
| --- | --- | --- |
| `acpBinaryPath` | `omp` | Agent binary |
| `acpArgs` | `["acp"]` | ACP mode args |
| `acpModel` | `omp/default` | Model id for describeModel / optional `--model` |
| `acpEnvAllowList` | see `OMP_ACP_ENV_ALLOWLIST` | Env names forwarded |
| `acpFsRead` / `acpFsWrite` | `false` | Client-side ACP fs capabilities (opt-in) |
| `acpAllowUnrestricted` | `true` | Operator-selected first-party CLI posture |
| `acpAuthenticate.preferMethods` | `["agent","terminal"]` | Post-initialize auth |

## Development

```bash
pnpm --filter @fusion-plugin-examples/omp-runtime test
pnpm --filter @fusion-plugin-examples/omp-runtime build
```

## Notes

- Do not invent release checksums for the operator’s `omp` binary.
- Generic multi-agent ACP (any binary) remains `fusion-plugin-acp-runtime`; this plugin is the omp-specific first-class path with sane defaults.

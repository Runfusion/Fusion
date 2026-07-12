# Grok CLI Contract (FN-7790 / FN-7796, updated for ACP transport)

Date: 2026-07-11

<!--
FNXC:GrokAcp 2026-07-11-12:00:
Agent session transport is native ACP (`grok agent stdio`) for realtime
session/update streaming, tool visibility, multi-turn session reuse, and Fusion
permission-gate integration. The previous one-shot `grok -p --output-format json`
path is retired as the primary prompt transport because it buffered until
subprocess close and could not surface tool calls. Probe (`grok --version`) and
model discovery (`grok models`) are unchanged.
-->

## Ground truth

Fusion shells out to an **operator-installed** `grok` binary. The binary is not downloaded or bundled by Fusion, so the authoritative contract is the installed xAI CLI's own help/version output plus live execution on an authenticated machine.

External integration evidence:

- Canonical upstream: xAI official Grok CLI / Grok Build TUI, surfaced by the installed binary as `grok 0.2.93 (f00f96316d4b)`.
- Docs/homepage: https://grok.com/, https://docs.x.ai/, https://docs.x.ai/build/overview, and `grok --help` / `grok agent --help` / `grok agent stdio --help` for exact flags.
- ACP protocol: https://agentclientprotocol.com
- Release/download: operator-installed; Fusion resolves `grok` from PATH or `grokCliBinaryPath` and does not bundle a release artifact.
- Binary name: `grok`.
- Checksum: `upstream-pending-verification` because Fusion does not pin or download the operator's binary.

The previously documented https://github.com/superagent-ai/grok-cli contract is a different product that happens to use the same binary name. Its `grok --prompt <text> --format json` invocation is not accepted by xAI's CLI.

## Agent session transport — ACP (`grok agent stdio`)

Fusion's `GrokRuntimeAdapter` drives Grok as an ACP (Agent Client Protocol) agent over JSON-RPC/stdio, following [xAI Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting#acp):

```bash
# Official automation shape (docs.x.ai): suppress update checks in CI/scripts
grok --no-auto-update agent stdio
# with optional model + session skills plugin:
grok --no-auto-update agent --plugin-dir <session-plugin> -m grok-4.5 stdio
```

ACP session lifecycle (official contract):

1. `initialize` (protocolVersion 1)
2. **`authenticate`** — prefer `xai.api_key` when `XAI_API_KEY` is set and advertised, else `cached_token`, with `_meta: { headless: true }`
3. `session/new` (cwd, mcpServers, optional `_meta.pluginDirs` / rules)
4. `session/prompt` — completion metadata on the response; assistant text arrives as `session/update` `agent_message_chunk`s

Auth: local `grok login` (cached token in `~/.grok/auth.json`) **or** `XAI_API_KEY`. Fusion forwards `XAI_API_KEY` on the spawn allow-list.

Implementation uses a **vendored** ACP client under `plugins/fusion-plugin-grok-runtime/src/acp/` (copied from the ACP runtime plugin; not a package import) with Grok-specific settings:

| Setting | Grok value |
| --- | --- |
| Binary | `grok` (or configured path) |
| Args | `["agent", "--plugin-dir", "<session-plugin>", …, "stdio"]` (optional `-m <id>`) |
| Env | Allow-list including `HOME`/`PATH`/`USER`/XDG + optional `XAI_API_KEY`/`GROK_API_KEY` (never full `process.env`) |
| `acpFsRead` / `acpFsWrite` | `false` (Grok has native tools; client-side fs stays off) |
| `acpAllowUnrestricted` | `true` (operator-selected first-party CLI; non-allow policy categories still gated) |
| `session/new.mcpServers` | Operator MCP servers (stdio/http/sse) + Fusion `fusion-custom-tools` bridge for `fn_*` |
| Skills | Session-scoped Grok plugin (`--plugin-dir` + `_meta.pluginDirs`) with bundled Fusion skill + `additionalSkillPaths` |

### Fusion tools and skills

<!--
FNXC:GrokAcp 2026-07-11-14:00:
Parity with pi sessions: executor/chat lanes pass customTools + skillSelection +
mcpServers through createResolvedAgentSession. Grok ACP must not drop them.
-->

1. **Operator MCP** — `options.mcpServers` is reshaped to ACP wire format and forwarded on `session/new`.
2. **Fusion custom tools (`fn_*`)** — engine `customTools` are hosted by a loopback HTTP bridge + stdio MCP server (`mcp-schema-server.cjs`) named `fusion-custom-tools`. Grok invokes tools via real MCP `tools/call`; the bridge runs `ToolDefinition.execute` in-process.
3. **Skills** — the bundled Fusion skill (`packages/cli/skill/fusion`) plus any `additionalSkillPaths` skill roots are staged into a temp plugin directory and loaded via `grok agent --plugin-dir` and `_meta.pluginDirs`. Requested skill names and tool counts are also written into `_meta.rules` / system prompt context.

### Session lifecycle

1. `createSession` — spawn `grok agent stdio`, ACP `initialize`, `session/new` over the task cwd.
2. `promptWithFallback` — ACP `session/prompt` with text + optional chat image ContentBlocks from prompt options; stream `session/update` notifications until terminal `stopReason`.
3. `dispose` — best-effort `session/cancel` + process-registry SIGKILL (authoritative no-orphan guarantee).

### Streamed update mapping

| ACP `sessionUpdate` | Fusion callback |
| --- | --- |
| `agent_message_chunk` | `onText` |
| `agent_thought_chunk` | `onThinking` |
| `tool_call` | `onToolStart` |
| `tool_call_update` (terminal) | `onToolEnd` |

Multi-turn conversations reuse the same ACP session/connection (no cold spawn per prompt).

### Auth

Grok owns authentication. Preferred path is a cached session in `~/.grok/auth.json` (requires `HOME` in the allow-list). Optional key-based auth uses `XAI_API_KEY` or `GROK_API_KEY` when no cached token is present. The readiness probe (`grok --version`) proves only binary presence, not authenticated ACP readiness.

### Permissions

Tool calls from the Grok agent surface as ACP `session/request_permission` and route through Fusion's per-category action gate (same floor as the generic ACP runtime). Unrestricted policy + `acpAllowUnrestricted` auto-allows sensitive categories for autonomous executor turns; `require-approval` / `block` still apply when configured.

## Failures that shaped the prior headless contract (historical)

### Wrong-product flags (FN-7790)

The old adapter invocation fails against the real xAI binary:

```bash
grok --prompt "say hello" --format json
```

### Streaming JSON cancellation with zero text (FN-7796)

`--output-format streaming-json` intermittently ended `stopReason:"Cancelled"` with zero `text` events. That motivated the temporary switch to single-object `--output-format json`. ACP replaces both headless modes for agent sessions because it streams reliably over JSON-RPC and carries tool/permission structure.

## Probe and model discovery (unchanged)

### Version probe

```bash
grok --version
```

### Model discovery

`grok models` is plain text, not JSON. Observed shape:

```text
You are logged in with grok.com.

Default model: grok-4.5

Available models:
  * grok-4.5 (default)
  - grok-composer-2.5-fast
```

Fusion parses the bullet list conservatively and exposes ids under provider `grok-cli` when the `useGrokCli` toggle is enabled.

## Runtime routing

The Grok runtime adapter is reached when:

1. an agent explicitly sets `runtimeConfig.runtimeHint === "grok"`; or
2. the FN-7753/FN-7758 no-visible-key fallback derives the same runtime hint for a `grok-cli/*` default/fallback provider selection and the bundled Grok Runtime plugin is registered.

The selected `grok-cli/<id>` or `grok/<id>` model is normalized to `<id>` and passed as `grok agent -m <id> stdio`. The explicit no-model Runtime-mode path keeps `grok/default` and omits `-m`.

## Diagnostics and empty-output invariant

The adapter preserves the resolve-never-reject runtime contract while surfacing concrete diagnostics:

- ACP create/handshake failure → dead session + diagnostic `onText` (create does not throw to the engine).
- ACP prompt failure → diagnostic `onText` when no assistant text streamed; never reject.
- Abnormal `stopReason` (not `end_turn`) with zero text → stop-reason diagnostic.
- Clean `end_turn` with no assistant text → legitimate silent response, not a diagnostic.
- Partial text before a failed close → keep the assistant text; do not replace it with an error.

This invariant prevents blank/no-message assistant bubbles while still allowing genuinely empty model turns.

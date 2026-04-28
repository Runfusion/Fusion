# OpenClaw Runtime Plugin

Drives the local **`openclaw` CLI** ([openclaw/openclaw](https://github.com/openclaw/openclaw)) as a subprocess. By default it runs `openclaw agent --local` (embedded mode, no daemon required); you can opt into the WebSocket gateway with `useGateway: true`.

## What it does

For each `promptWithFallback(session, prompt)`:

1. Spawns `openclaw --no-color agent --local --json --session-id <uuid> --message <prompt>` (plus `--agent`, `--model`, `--thinking`, `--timeout` if configured).
2. Reads the single JSON document on stdout (matching `OpenClawAgentJson`):
   - Concatenates `payloads[]` where `!isError && !isReasoning` → `session.callbacks.onText(...)`.
   - Joins `payloads[].isReasoning === true` → `session.callbacks.onThinking(...)`.
   - Surfaces tool-level errors (`payloads[].isError === true`) as a logger warning.
   - Stores `meta.agentMeta.usage` on the session for token accounting.
3. Reuses the same UUID across every prompt for the session so OpenClaw resumes the same agent conversation server-side.

The previous HTTP `/v1/chat/completions` integration has been removed — that endpoint required a separate gateway daemon and was an OpenAI-compat shim. The CLI surface is the canonical OpenClaw API.

## Prerequisites

```bash
npm install -g openclaw
```

Verify with `openclaw --version` (expect `OpenClaw 2026.x.y`).

If you want gateway mode (`useGateway: true`), also start `openclaw gateway run` separately.

> **First-run note:** the very first `openclaw agent` invocation lazy-installs runtime deps and can take 30–60s. Subsequent calls are fast.

## Settings

| Key | Env var | Default | Notes |
|---|---|---|---|
| `binaryPath` | `OPENCLAW_BIN` | `openclaw` | Path to the `openclaw` binary. |
| `agentId` | `OPENCLAW_AGENT_ID` | `main` | Maps to `--agent <id>`. List with `openclaw agents list`. |
| `model` | `OPENCLAW_MODEL` | (OpenClaw default) | Maps to `--model <provider/model>`, e.g. `anthropic/claude-haiku-4-5`. |
| `thinking` | `OPENCLAW_THINKING` | `off` | One of `off | minimal | low | medium | high | xhigh | adaptive | max`. |
| `cliTimeoutSec` | `OPENCLAW_TIMEOUT_SEC` | `0` | OpenClaw-side timeout (0 = no limit). |
| `cliTimeoutMs` | `OPENCLAW_CLI_TIMEOUT_MS` | `300000` | Hard kill on the Fusion side. |
| `useGateway` | `OPENCLAW_USE_GATEWAY` | `false` | When `true`, omit `--local`; the CLI tries the WS gateway and falls back to embedded after ~2 s. |

Settings precedence: plugin settings → env var → default.

## Limitations

- **No per-token streaming.** `--json` emits a single JSON document at process exit. `onText` is called exactly once.
- **Default ignores the gateway.** With `useGateway: false` (default) we always pass `--local`, skipping the WebSocket connect attempt entirely. Most users want this.
- **AbortSignal sends SIGTERM.** If the CLI ignores it (e.g. during a long model download), the hard-kill timer (`cliTimeoutMs`) eventually fires.

## Public API

```ts
import {
  OpenClawRuntimeAdapter,
  resolveCliConfig,
  buildOpenClawArgs,
  createCliSession,
  promptCli,
  describeCliModel,
  extractStderrError,
  probeOpenClawBinary,
  type CliConfig,
  type GatewaySession,
  type OpenClawAgentJson,
  type OpenClawBinaryStatus,
} from "@fusion-plugin-examples/openclaw-runtime";
```

`probeOpenClawBinary({ binaryPath?, timeoutMs? })` runs `openclaw --version` and returns `{ available, version, binaryPath, reason, probeDurationMs }` — used by the dashboard's "Runtimes → OpenClaw" settings card.

## Agent configuration

To create a Fusion agent backed by OpenClaw, set `runtimeConfig.runtimeHint`:

```json
{
  "name": "OpenClaw Executor",
  "role": "executor",
  "runtimeConfig": {
    "runtimeHint": "openclaw"
  }
}
```

Runtime selection happens in the dashboard's **New Agent → Plugin Runtime → OpenClaw**.

## Metadata

- **Plugin ID:** `fusion-plugin-openclaw-runtime`
- **Runtime ID:** `openclaw`
- **Package:** `@fusion-plugin-examples/openclaw-runtime`

## Development

```bash
pnpm --filter @fusion-plugin-examples/openclaw-runtime test    # 44 tests
pnpm --filter @fusion-plugin-examples/openclaw-runtime build
```

# Hermes Runtime Plugin

Drives the local **`hermes` CLI** ([NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)) as a subprocess, so a Fusion agent backed by this runtime delegates each prompt to a real Hermes Agent process running on the same machine.

## What it does

For each `promptWithFallback(session, prompt)` call:

1. Spawns `hermes chat -q <prompt> -Q --source tool` (with `--resume <id>` on subsequent calls in the same session).
2. Captures the trailing `session_id: YYYYMMDD_HHMMSS_xxxxxx` line from stdout.
3. Strips ANSI + TUI chrome (`╭─ Hermes ─╮`, `↻ Resumed session …`, etc.) and forwards the cleaned response body to `session.callbacks.onText(...)`.
4. Persists the captured session id on the session object so the next call resumes the same Hermes session.

This is fundamentally different from the older "raw-model" approach that bypassed `hermes` entirely by calling `@mariozechner/pi-ai` directly. The CLI subprocess is now the source of truth — provider/model selection, auth, skills, and memory are all the responsibility of the user's local `hermes` install.

## Prerequisites

You need the `hermes` Python CLI on `PATH` (or set `binaryPath` / `HERMES_BIN`). Install instructions:

```bash
# Recommended: use the upstream installer
curl -LsSf https://hermes-agent.nousresearch.com/install.sh | sh

# Or via pipx (cross-platform)
pipx install hermes-agent
```

After install, run `hermes login` (or `hermes auth`) to configure a provider. The Fusion plugin does **not** manage Hermes auth — it inherits whatever the local install has.

Verify with `hermes --version`.

## Limitations

Because we drive the CLI's `chat -q` mode:

- **No per-token streaming.** Hermes buffers output through prompt_toolkit; the full response arrives once the process exits. `onText` is called exactly once per turn.
- **No reasoning/thinking deltas.** `-Q` mode suppresses them. If you need streaming + reasoning, switch to Hermes's ACP mode (not yet implemented in this plugin).
- **No tool-call hooks.** Hermes runs tools internally; Fusion only sees the final assistant text. Use `yolo: true` to skip Hermes's interactive approval prompts in non-interactive sessions.
- **`AgentRuntimeOptions.cwd`, `tools`, `skills`, `sessionManager`, etc. are ignored** — Hermes's own session/tools/skills systems handle these.

## Settings

| Key | Env var | Default | Notes |
|---|---|---|---|
| `binaryPath` | `HERMES_BIN` | `hermes` | Path to the `hermes` binary. Falls back to PATH lookup. |
| `model` | `HERMES_MODEL_ID` | (Hermes default) | `-m <model>` (e.g. `claude-sonnet-4-5`, `MiniMax-M2.7`). |
| `provider` | `HERMES_PROVIDER` | (Hermes default) | `--provider <provider>` — one of `auto`, `anthropic`, `openrouter`, `gemini`, `openai-codex`, `copilot`, `copilot-acp`, `huggingface`, `zai`, `kimi-coding`, `minimax`, `minimax-cn`, `kilocode`, `xiaomi`, `nous`. |
| `maxTurns` | `HERMES_MAX_TURNS` | `12` | `--max-turns N`. Hermes's own default is 90; we cap lower. |
| `yolo` | `HERMES_YOLO` | `false` | `--yolo` — skip interactive approval. Required for non-interactive sessions that use shell-style tools. |
| `cliTimeoutMs` | `HERMES_CLI_TIMEOUT_MS` | `300000` (5 min) | Hard kill on the Fusion side. |

Settings precedence: plugin settings → env var → default.

## Public API

```ts
import {
  HermesRuntimeAdapter,
  resolveCliSettings,
  invokeHermesCli,
  buildHermesArgs,
  parseHermesOutput,
  probeHermesBinary,
  type HermesCliSettings,
  type HermesCliResult,
  type HermesBinaryStatus,
} from "@fusion-plugin-examples/hermes-runtime";
```

`probeHermesBinary({ binaryPath?, timeoutMs? })` runs `hermes --version` and returns `{ available, version, binaryPath, reason, probeDurationMs }`. Used by the dashboard's "Runtimes → Hermes" settings card to power the install-status badge.

## Metadata

- **Plugin ID:** `fusion-plugin-hermes-runtime`
- **Runtime ID:** `hermes`
- **Package:** `@fusion-plugin-examples/hermes-runtime`

## Development

```bash
pnpm --filter @fusion-plugin-examples/hermes-runtime test       # 41 tests
pnpm --filter @fusion-plugin-examples/hermes-runtime build
```

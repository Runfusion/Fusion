# OMP ACP Runtime Contract

Date: 2026-07-11

Launch/readiness contract for `fusion-plugin-omp-runtime`, which drives
[Oh My Pi (`omp`)](https://omp.sh/) over the
[Agent Client Protocol](https://agentclientprotocol.com) (`omp acp`).

Mirrors the shape of `docs/acp-contract.md` and `docs/grok-cli-contract.md`.

## Transport

- **Newline-delimited JSON-RPC 2.0 over stdio** via `@agentclientprotocol/sdk`
  (`ndJsonStream` + `ClientSideConnection`), vendored under the plugin’s
  `src/acp/` (same client as Grok ACP — not imported from the experimental
  `fusion-plugin-acp-runtime` package).
- Fusion launches `omp` as a subprocess with piped stdio.
- `stderr` is captured for diagnostics, never parsed as protocol.

## Invocation

```bash
omp acp
# optional model:
omp --model <id> acp
# equivalent mode flag:
omp --mode acp
```

Upstream docs: https://omp.sh/docs/acp

## Binary detection / readiness

- Probe: `omp --version` (exit 0 ⇒ available).
- Auth is owned by the local `omp` install under `~/.omp` (provider keys / OAuth).
  Fusion does not require a Fusion-visible API key.
- ACP handshake: `initialize` → `authenticate` (prefer method `agent`) →
  `session/new` → `session/prompt` turns.

## Env isolation

Subprocess env is built from `OMP_ACP_ENV_ALLOWLIST` only (HOME/PATH/XDG + common
provider key names). Inherited `process.env` is **not** forwarded.

## Failure surface

| Situation | Behavior |
| --- | --- |
| Binary missing | Probe `available: false`; createSession emits onText diagnostic |
| ACP handshake fail | Dead session + visible onText diagnostic (never silent empty) |
| Mid-turn error | Partial text kept; empty turn gets diagnostic |
| Dispose / no connection | Follow-up prompts re-surface connection diagnostic |

## External integration evidence

- Canonical upstream repo: https://github.com/can1357/oh-my-pi
- Docs / homepage: https://omp.sh/ · https://omp.sh/docs/acp
- Release / download: https://github.com/can1357/oh-my-pi/releases · installer script / npm `@oh-my-pi/pi-coding-agent`
- Binary / CLI name: `omp`
- Checksum: `upstream-pending-verification` (operator-installed)

## Plugin metadata

- Plugin ID: `fusion-plugin-omp-runtime`
- Runtime ID: `omp`
- Provider ID: `omp-cli`
- Package: `@fusion-plugin-examples/omp-runtime`
- Global settings: `useOmpCli`, `ompCliBinaryPath`
- Auth routes: `POST /api/auth/omp-cli`, `GET /api/providers/omp-cli/status`

## Fusion context delivery

- `systemPrompt` is forwarded on ACP `session/new` as `_meta.systemPromptOverride`.
- Operator MCP servers are eligible for `session/new.mcpServers` (`runtimeSupportsMcp("omp")`).
- Fusion in-process `fn_*` custom tools are **not** bridged in v1.

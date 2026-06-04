# ACP (Agent Client Protocol) Runtime Contract

Date: 2026-06-03

Launch/readiness contract and failure taxonomy for `fusion-plugin-acp-runtime`,
which drives any external [Agent Client Protocol](https://agentclientprotocol.com)
agent over JSON-RPC/stdio. Mirrors the shape of `docs/cursor-cli-contract.md`.

## Transport

- **Newline-delimited JSON-RPC 2.0 over stdio** (no Content-Length framing).
  Provided by `@agentclientprotocol/sdk` (`ndJsonStream` + `ClientSideConnection`).
- The client (Fusion) launches the agent as a subprocess with piped stdio. The
  agent's stdin is the JSON-RPC *output* stream; its stdout is the *input* stream.
- `stderr` is captured (redacted) for diagnostics, never parsed as protocol.

## Invocation and binary detection

- Unlike a single-vendor CLI, ACP is a protocol — the agent binary + ACP-mode
  flag are user-configured:
  - `acpBinaryPath` — e.g. `gemini`, `npx`, or an absolute path.
  - `acpArgs` — the flag(s) that put the agent in ACP/stdio mode, e.g. `["--acp"]`.
- The subprocess environment is built from the `acpEnvAllowList` allow-list only
  (inherited `process.env` is **not** forwarded — the agent is untrusted).

## Readiness = the `initialize` handshake

There is no `--version` probe. Readiness is the protocol handshake itself:

1. Spawn the agent subprocess.
2. Send `initialize { protocolVersion: 1, clientCapabilities: { fs } }` under a
   timeout (default 30s — research flagged Gemini-on-macOS OAuth and Claude-adapter
   `session/new` stalls).
3. The agent responds with its integer `protocolVersion`, `agentCapabilities`,
   and `authMethods`.
4. The client compares the integer protocol version; an unsupported version is a
   hard failure (do not assume the agent errors first).

`fs` capabilities are advertised **only** when `acpFsRead`/`acpFsWrite` are
enabled (writes default OFF).

## Failure taxonomy (`probe.ts` `AcpProbeReason`)

| Reason | Trigger |
| --- | --- |
| `ok` | Handshake completed (with `authRequired: true` when `authMethods` is non-empty) |
| `missing_binary` | Spawn `ENOENT` (binary not found, code 127) |
| `spawn_error` | Other spawn failure |
| `handshake_timeout` | `initialize` did not complete within the bound (code 124) |
| `incompatible_protocol` | Agent negotiated an unsupported integer protocol version |
| `unauthenticated` | Agent requires an auth method the client cannot satisfy |

## Lifecycle / teardown

- The engine has no `AbortSignal` in the runtime contract; teardown enters via an
  unawaited synchronous `dispose()` plus the process-registry kill. The
  **registry SIGKILL is the authoritative no-orphan / no-deadlock guarantee**; a
  best-effort `session/cancel` + pending-permission drain runs first when timing
  allows but is opportunistic.

## Sources

- https://agentclientprotocol.com (introduction, schema, transports, initialization, tool-calls)
- `@agentclientprotocol/sdk` v0.24.0 — https://www.npmjs.com/package/@agentclientprotocol/sdk
- Validation: the SDK example echo agent (CI) + an in-repo controllable fixture
  (`src/__tests__/fixtures/echo-agent.mjs`); Gemini CLI / Claude-adapter for manual e2e.

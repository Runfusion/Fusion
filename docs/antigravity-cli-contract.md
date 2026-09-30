# Google Antigravity CLI contract

Date: 2026-09-20

## Ground truth and provenance

Fusion integrates an operator-installed Google Antigravity CLI. The executable discovered on the compatibility host is `agy` **1.2.7** on macOS. `agy --help` identifies it as the CLI that exposes the documented `mcp` and print-mode command surfaces; no separate `antigravity` executable was installed on that host.

External integration evidence:

- Canonical upstream / product: https://antigravity.google/
- Documentation: https://antigravity.google/product/antigravity-cli and https://antigravity.google/docs/getting-started
- Release / install: https://antigravity.google/download and https://antigravity.google/cli/install.sh
- Binary: `agy`
- Checksum: `upstream-pending-verification`. Fusion never downloads, installs, or hashes the operator’s binary.

Fusion supports `agy` versions whose bounded `--help` output contains the print-mode `--output-format stream-json` contract and the `mcp add`, `remove`, `enable`, `disable`, and `list` commands below. An unrecognised version is unavailable rather than guessed. The CLI owns login and credentials; Fusion does not read, copy, persist, or log them. Operators authenticate with the vendor-supported login flow before enabling the provider.

## Readiness checks and passive status polling

`GET /api/auth/status` retains an unauthenticated Antigravity provider row when `useAntigravityCli` is unset, false, or unreadable, but does not resolve the configured binary path or start `agy`. This keeps background settings, onboarding, and provider-status refreshes silent for an optional provider the operator has not enabled.

Operator-requested readiness actions remain on-demand checks: `GET /api/providers/antigravity-cli/status` probes the effective binary even while disabled, and `POST /api/auth/antigravity-cli` probes a requested path or an enable request before saving it. Once enabled, `GET /api/auth/status` also probes the stored effective path and reports the provider ready only when that binary is available.

## Verified non-ACP transport

`agy 1.2.7 --help` verifies this non-ACP print transport:

```text
agy --print --output-format stream-json --input-format stream-json [--model <model>]
```

`--input-format stream-json` consumes one NDJSON request per stdin line and requires `--output-format stream-json`. Fusion uses a supervised, shell-free child process, writes the prompt as an NDJSON request, and parses one JSON event per stdout line. It does **not** use ACP and does not claim resume support; a subsequent turn starts a new bounded prompt with the retained Fusion-side conversation context.

The deterministic compatibility fixture is the release gate for this protocol. It records sanitized event classes (not account data): `assistant.delta`, optional `thinking.delta`, `tool.call.start`, `tool.call.result`/`tool.call.error`, and terminal `result`/`error`. Unknown or malformed lines are ignored without ending an otherwise healthy stream. A clean terminal result completes the turn; an abnormal exit, terminal error, first-output timeout, or inactivity timeout retains already emitted text and reports bounded provider remediation. Streaming, MCP management, and binary probes use shell-free supervision with bounded output and a minimal launcher environment; cancellation closes stdin, aborts the supervised child, and waits for it to exit.

Model discovery is `agy models`; its output is treated as untrusted text. Discovery is bounded, returns no rows on malformed or unauthenticated output, and does not remove registry rows for other providers.

## Managed persistent MCP transaction

The earlier direct session-injection direction is superseded. `agy` does not provide ACP session configuration, so Fusion may temporarily manage **one uniquely namespaced entry in the operator’s normal Antigravity MCP configuration** through the documented CLI only:

```text
agy mcp list
agy mcp add [--type stdio|http] [--env KEY=value] [--header 'Key: Value'] <name> <commandOrUrl> [args...]
agy mcp enable <name>
agy mcp disable <name>
agy mcp remove <name>
```

The command grammar above was captured from `agy 1.2.7 mcp --help` and its subcommand help. Fusion never edits Antigravity configuration files directly. Each session receives a random entry name prefixed `fusion-custom-tools-`; it points to a loopback stdio schema server and receives an opaque per-session bridge token via its process environment. The token, raw configuration, command output, tool schema, and credentials are never written to task worktrees, repositories, logs, or run audit.

Before mutation, Fusion acquires a cross-process lock outside the repository/worktree and retains that lease for the entire live session. The journal records the exact queried baseline plus a non-secret ownership fingerprint of the staged command, arguments, and environment; it never records bridge credentials. A second session cannot recover, remove, or replace a journal owned by a live process. Fusion only adds its own unique entry and enables it. It never changes any other entry.

Every normal completion, cancellation, bridge-start failure, tool failure, process exit, and disposal restores while holding that session lease. Cleanup requires the current documented list response to exactly match the journaled ownership fingerprint before Fusion removes its entry. A journal left by interruption is reconciled only after its owner is proven stale. Missing/malformed snapshots, lock uncertainty, foreign edits, ownership mismatch, failed command, or failed restoration fail closed: tool publication is withheld, operator configuration is preserved, and the status surface tells the operator to inspect and remove the named `fusion-custom-tools-*` entry before retrying.

## Fusion MCP bridge boundary

Only engine-proven `fusionTools` that both start with `fn_` and provide an executable definition are published. The loopback bridge checks a capability token in constant time, accepts only local callers, bounds result/error text, and rejects forged or unapproved names. It never forwards arbitrary configured MCP servers.

## Fallback and diagnostics

`antigravity-cli` is an explicit primary runtime route. Missing/unsupported runtime or binary selection fails fast with remediation; a fallback-only Antigravity row is dropped with a warning so a healthy primary session is not silently replaced. Diagnostics use fixed reason codes and bounded display text; they never include raw stream events, configuration snapshots, credentials, or bridge capability material.

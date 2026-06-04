# @fusion-plugin-examples/acp-runtime

A Fusion runtime plugin that drives **any** external [Agent Client Protocol
(ACP)](https://agentclientprotocol.com) agent over JSON-RPC/stdio. One
integration unlocks every ACP-compatible agent (Gemini CLI, the Claude Code ACP
adapter, and any future agent that speaks the protocol) through the standard
protocol instead of a bespoke per-CLI integration.

Selected via `runtimeId: "acp"`. Installed on demand (`experimental`) — see the
Fusion plugin catalog (`fn plugin install fusion-plugin-acp-runtime`).

## Security posture

The ACP agent is an **untrusted subprocess** that calls back into Fusion for
permissions and filesystem access. This plugin enforces a defense-in-depth floor:

- **Per-category permission gating.** Each `session/request_permission` is
  classified by tool kind into a Fusion action category and checked against the
  live permission policy — never a preset shortcut. `allow_once` only (never a
  persisted blanket grant). Unmappable kinds and missing policy default-deny.
- **Unrestricted-risk acknowledgement (`acpAllowUnrestricted`).** Because the
  shipped default policy is `unrestricted` (allow-all), a blanket `allow` on a
  *sensitive* category is escalated to approval unless the user explicitly sets
  `acpAllowUnrestricted: true`. Prefer running the ACP runtime under an
  `approval-required` policy.
- **Filesystem jail.** `fs/read_text_file` / `fs/write_text_file` are opt-in
  (`acpFsRead` / `acpFsWrite`, writes default OFF), confined to the session
  `cwd` by a real symlink-resolving jail (realpath + `O_NOFOLLOW`), with a
  deny-list for secrets (`.env`, `*.pem`, …) and git internals (`.git/**`).
  Writes are gated through the `file_write_delete` permission category.
- **Untrusted-input bounds.** Streamed output is sanitized (ANSI/control strip)
  and bounded (per-turn + per-chunk caps; bounded tool-call correlation map).
- **Subprocess isolation.** The agent env is built from an allow-list
  (`acpEnvAllowList`) — inherited `process.env` is **not** forwarded.

Not sandboxed in v1: the agent's own process/network syscalls run with Fusion's
user privileges (OS-level sandboxing is recommended future work).

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `acpBinaryPath` | `acp-agent` | Agent binary to spawn |
| `acpArgs` | `[]` | Args that launch the agent in ACP/stdio mode (e.g. `["--acp"]`) |
| `acpModel` | — | Optional model identifier reported via `describeModel` |
| `acpFsRead` | `false` | Advertise/register `fs/read_text_file` |
| `acpFsWrite` | `false` | Advertise/register `fs/write_text_file` (gated) |
| `acpEnvAllowList` | `[]` | Env var names forwarded to the agent subprocess |
| `acpAllowUnrestricted` | `false` | Acknowledge the untrusted-agent risk under an allow-all policy |

## Upstream / third-party integration evidence

Per `AGENTS.md` (External-integration evidence):

- **Protocol homepage / docs:** https://agentclientprotocol.com
- **Upstream protocol repo:** https://github.com/agentclientprotocol/agent-client-protocol
- **TypeScript SDK repo:** https://github.com/agentclientprotocol/typescript-sdk
- **Dependency (npm):** `@agentclientprotocol/sdk` — https://www.npmjs.com/package/@agentclientprotocol/sdk
- **Pinned release:** `0.24.0` (Apache-2.0)
- **Tarball:** https://registry.npmjs.org/@agentclientprotocol/sdk/-/sdk-0.24.0.tgz
- **Integrity (sha512):** `sha512-vvu9appvGvfYstBj19C6NCepV6SvUhY5VRv60KUZ4XzhTah/olOYul5Zo4C+x2enyshMSvgB2mm/OEmrsHaSmA==`
- **Agent binaries driven:** user-supplied ACP agents (e.g. `gemini --acp`, the
  `@agentclientprotocol/claude-agent-acp` adapter). These are configured by the
  user at runtime, not bundled — `upstream-pending-verification` per agent.

See `docs/acp-contract.md` for the launch/readiness contract and failure taxonomy.

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
- **Agent binaries driven:** user-supplied ACP agents (e.g. `gemini --acp`) and the bundled Claude bridge below. User-configured agents remain `upstream-pending-verification` per agent.

### Bundled Claude ACP bridge evidence

- **Canonical upstream repo URL:** https://github.com/moabualruz/claude-code-cli-acp
- **Docs / homepage URL:** https://github.com/moabualruz/claude-code-cli-acp#readme
- **Release / download URL:** npm package `claude-code-cli-acp` (version `0.1.1`) — https://www.npmjs.com/package/claude-code-cli-acp
- **Binary / CLI name:** `claude-code-cli-acp`
- **Checksum:** `sha512-qpfRGOXkOs9mqI7oumsGistWisyXcCC0r7ng7wdLvGMIORdzHjmUUa+94Jftgr/NYAVnAUe6N7kimD8PaO3D5g==` (from `pnpm-lock.yaml` for `claude-code-cli-acp@0.1.1`)
- **Pinned-commit spot-review:** tag `v0.1.1` points to commit `c93f4f4ca449f451d9f3b7db536caf4060883da9` (annotated tag `ca33404fc1128d6a88a55b248f042f70b4bc9f9a`, unsigned). License: Apache-2.0. Behavior reviewed for this integration: runs `claude` through a PTY, reads transcript JSONL, exposes an ACP server over stdio, and requires `@anthropic-ai/claude-code` installed + authenticated.

See `docs/acp-contract.md` for the launch/readiness contract and failure taxonomy.

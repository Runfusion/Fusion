
<!--
FNXC:CursorCli 2026-08-15-21:17:
Cursor MCP support is enabled only after the CLI contract is observed: project config resolution,
tool-name prefix, MCP approval semantics, and negotiated protocol. Fusion stages its config only
for that verified session contract; it never assumes a fallback CLI flag or config location.
-->

## Cross-runtime fallback

When a non-Cursor primary model has a configured `cursor-cli` fallback, Fusion withholds that pair from the primary runtime and arms it only when the Cursor runtime plugin is registered. The first retryable model-selection failure creates one Cursor session, re-issues the failed prompt there, and routes all later prompts through that replacement; non-retryable failures and swap-time failures preserve the original primary error. Disposing the primary session also disposes the replacement.

Cursor has no cross-runtime resume token. On the first swapped prompt only, Fusion can prepend a clearly labeled, non-authoritative text-only transcript from the primary session: at most the last 10 turns, 2,000 characters per turn, and 12,000 characters total. Tool and thinking blocks are excluded; missing or malformed session state transfers nothing and leaves the prompt unchanged. If the Cursor runtime plugin is unavailable or cannot be looked up, Fusion keeps the primary runtime and drops the fallback with a warning instead of crashing.

A successful handoff emits `session:cross-runtime-fallback-engaged`. Its metadata is ids/outcomes-only (`sessionPurpose`, primary/fallback provider and model ids, trigger point, failure category, and whether context transferred); it never records error prose or transcript text.

## MCP staging and cleanup

Fusion creates a unique `fusion-custom-tools-<uuid>` server key per Cursor session. The `.cursor/.fusion-mcp-state.json` manifest retains the complete `{ command, args, env }` entry for every lease, allowing one process to recompose a peer process's live entry. Operator content is taken from current bytes; Fusion content is taken from that manifest.

Before staging in a git worktree, Fusion writes its marker block to `info/exclude`, then creates `.cursor/` and its lock directory. The marker covers `mcp.json`, the state record, and the lock so step-boundary `git add -A` cannot capture session files. The first stage persists the byte-exact baseline before it writes config bytes. Later changes journal the intended output before atomic config replacement, then promote the record, so a crash can resolve either the intended or previous byte sequence without mistaking Fusion output for an operator edit.

A tracked `.cursor/mcp.json` is refused. Byte-different operator edits are preserved rather than restored over. If an operator edit makes the file unparsable, Fusion quarantines the worktree: no process writes that config, the exclusion remains, and further staging is refused. Reconciliation clears the quarantine only after the config is deleted or has valid JSON with no `fusion-custom-tools-*` keys.

### Worktree safety protocol

The lease manifest records each `serverEntry` as `{ command, args, env? }`; entries are always recomposed from the durable manifest while non-Fusion content comes from the current on-disk JSON. A peer can therefore dispose without dropping another process's bridge. The first stage commits the raw baseline before its first config write. Every subsequent mutation writes `pending { kind, raw, seq }`, atomically replaces the config, then promotes the pending record. Recovery compares bytes against the pending result and last confirmed result: match pending promotes, match prior discards, and any other bytes latch an operator edit.

Bootstrap is deliberately outside the main lock because that lock lives in `.cursor/`: resolve git shape, serialize the `info/exclude` marker under the git-dir bootstrap lock, observe/create `.cursor/` with an `EEXIST`-safe ownership observation, then acquire the main lock. On final cleanup the inverse is used: the exclusion marker is the last in-lock removal, the main lock is released immediately, and only then may Fusion make one non-recursive `rmdir` attempt. A failed `rmdir` is a benign peer/operator race and is retried only by a later reconciliation.

Lock owners persist PID, hostname, and acquisition time. Contenders retry briefly and may reclaim only a dead same-host owner or an expired critical-section TTL. Leases heartbeat independently for long turns. The synchronous process-exit backstop makes one free-lock attempt only; it never bootstraps, takes over a stale lock, or writes when a peer owns the lock. Reconciliation is the crash-recovery owner.

When quarantine is held, `.fusion-mcp-state.json` remains as the durable record and the Fusion `info/exclude` block is intentionally retained so leftover bridge entries cannot be swept by `git add -A`. To recover, repair the JSON and remove every `fusion-custom-tools-*` entry, or delete the config; a later Cursor session clears the record and exclusion automatically. A merely parseable file that still has a Fusion key remains quarantined.

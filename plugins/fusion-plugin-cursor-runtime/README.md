# fusion-plugin-cursor-runtime

Cursor CLI-backed provider/runtime plugin for Fusion.

## Contract summary

- Provider ID: `cursor-cli`
- Binary probes: `cursor-agent`, then `cursor`
- Expected failure states: missing binary, missing Cursor IDE install, locked macOS keychain, unauthenticated runtime
- Model discovery: `cursor-agent models` (plain text `id - Label` output; no `--json` support) with header/tip/empty-state filtering, dedupe, and fallback metadata
- Auth status: `cursor-agent status --format json` (`isAuthenticated`), probed against the same candidate binary that succeeded `--version`

## Notes

Status/auth and model discovery behavior follows `docs/cursor-cli-contract.md`.

## External Integration Evidence

- Canonical upstream repository: Cursor CLI is closed-source and has no canonical upstream source repository. Its public issue tracker is https://github.com/cursor/cursor.
- Docs / homepage: https://cursor.com/docs/cli/overview
- Release / download: `curl https://cursor.com/install -fsS | bash` (macOS/Linux/WSL), or `irm 'https://cursor.com/install?win32=true' | iex` (Windows PowerShell).
- Binary: `cursor-agent`
- Checksum: `upstream-pending-verification`; Cursor publishes no versioned checksum manifest. Verified local provenance: `2026.08.11-e8db854` on 2026-08-15.

## Execution transport contract

Fusion runs one supervised `cursor-agent --print --output-format stream-json` turn per prompt. The prompt is supplied on stdin, the process `cwd` is the Fusion task worktree, and the init event confirmed that cwd is the Cursor workspace without a `--workspace` argument. Stream JSON emits init, thinking, assistant, tool_call, and terminal result events; session IDs are retained with `--resume` on the next turn.

| Fusion tool mode | Cursor flags |
| --- | --- |
| `coding` | `--force --trust` |
| `readonly` or unset | `--mode plan --trust` |

`--print` already grants built-in write and shell tools. `--force` controls approval, so it is limited to coding sessions whose cwd is Fusion's isolated task worktree. Fusion does not use `--auto-review`, worktree, add-dir, plugin-dir, or sandbox override flags.

## Fusion MCP bridge

When a session has Fusion `fn_*` custom tools, Fusion starts a token-protected loopback bridge and stages a per-session stdio entry in the task worktree's `.cursor/mcp.json`. Cursor receives `--approve-mcps` only after that lease is staged. The stdio child receives `FUSION_CURSOR_TOOL_BRIDGE_URL` and `FUSION_CURSOR_TOOL_BRIDGE_TOKEN`; `mcp-schema-server.cjs` must be copied into the built package.

Fusion records the original config before its first write, persists live server entries in `.cursor/.fusion-mcp-state.json`, and removes its entry on disposal. The config is excluded from git while a lease is live. A git-tracked `.cursor/mcp.json` disables the bridge rather than risking a step-boundary commit. If an operator makes the config unparsable during a session, Fusion quarantines that worktree and leaves the config and exclusion untouched; repair the JSON and remove `fusion-custom-tools-*` entries (or delete the config), then the next Cursor session reconciles it.

<!-- FNXC:CursorMcpBridge 2026-08-15-21:17: The exclusion is installed before `.cursor/` exists because the nested lock has an owner file that `git add -A` could otherwise commit. Cleanup removes that exclusion only after the final lease's lock-protected compose. -->

### Worktree hygiene and recovery

Fusion may briefly create a git-dir `fusion-cursor-exclude.lock` during bootstrap, then `.cursor/.fusion-mcp.lock` while a session composes the config. Both are excluded before they exist. The state record can contain a `pending` journal after a crash; the next Cursor session resolves it from exact config bytes. A hard-killed lease is reaped by its heartbeat TTL, not by assuming an exit hook ran. A final empty `.cursor/` directory is removed with a single non-recursive attempt after its nested lock is released; a peer race leaves it for the next reconciliation.

### Quarantined configuration

A lane reports `bridge-start-failed` when `.cursor/.fusion-mcp-state.json` contains a `quarantine` record. Fusion deliberately refuses to rewrite that config and keeps its `info/exclude` marker, because the malformed file can still contain `fusion-custom-tools-*` entries that must not enter git. Do not delete the state file by hand. Instead repair `mcp.json` and remove every Fusion entry, or delete `mcp.json`; the next Cursor session clears quarantine and removes the marker automatically.

All turns use `superviseSpawn` with a finite lifetime. The Windows prompt transport prefers a direct executable; `.cmd`/`.bat` shims validate and reject cmd metacharacters before a quoted cmd launch, `.ps1` uses PowerShell `-File`, and unknown extensions fail loudly. `PI_CURSOR_CLI_FIRST_LINE_TIMEOUT_MS` and `PI_CURSOR_CLI_TIMEOUT_MS` optionally tune cold-start and inactivity guards.

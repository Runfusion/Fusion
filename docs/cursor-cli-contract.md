# Cursor CLI Contract (FN-3396 Step 0)

Date: 2026-05-07

<!--
FNXC:CursorCli 2026-07-08-00:00:
The original FN-3396 preflight assumed model discovery via JSON-flagged subcommand variants with a plain-text fallback, and stated no auth-status command was confirmed. FN-7697 captured and shipped the real `cursor-agent` CLI contract: model discovery is `cursor-agent models` (plain text `id - Label` lines, no JSON flag) and authentication is derived from `cursor-agent status --format json` (`isAuthenticated`). This doc was corrected on 2026-07-08 to match the verified contract; see FN-7697 for the implementation.
-->

**Update history:** 2026-07-08 — corrected the model-discovery and auth-status contract from FN-3396's assumed `--json` commands to the verified `cursor-agent models` / `cursor-agent status --format json` contract captured and implemented in FN-7697.

## Research method

- Local runtime inspection in the task environment (`which`, direct command execution).
- Local binary wrapper inspection (`cursor`, `cursor-agent` launch scripts and install layout).
- Bounded `fn_research_run` was attempted but failed in this environment with: `table research_runs has no column named projectId`.

## Confirmed invocation and binary detection

- **Primary executable aliases found on PATH:**
  - `cursor`
  - `cursor-agent`
- **Not found on PATH:**
  - `cursor-cli`
- `cursor` is a wrapper that can delegate to agent mode and emits a targeted message when IDE install is missing.
- `cursor-agent` is the direct CLI runtime entrypoint and is symlinked to a versioned install under:
  - `~/.local/share/cursor-agent/versions/<version>/cursor-agent`

### Detection strategy

1. If the global `cursorCliBinaryPath` setting is a non-empty string, probe that configured binary first.
2. Probe `cursor-agent` from PATH.
3. Probe `cursor` from PATH.
4. Deduplicate candidates when the configured value is exactly `cursor-agent` or `cursor`.
5. Persist the resolved path and executable name in probe results.
6. Report explicit failure reason when neither exists.

### Manual binary path override

<!--
FNXC:CursorCli 2026-07-02-00:00:
Operators can set a global Cursor CLI binary path when PATH discovery resolves the wrong shim. The override is optional and must never remove the cursor-agent/cursor fallback probes.
-->

Settings → Authentication → Cursor CLI exposes an optional binary path field. Leave it blank to use PATH auto-detection. When populated, Fusion validates the configured path by running the same `--version` probe used for status/enable, saves it only if that configured candidate itself succeeds, and then uses it for status, enable validation, and Cursor model discovery before falling back to PATH candidates.

If the configured path fails during ordinary status/model-discovery probes but a PATH candidate succeeds, Fusion remains usable and reports the PATH candidate as the effective `binaryPath`; bounded diagnostics include the configured-path failure. If saving a new non-empty override fails or only succeeds via PATH fallback, the Settings save returns a 400 diagnostic and does not persist the path.

Windows paths with spaces, for example `C:\Users\A User\AppData\Roaming\npm\cursor-agent.cmd`, are treated as one operator-provided string. Users should not quote or split the path in the UI.

### Windows PATH shim invocation

<!--
FNXC:CursorCli 2026-07-02-00:00:
Windows Cursor installs may publish `cursor-agent.cmd`, `cursor.cmd`, or equivalent `.bat` shims on PATH; Fusion must invoke Cursor probe and discovery commands through the Windows shell so Node can execute those wrappers.
Unix and macOS stay direct-spawned to avoid broadening shell semantics beyond the platform that requires it.
-->

On Windows, `cursor-agent`, `cursor`, and manual override paths can resolve to `.cmd` / `.bat` wrappers rather than native executables. Node.js direct `spawn(binary, args)` does not execute those wrappers reliably; Fusion's Cursor command runner therefore sets shell execution only when `process.platform === "win32"`.

The Windows shell-backed path applies to every Cursor CLI command Fusion currently runs through the shared runner:

- Configured binary / `cursor-agent --version` / `cursor --version` probe attempts.
- Auth-status probe against the effective probe-selected binary: `cursor-agent status --format json`.
- Model discovery against the effective probe-selected binary: `cursor-agent models` (plain text, no `--json` flag).

Non-Windows probes and discovery continue to use direct spawn. Spawn errors such as `ENOENT` or `EACCES` are included in the unavailable probe reason in bounded diagnostic form so a working terminal command is distinguishable from known Cursor runtime/auth states; Fusion does not dump PATH, environment variables, or unbounded stdout/stderr.

## Confirmed error/auth/runtime signals

Observed command behavior in this environment:

- `cursor --help` (without IDE install):
  - `Error: No Cursor IDE installation found. Use 'cursor agent' or 'agent' to run the agent.`
- `cursor-agent --help` and `cursor agent --help` (with locked keychain):
  - `Error: Your macOS login keychain is locked.`
  - `Run security unlock-keychain and try again.`

### Auth/readiness implications

- Keychain-locked is a distinct, expected failure mode and must be surfaced as an auth/runtime-blocked state (not as unknown crash).
- Missing IDE install is a distinct expected failure mode from missing binary.

## Structured output and model discovery

- **Confirmed:** `cursor-agent models` is the model-list command. Output is plain text — passing an unsupported JSON output flag (e.g. appending `--json` to the `models` subcommand) fails with `error: unknown option '--json'`.
- Output shape: an `Available models` header line, a blank line, then one model per line formatted as `<id> - <Label>` (e.g. `auto - Auto (default)`, `claude-4.5-sonnet - Sonnet 4.5`), followed by a trailing tip line: `Tip: use --model <id> (or /model <id> in interactive mode) to switch.`.
- Empty-account state: `No models available for this account.` (no model lines follow).
- `cursor-agent --list-models` exists but is unreliable — it can report "No models available for this account." even while the CLI is authenticated with models available. Prefer `cursor-agent models`.

### Model discovery parsing strategy (implemented)

1. Run `cursor-agent models` (or the effective probe-selected binary) with a short timeout.
2. Split stdout into lines; extract the bare model id as the segment before the first ` - ` on each line.
3. Filter out the `Available models` header, the trailing `Tip:` line, the `No models available for this account.` empty-state line, and blank lines.
4. Normalize and dedupe the remaining ids into the discovered model set.
5. If the command is unavailable or fails, return an empty discovered set with a machine-readable reason; host surfaces Cursor models only when provider readiness + discovery usability conditions are met.

### Authentication / status

- **Confirmed:** authentication state is derived from `cursor-agent status --format json` (alias `whoami`), which returns a JSON object with `isAuthenticated` (boolean), plus `status`, `hasAccessToken`, and `userInfo`.
- Use `isAuthenticated` as the auth signal instead of treating a successful `--version` probe as a proxy for readiness. `--version` remains the availability/version probe (bare version string), separate from auth.
- Keychain-locked and missing-IDE-install remain distinct expected failure modes on top of this (see "Confirmed error/auth/runtime signals" above) — a locked keychain or missing IDE surfaces as its own runtime-blocked state rather than folding into `isAuthenticated: false`.

## Provider ID decision

- Use **`cursor-cli`** as the provider ID.
- Rationale: aligns with task requirement; no conflicting provider ID observed in current codebase scan.

## Contract freeze for FN-3396 (superseded by the verified contract below)

The original FN-3396 preflight treated the following as canonical pending stronger evidence:

- Binary candidates: `cursor-agent`, `cursor`.
- Expected failure states include: missing binary, missing IDE installation, keychain locked, unauthenticated/not-ready CLI.
- Model discovery must be dynamic-first with resilient fallback and no hardcoded static catalog by default.

Binary candidates and expected failure states above remain accurate. The dynamic-first/no-static-catalog principle also still holds, but the specific commands are now confirmed rather than assumed — see "Structured output and model discovery" and "Windows PATH shim invocation" above for the verified `cursor-agent models` / `cursor-agent status --format json` contract that replaces the earlier `--json`-flag guesswork.

# CLI Reference

[← Docs index](./README.md)

Fusion’s command-line interface is exposed through the `fn` command.

## Global Usage

```bash
fn <command> <subcommand> [options]
```

### Global options

| Option | Description |
|---|---|
| `--project <name>`, `-P <name>` | Target a specific registered project. |
| `--help`, `-h` | Show help output. |

### Project resolution order

When `--project` is not supplied, Fusion resolves project context in this order:

1. Explicit `--project` flag
2. Default project (set via `fn project set-default <name>`)
3. Current-directory auto-detection (`.fusion/fusion.db` lookup upward)

---

## `fn init`

Initialize a new Fusion project in the current directory.

```bash
fn init
fn init --name my-project --path /absolute/path/to/project
```

When the target directory is not already a Git repository, Fusion initializes
minimal Git metadata during registration so task worktrees can be created. Use
`fn init --git` only when you also want Fusion to create the explicit starter
commit used by that flag.

During fresh initialization, Fusion also installs the bundled `fusion` skill into supported local agent homes when the target skill does not already exist:

- `~/.claude/skills/fusion`
- `~/.codex/skills/fusion`
- `~/.gemini/skills/fusion`

`fn init` is non-destructive for these installs:
- Existing `fusion` skill directories are preserved (not overwritten).
- Per-target filesystem/permission failures are reported as warnings and do not fail project initialization.

---

## `fn onboard`

Run the interactive CLI onboarding wizard. It walks through central DB setup,
API-key provider setup, optional first-project init, core settings defaults, and
a short next-steps tour. Each step can be individually skipped while staying in
the onboarding flow.

```bash
fn onboard
fn onboard --force
fn --skip-onboarding dashboard
FUSION_SKIP_ONBOARDING=1 fn dashboard
```

| Option | Description |
|---|---|
| `--force` | Re-run onboarding even when `cliOnboardingCompletedAt` is already set. |
| `--skip-onboarding` | Global escape hatch that bypasses onboarding auto-launch for this invocation. |
| `FUSION_SKIP_ONBOARDING` | Environment-variable escape hatch (`1`, `true`, `yes`, or `on`) that bypasses onboarding auto-launch. |

On successful completion, Fusion records `cliOnboardingCompletedAt` in global
settings.

Auto-launch behavior: before interactive commands, Fusion auto-launches onboarding
only when the central DB at `getDefaultCentralDbPath()` is missing and CLI
onboarding has not already completed. Auto-launch is skipped for `serve`,
`daemon`, non-TTY runs, `--skip-onboarding`, `FUSION_SKIP_ONBOARDING`, and once
`cliOnboardingCompletedAt` is set.

Backward-compatibility guard: existing setups are never blocked — when central DB
already exists (including the central-DB + registered-project case), or when the
CLI onboarding completion marker exists even if the central DB step was skipped,
onboarding does not auto-launch.

---

## `fn update`

Check for and install the latest `@runfusion/fusion` CLI release from npm.

```bash
fn update
fn update --check
fn update --global
fn update --json
fn upgrade
```

| Option | Description |
|---|---|
| `--check` | Check only. Does not install. Exit code `1` when an update is available. |
| `--global` | Explicitly install globally (`npm install -g @runfusion/fusion@latest`). This is the default behavior. |
| `--json` | Output machine-readable status: `currentVersion`, `latestVersion`, `updateAvailable`, `updated`. |

`fn upgrade` is an alias for `fn update`.

---

## `fn research`

Manage persisted research runs from the CLI.

```bash
fn research create --query "Compare sqlite WAL vs rollback journal"
fn research create --query "Rust async runtime trade-offs" --wait --max-wait-ms 120000
fn research list --status failed --limit 20
fn research show RR-001
fn research export RR-001 --format json --output ./artifacts/research-RR-001.json
fn research cancel RR-001
fn research retry RR-001 --json
```

| Subcommand | Description |
|---|---|
| `fn research create --query <text> [--wait] [--max-wait-ms <ms>] [--json]` | Create a run and optionally wait for completion. |
| `fn research list \| ls [--status <status>] [--limit <n>] [--json]` | List recent runs (statuses: `queued`, `running`, `cancelling`, `retry_waiting`, `completed`, `failed`, `cancelled`, `timed_out`, `retry_exhausted`). |
| `fn research show <run-id> [--json]` | Show one run with timestamps, summary, and error details. |
| `fn research export <run-id> [--format <json\|markdown\|pdf>] [--output <path>] [--json]` | Export run results and persist an export record. |
| `fn research cancel <run-id> [--json]` | Request cancellation for an active run. |
| `fn research retry <run-id> [--json]` | Create a new retry run from a `failed`/`timed_out` run when lifecycle marks it retryable. |

### Research error behavior (`fn research`)

`fn research` returns structured failures with machine-readable codes. The extension/tool-side equivalents are lowercase aliases in payload metadata (`feature-disabled`, `missing-credentials`, `provider-unavailable`, `invalid-transition`, `retry-exhausted`, `non-retryable-provider-error`).

- Feature disabled → `FEATURE_DISABLED` / `feature-disabled`
- Missing credentials → `MISSING_CREDENTIALS` / `missing-credentials`
- Provider unavailable/cooldown → `PROVIDER_UNAVAILABLE` / `provider-unavailable`
- Invalid cancel/retry transition → `INVALID_TRANSITION` / `invalid-transition`
- Retry budget exhausted → `RETRY_EXHAUSTED` / `retry-exhausted`
- Non-retryable provider failure → `NON_RETRYABLE_PROVIDER_ERROR` / `non-retryable-provider-error`

Examples:

```bash
# Feature disabled / setup guard
fn research create --query "compare x y" --json

# Missing credentials / provider unavailable
fn research create --query "latest node lts" --json

# Invalid transition (run already terminal)
fn research cancel RR-001 --json

# Retry exhausted / non-retryable provider error
fn research retry RR-001 --json
```

---

## `fn experiment finalize`

Group kept experiment-session commits into reviewable branches that share a merge-base with your integration branch. This command consumes a finalized experiment session produced by the experiment executor and can either preview the finalize plan or create branches.

```bash
fn experiment finalize ES-001
fn experiment finalize ES-001 --dry-run
fn experiment finalize ES-001 --dry-run --json
fn experiment finalize ES-001 --summary "Finalize experiment branches for review"
fn experiment finalize ES-001 --plan-file ./plan-override.json
```

| Option | Description |
|---|---|
| `<sessionId>` | Required positional session ID to finalize. |
| `--integration-branch <name>` | Integration branch used for merge-base calculation (default: `main`). |
| `--dry-run` | Preview the finalize plan without creating branches. |
| `--json` | Emit machine-readable output (`{ plan }` for dry-run, `{ result }` for finalize). |
| `--summary <text>` | Optional finalize summary stored with the session result. |
| `--plan-file <path>` | JSON file containing a plan override payload. |

| Exit code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Generic error. |
| `2` | `state_error`. |
| `3` | `no_kept_runs`. |
| `4` | `plan_error`. |
| `5` | `merge_base_error`. |
| `6` | `cherry_pick_conflict` (also prints `{ groupId, commit, stderr }` JSON to stderr). |
| `7` | `branch_exists`. |

For plan-override schema, finalize algorithm details, and the full error taxonomy (including HTTP-status and CLI-exit mappings), see [`docs/research/experiment-finalize.md`](./research/experiment-finalize.md).

---

## `fn dashboard`

Start the web dashboard (default port `4040`, bound to `127.0.0.1`).

```bash
fn dashboard
fn dashboard --port 5050
fn dashboard --host 0.0.0.0                # expose on LAN (use with care)
fn dashboard --token fn_yourStaticToken    # reuse a fixed token
fn dashboard --no-auth                     # disable bearer auth (local only)
fn dashboard --interactive
fn dashboard --paused
fn dashboard --dev                       # development-mode dashboard + engine
fn dashboard --no-engine                 # dashboard/API only
fn dashboard --lang zh-TW                   # force a UI locale for this run
```

The terminal UI is localized. `--lang <code>` (one of `en`, `zh-CN`, `zh-TW`,
`fr`, `es`, `ko`) takes precedence over the saved dashboard language setting and the
`LC_ALL`/`LC_MESSAGES`/`LANG`/`LANGUAGE` environment. See
[Localization contributor guide](./i18n-contributing.md).

| Option | Description |
|---|---|
| `--port`, `-p` | Dashboard HTTP port (default `4040`). |
| `--host` | Host to bind (default `127.0.0.1`, localhost only). Pass `0.0.0.0` to expose on all interfaces. |
| `--token <token>` | Bearer token to use. Default: `$FUSION_DASHBOARD_TOKEN` → `$FUSION_DAEMON_TOKEN` → auto-generated. |
| `--no-auth` | Disable bearer-token auth. Not recommended when binding to `0.0.0.0`. |
| `--paused` | Start with the engine paused (automation disabled). |
| `--interactive` | Interactive port selection. |
| `--dev` | Start dashboard in development mode. The AI engine still starts unless `--no-engine` is also passed. |
| `--no-engine` | Start dashboard/API only with no AI engine, planning, or scheduler runtime. |

### Interactive Terminal UI (TTY Mode)

When running in an interactive terminal (TTY), `fn dashboard` starts an
interactive TUI with sectioned views for system status, logs, settings, and
remote-access controls.

Remote controls are available inside **Interactive → Settings** in the detail pane.
Remote actions support:
- Switching active provider (`tailscale` / `cloudflare`) and explicit activation
- Manual tunnel lifecycle (`start` / `stop`)
- Persistent token regeneration (masked token display)
- Short-lived token generation with TTL input and expiry display
- URL + QR hand-off (always shows full authenticated URL)

> ⚠️ Remote URL/QR payloads include tokenized query data. Treat them like credentials and avoid sharing them in screenshots/chat/logs. Prefer short-lived links for ad-hoc phone login.

Remote action keys in Settings detail pane:
- `C` activate selected provider
- `V` start tunnel
- `X` stop tunnel
- `P` regenerate persistent token
- `L` enter TTL input mode and generate short-lived token
- `U` generate authenticated URL hand-off
- `K` request QR payload hand-off
- `R` refresh remote status/snapshot

Engine/runtime remote tunnel semantics used by dashboard + serve + TUI:
- Lifecycle states: `stopped → starting → running → stopping` (or terminal `failed`)
- Start/stop is process-supervised (`spawn`, `SIGTERM`, 5s default timeout, then `SIGKILL`)
- Provider switch is stop-first: the current provider is fully stopped before target startup is attempted
- Failed switch/start emits explicit failure status (`switch_failed` / `invalid_config` / `start_failed`) and never runs both providers concurrently
- Status/log subscribers receive redacted events (token-bearing args/env/log text masked)

QR hand-off behavior in TUI:
- `format="text"`: renders the text payload directly
- `format="image/svg"`: does not render raw SVG in terminal; shows the authenticated URL, expiry metadata, and a fallback instruction to open the URL on phone/browser

On startup, the TUI opens on the **System** section by default so you can
immediately see host/port and access-token details.

Mouse reporting auto-toggles with focus on the main screen: selecting
**Logs** enables wheel scrolling, while selecting **System** turns mouse
reporting back off so native click-drag text selection works.

**Keyboard Navigation:**

| Key | Action |
|---|---|
| `1-5` | Switch to tab by number |
| `n` or `→` | Next tab |
| `p` or `←` | Previous tab |
| `r` | Refresh stats (in Utilities tab) |
| `c` | Clear logs (in Utilities tab) |
| `t` | Toggle engine pause (in Utilities tab) |
| `?` or `h` | Toggle help overlay |
| `q` | Quit |
| `Ctrl+C` | Force quit |

**Logs Tab Navigation:**

| Key | Action |
|---|---|
| `↑` or `k` | Move selection to older log entry |
| `↓` or `j` | Move selection to newer log entry |
| `Home` | Jump to first log entry |
| `End` | Jump to last log entry |
| `Enter`, `Space`, or `e` | Toggle expanded view for selected entry |
| `Esc` | Close expanded view |
| `w` | Toggle wrap mode (long messages wrap vs. truncate) |
| `f` | Cycle severity filter (`all → info → warn → error → all`) |

The Logs list uses a scrollable viewport across the full in-memory ring buffer.
As long as an entry is still inside the buffer, you can reach it with
`↑`/`↓` (or `k`/`j`) and jump to absolute bounds with `Home`/`End`.

Severity filtering is a view-only control for the current Logs pane. Cycling with
`f` narrows the rendered list to the selected level (`info`, `warn`, or `error`),
but all entries remain in the ring buffer and are shown again when you return to
`all`.

In wrapped mode, long log messages are displayed with word wrapping. Long
unbroken tokens (such as URLs or stack traces) are hard-wrapped at the
available width. In expanded view, the full message is shown with complete
wrapping for inspection.

During interactive TTY mode, streamed runtime text (including merge-session
agent output) is routed into the Logs tab as stable line entries instead of
being written directly into the alternate-screen terminal surface.

In non-TTY mode (CI, piped output, scripts), the dashboard falls back to
plain console output to maintain compatibility with automated workflows.

### Authentication

Unless `--no-auth` is passed, the dashboard API (including the terminal
WebSocket) is protected by a bearer token. On first authenticated startup,
Fusion resolves a token via the daemon-token manager and persists it in the
existing global settings file (`~/.fusion/settings.json`, owner-only when
supported). Later dashboard startups reuse the same stored token unless you
explicitly override it.

On startup, Fusion prints both the resolved token and a click-to-open URL that
embeds `?token=<token>`:

```
fn dashboard
────────────────────────
→ http://localhost:4040
Auth:    bearer token required
Token:   fn_8f3a...
Open:    http://localhost:4040/?token=fn_8f3a...
         (the browser stores the token so you only need to click once)
```

On first visit the dashboard captures the token from the URL into
`localStorage` (key `fn.authToken`) and strips it from the visible URL so the
secret does not end up in browser history. Subsequent loads (including
closing and reopening the tab) reuse the stored token.

Precedence when resolving the token:

1. `--no-auth` (disables auth middleware entirely)
2. `--token <token>` flag
3. `FUSION_DASHBOARD_TOKEN` environment variable
4. `FUSION_DAEMON_TOKEN` environment variable (back-compat with `fn daemon`)
5. Stored token in `~/.fusion/settings.json`
6. New generated token persisted to `~/.fusion/settings.json` (first authenticated run)

To override defaults without changing stored settings, export one of the env vars:

```bash
export FUSION_DASHBOARD_TOKEN=fn_my_override_token
fn dashboard
```

To revoke/reset access, choose the behavior you want:
- **Temporary override:** set `--token` / env var for the current run.
- **Persistent reset:** clear `daemonToken` from `~/.fusion/settings.json` (or rotate it via `fn daemon --token-only`/token rotation workflow), then restart dashboard.
- **Client logout:** clear `fn.authToken` in browser localStorage so clients must re-authenticate with the current server token.

### Optional provider: Factory AI via Droid CLI

When the published CLI bundle includes the vendored `@fusion/droid-cli` extension, users can enable **Factory AI — via Droid CLI** in **Settings → Authentication**.

Requirements:
- a working Droid CLI binary (`droid` on `PATH` by default, or a custom plugin `droidBinaryPath`)
- successful local login (`droid auth login`)
- Fusion restart after toggling the provider on (to reload extensions)

Authentication status checks in **Settings → Authentication** use the same effective Droid binary path as the Droid runtime plugin, so custom binary-path installs are detected correctly.

---

## `fn serve`

Start Fusion as a headless node (API server + AI engine, no frontend UI).

```bash
fn serve [--port <port>] [--host <host>] [--paused] [--daemon]
fn serve --interactive
```

| Option | Description |
|---|---|
| `--port`, `-p` | Port for the API server (default `4040`). |
| `--host` | Host to bind (default `127.0.0.1`, localhost only). Pass `0.0.0.0` to expose on all interfaces. |
| `--paused` | Start with engine paused (automation disabled). |
| `--interactive` | Interactive port selection. |
| `--daemon` | Enable bearer token authentication for CLI client connections. |

`fn serve` uses the same project-scoped Remote Access manager as `fn dashboard`.
When remote access is enabled/configured, the headless server exposes `/api/remote/*`
control/status endpoints and applies the same hybrid token validation rules for
remote routes (persistent token + optional short-lived token registry).

Headless operators should use the same lifecycle/API flow as dashboard mode:

- `POST /api/remote/provider/activate`
- `POST /api/remote/tunnel/start`
- `POST /api/remote/tunnel/stop`
- `GET /api/remote/status`
- `POST /api/remote-access/auth/login-url`

`GET /remote-login?rt=<token>` is intentionally public for phone-link handoff,
but token validity is still enforced server-side.

For end-to-end setup, risk guidance, and troubleshooting, see
**[docs/remote-access.md](./remote-access.md)**.

For programmatic consumers, these endpoints map to the engine tunnel manager contract:
- `getStatus()` for current snapshot
- `start(provider, config)` / `stop()` / `switchProvider(...)`
- subscription hooks for live status and log updates (used by stream/poll clients)

---

## `fn daemon`

Start Fusion daemon (API server + AI engine, always requires bearer token authentication).

```bash
fn daemon [--port <port>] [--host <host>] [--token <token>] [--paused] [--interactive] [--token-only]
```

| Option | Description |
|---|---|
| `--port`, `-p` | Port for the daemon server (default: auto-assigned). |
| `--host` | Host to bind (default `127.0.0.1`, localhost only). Pass `0.0.0.0` to expose on all interfaces. |
| `--token` | Set a specific daemon token. If not provided, a random token is generated and printed. |
| `--paused` | Start with engine paused (automation disabled). |
| `--token-only` | Only generate/show the token without starting the server. |
| `--interactive` | Interactive port selection. |

---

## `fn desktop`

<!--
FNXC:DesktopCLI 2026-06-21-12:00:
`fn desktop` now starts the same local AI engine lifecycle as CLI dashboard mode by default.
Document `--paused` as automation-paused startup and explicitly note that desktop does not expose a `--no-engine` mode so users do not infer dashboard-only flags exist here.
-->

Launch the Fusion desktop app (Electron) with a local AI engine running by default, mirroring `fn dashboard` engine-on startup.

```bash
fn desktop
fn desktop --dev
fn desktop --paused
fn desktop --interactive
```

| Option | Description |
|---|---|
| `--dev` | Launch with hot-reload (connects to Vite dev server). |
| `--paused` | Launch with the AI engine paused (automation disabled). |
| `--interactive` | Interactive port selection. |

`fn desktop` does not support `--no-engine`. Unlike `fn dashboard`, which can run in dashboard/API-only mode, desktop always starts the local AI engine; use `--paused` when you want the engine process running without automation doing work.

---

## `fn task`

Task lifecycle and task operations.

### Creation and planning

```bash
fn task create "Fix login race condition"
fn task create "Fix bug" --attach screenshot.png --depends FN-010
fn task create "Investigate flaky runner" --node edge-runner
fn task plan "Design a new authentication flow"
```

For AI-guided task specification, see [Planning mode](#planning-mode).

### Planning mode

Use planning mode to turn a rough idea into a triage task through an interactive AI-guided Q&A flow.

When supported by your configured runtime/model provider, planning sessions can also use builtin `WebSearch` and `WebFetch` tools for live context gathering.

Planning sessions also have read-only board tools: `fn_task_list` (list active backlog tasks) and `fn_task_get` (read full task details, including PROMPT.md) so interviews can avoid duplicate in-flight plans and anchor questions to existing work. `fn_task_list` output is bounded and falls back to a defensive formatter if the runtime task-list clamp helper is unavailable, so board reads return text instead of failing during ambient planning or heartbeat checks. `fn_task_list` also accepts `includeDeleted: true` to surface soft-deleted blockers when diagnosing stalled dependency chains, and `fn_task_show` now auto-falls back to include soft-deleted tasks with a `[SOFT-DELETED at ...]` marker.

```bash
fn task plan [description]
```

`description` is optional. If you omit it, the CLI prompts for an initial idea (`Describe your idea:`) before creating the planning session.

Planning questions are interactive and use these types:
- `text` (multi-line; finish with `DONE` on its own line)
- `single_select` (pick one option)
- `multi_select` (pick one or more comma-separated options)
- `confirm` (`[Y/n]`, Enter defaults to yes)

Planning flow:
1. Create planning session from your description/idea.
2. Answer the current question.
3. Receive either a follow-up question or completion summary.
4. Review summary (title, description, suggested size, dependencies, key deliverables).
5. Confirm creation (or skip confirmation with `--yes`).
6. Task is created in `triage` when confirmed.

- With `--yes`, final confirmation is skipped and the task is created immediately.
- Without `--yes`, the CLI asks `Create this task? [Y/n]:`; answering no cancels creation.

| Option | Description |
|---|---|
| `--yes` | Skip final confirmation before creating the planned task. |
| `--project <name>`, `-P <name>` | Run planning mode against a specific registered project. |

Planning session limit: maximum **1000 planning sessions per hour**.

### Query and logs

```bash
fn task list
fn task show FN-001
fn task logs FN-001 --follow --limit 50 --type tool
```

`fn task logs` now exposes full agent-log content for each entry type. In particular, `thinking`, `tool_result`, and `tool_error` entries preserve full multiline output (including stderr/stack details) so you can inspect raw tool responses directly from the CLI stream.

`fn task show <id>` includes routing and provenance context when available:
- task node override
- project default node fallback
- unavailable-node policy value
- source provenance line (`Source: <origin>`), including parent task / GitHub issue URL context when present

### Execution and status

```bash
fn task move FN-001 in-progress
fn task update FN-001 2 done
fn task log FN-001 "Updated API contract"
fn task retry FN-001
fn task pause FN-001
fn task unpause FN-001
```

### Node routing controls

```bash
fn task set-node FN-001 edge-runner
fn task clear-node FN-001
```

Notes:
- `set-node` resolves either node name or node ID.
- `set-node` and `clear-node` are blocked while the task is in progress.
- Use `fn node list` / `fn node show <name>` to discover node IDs and status.

### Collaboration and guidance

```bash
fn task comment FN-001 "Needs stricter validation"
fn task comment FN-001 "Reviewed with QA" --author "alex"
fn task comments FN-001
fn task steer FN-001 "Reuse existing auth middleware"
```

### Completion, maintenance, and history

```bash
fn task attach FN-001 ./trace.log
fn task merge FN-001
fn task duplicate FN-001
fn task refine FN-001 --feedback "Add rollback handling"
fn task archive FN-001
fn task unarchive FN-001
fn task delete FN-001 --force
```

Notes:
- `fn task archive` accepts any live-board task (`triage`, `todo`, `in-progress`, `in-review`, or `done`) and preserves the original column for restore.
- `fn task unarchive` restores to the saved pre-archive column when available, with legacy archives falling back to `done`.

### Branch conflict handling

When executor branch allocation fails because `fusion/<task-id>` is already checked out, Fusion marks the task failed/investigable and logs conflict details (existing worktree path, tip SHA, stranded commits). Operators should inspect and resolve conflicting local branches/worktrees with standard git tooling, then retry the task.

### GitHub integration

Create a pull request for a task with `fn pr create <task-id>`.

Alias: `fn task pr-create <task-id>`

Maintenance: `fn pr automerge-cleanup` performs a dry run of legacy auto-merge stamps left by older `in-review` task behavior and prints affected task IDs/columns. Add `--apply` to clear those stamps after reviewing the list, and `--json` for machine-readable output.

Flags:
- `--title <title>`: Set the PR title.
- `--base <branch>`: Target base branch (default from repo/CLI settings).
- `--body <body>`: Set the PR body.
- `--draft`: Create the PR as a draft.
- `--no-ai`: Disable AI-generated PR title/body fallback.
- `--reviewer <login>`: Request a reviewer by GitHub login (repeatable for multiple reviewers).

Default behavior: PR title/body are AI-generated unless both `--title` and `--body` are provided. Use `--no-ai` to suppress AI generation.

```bash
fn pr create FN-001
fn pr create FN-001 --draft --reviewer octocat --reviewer hubot --base main
fn task pr-create FN-001 --title "Fix login race" --body "Prevents duplicate session refresh." --base main
fn pr automerge-cleanup --json
fn pr automerge-cleanup --apply
fn task import owner/repo --labels bug --limit 10
fn task import owner/repo --interactive
```

---

## `fn project`

Manage registered projects in multi-project mode.

```bash
fn project list --json
fn project add my-app /path/to/app --isolation child-process
fn project show my-app
fn project info my-app
fn project set-default my-app
fn project detect
fn project remove my-app --force
```

Subcommands: `list|ls`, `add`, `remove|rm`, `show`, `info`, `set-default|default`, `detect`.

`fn project add` registers an existing directory with Fusion. If the directory
does not contain a Git repository yet, Fusion runs a minimal `git init` during
registration and fails the registration if Git is unavailable.

---

## `fn node`

Manage external execution nodes.

```bash
fn node list --json
fn node connect edge-runner --url https://node.example.com --api-key $NODE_API_KEY --max-concurrent 4
fn node disconnect edge-runner --force
fn node show edge-runner
fn node health edge-runner
```

Subcommands: `list|ls`, `connect`, `disconnect`, `show|info`, `health`.

---

## `fn mesh`

Mesh network status.

```bash
fn mesh status [--json]
```

Subcommands: `status`.

---

## `fn mission`

Mission hierarchy operations.

```bash
fn mission create "Platform hardening" "Security and reliability initiative" --base-branch develop --goal G-001 --goal G-002
fn mission list
fn mission show mission_123
fn mission goals mission_123
fn mission link-goal mission_123 G-001
fn mission unlink-goal mission_123 G-001
fn mission delete mission_123 --force
fn mission activate-slice slice_456
```

Subcommands: `create`, `list|ls`, `show|info`, `goals`, `link-goal`, `unlink-goal`, `delete`, `activate-slice`.

`fn mission create` supports `--base-branch <branch>` to set a mission-level default integration branch used by mission feature/slice triage when no explicit branch override is provided. It also supports repeatable `--goal <goal-id>` flags to link active goals during creation.

Mission ↔ goal linkage commands operate on the persisted `mission_goals` relation:

- `fn mission goals <mission-id>` lists the linked goals for a mission.
- `fn mission link-goal <mission-id> <goal-id>` idempotently adds a goal link; archived goals reject with `GOAL_ARCHIVED` and missing goals still fail with `404`/not found.
- `fn mission unlink-goal <mission-id> <goal-id>` idempotently removes a goal link, including archived goals.

---

## `fn goals`

Goal management operations, including Slice 2 citation-audit queries.

```bash
fn goals list [--status active|archived|all]
fn goals create "Improve reliability" "Reduce flaky tests and retries"
fn goals archive G-001
fn goals citations [--goal <id>] [--agent <id>] [--surface <agent_log|task_document>] [--since <iso>] [--until <iso>] [--limit <n>] [--json]
```

Subcommands: `list|ls`, `create`, `archive`, `citations`.

Notes:
- `fn goals list` defaults to `active` goals.
- Active goals have a hard cap of 5. Create operations fail cleanly once the cap is reached.
- `fn goals citations` lists recorded goal-ID citations across `agent_log` and `task_document` and supports machine-readable output with `--json`.

---

## `fn agent`

Agent runtime operations.

```bash
fn agent stop AGENT-001
fn agent start AGENT-001
fn agent mailbox AGENT-001
fn agent import <source> [--dry-run] [--skip-existing]
fn agent export ./output-dir --company-name "My Company" --company-slug my-company
```

Subcommands: `stop`, `start`, `mailbox`, `import`, `export`.

### `fn agent stop`

Pause a running/active agent by transitioning its state to `paused`.

**Options:**
| Option | Description |
|---|---|
| `--project <name>`, `-P <name>` | Target a specific registered project before resolving the agent. |

**Behavior notes:**
- Usage: `fn agent stop <id>`.
- If the agent does not exist, the command exits with `Agent <id> not found`.
- If the agent is already paused, this is a no-op and prints `Agent <id> is already paused`.
- Invalid state transitions are rejected with `Cannot stop agent <id> — current state '<state>' cannot transition to 'paused'`.
- On success, prints `✓ Agent <id> stopped`.

**Examples:**
```bash
fn agent stop AGENT-001
fn agent stop AGENT-001 --project my-project
```

### `fn agent start`

Resume a paused agent by transitioning its state to `active`.

**Options:**
| Option | Description |
|---|---|
| `--project <name>`, `-P <name>` | Target a specific registered project before resolving the agent. |

**Behavior notes:**
- Usage: `fn agent start <id>`.
- If the agent does not exist, the command exits with `Agent <id> not found`.
- If the agent is already `active` or `running`, this is a no-op and prints `Agent <id> is already running (<state>)`.
- Invalid state transitions are rejected with `Cannot start agent <id> — current state '<state>' cannot transition to 'active'`.
- On success, prints `✓ Agent <id> started`.

**Examples:**
```bash
fn agent start AGENT-001
fn agent start AGENT-001 --project my-project
```

### `fn agent mailbox`

Inspect an agent-owned inbox (different from `fn message inbox`, which shows the CLI user's inbox).

**Options:**
| Option | Description |
|---|---|
| `--project <name>`, `-P <name>` | Target a specific registered project before reading mailbox data. |

**Behavior notes:**
- Usage: `fn agent mailbox <id>`.
- Header format: `🤖 Agent Mailbox: <id> (<unreadCount> unread)`.
- Displays up to 20 most recent inbox messages for the agent.
- Unread messages are prefixed with `●`; read messages are unprefixed.
- Message previews are truncated to 80 characters with a trailing ellipsis (`…`).
- If no messages are present, prints `No messages`.

**Examples:**
```bash
fn agent mailbox AGENT-001
fn agent mailbox AGENT-001 --project my-project
```

### `fn agent export`

Export Fusion agents to an Agent Companies package directory.

**Options:**
| Option | Description |
|---|---|
| `--company-name <name>` | Override the exported company display name. |
| `--company-slug <slug>` | Override the exported company slug used in package metadata/paths. |
| `--project <name>`, `-P <name>` | Target a specific registered project before collecting agents. |

**Behavior notes:**
- Usage: `fn agent export <dir> [--company-name <name>] [--company-slug <slug>]`.
- If no agents exist in the selected project, the command exits with `No agents found to export`.
- Exported `AGENTS.md` manifests include inline `memory` for each agent so memory round-trips across package export/import.
- Successful runs print a summary including output directory, agents exported, skills exported, files written, and per-agent errors (if any).
- Output directory paths are resolved to absolute paths before export.

**Examples:**
```bash
fn agent export ./output-dir
fn agent export ./output-dir --company-name "My Company" --company-slug my-company
fn agent export ./output-dir --project my-project
```

### `fn agent import`

Import agents from [companies.sh](https://companies.sh) packages. Supports single manifest files, team packages, and archives.

**Source formats:**
- Single `AGENTS.md` manifest file
- Companies.sh package directory with `COMPANY.md`, `TEAM.md`, and `AGENTS.md`
- Archive files (`.tar.gz`, `.tgz`, `.zip`)

**Options:**
| Option | Description |
|---|---|
| `--dry-run` | Preview import without creating agents or skill files |
| `--skip-existing` | Skip agents with names that already exist in Fusion |

**Team hierarchy:**
When importing a companies.sh package with team structure, the importer preserves manager/report relationships for both fresh and partial imports. Manifest-style manager references such as `ceo`, `../ceo/AGENTS.md`, and already-valid Fusion agent IDs are resolved to actual Fusion `reportsTo` agent IDs before agents are created, and `--skip-existing` reuses matching existing managers when available instead of flattening the org tree.

**Memory import/export parity:**
Manifest-provided inline `memory` is preserved during `fn agent import` (including `--dry-run` previews) and restored onto created agents, matching export behavior so operator-authored memory is not dropped.

**Skill imports:**
When importing from a package directory or archive, the importer also imports any package skill manifests (`skills/*/SKILL.md`). Skills are written to `{project}/skills/imported/{company-slug}/{skill-slug}/SKILL.md`. Existing skill files at the target path are skipped (not overwritten). Single `AGENTS.md` file imports do not include package skills.

The import summary reports:
- Skills imported (new skills written)
- Skills skipped (already exist at target path)
- Skill errors (invalid manifests or write failures)

**Examples:**
```bash
# Import a single agent manifest
fn agent import ./ceo/AGENTS.md

# Import a full companies.sh package (includes agents and skills)
fn agent import ./my-company/

# Import from archive
fn agent import ./package.tar.gz

# Preview without creating
fn agent import ./package/ --dry-run

# Skip existing agents
fn agent import ./package/ --skip-existing
```

---

## `fn message`

User mailbox operations for sending and managing direct messages with agents.

```bash
fn message inbox
fn message outbox
fn message send AGENT-001 "Please prioritize FN-222"
fn message read MSG-123
fn message delete MSG-123
```

| Subcommand | Description |
|---|---|
| `fn message inbox` | List your inbox messages (newest first, up to 20). |
| `fn message outbox` | List messages you sent (newest first, up to 20). |
| `fn message send <agent-id> <content>` | Send a user→agent message and print the created message ID. |
| `fn message read <id>` | Show one full message by ID and auto-mark it as read if unread. |
| `fn message delete <id>` | Permanently delete one message by ID. |

### Mailbox behavior

- `inbox` header shows unread totals as `Inbox (<count> unread)`.
- Unread inbox rows are prefixed with `●`; read rows have no dot.
- Inbox sender labels use `Agent <id>` for agent senders and raw user IDs for user senders.
- Outbox recipient labels use `Agent <id>` for agent recipients.
- Inbox/outbox previews are truncated to 80 characters with a trailing ellipsis (`…`).
- `send` success output includes `✓ Message sent: <message-id>` plus the destination agent.
- `read` prints full metadata (`Message`, `Type`, `From`, `To`, `Time`) and the complete message body.
- `read` exits with code `1` when the message ID is not found.
- `delete` removes the message immediately and prints `✓ Message <id> deleted`.

### Options

| Option | Description |
|---|---|
| `--project <name>` | Route mailbox operations to a specific registered project (resolved via project context). Supported by all `fn message` subcommands. |

### Related command

`fn agent mailbox <agent-id>` is separate from `fn message`: it inspects an **agent-owned mailbox** (agent inbox view), while `fn message ...` manages the **CLI user mailbox**.

---

## `fn chat`

Interactive CLI conversation loop with a specific agent.

```bash
fn chat <agent-id> [message…] [--once] [--non-interactive] [--poll-ms <n>]
```

### Behavior

- `fn chat <agent-id>` starts an interactive REPL.
- `fn chat <agent-id> <message…>` sends one message and waits for a reply (`--once` implied).
- Messages are sent as `user-to-agent` records from CLI user `cli` with `metadata.wakeRecipient=true`.
- Replies are polled from the CLI user inbox and printed as they arrive.

### Options

| Option | Description |
|---|---|
| `--once` | Send one message and exit after first reply (or timeout). |
| `--non-interactive` | Read full stdin to EOF as message body (useful for pipes/scripts). |
| `--poll-ms <n>` | Poll interval in milliseconds (default `1000`, or `FUSION_CHAT_POLL_MS`). |

### Examples

```bash
# Interactive session
fn chat agent-abc123

# One-shot message (positional message implies --once)
fn chat agent-abc123 "status update?"

# Scripted one-shot from stdin
printf "deploy report" | fn chat agent-abc123 --once --non-interactive
```

> Agent replies require a running engine for the same project (for example `fn dashboard` or `fn serve`).
>
> See [Agents: Interactive CLI Chat](./agents.md#interactive-cli-chat) for agent-oriented details.

---

## `fn settings`

Show and manage settings.

```bash
fn settings
fn settings set maxConcurrent 4
fn settings set defaultNodeId node_abc123
fn settings set unavailableNodePolicy fallback-local
fn settings set worktrunk.enabled true
fn settings export [--scope global|project|both] [--output <file>]
fn settings import <file> [--scope global|project|both] [--merge] [--yes]
```

| Option | Description |
|---|---|
| `--scope` | Scope selector for `settings export` and `settings import`: `global`, `project`, or `both` (default: `both`). |
| `--output` | Custom output file path for `settings export`. |
| `--merge` | Merge imported values with existing settings (used by `settings import`). |
| `--yes` | Skip confirmation prompt during `settings import`. |

---

## `fn git`

Project git operations.

```bash
fn git status
fn git fetch
fn git fetch upstream
fn git pull --yes
fn git push --yes
```

---

## `fn backup`

Database backup lifecycle.

```bash
fn backup --create
fn backup --list
fn backup --restore .fusion/backups/fusion-2026-04-08.db
fn backup --cleanup
```

---

## `fn plugin`

Plugin lifecycle management.

```bash
fn plugin list
fn plugin install <path> [--ai-scan]
fn plugin rescan <id>
fn plugin trust <id>
fn plugin untrust <id>
fn plugin verify <id>
fn plugin uninstall <id> --force
fn plugin enable <id>
fn plugin disable <id>
fn plugin create <name>
fn plugin new <name> [--output <dir>] [--scope <scope>]
fn plugin dev <path> [--once] [--ai-scan]
```

Subcommands: `list|ls`, `install`, `rescan`, `trust`, `untrust`, `verify`, `uninstall`, `enable`, `disable`, `create`, `new`, `dev`.

Scope semantics:
- `fn plugin install <path>` accepts a built plugin directory or installed package name, not a packed `.tgz` tarball; extract tarballs before installing.
- `fn plugin install` / `fn plugin uninstall` are **global** operations
- `fn plugin enable` / `fn plugin disable` are **project-scoped** operations (`--project` selects the project context)
- `fn plugin list` shows globally installed plugins plus enabled/disabled state for the current project context

`fn plugin install --ai-scan` enables AI security scanning on plugin load. `fn plugin rescan <id>` runs a fresh scan/reload cycle and prints plugin name, verdict, summary, and finding count. It exits non-zero for `blocked`, `error`, or `unavailable` verdicts.

---

## `fn skills`

Browse and install agent skills from [skills.sh](https://skills.sh).

```bash
fn skills search <query> [--limit <n>]
fn skills install <owner/repo> [--skill <name>]
```

Subcommands: `search`, `install`.

| Option | Description |
|---|---|
| `--limit` | Max search results (default: 10, max: 50). Used by `search`. |
| `--skill` | Install a specific skill by name. Used by `install`. |

---

## Useful option flags by context

| Option | Used by |
|---|---|
| `--project`, `-P` | Most project-scoped commands (for example: `fn task ...`, `fn message ...`, `fn agent mailbox`, `fn settings`, `fn research`, `fn mission`, `fn node`, `fn plugin`, `fn skills`) |
| `--port`, `-p` | `fn dashboard`, `fn serve`, `fn daemon` |
| `--host` | `fn serve`, `fn daemon` |
| `--interactive` | `fn dashboard`, `fn serve`, `fn daemon`, `fn desktop`, `fn task import`, `fn project add` |
| `--paused` | `fn dashboard`, `fn serve`, `fn daemon`, `fn desktop` |
| `--dev` | `fn dashboard`, `fn desktop` |
| `--no-engine` | `fn dashboard` |
| `--attach` | `fn task create` |
| `--depends` | `fn task create` |
| `--node` | `fn task create` |
| `--feedback` | `fn task refine` |
| `--yes` | confirmation-skipping flows (`task plan`, `settings import`, git pull/push, etc.) |
| `--limit`, `-l` | `fn task import` (default: 30, max: 100), `fn skills search` (default: 10, max: 50) |
| `--labels`, `-L` | `fn task import` |
| `--skill` | `fn skills install` |
| `--dry-run` | `fn agent import` |
| `--skip-existing` | `fn agent import` |
| `--company-name` | `fn agent export` |
| `--company-slug` | `fn agent export` |
| `--once` | `fn chat` |
| `--non-interactive` | `fn chat` |
| `--poll-ms` | `fn chat` |

For configuration details used by these commands, see [Settings Reference](./settings-reference.md).

# CLI Reference

[← Docs index](./README.md)

Fusion’s command-line interface is exposed through the `fn` command.

<!--
FNXC:AgentTools 2026-06-29-22:31:
The published CLI/pi extension must document its agent-facing workflow authoring surface so operators know agents can inspect, create, update, configure, and delete custom workflows without using the dashboard editor.

FNXC:AgentTools 2026-06-30-09:25:
The extension docs must list workflow selection and task-creation forwarding alongside CRUD/settings tools so operators do not assume only discovery and selection exist or that agents may reroute arbitrary tasks.

FNXC:WorkflowCli 2026-07-12-00:00:
Workflow authors need a published CLI dry-run that validates the same IR contract as create/update while performing zero persistence, so scripts can fail before attempting a save.
-->

## Published agent extension workflow tools

The published `@runfusion/fusion` CLI bundle also exposes the pi extension tool surface used by external agents. Alongside task and coordination helpers, agents can now author and manage workflow definitions:

- `fn_workflow_list` / `fn_workflow_get` — discover built-in and custom workflows and inspect a workflow's IR before editing.
- `fn_workflow_validate` — dry-run validate a workflow IR without creating or mutating it. It accepts an existing workflow id or inline IR through the tool surface and returns the same typed validation errors that create/update would reject.
- `fn_workflow_create` / `fn_workflow_update` — create or revise custom workflow definitions through Fusion's central workflow validator. Built-in definitions are read-only, and broader-than-default column permission bindings require explicit policy-escalation confirmation.
- `fn_workflow_settings` — read and write typed per-project values for a workflow's declared settings. `get` returns stored and engine-effective values; `set` validates atomically and treats `null` as deleting a stored override.
- `fn_workflow_delete` — delete custom workflows; built-in workflows remain protected.
- `fn_trait_list` — list the column trait vocabulary used when authoring workflow columns.
- `fn_workflow_select` — assign a workflow to the current task in task-bound lanes or to an explicit `task_id` when the lane has no ambient task. Published/pi extension calls, dashboard chat/planning, and no-task heartbeat lanes must pass `task_id`; executor paths may omit it only for the task currently under execution.
- `workflow_id` on task creation/delegation tools — create or delegate a task onto a real workflow id from the start.

Agents should still use `fn_workflow_select` only when the user explicitly requested that workflow or when assigning a workflow to a task they created; they must not reroute arbitrary existing tasks just because another workflow appears more suitable. Prompt-injectable lanes strip workflow approval-bypass flags during `fn_workflow_create` / `fn_workflow_update`; executor-owner paths are the only authoring path that may preserve those flags.

## Workflow commands

```bash
fn workflow validate <id> [--json]
fn workflow validate --file <path> [--json]
```

`fn workflow validate` runs the server-side workflow IR dry run without creating, updating, deleting, or emitting workflow events. The command exits `0` when the IR is valid, exits non-zero for invalid IR or usage errors, and `--json` prints `{ "valid": true }` or `{ "valid": false, "errors": [...] }` for automation.

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

Settings pane navigation and editing:
- `Tab` switches focus between the settings list and the detail/edit pane.
- In the settings list, `↑`/`↓` or `k`/`j` moves the selected setting.
- In the detail/edit pane, `←`/`→` or `h`/`l` cycles enum values such as **Remote Provider**; `Space` toggles booleans; `+`/`-` adjusts numbers.

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

FNXC:DesktopCLI 2026-07-01-21:12:
Installed `fn desktop` / `fusion desktop` must launch packaged desktop runtime assets instead of treating the shell cwd as a Fusion source checkout. This keeps unrelated invalid JSON in user directories from blocking desktop startup; `--dev` is the explicit source-checkout path.
-->

Launch the Fusion desktop app (Electron) with a local AI engine running by default, mirroring `fn dashboard` engine-on startup. In normal installed usage, both `fn desktop` and `fusion desktop` resolve the packaged desktop runtime from the installed `@runfusion/fusion` package; they do not build `@fusion/desktop`, inspect a source workspace, or validate `package.json` files from the current directory or its ancestors.

Use `--dev` only from a Fusion source checkout after building the desktop entrypoint. It points Electron at the checkout's `packages/desktop/dist/main.js` and Vite dev server.

```bash
fn desktop
fusion desktop --no-auth
fn desktop --dev
fn desktop --paused
fn desktop --interactive
```

| Option | Description |
|---|---|
| `--dev` | Launch from a source checkout with hot-reload (connects to Vite dev server). |
| `--paused` | Launch with the AI engine paused (automation disabled). |
| `--interactive` | Interactive port selection. |
| `--no-auth` | Disable bearer-token auth for the embedded local dashboard server. This matches `fn dashboard --no-auth` for local desktop compatibility and does not change runtime asset resolution. |

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

Planning sessions also have read-only board tools: `fn_task_list` (list active backlog tasks) and `fn_task_show` (read full task details, including PROMPT.md) so interviews can avoid duplicate in-flight plans and anchor questions to existing work. `fn_task_list` output is bounded and falls back to a defensive formatter if the runtime task-list clamp helper is unavailable, so board reads return text instead of failing during ambient planning or heartbeat checks. `fn_task_list` also accepts `includeDeleted: true` to surface soft-deleted blockers when diagnosing stalled dependency chains, and `fn_task_show` now auto-falls back to include soft-deleted tasks with a `[SOFT-DELETED at ...]` marker.

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

Every `fn task` subcommand that touches the board retries on lock (FN-7731,
generalized to all subcommands in FN-7734): if the board database
(`.fusion/fusion.db`) is momentarily locked by the engine or another agent,
the command retries with bounded exponential backoff instead of failing
outright. If the lock hasn't cleared once the retry deadline (default 15s)
is reached, the command fails fast with a clear, actionable, non-zero-exit
error naming the task and operation rather than hanging. Override the
deadline with `FUSION_CLI_LOCK_RETRY_MS` (milliseconds). The resolved
`TaskStore` is always closed on exit (success, not-found, or lock-exhaustion)
so the CLI process exits promptly, for both a registered/cached project
store and the uncached CWD-fallback resolution branch.

Multi-step commands (`fn task create`, `fn task retry`, `fn task delete`,
`fn task merge`, the GitHub/GitLab bulk-import commands) retry each discrete
board write independently rather than retrying the whole flow, so a lock
error on a later step never redoes an already-committed earlier write (e.g.
double-creating a task). Long-lived/interactive commands (`fn task plan`,
interactive GitHub import, `fn task logs --follow`) keep their interactive
prompt loop or tail session un-retried by design but still close the
resolved store on every exit path, including on `Ctrl+C`.

The same retry-on-lock and deterministic-teardown behavior extends to
`fn branch-group *` (`list`/`show`/`abandon`/`promote`) and `fn pr *`
(`create`/`list`/`show`/`approve`/`respond`/`retry`/`merge`/`close`/
`automerge`/`automerge-cleanup`) (FN-7738). Discrete board reads/writes
retry through a momentary `database is locked` (subject to the same
`FUSION_CLI_LOCK_RETRY_MS` deadline override); external GitHub API calls and
workflow-release side effects are not retried, to avoid re-issuing an
already-completed side effect. The resolved `TaskStore` — whether resolved
from the registered/default project or the uncached CWD-fallback project —
is always closed on exit so the CLI process exits promptly.

FN-7739 extends the same pattern to `fn backup *` (`create`/`list`/
`restore`/`cleanup`), `fn memory-backup *` (`create`/`list`/`restore`),
`fn mcp *` (`list`/`add`/`edit`/`remove`/`enable`/`disable`/`import`/
`export`/`validate`), and `fn db vacuum`. `fn backup`/`fn memory-backup`
retry their `getSettings()` board read; `fn mcp` retries project-scope
`updateSettings` writes (mutations) and reads, and closes BOTH the cached
project `TaskStore` and the ad-hoc uncached secrets `TaskStore` opened by
`--secret-ref`/`--create-secret-*` resolution when no project is in scope;
`fn db vacuum` retries the VACUUM call itself (VACUUM requires an exclusive
lock, the canonical transient-lock case) and closes the resolved store
BEFORE each `process.exit()` call, since `runDbVacuum` always exits
explicitly and a pending `finally` does not run after `process.exit()`. MCP
global-scope settings live in the file-backed `GlobalSettingsStore`
(`~/.fusion/settings.json`, no SQLite handle) and are intentionally left
with no close and no lock-retry. All of the above honor the same
`FUSION_CLI_LOCK_RETRY_MS` deadline override.

The same class of fix (FN-7740) also covers `fn research *`
(`create`/`list`/`show`/`export`/`cancel`/`retry`), `fn settings import`,
`fn agent export`, `fn git *` (`status`/`fetch`/`pull`/`push`), and
`fn project *` (`list`/`add`/`remove`/`show`/`set-default`/`detect`):

- `fn git *` and `fn agent export` never write the board, so they are
  **teardown-only** — the resolved project path is now obtained via the
  path-only helper (no cached, never-closed `TaskStore` left behind), and
  `fn agent export` additionally closes the `AgentStore` it opens on every
  exit path (success and the no-agents-to-export guard).
- `fn project list`/`show` compute per-project task counts against an
  uncached `TaskStore` per registered project; that store is now closed
  after every call (so `fn project list` no longer leaks one store per
  registered project), and the count read retries a momentary
  `database is locked` instead of silently reporting zero tasks.
- `fn settings import`'s `importSettings` write and `fn research create`
  (settings read) / `fn research export`'s `createExport` write retry
  through a momentary `database is locked` — subject to the same
  `FUSION_CLI_LOCK_RETRY_MS` deadline override as `fn task`/`fn branch-group`/
  `fn pr` — and the resolved store is closed BEFORE every `process.exit()`
  call (a pending `finally` does not run after `process.exit()`).
- `fn research create` without `--wait-for-completion` is the ONE
  intentionally-long-lived exception in the CLI: the research run continues
  in the background against the same store after the command returns, so
  that store is deliberately NOT closed on this path (closing it would
  truncate the in-flight run). Every other `fn research *` path, including
  `--wait-for-completion`, closes its store on exit.

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

`fn task import` creates Fusion tasks from GitHub issues. If project or global GitHub tracking defaults are enabled, imported issue tasks are marked as tracked and the tracking hook links the source issue itself instead of opening a duplicate Fusion tracking issue.

`fn task import-gitlab` creates Fusion tasks from GitLab project issues, group issues, or project merge requests using the configured GitLab instance/API URL and access token (`read_api` or `api` scope for import; `api` for later comments/close actions). It uses the GitLab HTTP API only (no `glab` dependency), supports GitLab.com and self-managed instances, stores `gitlab_import` provenance plus `gitlabTracking` task metadata for dashboard badges/details, and skips duplicates by source URL/provenance. Imported GitLab tasks can post lifecycle comments and close/reopen source or tracking targets when project settings enable those side effects; group issues require backing project identity, and Fusion never merges GitLab merge requests.

```bash
fn pr create FN-001
fn pr create FN-001 --draft --reviewer octocat --reviewer hubot --base main
fn task pr-create FN-001 --title "Fix login race" --body "Prevents duplicate session refresh." --base main
fn pr automerge-cleanup --json
fn pr automerge-cleanup --apply
fn task import owner/repo --labels bug --limit 10
fn task import owner/repo --interactive
fn task import-gitlab group/project --resource project-issues --labels bug --limit 10
fn task import-gitlab group/subgroup --resource group-issues --limit 20
fn task import-gitlab 12345 --resource merge-requests --limit 5
fn task import-gitlab platform/team/app --resource project-issues --project self-managed
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

`fn project list` and `fn project show/info` report `In-Flight Agents` from live task state: in-progress executors plus triage planners whose task is in `triage` with `status === "planning"` and is not paused. The readout intentionally ignores stale persisted `projectHealth.inFlightAgentCount` bookkeeping.

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
- The command always closes its store connections and exits promptly on every path (success, already-paused, not-found, invalid-transition) — it never hangs. The underlying state-store write is bounded by a fast-fail deadline (default 10s, override via `FUSION_AGENT_CMD_TIMEOUT_MS`); if it cannot complete in time, the command prints a clear error naming the agent and operation and exits non-zero instead of hanging. Safe to drive from an automated recovery watcher.

**Examples:**
```bash
fn agent stop AGENT-001
fn agent stop AGENT-001 --project my-project
FUSION_AGENT_CMD_TIMEOUT_MS=5000 fn agent stop AGENT-001  # tighter fast-fail deadline
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
- Same deterministic-exit and fast-fail-timeout behavior as `fn agent stop` (see above) — the command always closes its store connections and exits promptly, and the state-store write is bounded by `FUSION_AGENT_CMD_TIMEOUT_MS` (default 10s).

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

## `fn mcp`

Manage Fusion MCP server definitions for stdio, SSE, and streamable HTTP transports. See [MCP](./mcp.md) for the full configuration and usage guide, including dashboard flows and secret-reference behavior.

```bash
fn mcp list [--project <name>] [--json]
fn mcp add <name> --scope global|project --transport stdio --command <cmd> [--arg <arg> ...]
fn mcp add <name> --scope global|project --transport sse|http --url <url>
fn mcp edit <name> [--scope global|project] [--transport stdio|sse|http] [--command <cmd>|--url <url>]
fn mcp remove <name> [--scope global|project]
fn mcp enable <name> [--scope global|project]
fn mcp disable <name> [--scope global|project]
fn mcp import <claude-desktop.json> [--scope global|project] [--yes]
fn mcp export [--scope global|project|effective] [--output <file>] [--json]
fn mcp validate [--scope global|project|effective] [--json]
```

Scope semantics:
- `--scope global` writes shared MCP declarations in global settings.
- `--scope project` writes the selected project's declarations. Project servers override same-named global servers; a project server with `enabled:false` disables the inherited global server without deleting it.
- `list`, `export`, and `validate` can show the `effective` resolution, which is global plus project overrides after disabled entries are removed.

Secret handling:
- Fusion never persists raw MCP env/header/token-like values in settings. Sensitive fields are stored only as Fusion secret references (`{ secretRef, scope }`).
- Use `--env KEY=SECRET_REF` or `--header NAME=SECRET_REF` to attach existing secrets. Add `--secret-scope global|project` when the referenced secret lives outside the command's default scope.
- Use `--create-secret-env KEY=VALUE` or `--create-secret-header NAME=VALUE` when you want the CLI to create a Fusion secret and persist only the resulting reference.
- `--env-raw` and `--header-raw` are rejected by design; they exist only to produce an explicit no-plaintext error for scripts that try to pass inline sensitive values.
- `fn mcp import` accepts Claude Desktop-style `{ "mcpServers": { ... } }` JSON, creates Fusion secrets for imported plaintext env/header values, and writes only secret references.
- `list`, `export`, and `validate` print descriptors/summaries, never decrypted secret values.

| Option | Description |
|---|---|
| `--scope` | `global` or `project` for writes; `global`, `project`, or `effective` for read/export/validate commands. |
| `--transport` | Server transport for add/edit: `stdio`, `sse`, `http`, or `streamable-http`. |
| `--command` | Command path/name for `stdio` servers. |
| `--arg <arg>` / `--args <args>` | Arguments for `stdio` servers. Repeat `--arg`; `--args` accepts a space-separated string. |
| `--url` | URL for `sse`, `http`, or `streamable-http` servers. |
| `--env KEY=SECRET_REF` | Attach an env var to an existing secret reference. |
| `--header NAME=SECRET_REF` | Attach an HTTP/SSE header to an existing secret reference. |
| `--secret-scope` | Scope used when resolving `--env`, `--header`, or `--secret-ref` (default: command scope). |
| `--secret-ref` | Existing secret reference for token-like single-secret flows. |
| `--create-secret-env KEY=VALUE` | Create a Fusion secret for an env var and store only the reference. |
| `--create-secret-header NAME=VALUE` | Create a Fusion secret for a header and store only the reference. |
| `--output <file>` | Write `fn mcp export` output to a file instead of stdout. |
| `--json` | Print machine-readable output for list/export/validate where supported. |
| `--yes` | Skip confirmation during import. |

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
fn plugin publish <path> [--dry-run] [--previous-version <semver>]
```

Subcommands: `list|ls`, `install`, `rescan`, `trust`, `untrust`, `verify`, `uninstall`, `enable`, `disable`, `create`, `new`, `dev`, `publish`.

Scope semantics:
- `fn plugin install <path>` accepts a built plugin directory or installed package name, not a packed `.tgz` tarball; extract tarballs before installing.
- `fn plugin install` / `fn plugin uninstall` are **global** operations
- `fn plugin enable` / `fn plugin disable` are **project-scoped** operations (`--project` selects the project context)
- `fn plugin list` shows globally installed plugins plus enabled/disabled state for the current project context

`fn plugin install --ai-scan` enables AI security scanning on plugin load. `fn plugin rescan <id>` runs a fresh scan/reload cycle and prints plugin name, verdict, summary, and finding count. It exits non-zero for `blocked`, `error`, or `unavailable` verdicts.

`fn plugin publish --dry-run <path>` runs an offline, non-mutating publish preflight for external authors. It validates `manifest.json`, the compiled JavaScript entrypoint, declared lifecycle hooks, and the optional version bump (`--previous-version <semver>`), then prints manual `pnpm build` → `pnpm pack` → `npm publish --access public` next steps without installing, uploading, or tagging anything.

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
| `--no-auth` | `fn dashboard`, `fn desktop`, `fn chat` |
| `--no-engine` | `fn dashboard` |
| `--attach` | `fn task create` |
| `--depends` | `fn task create` |
| `--node` | `fn task create` |
| `--feedback` | `fn task refine` |
| `--yes` | confirmation-skipping flows (`task plan`, `settings import`, git pull/push, etc.) |
| `--limit`, `-l` | `fn task import`, `fn task import-gitlab` (default: 30, max: 100), `fn skills search` (default: 10, max: 50) |
| `--labels`, `-L` | `fn task import`, `fn task import-gitlab` |
| `--resource`, `-r` | `fn task import-gitlab` (`project-issues`, `group-issues`, or `merge-requests`) |
| `--skill` | `fn skills install` |
| `--dry-run` | `fn agent import` |
| `--skip-existing` | `fn agent import` |
| `--company-name` | `fn agent export` |
| `--company-slug` | `fn agent export` |
| `--once` | `fn chat` |
| `--non-interactive` | `fn chat` |
| `--poll-ms` | `fn chat` |

For configuration details used by these commands, see [Settings Reference](./settings-reference.md).

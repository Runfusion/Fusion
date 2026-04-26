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

During fresh initialization, Fusion also installs the bundled `fusion` skill into supported local agent homes when the target skill does not already exist:

- `~/.claude/skills/fusion`
- `~/.codex/skills/fusion`
- `~/.gemini/skills/fusion`

`fn init` is non-destructive for these installs:
- Existing `fusion` skill directories are preserved (not overwritten).
- Per-target filesystem/permission failures are reported as warnings and do not fail project initialization.

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
fn dashboard --dev
```

| Option | Description |
|---|---|
| `--port`, `-p` | Dashboard HTTP port (default `4040`). |
| `--host` | Host to bind (default `127.0.0.1`, localhost only). Pass `0.0.0.0` to expose on all interfaces. |
| `--token <token>` | Bearer token to use. Default: `$FUSION_DASHBOARD_TOKEN` → `$FUSION_DAEMON_TOKEN` → auto-generated. |
| `--no-auth` | Disable bearer-token auth. Not recommended when binding to `0.0.0.0`. |
| `--paused` | Start with the engine paused (automation disabled). |
| `--interactive` | Interactive port selection. |
| `--dev` | Start dashboard only (no AI engine, no triage/scheduler). |

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

Remote action keys in Settings detail pane:
- `C` activate selected provider
- `V` start tunnel
- `X` stop tunnel
- `P` regenerate persistent token
- `L` enter TTL input mode and generate short-lived token
- `U` generate authenticated URL hand-off
- `K` request QR payload hand-off
- `R` refresh remote status/snapshot

QR hand-off behavior in TUI:
- `format="text"`: renders the text payload directly
- `format="image/svg"`: does not render raw SVG in terminal; shows the authenticated URL, expiry metadata, and a fallback instruction to open the URL on phone/browser

On startup, the TUI opens on the **System** section by default so you can
immediately see host/port and access-token details.

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

Launch the Fusion desktop app (Electron).

```bash
fn desktop
fn desktop --dev
fn desktop --paused
fn desktop --interactive
```

| Option | Description |
|---|---|
| `--dev` | Launch with hot-reload (connects to Vite dev server). |
| `--paused` | Launch with automation paused. |
| `--interactive` | Interactive port selection. |

---

## `fn task`

Task lifecycle and task operations.

### Creation and planning

```bash
fn task create "Fix login race condition"
fn task create "Fix bug" --attach screenshot.png --depends FN-010
fn task plan "Design a new authentication flow"
```

### Query and logs

```bash
fn task list
fn task show FN-001
fn task logs FN-001 --follow --limit 50 --type tool
```

### Execution and status

```bash
fn task move FN-001 in-progress
fn task update FN-001 2 done
fn task log FN-001 "Updated API contract"
fn task retry FN-001
fn task pause FN-001
fn task unpause FN-001
```

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

### GitHub integration

```bash
fn task pr-create FN-001 --title "Fix login race" --base main
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
fn mission create "Platform hardening" "Security and reliability initiative"
fn mission list
fn mission show mission_123
fn mission delete mission_123 --force
fn mission activate-slice slice_456
```

Subcommands: `create`, `list|ls`, `show|info`, `delete`, `activate-slice`.

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

Inter-agent/user message mailbox.

```bash
fn message inbox
fn message outbox
fn message send AGENT-001 "Please prioritize FN-222"
fn message read MSG-123
fn message delete MSG-123
```

---

## `fn settings`

Show and manage settings.

```bash
fn settings
fn settings set maxConcurrent 4
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
fn plugin install <path>
fn plugin uninstall <id> --force
fn plugin enable <id>
fn plugin disable <id>
fn plugin create <name>
```

Subcommands: `list|ls`, `install`, `uninstall`, `enable`, `disable`, `create`.

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
| `--port`, `-p` | `fn dashboard`, `fn serve`, `fn daemon` |
| `--host` | `fn serve`, `fn daemon` |
| `--interactive` | `fn dashboard`, `fn serve`, `fn daemon`, `fn desktop`, `fn task import`, `fn project add` |
| `--paused` | `fn dashboard`, `fn serve`, `fn daemon`, `fn desktop` |
| `--dev` | `fn dashboard`, `fn desktop` |
| `--attach` | `fn task create` |
| `--depends` | `fn task create` |
| `--feedback` | `fn task refine` |
| `--yes` | confirmation-skipping flows (`task plan`, `settings import`, git pull/push, etc.) |
| `--limit`, `-l` | `fn task import` (default: 30, max: 100), `fn skills search` (default: 10, max: 50) |
| `--labels`, `-L` | `fn task import` |
| `--skill` | `fn skills install` |

For configuration details used by these commands, see [Settings Reference](./settings-reference.md).

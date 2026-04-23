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
interactive TUI with five sections:

| Section | Description |
|---|---|
| **Logs** | Real-time log entries with timestamps and severity levels |
| **System** | Host, port, URL, auth mode, token, engine status, uptime |
| **Utilities** | Actions: refresh stats, clear logs, toggle engine pause |
| **Stats** | Task counts by column, active task count, agent state counts |
| **Settings** | Key settings from the task store |

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

In wrapped mode, long log messages are displayed with word wrapping. Long
unbroken tokens (such as URLs or stack traces) are hard-wrapped at the
available width. In expanded view, the full message is shown with complete
wrapping for inspection.

In non-TTY mode (CI, piped output, scripts), the dashboard falls back to
plain console output to maintain compatibility with automated workflows.

### Authentication

Unless `--no-auth` is passed, the dashboard API (including the terminal
WebSocket) is protected by a bearer token. On startup, Fusion prints both the
raw token and a click-to-open URL that embeds `?token=<token>`:

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

1. `--token <token>` flag
2. `FUSION_DASHBOARD_TOKEN` environment variable
3. `FUSION_DAEMON_TOKEN` environment variable (back-compat with `fn daemon`)
4. Random `fn_<32 hex>` generated per run

To reuse a stable token across runs, export one of the env vars:

```bash
export FUSION_DASHBOARD_TOKEN=fn_my_stable_token
fn dashboard
```

If you ever need to revoke access, either restart `fn dashboard` (which
rotates the auto-generated token) or clear the `fn.authToken` entry from
each client's `localStorage`.

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

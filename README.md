# kb

AI-orchestrated task board. Like Trello, but your tasks get specified, executed, and delivered by AI — powered by [pi](https://github.com/badlogic/pi-mono).

![kb dashboard](demo/screenshot.png)

## Workflow

```mermaid
graph TD
    H((You)) -->|rough idea| T["Triage\n<i>auto-specification</i>"]
    T --> TD["Todo\n<i>scheduled for execution</i>"]
    TD --> IP["In Progress\n<i>for each step:\nplan, review, execute, review </i>"]

    subgraph IP["In Progress"]
        direction TD
        NS([Begin step]) --> P[Plan]
        P[Plan] --> R1{Review}
        R1 -->|revise| P
        R1 -->|approve| E[Execute]
        E --> R2{Review}
        R2 -->|revise| E
        R2 -->|next step| NS
        R2 -->|rethink| P
    end

    R2 -->|done| IR["In Review\n<i>ready to merge,\nor auto-complete</i>"]
    IR -->|direct squash merge\nor merged PR| D["Done"]

    style H fill:#161b22,stroke:#8b949e,color:#e6edf3
    style T fill:#2d2006,stroke:#d29922,color:#d29922
    style TD fill:#0d2044,stroke:#58a6ff,color:#58a6ff
    style IP fill:#1a0d2e,stroke:#bc8cff,color:#bc8cff
    style P fill:#1a0d2e,stroke:#bc8cff,color:#e6edf3
    style R1 fill:#1a0d2e,stroke:#bc8cff,color:#e6edf3
    style E fill:#1a0d2e,stroke:#bc8cff,color:#e6edf3
    style R2 fill:#1a0d2e,stroke:#bc8cff,color:#e6edf3
    style NS fill:#1a0d2e,stroke:#bc8cff,color:#e6edf3
    style IR fill:#0d2d16,stroke:#3fb950,color:#3fb950
    style D fill:#1a1a1a,stroke:#8b949e,color:#8b949e
```

Tasks with dependencies are processed sequentially. Independent tasks run in parallel.

## Quick Start

```bash
npm i -g @dustinbyrne/kb
```

Then from the root of your repository:

```bash
kb dashboard
```

Or start with interactive port selection:

```bash
kb dashboard --interactive
```

Open [http://localhost:4040](http://localhost:4040) — create tasks from the board or the CLI.

### CLI commands

```bash
kb dashboard                              # Start the web UI (default port 4040)
kb dashboard --interactive                # Start with interactive port selection
kb task create "Fix the login redirect bug"
kb task create "Button misaligned" --attach screenshot.png
kb task list
kb task show KB-001
kb task move KB-001 todo
kb task merge KB-001
kb task refine KB-001 --feedback "Add more tests"   # Create follow-up refinement task
kb task import owner/repo                  # Import all open issues (batch mode)
kb task import owner/repo --interactive    # Interactive issue selection
kb task import owner/repo --limit 10       # Limit number of issues fetched
kb task import owner/repo --labels bug     # Filter by label(s)
```

**GitHub Import:**
- Batch mode imports all open issues automatically (skipping already-imported)
- Interactive mode (`-i`) lets you select specific issues from a numbered list
- Uses `gh` CLI authentication (run `gh auth login`) or falls back to `GITHUB_TOKEN` for private repositories
- Pull requests are automatically filtered out

**Dashboard Import:**
- Click the ↓ (Download) icon in the header to open the GitHub import modal
- kb detects GitHub remotes automatically: a single remote is preselected, and multiple remotes can be chosen from a repository dropdown
- Optionally filter the fetched issues with comma-separated labels before loading open issues
- Review the results list and preview pane, then select the issue you want to import
- Already-imported issues stay visible with an "Imported" badge and cannot be selected again

Agents can use these same commands, or see [`.agents/skills/`](.agents/skills/) for structured skill docs.

### Prerequisites

The AI engine uses [pi](https://github.com/badlogic/pi-mono) under the hood:

1. `npm i -g @mariozechner/pi-coding-agent`
2. Run `pi` and use `/login`, or set `ANTHROPIC_API_KEY`

kb reuses your existing pi authentication.

## Packages

| Package         | Description                                                     |
| --------------- | --------------------------------------------------------------- |
| `@kb/core`      | Domain model — tasks, board columns, file-based store           |
| `@kb/dashboard` | Web UI — Express server + kanban board with SSE                 |
| `@kb/engine`    | AI engine — triage (pi), execution (pi + worktrees), scheduling |
| `kb` (cli)      | CLI — `kb dashboard`, `kb task create/list/move/attach`         |

## Architecture

### Task Storage

Tasks live on disk in `.kb/tasks/` in the project root:

```
.kb/
├── config.json              # Board config + ID counter
└── tasks/
    └── KB-001/
        ├── task.json        # Metadata (column, deps, timestamps)
        ├── PROMPT.md        # Task specification
        └── attachments/     # File attachments — images & text files (optional)
```

### Board UI

Real-time kanban board at `localhost:4040`:

- Drag-and-drop cards between columns
- Create tasks from the web UI
- Click cards for detail view with move/delete actions
- Server-Sent Events for live updates across tabs

### AI Engine

The AI engine starts automatically with the dashboard. Three components run:

- **TriageProcessor** — Watches triage column. Spawns a pi agent session that reads the project, understands context, and writes a full PROMPT.md specification. Moves task to todo.

- **Scheduler** — Watches todo column. Resolves dependency graphs. Moves tasks to in-progress when deps are satisfied and concurrency allows (default: 2 concurrent). When `groupOverlappingFiles` is enabled in settings, tasks whose `## File Scope` sections share files are serialized to prevent merge conflicts.

- **TaskExecutor** — Listens for tasks entering in-progress. Creates a git worktree, spawns a pi agent session with full coding tools scoped to the worktree, and executes the specification. Moves to in-review on completion.

Each pi agent session gets:

- Custom system prompt for its role (triage specifier vs task executor)
- Tools scoped to the correct directory (`createCodingTools(cwd)`)
- In-memory sessions (no persistence needed)
- The user's existing pi auth (API keys from `~/.pi/agent/auth.json`)

## Development

```bash
pnpm install
pnpm dev dashboard              # Board + AI engine
pnpm dev task list              # CLI commands
```

## Building a standalone executable

You can build a single self-contained `kb` binary using [Bun](https://bun.sh/):

```bash
pnpm build:exe
```

This compiles all TypeScript, builds the dashboard client, and produces:

- `packages/cli/dist/kb` — the standalone binary
- `packages/cli/dist/client/` — co-located dashboard assets

Run the binary directly — no Node.js, pnpm, or workspace setup needed:

```bash
./packages/cli/dist/kb --help
./packages/cli/dist/kb task list
./packages/cli/dist/kb dashboard
```

To distribute, copy both the `kb` binary and the `client/` directory together.

### Cross-compilation

Build binaries for all supported platforms from a single machine:

```bash
pnpm build:exe:all
```

This produces binaries for all supported targets in `packages/cli/dist/`:

| Target             | Output               |
| ------------------ | -------------------- |
| `bun-linux-x64`    | `kb-linux-x64`       |
| `bun-linux-arm64`  | `kb-linux-arm64`     |
| `bun-darwin-x64`   | `kb-darwin-x64`      |
| `bun-darwin-arm64` | `kb-darwin-arm64`    |
| `bun-windows-x64`  | `kb-windows-x64.exe` |

To build for a specific platform:

```bash
pnpm --filter kb build:exe -- --target bun-linux-x64
```

The `client/` directory is shared across all binaries (platform-independent assets).

You can override the dashboard asset path via the `KB_CLIENT_DIR` environment variable:

```bash
KB_CLIENT_DIR=/path/to/client ./kb dashboard
```

**Prerequisites:** Bun ≥ 1.0 (`bun --version`)

## GitHub Integration

kb uses the `gh` CLI (GitHub CLI) for all GitHub operations. If you have `gh` installed and authenticated (run `gh auth login`), kb will use your existing session. For environments without `gh` CLI, you can set `GITHUB_TOKEN` as a fallback.

### PR Creation from Dashboard

kb can create GitHub Pull Requests directly from the dashboard for tasks in the **In Review** column:

1. Ensure you have `gh` CLI installed and authenticated (`gh auth login`), or set the `GITHUB_TOKEN` environment variable
2. Open a task in the **In Review** column
3. Click **"Create PR"** in the Pull Request section
4. Enter a title and optional description
5. The PR is created and linked to the task automatically

The dashboard shows real-time PR status (open, closed, merged) with a refresh button to fetch the latest state from GitHub.

### Auto-completion modes

kb supports two completion strategies once a task reaches **In Review**:

- **Direct merge** *(default)* — existing behavior. kb AI-squash-merges the task branch into your current branch locally.
- **Pull request** — kb creates or links a GitHub PR for the task branch, keeps the task in **In Review** while reviews/checks are pending, and auto-merges the PR when required checks succeed and no review is actively blocking it.

`autoMerge` still controls whether kb performs either completion strategy automatically. Turning `autoMerge` off means tasks stay in **In Review** until you merge manually.

### PR-first mode prerequisites and behavior

PR-first automation is designed for repositories that require GitHub-side governance:

- Authenticate GitHub access with `gh auth login` or `GITHUB_TOKEN`
- Ensure the task branch already exists on GitHub using the normal kb branch naming convention: `kb/<task-id-lower>`
- Expect the task to remain in **In Review** while required checks are pending/failing or a review is blocking merge

**Important:** kb does **not** implicitly push task branches before creating a PR. PR-first mode assumes branch publishing is handled by your existing workflow or repository automation.

### Spec Editing & AI Revision

The dashboard includes a **Spec** tab for managing task specifications directly in the UI:

**Manual Edit:**
1. Open any task and click the **Spec** tab
2. Click **Edit** to modify the PROMPT.md content directly
3. Save changes with the **Save** button (or Ctrl/Cmd+Enter)

**Request AI Revision:**
1. In the Spec tab, use the **"Ask AI to Revise"** section
2. Enter feedback describing what needs to change (e.g., "Add more details about error handling", "Split this into smaller steps")
3. Click **"Request AI Revision"**
4. The task moves to **Triage** for re-specification by the AI

**Limitations:**
- AI revision is only available for tasks in **Todo** or **In Progress** columns
- Tasks in **In Review** or **Done** must be moved back to Todo/In Progress first
- Maximum feedback length is 2000 characters

### PR Comment Monitoring

When a task has a linked PR, kb automatically monitors it for new review comments:

- **Adaptive polling**: Checks every 30 seconds when active, 5 minutes when idle
- **Actionable feedback detection**: Filters out "LGTM" and "Thanks" comments, detects requests like "fix", "change", "update"
- **Steering comments**: Automatically adds actionable review feedback as steering comments on the task
- **Follow-up tasks**: When a PR is closed with unaddressed feedback, a follow-up task is created

Uses `gh` CLI authentication when available, falls back to `GITHUB_TOKEN` if set.

## Releases

Packages are published to npm automatically via GitHub Actions and [changesets](https://github.com/changesets/changesets).

### Installing from npm

```bash
npm install -g kb
```

### Triggering a release

Releases are automated via [changesets](https://github.com/changesets/changesets). See [RELEASING.md](./RELEASING.md) for the full workflow.

In short: add a changeset with `pnpm changeset`, merge to main, then merge the auto-generated "Version Packages" PR. Once merged, the workflow automatically publishes all updated packages to npm.

### CI pipeline

- **Pull requests & pushes to main** — runs tests and build (`.github/workflows/ci.yml`)
- **Push to main** — creates a version PR (if changesets exist) or publishes to npm (`.github/workflows/version.yml`)

## License

ISC

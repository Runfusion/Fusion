# kb

AI-orchestrated task board. Like Trello, but your tasks get specified, executed, and delivered by AI — powered by [pi](https://github.com/badlogic/pi-mono).

## Workflow

```mermaid
graph LR
    H((You)) -->|rough idea| T[Triage]
    T -->|AI writes spec| TD[Todo]
    TD -->|deps met,\nagent free| IP[In Progress]
    IP -->|all steps done,\nreviews pass| IR[In Review]
    IR -->|squash merge| D[Done]

    subgraph IP[In Progress]
        direction TB
        E[Execute step] --> R{Review}
        R -->|approve| E
        R -->|revise| E
    end

    style T fill:#2d2006,stroke:#d29922,color:#d29922
    style TD fill:#0d2044,stroke:#58a6ff,color:#58a6ff
    style IP fill:#1a0d2e,stroke:#bc8cff,color:#bc8cff
    style IR fill:#0d2d16,stroke:#3fb950,color:#3fb950
    style D fill:#1a1a1a,stroke:#8b949e,color:#8b949e
```

Tasks with dependencies are processed sequentially. Independent tasks run in parallel.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the board (with AI engine)
pnpm dev dashboard

# Create a task via CLI
pnpm dev task create "Fix the login redirect bug"

# List tasks
pnpm dev task list

# Move a task
pnpm dev task move KB-001 todo

# Pause a task (stops all automation)
pnpm dev task pause KB-001

# Unpause a task (resumes automation)
pnpm dev task unpause KB-001

# Attach a file to a task (images, logs, configs)
pnpm dev task attach KB-001 ./screenshot.png

# Create a task with attachments
pnpm dev task create "Fix the login bug" -- --attach screenshot.png --attach error.log
```

Then open [http://localhost:4040](http://localhost:4040).

## Prerequisites

The AI engine uses [pi](https://github.com/badlogic/pi-mono) agent sessions under the hood. You need:

1. **pi installed:** `npm install -g @mariozechner/pi-coding-agent`
2. **API key configured:** Run `pi` and use `/login` or set `ANTHROPIC_API_KEY`

kb reuses your existing pi authentication — no separate setup needed.

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
  config.json              -- board config + ID counter
  tasks/
    KB-001/
      task.json             -- metadata (column, deps, timestamps)
      PROMPT.md             -- task specification
      attachments/          -- file attachments (optional)
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

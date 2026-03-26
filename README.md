# hai

AI-orchestrated task board. Like Trello, but your tasks get specified, executed, and delivered by AI — powered by [pi](https://github.com/badlogic/pi-mono).

## Workflow

```
┌──────────┐    ┌──────────┐    ┌────────────┐    ┌───────────┐    ┌──────┐
│  Triage  │───▶│   Todo   │───▶│ In Progress│───▶│ In Review │───▶│ Done │
│          │    │          │    │            │    │           │    │      │
│ raw idea │    │ AI spec'd│    │ AI working │    │ ready to  │    │merged│
│          │    │ & ready  │    │ in worktree│    │   merge   │    │      │
└──────────┘    └──────────┘    └────────────┘    └───────────┘    └──────┘
    pi               ▲              pi                human
 specifies      deps gate        executes            reviews
```

1. **Triage** — Throw rough ideas in. Pi picks them up and writes a proper task spec.
2. **Todo** — Fully specified, ready to go. Scheduler moves them when deps are met.
3. **In Progress** — Pi works the task in an isolated git worktree.
4. **In Review** — Work is done. Merge the worktree and close. Toggle **Auto-merge** in the column header to automatically merge tasks as they arrive.
5. **Done** — Shipped.

Tasks with dependencies are processed sequentially. Independent tasks run in parallel.

## Quick Start

```bash
# Install dependencies
pnpm install

# Start the board (UI only)
pnpm dev dashboard

# Start with AI engine (auto-specify + auto-execute)
pnpm dev dashboard -- --engine

# Create a task via CLI
pnpm dev task create "Fix the login redirect bug"

# List tasks
pnpm dev task list

# Move a task
pnpm dev task move HAI-001 todo

# Attach a file to a task (images, logs, configs)
pnpm dev task attach HAI-001 ./screenshot.png

# Create a task with attachments
pnpm dev task create "Fix the login bug" -- --attach screenshot.png --attach error.log
```

Then open [http://localhost:4040](http://localhost:4040).

## Prerequisites

The AI engine uses [pi](https://github.com/badlogic/pi-mono) agent sessions under the hood. You need:

1. **pi installed:** `npm install -g @mariozechner/pi-coding-agent`
2. **API key configured:** Run `pi` and use `/login` or set `ANTHROPIC_API_KEY`

hai reuses your existing pi authentication — no separate setup needed.

## Packages

| Package | Description |
|---------|-------------|
| `@hai/core` | Domain model — tasks, board columns, file-based store |
| `@hai/dashboard` | Web UI — Express server + kanban board with SSE |
| `@hai/engine` | AI engine — triage (pi), execution (pi + worktrees), scheduling |
| `hai` (cli) | CLI — `hai dashboard`, `hai task create/list/move/attach` |

## Architecture

### Task Storage

Tasks live on disk in `.hai/tasks/` in the project root:

```
.hai/
├── config.json              # Board config + ID counter
└── tasks/
    └── HAI-001/
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

### API Rate Limiting

All API endpoints (`/api/*`) are rate limited to prevent abuse. Limits are applied per client IP:

| Scope | Limit | Window |
|-------|-------|--------|
| General API (`/api/*`) | 100 requests | 1 minute |
| SSE connections (`/api/events`) | 10 connections | 1 minute |

Every API response includes standard rate limit headers:

| Header | Description |
|--------|-------------|
| `RateLimit-Limit` | Maximum requests allowed per window |
| `RateLimit-Remaining` | Requests remaining in the current window |
| `RateLimit-Reset` | Seconds until the rate limit window resets |
| `Retry-After` | Seconds to wait before retrying (only on 429 responses) |

When a client exceeds the limit, the API returns `429 Too Many Requests`.

### AI Engine (`--engine`)

When enabled, three components run:

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
pnpm dev dashboard              # Board only
pnpm dev dashboard -- --engine  # Board + AI engine
pnpm dev task list              # CLI commands
```

## Building a standalone executable

You can build a single self-contained `hai` binary using [Bun](https://bun.sh/):

```bash
pnpm build:exe
```

This compiles all TypeScript, builds the dashboard client, and produces:

- `packages/cli/dist/hai` — the standalone binary
- `packages/cli/dist/client/` — co-located dashboard assets

Run the binary directly — no Node.js, pnpm, or workspace setup needed:

```bash
./packages/cli/dist/hai --help
./packages/cli/dist/hai task list
./packages/cli/dist/hai dashboard
```

To distribute, copy both the `hai` binary and the `client/` directory together.

### Cross-compilation

Build binaries for all supported platforms from a single machine:

```bash
pnpm build:exe:all
```

This produces binaries for all supported targets in `packages/cli/dist/`:

| Target | Output |
|--------|--------|
| `bun-linux-x64` | `hai-linux-x64` |
| `bun-linux-arm64` | `hai-linux-arm64` |
| `bun-darwin-x64` | `hai-darwin-x64` |
| `bun-darwin-arm64` | `hai-darwin-arm64` |
| `bun-windows-x64` | `hai-windows-x64.exe` |

To build for a specific platform:

```bash
pnpm --filter hai build:exe -- --target bun-linux-x64
```

The `client/` directory is shared across all binaries (platform-independent assets).

You can override the dashboard asset path via the `HAI_CLIENT_DIR` environment variable:

```bash
HAI_CLIENT_DIR=/path/to/client ./hai dashboard
```

**Prerequisites:** Bun ≥ 1.0 (`bun --version`)

## Releases

Pre-built standalone binaries are published automatically via GitHub Actions.

### Downloading binaries

Download the latest binary from the [GitHub Releases](../../releases) page. Each release includes platform-specific binaries and SHA256 checksum files for verification.

#### Supported platforms

| Platform | Binary | Runner |
|----------|--------|--------|
| Linux x64 | `hai-linux-x64` | `ubuntu-latest` |
| macOS arm64 (Apple Silicon) | `hai-darwin-arm64` | `macos-latest` |
| macOS x64 (Intel) | `hai-darwin-x64` | `macos-13` |
| Windows x64 | `hai-windows-x64.exe` | `windows-latest` |

### Triggering a release

Releases are automated via [changesets](https://github.com/changesets/changesets). See [RELEASING.md](./RELEASING.md) for the full workflow.

In short: add a changeset with `pnpm changeset`, merge to main, then merge the auto-generated Version Packages PR to trigger a release.

Manual fallback — tag a version and push:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow will automatically build native binaries for all supported platforms and create a GitHub Release with all artifacts attached.

### CI pipeline

- **Pull requests & pushes to main** — runs tests, build, and verifies the standalone binary can be compiled (`.github/workflows/ci.yml`)
- **Version tags (`v*`)** — builds the binary and publishes it as a GitHub Release (`.github/workflows/release.yml`)
- **Manual testing** — maintainers can trigger `.github/workflows/test-release.yml` via the Actions tab to test the build pipeline without publishing

## License

ISC

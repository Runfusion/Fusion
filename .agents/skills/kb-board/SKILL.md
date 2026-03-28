---
name: kb-board
description: Start and manage the kb dashboard web UI and AI engine. Use when asked to start the board, run the dashboard, enable the AI engine, or configure kb settings.
---

# kb board

## Start the dashboard

```bash
kb dashboard
```

Opens the kanban board at http://localhost:4040 and starts the AI engine.

The AI engine provides:
- **Triage processor** — auto-specifies tasks in the triage column
- **Scheduler** — moves todo tasks to in-progress when dependencies are met
- **Executor** — runs tasks in git worktrees via AI agents
- **Auto-merge** — squash-merges completed tasks to main
- **Cross-model review** — independent reviewer agent checks work at step boundaries

Options:
- `--port <N>` or `-p <N>` — custom port (default: 4040)
- `--no-open` — don't open the browser automatically

### Development mode

Run in two terminals:

```bash
# Terminal 1: start the server + engine
kb dashboard

# Terminal 2: watch-rebuild the React dashboard UI
pnpm dev:ui
```

## Configuration

Settings are in `.kb/config.json`:

```json
{
  "nextId": 27,
  "settings": {
    "maxConcurrent": 4,
    "maxWorktrees": 4,
    "pollIntervalMs": 15000,
    "autoMerge": true
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `maxConcurrent` | Max tasks executing simultaneously | 2 |
| `maxWorktrees` | Max git worktrees | 4 |
| `pollIntervalMs` | Scheduler/triage poll interval | 15000 |
| `autoMerge` | Auto-merge tasks when they reach in-review | true |

## Task storage

Tasks live in `.kb/tasks/`:

```
.kb/
├── config.json
└── tasks/
    └── KB-001/
        ├── task.json    # Metadata, steps, log
        └── PROMPT.md    # Task specification
```

## Prerequisites

The AI engine requires [pi](https://github.com/badlogic/pi-mono) with
configured API keys. Run `pi` first to set up authentication.

# Standalone CLI

kb works as a standalone CLI without pi. This is useful for CI environments, scripting, or if you prefer working from the terminal.

## Installation

```bash
npm install -g @dustinbyrne/kb
```

## Authentication

kb uses [pi](https://github.com/badlogic/pi-mono) for AI agent sessions and reuses your existing pi authentication. You can also authenticate directly through the dashboard UI.

If you don't have pi set up yet: `npm i -g @mariozechner/pi-coding-agent && pi` then `/login`.

## Usage

### Start the dashboard

Launch the web UI and AI engine:

```bash
kb dashboard
kb dashboard --port 8080
kb dashboard --paused        # Start with automation paused (review before work begins)
kb dashboard --dev           # Start web UI only (no AI engine)
```

### Create a task

```bash
kb task create "Fix the login redirect bug"
kb task create "Update hero section" --attach screenshot.png --attach design.pdf
```

### Manage tasks

```bash
kb task list                        # List all tasks
kb task show KB-001                 # Show task details, steps, and log
kb task move KB-001 todo            # Move a task to a column
kb task merge KB-001                # Merge an in-review task and close it
kb task log KB-001 "Added context"  # Add a log entry
kb task pause KB-001                # Pause a task (stops automation)
kb task unpause KB-001              # Resume a paused task
kb task attach KB-001 ./error.log   # Attach a file to a task
kb task import owner/repo           # Import GitHub issues as tasks
kb task import owner/repo --limit 10 --labels "bug,enhancement"
```

### Typical workflow

```bash
# 1. Create a task — it lands in triage
kb task create "Add dark mode support"

# 2. Start the dashboard — AI specs the task and begins working
kb dashboard

# 3. Check progress
kb task list
kb task show KB-042

# 4. When it reaches "in-review", review the changes and merge
kb task merge KB-042
```

## Standalone binary

Prebuilt standalone binaries are available that require no Node.js runtime. You can also build one yourself with [Bun](https://bun.sh/):

```bash
bun run build.ts
```

See the [GitHub repository](https://github.com/dustinbyrne/kb) for platform-specific binaries and build instructions.

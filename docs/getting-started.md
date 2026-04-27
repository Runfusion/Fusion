# Getting Started

[← Docs index](./README.md)

This guide walks you from install to your first task in Fusion.

## Install Fusion

Choose one of these install methods from the [README quick start](../README.md#quick-start):

### Zero install (recommended)

Run Fusion directly from npm without a global install:

```bash
npx runfusion.ai
```

This launches the dashboard immediately. You can also run subcommands the same way (for example, `npx runfusion.ai task create "fix X"`).

### One-line installer (macOS & Linux)

```bash
curl -fsSL https://runfusion.ai/install.sh | sh
fusion dashboard
```

### Homebrew (macOS & Linux)

```bash
brew tap runfusion/fusion
brew install fusion
fusion dashboard            # or: fn dashboard
```

### npm global

```bash
npm install -g @runfusion/fusion
fn dashboard                # or: fusion dashboard
```

### From source (development)

```bash
pnpm dev dashboard
```

After installing, verify the CLI is available:

```bash
fn --help
# or
fusion --help
```

> **Optional — Pi extension:** To use Fusion tools inside [Pi](https://pi.dev) chat sessions, run `pi install npm:@runfusion/fusion`. This adds a `/fn` command and Fusion tools within pi. You do **not** need this to use Fusion — the global CLI and dashboard work standalone.

## Initialize a Project

In each repository you want Fusion to manage, run:

```bash
fn init
```

On fresh init, Fusion also installs its bundled `fusion` skill into supported agent homes (`~/.claude/skills/fusion`, `~/.codex/skills/fusion`, `~/.gemini/skills/fusion`) when those targets are missing. Existing installs are left untouched.

## First Run and Onboarding

Start the dashboard:

```bash
fn dashboard
```

On first launch, Fusion opens an onboarding wizard with three steps:

1. **AI Setup** — choose a provider and authenticate (you only need one to start)
2. **GitHub (Optional)** — connect GitHub for issue import and PR workflows
3. **First Task** — create your first task or import one from GitHub

The wizard is dismissible and non-blocking. You can skip it and continue using Fusion, then reopen it later from **Settings → Authentication**.

On startup, Fusion prints an `Open:` URL that includes a bearer token (for example, `http://localhost:4040/?token=fn_...`). Open that URL to sign in quickly.

## Create Your First Task

Create tasks from the board or CLI.

### Option A: Quick Entry (Board)

1. Type a short request in the quick entry input.
2. Press Enter.
3. Task appears in **Planning** and the planning agent generates `PROMPT.md`.

### Option B: Plan Mode (Board)

Use the 💡 button to open AI planning mode:

- Fusion asks clarifying questions
- Produces a structured summary
- Lets you create one task or multiple dependency-linked tasks

### Option C: Subtask Breakdown (Board)

Use the 🌳 button to generate 2–5 subtasks, reorder them, and link dependencies before creating tasks.

You can also use expanded board controls (Refine, Deps, Attachments, model overrides, agent assignment) or the CLI (`fn task create`, `fn task plan`) when needed.

## Understand the Task Lifecycle

Fusion uses six columns:

1. **Planning** — raw idea; AI writes plan
2. **Todo** — planned and queued
3. **In Progress** — executor implements in a dedicated worktree
4. **In Review** — implementation complete, awaiting merge/finalization
5. **Done** — merged and complete
6. **Archived** — retained for history, optionally cleaned up from filesystem

## Daily CLI Commands

```bash
fn task list
fn task show FN-001
fn task logs FN-001 --follow --limit 50
fn task steer FN-001 "Prefer existing utility functions"
fn task pause FN-001
fn task unpause FN-001
```

## Next Steps

- [Architecture](./architecture.md) — system internals and package layout
- [Task Management](./task-management.md) — deeper task workflow and lifecycle details
- [Dashboard Guide](./dashboard-guide.md) — board and UI features
- [Settings Reference](./settings-reference.md) — project and global configuration

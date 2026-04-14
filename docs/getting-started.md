# Getting Started

[← Docs index](./README.md)

This guide gets Fusion running, explains first-run setup, and walks through your first task from creation to completion.

## Prerequisites

Fusion uses the `pi` agent runtime for AI sessions.

1. Install pi:

```bash
npm i -g @mariozechner/pi-coding-agent
```

2. Authenticate pi (for example with `/login`) or configure provider API keys.

```bash
pi
```

## Install Fusion

Install the published CLI package globally:

```bash
npm i -g @gsxdsm/fusion
```

Then verify install:

```bash
fn --help
```

## First Run and Onboarding

Start the dashboard:

```bash
fn dashboard
```

On first launch, Fusion automatically opens the **onboarding wizard**. It guides you through three steps:

1. **AI Setup** — Connect an AI provider and choose a default model. Authenticate via OAuth login or enter an API key.

2. **GitHub (Optional)** — Connect GitHub to import issues and manage pull requests. This step is optional — you can continue without GitHub.

3. **First Task** — Get started by creating your first task or importing from GitHub.

**The onboarding wizard is dismissible and non-blocking.** If you skip setup, you can complete it later:
- Click **Skip for now** to dismiss the wizard — the dashboard remains fully usable
- After dismissing, a **Continue Setup** banner appears at the top of the dashboard, letting you resume from where you left off
- Re-open onboarding anytime from **Settings → Authentication**, or by clearing the `modelOnboardingComplete` flag in global settings

Onboarding completion is tracked by `modelOnboardingComplete` in global settings.

## Start the Dashboard

Common startup options:

```bash
fn dashboard                       # default port 4040
fn dashboard --port 5050          # custom port
fn dashboard --interactive        # choose port interactively
fn dashboard --paused             # start with automation paused
fn dashboard --dev                # run UI only (no engine)
```

Open: `http://localhost:4040`

## Create Your First Task

You can create tasks from the board or CLI.

### Option A: Quick Entry (Board)

1. Type a short request in the quick entry input.
2. Press Enter.
3. Task appears in **Triage** and the triage agent generates `PROMPT.md`.

### Option B: Plan Mode (Board)

Use the 💡 button to open AI planning mode:

- Fusion asks clarifying questions
- Produces a structured summary
- Lets you create one task or break into multiple dependency-linked tasks

### Option C: Subtask Breakdown (Board)

Use the 🌳 button to:

- Generate 2–5 subtasks
- Reorder by drag-and-drop
- Add dependency links before creating tasks

### Option D: Expanded Controls (Board)

Expand the quick entry panel (▼) to access additional controls:

- **Refine** (✨) — Improve the description with AI
- **Deps** (🔗) — Link existing tasks as dependencies
- **Attach** — Add image attachments
- **Models** (🧠) — Set per-task model overrides
- **Agent** — Assign an agent to the task
- **Save** — Create the task manually

### Option E: CLI

```bash
fn task create "Fix flaky login test"
fn task plan "Implement role-based access control"
```

## Understand the Task Lifecycle

Fusion uses six columns:

1. **Triage** — raw idea; AI writes spec
2. **Todo** — specified and queued
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

## Dashboard Orientation (Annotated)

![Dashboard board view with key UI areas](./screenshots/dashboard-overview.png)

Suggested way to read the screen:

- **Top bar:** global actions (settings, activity, mission/agent tools)
- **Columns:** task lifecycle stages
- **Task cards:** status, metadata, PR/issue badges
- **Quick entry:** fastest way to create a new task

Next: [Architecture](./architecture.md) for internals, or [Task Management](./task-management.md) for deeper task workflows.

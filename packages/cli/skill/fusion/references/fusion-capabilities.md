# Fusion Capabilities Catalog

## Overview

Fusion (kb) is an AI-orchestrated task board. Tasks flow through columns:
Triage → Todo → In Progress → In Review → Done → Archived

## Pi Extension Tools (Available to Agents)

All skill/extension tool invocations in this catalog use the public `fn_*` namespace. Engine runtime tools (for example `task_create`, `task_update`, `task_log`, `task_done`) are internal and intentionally not listed here.

| Tool | Purpose |
|------|---------|
| `fn_task_create` | Create a new task in triage |
| `fn_task_update` | Update task title, description, or dependencies |
| `fn_task_list` | List all tasks grouped by column |
| `fn_task_show` | Show full task details, steps, log |
| `fn_task_attach` | Attach a file to a task |
| `fn_task_pause` | Pause automation for a task |
| `fn_task_unpause` | Resume automation for a task |
| `fn_task_retry` | Retry a failed task (clears error, moves to todo) |
| `fn_task_duplicate` | Duplicate a task (copy to triage) |
| `fn_task_refine` | Create refinement task for follow-up work |
| `fn_task_archive` | Archive a done task |
| `fn_task_unarchive` | Restore an archived task |
| `fn_task_delete` | Permanently delete a task |
| `fn_task_import_github` | Batch import GitHub issues as tasks |
| `fn_task_import_github_issue` | Import a single GitHub issue |
| `fn_task_browse_github_issues` | Browse GitHub issues before importing |
| `fn_task_plan` | Create task via AI-guided planning mode |
| `fn_mission_create` | Create a new mission |
| `fn_mission_list` | List all missions |
| `fn_mission_show` | Show mission hierarchy |
| `fn_mission_delete` | Delete a mission |
| `fn_milestone_add` | Add a milestone to a mission |
| `fn_slice_add` | Add a slice to a milestone |
| `fn_feature_add` | Add a feature to a slice |
| `fn_slice_activate` | Activate a pending slice |
| `fn_feature_link_task` | Link a feature to a task |
| `fn_agent_stop` | Stop (pause) a running agent |
| `fn_agent_start` | Start (resume) a stopped agent |
| `fn_skills_search` | Search skills.sh for agent skills |
| `fn_skills_install` | Install a skill from skills.sh |

## CLI Commands (fn)

### Dashboard
- `fn dashboard` — Start web UI + AI engine
- `fn dashboard --paused` — Start with automation paused
- `fn dashboard --dev` — Start web UI only (no AI engine)

### Task Management
- `fn task create "description"` — Create a new task
- `fn task plan "description"` — AI-guided planning mode
- `fn task list` — List all tasks
- `fn task show KB-001` — Show task details
- `fn task move KB-001 todo` — Move task to a column
- `fn task merge KB-001` — Merge an in-review task
- `fn task duplicate KB-001` — Duplicate a task
- `fn task refine KB-001 --feedback "..."` — Create refinement task
- `fn task archive/unarchive KB-001` — Archive/restore tasks
- `fn task delete KB-001` — Delete a task
- `fn task retry KB-001` — Retry a failed task
- `fn task comment KB-001 "..."` — Add a task comment
- `fn task steer KB-001 "..."` — Add steering comment
- `fn task pause/unpause KB-001` — Control automation
- `fn task logs KB-001` — View task agent logs

### GitHub Integration
- `fn task import owner/repo` — Batch import issues
- `fn task import owner/repo -i` — Interactive import
- `fn task pr-create KB-001` — Create PR for task

### Git Commands
- `fn git status/fetch/pull/push` — Git operations

### Settings
- `fn settings` — Show current settings
- `fn settings set key value` — Update a setting

## AI Engine Components

1. **TriageProcessor** — Auto-specifications for tasks in triage column
2. **Scheduler** — Dependency resolution, concurrency management
3. **TaskExecutor** — Creates worktrees, executes tasks with coding tools

## Task Storage Structure

```
.fusion/
├── fusion.db                # SQLite database (WAL mode)
└── tasks/
    └── KB-001/
        ├── PROMPT.md        # Task specification
        ├── agent.log        # Execution logs
        └── attachments/     # File attachments
```

## Dashboard Features

- Real-time kanban board with drag-and-drop
- Board view and list view
- Task detail modal with tabs (Details, Spec, Model, Workflow, Comments)
- Git manager (commits, branches, worktrees)
- Activity log
- Settings modal
- Workflow step manager
- Scheduled tasks (automations)
- GitHub import modal
- Theme system (8+ themes, dark/light/system)

## Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `maxConcurrent` | 2 | Concurrent task execution lanes (executor + merge). Triage/specification is controlled by `maxTriageConcurrent`. |
| `maxTriageConcurrent` | 2 | Concurrent triage/specification agents. Falls back to `maxConcurrent` when undefined. |
| `autoMerge` | true | Auto-merge completed tasks |
| `requirePlanApproval` | false | Manual approval for specs |
| `prCompletionMode` | direct | Completion: direct/pr-first |
| `taskStuckTimeoutMs` | — | Stuck task detection timeout |
| `recycleWorktrees` | false | Pool and reuse worktrees |

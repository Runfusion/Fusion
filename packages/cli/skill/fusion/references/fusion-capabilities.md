# Fusion Capabilities Catalog

## Overview

Fusion is an AI-orchestrated task board. Tasks flow through columns:
Triage → Todo → In Progress → In Review → Done → Archived

## Pi Extension Tools (Available to Agents)

All skill/extension tool invocations in this catalog use the public `fn_*` namespace. Engine runtime tools (for example `task_create`, `task_update`, `task_log`, `task_done`) are internal and intentionally not listed here.

| Tool | Purpose |
|------|---------|
| `fn_task_create` | Create a new task in triage |
| `fn_task_update` | Update task title, description, or dependencies |
| `fn_task_list` | List all tasks grouped by column |
| `fn_task_show` | Show full task details, steps, and log preview |
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

### Dashboard and Node Runtime
- `fn dashboard` — Start web UI + AI engine
- `fn dashboard --paused` — Start with automation paused
- `fn dashboard --dev` — Start web UI only (no AI engine)
- `fn serve` — Start headless node mode (API + engine, no UI)
- `fn daemon` — Start daemon mode with auth

### Task Management
- `fn task create "description"` — Create a new task
- `fn task plan "description"` — AI-guided planning mode
- `fn task list` — List all tasks
- `fn task show FN-001` — Show task details
- `fn task move FN-001 todo` — Move task to a column
- `fn task merge FN-001` — Merge an in-review task
- `fn task duplicate FN-001` — Duplicate a task
- `fn task refine FN-001 --feedback "..."` — Create refinement task
- `fn task archive FN-001` / `fn task unarchive FN-001` — Archive/restore tasks
- `fn task delete FN-001` — Delete a task
- `fn task retry FN-001` — Retry a failed task
- `fn task comment FN-001 "..."` — Add a task comment
- `fn task steer FN-001 "..."` — Add steering comment
- `fn task pause FN-001` / `fn task unpause FN-001` — Control automation
- `fn task logs FN-001` — View task agent logs

### GitHub, Skills, and Settings
- `fn task import owner/repo` — Batch import issues
- `fn task pr-create FN-001` — Create PR for task
- `fn skills search "react"` — Search skill registry
- `fn skills install owner/repo --skill <name>` — Install a skill
- `fn settings` / `fn settings set key value` — View/update settings

## Task Storage Structure

```
.fusion/
├── fusion.db                # SQLite database (WAL mode)
└── tasks/
    └── FN-001/
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
- Theme system with dark/light support and color themes

## Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `maxConcurrent` | 2 | Concurrent task execution lanes (executor + merge). Triage/specification is controlled by `maxTriageConcurrent`. |
| `maxTriageConcurrent` | 2 | Concurrent triage/specification agents. Falls back to `maxConcurrent` when undefined. |
| `autoMerge` | true | Auto-merge completed tasks |
| `requirePlanApproval` | false | Manual approval for specs |
| `prCompletionMode` | direct | Completion mode: direct/pr-first |
| `taskStuckTimeoutMs` | — | Stuck task detection timeout |
| `recycleWorktrees` | false | Pool and reuse worktrees |

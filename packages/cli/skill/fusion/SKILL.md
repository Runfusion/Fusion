---
name: fusion
description: AI-orchestrated task board (Fusion/kb) interface. Use when working with the Fusion task management system, creating or managing tasks, understanding task workflows, organizing work into missions, or interfacing with the kb dashboard. Triggers on "create a task", "list tasks", "show board", "plan a mission", "check task status", "import issues", or any Fusion/kb interaction.
---

<essential_principles>

Fusion (kb) is an AI-orchestrated task board. You throw in rough ideas; AI specifies, executes, reviews, and delivers them.

**Task lifecycle:** Triage → Todo → In Progress → In Review → Done → Archived

- **Triage** — AI auto-generates a full specification (PROMPT.md) with steps, file scope, and acceptance criteria
- **Todo** — Scheduler resolves dependencies and queues for execution
- **In Progress** — Executor agent works in a git worktree: plan → review → execute → review per step
- **In Review** — Completed work ready for merge (auto-merge or PR-based)
- **Done** — Merged to main branch
- **Archived** — Removed from active board view

**Missions** provide hierarchical planning above tasks:
Mission → Milestone → Slice → Feature → Task

**Available tools:** Fusion registers tools via the pi extension (prefixed `kb_*`). No CLI commands or Bash needed — use the registered tools directly.

**Tool categories:**
- **Task tools** — `kb_task_create`, `kb_task_update`, `kb_task_list`, `kb_task_show`, `kb_task_attach`, `kb_task_pause`, `kb_task_unpause`, `kb_task_retry`, `kb_task_duplicate`, `kb_task_refine`, `kb_task_archive`, `kb_task_unarchive`, `kb_task_delete`, `kb_task_plan`
- **GitHub tools** — `kb_task_import_github`, `kb_task_import_github_issue`, `kb_task_browse_github_issues`
- **Mission tools** — `kb_mission_create`, `kb_mission_list`, `kb_mission_show`, `kb_mission_delete`, `kb_milestone_add`, `kb_slice_add`, `kb_feature_add`, `kb_slice_activate`, `kb_feature_link_task`
- **Dashboard** — Use `/fn` command to start/stop the dashboard

</essential_principles>

<routing>

Based on the user's request, route to the appropriate workflow:

**Task operations:**
- Create, list, show, manage tasks → workflows/task-management.md
- Understand task columns, lifecycle, statuses → workflows/task-lifecycle.md

**Planning and specifications:**
- Plan complex work, break down ideas → workflows/specifications.md
- Organize into missions, milestones, slices → workflows/specifications.md

**Dashboard and CLI:**
- Start dashboard, use CLI commands, settings → workflows/dashboard-cli.md

**If the intent is simple and clear** (e.g., "create a task to fix the login bug"), execute directly using the appropriate `kb_*` tool without loading a workflow file. Only load workflows for guidance on complex operations or when the user needs help understanding Fusion concepts.

</routing>

<quick_reference>

**Create a task:**
Use `kb_task_create` with a descriptive message. Include the problem AND desired outcome.

**List tasks:**
Use `kb_task_list` to see all tasks grouped by column. Use `column` param to filter.

**Show task details:**
Use `kb_task_show` with the task ID (e.g., KB-001) to see steps, progress, and log.

**Plan complex work:**
Use `kb_task_plan` for AI-guided planning that interviews you before creating the task.

**Import GitHub issues:**
Use `kb_task_browse_github_issues` to preview, then `kb_task_import_github_issue` for specific issues.

**Start dashboard:**
Use `/fn` command. `/fn stop` to stop. `/fn status` to check.

**Mission planning:**
Use `kb_mission_create` for high-level objectives, then add milestones, slices, and features.

</quick_reference>

<known_limitations>

These operations are **not available** via pi extension tools and require the dashboard or CLI:

- **Moving tasks between columns** — No tool for column moves (handled by the AI engine)
- **Workflow steps** — Creating/managing workflow step definitions requires the dashboard
- **Settings** — Changing settings requires the dashboard or `fn settings set` CLI command
- **Steering comments** — Adding steering comments to guide task execution requires CLI (`fn task steer`)
- **Merge operations** — Merging completed tasks requires CLI (`fn task merge`) or auto-merge

For these operations, guide the user to the dashboard (`/fn`) or CLI commands documented in workflows/dashboard-cli.md.

</known_limitations>

<reference_index>

| Reference | When to Use |
|-----------|-------------|
| references/cli-commands.md | Full CLI command reference |
| references/task-structure.md | Task file structure and storage |
| references/extension-tools.md | All pi extension tools with parameters |
| references/best-practices.md | Tips for effective Fusion usage |
| references/fusion-capabilities.md | Complete feature catalog |
| references/skill-patterns.md | Patterns used in this skill's design |

</reference_index>

---
name: fusion
description: AI-orchestrated task board (Fusion) interface. Use when working with the Fusion task management system, creating or managing tasks, understanding task workflows, organizing work into missions, or interfacing with the fusion dashboard. Triggers on "create a task", "list tasks", "show board", "plan a mission", "check task status", "import issues", or any Fusion interaction.
---

<essential_principles>

Fusion is an AI-orchestrated task board. You throw in rough ideas; AI specifies, executes, reviews, and delivers them.

**Task lifecycle:** Triage → Todo → In Progress → In Review → Done → Archived

- **Triage** — AI auto-generates a full specification (PROMPT.md) with steps, file scope, and acceptance criteria
- **Todo** — Scheduler resolves dependencies and queues for execution
- **In Progress** — Executor agent works in a git worktree: plan → review → execute → review per step
- **In Review** — Completed work ready for merge (auto-merge or PR-based)
- **Done** — Merged to main branch
- **Archived** — Removed from active board view

**Missions** provide hierarchical planning above tasks:
Mission → Milestone → Slice → Feature → Task

**Available tools:** Fusion registers tools via the pi extension (prefixed `fn_*`). No CLI commands or Bash needed — use the registered tools directly.

**Naming boundary:** The published skill surface always uses `fn_*` tool names (for example `fn_task_create`, `fn_mission_create`). Internal engine runtime tools like `task_create`, `task_update`, `task_log`, and `task_done` are intentionally unprefixed and not part of this skill.

**Tool categories:**
- **Task tools** — `fn_task_create`, `fn_task_update`, `fn_task_list`, `fn_task_show`, `fn_task_attach`, `fn_task_pause`, `fn_task_unpause`, `fn_task_retry`, `fn_task_duplicate`, `fn_task_refine`, `fn_task_archive`, `fn_task_unarchive`, `fn_task_delete`, `fn_task_plan`
- **GitHub tools** — `fn_task_import_github`, `fn_task_import_github_issue`, `fn_task_browse_github_issues`
- **Mission tools** — `fn_mission_create`, `fn_mission_list`, `fn_mission_show`, `fn_mission_delete`, `fn_milestone_add`, `fn_slice_add`, `fn_feature_add`, `fn_slice_activate`, `fn_feature_link_task`
- **Agent tools** — `fn_agent_stop`, `fn_agent_start`
- **Skills tools** — `fn_skills_search`, `fn_skills_install`
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

**If the intent is simple and clear** (e.g., "create a task to fix the login bug"), execute directly using the appropriate `fn_*` tool without loading a workflow file. Only load workflows for guidance on complex operations or when the user needs help understanding Fusion concepts.

</routing>

<quick_reference>

**Create a task:**
Use `fn_task_create` with a descriptive message. Include the problem AND desired outcome.

**List tasks:**
Use `fn_task_list` to see all tasks grouped by column. Use `column` param to filter.

**Show task details:**
Use `fn_task_show` with the task ID (e.g., KB-001) to see steps, progress, and log.

**Plan complex work:**
Use `fn_task_plan` for AI-guided planning that interviews you before creating the task.

**Import GitHub issues:**
Use `fn_task_browse_github_issues` to preview, then `fn_task_import_github_issue` for specific issues.

**Start dashboard:**
Use `/fn` command. `/fn stop` to stop. `/fn status` to check.

**Mission planning:**
Use `fn_mission_create` for high-level objectives, then add milestones, slices, and features.

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

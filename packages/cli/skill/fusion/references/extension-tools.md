# Fusion Pi Extension Tools

All tools are registered via the pi extension. They are available in any pi agent session when the Fusion extension is installed.

> Naming contract: all externally exposed Fusion extension tools are `fn_*` (for example `fn_task_create`). Internal engine/executor runtime tools (`task_create`, `task_update`, `task_log`, `task_done`, etc.) are separate and intentionally out of scope for this skill surface.

## Task Tools

### fn_task_create

Create a new task on the Fusion board. Enters triage for AI specification.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `description` | string | ✓ | What needs to be done — be descriptive |
| `depends` | string[] | — | Task IDs this depends on (e.g., ["FN-001"]) |

Returns: task ID, column, dependencies, path

### fn_task_update

Update fields on an existing task (title, description, dependencies).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (e.g., FN-001) |
| `title` | string | — | New task title |
| `description` | string | — | New task description |
| `depends` | string[] | — | New dependency list — replaces existing |

Returns: task ID, list of updated fields

### fn_task_list

List all tasks grouped by column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | — | Filter to specific column |
| `limit` | number | — | Max tasks per column (default: 10) |

Returns: formatted task list grouped by column

### fn_task_show

Show full task details including steps, progress, prompt preview, and log.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (e.g., FN-001) |

Returns: task details with steps, prompt preview (500 chars), last 5 log entries

### fn_task_attach

Attach a file to a task. Copies file to task's attachments directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID |
| `path` | string | ✓ | Path to file to attach |

Supported formats: png, jpg, jpeg, gif, webp, txt, log, json, yaml, yml, toml, csv, xml

### fn_task_pause

Pause automation for a task. Scheduler and executor will skip this task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID |

### fn_task_unpause

Resume automation for a paused task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID |

### fn_task_retry

Retry a failed task. Clears error state, moves to todo for re-execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (must be in failed state) |

### fn_task_duplicate

Duplicate a task. Creates a fresh copy in triage with same title and description.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Source task ID to duplicate |

### fn_task_refine

Create a follow-up task for a completed task. New task depends on the original.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (must be done or in-review) |
| `feedback` | string | ✓ | What needs to be refined (1-2000 chars) |

### fn_task_archive

Archive a done task. Moves from done → archived.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (must be in done column) |

### fn_task_unarchive

Restore an archived task. Moves from archived → done.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (must be in archived column) |

### fn_task_delete

Permanently delete a task. Cannot be undone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID |

### fn_task_plan

Create a task via AI-guided planning mode. Non-interactive when called from extension.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `description` | string | — | Initial plan description |

## GitHub Tools

### fn_task_import_github

Batch import GitHub issues as Fusion tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ownerRepo` | string | ✓ | Repository (e.g., "owner/repo") |
| `limit` | number | — | Max issues (default: 30, max: 100) |
| `labels` | string[] | — | Label names to filter by |

### fn_task_import_github_issue

Import a single GitHub issue by number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | ✓ | Repository owner |
| `repo` | string | ✓ | Repository name |
| `issueNumber` | number | ✓ | GitHub issue number |

### fn_task_browse_github_issues

Browse open issues from a repository before importing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | ✓ | Repository owner |
| `repo` | string | ✓ | Repository name |
| `limit` | number | — | Max issues (default: 30, max: 100) |
| `labels` | string[] | — | Label names to filter by |

## Mission Tools

### fn_mission_create

Create a new mission — a high-level objective spanning multiple milestones.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | ✓ | Mission title |
| `description` | string | — | Detailed objectives and context |
| `autoAdvance` | boolean | — | Auto-activate next slice on completion |

### fn_mission_list

List all missions with current status. No parameters.

### fn_mission_show

Show mission details with full hierarchy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Mission ID (e.g., M-001) |

### fn_mission_delete

Delete a mission and all children. Tasks are NOT deleted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Mission ID |

### fn_milestone_add

Add a milestone to a mission.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionId` | string | ✓ | Parent mission ID |
| `title` | string | ✓ | Milestone title |
| `description` | string | — | Milestone description |

### fn_slice_add

Add a slice to a milestone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `milestoneId` | string | ✓ | Parent milestone ID |
| `title` | string | ✓ | Slice title |
| `description` | string | — | Slice description |

### fn_feature_add

Add a feature to a slice.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sliceId` | string | ✓ | Parent slice ID |
| `title` | string | ✓ | Feature title |
| `description` | string | — | Feature description |
| `acceptanceCriteria` | string | — | Acceptance criteria |

### fn_slice_activate

Activate a pending slice for implementation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Slice ID (must be pending) |

### fn_feature_link_task

Link a feature to a kb task. Updates feature status to triaged.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `featureId` | string | ✓ | Feature ID (e.g., F-001) |
| `taskId` | string | ✓ | Task ID (e.g., FN-001) |

### fn_agent_stop

Stop (pause) a running agent. Transitions the agent from running/active to paused state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Agent ID to stop (e.g., agent-abc123) |

### fn_agent_start

Start (resume) a stopped agent. Transitions the agent from paused to active state.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Agent ID to start (e.g., agent-abc123) |

## Skills Tools

### fn_skills_search

Search the skills.sh directory for agent skills. Returns matching skills with names, sources, install counts, and install commands.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | ✓ | Search query — framework, technology, or capability (e.g., "react", "firebase", "testing", "docker") |
| `limit` | number | — | Max results (default: 10, max: 50) |

### fn_skills_install

Install an agent skill from skills.sh into the current project. Downloads skill files into the project's skill directories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | ✓ | GitHub source in owner/repo format (e.g., "firebase/agent-skills") |
| `skill` | string | — | Specific skill name to install. Omit to install all skills from the source. |

## Dashboard Command

### /fn

Start or stop the Fusion dashboard from within a pi session.

| Command | Description |
|---------|-------------|
| `/fn` | Start dashboard on port 4040 |
| `/fn 8080` | Start on custom port |
| `/fn stop` | Stop dashboard |
| `/fn status` | Check if running |

# Fusion Pi Extension Tools

All tools are registered via the pi extension. They are available in any pi agent session when the Fusion extension is installed.

## Task Tools

### kb_task_create

Create a new task on the Fusion board. Enters triage for AI specification.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `description` | string | ✓ | What needs to be done — be descriptive |
| `depends` | string[] | — | Task IDs this depends on (e.g., ["KB-001"]) |

Returns: task ID, column, dependencies, path

### kb_task_update

Update fields on an existing task (title, description, dependencies).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (e.g., KB-001) |
| `title` | string | — | New task title |
| `description` | string | — | New task description |
| `depends` | string[] | — | New dependency list — replaces existing |

Returns: task ID, list of updated fields

### kb_task_list

List all tasks grouped by column.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `column` | string | — | Filter to specific column |
| `limit` | number | — | Max tasks per column (default: 10) |

Returns: formatted task list grouped by column

### kb_task_show

Show full task details including steps, progress, prompt preview, and log.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (e.g., KB-001) |

Returns: task details with steps, prompt preview (500 chars), last 5 log entries

### kb_task_attach

Attach a file to a task. Copies file to task's attachments directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID |
| `path` | string | ✓ | Path to file to attach |

Supported formats: png, jpg, jpeg, gif, webp, txt, log, json, yaml, yml, toml, csv, xml

### kb_task_pause

Pause automation for a task. Scheduler and executor will skip this task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID |

### kb_task_unpause

Resume automation for a paused task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID |

### kb_task_retry

Retry a failed task. Clears error state, moves to todo for re-execution.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (must be in failed state) |

### kb_task_duplicate

Duplicate a task. Creates a fresh copy in triage with same title and description.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Source task ID to duplicate |

### kb_task_refine

Create a follow-up task for a completed task. New task depends on the original.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (must be done or in-review) |
| `feedback` | string | ✓ | What needs to be refined (1-2000 chars) |

### kb_task_archive

Archive a done task. Moves from done → archived.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (must be in done column) |

### kb_task_unarchive

Restore an archived task. Moves from archived → done.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID (must be in archived column) |

### kb_task_delete

Permanently delete a task. Cannot be undone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Task ID |

### kb_task_plan

Create a task via AI-guided planning mode. Non-interactive when called from extension.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `description` | string | — | Initial plan description |

## GitHub Tools

### kb_task_import_github

Batch import GitHub issues as Fusion tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ownerRepo` | string | ✓ | Repository (e.g., "owner/repo") |
| `limit` | number | — | Max issues (default: 30, max: 100) |
| `labels` | string[] | — | Label names to filter by |

### kb_task_import_github_issue

Import a single GitHub issue by number.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | ✓ | Repository owner |
| `repo` | string | ✓ | Repository name |
| `issueNumber` | number | ✓ | GitHub issue number |

### kb_task_browse_github_issues

Browse open issues from a repository before importing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `owner` | string | ✓ | Repository owner |
| `repo` | string | ✓ | Repository name |
| `limit` | number | — | Max issues (default: 30, max: 100) |
| `labels` | string[] | — | Label names to filter by |

## Mission Tools

### kb_mission_create

Create a new mission — a high-level objective spanning multiple milestones.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | ✓ | Mission title |
| `description` | string | — | Detailed objectives and context |
| `autoAdvance` | boolean | — | Auto-activate next slice on completion |

### kb_mission_list

List all missions with current status. No parameters.

### kb_mission_show

Show mission details with full hierarchy.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Mission ID (e.g., M-001) |

### kb_mission_delete

Delete a mission and all children. Tasks are NOT deleted.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Mission ID |

### kb_milestone_add

Add a milestone to a mission.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `missionId` | string | ✓ | Parent mission ID |
| `title` | string | ✓ | Milestone title |
| `description` | string | — | Milestone description |

### kb_slice_add

Add a slice to a milestone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `milestoneId` | string | ✓ | Parent milestone ID |
| `title` | string | ✓ | Slice title |
| `description` | string | — | Slice description |

### kb_feature_add

Add a feature to a slice.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sliceId` | string | ✓ | Parent slice ID |
| `title` | string | ✓ | Feature title |
| `description` | string | — | Feature description |
| `acceptanceCriteria` | string | — | Acceptance criteria |

### kb_slice_activate

Activate a pending slice for implementation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | ✓ | Slice ID (must be pending) |

### kb_feature_link_task

Link a feature to a kb task. Updates feature status to triaged.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `featureId` | string | ✓ | Feature ID (e.g., F-001) |
| `taskId` | string | ✓ | Task ID (e.g., KB-001) |

## Dashboard Command

### /fn

Start or stop the Fusion dashboard from within a pi session.

| Command | Description |
|---------|-------------|
| `/fn` | Start dashboard on port 4040 |
| `/fn 8080` | Start on custom port |
| `/fn stop` | Stop dashboard |
| `/fn status` | Check if running |

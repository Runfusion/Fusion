# Task Management

[← Docs index](./README.md)

This guide covers task creation, lifecycle behavior, task metadata, and operational workflows.

## Task Creation Options

### 1) Quick Entry (dashboard)

Use the inline input on board/list view:

- Type description
- Press Enter
- Task is created in `planning`

### 2) Plan Mode (AI interview)

Use the 💡 button to open planning mode:

- AI asks clarifying questions
- Produces summary + key deliverables
- Create one task or **Break into Tasks** (multi-task generation with dependencies)

### 3) Subtask Breakdown Dialog

Use the 🌳 button:

- Generate 2–5 candidate subtasks
- Drag to reorder
- Add dependencies only on earlier items
- Create tasks in one action

### 4) Expanded Controls

Expand the creation panel (▼) to access additional controls:

- **Refine** (✨) — Improve the description with AI
- **Deps** (🔗) — Link existing tasks as dependencies
- **Attach** — Add image attachments
- **Models** (🧠) — Set per-task model overrides (executor, validator, planning)
- **Agent** — Assign an agent to the task
- **Review** — Set review rigor level (None, Plan Only, Plan and Code, Full)
- **Browser Verify** — Enable browser verification workflow step

### 5) CLI creation

```bash
fn task create "Fix API timeout handling"
fn task plan "Implement role-based access control"
fn task create "Bug" --attach screenshot.png --depends FN-002
```

## Task Lifecycle

Fusion task columns:

1. **planning** — idea intake; AI writes a full plan
2. **todo** — ready for scheduling
3. **in-progress** — executor active in isolated worktree
4. **in-review** — implementation complete; awaiting finalization
5. **done** — merged/finalized
6. **archived** — preserved history, optionally cleaned from filesystem

### Lifecycle commands

```bash
fn task move FN-001 todo
fn task merge FN-001
fn task archive FN-001
fn task unarchive FN-001
```

## Task Execution Modes

Each task has an execution mode that controls how the executor agent approaches the task:

| Mode | Description |
|------|-------------|
| `standard` | Full execution with complete review workflow (default) |
| `fast` | Expedited execution with minimal overhead for simple tasks |

### Fast Mode Bypassed Gates

When `executionMode: "fast"`, the following automated review/validation gates are **bypassed**:

| Gate | Standard Mode | Fast Mode |
|------|---------------|-----------|
| `review_step` tool enforcement | Available to executor agent | **Not injected** |
| Pre-merge workflow-step execution | Runs configured steps | **Skipped** |
| Workflow revision loop | Enabled (feedback → fix → re-review) | **Disabled** |

### Fast Mode Mandatory Gates

The following quality gates **remain enforced** in fast mode:

| Gate | Behavior |
|------|----------|
| `task_done` requirement | Agent must call `task_done()` to complete |
| Completion blocker checks | Tests, build, and typecheck from PROMPT.md still enforced |
| Post-merge workflow steps | Run as normal (merger-owned) |

### Execution Mode Matrix

| Feature | Standard | Fast |
|---------|----------|------|
| Executor agent session | Full prompt + tools | Full prompt (minus review_step) |
| Pre-merge workflow steps | ✅ Run | ❌ Bypassed |
| `review_step` tool | ✅ Available | ❌ Not available |
| Post-merge workflow steps | ✅ Run | ✅ Run |
| Completion blockers (test/build/typecheck) | ✅ Enforced | ✅ Enforced |
| `task_done()` requirement | ✅ Required | ✅ Required |

### Setting Execution Mode

Execution mode can be set during task creation or editing:

- **Via API**: Include `executionMode` field in task create/update payload
- **Via dashboard**: Select execution mode in the task creation dialog or task detail modal
- **Values**: `"standard"` (default) or `"fast"`

Example API payload:
```json
{
  "description": "Simple fix",
  "executionMode": "fast"
}
```

## Task Detail Modal (Dashboard)

The task detail modal exposes multiple tabs:

- **Details** — primary metadata and description
- **Steps** — progress across plan/implementation steps
- **Log** — task event history
- **Changes** — merge diff/change summary
- **Workflow** — workflow step results (pass/fail/skip)
- **Comments** — collaboration thread + steering controls
- **Model** — per-task model overrides and thinking level

## `PROMPT.md` Plan Structure

After planning, each task gets a structured `PROMPT.md` with sections like:

- Mission
- Dependencies
- Context to read first
- File scope
- Steps
- Acceptance criteria
- Guardrails / Do NOT list
- Build/test/typecheck requirements

This file is the contract for execution and review.

## Task Comments vs Steering Comments

- **Task comments** (`fn task comment`) are general collaboration notes.
- **Steering comments** (`fn task steer`) are execution guidance for the running agent.

Steering comments can be injected mid-run into active executor sessions.

## Refinement Tasks

`fn task refine <id>` creates a new planning task that depends on the original done/in-review task.

Example:

```bash
fn task refine FN-042 --feedback "Add explicit rollback tests for partial failure"
```

Behavior:

- New title format: `Refinement: <source label>`
- New task depends on source task
- Created in `planning`

## Archive and Restore

### Archive behavior

- `fn task archive <id>` moves done task to `archived`
- Cleanup mode can persist compact metadata and remove the task directory
- Archived tasks are read-only for task log/document writes:
  - `logEntry()` throws `Task <id> is archived — logging is read-only`
  - `upsertTaskDocument()` throws `Task <id> is archived — documents are read-only`
  - `fn_task_log` returns `ERROR: Cannot log to archived task — this task is read-only`

### Cleanup behavior

- Archived entries are persisted as compact archive snapshots (current runtime stores these in SQLite `archivedTasks`; legacy docs may refer to `.fusion/archive.jsonl`)
- Task directory (`task.json`, `PROMPT.md`, `agent.log`, attachments) can be removed

### Compact archive entry format

Archive entries preserve key metadata needed for restoration, including:

- `id`, `title`, `description`, `priority`, `column`
- `dependencies`, `steps`, `currentStep`
- `size`, `reviewLevel`, `prInfo`, `issueInfo`
- `attachments` metadata
- task `log`
- timestamps (`createdAt`, `updatedAt`, `columnMovedAt`, `archivedAt`)
- model override fields (`modelProvider`, `modelId`, `validatorModel*`, `planningModel*`)

`agent.log` content is intentionally not preserved in compact archive entries.

### Restore behavior

`fn task unarchive <id>`:

- Restores archive entry if directory is missing
- Rebuilds `PROMPT.md`
- Moves task to `done`
- Logs “Task restored from archive” when recovering from compact archive entry

## GitHub Issue Import and PR Creation

Import issues:

```bash
fn task import owner/repo --labels bug --limit 20
fn task import owner/repo --interactive
```

Create PR for in-review task:

```bash
fn task pr-create FN-120 --title "Fix flaky auth flow" --base main
```

## Completion Modes (`mergeStrategy`)

- **`direct`**: local squash-merge flow into target branch
- **`pull-request`**: PR-first completion flow via GitHub checks/reviews

Configured via settings.

## Per-Task Model Overrides

Each task may override:

- Executor model (`modelProvider` + `modelId`)
- Validator model (`validatorModelProvider` + `validatorModelId`)
- Planning model (`planningModelProvider` + `planningModelId`)
- Thinking level (`off|minimal|low|medium|high`)

Overrides are configured from the task model tab or task creation actions.

## Node Routing

Tasks execute on an effective node selected by routing precedence:

1. **Per-task node override** (`Task.nodeId`)
2. **Project default node** (`defaultNodeId` in project settings)
3. **Local execution** (no node configured)

At dispatch time, scheduler routing is persisted on the task as:
- `effectiveNodeId`
- `effectiveNodeSource` (`task-override`, `project-default`, or `local`)

### Per-task node override

You can set or clear a task override from:

- Task detail modal → **Routing** tab
- Quick/create flows that support node selection
- Bulk task actions
- CLI:
  - `fn task set-node <task-id> <node-name-or-id>`
  - `fn task clear-node <task-id>`
  - `fn task create "..." --node <node-name-or-id>`
- Pi extension tool `fn_task_update` with `nodeId`

### Active-task blocking

Node override changes are blocked while a task is active/in progress. Core validation (`validateNodeOverrideChange`) returns `reason: "task-in-progress"` and users must pause/stop or wait for completion before changing routing.

### Task detail routing summary

The Routing tab shows:

- Effective node (with health indicator when known)
- Routing source (override vs project default vs local)
- Unavailable-node policy value (`block` or `fallback-local`)
- Lock banner when routing is currently immutable for an active task

### Activity log entries

When a task is dispatched, task activity/log records include routing decisions such as:

- `Node routing resolved: <node-or-local> (source: <source>)`

Use `fn task show <id>` or task logs to inspect current node routing context.

### Examples

```bash
# Route one task to a specific remote node
fn task set-node FN-204 edge-runner

# Remove override and return to project default routing
fn task clear-node FN-204

# Create a task with node override immediately
fn task create "Reproduce flaky node error" --node edge-runner

# Inspect routing summary from CLI
fn task show FN-204
```

See also: [Settings Reference → Node Routing settings](./settings-reference.md#node-routing-settings-project-scope) and [Architecture → Task Routing Architecture](./architecture.md#task-routing-architecture).

## Review Level

Review levels control the rigor of the review process for a task:

| Level | Name | Description |
|-------|------|-------------|
| 0 | None | No review |
| 1 | Plan Only | Review only the plan |
| 2 | Plan and Code | Review both the plan and implementation |
| 3 | Full | Full review with all checks |

Review level can be set during task creation (in the New Task dialog under More options) or when editing a task (in the task detail modal).

The review level affects how the reviewer agent evaluates the task but does not override workflow steps or model presets.

## Model Presets and Auto-Selection by Size

Project settings support reusable model presets:

- `modelPresets`
- `autoSelectModelPreset`
- `defaultPresetBySize` (`S`, `M`, `L`)

Users can apply presets at task creation; manual model selection can override them.

## AI Title Summarization

When `autoSummarizeTitles` is enabled and a task has a long untitled description, Fusion can auto-generate a concise title.

## Screenshots

### Board/task cards + quick entry

![Task cards and quick entry on board view](./screenshots/dashboard-overview.png)

### Task detail modal

![Task detail modal](./screenshots/task-detail.png)

For UI-level details, see [Dashboard Guide](./dashboard-guide.md).

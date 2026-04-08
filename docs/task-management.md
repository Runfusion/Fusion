# Task Management

[← Docs index](./README.md)

This guide covers task creation, lifecycle behavior, task metadata, and operational workflows.

## Task Creation Options

### 1) Quick Entry (dashboard)

Use the inline input on board/list view:

- Type description
- Press Enter
- Task is created in `triage`

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

### 4) CLI creation

```bash
fn task create "Fix API timeout handling"
fn task plan "Implement role-based access control"
fn task create "Bug" --attach screenshot.png --depends FN-002
```

## Task Lifecycle

Fusion task columns:

1. **triage** — idea intake; AI writes a full specification
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

## Task Detail Modal (Dashboard)

The task detail modal exposes multiple tabs:

- **Details** — primary metadata and description
- **Steps** — progress across plan/implementation steps
- **Log** — task event history
- **Changes** — merge diff/change summary
- **Workflow** — workflow step results (pass/fail/skip)
- **Comments** — collaboration thread + steering controls
- **Model** — per-task model overrides and thinking level

## `PROMPT.md` Specification Structure

After triage, each task gets a structured `PROMPT.md` with sections like:

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

`fn task refine <id>` creates a new triage task that depends on the original done/in-review task.

Example:

```bash
fn task refine FN-042 --feedback "Add explicit rollback tests for partial failure"
```

Behavior:

- New title format: `Refinement: <source label>`
- New task depends on source task
- Created in `triage`

## Archive and Restore

### Archive behavior

- `fn task archive <id>` moves done task to `archived`
- Cleanup mode can persist compact metadata and remove the task directory

### Cleanup behavior

- Archived entries are persisted as compact archive snapshots (current runtime stores these in SQLite `archivedTasks`; legacy docs may refer to `.fusion/archive.jsonl`)
- Task directory (`task.json`, `PROMPT.md`, `agent.log`, attachments) can be removed

### Compact archive entry format

Archive entries preserve key metadata needed for restoration, including:

- `id`, `title`, `description`, `column`
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

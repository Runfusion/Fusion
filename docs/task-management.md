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
- AI reasoning (thinking output) is preserved and visible throughout the session — expand the reasoning toggle to review the model's analysis before answering each question or accepting the summary
- Produces summary + key deliverables
- Create one task or **Break into Tasks** (multi-task generation with dependencies)
- Summary view includes a **Priority** selector (`low`, `normal`, `high`, `urgent`) so single-task creation can set priority before task creation
- Break-into-tasks mode includes per-subtask **Priority** selectors (`low`, `normal`, `high`, `urgent`) so each generated task can be prioritized before creation
- Break-into-tasks descriptions are structured with subtask-specific guidance first, then a separate larger-plan context section (plus `## Planning Interview Context` when interview history exists)
- Final multi-task creation now uses a compact request payload: unchanged generated subtask descriptions stay server-side, while any edits to title, description, size, priority, and dependencies are preserved when tasks are created
- Sessions persist when the modal is closed — resume from the sidebar list at any time; reasoning context is restored automatically
- Back navigation rewinds the server-side planning session to the previous answered question so you can revise earlier answers and continue from the corrected turn
- On the summary screen, **Refine Further** continues through the backend planning session (including resumed completed sessions) and waits for a real follow-up question or updated summary; it does not switch to an empty question view

### 3) Todo item → Plan Mode

In **Todos** view, each todo item includes a planning action:

- Click the planning (💡) action on a todo item
- Opens Planning Mode with that todo text pre-filled as the initial plan
- Starts an AI planning interview (clarification questions + summary)
- You can then create one task or break the plan into multiple tasks

This action starts a planning session; it does **not** immediately create a task.

For full Todo View behavior (enablement, list/item actions, API routes, and storage), see [Todo View](./todo-view.md).

### 4) Subtask Breakdown Dialog

Use the 🌳 button:

- Generate 2–5 candidate subtasks
- Drag to reorder
- Add dependencies only on earlier items
- Set each subtask's **Priority** (`low`, `normal`, `high`, `urgent`) before create
- Create tasks in one action

### 5) Expanded Controls

Expand the creation panel (▼) to access additional controls:

- **Refine** (✨) — Improve the description with AI
- **Deps** (🔗) — Link existing tasks as dependencies
- **Attach** — Add image attachments
- **Models** (🧠) — Set per-task model overrides (executor, validator, planning)
- **Priority** (🚩) — Set task priority (`low`, `normal`, `high`, `urgent`) before creation; the selected value is applied to the created task (it does not reset to default unless omitted)
- **Agent** — Assign an agent to the task
- **Branch settings** (`branch` / `baseBranch`) remain available in full task forms and task detail editing (not in Quick Entry)
- **Review** — Set review rigor level (None, Plan Only, Plan and Code, Full)
- **Browser Verify** — Enable browser verification workflow step

### 6) CLI creation

```bash
fn task create "Fix API timeout handling"
fn task plan "Implement role-based access control"
fn task create "Bug" --attach screenshot.png --depends FN-002
```

### 7) Create/Enrich from Research findings

From the standalone **Research** view, each finding supports two task actions:

- **Create Task** — creates a new task with `sourceType: "research"`
- **Enrich Task** — appends/updates research content on an existing task

Research actions persist detailed output in task documents (and optional attachments), not in long task descriptions.

## Task Lifecycle

Fusion task columns:

1. **planning** — idea intake; AI writes a full plan
2. **todo** — ready for scheduling
3. **in-progress** — executor active in isolated worktree
4. **in-review** — implementation complete; awaiting finalization
   - If merge/finalization hits a terminal error, tasks can remain in `in-review` with `status: "failed"` for explicit follow-up. This state is intentionally preserved by recovery (not auto-bounced to `todo`).
   - Retry behavior splits by step completion: `in-review` tasks with incomplete steps (`pending`/`in-progress`) are treated as execution failures and retried back to `todo` with `preserveProgress: true`; `in-review` tasks with all steps `done` are treated as merge/finalization failures and stay in `in-review` with merge retry state reset.
   - Persisted executor session state is resumed only when it still matches the task's current worktree context. If a retry fails with `Refusing to start coding agent in missing worktree: ...` and the persisted session points at stale worktree metadata, recovery clears stale session pointers and retries fresh so review retries do not reopen deleted worktree paths.
   - Merge-confirmed tasks still respect `getTaskMergeBlocker()` before the final `in-review` → `done` move. If merge is confirmed but a blocker remains (for example, incomplete steps), Fusion parks the task in `in-review` with `status: "failed"` and an explicit blocker error instead of retry-looping auto-finalization.
   - Self-healing can still auto-finalize retry-exhausted failed review tasks when it can prove their branch content already landed on the merge target, so already-merged work does not deadlock in `in-review`.
   - Repeated engine merge-queue drops now escalate to an explicit recoverable review failure: if auto-recovery hits `Auto-merge starvation:` in the task `error`, Fusion has already seen three consecutive enqueue attempts rejected by the engine merge queue. Operators can recover by clearing the failed state from the dashboard, which lets the usual unpause/clear flow re-attempt merge once the underlying queue wedge is resolved.
   - Non-recoverable state-machine errors during finalization (for example `Invalid transition: 'todo' → 'done'`) are treated as terminal review failures: recovery must not re-enqueue these tasks for merge unless task state changes prove they are recoverable.
5. **done** — merged/finalized
6. **archived** — preserved history, optionally cleaned from filesystem

Board ordering behavior:
- `todo` mirrors scheduler dispatch order: priority first (`urgent` → `low`), then oldest `createdAt` within a priority tier, then task ID as deterministic tie-break.
- `triage`, `in-progress`, and `in-review` remain priority-first with task-ID tie-breaks (`in-review` still pins merge-active statuses above non-merging tasks).
- The `done` column is recency-ordered by completion time (newest first), using `columnMovedAt` as primary and falling back to `updatedAt` then `createdAt` for legacy tasks.
- The dashboard **list view default ordering matches these same per-column semantics** until a user clicks a sortable header (manual list sorting still overrides defaults).

### Lifecycle commands

```bash
fn task move FN-001 todo
fn task merge FN-001
fn task archive FN-001
fn task unarchive FN-001
```

### Branch metadata semantics

Task cards on the board only surface branch metadata when it is non-default/user-meaningful: they hide the conventional auto-generated working branch (`fusion/<task-id>` and suffixed variants) and hide the default merge target (`main`), while still showing custom working branches and non-default merge targets.

The board header search panel now includes two **board-only** branch filters:
- **Working branch** filters by `task.branch`
- **Target branch** filters by `task.baseBranch`

These filters apply only to board rendering (not list view). Each filter supports concrete branch values plus a **No branch** option that matches tasks where `branch` or `baseBranch` is unset. Persisted filter state remains intentionally deferred to follow-up task FN-3426.

Task branch fields are intentionally distinct:

- `task.branch` — the actual working branch used for the task worktree (for example `fusion/fn-1234` or a conflict-suffixed variant).
- `task.baseBranch` — the task's configured merge target/base branch intent.
- `task.executionStartBranch` — internal execution provenance used when scheduler/executor temporarily start from a dependency branch; this is transient and cleared during execution resets/recovery.

`PrInfo.baseBranch` is unchanged and continues to represent pull-request target branch metadata.

### Dependency reconciliation guidance

When a task was created to resolve a temporary failure state in another task (for example, a preserved `in-review/failed` merge condition), its dependency contract may become stale after recovery.

Use supported TaskStore/API paths to reconcile safely:

- Remove/replace stale dependencies through task update APIs (do not hand-edit `task.json`/SQLite)
- Add a single comment/log entry explaining why the dependency changed
- Keep downstream blockers coherent (only tasks that still truly depend on unfinished work should remain blocked)

Completion gating treats dependencies as resolved only when the dependency task is in `done`, `in-review`, or `archived`.

Auto-merge recovery follow-up creation is deduplicated: Fusion creates at most one active (`not done/archived`) recovery task per unresolved parent failure, and merge-conflict recovery also deduplicates by active branch ownership to prevent parallel duplicate follow-ups on the same conflict branch.

### Landed-task state reconciliation (maintenance)

If a task already shipped (`column: done`) but still carries transient failure metadata (`status: failed`, `error`, `worktree`, `blockedBy`, recovery retry fields), reconcile through supported TaskStore/API paths so SQLite and task JSON stay in sync.

Recommended pattern:
- Audit first (dry-run) for contradictory `done` + transient-failure state.
- Apply reconciliation with TaskStore-backed mutations (for example `moveTask(id, "done")` for done-normalization cleanup).
- Add one durable reconciliation log entry explaining why stale transient fields were cleared (avoid duplicating historical failure logs).
- Re-audit after apply and resolve or explicitly disposition any related stale follow-up tasks.

Do **not** patch `.fusion/fusion.db` directly without synchronizing `.fusion/tasks/*/task.json` through a supported store-backed path.

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
- **Task detail quick toggle**: In read mode, use the inline lightning-bolt control in task metadata to switch between **Standard** and **Fast** without entering full edit mode
- **Values**: `"standard"` (default) or `"fast"`

Example API payload:
```json
{
  "description": "Simple fix",
  "executionMode": "fast"
}
```

## Task provenance and research enrichment

Agent-created tasks now show a compact **Created by agent** marker directly on dashboard task cards when creation provenance indicates agent/automation origin (`sourceType: agent_heartbeat` or `sourceType: automation`, with legacy fallback to populated `sourceAgentId`). Where available, displays should prefer `sourceMetadata.agentName` over raw `sourceAgentId`.

Research-created tasks show provenance as **Created via Research** in the task detail header and `Source: Research` in `fn task show` output.

When `sourceMetadata.findingLabel` is present, the UI/CLI include it as context; otherwise they fall back to `runId` when available.

Research enrichment uses a canonical per-run document key:

- `research-{sanitizedRunId}`

Repeated enrichment from the same run writes new revisions to that same key (no sibling keys for the same run). Optional exported artifacts can also be attached to the task; duplicate attachment records are skipped unless an explicit replacement path is used.

Research document content appears in the existing **Documents** tab in Task Detail. Optional artifacts appear in existing task attachments.

## Task Detail Modal (Dashboard)

The task detail modal exposes multiple tabs.

In read mode, task metadata includes lightweight inline controls: priority can be changed from the priority chip, and execution mode can be toggled with a one-click lightning-bolt fast-mode button (Fast ↔ Standard) without opening full edit mode. These controls are intentionally aligned as a paired row (matched control height, baseline alignment, and mobile-safe wrapping) so frequent priority/mode changes stay quick and visually consistent.

Task metadata also shows compact `Created` / `Updated` timestamps: recent values render as relative time (`just now`, `Xm`, `Xh`, `Xd`) and older values switch to short month/day dates; both timestamps stay on one row across desktop and mobile widths for a compact metadata presentation.

Task settings edited from the modal now auto-save as you edit (change/blur with debounce for text-like fields). This includes title, description, dependencies, working/base branch (`branch`/`baseBranch`), workflow-step selection, model overrides in the edit form, and source issue metadata. In shared create/edit task forms, the GitHub Tracking controls are placed at the bottom of **More options** after **Workflow Steps**. The footer Save button remains available, but normal field edits no longer depend on a manual save click.

The edit footer shows inline autosave state (saving/saved/error), and successful saves propagate the returned task through `onTaskUpdated` so open detail/list state stays fresh.

The task detail modal exposes multiple tabs:

- **Details** — primary metadata and description
- **Steps** — progress across plan/implementation steps
- **Log** — task event history
- **Changes** — merge diff/change summary
- **Workflow** — workflow step results (pass/fail/skip)
- **Review** — actionable feedback surface (PR reviews/threads or reviewer-agent findings), manual refresh controls, and same-task revision actions for selected items
- **Stats** — execution timing + token usage breakdown
  - `Total execution time` prefers durable wall-clock execution window (`executionStartedAt` → `executionCompletedAt`)
  - Fallback order for legacy tasks: `timedExecutionMs` when present, otherwise `[timing]` log sum + workflow runtime
  - Workflow runtime is shown as a separate metric and is not double-counted into totals when `timedExecutionMs` is already available
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
- **Review tab feedback** is dedicated actionable review input (PR review data in pull-request mode, reviewer-agent findings in direct/non-PR mode) used to request same-task revisions.
- Review data is served from task-scoped API endpoints: `GET /api/tasks/:id/review` and `POST /api/tasks/:id/review/refresh`.
- Both endpoints return one normalized contract (`TaskReviewData`) with stable per-item `itemId` values and `sourceMode` (`pull-request` or `reviewer-agent`) so Review UI and per-item progress can share one read model.
- The Review tab supports **manual refresh** without closing/reopening Task Detail:
  - Pull-request mode refreshes live GitHub-backed review decision/thread/comment state and updates PR metadata freshness.
  - Direct/non-PR mode refreshes normalized reviewer-agent feedback from persisted task review artifacts and does not call GitHub.
- In direct/non-PR auto-merge mode, the Review tab shows parsed reviewer-agent feedback with explicit loading/error/empty states instead of sending users to raw comments or agent logs.
- **Comments remains the general discussion surface**; Review remains the actionable review surface.
- **Steering comments** (`fn task steer`) are execution guidance for the running agent.

Steering comments can be injected mid-run into active executor sessions.

When users select review items and trigger **Request revision** from the Review tab, Fusion starts an in-place same-task AI revision pass (no refinement child task):

- Review addressing progress is persisted per selected item in task state, including a durable snapshot and lifecycle timestamps.
- Each selected item transitions through `queued` → `in-progress` → `addressed`/`failed`, so Review progress survives refreshes and reloads even if upstream review data changes.
- Persisted snapshots are rendered in the Review tab when the original source item is no longer present, while Comments remains dedicated to general discussion.

- `in-progress` tasks receive compact steering guidance from the selected review items and continue on the same task/branch/worktree context.
- `in-review` tasks are resumed back to `in-progress`, reopen the last completed step, and keep same-task branch/worktree context for the revision pass.
- Assigned immediate-response agents are woken on-demand only when there is no active session; otherwise guidance is injected without forcing a new wake.

### User comments and triage re-consideration

User comments can trigger **re-triage** for already-planned but non-executing work:

- `triage` + `awaiting-approval` → user comment sets `status: "needs-replan"`
- `triage` or `todo` with a real (non-bootstrap-stub) `PROMPT.md` → user comment sets `status: "needs-replan"`
- `triage` or `todo` with only bootstrap-stub/unplanned prompt content → no re-triage transition

Execution ownership is preserved for active work:

- User comments on `in-progress` and `in-review` tasks do **not** re-route those tasks back through triage.
- Agent/system comments do **not** trigger comment-driven re-triage.

This is distinct from steering comments: steering feedback targets the currently running executor session, while comment-driven re-triage requests a fresh specification pass for planned work.
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

### Task-ID collision safety and operator recovery

- Ordinary task creation, duplicate, and refine flows now fail safely if the chosen task ID already exists in active storage or archive storage. Existing task rows/files always win; the new create attempt must retry with a fresh reservation instead of overwriting data.
- A failed create may burn a distributed reservation. Gaps in `FN-*` numbering are expected and are safer than reissuing a possibly-colliding ID.
- `config.nextId` is legacy/read-only. The live allocator state is `distributed_task_id_state.nextSequence`, reconciled on store open against live tasks, archived task snapshots, and reservation history.

If you suspect **historical overwrites from pre-FN-4044 builds**, inspect surviving evidence in this order:

1. `archive.db` / archived task snapshots for the missing ID
2. `.fusion/tasks/<id>/task.json.bak`, `PROMPT.md`, attachments, and any surviving worktree branch named for the task
3. agent run logs / task documents / activity log entries that still mention the original ID
4. git commits whose subject/body references the original task ID but no longer matches the current task metadata

Recovery/backfill guidance:

- If the original task row still exists in archive storage, unarchive or manually recreate the task from that snapshot.
- If only prompt/worktree/git evidence survives, create a replacement task with a new ID and copy over the recovered description, prompt, documents, and attachments manually.
- If both the active row and archive snapshot were overwritten, Fusion cannot reconstruct lost attachments/comments automatically; recreate them from git history, branch/worktree contents, screenshots, or external issue trackers.
- Record the incident in the replacement task so future audits understand why the task ID and commit history diverge.

## GitHub Issue Import and PR Creation

Import issues:

- GitHub-imported tasks retain typed source issue metadata (`sourceIssue.provider/repository/externalIssueId/issueNumber/url`), which executor and merger flows use to include `Ref: owner/repo#N` in commit bodies.

```bash
fn task import owner/repo --labels bug --limit 20
fn task import owner/repo --interactive
```

Create PR for an `in-review` task:

```bash
fn task pr-create FN-120 --title "Fix flaky auth flow" --base main
```

Manual/non-auto-merge behavior:
- Task PR branches use `fusion/<task-id-lower>`.
- In the dashboard task detail modal (`in-review`), the existing primary footer action can manually drive PR-first completion when `mergeStrategy: "pull-request"` and `autoMerge: false`:
  - `Start PR Review` (no PR linked yet)
  - `Check PR Status` (open PR linked)
  - `Finish & Close` (PR already merged)
- Manual PR creation first checks for an existing PR on that branch and links it when found.
- If no PR exists, Fusion pushes the task branch to `origin` before creating the PR.
- When buffered actionable PR feedback exists on a PR that is already merged/closed and the task leaves `in-review`, Fusion creates a dependency-linked follow-up task in `triage` so feedback is not stranded.

## GitHub Tracking Issues

GitHub tracking issues are optional issues Fusion can create from Fusion tasks. They are **not** the same as imported source issues (`issueInfo` / `sourceIssue`): imported issues represent an existing GitHub issue that created the task, while tracking issues are new GitHub issues opened to track a Fusion task.

When task creation runs with tracking enabled, Fusion attempts issue creation during task creation flows (including quick create, planning output, automation `create-task` workflow steps, and subtask creation paths that create tasks). For existing tasks, PATCH first persists any `githubTracking` mutation (enable/disable, repo override, or unlink), then evaluates whether the updated task is **enabled and still unlinked** and should trigger best-effort issue creation (including non-`githubTracking` edits). This keeps retry/create behavior consistent from Task Detail instead of relying on stale pre-patch state. Creation is best-effort and non-blocking: task updates and task creation still succeed even if repo resolution fails or GitHub calls fail.

Tracking behavior is controlled per task:

- `task.githubTracking.enabled` turns tracking on for that task.
- `task.githubTracking.repoOverride` optionally forces a specific target repo (`owner/repo`).
- In the dashboard **Task Detail** modal, eligible existing tasks (`triage`, `todo`, `in-progress`, `in-review`) always show a compact GitHub tracking summary row; linked-issue details and tracking controls are behind a disclosure arrow so tracking can still be enabled, disabled, or retargeted without reopening the task in a creation flow.
- When a task is already tracking-enabled but still unlinked, Task Detail exposes a **Create tracking issue** action in the disclosure content (including non-editable columns like `done`) so "Issue not yet created" is not a dead-end state.
- Clearing the Task Detail repo override stores `null`, which reverts repo resolution to project/global defaults.
- Explicit task-level enablement is honored even when project/global GitHub tracking defaults are unset. If `enabled: true` and the repo resolves at task scope (for example via `repoOverride`), Fusion attempts tracking-issue creation on both create-time and eligible edit-time flows.
- Explicit manual unlink (`githubTracking.issue: null`) does not recreate a tracking issue in that same update request, and disabling tracking does not create new issues.

Repository resolution order:

1. Task override: `task.githubTracking.repoOverride`
2. Project default: `githubTrackingDefaultRepo`
3. Global default: `githubTrackingDefaultRepo`

When Fusion creates a tracking issue, it uses:

- Title: `[FN-XXXX] Task title`
- Body prefix: `Fusion task: FN-XXXX`
- Body content: bounded plain-text task summary snippet (not full prompt content)

GitHub authentication/settings are configured in [Settings Reference](./settings-reference.md) via `githubAuthMode` (`gh-cli` or `token`) and `githubAuthToken`.

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

### Create-time routing semantics

Cluster-aware task creation separates two routing decisions:

- **Transport node**: which node receives the `POST /api/tasks` request (can be local or proxied remote).
- **Execution target** (`Task.nodeId`): which node should run the task later.

These are intentionally independent. Routing a create request through node A does not force execution on node A unless `Task.nodeId` also points there.

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

When `autoSummarizeTitles` is enabled and a task has a long untitled description, Fusion can auto-generate a concise title. This applies to tasks created from the dashboard/API as well as tasks created by agents and tooling flows (`fn_task_create`, delegated tasks, and triage-created child tasks).

## Screenshots

### Board/task cards + quick entry

![Task cards and quick entry on board view](./screenshots/dashboard-overview.png)

### Task detail modal

![Task detail modal](./screenshots/task-detail.png)

For UI-level details, see [Dashboard Guide](./dashboard-guide.md).

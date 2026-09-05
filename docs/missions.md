# Missions

[← Docs index](./README.md)

Missions provide structured planning across multiple related tasks.

> Roadmaps are a separate lightweight planning model (`Roadmap → RoadmapMilestone → RoadmapFeature`) used for standalone planning. Missions remain the richer execution-oriented hierarchy when you need slice activation, autopilot, and feature-to-task delivery tracking.

## Mission Hierarchy

Fusion models delivery as:

**Mission → Milestone → Slice → Feature → Task**

Example:

```text
Mission: Improve Reliability
  Milestone: Stabilize execution pipeline
    Slice: Retry and recovery hardening
      Feature: Stuck task recovery improvements
        Task: FN-210
        Task: FN-214
```

## Agent task-creation admission

Mission lineage is an admission requirement only for **autonomous no-task heartbeat** creates and delegations. Those idle patrol calls must supply a valid active Mission → Milestone → Slice → Feature chain; an allow rule for `task_agent_mutation` cannot bypass this requirement. Missing or invalid lineage is rejected before a task is persisted with an explicit mission-lineage remedy.

Interactive/user-supervised, task-scoped heartbeat, executor, triage, and workflow-step calls may create or delegate freeform tasks without lineage. They remain governed by the normal `task_agent_mutation` permission policy, including category and exact-tool allow, approval, and block rules.

A valid active lineage may name a hand-authored `defined` feature only for its first task. Fusion atomically claims the feature, links that exact task, and promotes the feature to `triaged`; an already-linked feature rejects rather than overwriting its canonical task. This bootstrap exception does not make `defined` executable: later scheduler and symbol-lock admission still uses the stricter contract below.

Both feature→task link transitions emit lifecycle events observable via mission-store subscribers and the dashboard SSE. Linking (`linkFeatureToTask` / claims) emits `feature:updated`, a `feature_status_changed` `mission:event` sourced `mission-link`, and `feature:linked`. Unlinking (`unlinkFeatureFromTask`) mirrors that family: it emits `feature:updated`, a `feature_status_changed` `mission:event` sourced `mission-unlink`, and `feature:unlinked` (the payload carries the detached `taskId`). Unlinking a feature that is not linked to any task is an error — it changes nothing and emits nothing. Consumers that react to `feature:linked` for feature→task automation see unlinks too via `feature:unlinked`, and the `mission-unlink` source distinguishes an unlink from a generic feature status edit.

## Canonical lineage approval for autonomous symbol locks

Before autonomous scheduler work may acquire a symbol lock, it resolves the task's Mission → Milestone → Slice → Feature lineage and evaluates the single `@fusion/core` contract: `evaluateMissionLineageApproval`. Resolution and lock acquisition remain scheduler responsibilities; downstream schedulers must not redefine the approval rule.

Approval requires every one of these statuses:

- Mission: `active`
- Milestone: `active`
- Slice: `active`
- Feature: `triaged` or `in-progress` (never `defined`; defined is only allowed at the first-task bootstrap boundary)

When the scheduler passes `planApprovalRequired: true`, the linked task must also have an `approvedPlanFingerprint` that is a non-empty string after trimming whitespace. The predicate does not recompute the fingerprint; `plan-approval.ts` owns its generation and validation. When plan approval is not required, the fingerprint is ignored.

The predicate is pure and returns `{ approved, reason }`. Its stable reasons are `approved`, `missing-mission`, `missing-milestone`, `missing-slice`, `missing-feature`, `mission-not-active`, `milestone-not-active`, `slice-not-active`, `feature-not-implementable`, and `plan-not-approved`. A false result is the scheduler's `lineage-blocked` outcome; only an approved result is eligible for symbol-lock admission.

## Mission → Goal linkage

Missions and goals are stored independently, with an optional many-to-many linkage persisted in the `mission_goals` join table.

- Columns: `missionId`, `goalId`, `createdAt`
- Primary key: `(missionId, goalId)`
- Foreign keys: `missionId → missions.id`, `goalId → goals.id`
- Delete behavior: both foreign keys use `ON DELETE CASCADE`, so removing either parent deletes only the corresponding join rows
- Reverse lookups are indexed via `idxMissionGoalsGoalId`

`MissionStore` owns the persisted linkage CRUD surface:

- `linkGoal(missionId, goalId)` — idempotently create a link and return `{ missionId, goalId, createdAt }`
- `unlinkGoal(missionId, goalId)` — remove a link and report whether anything changed
- `listGoalIdsForMission(missionId)` — list linked goals in deterministic creation order
- `listMissionIdsForGoal(goalId)` — list linked missions in deterministic creation order

### No-backfill decision

Existing missions are intentionally **not** auto-linked to any goals. Fusion does not run a migration backfill for pre-existing missions, so a mission with no links should be treated as genuinely unlinked until an operator or agent associates it with one or more goals.

### Manual linkage workflow

Mission ↔ goal links are created and removed deliberately as part of normal planning and operations work. The dashboard exposes the relationship from both directions: Mission detail has an active-goal picker plus linked-goal chips with unlink controls, and each Goals view card has a mission picker plus linked-mission chips with unlink controls. Archived goals are never offered for new links, duplicate link attempts are no-ops at the store/API layer, and removing the last link restores the empty-state copy rather than leaving an empty control shell. The workflow is intentionally manual so teams can choose the correct strategic relationship per mission instead of inheriting guessed links from older data.

### Unlinked mission indicator

Mission Manager shows an **Unlinked** indicator on active mission cards when `linkedGoalCount` is zero. Linking or unlinking from either dashboard surface refreshes this count so operators can quickly find active missions that still need an explicit goal association.

The engine also emits a workflow insight with advisory key `unlinked_missions_advisory` when it first observes one or more active missions with zero goal links. The insight is advisory only, includes only the affected mission ids plus a count, and is deduped to one stable row so it does not spam on every scheduler heartbeat.

### Task → Goal provenance

When a mission feature is linked or triaged into a task, Fusion does **not** copy goal ids onto the task row. Instead, task goal provenance is always derived from the mission link owned by `MissionStore`:

- `listGoalIdsForTask(taskId)` resolves the owning mission from the linked feature hierarchy first (`feature -> slice -> milestone -> mission`), then falls back to the live task row's `missionId` when needed.
- `listGoalsForTask(taskId)` maps those ids back to full `Goal` records using the same goals-table read path as `getMissionWithHierarchy`, so mission reads and task provenance stay in sync.
- Unknown, unlinked, or partially missing hierarchy state resolves fail-soft to `[]`.
- Archived goals remain part of provenance; only missing goal rows are dropped.

This derived bridge lets downstream systems recover which strategic goals a task serves without duplicating mission-goal linkage during task creation.

### Goal-injection diagnostics provenance field

The engine's `resolveAndEmitGoalContext` seam still injects only the always-on active-goal context into prompts, but diagnostics now add `provenanceGoalIds: string[]` alongside the existing injected `goalIds` / `goalCount` fields.

- `goalIds` / `goalCount` continue to describe the active goals injected into the prompt.
- `provenanceGoalIds` records which mission-linked goals the task serves.
- Diagnostics and run-audit metadata persist ids/counts only — never goal titles, descriptions, or prompt text.

## Creating Missions

### Mission base branch defaults

Missions support an optional `baseBranch` field. When set, feature triage (`triageFeature`) and slice triage (`triageSlice`) inherit this value as the task `baseBranch` whenever a triage request does not explicitly provide a base branch override.

Precedence order during triage:
1. Explicit triage `branchSelection.baseBranch` / `baseBranch`
2. Mission `baseBranch`
3. Project default branch resolution

### Mission task prefix override

Missions support an optional `taskPrefix` field. When set, feature triage (`triageFeature` / `triageSlice`) passes it as a transient minting hint on `TaskCreateInput` so the distributed task-id allocator issues ids under that prefix. When unset or cleared, triage inherits the project-wide `settings.taskPrefix`.

The Mission Manager create/edit form exposes this as **Task prefix** (empty = project default). Clearing a previously saved prefix on edit sends `taskPrefix: null` so the stored override is removed.

### Mission branch strategy defaults

Missions can also persist a `branchStrategy` used whenever triage is triggered without explicit branch options (manual triage and autopilot triage).

Supported modes:

- `project-default` (or absent): shared mode; triage creates and reuses the deterministic group integration branch `mission/<mission.id>` (for example `mission/M-3324`). Each feature gets a distinct per-task working branch while that branch remains the group merge target. Existing persisted default-branch groups are not rewritten; their members remain protected by the normal manual-release gate.
- `auto-per-task`: sets `branchAssignment.mode = "per-task-derived"` (distinct per-task working branches with no shared mission group merge target)
- `existing`: shared mode using `branchSelection.mode = "existing"` with `branchName` as the shared merge-target branch
- `custom-new`: shared mode using `branchSelection.mode = "custom-new"` with `branchName` as the shared merge-target branch

The Mission Manager create/edit form exposes this as **Branch strategy** plus a conditional **Branch name** field for `existing` and `custom-new`.

### Mission auto-merge override

The **Merge behavior** control appears in each Mission Manager create and edit form. Use the secondary **Create** link beside **Plan New Mission** when a manual create is needed; the primary planning CTA continues to start the AI interview. Its in-context help explains that **Inherited** follows the project setting, **Auto-merge** lands each feature as it passes, and **Single pull request** retains all features on a shared branch for joint review. The latter persists `autoMerge: false` on the mission and stamps newly triaged feature tasks with the same false override, while preserving the mission's shared branch group. Returning the control to inherited clears the mission override. Mission detail shows the branch name, canonical member count, and PR state only after it resolves a mission-owned group through a linked task's branch context; unavailable, stale, or foreign groups remain hidden.

### Shared branch-group invariant across entry points

Across all branch entry points (planning/subtask creation, mission triage, and New Task `shared-group` creation), Fusion enforces one rule:

- Persist a **per-task working branch** on each task (the checkout branch used for execution).
- Persist the shared branch only as the **group merge target** via `branchContext.groupId` → `branch_groups.branchName`.
- Never persist the shared branch itself as a task working/checkout branch.

This keeps member execution isolated per task while still routing member landings into a single shared integration branch.

### Dashboard

Use the Mission Manager UI to create missions and build hierarchy interactively.

Mission Manager anchors the primary **Plan New Mission** CTA at the top of the mission list on both mobile stacked and desktop split layouts. The secondary **Create** manual-create link sits beneath it, and both primary controls use the same slightly taller tokenized height. While the inline create form is open, the CTA is suppressed cleanly without leaving an empty container; each surface retains only one primary planning control.

Mission detail refreshes now preserve expanded milestone/slice state and keep the selected milestone expanded, so persisted milestone acceptance criteria remain visible across live updates.

Mission, milestone, slice, and feature read-only text surfaces in Mission Manager render Markdown (GFM) for descriptions, verification, and acceptance criteria; edit forms continue to use raw plain-text `<textarea>` inputs.

### Clearing a stale mission blocked badge

Use **Clear blocked status** when the mission-level `blocked` badge is stale. It recomputes and records the mission status with an attributed audit event, but does **not** resume the mission, unpause linked tasks, re-arm autopilot, or clear lineage stops. **Resume** remains the separate operation that reactivates execution.

`MissionBlockerDescriptor` is the canonical diagnosis shape: `{ rootFeatureId, reason, source }`, where `source` is `feature-row` or `lineage-stop`. Diagnostics, clear responses, and `POST /api/missions/:missionId/resume` `409 MISSION_RESUME_CONFLICT` use the same array, deduplicated on `(rootFeatureId, source, reason)` while preserving same-root entries with different sources.

Feature-validation repair controls repair feature state only; they intentionally do not modify a mission-level status badge.

### CLI

```bash
fn mission create "Reliability initiative" "Reduce execution failures and improve recovery" --goal G-001 --goal G-002
fn mission list
fn mission show mission_123
fn mission goals mission_123
fn mission link-goal mission_123 G-001
fn mission unlink-goal mission_123 G-001
fn mission activate-slice slice_456
fn mission delete mission_123 --force
```

## Mission ↔ Goal operator surfaces

Fusion surfaces the persisted mission↔goal linkage through REST, CLI, and pi-extension tools.

### REST endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/missions` | Create a mission. Optional body field `goalIds: string[]` links goals during creation and returns `linkedGoals` in the response. |
| `PATCH /api/missions/:missionId` | Update mission fields. Optional `goalIds: string[]` replaces the full linked-goal set; `[]` clears links and `undefined` leaves links unchanged. |
| `GET /api/missions/:missionId` | Return `MissionWithHierarchy`, including `linkedGoals` as an always-present array of `Goal` objects for the selected mission and optional `eventCount` as the authoritative unfiltered mission activity total. |
| `GET /api/missions/:missionId/goals` | List linked goals for a mission. Returns `{ goals }`. |
| `GET /api/goals/:goalId/missions` | List linked missions for a goal. Returns `{ missions: [{ id, title, status }] }` and skips stale links whose mission row no longer resolves. |
| `PUT /api/missions/:missionId/goals` | Replace the full linked-goal set with body `{ goalIds: string[] }`. Duplicate ids are deduplicated before reconciliation. |
| `POST /api/missions/:missionId/goals/:goalId` | Idempotently link one goal to a mission. |
| `DELETE /api/missions/:missionId/goals/:goalId` | Idempotently unlink one goal from a mission. |
| `GET /api/missions/:missionId/blocked-diagnostics` | Return the read-only blocked-badge diagnosis: mission status, recomputed status, clearability, resumability, and canonical blockers. |
| `POST /api/missions/:missionId/clear-blocked` | Clear only a stale mission `blocked` badge. Optional `{ reason }` is bounded and audit-attributed; it returns `{ mission, blockers }`. |

The mission detail payload keeps `linkedGoals` separate from the milestone tree so read paths can surface strategy context without traversing slices/features. All goal-link write endpoints preserve the same invariant: missing goals on link write paths (`POST /api/missions`, `PATCH /api/missions/:missionId`, `PUT /api/missions/:missionId/goals`, `POST /api/missions/:missionId/goals/:goalId`) reject with `400 { code: "GOAL_NOT_FOUND" }`, archived goals reject with `400 { code: "GOAL_ARCHIVED" }`, duplicate/relinked ids are no-ops, and the `DELETE /api/missions/:missionId/goals/:goalId` unlink path treats unknown goals as a `404` while remaining allowed even after a goal is archived.

### CLI

- `fn mission create ... --goal <goal-id> [--goal <goal-id> ...]` — create a mission and batch-link active goals.
- `fn mission goals <mission-id>` — list linked goals for a mission.
- `fn mission link-goal <mission-id> <goal-id>` — idempotently link a goal; archived goals reject with `GOAL_ARCHIVED`.
- `fn mission unlink-goal <mission-id> <goal-id>` — idempotently unlink a goal, including archived goals.
- Dashboard Mission detail lets operators link active goals, unlink existing goal chips, and select a chip to open the Goals view at the anchored goal card.
- Dashboard Goals cards show linked missions, let operators link/unlink missions for that goal, and select a mission chip to open Mission Manager at that mission.

## Mission Planning Tools (pi extension)

The canonical per-parameter tool reference lives in `packages/cli/skill/fusion/references/extension-tools.md`; this section is a user-facing summary of the mission-planning tool surface.

| Tool | Purpose |
|---|---|
| `fn_mission_create` | Create a mission with title/description, optional `baseBranch`, and optional auto-advance behavior. |
| `fn_mission_list` | List missions and their current status. |
| `fn_mission_show` | Show mission details with milestone/slice/feature hierarchy, including a **Linked Goals** section plus milestone/feature acceptance criteria and slice verification when present. |
| `fn_mission_list_goals` | List the goals linked to a mission. |
| `fn_mission_link_goal` | Idempotently link a goal to a mission; archived goals reject with `GOAL_ARCHIVED`. |
| `fn_mission_unlink_goal` | Idempotently unlink a goal from a mission, including archived goals. |
| `fn_mission_delete` | Delete a mission and its hierarchy. |
| `fn_mission_update` | Update mission title/description using partial patches. |
| `fn_mission_set_status` | Set mission lifecycle status with an attributed audit event. |
| `fn_mission_clear_blocked` | Clear a stale mission-level `blocked` badge without resuming automation (operator-only). |
| `fn_milestone_add` | Add a milestone to a mission. |
| `fn_milestone_update` | Update milestone fields using partial patches. |
| `fn_slice_add` | Add a slice to a milestone. |
| `fn_slice_activate` | Activate a pending slice for implementation. |
| `fn_slice_delete` | Delete a slice (with linked-task guard and optional `force`). |
| `fn_feature_add` | Add a feature to a slice with optional acceptance criteria. |
| `fn_feature_delete` | Delete a feature (with linked-task guard and optional `force`). |
| `fn_feature_update` | Update feature fields using partial patches. |
| `fn_feature_set_status` | Set feature status; execution statuses require a linked task. |
| `fn_feature_repair_validation` | Clear a stale validation badge or re-run an eligible validation. |
| `fn_feature_link_task` | Link a feature to a task for implementation. |
| `fn_milestone_delete` | Delete a milestone (with linked-task guard and optional `force`). |

### fn_mission_update

Updates an existing mission's `title` or `description`. Partial patches leave untouched fields intact — fields omitted from the call are not modified.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Mission ID to update (e.g., `M-001`) |
| `title` | string | — | Updated mission title |
| `description` | string | — | Updated mission description |

Use this to reconcile mission narrative/state text without recreating the mission.

### fn_milestone_update

Updates an existing milestone's `title`, `description`, or `acceptanceCriteria`. Partial patches leave untouched fields intact — fields omitted from the call are not modified.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Milestone ID to update (e.g., `MS-001`) |
| `title` | string | — | Updated milestone title |
| `description` | string | — | Updated milestone description |
| `acceptanceCriteria` | string | — | Updated acceptance criteria for completing the milestone |

Callers can only update milestones within missions they have access to. Use `fn_milestone_add` to create milestones. This update behavior was introduced in FN-4578.

### fn_feature_update

Updates an existing feature's `title`, `description`, or `acceptanceCriteria`. Partial patches leave untouched fields intact — fields omitted from the call are not modified.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Feature ID to update (e.g., `F-001`) |
| `title` | string | — | Updated feature title |
| `description` | string | — | Updated feature description |
| `acceptanceCriteria` | string | — | Updated acceptance criteria for completing the feature |

Use this to edit existing features without delete-and-re-add cycles.

### Repair feature validation state

`fn_feature_repair_validation` repairs a stale feature validation state without weakening normal execution-loop transitions. Use `clear` to clear an eligible `blocked` or `needs_fix` loop state (and a blocked feature status); use `re_run` to create a new validator run only when it is safe.

The shared eligibility rule is used by the store, agent tool, REST route, and dashboard. A `blocked` or `needs_fix` loop state permits both actions regardless of feature status. A blocked status with no loop state or `idle` also permits both. A blocked status with `validating`, `implementing`, or `passed` permits **Clear only**; `re_run` is refused while a live cycle is active and for passed features. Healthy features expose neither action, and `re_run` also refuses a feature with an in-flight validator run or no linked assertions.

For a status-changing clear, the engine resolves a target status and loop target plus a ground-truth fence. The fence type lives in `@fusion/core` while the engine produces it, preserving core's dependency direction. It captures the linked task identity, lane role, and whether that task was observed `live` or `absent`. A missing, deleted, or archived linked task is an absent ground truth that resolves to `defined`, so it can be repaired rather than permanently rejected.

The store rechecks the fence under its feature-row lock: a live task must still be live and unchanged, while an absent task must remain absent. It retries a stale resolution once. The no-`taskStore` fixture fallback records `groundTruthTaskVerified: false` for a non-null task ID. Callers provide both resolved targets: the store ignores `resolvedLoopState` on a status-only clear and ignores `resolvedStatus` on a loop-only clear, avoiding stale pre-lock branching. The mutation and `feature_validation_repaired` audit event commit in one transaction; clearing resets the implementation retry count, and unlinked features cannot be resumed as `triaged` or `in-progress`. The normal execution loop still cannot escape `blocked` by itself.

### Clear a stale mission blocked badge

`fn_mission_clear_blocked` repairs only a stale mission-level `blocked` badge. It accepts an audit-logged optional `reason` and reports residual canonical blockers, but does not clear them or resume automation. Use **Resume mission** when automation should be re-armed. The tool is withheld from agent sessions and is available only to a human operator through the CLI/pi extension.

## Mission delete policy (hard delete with linked-task guard)

Mission hierarchy records (`missions`, `milestones`, `slices`, `mission_features`) use hard deletes with FK cascades and do not have `deletedAt` soft-delete columns.

To keep behavior consistent, Fusion uses **hard delete with guard** for feature/slice/milestone deletes:

- Delete is rejected when the target (or any cascading child feature) is linked to a **live** task (`deletedAt IS NULL` and not archived).
- Callers can pass `force: true` to override the guard. Force clears the mission linkage before deletion, then proceeds with the same hard delete.
- Linked tasks are preserved; only mission hierarchy rows are removed.

This intentionally differs from task soft-delete behavior described in `docs/soft-delete-verification-matrix.md` and avoids a mission-table soft-delete migration.

## Mission Interview and Planning Workflow

The dashboard supports mission planning workflows where you can:

- Define mission outcomes
- Break work into milestones/slices/features
- Associate features to executable tasks
- Track progress at each layer
- Persisted missions with `interviewState: "in_progress"` remain visible as interview-styled mission cards in the main mission list so planning work does not disappear after reloads
- Resume in-progress mission interview sessions directly from separate transient session rows in the main missions list (`mission_interview` sessions in `generating`, `awaiting_input`, `error`, or `complete`) before a mission record is created; `complete` means the plan summary is ready for review/approval but has not been converted into a mission yet
- Mission interview closes are non-destructive: the modal now uses a single close action for header close, backdrop click, and Escape. Closing preserves the in-progress `mission_interview` session, and Missions re-fetches project-scoped transient rows (including on the mobile stacked Missions view) so resume/retry remains discoverable without losing persisted `interviewState: "in_progress"` mission cards. Resume-launched interview modals also expose a **Send to background** action that performs the same non-destructive park without cancelling the session. Deletion remains an explicit sidebar action.
- Mission interview, milestone interview, and slice interview agents have read-only board visibility via `fn_task_list` and `fn_task_show`, so they can reference active backlog context and avoid duplicating in-flight tasks while asking planning questions

### Mission Interview Drafts

Mission interview sessions are persisted in `ai_sessions` before a mission row exists, so unfinished drafts stay recoverable across reloads and restarts.

- **Dashboard:** the Missions view shows a **Drafts** section for in-flight `mission_interview` sessions with **Resume**/**Review** and **Discard** actions. A `complete` draft is a generated-but-unapproved plan parked at the summary step.
- **CLI:** `fn mission list` shows drafts by default before normal mission status sections, including `complete` plan-ready drafts. Pass `--no-drafts` to hide them.
- **pi extension:** `fn_mission_list` includes drafts by default and accepts `includeDrafts: false` to suppress them; `complete` mission interview drafts are returned here too.
- **Discarding drafts:** discarding removes the `ai_sessions` row even for cold drafts after a server restart.

Mission interview draft endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/missions/interview/drafts` | List in-flight mission interview drafts |
| `POST /api/missions/interview/drafts/:sessionId/discard` | Discard a draft session |

### Auto-Generated Assertions

Fusion keeps a canonical per-feature assertion invariant in `MissionStore`:

- `addFeature()` creates exactly one store-managed assertion for each feature and links it.
- `updateFeature()` keeps that assertion synchronized when `title`, `description`, or `acceptanceCriteria` change.
- `deleteFeature()` removes the store-managed assertion to avoid orphaned rows.
- This applies to all creation paths (interview import, API, CLI, tools).

Assertion text source priority is: `acceptanceCriteria` → `feature.description` → fallback text (`"Verify implementation of: {feature.title}"`).

**Operator repair note (FN-5696):** Some databases created before the feature-create-path fix could show feature `acceptanceCriteria`/`description` in the UI but still have zero `mission_feature_assertions` links, which caused validator auto-pass short-circuits. Use the built-in backfill operator surfaces instead of ad-hoc scripts:

- Agent/tool: `fn_mission_backfill_assertions` with `{ missionId?, dryRun? }` (dry-run default)
- API: `POST /api/missions/:missionId/backfill-assertions` with body `{ dryRun?: boolean }`

Run dry-run first, then apply (`dryRun=false`) when the report looks correct. Scope by mission id for targeted repair (for example Goals mission `M-MP32KU9Y-0001-2ADN`).
- **Verification fields**: Milestone and slice verification criteria from the interview are stored in dedicated `verification` fields rather than concatenated into descriptions
- **Milestone acceptanceCriteria derivation**: explicit `milestone.acceptanceCriteria` from interview output is authoritative. When omitted/blank, Fusion derives a deterministic bulleted summary from child features after creation: prefer `feature.acceptanceCriteria`, fall back to `feature.description`, skip empty contributors, and leave milestone acceptance empty when nothing contributes
- **Partial plans handled**: Auto-generation is robust to partial plans (missing slices/features or empty criteria) without throwing errors

### Milestone Text Field Semantics

Milestones now carry three complementary free-text fields:

- `description` — narrative scope of the phase
- `verification` — informal "how to confirm" notes
- `acceptanceCriteria` — structured acceptance/assertion text (the canonical pass/fail bar), parallel to feature-level `acceptanceCriteria`

## Slice Activation and Progress

Slices represent staged execution windows.

- Pending slices remain inactive
- Automatic progression admits at most one active slice per mission
- Completion rolls up through feature → slice → milestone → mission

Manual activation is available through `fn mission activate-slice <slice-id>`.

## Mission Autopilot

Missions are always created stopped (`status: "planning"`, `autopilotEnabled: false`, `autoAdvance: false`).
Autopilot must be enabled explicitly after creation (for example via start/update actions).
When `autopilotEnabled` is on, Fusion can watch completion events and progress missions automatically.

State machine:

- `inactive`
- `watching`
- `activating`
- `completing`

Typical flow:

1. Mission is watched (missions updated with `autopilotEnabled: true` or explicitly started are watched)
2. Task completion updates feature status
3. If no slice is active, autopilot activates only the earliest pending slice after every earlier milestone and slice is complete
4. When milestones are all complete, mission transitions to complete

If validation cannot run (unexpected loop state, duplicate trigger, blocked validation, or validator error), Fusion logs a mission `warning`/`error` event with structured metadata so the stuck state is visible in mission events.

Mission `status` and `autopilotEnabled` transitions are atomically written with a mission activity event. The event records stable actor type/id, optional display name, source, and before/after values; unchanged values create no transition event. Dashboard controls identify an operator, tools identify an agent when they expose a sensitive mutation, and autonomous engine paths identify the system/autopilot.

Automatic hierarchy rollup, including terminal-task delivery reconciliation, owns only `planning`, `active`, and `complete` for missions and milestones. It never rewrites intentional `blocked` or `archived` status during hierarchy churn; a blocked mission stays blocked even after all milestones complete. Those statuses change only through resume, an explicit status write, or the mission clear-blocked path. `packages/core/src/__tests__/mission-rollup-status-writer-ratchet.test.ts` inventories first-party computed status writers and requires each automatic writer to use the shared ownership guard.

## `autopilotEnabled` vs `autoAdvance`

- **`autopilotEnabled`**: primary control for autopilot behavior — enables background monitoring, orchestration, and automatic slice activation when a slice completes. Also triggers auto-planning (converting features to tasks) when a slice is activated.
- **`autoAdvance`**: legacy fallback for backward compatibility with existing mission data. Kept for compatibility — new missions should use `autopilotEnabled`.

**Auto-planning behavior:**

- `autopilotEnabled=true` → features in activated slices are automatically planned (converted to tasks)
- `autopilotEnabled=false`, `autoAdvance=true` → features are planned (legacy compat)
- Active autopilot slices are continuously reconciled on startup recovery and periodic maintenance: stranded features (`taskId == null`) are re-triaged idempotently, title-matched tasks are linked first, and successful link/triage repairs emit `mission:stranded-feature-triaged` run-audit events.
- `autopilotEnabled=false`, `autoAdvance=false` → manual slice activation only

**Slice progression (on slice completion):**

- `autopilotEnabled=true` → serial admission activates only the earliest eligible pending slice. Any active slice blocks admission; earlier milestones and slices must be complete before later milestones start.
- Explicit milestone dependencies are additional restrictions and never override creation order.
- Duplicate completion callbacks and stale/startup recovery calls are idempotent no-ops when a slice is already active or no eligible slice exists.
- `autopilotEnabled=false`, `autoAdvance=true` → the legacy compatibility entry uses the same serial admission rule
- `autopilotEnabled=false`, `autoAdvance=false` → manual activation required

**Dashboard UI:** The Mission Manager groups mission run settings together: explicit **Start mission / Stop mission / Resume mission** actions control mission run-state, while the **Autopilot** toggle controls automatic slice advancement and feature planning. The autopilot badge uses human-readable states (`Off`, `Watching`, `Activating slice`, `Completing`). When enabling autopilot on an already-active mission, the system automatically checks whether recovery is needed (no active slice or completed active slice) and progresses accordingly.

## Autopilot API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/missions/:missionId/autopilot` | Get autopilot status for mission |
| `PATCH /api/missions/:missionId/autopilot` | Enable/disable autopilot (`{ enabled: boolean }`) |
| `POST /api/missions/:missionId/autopilot/start` | Start watching manually |
| `POST /api/missions/:missionId/autopilot/stop` | Stop watching manually |

## Feature Reconciliation API Endpoint

Use this endpoint when a feature's delivery task has already shipped and is now terminal (`done` or `archived`), but the feature status still needs to be reconciled to `done`.

### `POST /api/missions/features/:featureId/reconcile-done`

**Request body:**

```json
{ "taskId": "FN-123" }
```

**Safety gate behavior:**

- Validates `featureId` and requires a non-empty string `taskId`.
- Resolves the feature and terminal delivery evidence in the request's scoped PostgreSQL project.
- Accepts either a live, non-deleted task in `done`, or a supported archived task represented by both its retained soft-deleted `column=archived` project-task tombstone and its project-scoped cold archive snapshot. A deletion without both archive representations is not delivery evidence.
- Atomically validates conflicts, writes the canonical feature→task link, marks the feature `done`, updates the live task's reverse mission/slice link when applicable, and recomputes slice/milestone rollups. Any validation or write failure rolls back the complete operation.
- Archived evidence remains archived and read-only: reconciliation intentionally leaves its retained task tombstone without a writable reverse backlink rather than resurrecting the task.
- Repeating the same terminal task against the same completed feature is idempotent. A feature linked to another task, or a task linked to another feature, returns `409` without mutation.
- The repair path never enters ordinary triage/implementation state, changes loop attempts, creates or moves a task, activates/watches the mission, or changes mission `status`, `autopilotEnabled`, or `autoAdvance`.

<!-- FNXC:MissionReconciliation 2026-07-20-08:34: Operators need a supported atomic terminal-evidence repair because unarchive/move workarounds enter ordinary task lifecycle observers and can wake a parked mission or generate duplicate work. -->
**Safe duplicate cleanup:** preserve the first `409`; verify through supported APIs that the current linked task is generated duplicate work with no unique delivery or lineage value; call `POST /api/missions/features/:featureId/unlink-task`; archive only the proven duplicate through the supported task archive API; then call `reconcile-done` with the canonical terminal task. Never overwrite a mismatched link, unarchive/move canonical delivery evidence, or use direct storage edits. If the duplicate is ambiguous, leave it untouched and escalate for evidence.

## Unlink / Re-point a feature's task link

A mission feature's forward `taskId` link is single-valued and pinned: `fn_feature_link_task` / `linkFeatureToTask` refuse to re-point an already-linked feature (`Feature … is already linked to task …`). To correct a feature pinned to the wrong task (for example a shared vision document instead of the deterministic delivery task), use the re-point or unlink surface rather than the status-lossy unlink-then-link two-step:

- **Re-point** moves the single-valued `taskId` directly with no status loss: `fn_feature_repoint_task` (engine tool) and the corresponding `fn_feature_repoint_task` CLI/pi-extension tool call the `repointFeatureToTask` store primitive. It atomically clears the old task's reverse `missionId`/`sliceId` linkage, sets the new task's, keeps an already-linked feature's status/loop/attempts, and preserves single-valuedness via the same conflicting-feature guard as linking. Same-task re-point is an idempotent no-op.
- **Unlink** detaches the feature entirely: `fn_feature_unlink_task` (engine and CLI tools) and the write surface `POST /api/missions/features/:featureId/unlink-task` call the `unlinkFeatureFromTask` store primitive, which clears `taskId`, clears the old task's reverse linkage, and demotes the feature to `defined` — all in one transaction. Unlink of a feature not currently linked to any task is an error: it changes nothing and emits nothing (the CLI/agent surfaces report the error, and the dashboard route maps it to a 4xx).

Both tools are classified as permanent-task-agent mutation surfaces (action gating and readonly workflow-step denial behave like `fn_feature_link_task`). Re-point is preferred over unlink-then-link because it preserves loop/status progress; unlink remains the correct path before the documented safe duplicate-cleanup + `reconcile-done` flow above.

**How this differs from `PATCH /api/missions/features/:featureId`:**

- `PATCH` keeps the execution-status guard and rejects `done`/`triaged`/`in-progress`/`blocked` when no linked task exists.
- `reconcile-done` is a dedicated, evidence-gated transaction for already-shipped work. It is not a shortcut for active work or mission execution.

**Error responses:**

- `400` — invalid feature ID format or missing/empty `taskId`.
- `404` — feature not found or no task/archive evidence exists for the supplied task ID.
- `409` — feature/task mismatch, task already linked to another feature, nonterminal task, or a deleted/archived task lacking the supported retained tombstone plus cold snapshot. Every `409` leaves feature, task, rollups, and mission controls unchanged.

## Validation Contract Lifecycle

Fusion's validation contract lifecycle is the structured feature delivery system for missions. It combines validation contracts, AI validation, and bounded retries to provide systematic, auditable feature completion. The lifecycle covers the full end-to-end path from clarification through blocked handoff.

### End-to-End Flow

```
Clarification → Validation Contract → Feature Execution → Validator Loop
      ↑                                                         ↓
      │    Fix-Feature Retry ←─ (budget exhausted?) ←───────────┘
      │
Blocked Handoff ←── (budget exhausted, root cause unresolvable)
```

### Phase 1: Clarification

The clarification phase occurs during mission interview and planning. Operators define:
- **Milestone outcomes** and **slice verification criteria** stored in dedicated `verification` fields
- **Feature descriptions** and **acceptance criteria**

These inputs flow directly into assertion auto-generation in the next phase.

### Phase 2: Validation Contract

Contract assertions (`MissionContractAssertion`) formalize what must be true for a feature to be considered complete:

```typescript
interface MissionContractAssertion {
  id: string;              // e.g., "CA-MS39KJP3-000A-8ABO" (legacy: "CA-A3B7CD-E9F2")
  milestoneId: string;     // Parent milestone
  sourceFeatureId?: string;// Store-managed feature assertion owner
  scope: "feature" | "milestone";
  origin: "authored" | "imported" | "derived_milestone_acceptance";
  title: string;           // Human-readable title
  assertion: string;       // Behavioral plan
  status: AssertionStatus; // pending | passed | failed | blocked
  orderIndex: number;      // Sort order within milestone
  featureIds: string[];    // Linked features (many-to-many)
}
```

**Assertion text source priority:**
1. `acceptanceCriteria` (from feature planning)
2. `feature.description` (fallback)
3. Fallback text: `"Verify implementation of: {feature.title}"`

**Coverage tracking:** `MilestoneValidationRollup` computes per-milestone coverage:

```typescript
interface MilestoneValidationRollup {
  milestoneId: string;
  totalAssertions: number;
  passed: number;
  failed: number;
  blocked: number;
  pending: number;
  unlinked: number;
  state: MilestoneValidationState;
}
```

**Validation state precedence** (highest priority wins):
1. `not_started` — no assertions exist
2. `needs_coverage` — assertions exist but some are not linked to features
3. `ready` — assertions exist and are linked, but not all have passed
4. `passed` — all assertions have passed
5. `failed` — at least one assertion failed
6. `blocked` — at least one assertion is blocked

**Current-state reconciliation:** after every successful assertion create, repair, removal, or feature-link change, the PostgreSQL store recomputes this rollup from current assertions, persists the resulting `milestones.validationState` within the same project partition, then emits the validation refresh event. A repaired final failure therefore cannot leave a persisted `failed` badge behind; a remaining failed assertion still wins the current rollup.

**Dashboard refresh freshness:** rollup and validation-telemetry requests share one monotonically increasing generation per milestone. A response writes badge/panel state only when its captured generation is still current, including initial selection, expansion, mutation refreshes, and SSE events. This is request ordering, not validation-state precedence: a newer response is allowed to legitimately transition a milestone back to `failed`.

#### Completion Gate Contract

Canonical authored feature criteria live on `MissionFeature.acceptanceCriteria`, and each feature validator derives its verdict only from its **linked feature-scoped assertions**. Validator prompts list each authoritative assertion ID in brackets; responses must return exactly one result keyed by each listed ID. To recover older model output safely, only an exact-count response with zero recognized IDs is matched positionally and recorded in diagnostics. Partial matches, duplicate IDs, and count mismatches remain fail-closed. Model summary prose, milestone prose, and behavioral results that are not mapped to a linked behavioral assertion cannot override that verdict.

Validator formatting recovery examines only the final 256 KiB of an assistant response and at most eight string-aware fenced or balanced-object candidates, preferring the final syntactically valid payload. It first parses exactly, then makes one conservative syntax-only repair for trailing commas or missing closing delimiters. Recovery never supplies or changes assertion IDs, verdicts, evidence, summaries, or aggregate outcomes; responses that remain invalid are recorded as validator errors and generate no remediation.

Milestone prose is synchronized to one canonical milestone-scoped assertion with `origin: "derived_milestone_acceptance"`. PostgreSQL restricts uniqueness to that derived origin per project/milestone; authored, imported, and migrated legacy milestone assertions stay independent, are never inferred from title/text, and require no feature links. The rollup evaluates all milestone-scoped assertions after feature coverage and feature assertion passes are ready; unmet parent criteria therefore block milestone completion without failing an already-passing feature. See [Mission Completion Gate Contract](./missions-completion-contract.md).

### Phase 3: Feature Execution Loop

Features track their implementation state via `FeatureLoopState` separate from task status:

```typescript
type FeatureLoopState =
  | "idle"         // Not yet started
  | "implementing" // Tasks are in-flight
  | "validating"   // Awaiting AI validation
  | "needs_fix"    // Validation failed, retry in progress
  | "passed"       // All assertions passed
  | "blocked";     // Retry budget exhausted, cannot proceed
```

**State transitions:**
```
idle → implementing → validating → passed (all assertions pass)
                          ↓
                   needs_fix → implementing (retry feature created)
                          ↓
                      blocked (budget exhausted)
```

When a feature enters the `implementing` state, `implementationAttemptCount` is initialized and incremented on each retry.

### Phase 4: Validator Loop

On task completion, the scheduler calls `MissionExecutionLoop.processTaskOutcome()` to run AI validation:

1. Find the feature linked to the completed task
2. If assertions are linked, keep feature completion gated until validation passes
3. Transition feature to `validating` state
4. Fire the AI validator agent (read-only judge) against contract assertions
5. Apply the **behavioral-verification posture** (see below): static assertions keep the judge's verdict; behavioral/bug assertions default to fail until a bounded, non-mutating verification run confirms them
6. Record `MissionValidatorRun` metadata for the validation attempt (per-assertion failures are stored separately in `MissionAssertionFailureRecord` rows)

For a linked task with a recorded `mergeDetails.commitSha`, the read-only judge runs from a disposable detached checkout of that landed merge revision rather than the ambient project checkout. If that checkout cannot be materialized, the judge falls back to the project root; a fail is deferred to **inconclusive** when the landed commit is not reachable from that same inspected root, or when the landed revision/its ancestry cannot be verified, preventing a branch-divergence false failure. The task worktree fork point (`baseCommitSha`) is never used as an inspection revision.

**Behavioral-verification posture (adversarial default-to-fail).** A Contract Assertion now carries a `type` (`static` | `behavioral`). The validator no longer grades a Feature "done" purely from the diff's apparent intent:

- **Static assertions** (e.g. "documented in README") keep today's read-only static judging — no added cost or strictness.
- **Behavioral / bug-fix assertions** *default to fail*. The read-only judge's "pass" on a behavioral assertion is **advisory, not authoritative**; an authoritative pass requires a separate, bounded **verification run** that exercises the implemented code (running the test suite / an agent-supplied regression test against a disposable checkout) and confirms the observable behavior. An agent's narrative claim is not evidence on its own.

**The verification run is not read-only and is not part of the judge session.** The AI judge session stays `tools: "readonly"` (no `bash`/`edit`/`write`/task-mutation). The verification run is a *separate*, side-effecting execution that runs against an isolating sandbox backend (fail-closed when none is available) and a disposable checkout at a trusted revision — never the live worktree, never the repo root. Its effects are confined to that disposable surface: it creates no board task, mutates no mission/board row, and leaves the source tree that feeds diff/merge byte-identical (git-clean) after the run. Verification is therefore no longer "purely read-only/static" — but it is *non-mutating to mission/board state*, which is the invariant the recovery sweep and reaper depend on (see Surface Enumeration).

**Inconclusive is a first-class verdict, distinct from fail.** Verification yields `pass` / `fail` / `inconclusive`. A real behavioral failure (`fail`) spawns a Fix Feature with a recorded observed-vs-expected reason. An **inconclusive** verdict — verification could not run or conclude (no isolating backend, timeout, isolation-setup failure, rejected proof, detected flakiness) — routes the feature to a blocked/needs-attention state with a persisted `verification_inconclusive` mission event and **spawns no Fix Feature**, so a fragile verification surface cannot manufacture remediation churn. A non-passing verification never resolves to a default pass.

Mission validation resolves its model from the validator lane before session creation: assigned agent runtime model (when the linked task has an assigned durable agent) → per-task `validatorModelProvider`/`validatorModelId` → project `validatorProvider`/`validatorModelId` → global `validatorGlobalProvider`/`validatorGlobalModelId` → project `defaultProviderOverride`/`defaultModelIdOverride` → global `defaultProvider`/`defaultModelId`. In `testMode`, validation is forced to `mock/scripted` instead of falling through to provider auto-detection.

Validation runs are internal mission-loop operations: Fusion does **not** create visible `🔍 Validate:` board tasks for single-feature validation.

```typescript
interface MissionValidatorRun {
  id: string;
  featureId: string;
  milestoneId: string;
  sliceId: string;
  status: "running" | "passed" | "failed" | "blocked" | "error";
  triggerType?: string;
  implementationAttempt: number;
  validatorAttempt: number;
  taskId?: string;
  summary?: string;
  blockedReason?: string;
  startedAt: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

**Validation timeout:** 10 minutes (`VALIDATION_TIMEOUT_MS = 10 * 60 * 1000`). If session creation, auth/credit checks, prompting, or timeout fails, the run is marked `error` and emits a surfaced `validation_error` mission event instead of silently spawning a fix feature.

**Manual validation admission:** `POST /api/missions/features/:featureId/validate` admits manual runs atomically per feature. A fresh `running` run, including an engine-started run, returns `409` with `details: { code: "VALIDATION_ALREADY_RUNNING", runId, featureId, startedAt }` and does not mutate the feature. The guard ignores runs older than the stale window. Automatic `admitValidatorRun` remains fingerprint-scoped: a fingerprint-less manual run does not suppress a later automatic dispatch (tracked by FN-8976).

**Stale validator-run reaper:** startup recovery and periodic self-healing also sweep `MissionValidatorRun` rows stuck in `status="running"` longer than `VALIDATOR_RUN_STALE_MAX_AGE_MS` (currently 6 hours). Runs still owned by the live process (tracked in `activeValidations`) are skipped, so a slow-but-legitimate verification is never reaped while its session is in-flight. Ownerless stale runs are reaped to terminal `status="error"`, their reap reason is stored in `summary`, and live (non-`done`) mission features are moved to `loopState="needs_fix"` with `lastValidatorStatus="error"` so the loop can re-trigger. A *done* feature's loop state is intentionally left untouched (it keeps the `loopState="validating"` set when the run started) so the reaper does not rewrite a feature that already finished its task. Runs whose parent mission is already `complete`/`archived` are likewise terminated without touching feature state. Each successful reap emits a run-audit event with `mutationType: "mission:validator-run-reaped"`.

**Verification wall-clock is bounded under the reaper window.** The aggregate verification budget — checkout materialization plus the test-suite command (`VERIFICATION_COMMAND_TIMEOUT_MS`, 10 min), including the optional pre-fix baseline run — is provably far shorter than the 6-hour reaper stale window, so a legitimate verification run completes long before it would be eligible for reaping. The reaper's `activeValidations` skip is the second line of defense: an in-flight run is never reaped regardless of wall-clock.

### Phase 5: Fix-Feature Retries

Validation always records failed runs and diagnostics. Remediation is separately opt-in: Fusion creates and auto-triages a Fix Feature only when `autopilotEnabled === true || autoAdvance === true`. With both flags false or unset, validation is **report-only**: the failed validator run and `validation_failed`/`validation_report_only` mission events remain visible, but Fusion does not mint a Fix Feature, create or plan a task, triage work, or dispatch remediation. This same predicate applies to completion, startup recovery, and periodic recovery, so a restart cannot bypass supervised mode.

`autoAdvance` remains the legacy compatible opt-in. New missions should prefer `autopilotEnabled`.

When the opt-in is enabled and validation fails, `MissionStore.createGeneratedFixFeature()` creates a fix feature with lineage tracking:

```typescript
interface MissionFixFeatureLineage {
  sourceFeatureId: string;      // Original feature being remediated
  fixFeatureId: string;         // New fix feature
  runId: string;                // Validator run that triggered this fix
  failedAssertionIds: string[]; // Assertions that failed
}
```

The fix feature is **auto-planned** (converted to tasks) for immediate execution. Each fix increments the **canonical root feature's** `implementationAttemptCount`; generated fixes never receive a fresh budget. With the default retry budget of 3 (`DEFAULT_IMPLEMENTATION_RETRY_BUDGET`), requests 1–3 mint one remediation each and request 4 mints nothing, records `budget-exhausted`, and blocks the root.

Missing, cyclic, or legacy blocked lineage fails closed. A pre-migration blocked root without an explicit stop reason cannot mint remediation and cannot be implicitly resumed.

### Phase 6: Blocked Handoff

A feature transitions to `blocked` when:
1. All retry budget is exhausted (`implementationAttemptCount >= maxRetryBudget`)
2. Validation continues to fail
3. Root cause cannot be resolved through iteration

**Blocked semantics:**
- Autopilot stops advancing the slice containing the blocked feature
- `MilestoneValidationRollup.state` reflects `blocked` assertions
- The feature remains in `blocked` state until operator intervention
- Deleting a generated fix, or archiving/deleting its generated task, records a durable root-scoped `operator-intervention` stop in the same transaction as unlink/removal. Recovery, duplicate delivery, unarchive, task/root recreation, and relinking cannot mint a sibling. The stop remains even if a hierarchy cascade removes root and lineage rows.
- `POST /api/missions/:missionId/resume` is the sole resume seam. It atomically clears only operator-intervention stops, preserves attempt counts, moves extant roots to `needs_fix`, and activates the mission. If any root is non-resumable, it changes no root, tombstone, counter, or mission state and returns HTTP 409 with `code: "MISSION_RESUME_CONFLICT"`, `blockerSchemaVersion: 1`, and `blockers: MissionBlockerDescriptor[]`. A descriptor has `schemaVersion: 1`, `kind: "mission-resume-conflict"`, `rootFeatureId`, closed `reason` (`budget-exhausted`, `operator-intervention`, or fail-closed `legacy-unknown-stop`), and `source` (`feature-row` or `lineage-stop`); lineage stops also retain `stoppedAt` and `origin`. Unknown or empty persisted reasons normalize to `legacy-unknown-stop`, retaining a non-empty persisted value as `rawReason`. The canonical array is deduplicated on `(rootFeatureId, source, reason)` while preserving distinct cross-source provenance. Consumers must treat an unrecognized `blockerSchemaVersion` as non-resumable and ask an operator rather than guessing. FN-8979 retired the v0 mirror; `legacyBlockers` is not part of this response.

On engine restart, `recoverActiveMissions()` re-enqueues features in `validating` or `needs_fix` states, ensuring no validation work is lost. It also re-triggers `implementing` features whose linked task is already `done`/`archived` and whose assertion validation has not passed yet. When the stale-run reaper has already converted an abandoned validator run into `needs_fix`, `processTaskOutcome()` promotes the feature back through `implementing` and re-validates instead of skipping it. The same recovery path is replayed during periodic self-heal maintenance, so historically stranded `implementing` features can self-heal without requiring an engine restart.

**Reaper → slice deadlock closure (P0).** A *task-less, done, assertion-linked* feature is the dangerous case: it carries no board task to re-drive from, and `computeSliceStatus` refuses to count it complete until its validator passes. When the reaper terminates such a feature's stale run, the feature is left stranded in `loopState="validating"` (the reaper's done-guard, above) — a state the `validating`/`needs_fix` recovery branches (which only re-drive features that carry a `taskId`) never re-validate, while default-to-fail would otherwise re-drive it forever to a non-terminal `error`. `recoverActiveMissions()` closes this with a **stranded-done catch-all**: any task-less, done feature in `loopState` `implementing` *or* `validating` (or `needs_fix` + `lastValidatorStatus="error"`) that has not reached a passing validator status and is not currently being validated is re-driven directly through `runFeatureValidation()`. Because the verification run is bounded and non-mutating, this reaches a terminal `pass` / `fail` / `inconclusive` (and the slice can finally resolve) instead of livelocking on `validating`/`error`.

#### Surface Enumeration — validation re-drive entry points (R15)

Now that the verification step has side effects (on a disposable, isolated surface — never mission/board state), every site that re-drives validation must remain correct: after a run the source tree feeding diff/merge is git-clean, no duplicate Fix Feature is minted, and a terminal verdict is reached without an `error`-state slice deadlock. The complete set of re-drive entry points, each gated by an adversarial reliability test in `packages/engine/src/__tests__/reliability-interactions/mission-verification-redrive-surface.test.ts`:

| Entry point | Trigger | Post-conditions asserted |
| --- | --- | --- |
| `processTaskOutcome()` | Normal task-completion validation | terminal verdict; one Fix Feature on fail (idempotent on re-drive); no validation-created board task |
| `recoverActiveMissionValidations` → **validating** branch | Restart with a feature stranded mid-validation (has taskId) | re-driven to terminal verdict; git-clean; no duplicate Fix Feature |
| → **needs_fix** branch | Reaped/abandoned run on a feature with a `taskId` | promoted via `processTaskOutcome`; terminal verdict |
| → **implementing + taskId** branch | Feature left implementing while its task already finished | re-triggered to terminal verdict |
| → **stranded-done catch-all** (`implementing`/`validating`/`needs_fix`+`error`, no taskId) | Orphaned or reaped task-less done feature (the P0 deadlock) | re-driven directly; terminal verdict, never indefinitely re-driven `error`; slice resolves |
| `reapStaleMissionValidatorRuns` | Stale ownerless run | run → terminal `error`; live feature → `needs_fix`; done feature loopState untouched; in-flight runs skipped |

Each path is verified to leave **zero mission/board residue from the verification run itself** — the only board task a failed verdict legitimately creates is the auto-triaged Fix Feature, and an inconclusive verdict creates none.

For features with missing linked assertions, the completion path is now validator-first: the loop lazily restores the store-managed per-feature assertion just before validation, then runs the AI validator instead of auto-passing. Milestone `acceptanceCriteria` is threaded into the validator prompt for every feature in that milestone, so all mission criteria are AI-evaluated. Contract details are defined in [Mission Completion Gate Contract](./missions-completion-contract.md).

### Autopilot / Scheduler Interplay

The scheduler and autopilot collaborate through a carefully ordered call sequence:

```
1. Task completes → scheduler detects completion
2. scheduler.missionExecutionLoop.processTaskOutcome() — validation FIRST
   - Finds linked feature, runs AI validation, records MissionValidatorRun
3. autopilot.handleTaskCompletion() — feature status sync SECOND
   - Syncs feature status from task state, advances slice if complete
4. scheduler filters blocked missions from further advancement (line ~532)
```

**Autopilot vs Execution Loop retry tracking:**
- **Autopilot**: Per-task retry tracking for slice/feature completion events
- **Execution Loop**: `implementationAttemptCount` for retry budget enforcement (default: 3)

These are independent tracking mechanisms — autopilot monitors mission progress while the execution loop manages feature-level retry budgets.

### Telemetry and Observability

**MissionHealth snapshot fields:**
- `activeSlices`, `activeFeatures`, `blockedFeatures`
- `validationState`, `validationRollup`
- `inProgressCount`, `passedCount`, `failedCount`, `blockedCount`

**MissionEvent audit types:**
- `slice_activated`, `feature_planned`, `feature_completed`
- `validation:started`, `validation:passed`, `validation:failed`, `validation:blocked`
- `milestone_missing_structured_assertions` (legacy-data warning surface; enforcement still lazy-restores managed assertions at runtime)
- `fix_feature:created`, `feature:blocked`

**Validator run telemetry:**
- `triggerType` — free-form trigger source (`manual`, `task_completion`, `auto`, etc.)
- `implementationAttempt` — which retry attempt this was
- `validatorAttempt` — how many validator runs for this implementation
- `status` — running | passed | failed | blocked | error
- `summary` — natural language summary of results

**Assertion failure records:**
```typescript
interface MissionAssertionFailureRecord {
  assertionId: string;
  assertionTitle: string;
  expected: string;
  actual: string;
  message: string;
}
```

**Full state snapshots:** `MissionFeatureLoopSnapshot` captures complete loop state including all validator runs and lineage chains for post-mortem analysis.

### Validation failure diagnostics

A `validation_failed` Mission activity event includes `metadata.validationDiagnostics`, the typed source of truth for failure reporting. It contains the validator `runId`, `sourceFeatureId`, overall outcome, next action, and ordered per-assertion verdicts with expected, observed, message, and evidence references. The visible event text is derived from this object—not an AI summary—so a failed event always names failed assertion IDs and labels any separately blocked assertion IDs as blocked (never as failed).

Evidence is secret-redacted before persistence. Each assertion retains at most 16 evidence entries and every message, expected, observed, and evidence text field is capped at 4,096 UTF-8 bytes. Bounded fields carry `truncated: true`, excess evidence is reported as `omittedEvidenceCount`, project paths become project-relative, and external or disposable absolute paths become `[external path omitted]`.

Generated fix features and their triaged tasks include the same **Validation cause** section with source feature, validator run, failed assertion IDs, bounded observations, and evidence. SQLite `MissionStore` and PostgreSQL `AsyncMissionStore` use the shared renderer, so a retry does not produce backend-specific causes or duplicate sections. A fix that is already linked to a canonical task is an idempotent race; otherwise Mission activity tells the operator to inspect and retry triage rather than exposing internal exception/loop-state prose.

A generated fix superseded by successful validation is terminal because it is no longer needed; superseding it never invents a passed validator result. Autonomous reconciliation preserves that terminal state instead of re-blocking it. A task-less generated fix with an unvalidated passed marker is restored to `defined` automatically, and an operator may also use validation repair to clear that marker; a passed marker tied to a validator run remains genuine evidence and is not cleared.

The loop state is internal scheduling context, not an operator diagnosis. Its public meanings and actions are:

| Public state | Meaning | Operator action |
|---|---|---|
| validating | A validator run is evaluating the landed implementation. | Inspect the run only if it remains active beyond the stale-run window. |
| needs_fix | A validator found a remediable assertion failure. | Review the event’s Validation diagnostics and triage the generated Fix feature/task. |
| blocked | Validation could not obtain sufficient proof, or retry budget is exhausted. | Resolve the stated external constraint or root cause, then retry/triage the feature. |
| implementing | A task is carrying out the feature or its generated remediation. | Follow the linked task; duplicate validator triggers with a canonical task are ignored. |

### Operator Troubleshooting

| Symptom | Diagnosis | Resolution |
|---------|-----------|------------|
| Feature stuck in "validating" | Validator owner may have died, leaving a stale `MissionValidatorRun` in `status="running"` | Check mission-loop/self-healing logs; the startup or maintenance reaper should terminate runs older than `VALIDATOR_RUN_STALE_MAX_AGE_MS` (6h) and emit `mission:validator-run-reaped` |
| Fix feature not auto-planning | `planFeature()` may have errored; check logs | Manual planning via `fn mission plan-feature <id>`; investigate `planFeature()` errors |
| Budget exhaustion loop | `implementationAttemptCount >= maxRetryBudget` (default: 3) | Increase `maxRetryBudget` in mission settings or fix root cause |
| Blocked mission not advancing | `MilestoneValidationRollup.state` shows `blocked` | Identify blocked assertions; operator must resolve root cause |
| Validation agent errors | AI session creation failed or `VALIDATION_TIMEOUT_MS` (10 min) exceeded | Check model configuration and logs; verify AI provider auth |
| No validation runs after task completion | `processTaskOutcome()` not called; check scheduler logs | Verify mission linkage on feature → task mapping; check scheduler event handlers |
| Recovery after engine restart | Features in `validating`/`needs_fix`/stalled `implementing` state may not re-enqueue | `recoverActiveMissions()` should run on startup; check recovery log count and mission-loop logs |

### Parity Verification Tests

This lifecycle is validated by integration tests in two dependent tasks:

**FN-1571 — Core parity tests:**
- `packages/core/src/mission-factory-parity.integration.test.ts` — MissionStore rollups, assertion persistence, validator run records, fix feature lineage
- `packages/engine/src/mission-factory-parity.integration.test.ts` — Scheduler/autopilot/runtime parity with the validation loop

**FN-1572 — Dashboard parity tests:**
- `packages/dashboard/src/mission-e2e.test.ts` — API contract telemetry round-trip (MissionContractAssertion → validator run → MissionHealth)
- `packages/dashboard/app/components/__tests__/MissionManager.test.tsx` — UI blocked/iterating state rendering

## Screenshot

![Mission manager](./screenshots/mission-manager.png)

See also: [Multi-Project](./multi-project.md) and [Task Management](./task-management.md).

## Agent and dashboard-chat tools

Mission hierarchy operations are available with the same project-scoped `MissionStore` contract in the pi extension, engine-managed executor/triage/heartbeat agents, and provider-backed dashboard chat. The surface is `fn_mission_list`, `fn_mission_show`, `fn_mission_create`, `fn_mission_update`, `fn_mission_set_status`, `fn_mission_delete`, `fn_milestone_add`, `fn_milestone_update`, `fn_milestone_delete`, `fn_slice_add`, `fn_slice_activate`, `fn_slice_delete`, `fn_feature_add`, `fn_feature_update`, `fn_feature_set_status`, `fn_feature_repair_validation`, `fn_feature_delete`, and `fn_feature_link_task`.

`fn_mission_list` and `fn_mission_show` are positively classified read-only. All other hierarchy operations, including `fn_feature_repair_validation` and `fn_mission_reconcile`, mutate persisted project data and remain subject to the engine action gate and permanent-agent permission policy; they are never treated as unknown or exempt tools. `fn_mission_clear_blocked` is intentionally absent from agent tool lists: it is classified as `task_agent_mutation` in both gate paths and denied in readonly workflow steps, while the CLI/pi-extension hard-withholds it from agent principals.

## Automatic mission reconciliation

The scheduler startup and self-healing maintenance passes, mission autopilot, task moves, and `fn_mission_reconcile({ id?, dryRun? })` use one idempotent reconciliation authority. `POST /api/missions/:missionId/reconcile` exposes the same pass; `dryRun: true` returns planned changes without mutation. Task-move reconciliation is best-effort: a reconciliation failure is logged but cannot suppress the mission completion trigger or its validation loop. Automatic writes are attributed to `mission-reconcile:<startup|self-healing|autopilot|task-move>` and API/tool calls retain their operator or agent actor.

### Mission Manager reconcile control

Mission detail includes **Reconcile now** for an on-demand operator pass. It first requests a zero-write dry-run preview and lists the server-returned planned feature actions. **Apply reconcile** is a separate explicit action; a failed apply leaves that preview available to retry. Archived missions report as skipped and offer no apply action.

Selection changes discard reconcile responses silently, including responses arriving before the newly selected mission detail finishes loading. Leaving a mission also releases its busy and preview state so the next mission is immediately actionable. While a new mission detail is loading, the retained previous header's reconcile controls are inert (disabled and handler-refused), preventing reconciliation of the mission just left.

Correction scans every non-archived mission and slice but never activates or triages work. It maps deterministic task lifecycle lanes, failure state, and assertion validation to feature status, repairs stale validation badges when the store supports its fenced repair primitive, and uses explicit task links only to reconcile shipped archived delivery through the store's `terminal-task-reconcile` attribution. A bounded `mission:reconcile-pass` audit event records IDs, source enums, and counters only. Git history, GitHub polling, FR-41 receipts, and FN-8845 spec-lock drift are deliberately deferred extension inputs.

Beyond the single-valued forward `feature.taskId` link, the reconcile also credits a feature as satisfying its acceptance criteria when a **terminal, non-failed** task carries the feature's reverse `mission_lineage` (`sourceMetadata.missionLineage` naming the feature's `missionId`/`sliceId`/`featureId`). This reverse-lineage credit is an additional satisfying input, not a replacement: it leaves the forward link untouched, never fires when any live lineage follow-up keeps the feature active (live withholding takes precedence), and ignores failed/errored lineage tasks. It lets a roadmap feature close `done` even when its forward link is pinned to a shared, non-satisfying task (RUFU-109).

For example, activate a ready work unit with `fn_slice_activate({ id: "SL-…" })`. Link it to live work with `fn_feature_link_task({ featureId: "F-…", taskId: "FN-…" })`. Linking delegates to `MissionStore.linkFeatureToTask()`: it verifies the task is a live row in the same project, changes the feature to `triaged`, and records the mission/slice linkage on the task. Archived, deleted, missing, and other-project tasks are rejected.

## Ideation handoff

[Persisted ideation](./ideation/persisted-diverge-converge.md) converges a selected candidate into this canonical hierarchy. It atomically creates or attaches a Mission and persists that linkage, rather than maintaining a parallel roadmap document.

## Research-derived features

A completed cited research finding may become a normal Mission Feature. Its feature retains research run, stable finding, and source-URL provenance; optional triage uses the normal feature task flow. Linked task changes reconcile through the existing feature → slice → milestone → mission rollups, and task completion remains subject to assertion validation.

### Autonomous mission admission

Autonomous no-task heartbeat agents may create or delegate implementation work only with an approved Feature → Slice → Milestone → Mission lineage. Interactive and task-scoped calls remain governed by `task_agent_mutation` policy as described in [Agent task-creation admission](#agent-task-creation-admission). The created task stores that lineage as task metadata; it does not replace the canonical feature `taskId` link except at the documented `defined`-feature first-task bootstrap. Missing or invalid autonomous lineage is rejected before a task is persisted. Roadmap reconciliation marks done tasks done, returns cancelled/requeued tasks to triaged, keeps failed work non-complete, and treats archives as non-promoting no-ops.

## Validator memoization and failure budget (FN-8694)

Automatic feature validation is content-addressed by landed SHA, resolved judge provider/model, and exact built prompts. Admission is atomic per project and feature: its in-flight check observes every fresh running validator, including fingerprint-less manual and non-memo automatic runs, while honoring the reaper stale window so a dead run cannot wedge validation. After that liveness check, terminal history is selected deterministically by fingerprint: static-only passes are reused, and matching failures permit at most three dispatched runs before the feature is blocked. Behavioral or mixed assertions never reuse a pass, but failures are still budgeted.

Every automatic suppression appends one visible `validation memoized` activity event (`running`, `reuse-pass`, or `budget-exhausted`) with fingerprint and referenced run ID where available. Initial exhaustion additionally appends one `validation-stuck` event; later unchanged sweeps append only their memoized event. No synthetic validator run or verdict is created for reuse or exhaustion. Missing landed SHA, fallback checkout, unknown judge identity, and preparation failures fail open to ordinary validation; `error`/`blocked` outcomes are transient. Manual validation bypasses memoization and the budget, but its live run blocks a concurrent automatic dispatch. Recovery revisits only a feature bearing FN-8694's budget-block provenance: unchanged inputs remain blocked, while a changed prepared fingerprint can be admitted; unrelated blocked/remediation/operator states stay closed.

## Spec alignment

A linked task may expose a separate spec alignment signal: `on-plan`, `diverged-needs-review`, `diverged-relocked-approved`, or `unavailable`. This signal is independent of feature delivery and validation status; it never marks a feature done, blocks a task, or substitutes for assertion validation. Archived tasks retain their task-visible lock history but follow the existing unlink behavior and do not recreate a feature projection. Scheduler and autopilot reconciliation persist the current deterministic projection on each linked feature even when delivery status does not change, and Mission Manager renders that retained projection.


`fn_feature_set_status` preserves the linked-task guard: `triaged`, `in-progress`, `done`, and `blocked` require a linked task; link an existing task with `fn_feature_link_task` or triage the feature first. Feature status writes emit `feature_status_changed` atomically with the row write at every production writer: engine and pi tools, dashboard REST repairs, scheduler work, linking/claiming, terminal-task reconciliation, validator reuse, and superseded-fix reconciliation. Feature and mission status events use one total, size-capped metadata builder, which persists only ids-only actor fields (`type`, `id`, `source`; never `displayName`) and an optional redacted, byte-bounded reason.

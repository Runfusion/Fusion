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

## Canonical lineage approval for autonomous symbol locks

Before autonomous scheduler work may acquire a symbol lock, it resolves the task's Mission → Milestone → Slice → Feature lineage and evaluates the single `@fusion/core` contract: `evaluateMissionLineageApproval`. Resolution and lock acquisition remain scheduler responsibilities; downstream schedulers must not redefine the approval rule.

Approval requires every one of these statuses:

- Mission: `active`
- Milestone: `active`
- Slice: `active`
- Feature: `triaged` or `in-progress`

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

### Mission branch strategy defaults

Missions can also persist a `branchStrategy` used whenever triage is triggered without explicit branch options (manual triage and autopilot triage).

Supported modes:

- `project-default` (or absent): shared mode; each triaged feature gets a distinct per-task working branch (for example `<shared-branch>/<feature-id>`) while the shared branch remains the mission group merge target
- `auto-per-task`: sets `branchAssignment.mode = "per-task-derived"` (distinct per-task working branches with no shared mission group merge target)
- `existing`: shared mode using `branchSelection.mode = "existing"` with `branchName` as the shared merge-target branch
- `custom-new`: shared mode using `branchSelection.mode = "custom-new"` with `branchName` as the shared merge-target branch

The Mission Manager create/edit form exposes this as **Branch strategy** plus a conditional **Branch name** field for `existing` and `custom-new`.

### Mission auto-merge override

The **Merge behavior** control can inherit the project default, explicitly enable auto-merge, or select **Single pull request**. In-context help explains that auto-merge lands each feature individually while a single pull request retains all features on a shared branch for joint review. The latter persists `autoMerge: false` on the mission and stamps newly triaged feature tasks with the same false override, while preserving the mission's shared branch group. Returning the control to inherited clears the mission override. Once a shared branch has members, Mission detail displays its branch name, member count, and PR state.

### Shared branch-group invariant across entry points

Across all branch entry points (planning/subtask creation, mission triage, and New Task `shared-group` creation), Fusion enforces one rule:

- Persist a **per-task working branch** on each task (the checkout branch used for execution).
- Persist the shared branch only as the **group merge target** via `branchContext.groupId` → `branch_groups.branchName`.
- Never persist the shared branch itself as a task working/checkout branch.

This keeps member execution isolated per task while still routing member landings into a single shared integration branch.

### Dashboard

Use the Mission Manager UI to create missions and build hierarchy interactively.

On mobile, Mission Manager surfaces the primary **Plan New Mission** CTA at the top of the mission list for faster access, while desktop keeps the split-layout sidebar CTA anchored in the bottom action region as the primary entry point.

Mission detail refreshes now preserve expanded milestone/slice state and keep the selected milestone expanded, so persisted milestone acceptance criteria remain visible across live updates.

Mission, milestone, slice, and feature read-only text surfaces in Mission Manager render Markdown (GFM) for descriptions, verification, and acceptance criteria; edit forms continue to use raw plain-text `<textarea>` inputs.

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
| `fn_milestone_add` | Add a milestone to a mission. |
| `fn_milestone_update` | Update milestone fields using partial patches. |
| `fn_slice_add` | Add a slice to a milestone. |
| `fn_slice_activate` | Activate a pending slice for implementation. |
| `fn_slice_delete` | Delete a slice (with linked-task guard and optional `force`). |
| `fn_feature_add` | Add a feature to a slice with optional acceptance criteria. |
| `fn_feature_delete` | Delete a feature (with linked-task guard and optional `force`). |
| `fn_feature_update` | Update feature fields using partial patches. |
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
- Active slices are currently allowed to progress
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
3. If a slice is complete, autopilot activates next pending slice
4. When milestones are all complete, mission transitions to complete

If validation cannot run (unexpected loop state, duplicate trigger, blocked validation, or validator error), Fusion logs a mission `warning`/`error` event with structured metadata so the stuck state is visible in mission events.

## `autopilotEnabled` vs `autoAdvance`

- **`autopilotEnabled`**: primary control for autopilot behavior — enables background monitoring, orchestration, and automatic slice activation when a slice completes. Also triggers auto-planning (converting features to tasks) when a slice is activated.
- **`autoAdvance`**: legacy fallback for backward compatibility with existing mission data. Kept for compatibility — new missions should use `autopilotEnabled`.

**Auto-planning behavior:**

- `autopilotEnabled=true` → features in activated slices are automatically planned (converted to tasks)
- `autopilotEnabled=false`, `autoAdvance=true` → features are planned (legacy compat)
- Active autopilot slices are continuously reconciled on startup recovery and periodic maintenance: stranded features (`taskId == null`) are re-triaged idempotently, title-matched tasks are linked first, and successful link/triage repairs emit `mission:stranded-feature-triaged` run-audit events.
- `autopilotEnabled=false`, `autoAdvance=false` → manual slice activation only

**Slice progression (on slice completion):**

- `autopilotEnabled=true` → next pending slice is automatically activated
- `autopilotEnabled=false`, `autoAdvance=true` → next pending slice is activated (legacy compat)
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
- Looks up the feature and the delivery task in the request's scoped project store.
- Only allows reconciliation when the delivery task column is `done` or `archived`.
- If feature has no `taskId`, the endpoint links it first, then marks feature status `done` via `updateFeatureStatus` (which recomputes slice status).
- If feature already has a different `taskId`, returns `409` (conflict).

**How this differs from `PATCH /api/missions/features/:featureId`:**

- `PATCH` keeps the execution-status guard and rejects `done`/`triaged`/`in-progress`/`blocked` when no linked task exists.
- `reconcile-done` is a dedicated, evidence-gated path for shipped work where the delivery task is already terminal.

**Error responses:**

- `400` — invalid feature ID format or missing/empty `taskId`.
- `404` — feature not found or delivery task not found.
- `409` — feature/task mismatch or delivery task is not in `done`/`archived` (use normal PATCH/triage/link flow for active work).

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
  id: string;              // e.g., "CA-A3B7CD-E9F2"
  milestoneId: string;     // Parent milestone
  sourceFeatureId?: string;// Store-managed feature assertion owner
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

#### Completion Gate Contract

Canonical authored feature criteria live on `MissionFeature.acceptanceCriteria`, but mission autopilot enforcement runs through each feature's **linked contract assertions** (store-managed per-feature assertion plus any additive linked milestone assertions). `milestone.acceptanceCriteria` remains authored milestone pass-bar text for humans, while validator gating/advance decisions follow assertion linkage and outcomes; see [Mission Completion Gate Contract](./missions-completion-contract.md) for the authoritative enforced-vs-informational surface map and zero-assertion behavior.

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

**Stale validator-run reaper:** startup recovery and periodic self-healing also sweep `MissionValidatorRun` rows stuck in `status="running"` longer than `VALIDATOR_RUN_STALE_MAX_AGE_MS` (currently 6 hours). Runs still owned by the live process (tracked in `activeValidations`) are skipped, so a slow-but-legitimate verification is never reaped while its session is in-flight. Ownerless stale runs are reaped to terminal `status="error"`, their reap reason is stored in `summary`, and live (non-`done`) mission features are moved to `loopState="needs_fix"` with `lastValidatorStatus="error"` so the loop can re-trigger. A *done* feature's loop state is intentionally left untouched (it keeps the `loopState="validating"` set when the run started) so the reaper does not rewrite a feature that already finished its task. Runs whose parent mission is already `complete`/`archived` are likewise terminated without touching feature state. Each successful reap emits a run-audit event with `mutationType: "mission:validator-run-reaped"`.

**Verification wall-clock is bounded under the reaper window.** The aggregate verification budget — checkout materialization plus the test-suite command (`VERIFICATION_COMMAND_TIMEOUT_MS`, 10 min), including the optional pre-fix baseline run — is provably far shorter than the 6-hour reaper stale window, so a legitimate verification run completes long before it would be eligible for reaping. The reaper's `activeValidations` skip is the second line of defense: an in-flight run is never reaped regardless of wall-clock.

### Phase 5: Fix-Feature Retries

When validation fails, `MissionStore.createGeneratedFixFeature()` creates a fix feature with lineage tracking:

```typescript
interface MissionFixFeatureLineage {
  sourceFeatureId: string;      // Original feature being remediated
  fixFeatureId: string;         // New fix feature
  runId: string;                // Validator run that triggered this fix
  failedAssertionIds: string[]; // Assertions that failed
}
```

The fix feature is **auto-planned** (converted to tasks) for immediate execution. Each fix increments `implementationAttemptCount`.

**Default retry budget:** 3 (`DEFAULT_IMPLEMENTATION_RETRY_BUDGET`). When `implementationAttemptCount >= maxRetryBudget`, the feature transitions to `blocked`.

### Phase 6: Blocked Handoff

A feature transitions to `blocked` when:
1. All retry budget is exhausted (`implementationAttemptCount >= maxRetryBudget`)
2. Validation continues to fail
3. Root cause cannot be resolved through iteration

**Blocked semantics:**
- Autopilot stops advancing the slice containing the blocked feature
- `MilestoneValidationRollup.state` reflects `blocked` assertions
- The feature remains in `blocked` state until operator intervention

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

Mission hierarchy operations are available with the same project-scoped `MissionStore` contract in the pi extension, engine-managed executor/triage/heartbeat agents, and provider-backed dashboard chat. The surface is `fn_mission_list`, `fn_mission_show`, `fn_mission_create`, `fn_mission_update`, `fn_mission_delete`, `fn_milestone_add`, `fn_milestone_update`, `fn_milestone_delete`, `fn_slice_add`, `fn_slice_activate`, `fn_slice_delete`, `fn_feature_add`, `fn_feature_update`, `fn_feature_delete`, and `fn_feature_link_task`.

`fn_mission_list` and `fn_mission_show` are positively classified read-only. All other hierarchy operations mutate persisted project data and remain subject to the engine action gate and permanent-agent permission policy; they are never treated as unknown or exempt tools.

For example, activate a ready work unit with `fn_slice_activate({ id: "SL-…" })`. Link it to live work with `fn_feature_link_task({ featureId: "F-…", taskId: "FN-…" })`. Linking delegates to `MissionStore.linkFeatureToTask()`: it verifies the task is a live row in the same project, changes the feature to `triaged`, and records the mission/slice linkage on the task. Archived, deleted, missing, and other-project tasks are rejected.

## Ideation handoff

[Persisted ideation](./ideation/persisted-diverge-converge.md) converges a selected candidate into this canonical hierarchy. It atomically creates or attaches a Mission and persists that linkage, rather than maintaining a parallel roadmap document.

## Research-derived features

A completed cited research finding may become a normal Mission Feature. Its feature retains research run, stable finding, and source-URL provenance; optional triage uses the normal feature task flow. Linked task changes reconcile through the existing feature → slice → milestone → mission rollups, and task completion remains subject to assertion validation.

### Autonomous mission admission

Heartbeat agents may create or delegate implementation work only with an approved Feature → Slice → Milestone → Mission lineage. The created task stores that lineage as task metadata; it does not replace the canonical feature `taskId` link. Missing or invalid lineage is rejected before a task is persisted. Roadmap reconciliation marks done tasks done, returns cancelled/requeued tasks to triaged, keeps failed work non-complete, and treats archives as non-promoting no-ops.

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

- `project-default` (or absent): shared branch behavior; no per-task derivation
- `auto-per-task`: sets `branchAssignment.mode = "per-task-derived"` (task branches auto-derived from task details)
- `existing`: shared branch using `branchSelection.mode = "existing"` with `branchName`
- `custom-new`: shared branch using `branchSelection.mode = "custom-new"` with `branchName`

The Mission Manager create/edit form exposes this as **Branch strategy** plus a conditional **Branch name** field for `existing` and `custom-new`.

### Dashboard

Use the Mission Manager UI to create missions and build hierarchy interactively.

On mobile, Mission Manager surfaces the primary **Plan New Mission** CTA at the top of the mission list for faster access, while desktop keeps the split-layout sidebar CTA anchored in the bottom action region as the primary entry point.

Mission detail refreshes now preserve expanded milestone/slice state and keep the selected milestone expanded, so persisted milestone acceptance criteria remain visible across live updates.

Mission, milestone, slice, and feature read-only text surfaces in Mission Manager render Markdown (GFM) for descriptions, verification, and acceptance criteria; edit forms continue to use raw plain-text `<textarea>` inputs.

### CLI

```bash
fn mission create "Reliability initiative" "Reduce execution failures and improve recovery"
fn mission list
fn mission show mission_123
fn mission activate-slice slice_456
fn mission delete mission_123 --force
```

## Mission Planning Tools (pi extension)

The canonical per-parameter tool reference lives in `packages/cli/skill/fusion/references/extension-tools.md`; this section is a user-facing summary of the mission-planning tool surface.

| Tool | Purpose |
|---|---|
| `fn_mission_create` | Create a mission with title/description, optional `baseBranch`, and optional auto-advance behavior. |
| `fn_mission_list` | List missions and their current status. |
| `fn_mission_show` | Show mission details with milestone/slice/feature hierarchy, including milestone/feature acceptance criteria and slice verification when present. |
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
- Resume in-progress mission interview sessions directly from separate transient session rows in the main missions list (`mission_interview` sessions in `generating`, `awaiting_input`, or `error`) before a mission record is created
- Banner-driven mission interview resumes are one-shot: if you close or send the interview to background, Missions re-fetches project-scoped `mission_interview` sessions and re-surfaces the transient row (including on the mobile stacked Missions view) so resume/retry remains discoverable without losing persisted `interviewState: "in_progress"` mission cards
- Mission interview, milestone interview, and slice interview agents have read-only board visibility via `fn_task_list` and `fn_task_get`, so they can reference active backlog context and avoid duplicating in-flight tasks while asking planning questions

### Mission Interview Drafts

Mission interview sessions are persisted in `ai_sessions` before a mission row exists, so unfinished drafts stay recoverable across reloads and restarts.

- **Dashboard:** the Missions view shows a **Drafts** section for in-flight `mission_interview` sessions with **Resume** and **Discard** actions.
- **CLI:** `fn mission list` shows drafts by default before normal mission status sections. Pass `--no-drafts` to hide them.
- **pi extension:** `fn_mission_list` includes drafts by default and accepts `includeDrafts: false` to suppress them.
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

**Operator repair note (FN-5696):** Some databases created before the feature-create-path fix could show feature `acceptanceCriteria`/`description` in the UI but still have zero `mission_feature_assertions` links, which caused validator auto-pass short-circuits. Run `node scripts/backfill-fn-5696-feature-assertions.mjs` to preview repairs, then `node scripts/backfill-fn-5696-feature-assertions.mjs --apply` to write links. Use `--mission=<missionId>` for scoped repair (for example the confirmed Goals mission `M-MP32KU9Y-0001-2ADN`).
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
4. Fire AI validator agent against contract assertions
5. Record `MissionValidatorRun` with per-assertion results

Validation runs are internal mission-loop operations: Fusion does **not** create visible `🔍 Validate:` board tasks for single-feature validation.

```typescript
interface MissionValidatorRun {
  id: string;
  featureId: string;
  missionId: string;
  taskId: string;
  triggerType: "manual" | "automatic";
  implementationAttempt: number;
  validatorAttempt: number;
  status: "started" | "passed" | "failed" | "blocked" | "error";
  summary: string;
  results: AssertionResult[];
  blockedReason?: string;
  startedAt: string;
  completedAt?: string;
}
```

**Validation timeout:** 10 minutes (`VALIDATION_TIMEOUT_MS = 10 * 60 * 1000`). If the validator times out, the run is marked `error` and the feature remains in `needs_fix` for retry.

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

On engine restart, `recoverActiveMissions()` re-enqueues features in `validating` or `needs_fix` states from the `activeValidations` set, ensuring no validation work is lost. It also re-triggers `implementing` features whose linked task is already `done`/`archived` and whose assertion validation has not passed yet. The same recovery path is replayed during periodic self-heal maintenance, so historically stranded `implementing` features can self-heal without requiring an engine restart.

For features with zero linked assertions, the completion path is explicit: the loop marks the feature `done`, advances `loopState` to `passed`, emits `validation:passed` with summary `"No assertions linked"`, and records mission event code `validation_auto_passed_no_assertions`. Contract details (including canonical no-assertions behavior and FN-5696 assertion-authoring separation) are defined in [Mission Completion Gate Contract](./missions-completion-contract.md).

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
- `validation_auto_passed_no_assertions` (reason: `"No assertions linked"`)
- `milestone_missing_structured_assertions` (warning when prose criteria exist with zero structured assertions)
- `fix_feature:created`, `feature:blocked`

**Validator run telemetry:**
- `triggerType` — manual vs automatic
- `implementationAttempt` — which retry attempt this was
- `validatorAttempt` — how many validator runs for this implementation
- `status` — started | passed | failed | blocked | error
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
| Feature stuck in "validating" | `activeValidations` set may be stale; engine restart needed | Check logs for validator errors; restart engine to trigger `recoverActiveMissions()` |
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

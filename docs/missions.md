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

### Dashboard

Use the Mission Manager UI to create missions and build hierarchy interactively.

### CLI

```bash
fn mission create "Reliability initiative" "Reduce execution failures and improve recovery"
fn mission list
fn mission show mission_123
fn mission activate-slice slice_456
fn mission delete mission_123 --force
```

## Mission Interview and Planning Workflow

The dashboard supports mission planning workflows where you can:

- Define mission outcomes
- Break work into milestones/slices/features
- Associate features to executable tasks
- Track progress at each layer

### Auto-Generated Assertions

When missions are created through the interview planning workflow, Fusion automatically generates contract assertions for each feature:

- **Assertion text source priority**: `acceptanceCriteria` → `feature.description` → fallback text (`"Verify implementation of: {feature.title}"`)
- **Assertions are linked to features**: Each auto-generated assertion is automatically linked to its feature, enabling mission validation rollup and enriched triage context
- **Verification fields**: Milestone and slice verification criteria from the interview are stored in dedicated `verification` fields rather than concatenated into descriptions
- **Partial plans handled**: Auto-generation is robust to partial plans (missing slices/features or empty criteria) without throwing errors

## Slice Activation and Progress

Slices represent staged execution windows.

- Pending slices remain inactive
- Active slices are currently allowed to progress
- Completion rolls up through feature → slice → milestone → mission

Manual activation is available through `fn mission activate-slice <slice-id>`.

## Mission Autopilot

When `autopilotEnabled` is on, Fusion can watch completion events and progress missions automatically.

State machine:

- `inactive`
- `watching`
- `activating`
- `completing`

Typical flow:

1. Mission is watched
2. Task completion updates feature status
3. If a slice is complete, autopilot activates next pending slice
4. When milestones are all complete, mission transitions to complete

## `autopilotEnabled` vs `autoAdvance`

- **`autopilotEnabled`**: primary control for autopilot behavior — enables background monitoring, orchestration, and automatic slice activation when a slice completes. Also triggers auto-triage (converting features to tasks) when a slice is activated.
- **`autoAdvance`**: legacy fallback for backward compatibility with existing mission data. Kept for compatibility — new missions should use `autopilotEnabled`.

**Auto-triage behavior:**

- `autopilotEnabled=true` → features in activated slices are automatically triaged (converted to tasks)
- `autopilotEnabled=false`, `autoAdvance=true` → features are triaged (legacy compat)
- `autopilotEnabled=false`, `autoAdvance=false` → manual slice activation only

**Slice progression (on slice completion):**

- `autopilotEnabled=true` → next pending slice is automatically activated
- `autopilotEnabled=false`, `autoAdvance=true` → next pending slice is activated (legacy compat)
- `autopilotEnabled=false`, `autoAdvance=false` → manual activation required

**Dashboard UI:** The Mission Manager shows `autopilotEnabled` as the primary control. When enabling autopilot on an already-active mission, the system automatically checks whether recovery is needed (no active slice or completed active slice) and progresses accordingly.

## Autopilot API Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/missions/:missionId/autopilot` | Get autopilot status for mission |
| `PATCH /api/missions/:missionId/autopilot` | Enable/disable autopilot (`{ enabled: boolean }`) |
| `POST /api/missions/:missionId/autopilot/start` | Start watching manually |
| `POST /api/missions/:missionId/autopilot/stop` | Stop watching manually |

## Factory Operating Model

The Factory operating model is Fusion's structured feature delivery system for missions. It combines validation contracts, AI validation, and bounded retries to provide systematic, auditable feature completion. The model covers the full end-to-end lifecycle from clarification through blocked handoff.

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
  title: string;           // Human-readable title
  assertion: string;       // Behavioral specification
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
2. Transition feature to `validating` state
3. Fire AI validator agent against contract assertions
4. Record `MissionValidatorRun` with per-assertion results

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

The fix feature is **auto-triaged** (converted to tasks) for immediate execution. Each fix increments `implementationAttemptCount`.

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

On engine restart, `recoverActiveMissions()` re-enqueues features in `validating` or `needs_fix` states from the `activeValidations` set, ensuring no validation work is lost.

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
- `slice_activated`, `feature_triaged`, `feature_completed`
- `validation:started`, `validation:passed`, `validation:failed`, `validation:blocked`
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
| Fix feature not auto-triaging | `triageFeature()` may have errored; check logs | Manual triage via `fn mission triage-feature <id>`; investigate `triageFeature()` errors |
| Budget exhaustion loop | `implementationAttemptCount >= maxRetryBudget` (default: 3) | Increase `maxRetryBudget` in mission settings or fix root cause |
| Blocked mission not advancing | `MilestoneValidationRollup.state` shows `blocked` | Identify blocked assertions; operator must resolve root cause |
| Validation agent errors | AI session creation failed or `VALIDATION_TIMEOUT_MS` (10 min) exceeded | Check model configuration and logs; verify AI provider auth |
| No validation runs after task completion | `processTaskOutcome()` not called; check scheduler logs | Verify mission linkage on feature → task mapping; check scheduler event handlers |
| Recovery after engine restart | Features in `validating`/`needs_fix` state may not re-enqueue | `recoverActiveMissions()` should run on startup; check recovery log count |

### Parity Verification Tests

The Factory model is validated by integration tests in two dependent tasks:

**FN-1571 — Core parity tests:**
- `packages/core/src/mission-factory-parity.integration.test.ts` — MissionStore rollups, assertion persistence, validator run records, fix feature lineage
- `packages/engine/src/mission-factory-parity.integration.test.ts` — Scheduler/autopilot/runtime parity with the validation loop

**FN-1572 — Dashboard parity tests:**
- `packages/dashboard/src/mission-e2e.test.ts` — API contract telemetry round-trip (MissionContractAssertion → validator run → MissionHealth)
- `packages/dashboard/app/components/__tests__/MissionManager.test.tsx` — UI blocked/iterating state rendering

## Screenshot

![Mission manager](./screenshots/mission-manager.png)

See also: [Multi-Project](./multi-project.md) and [Task Management](./task-management.md).

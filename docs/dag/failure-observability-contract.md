# DAG Failure Model + Observability Contract (Milestone A)

Related tasks: **FN-4487**, **FN-4471**, governance/policy dependencies **FN-4359**, **FN-3973**, **FN-4488**, retry context **FN-4398**.

See also: [Requirements Matrix](./requirements-matrix.md) · [ADR v1](./adr-0001-dag-orchestration.md)

## 1) Failure taxonomy

- **Per-node failure**: a node reaches failed terminal state due to execution error/timeouts.
- **Edge failure (dependency unsatisfied)**: downstream node cannot enqueue because one or more required predecessor outcomes are missing/invalid.
- **Partial-DAG abort**: DAG run transitions to aborted with a subset of nodes complete and remainder marked skipped/blocked.
- **Whole-DAG cancel**: operator/system cancellation transitions all non-terminal nodes to canceled/skipped with audit trail.
- **Retry-exhausted**: bounded retries consumed for node/run; record retry budget burn (align with FN-4398 `retriesBurned` concepts).
- **Governance-blocked**: execution path denied by policy gate (spawn/approval restrictions, e.g., FN-3973 and FN-4488 governance).

## 2) Interaction contract with existing reliability layers

Milestone B implementation MUST preserve all behaviors below:

1. **SelfHealingManager (`packages/engine/src/self-healing.ts`)**
   - No new reliability-layer code paths are required for Milestone B prototype.
   - DAG state machine must remain additive and not alter existing self-healing recovery semantics.

2. **RestartRecoveryCoordinator (`packages/engine/src/restart-recovery-coordinator.ts`)**
   - DAG run/node state must be reconstructible from SQLite alone after process restart.
   - Recovery should not require ephemeral in-memory DAG state as source of truth.

3. **Merger post-squash audit + file-scope invariant (`packages/engine/src/merger.ts`)**
   - DAG orchestration must not alter one-task/one-branch merge assumptions.
   - Existing audit and file-scope gating remain unchanged and mandatory.

4. **Workflow steps `gateMode` semantics (`docs/workflow-steps.md`)**
   - `gate` failures continue blocking merge; `advisory` remains non-blocking.
   - DAG path cannot silently downgrade or bypass configured workflow gates.

5. **Executor checkout leasing (409 contention semantics)**
   - Lease conflicts remain hard conflicts (409) and are not auto-retried by DAG coordinator logic.
   - DAG scheduler logic must respect existing ownership/checkout contracts.

## 3) Observability contract

### Structured logger prefix

Use a dedicated prefix aligned to existing conventions (`[executor]`, `[scheduler]`, `[stuck-detector]`):
- **`[dag-coordinator]`** for DAG orchestration lifecycle logs.

### Minimum event vocabulary

- `dag:run:start`
- `dag:node:enqueue`
- `dag:node:complete`
- `dag:node:fail`
- `dag:run:complete`
- `dag:run:abort`

Each event should include (at minimum): `runId`, `dagRunId`, `taskId` (when applicable), `nodeId`, `status`, `reasonCode` (for fail/abort/block), and timestamp.

### Run-audit linkage

DAG lifecycle mutations must emit auditable events consistent with the run-audit contract (`AGENTS.md` Run Audit section):
- database domain for DAG state transitions,
- git domain unchanged (normal task branch/merge flow),
- filesystem domain only when writing normal task artifacts.

### Dashboard surfacing

Operator-facing DAG views are **deferred to Milestone C**. Milestone B only requires machine-usable structured logs/audit evidence and minimal debug visibility.

## 4) Out of scope (explicit)

- Cross-node DAG execution beyond existing mesh model constraints.
- Multi-tenant orchestration isolation redesign.
- Time-travel/replay engine semantics.
- Autoscaling/orchestration-level capacity management.

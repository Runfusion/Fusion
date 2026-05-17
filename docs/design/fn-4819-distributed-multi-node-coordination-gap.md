# FN-4819 — Distributed Multi-Node Task Coordination Gap Specification

## 1. Baseline: Single-Node SQLite WAL Correctness Model

Fusion's current correctness baseline is single-node.
Within one project runtime, structured task metadata is stored in one per-project SQLite database at `.fusion/fusion.db`.
That database runs in WAL mode.
Large blobs stay on disk under `.fusion/tasks/{ID}/`.

From `AGENTS.md` (Storage Model):

> Fusion uses a hybrid storage architecture: structured metadata lives in SQLite (`.fusion/fusion.db`) while large blob files (PROMPT.md, attachments) remain on the filesystem under `.fusion/tasks/{ID}/`. The database runs in WAL mode for concurrent access.

From `AGENTS.md` (Checkout Leasing):

> Checkout conflicts return **409 Conflict** when another agent already holds the lease.
> Clients **must not retry 409 automatically** — this is ownership contention, not a transient failure.

From `docs/storage.md`:

- Project authoritative task row storage is `.fusion/fusion.db` (`docs/storage.md:70`).
- SQLite connections enforce `journal_mode = WAL` and `busy_timeout` (`docs/storage.md:92-101`).

Within one process, ownership is enforced by `AgentStore.checkoutTask(...)`.
The in-process path checks `task.checkedOutBy`, throws `CheckoutConflictError` if held by another agent, and writes lease fields on success (`packages/core/src/agent-store.ts:1378-1426`).

Durable lease-related fields already present on task rows are:

- `checkedOutBy`
- `checkoutNodeId`
- `checkoutRunId`
- `checkoutLeaseEpoch`
- `checkoutLeaseRenewedAt`

These are defined on task records in `packages/core/src/store.ts:155-160` and persisted through the task row write path (`packages/core/src/store.ts:1571-1576`, `1599-1624`).

### Gap statement

Under multi-node operation, each node can maintain a locally consistent read/write path for the same logical task row, but there is no documented atomic cross-node compare-and-set ownership contract.
Two nodes can each evaluate the local single-row precondition as true before either write is globally fenced, causing double-checkout risk.
SQLite WAL guarantees concurrency semantics for a database file, not distributed consensus across multiple node runtimes.
Therefore, the single-node WAL safety model does not, by itself, define cross-node lease correctness.

## 2. Distributed Checkout Mutex (Independent, Testable)

This section is intentionally independent from §3.
It is testable without invoking unavailable-node handoff logic.

### 2.1 Contract

A lease claim attempt by claimant tuple `(nodeId, agentId, runId)` against task `(projectId, taskId)` MUST:

1. Atomically read ownership precondition over:
   - `checkedOutBy`
   - `checkoutNodeId`
   - `checkoutLeaseEpoch`
2. Either:
   - Acquire ownership and bump epoch (`checkoutLeaseEpoch = priorEpoch + 1`) for owner changes, or
   - Return `CheckoutConflictError` populated with current owner details.
3. Renewal by the existing owner MUST update renewal timestamp but MUST NOT bump epoch.

### 2.2 Authority placement decision

**Decision:** Use an authoritative central claim row in `~/.fusion/fusion-central.db`, keyed by `(projectId, taskId)`.

Why this option:

- Least new infrastructure relative to existing architecture.
- Reuses existing central registry database already used for cross-project/node coordination (`docs/multi-project.md:19`, `packages/core/src/central-core.ts:7`, `2626`).
- Avoids introducing external consensus services.
- Keeps per-project `.fusion/fusion.db` semantics intact for local task state while adding one cross-node authority point.

Rejected options (for FN-4819 scope):

- Pure per-project DB mutex only:
  - insufficient when ownership arbitration spans nodes and runtimes.
- Full distributed consensus layer:
  - larger infra jump than required for the defined gap.

### 2.3 Data model (minimum)

Authoritative central table (conceptual): `taskClaims`

Primary key:

- `(projectId, taskId)`

Required columns:

- `projectId TEXT NOT NULL`
- `taskId TEXT NOT NULL`
- `ownerNodeId TEXT NOT NULL`
- `ownerAgentId TEXT NOT NULL`
- `ownerRunId TEXT NULL`
- `leaseEpoch INTEGER NOT NULL`
- `leaseRenewedAt TEXT NOT NULL`
- `createdAt TEXT NOT NULL`
- `updatedAt TEXT NOT NULL`

Optional but recommended columns:

- `ownerSessionId TEXT NULL`
- `metadataJson TEXT NULL`

Task row remains source for local executor checks and backward compatibility:

- `checkedOutBy`
- `checkoutNodeId`
- `checkoutRunId`
- `checkoutLeaseEpoch`
- `checkoutLeaseRenewedAt`

### 2.4 Acquisition semantics

Acquisition is one atomic write transaction in central DB.
Use single-writer semantics with `INSERT ... ON CONFLICT(projectId, taskId) DO UPDATE ... WHERE <precondition>`.

Precondition for claimant change:

- Existing claim is absent, OR
- Existing claim matches same owner tuple for renewal path, OR
- Existing claim explicitly released.

Owner-change claim success path:

- `leaseEpoch = existingEpoch + 1` (or `1` on first claim)
- Set owner tuple to claimant.
- Set `leaseRenewedAt = now`.

Renewal success path (same owner tuple):

- Keep `leaseEpoch` unchanged.
- Update `leaseRenewedAt = now`.

Loser path:

- No mutation.
- Return `CheckoutConflictError` with current holder.
- Caller MUST NOT auto-retry immediately (matches existing 409 semantics from `AGENTS.md` Checkout Leasing).

### 2.5 Per-project row synchronization

On successful central claim transaction, update per-project task row lease fields in the same logical operation boundary:

- Write `checkedOutBy = ownerAgentId`
- Write `checkoutNodeId = ownerNodeId`
- Write `checkoutRunId = ownerRunId`
- Write `checkoutLeaseEpoch = central.leaseEpoch`
- Write `checkoutLeaseRenewedAt = central.leaseRenewedAt`

On release:

- Clear owner fields on both central row and task row.
- Preserve monotonic epoch progression in central row history (or tombstone).

If a split-write occurs (central success, task-row write fail), reconciliation policy is:

- Treat central row as authority.
- Repair task row via reconciliation worker before next dispatch.

### 2.6 Heartbeat semantics

Heartbeat renewal from active owner:

- Re-assert same owner tuple.
- Update `leaseRenewedAt`.
- Do not bump epoch.

Heartbeat from stale owner (epoch mismatch or owner mismatch):

- Must fail as conflict.
- Worker aborts run before any write/merge path.

### 2.7 API-level behavior contract

`AgentStore.checkoutTask(...)` remains the integration point.
Behavior evolves from single-row local check to:

1. central authoritative claim mutation
2. task-row synchronization write
3. return claimed task

Conflict mapping remains `CheckoutConflictError` / 409 for external callers.
No automatic retry loops in caller.

### 2.8 Testability surface

Required unit-level contract test:

- Given pre-seeded central claim row with owner A
- When owner B attempts claim
- Then claim fails with `CheckoutConflictError`
- And error contains `currentHolder = owner A`

Required race integration test:

- Simulate two nodes racing same `(projectId, taskId)` claim.
- Use barrier/latch to release both attempts simultaneously.
- Assert exactly one winner.
- Assert loser receives `CheckoutConflictError`.
- Assert post-state owner fields match winner tuple `(nodeId, agentId)`.
- Assert epoch bumped exactly once from initial value.

## 3. Unavailable-Node Handoff Policy (Independent, Testable)

This section is intentionally independent from §2.
It is testable without invoking mutex acquisition by pre-seeding task ownership rows and node health transitions.

### 3.1 Scope and intent

Define deterministic handling for node availability transitions affecting existing lease owners.
No live-process migration is introduced.
Scheduler failover is out of scope.

### 3.2 Transition A: pre-dispatch unavailable

Keep current dispatch semantics from `applyUnavailableNodePolicy(...)`:

- `fallback-local` allows local fallback (`packages/engine/src/node-routing-policy.ts:11-37`).
- `block` refuses dispatch with reason (`packages/engine/src/node-routing-policy.ts:39-42`).

Current scheduler call site remains dispatch-time policy gate (`packages/engine/src/scheduler.ts:1005`).

### 3.3 Transition B: owner unreachable mid-task

Behavior contract:

1. In-flight task remains owned until lease expiry window is reached.
2. After lease expiry, if `NodeHealthMonitor` reports owner status `offline` or `error` (`packages/engine/src/node-health-monitor.ts:132-148`), owner is considered unreachable.
3. Recovery action:
   - release claim
   - move task to `todo`
   - preserve step progress (`preserveProgress = true` when progress exists)
   - do not preserve old worktree on picking node (`preserveWorktree = false`)
4. Emit run-audit event: `task:auto-recover-node-unreachable`.

`MeshLeaseManager.isLeaseRecoverable(...)` and `recoverAbandonedLease(...)` provide current recovery seam (`packages/engine/src/mesh-lease-manager.ts:23-107`), extended by policy checks above.

No executor/session process handoff occurs.
Restarted work is fresh execution from preserved progress metadata.

### 3.4 Transition C: owner returns after handoff

A previously owning node may come back online after another node advanced epoch.
Returning node behavior:

- On next heartbeat, validate lease ownership.
- If central claim owner/epoch no longer matches local run, abort cleanly.
- Do not continue writes, merges, or `fn_task_done`.

Existing detection seam:

- `HeartbeatMonitor.executeHeartbeat()` already validates `task.checkedOutBy` and exits with checkout-conflict semantics (`AGENTS.md` Checkout Leasing section).

Minimal extension needed:

- include central epoch/owner validation (or synchronized local epoch validation) in the same heartbeat preflight so stale owner runs fence themselves before side effects.

### 3.5 Policy enum

Define policy enum for unavailable-owner reassignment behavior:

- `block`
- `reassign-to-local`
- `reassign-any-healthy`

Default recommendation:

- Keep default behavior equivalent to today's fallback/local-block pattern unless explicitly configured.
- For compatibility, map existing `fallback-local` to `reassign-to-local` in transition layer.

### 3.6 Testability surface

Unit policy tests:

- For each enum value, assert expected decision for `{owner online, owner offline, owner error, owner unknown}`.

Scheduler integration tests:

1. Online-owner protection:
   - pre-seed task owned by online node A
   - scheduler on node B must not dispatch it
2. `reassign-to-local` behavior:
   - pre-seed task owned by offline node A
   - after lease expiry and policy evaluation, row is released
   - task becomes dispatch-eligible for local node B

Independence harness note:

- These tests can bypass §2 by directly seeding ownership row + lease timestamps and toggling health monitor outputs.

## 4. Single-Project → Multi-Project / Multi-Node Isolation & Ownership Transition Path

### 4.1 Supported state machine

Supported operational states:

- `single-project/in-process`
- `multi-project/in-process`
- `multi-project/child-process`
- `multi-project/in-process + remote runtime placement`

Transition trigger is runtime reconfiguration requiring restart-bound re-evaluation.

### 4.2 Preconditions

Transition allowed when:

- Node is idle (`0` tasks in `in-progress`), OR
- Caller passes explicit `force` flag.

If `force=true`:

- In-flight tasks are paused through engine-initiated rebound path.
- Do not mark tasks as `userPaused`.
- Resume under new runtime after restart and ownership re-validation.

### 4.3 Runtime selection behavior on transition

On startup after transition:

- Re-evaluate `shouldUseHybridExecutor(...)` gate (`packages/engine/src/hybrid-executor-gate.ts:20`).
- Re-evaluate runtime type selection in `ProjectManager.addProject(...)` based on `isolationMode` (`packages/engine/src/project-manager.ts:168-170`).
- Continue to use `CentralCore` registration as source for project placement and mode (`packages/core/src/central-core.ts:252`, `449`).

Per-project SQLite DBs are not migrated or rewritten by this transition.
They remain at `.fusion/fusion.db` per project.

### 4.4 Central claim bootstrap

On first startup in multi-node-capable mode:

- Apply idempotent migration to create central `taskClaims` table (from §2).
- Migration must be safe to rerun.
- No data loss on repeated startups.

### 4.5 Rollback rules

Rollback to single-project mode is only supported when node is sole registered node in `CentralCore`.
If multiple nodes are registered, reject rollback with actionable error.

Rationale:

- prevents silently orphaning cross-node claim ownership semantics.

### 4.6 Durable trail requirements

Every transition writes durable activity/audit records:

- Activity entry: `project:isolation-transition`
- Event entry: `project:runtime-restarted` with payload:
  - `projectId`
  - `isolationMode`
  - `reason`

### 4.7 Explicit non-hot-swap scope

Hot-swap isolation transitions without restart are out of scope.
All supported transitions are restart-bound.

## 5. Non-Goals (Explicit Exclusions)

The following are explicitly out of scope for FN-4819 and MUST NOT be pulled into this brief's implementation follow-up:

1. **Scheduler failover**
   - Exclusion: a peer taking over the live scheduler tick loop for another node's project runtime.
   - Rationale: requires runtime leadership election and scheduler state transfer not needed to close lease-ownership gap.
2. **Live-process state migration**
   - Exclusion: transferring in-memory executor/session process state mid-task across nodes.
   - Rationale: requires session serialization/resume semantics beyond lease fencing and handoff policy.
3. **Cross-node consensus for engine settings mutations**
   - Exclusion: globally coordinated settings write quorum.
   - Rationale: orthogonal control-plane consistency problem.
4. **Multi-master concurrent writes to the same per-project `.fusion/fusion.db`**
   - Exclusion: active simultaneous writers from multiple nodes to one project DB file.
   - Rationale: storage topology constraint outside this task's lease contract.
5. **Automatic node promotion**
   - Exclusion: autonomous promotion/demotion workflows for node roles.
   - Rationale: operational governance feature, not checkout correctness.

No follow-up task is to be filed under this brief for these exclusions.

## 6. Acceptance Mapping

- **Acceptance: "four concerns called out as separate sections"**
  - Satisfied by:
    - §1 Baseline correctness model
    - §2 Distributed checkout mutex
    - §3 Unavailable-node handoff policy
    - §4 Isolation/ownership transition path
- **Acceptance: "distributed checkout mutex and unavailable-node handoff policy explicitly independent and testable"**
  - Satisfied by:
    - §2 opening independence statement + §2.8 testability surface
    - §3 opening independence statement + §3.6 testability surface
- **Acceptance: "WAL-based single-node baseline referenced in the protocol/docs section"**
  - Satisfied by:
    - §1 references to `AGENTS.md` Storage Model and `docs/storage.md` WAL details
- **Acceptance: "non-goal section explicitly excludes scheduler failover/live-process migration"**
  - Satisfied by:
    - §5 items 1 and 2

## 7. Code & Doc References

All references below were path-verified during FN-4819 preflight.

- `AGENTS.md:81-85` — Storage Model canonical wording
- `AGENTS.md:472-486` — Checkout Leasing conflict semantics and heartbeat enforcement notes
- `docs/storage.md:70` — per-project DB row source (`.fusion/fusion.db`)
- `docs/storage.md:92-101` — WAL/busy-timeout and concurrent write notes
- `docs/multi-project.md:19` — central DB path `~/.fusion/fusion-central.db`
- `docs/multi-project.md:108-113` — isolation mode definitions
- `docs/multi-project.md:158-166` — ProjectManager runtime-mode mapping narrative
- `docs/shared-mesh-protocol.md:16-19` — existing protocol non-goals including scheduler failover/live-process migration
- `docs/architecture.md` — engine composition and run-audit reference baseline
- `packages/core/src/store.ts:155-160` — task lease field definitions
- `packages/core/src/store.ts:1571-1576` — persisted lease field write mapping
- `packages/core/src/store.ts:1599-1624` — insert/upsert columns include lease fields
- `packages/core/src/agent-store.ts:1378-1426` — `checkoutTask` current single-process lease behavior
- `packages/core/src/agent-store.ts:47` — `CheckoutConflictError` usage import site
- `packages/core/src/central-core.ts:7` — central DB location note
- `packages/core/src/central-core.ts:252-255` — `registerProject` with `isolationMode`
- `packages/core/src/central-core.ts:449` — `updateProject` mutation path
- `packages/core/src/central-core.ts:2626` — central DB path getter
- `packages/core/src/types.ts:3369` — `IsolationMode = "in-process" | "child-process"`
- `packages/engine/src/project-manager.ts:168-170` — `isolationMode` runtime branching
- `packages/engine/src/node-routing-policy.ts:4-42` — `PolicyDecision` and `applyUnavailableNodePolicy`
- `packages/engine/src/mesh-lease-manager.ts:23-107` — lease recoverability and recovery path
- `packages/engine/src/node-health-monitor.ts:132-148` — offline/error transition handling
- `packages/engine/src/scheduler.ts:1005` — dispatch-time unavailable-node policy call site
- `packages/engine/src/hybrid-executor-gate.ts:20` — `shouldUseHybridExecutor` decision seam

## 8. Related Work (Optional Footnote)

No sibling FN design brief is required to interpret this document.
If adjacent work (for example another FN-48xx mesh coordination brief) exists, treat it as supplemental context only; FN-4819 remains self-contained and normative for this specific coordination-gap specification.

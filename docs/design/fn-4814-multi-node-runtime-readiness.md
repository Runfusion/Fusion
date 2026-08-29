# FN-4814 — Multi-node runtime readiness remediation brief

## Status & Premise

As of FN-4772 (wiring) and FN-4775 (verification), `HybridExecutor` is already the canonical runtime orchestration path when the gate resolves enabled; it is not unwired. The gate order in `packages/engine/src/hybrid-executor-gate.ts` is explicit and current: env override (`FUSION_HYBRID_EXECUTOR=1|0`) → multi-node (`nodes.length > 1`) → multi-project (`liveProjects.length > 1`) → disabled (`single-project-local-only`) → disabled on central failures (`central-unavailable`) (`packages/engine/src/hybrid-executor-gate.ts:8-41`).

## Scope Frame

| Area | In scope for this brief (input to FN-4813) | Out of scope for this brief |
| --- | --- | --- |
| Runtime truth | Confirm current architecture and gate behavior as already landed | Re-litigating whether HybridExecutor should exist |
| Ownership | Define distributed claim mutex boundary for task ownership | General-purpose distributed lock service for arbitrary state |
| Unavailable node behavior | Define pre-dispatch vs mid-task unreachable behavior and recovery contract | Live process migration of an in-flight task |
| Isolation transition | Define supported single-project → multi-project/child-process/remote-node transition model | Hot-swap transition without restart |
| Scheduler model | Clarify current routing boundary and handoff interactions | Scheduler failover across nodes |
| Session state | Define ownership-loss abort behavior | Cross-node mutation/replication of executor in-memory session internals |
| Topology control | Define rollback guard when returning to single-node mode | Automatic node promotion/election |

### Explicit non-remediation directives

The following are acknowledged and intentionally excluded from remediation under this brief:

- Scheduler failover.
- Live-process migration of an in-flight task across nodes.
- Automatic node promotion.
- Cross-node mutation of executor session state.

No follow-up tasks should be filed under FN-4814 for those items.

## Ownership Boundaries

### Boundary map when `shouldUseHybridExecutor(...).enabled === true`

```text
+-----------------------------------------------------------------------+
| CentralCore (~/.fusion/fusion-central.db)                             |
| - Node registry                                                        |
| - Project registry                                                     |
| - Proposed distributed task-claim mutex table (projectId, taskId key) |
+-------------------------------+---------------------------------------+
                                |
                                v
+-----------------------------------------------------------------------+
| HybridExecutor                                                         |
| - Selects/loads ProjectRuntime instances                              |
| - Starts/stops NodeHealthMonitor lifecycle                            |
+-------------------------------+---------------------------------------+
                                |
            +-------------------+-------------------+
            v                                       v
+-------------------------------+   +-----------------------------------+
| ProjectEngineManager/Engine   |   | Scheduler                         |
| - Per-project engine lifecycle|   | - Calls applyUnavailableNodePolicy|
| - Existing ownership unchanged|   | - Pre-dispatch routing decisions  |
+-------------------------------+   +-----------------------------------+
            |
            v
+-----------------------------------------------------------------------+
| Per-project DB (.fusion/fusion.db)                                    |
| - Existing task row and local lease fields, including checkedOutBy    |
| - Remains local source for task lifecycle data                         |
+-----------------------------------------------------------------------+
```

### Ownership statements

- `CentralCore` is the only shared visibility plane across nodes and therefore owns the distributed claim record.
- `HybridExecutor` owns orchestration composition (`ProjectRuntime` selection) plus node health monitor lifecycle; it does not become a distributed lock coordinator itself.
- `ProjectEngineManager` and `ProjectEngine` remain the per-project lifecycle owners; this brief does not alter that contract.
- `Scheduler` remains the call-site boundary for `applyUnavailableNodePolicy` pre-dispatch decisions (`packages/engine/src/scheduler.ts:1035-1039`).
- Per-project `.fusion/fusion.db` keeps local lease semantics and task state (`Task.checkedOutBy`), but cross-node authority is lifted to the central claim row.

## Distributed Checkout / Claim Mutex Design

### Goal

Provide a durable, cross-node, per-task ownership claim so two nodes cannot concurrently own the same task execution lane.

### Proposed central table (design sketch)

Table name (proposed): `task_claims`

Primary/unique key:

- `UNIQUE(projectId, taskId)`

Required columns (minimum):

- `projectId` — string/project identifier.
- `taskId` — string/task identifier.
- `nodeId` — owning node identifier.
- `ownerAgentId` — current owning agent identifier.
- `acquiredAt` — unix ms/iso timestamp of first acquisition for epoch.
- `heartbeatAt` — last successful owner heartbeat timestamp.
- `leaseTtlMs` — lease TTL assigned on acquisition.
- `epoch` — monotonically increasing ownership generation.

Recommended operational columns (optional but useful):

- `runId` — active execution run correlation.
- `updatedAt` — last write audit convenience.
- `releasedAt` — explicit release timestamp for diagnostics.

### Acquisition semantics

- Claim path uses single-writer semantics with `INSERT ... ON CONFLICT(projectId, taskId)`.
- Winner acquires claim and sets initial `acquiredAt`, `heartbeatAt`, `leaseTtlMs`, and `epoch`.
- Loser gets a conflict result that is treated as 409-equivalent ownership contention.
- Loser must **not** auto-retry in a tight loop, matching checkout conflict contract in AGENTS.md.

### Heartbeat semantics

- The owner refreshes `heartbeatAt` on each task heartbeat tick.
- Claim is live when `now - heartbeatAt < leaseTtlMs`.
- Heartbeat update must be guarded by current `(projectId, taskId, epoch, nodeId, ownerAgentId)` to prevent stale owner refresh.

### Expiry/reclaim semantics

A peer may reclaim only if **both** are true:

1. Lease has expired (`now - heartbeatAt >= leaseTtlMs`), and
2. `NodeHealthMonitor` reports owner status `offline` or `error`.

Rationale:

- Expiry-only can steal from transiently slow but healthy owners.
- Health-only can steal from temporarily delayed heartbeats.
- Conjunction reduces split-brain risk for active owners.

### Relationship to per-project `Task.checkedOutBy`

- Central claim is authoritative across nodes.
- Local `Task.checkedOutBy` remains local engine lease signal.
- Acquisition/release operations must update central claim and local row atomically from caller perspective (single success/failure outcome).
- If either side fails, operation is considered failed and must roll back/compensate before dispatch continues.

### Migration/bootstrap

- Add claim table in `fusion-central.db` via idempotent central migration.
- Migration runs on first multi-mode startup (or first startup after introducing schema).
- No historical backfill is required: prior single-node operation had no cross-node claim contention.

### Guardrail (non-goal)

This mutex governs **task ownership claims only**. It is not a distributed lock primitive for arbitrary engine mutations, scheduler internals, or settings writes.

## Unavailable-Node Handoff Behavior

This section layers on top of existing `applyUnavailableNodePolicy` behavior in `packages/engine/src/node-routing-policy.ts:16-47`.

### 1) Pre-dispatch unavailable (existing behavior preserved)

- Keep current semantics unchanged.
- `fallback-local`: dispatch allowed and rewritten to local.
- `block`: dispatch denied with policy reason.
- Call-site remains scheduler pre-dispatch boundary (`packages/engine/src/scheduler.ts:1035-1056`).

### 2) Owner becomes unreachable mid-task

Behavior contract:

- In-flight task stays owned by original central claim until lease expiry.
- No live process migration is attempted (explicit non-goal).
- When lease expires **and** owner health is `offline`/`error`:
  - engine-initiated rebound moves task to `todo`;
  - rebound uses `preserveProgress` and `preserveWorktree=false`;
  - stale claim is released/replaced by reclaiming node;
  - emit run-audit event `task:auto-recover-node-unreachable`.

Worktree treatment:

- Worktree on unreachable owner is forfeit.
- New owner recreates fresh worktree/session using existing recovery posture aligned with FN-4601 session-start recovery patterns.

### 3) Owner returns after handoff

Behavior contract:

- Returning node checks whether it still owns central claim epoch.
- If claim epoch/node ownership no longer matches:
  - abort active session cleanly;
  - clear local `checkedOutBy` row state;
  - do not commit/finalize stale session output.

Detection point:

- Existing heartbeat guard already validates local checkout ownership in `HeartbeatMonitor.executeHeartbeat()` per AGENTS guidance.
- Extend same guard to compare local owner identity against central claim epoch.

User pause invariant:

- This is engine-initiated recovery, not a user pause.
- Do not set `userPaused`; preserve existing engine rebound semantics from AGENTS “Engine Process Rules”.

## Single-Project → Multi-Project Transition Path

### Supported state machine

```text
single-project local mode
  -> (config change + restart, if preconditions met)
multi-project/hybrid orchestration mode
  -> (config change + restart, rollback guard passes)
single-project local mode
```

### Preconditions for enabling multi-mode

- Node must be idle (no `in-progress` tasks).
- If non-idle, reject transition with explicit “drain tasks first” error.

### Transition execution contract

- On next startup, re-evaluate `shouldUseHybridExecutor`.
- If enabled, call `HybridExecutor.initialize()`.
- `ProjectEngineManager` ownership of per-project engines remains unchanged.
- Existing per-project SQLite databases remain untouched (consistent with `docs/multi-project.md`).

### Claim-mutex bootstrap during transition

- First multi-mode startup runs idempotent central claim table migration.
- Migration is safe to run repeatedly and no-op when already applied.

### Rollback to single-project constraints

- Rollback allowed only when local node is the sole registered node in `CentralCore`.
- If multiple nodes remain registered, reject rollback to prevent orphaned remote orchestration peers.

### Explicit transition non-goal

- Hot-swap isolation transition without restart is not supported by this brief.

## Acknowledged Non-Goals (No Remediation Required)

- **Scheduler failover across nodes**: maintaining single scheduler loops per node avoids distributed election complexity and is sufficient with explicit ownership claims.
- **Live-process migration of in-flight tasks**: process/state transfer cost and correctness risk outweigh value versus lease-expiry rebound.
- **Cross-node consensus for engine settings mutations**: settings convergence is out of the task-ownership safety path and would introduce high coordination overhead.
- **Multi-master writes to the same per-project DB simultaneously**: per-project DB remains local-owner scoped; central claim prevents concurrent execution ownership races instead of enabling shared-master semantics.

No follow-up task should be filed under this brief for these items.

## Code References Summary

- `packages/engine/src/hybrid-executor-gate.ts:8-41` — `parseEnvOverride`, `shouldUseHybridExecutor` gate order and reasons.
- `packages/engine/src/hybrid-executor.ts:168-214` — `HybridExecutor.initialize()` and `NodeHealthMonitor` lifecycle startup.
- `packages/engine/src/node-routing-policy.ts:16-47` — `applyUnavailableNodePolicy` dispatch decision contract.
- `packages/engine/src/node-routing-policy.ts:49-80` — `decideOwningNodeHandoff` helper semantics.
- `packages/engine/src/scheduler.ts:1035-1056` — scheduler call-site for `applyUnavailableNodePolicy` and local fallback rewrite.
- `packages/engine/src/runtimes/in-process-runtime.ts` — local runtime path under `ProjectRuntime` abstraction.
- `packages/engine/src/runtimes/child-process-runtime.ts` — child-process runtime path.
- `packages/engine/src/runtimes/remote-node-runtime.ts` — remote runtime path.
- `packages/engine/src/runtimes/child-process-worker.ts` — child worker process runtime implementation.
- `packages/engine/src/runtimes/remote-node-client.ts` — remote-node runtime client path.
- `packages/engine/src/project-manager.ts` — runtime orchestration internals under hybrid layer.
- `packages/engine/src/project-engine-manager.ts` — per-project engine lifecycle owner.
- `packages/engine/src/node-health-monitor.ts` — node health signal source used by routing/handoff policy.
- `packages/engine/src/__tests__/hybrid-executor-multi-node-routing.test.ts` — multi-node routing coverage.
- `packages/engine/src/__tests__/node-routing-policy.test.ts` — routing policy unit coverage.
- `packages/engine/src/__tests__/hybrid-executor-startup.integration.test.ts` — startup/wiring integration coverage.
- `packages/core/src/types.ts:1631` — `Task.checkedOutBy` task lease field.
- `packages/core/src/types.ts:283` — `UnavailableNodePolicy` type.
- `packages/core/src/types.ts:3410` — `NodeStatus` type.
- `docs/multi-project.md` — existing public runtime narrative and hybrid wiring section.
- `docs/architecture.md` — startup architecture overview context.
- `AGENTS.md` — canonical guardrails for checkout leasing and engine rebound behavior.

## Implementation Handoff

Mapping from this brief to FN-4813 implementation work items:

1. **Brief §3 Ownership Boundaries** → establish integration points and ownership contracts in implementation plan.
2. **Brief §4 Claim Mutex Design** → add central claim schema + acquire/heartbeat/reclaim/release flow.
3. **Brief §4 Relationship to `checkedOutBy`** → add atomic coupling between central claim row and per-project lease updates.
4. **Brief §5 Mid-task unreachable behavior** → implement lease-expiry + health-gated rebound and `task:auto-recover-node-unreachable` audit event.
5. **Brief §5 Owner returns after handoff** → extend heartbeat ownership checks with central claim epoch comparison and stale-owner abort path.
6. **Brief §6 Transition path** → implement isolation-mode transition precondition checks, startup migration bootstrap trigger, and rollback guard for multi-node registry presence.
7. **Brief §7 Non-goals** → enforce scope boundaries during implementation review; do not add scheduler failover/live migration/consensus features under FN-4813.

## Operational Sequences (Normative)

### Sequence A — Initial claim acquisition

1. Scheduler selects a task candidate in `todo`.
2. Executor prepares ownership acquisition intent (`projectId`, `taskId`, `nodeId`, `ownerAgentId`, `leaseTtlMs`).
3. Central claim write is attempted with single-writer conflict semantics.
4. On success:
   - central row is visible with current `epoch`;
   - local task lease (`checkedOutBy`) is set by same ownership flow;
   - execution proceeds.
5. On conflict:
   - caller receives ownership contention result (409-equivalent);
   - caller does not auto-retry in a loop;
   - task remains available for future scheduling pass.

### Sequence B — Normal heartbeat renewal

1. Owner heartbeat tick runs on existing cadence.
2. Renewal updates `heartbeatAt` only when `(projectId, taskId, nodeId, ownerAgentId, epoch)` match.
3. If update succeeds, ownership remains valid.
4. If update fails due to epoch mismatch, owner has been superseded and must abort its session.

### Sequence C — Mid-task owner unreachable

1. Owner becomes unreachable (network/process failure).
2. Peers observe degraded health but do not reclaim immediately.
3. Reclaim eligibility begins only after both:
   - lease TTL expiry, and
   - owner health `offline` or `error`.
4. Recovering node performs engine-initiated rebound:
   - task moved to `todo` with `preserveProgress` and `preserveWorktree=false`;
   - claim is reclaimed/replaced;
   - run-audit event `task:auto-recover-node-unreachable` emitted.
5. New owner starts clean worktree/session.

### Sequence D — Returning stale owner

1. Original owner recovers after handoff.
2. Next heartbeat/ownership check compares local lease to central claim epoch.
3. Mismatch result triggers stale-owner abort path:
   - stop execution;
   - clear local `checkedOutBy`;
   - suppress any finalize/commit from stale run.

### Sequence E — Transition to multi-mode

1. User requests isolation transition.
2. Runtime verifies node idle precondition.
3. If non-idle, transition rejected and user instructed to drain.
4. If idle, user restarts process.
5. Startup re-evaluates hybrid gate.
6. On enabled path:
   - `HybridExecutor.initialize()` starts runtime orchestration;
   - central claim table migration runs idempotently.

## Failure-Mode Matrix

| Failure mode | Detection source | Required behavior |
| --- | --- | --- |
| Claim row conflict at acquisition | Central DB conflict result | Treat as 409-equivalent; no tight auto-retry |
| Owner heartbeat delayed but node still online | `heartbeatAt` lag + health `online` | Do not reclaim |
| Owner offline but lease still live | Health monitor + TTL check | Do not reclaim |
| Owner offline and lease expired | Health monitor + TTL check | Reclaim eligible; rebound to `todo` |
| Returning owner after reclaim | Central epoch mismatch | Abort stale owner; clear local lease |
| Transition request with active tasks | Local runtime state | Reject transition; require drain |
| Rollback-to-single while >1 registered node | Central node registry | Reject rollback to avoid orphaning peers |

## Guardrails for FN-4813 Implementation Review

The following checks are mandatory when validating FN-4813 against this brief:

- Verify no code path introduces automatic retries for central claim conflicts.
- Verify reclaim requires TTL expiry **and** unhealthy owner status.
- Verify engine rebound path does not set `userPaused`.
- Verify stale-owner return path blocks duplicate finalize/commit.
- Verify transition guards are restart-based and reject hot-swap behavior.
- Verify no implementation extends scope into scheduler failover or live migration.

## Terminology

- **Central claim**: shared ownership row in `fusion-central.db` keyed by `(projectId, taskId)`.
- **Local lease**: per-project task-row ownership signal (e.g., `checkedOutBy`) in `.fusion/fusion.db`.
- **Epoch**: monotonically increasing ownership generation used to detect stale owners.
- **Rebound**: engine-initiated task move back to `todo` for safe re-dispatch.
- **Forfeit worktree**: unreachable-owner worktree treated as non-recoverable state.

## Closure Statement

This brief intentionally narrows FN-4813 scope to distributed claim ownership, unavailable-owner handoff behavior, and isolation transition guards while preserving existing runtime topology assumptions. Any proposal that expands into failover-election, live-process migration, or distributed consensus falls outside this design predicate and should be rejected during FN-4813 implementation review.

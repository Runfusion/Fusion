# ADR-0001: DAG Orchestration Representation and Scheduling Boundary (v1)

Related tasks: **FN-4487**, **FN-4471**, governance gate **FN-4359**.

See also: [Requirements Matrix](./requirements-matrix.md) · [Failure + Observability Contract](./failure-observability-contract.md)

## Status

**Proposed**

## Context

FN-4471 scoped the multi-agent DAG request into a bounded discovery/prototype arc and highlighted that current orchestration is mostly prompt-driven rather than engine-enforced. FN-4487 converted that scope into Milestones A/B/C and recommended architecture-first work before any runtime prototype.

This ADR is Milestone A’s binding architecture decision for how DAG semantics integrate with existing Fusion execution primitives without changing reliability-layer behavior during the FN-4359 freeze.

## Decision

Adopt a **first-class DAG model persisted in SQLite** (explicit `dag_runs`, `dag_nodes`, `dag_edges` style records) rather than deriving orchestration only from task `dependencies`.

Use a narrow scheduling boundary: a new logical **DagCoordinator** concept may evaluate graph readiness and then enqueue work only through existing scheduler/executor pathways (no direct task execution path). Integration point is the existing scheduler surface in `packages/engine/src/scheduler.ts`; Milestone B prototype should call into existing queueing/dispatch mechanisms and must not bypass `AgentSemaphore` (`packages/engine/src/concurrency.ts`) or checkout leasing guarantees.

Rationale for this boundary:
- Keeps scheduler internals stable for Milestone B by treating DAG as an upstream producer of eligible task-enqueue intents, not a scheduler replacement.
- Preserves executor ownership and lease semantics in `packages/engine/src/executor.ts`.
- Supports clean restart reconstruction from DB and additive observability.

## Consequences

1. **Storage impact**
   - Additive SQLite schema additions are required in `.fusion/fusion.db`.
   - No destructive migration or replacement of existing task/blob storage (`docs/storage.md`).

2. **Single-event-loop invariant**
   - DAG evaluation and persistence operations must remain non-blocking and aligned with `AGENTS.md` Engine Process Rules.
   - No `execSync` for user-configured operations; orchestration logic must use async patterns.

3. **Multi-project/mesh impact**
   - Prototype remains single-project/single-node by default.
   - Any cross-node DAG semantics are deferred and must align with `docs/multi-project.md` and `docs/multi-project-sequencing.md` identity/routing constraints.

4. **Merge/file-scope path impact**
   - DAG-driven execution does not change merge topology: one task still maps to one branch/review flow.
   - No cross-task squash semantics introduced; merger audit and file-scope invariant remain authoritative.

## Alternatives Considered

### 1) Use task `dependencies` graph only

Rejected because task dependencies encode coarse task ordering, not DAG-run identity, per-node lifecycle, conditional branch semantics, or node-scoped retry/cancel state. Overloading dependencies would blur existing scheduler semantics and make restart/observability contracts harder to reason about.

### 2) External orchestrator service

Rejected for Milestone A/B because it adds network/distributed coordination complexity before proving local fit, conflicts with current single-process engine assumptions, and increases failure surface around auth/routing across nodes. A local additive model gives lower blast radius and cleaner governance under FN-4359.

## Governance

Reliability freeze text from `AGENTS.md`:

> "Reliability mechanism changes are currently under freeze pending FN-4359 governance hardening; treat new reliability-layer behavior changes as blocked unless explicitly approved in task scope."

Milestone B implementation is gated on freeze lift or explicit carve-out approval. DAG retry/replay behavior MUST NOT regress `SelfHealingManager` (`packages/engine/src/self-healing.ts`), `RestartRecoveryCoordinator` (`packages/engine/src/restart-recovery-coordinator.ts`), or merger audit/file-scope protections (`packages/engine/src/merger.ts`).

## Open Questions

1. Node identity model: reuse task IDs directly or introduce DAG-node IDs that reference tasks?
2. Fan-in semantics: how should `blockedBy` and multiple-parent completion be represented?
3. Retry budgeting: per-node, per-run, or hybrid budget with `retriesBurned` attribution?
4. Cancellation precedence: how should operator cancel interact with in-flight executor retries?
5. DAG/task document linkage: should run evidence live only in DB/audit logs or mirror key summaries into task documents?
6. Prototype flag scope: project-level feature flag only, or per-task override allowed?

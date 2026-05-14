# Milestone B DagCoordinator Enqueue-Only Adapter Design

Related tasks: **FN-4491**, **FN-4490**, **FN-4487**, **FN-4471**, governance gate **FN-4359**.

See also: [Schema migration plan](./milestone-b-schema-migration-plan.md) · [Implementation checklist](./milestone-b-implementation-checklist.md) · [ADR v1](./adr-0001-dag-orchestration.md)

## Governance gate

Per `AGENTS.md` reliability governance policy:

> "Reliability mechanism changes are currently under freeze pending FN-4359 governance hardening; treat new reliability-layer behavior changes as blocked unless explicitly approved in task scope."

This design is architecture-only. Milestone B implementation requires freeze lift or explicit carve-out.

## Adapter contract

ADR traceability: derived from ADR-0001 **Decision** (enqueue-only scheduling boundary) and **Consequences #4** (no merge-path changes).

Proposed file: `packages/engine/src/dag-coordinator.ts`.

`DagCoordinator` is **enqueue-only**:
- evaluates node readiness from DAG tables.
- creates/unblocks tasks through `TaskStore` public APIs.
- triggers wakeups through `HeartbeatTriggerScheduler` surface.

`DagCoordinator` MUST NOT:
- call scheduler internals in `packages/engine/src/scheduler.ts`.
- mutate `AgentSemaphore` directly (`packages/engine/src/concurrency.ts`).
- bypass checkout leasing / 409 conflict semantics.

Proposed methods:
- `startDagRun(spec: DagRunSpec): Promise<{ runId: string }>`
- `onTaskMoved(event: { taskId: string; from: string; to: string; status?: string }): Promise<void>`
- `onTaskUpdated(event: { taskId: string; status?: string; column?: string }): Promise<void>`
- `cancelDagRun(runId: string, reason: string): Promise<void>`
- `tick(runId?: string): Promise<void>` (optional bounded reconciliation pass)

## Event sources

Existing observable events from current engine/task store surfaces:
- `task:created`
- `task:moved`
- `task:updated`

Evidence in source scan:
- `packages/engine/src/scheduler.ts` subscribes to `task:created`, `task:moved`, `task:updated`.
- `packages/engine/src/executor.ts` subscribes to `task:moved`, `task:updated`.
- `packages/engine/src/project-manager.ts` forwards runtime `task:created`, `task:moved`, `task:updated`.

No dedicated `task:failed` event was confirmed in existing public event vocabulary; failure detection should currently derive from `task:updated` status/column state.

## Required engine seams (additive only)

1. Additive coordinator wiring point in project engine bootstrap to register coordinator listeners without changing scheduler dispatch semantics.
2. Optional narrow helper on task store/runtime event payloads for explicit terminal reason mapping (if current `task:updated` payload lacks enough fidelity).
3. Feature-flag check seam (`experimentalDagCoordinator`) at wiring boundary so default behavior is unchanged.

All seams must be additive and behavior-preserving while FN-4359 freeze is active.

## Concurrency and event-loop safety

- Coordinator logic must be async and non-blocking.
- No `execSync` in coordinator paths (aligns with AGENTS.md Engine Process Rules).
- Any external command path (if ever needed) must use async `exec`/`promisify(exec)` with timeout.
- Readiness evaluation should use bounded batches to avoid monopolizing the single Node event loop.

## Merge-path integration (explicit invariant)

The coordinator does **not** change merger behavior. It does not alter:
- post-squash audit,
- file-scope invariant,
- gitignored-path guard,
- one-task-one-branch execution/merge mapping.

## Failure handling map (from FN-4490 contract)

- **Per-node failure** → mark `dag_node.status=failed`; emit `dag:node:fail`; evaluate run abort/continue policy.
- **Edge failure/dependency unsatisfied** → keep downstream `blocked`/`pending`; emit `dag:node:blocked` with reason.
- **Partial-DAG abort** → set run `aborted`; mark remaining non-terminal nodes `skipped`/`blocked`; emit `dag:run:abort`.
- **Whole-DAG cancel** → mark run `cancelled`; mark non-terminal nodes `cancelled`; emit `dag:run:abort` with cancel reason.
- **Retry-exhausted** → defer to existing executor retry exhaustion path (incl. FN-4398 `retriesBurned` semantics); coordinator records terminal node outcome, no custom retry engine.
- **Governance-blocked** (e.g., FN-3973/FN-4488 policy denial) → emit `dag:node:blocked` with policy reason; do not retry automatically.

## Observability and audit

Logger prefix: **`[dag-coordinator]`** (aligned with existing subsystem prefix style in `packages/engine/src/logger.ts`).

Minimum events (FN-4490 contract):
- `dag:run:start`
- `dag:node:enqueue`
- `dag:node:complete`
- `dag:node:fail`
- `dag:run:complete`
- `dag:run:abort`
- additive: `dag:node:blocked`

Each event payload should include at least: `runId`, `dagRunId`, `nodeId`, `taskId?`, `status`, `reasonCode?`, `timestamp`.

Run-audit linkage:
- database-domain audit entries for DAG row transitions.
- git-domain unchanged (normal task flow only).
- filesystem-domain only for normal task artifacts, not DAG-specific side channels.

## Multi-project scope

ADR traceability: aligns with ADR-0001 **Consequences #3** (single-project prototype scope).

Decision: **per-project coordinator instance**.

Rationale (from `docs/multi-project.md`):
- task/state persistence is project-local in `.fusion/fusion.db`.
- central DB manages registry/global coordination, not per-project task execution state.
- one coordinator per project runtime keeps ownership boundaries consistent with existing runtime model.

## Test strategy for Milestone B implementor

1. **Unit tests** (`packages/engine/src/__tests__/`) for readiness evaluation, enqueue behavior, and event emission.
2. **Integration tests** with real SQLite project DB (same init/migration path), mock heartbeat scheduler trigger points, and fixture DAG specs.
3. Use existing executor helper conventions in `packages/engine/src/__tests__/executor-test-helpers.ts` when synthesizing worktree/task execution preconditions.
4. Add/update interaction tests in `packages/engine/src/__tests__/reliability-interactions/` for scheduler/executor/self-healing/restart-recovery adjacency.

## Out of scope

- Dashboard DAG UX/product surfaces (deferred to FN-4492 / Milestone C).
- Cross-project or cross-node DAG execution.
- Time-travel/replay engine.
- Autoscaling/capacity orchestration redesign.

## Open questions

1. Should coordinator reconcile missed events solely via periodic `tick()` or rely on exhaustive event subscriptions plus startup scan?
2. Where should DAG run initiation be invoked from (API route, workflow step hook, mission loop) for minimal coupling?
3. What is the minimal policy reason-code taxonomy for `dag:node:blocked` to support diagnostics without new reliability behavior?
4. Should node completion depend strictly on task column transitions (`done`) or include additional status fields for retry-exhausted terminal mapping?

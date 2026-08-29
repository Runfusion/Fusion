# Milestone B Implementation Checklist (Executor-Ready)

Related tasks: **FN-4491**, **FN-4490**, **FN-4487**, **FN-4471**, governance gate **FN-4359**.

See also: [Schema migration plan](./milestone-b-schema-migration-plan.md) · [DagCoordinator design](./milestone-b-dag-coordinator-design.md) · [ADR v1](./adr-0001-dag-orchestration.md)

## Gate (must be first)

- [ ] **FN-4359 freeze lifted or explicit carve-out granted for DAG prototype implementation. Until then, do not implement.**
  - Policy quote (`AGENTS.md`): “Reliability mechanism changes are currently under freeze pending FN-4359 governance hardening; treat new reliability-layer behavior changes as blocked unless explicitly approved in task scope.”

## Ordered milestones

ADR traceability: sequence follows ADR-0001 **Decision** (SQLite DAG + enqueue-only coordinator) and **Consequences #1/#2/#4** (additive storage, non-blocking runtime, unchanged merge path).

1. [ ] **Land additive migration(s) from plan**
   - Outcome: `dag_run`, `dag_node`, `dag_edge` created via next schema version block.
   - File scope hints: `packages/core/src/db.ts`, `packages/core/src/__tests__/db*.test.ts`.
   - Verification: `pnpm test`, `pnpm build`.

2. [ ] **Add `DagCoordinator` skeleton behind feature flag, no subscribers yet**
   - Outcome: inert class and wiring seam exists but disabled by default.
   - File scope hints: `packages/engine/src/dag-coordinator.ts`, `packages/engine/src/project-engine.ts` (or equivalent bootstrap).
   - Verification: `pnpm test`, `pnpm build`.

3. [ ] **Wire event subscriptions behind same flag**
   - Outcome: listens to existing `task:created|task:moved|task:updated` and performs enqueue-only transitions.
   - File scope hints: `packages/engine/src/dag-coordinator.ts`, runtime registration surfaces.
   - Verification: `pnpm test`, `pnpm build`.

4. [ ] **Add focused unit tests**
   - Outcome: readiness evaluation, enqueue path, block/fail/complete event coverage.
   - File scope hints: `packages/engine/src/__tests__/dag-coordinator.test.ts` (new), helper fixtures.
   - Verification: `pnpm test`.

5. [ ] **Add reliability interaction regression tests**
   - Outcome: explicit interaction coverage in reliability backstop suite for scheduler/executor/self-healing/restart recovery adjacency.
   - File scope hints: `packages/engine/src/__tests__/reliability-interactions/`.
   - Verification: `pnpm test`.

6. [ ] **Add opt-in integration test for 2-node DAG**
   - Outcome: validates end-to-end enqueue-only orchestration with real SQLite state and mocked/controlled wakeups.
   - File scope hints: `packages/engine/src/__tests__/dag-coordinator.integration.test.ts`.
   - Verification: `pnpm test`, `pnpm build`.

7. [ ] **Finalize docs + changeset when implementation lands**
   - Outcome: update DAG docs and settings docs for shipped flag/behavior.
   - File scope hints: `docs/dag/*.md`, `docs/settings-reference.md`, `.changeset/*.md`.
   - Verification: `pnpm test`, `pnpm build`.

## Config flag proposal

- Proposed setting: `experimentalDagCoordinator: boolean` (default `false`).
- Planned definition locations when implementation lands:
  - `packages/core/src/types.ts` (project settings type)
  - settings read/write plumbing
  - `docs/settings-reference.md` (documented only when implemented)

## Changeset requirement for implementation task

When Milestone B implementation (code) lands, include a changeset for **`@runfusion/fusion`** because it introduces new user-facing functionality behind a flag.

- Acceptable bump: `patch` (if strictly bugfix-like/internal behavior) or `minor` (if introducing opt-in new capability surface).
- This current FN-4491 design-only task does **not** add a changeset.

## Non-goals (self-contained)

- No scheduler replacement.
- No direct `AgentSemaphore` manipulation.
- No checkout-lease bypass.
- No merger/audit/file-scope invariant changes.
- No dashboard DAG UX/productization (Milestone C / FN-4492).
- No cross-project/cross-node DAG orchestration.
- No replay/time-travel/autoscaling orchestration engine.

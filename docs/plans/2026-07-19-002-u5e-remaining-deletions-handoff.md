---
title: "U5e remainder — unblock the legacy-tail deletions by modernizing the executor test fakes"
type: handoff
status: ready
date: 2026-07-19
parent_plan: docs/plans/2026-07-18-001-refactor-ir-driven-lifecycle-cutover-plan.md
supersedes_map_in: docs/plans/2026-07-19-001-u5e-executecore-lift-handoff.md
---

# U5e remainder — one unlock gates every remaining deletion

## What U5e landed

**`8ed4d8995` — the lift. The unit's headline goal is met: there is ZERO graph re-entry
into `execute()`.**

- `executeCore(task)` is **routing only**: duplicate-dispatch drop, dependency gate,
  ephemeral gate, `maybeExecuteWorkflowGraph`, `workflowAuthoritativeDispatch`.
- `runImplementation(task, { graphCompletion? })` is the lifted ~2400-line body: the
  process-wide task lock, soft-delete refusal, work-engine dispatch, heartbeat deferral,
  settings merge, worktree acquisition, agent session, up to the completion boundary.
- `runImplementationPhase` (the graph seam) calls `runImplementation` **directly**.
- `execute()` no longer has a `graphCompletion` parameter.
- The routing block lost its `if (!graphCompletion)` wrapper — there is no inner
  invocation left to exclude.

Why the re-entry existed at all: worktree / taskEnv / agent / semaphore state is assembled
inside `execute()` and was not available standalone at `createGraphSeams` time. Lifting the
body puts that assembly behind an ordinary method call, which is what removes the need.

## What did NOT land, and the single reason why

Still present: the 3 callback completion boundaries, the legacy in-review handoff tails,
`fn_review_step` and its review-level prompt scaffolding, and the seam maps
(`graphSeamGoverningNodeId`, `graphSeamThinkingLevel`, `graphStepSessionPinned`,
`graphStepRunOnce`, `graphStepActiveContext`).

**All of them are gated behind exactly one thing** — `maybeExecuteWorkflowGraph`'s
workflow-selection-api-unavailable fallback (`transferPreHeldToLegacy = true; return false;`,
the branch guarded by `hasEnabledSteps`). It fires **only** when a TaskStore exposes neither
`getTaskWorkflowSelection` nor `getTaskWorkflowSelectionAsync` **and** the task has no
`enabledWorkflowSteps`. Production stores always expose a workflow-selection reader, so
**only minimal test fakes ever reach it**.

The dependency chain is strict and worth stating plainly:

```
delete the fallback
  -> maybeExecuteWorkflowGraph always owns the task
  -> executeCore never calls runImplementation without a callback
  -> graphCompletion becomes MANDATORY
  -> the 3 boundaries collapse to `return { taskDone: true, modifiedFiles }`
  -> every legacy in-review tail below them is dead -> delete
  -> `!graphCompletion` fn_review_step injection gate is statically false -> delete the
     tool factory, the deferred re-raise channel, and the review-level scaffolding
  -> `graphCompletion !== undefined` review-gate flags become the constant `true`
```

So this is not five deletions. It is **one unlock plus mechanical fallout.**

## The cost of the unlock — measured, not estimated

Do not re-derive this; it was measured directly.

- **33** engine test files drive `execute()` through legacy-minimal fakes. **28** of them
  share `createMockStore()` in `packages/engine/src/__tests__/executor-test-helpers.ts`,
  so one helper edit reaches most of the surface.
- Adding `getTaskWorkflowSelection` / `getTaskWorkflowSelectionAsync` (returning
  `{ workflowId: "builtin:coding", stepIds: [] }`) to that helper and running a 12-file
  sample moved it from **155 failed / 190 passed** to **214 failed / 131 passed** —
  **+59 new failures**.
- Root cause split of those 59:
  - **38 are `session.subscribe is not a function`.** Making the store workflow-aware
    routes these tests through the graph, which pulls them into real **workflow-step**
    sessions. Each test file supplies its own `createFnAgent` session mock, and those mocks
    lack `subscribe` (read at the workflow-step streaming site in `executor.ts`). This is a
    **per-file session-mock** gap, not a store gap — the shared helper cannot fix it.
  - The remainder are legacy-behavior assertions (in-review handoff, retry-counter resets)
    that the deletion **intentionally** invalidates and which must be rewritten against the
    graph contract, not appeased.
- Context for the numbers: this surface **already carries 155 pre-existing reds at HEAD**
  in that 12-file sample alone — far more than the ~13 the previous handoff listed. Measure
  your own baseline per file before attributing anything.

`executor-preheld-legacy-handoff.test.ts` is a special case: all 4 of its tests exist
*specifically* to assert the fallback (they `delete` both selection methods from the fake).
Deleting the fallback deletes that file's reason to exist — remove it rather than repair it.

Also needing hand work after the helper edit: the 3 local `createStore()` fakes in
`executor-soft-delete-guard.test.ts`, `in-review-unmet-dependency-reconcile.test.ts`, and
`reliability-interactions/post-done-continuation-no-wedge.test.ts`.

## Recommended order

1. Add the two selection methods to `createMockStore` (one edit, 28 files).
2. Add a `subscribe` stub to the per-file session mocks — sweep the 38 failures; consider
   hoisting a shared session-mock factory into `executor-test-helpers.ts` so this class of
   drift stops recurring.
3. Rewrite the legacy-behavior assertions against the graph contract.
4. Delete `executor-preheld-legacy-handoff.test.ts`.
5. Only then delete the fallback, and take the mechanical fallout above in one pass.

## A note on the seam maps

Threading `governingNodeId` / `thinkingLevel` as explicit `runImplementation` params is
*partially* unblocked — but only 3 of the ~8 read sites live inside the lifted body
(`forceStepSession`, `workflowStepThinkingLevel`, `executorSessionThinkingSource`). The rest
are in helper methods reached deep from the session build. Threading only the 3 creates
**two sources of truth for the same value**, which is worse than the map. Do it as one pass
with the deletion, or not at all.

## Validation net (the oracle — green at this handoff)

`task-pipeline-smoke`, `executor-graph-requeue-gate`, `workflow-graph-executor-parity`,
`executor-graph-boundary`, `merger-trait-rekey`, `self-healing-trait-rekey`,
`workflow-graph-column-moves` — **59/59 green**; engine typecheck clean.

Measured pre-existing reds, unchanged by U5e (verified before *and* after the lift):
- `executor-column-agent-seams` + `executor-fast-mode-workflows` +
  `executor-outer-dispatch-dependency-gate` + `executor-task-done-invariant` +
  `workflow-graph-optional-step-fix` = **39 failed / 69 passed**
- `executor-step-session` + `reliability-interactions/concurrent-execute-race` =
  **14 failed / 22 passed**

## Guardrails

Keep the branch landable at every commit; scope verification to changed files (no
`allowFullSuite`); port 4040 reserved; never kill the live `fn`; stage by explicit path
(Fusion writes to this checkout concurrently).

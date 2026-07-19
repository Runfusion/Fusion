---
title: "U10b done — the flip landed, the legacy execute fallback is deleted, graph ownership is unconditional"
type: handoff
status: ready
date: 2026-07-19
parent_plan: docs/plans/2026-07-18-001-refactor-ir-driven-lifecycle-cutover-plan.md
supersedes: docs/plans/2026-07-19-005-u10-flip-residual-handoff.md
---

# U10b — the flip is landed and the second executor is gone

## What landed

| commit | what |
| --- | --- |
| `3030e1db2` | three more shared harness seams, measured baseline-neutral |
| `7ea9cd039` | **the flip** — the 40-file execute surface runs the workflow graph |
| `<this>` | the legacy execute fallback deleted; `graphCompletion` mandatory; tombstones + docs |

## The measured story

| | failed | passed |
| --- | --- | --- |
| baseline (after `e460752f1`) | 9 | 1063 |
| + the flip, before triage | 99 | — |
| + the flip, after triage | **9** (identical BY NAME) | — |
| + the fallback deletion, before triage | 41 | — |
| + the fallback deletion, after triage | **5** | 1021 |

**The flip cost exactly 90 new reds; the fallback deletion cost 32 more.** Both waves were driven
to zero, and the surface ended BELOW its own baseline: 5 reds, a strict subset of the original 9
by name. The 4 that disappeared were `restart.integration` tests that had been failing for the
same reason the wave-2 work fixed — its LOCAL `createMockStore` (line ~309, shadowing the shared
one) never implemented the real store contract. Nobody had connected them before because they sat
in the inherited "pre-existing baseline" bucket.

Remaining 5, all pre-existing: 3 in `restart.integration`, 1 in `triage`, 1 in
`executor-task-done-invariant`.

Triage tally across both waves: **~130 tests migrated, 1 test deleted, 1 file deleted, 4
assertions deleted.** Nothing was quarantined, skipped, or weakened.

## Three shared seams did most of the work — do not re-derive these

The predecessor found `getTaskDocument`, write-through `updateTask`, and the tool-capture clobber.
Three more were needed, all the same shape (a mock returning a frozen literal where the graph
re-reads the live row):

1. **`moveTask` must return the LIVE row.** The graph's merge boundary
   (`ensureWorkflowMergeBoundaryTask`) feeds `store.moveTask(...)`'s return value straight into the
   implementation-proof gate. A mock returning `{}` reported zero steps, so the merge failed
   `implementation-incomplete` AFTER the implementation had completed and every step was written
   `done`. Measured directly: the proof gate went `steps=["pending"]` → `steps=["done"]`.
2. **`updateStep` write-through**, or `steps#N:step-execute` re-reads the projection and terminates
   the graph with `step N not completed by implementation pass`.
3. **A per-file `getTask` override must not defeat write-through.** ~10 files install their own;
   wrapping `mockImplementation`/`mockResolvedValue` layers the executor's writes on top. Patches
   win (they are the later writes), so `store._setRow(id, patch)` exists for the opposite ordering —
   a test simulating an EXTERNAL mutation ("the worktree vanished under us").

Plus the **merge-requester seam**: `requestMerge` short-circuits to `merge-unavailable` before any
row mutation when `mergeRequester` is unset, so a bare `new TaskExecutor(store, root)` produced
ZERO `moveTask` calls. A prototype accessor does NOT work (TS class fields shadow it); the harness
patches `execute`/`resumeTaskForAgent` to inject a default when unset.

**`FUSION_TEST_LOG_PROBE=1`** makes the harness's mocked logger write to console.error. Every
finding above came from it. Keep using it.

## The two contract changes that explain most migrations

- **`todo → in-progress` is scheduler-owned (KTD-2).** The graph parks at a ready-for-release seam;
  a bare executor test never sees that move.
- **The in-review handoff IS the merge boundary**, carrying
  `workflowMoveSource: "workflow-graph"` provenance. There is no completion-path
  `moveTask(id, "in-review")`.

## What the fallback deletion actually removed

`maybeExecuteWorkflowGraph` → `executeWorkflowGraph`, returning `void`. It could return `false` and
hand the run to a legacy implementation path — an executor with no graph, no gates, and nothing
owning its completion. Gone with it: `transferPreHeldToLegacy` and the pre-held-slot hand-off, the
conditional at three completion boundaries in `runImplementation` (now plain returns) and their
legacy tails, the `graphOwned` branch in completed-task recovery, and
`executor-preheld-legacy-handoff.test.ts` (its 2 tests reached the fallback by `delete`-ing the
selection readers; they had become vacuous). `runImplementation(task, graphCompletion)` now takes
the callback as a REQUIRED positional parameter — the type-level statement that an unowned
implementation pass cannot be constructed.

A store that cannot resolve a workflow selection now ALWAYS fails closed. Previously it failed
closed only when the task had enabled steps and otherwise fell through.

## Ruled out / settled — do not redo

- **Step 3 (`needs-replan` writers) is RECLASSIFIED, not deferred work-in-progress.** Owner ruling:
  post-U3 the durable write happens at the graph's OWN `plan-replan` seam
  (`requestPreMergeOptionalStepFix` → `executor.ts`), so the workflow IS the writer; the 14 readers
  form one coherent graph-owned loop. It is the graph's durable replan signal wearing a legacy
  name. The `legacy-adoption.test.ts` census guard requiring the literal in `executor.ts` is
  CORRECT and must stay. Reader migration to a run-state signal is a post-cutover follow-up with
  its own risk budget. Recorded in AGENTS.md and `docs/architecture.md`.
- **The 40-file surface definition undercounts.** It is
  `grep -l createMockStore ∩ grep -l '.execute(|resumeTaskForAgent'`, which misses files that build
  their own store — e.g. `post-done-continuation-no-wedge.test.ts` (3 reds) and
  `executor-outer-dispatch-dependency-gate.test.ts`. `post-done-continuation-no-wedge` was verified
  red WITHOUT the flip too, so it is pre-existing, but a successor should widen the surface to
  `grep -l executor-test-helpers` rather than trust the 40.
- **`executor-task-done-invariant > moves a cleanly completed task to in-review via the merge-node
  boundary` fails in ISOLATION**, so the inherited "suite-level Postgres contention" diagnosis for
  it is wrong. Still pre-existing; still deserves its own look.

## Still open

- U11, the 6-column benchmark. Orientation from the coordinator:
  `WorkflowGraphExecutorDeps` already accepts an injectable `columnBoundary` dep (wired at
  `workflow-graph-executor.ts:544` node entry, `:1052` synthetic merge node, `:1160` drift check)
  and `WorkflowTaskRuntimeDeps` passes it through, so the benchmark can assert real column moves via
  `createWorkflowColumnBoundary` without standing up a store. There is NO 6-column fixture yet (the
  engine fixtures dir has only `triage-duplicate-scenario.ts`). Model it on `task-pipeline-smoke`'s
  injected-primitive pattern.
- `executor-prompt.test.ts` has two near-verbatim duplicate `fn_task_done with paused state
  (FN-3964 / FN-4167 regression)` describe blocks. Pre-existing; dedup was out of scope.

## Guardrails held at every commit

Oracle net 59/59 (`task-pipeline-smoke`, `executor-graph-requeue-gate`,
`workflow-graph-executor-parity`, `executor-graph-boundary`, `merger-trait-rekey`,
`self-healing-trait-rekey`, `workflow-graph-column-moves`); engine-core gate 294/294; engine
typecheck clean. pg-gate excluded — known rotating suite-level contention, a different file set
every run with zero assertion failures.

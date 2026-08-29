---
title: "U5e handoff — lift executeCore's implementation body into a standalone runner"
type: handoff
status: ready
date: 2026-07-19
parent_plan: docs/plans/2026-07-18-001-refactor-ir-driven-lifecycle-cutover-plan.md
---

# U5e handoff — delete graph re-entry by lifting the implementation phase

Surgical map produced by U5d. Line numbers are valid as of commit `b22aab024`.

## What U5d already landed

- **`140f1cead`** — `fix(cutover)`: the `engine-core` vitest project builds `@fusion/core`
  from the gate-safe barrel `packages/core/src/index.gate.ts`, and U3's
  workflow-step-results lease exports were only added to `index.ts`. So
  `classifyReviewLease` was `undefined` **only** under `engine-core`, throwing
  `"classifyReviewLease is not a function"` and failing every `defaultOn` Plan Review
  run — which is why the byte-compat oracle `task-pipeline-smoke` was red. Production
  (`dist`, via `index.ts`) was never affected. Fixed by syncing the exports, plus a
  loud named guard at the lease site and an R5 lock in the smoke.
- **`b22aab024`** — `feat(cutover)`: deleted the `graphCompletionInterceptors` **Map**,
  replaced by an explicit `GraphCompletionCallback` threaded
  `execute(task, graphCompletion?)` → `executeCore(task, graphCompletion?)`.

**Validation net is now GREEN and is U5e's oracle:** oracle + trait suites **59/59**
(`task-pipeline-smoke`, `executor-graph-requeue-gate`, `workflow-graph-executor-parity`,
`executor-graph-boundary`, `merger-trait-rekey`, `self-healing-trait-rekey`,
`workflow-graph-column-moves`); engine typecheck clean.

## What remains: the lift (the operator's "zero legacy re-entry machinery")

U5d removed the shared-state *signalling*, **not the re-entry**: the graph still calls
`execute()`. Deleting re-entry outright means lifting the implementation body out of the
dual-purpose `executeCore` into a standalone runner the graph calls directly.

### The core coupling (verified)

`executor.ts` documents (near the step-inversion driver, ~6549) that worktree / taskEnv /
agent / semaphore state is assembled **inside** `execute()` and is not available
standalone at `createGraphSeams` time — which is exactly why re-entry was chosen. So the
lift is: move that state assembly into `runImplementation(...)` and have the graph call
it, leaving `executeCore` as routing only.

### Target shape

- `execute(task)` → **routing only**: dependency/ephemeral gates, `graphRouting`,
  `maybeExecuteWorkflowGraph`, `workflowAuthoritativeDispatch`, the process-wide
  `executingTaskLock` claim, `maybeDispatchWorkflowWorkEngine`, heartbeat deferral.
- `runImplementation(task, prepared, ctx)` → the lifted body: settings merge, worktree,
  agent session, up to the completion boundary. **Returns `{ taskDone, modifiedFiles }`
  directly** — no callback, no re-entry.
- The legacy in-review handoff tail is **deleted** (R9).

### Line map (as of `b22aab024`)

| Landmark | Location |
| --- | --- |
| `executeCore` declaration | `executor.ts:10645` |
| `executeCore` end (next method) | `executor.ts:13845` (`createTaskUpdateTool`) — body ≈ **3200 lines** |
| Routing-skip gate (`if (!graphCompletion)`) | `10655` |
| Implementation body starts (settings merge) | ≈ `10756` |
| **Completion boundary 1** (step-session) | `11594` |
| **Completion boundary 2** (task completion) | `12494` |
| **Completion boundary 3** (completion retry) | `12810` |
| `fn_review_step` injection gate | `11928` |
| `workflowReviewGatesOwnedByGraph` flags | `12305`, `12721`, `12743` |
| `runImplementationPhase` (delete after lift) | `6515` |
| Its callers | `6596` (step driver memo), `6749` (`runCodingSession`), `7262` (seam) |

Each completion boundary currently reads:

```ts
if (graphCompletion) { …; graphCompletion({ modifiedFiles }); return; }
// …then the LEGACY in-review handoff (moveTask → in-review) — delete this
```

After the lift each becomes a plain `return { taskDone: true, modifiedFiles }`, and the
legacy handoff below it is removed.

### Seam maps still to retire (R9)

These exist only to thread state across the re-entry; convert to **parameters** of
`runImplementation` and delete:

| Map | Line | Notes |
| --- | --- | --- |
| `graphStepRunOnce` | `5320` | per-run memo of the impl phase; keep the memo, memoize `runImplementation` |
| `graphSeamGoverningNodeId` | `5365` | read inside body at ~`3254`, `7834`, `7905` → pass as param |
| `graphSeamThinkingLevel` | `5371` | → param |
| `graphStepSessionPinned` | `5313` | → param/derived |
| `graphStepActiveContext` | `5330` | foreach instance context |

### Part 2 (falls out of the lift)

`fn_review_step` — **30 occurrences** in `executor.ts`. Once every run is graph-owned,
the injection gate at `11928` is always false, so the tool factory (~`15313`+), the
deferred re-raise channel, and the review-level prompt scaffolding (~`20064`–`20220`,
the `workflowReviewGatesOwnedByGraph` branch) are all dead → delete.

### Part 4 (test fakes)

Upgrade minimal executor-core fakes to the workflow-aware store shape rather than keeping
a legacy characterization path. U5d already upgraded
`executor-outer-dispatch-dependency-gate.test.ts` to the explicit-callback contract.

## Known pre-existing reds (NOT caused by the cutover work — do not "fix" by appeasing)

Red at `HEAD` before U5d's changes; verify before attributing anything to U5e:

- `executor-column-agent-seams.test.ts` — 8 failures
- `executor-fast-mode-workflows.test.ts` — 3 failures (these assert current
  `fn_review_step` behavior and will need rewriting as part of Part 2)
- `executor-task-done-invariant.test.ts` (25–26/27), `workflow-graph-optional-step-fix`
  (2/24), FN-8309 dashboard `html2canvas` in `verify:fast`

## Guardrails

Keep the branch landable at every commit; scope verification to changed files (no
`allowFullSuite`); port 4040 reserved; never kill the live `fn`; stage by explicit path
(Fusion writes to this checkout concurrently).

---
category: architecture-patterns
module: workflow-resolved-columns
date: 2026-07-30
problem_type: systemic_gap
component: core
severity: high
applies_when:
  - "Converting a guard by adding an optional resolved-lane parameter"
  - "Reviewing a conversion that added a parameter"
  - "Auditing what a renamed board still breaks after the census reaches zero"
tags:
  - workflow-resolved-columns
  - column-census
  - unwired-parameter
  - census-invisible
---

# A resolved seam nobody wired is indistinguishable from no seam at all

## The shape

The standard conversion in this program adds an optional resolved parameter with a legacy default:

```ts
export function isParkedTaskColumn(
  task: Pick<Task, "column">,
  parkedColumns: readonly string[] = LEGACY_PARKED_COLUMNS,
): boolean
```

The helper is now correct, its own test passes, and the census entry is gone — the literal moved into a
documented default. **But every caller that does not pass the argument still gets the legacy behaviour**,
and nothing in the codebase records that.

This is worse than an unconverted literal in one specific way: the literal is *visible* to the census and
to grep. A converted helper with unwired callers looks finished from every angle except the call site.

## Why the seam test cannot catch it

The seam test supplies the parameter — that is what it is testing. It proves the helper honours a resolved
set. It says nothing about whether anyone supplies one. So the suite is green, the census is clean, and
the guard is inert in production.

Same root as the optional-flags blind spot (`optional-flags-seam-hides-unconverted-column-guards.md`), one
level up: there the *test* omits the parameter, here the *caller* does.

## The audit, and its result

Method — cheap and repeatable:

1. Find helpers with an optional resolved-lane parameter:

   ```bash
   grep -rn "ReadonlySet<string>\|ColumnRoleFlags\|LifecycleColumns" packages/*/src --include=*.ts \
     | grep -v __tests__
   ```
   then keep the signatures where that type appears on an **optional** parameter (`name?: ReadonlySet<string>`).

2. For each, grep every call site and check whether the argument is actually passed.

Result across `core`, `engine`, `dashboard`, `cli` — **13 such helpers**:

| disposition | count | notes |
| --- | ---: | --- |
| callers wired | 7 | `isStaleBlockedByBlocker`, `areAllDependenciesDone`, `enqueue`/`dequeueMergeQueueInTransaction`, the three `restart-recovery-coordinator` predicates, `isTerminalTaskStatus` |
| **unwired — fixed** | **5** | see below |
| left deliberately | 1 | `selectActionablePlanningContinuations` — **no production caller**; wiring a parameter into a function nothing calls is the unwired-parameter anti-pattern the caller audit (#2803) removed five of |
| not lifecycle | 1 | `isBuiltinWorkflowEnabled` |

**SCOPE OF THAT TABLE, corrected.** It enumerates the HELPERS and the call sites reached while fixing
them. It does NOT claim every caller of every helper was audited — and for at least one helper that
distinction matters a lot. `getTaskMergeBlocker` alone has **13 call sites** across core and engine;
two are fixed here, two were already wired (`moves.ts:821` passes `moveLifecycle?.review`;
`moves.ts:647` deliberately passes `skipColumnIdentityCheck` because the trait was already proven), four
sit inside self-healing sweeps that are query-gated and never run on a renamed board anyway, and the
**remaining five are genuinely unwired**:

```text
  packages/core/src/default-workflow-hooks.ts:72
  packages/core/src/task-merge.ts:355, 377
  packages/core/src/in-review-stall.ts:237
  packages/engine/src/merger.ts:6645
  packages/engine/src/merger-ai.ts:1173
  packages/engine/src/executor.ts:2404
```

Run step 2 of the method per helper before believing any "audit complete" claim, including this one.

Two of those five are now fixed (`default-workflow-hooks:72`, `executor.ts:2404` — both had the resolved
lane already in scope). The remaining three are each blocked on something other than effort, and the
reason matters more than the count:

- **`task-merge.ts:377` (`isTaskReadyForMerge`) — dead in production.** Exported and referenced only by
  the index barrels and its own test. Wiring a parameter into a function nothing calls is the
  unwired-parameter anti-pattern itself; it is left, like `selectActionablePlanningContinuations`.
- **`task-merge.ts:355` (`getTaskHardMergeBlocker`) — mostly query-gated.** Three of its four callers are
  self-healing sweeps behind hardcoded `listTasks({ column: "in-review" })`, so they never run on a
  renamed board regardless (see the self-healing doc). Only `project-engine.ts:3537` is live.
- **`in-review-stall.ts:237` (`getInReviewStallReason`) — needs a batch prefetch, not a per-task resolve.**
  Its four callers are in `reads.ts`, which decorates EVERY task on every list read. A per-task
  `resolveWorkflowIrForTask` there costs one IR resolution per row on a hot path. The correct shape is the
  prefetched per-workflow map used by the converted self-healing sweeps — resolve once per workflow for
  the batch, then index by task. That is a performance-shaped change, not a one-argument wiring, which is
  why it is recorded here rather than done in passing.

The operator-visible cost of the last one is the in-review stall badge: on a renamed board the stall
reason is computed against the legacy lane, so the badge can be wrong for every card in review.

## The recurring shape: outer question resolved, inner one not

The sharpest instances are not "a caller forgot an argument" but "the same function resolved the lane and
then re-asked with the literal", a few lines apart:

- `task-artifacts-ops` resolves `completeColumn` from the workflow, then calls the blocker with the literal.
- `default-workflow-hooks:72` gates on `lifecycleColumns?.review` / `?.complete`, then calls it with the literal.
- `executor.ts:2404` compares against `(await this.resolveResumeLanes(taskId)).review`, then calls it with the literal.
- `resolvePlanningContinuationCandidate` applies the caller's resolved terminal set, then delegates without it.

A conversion that stops at the outer question looks complete at the call site and is not. Grep for the
helper, not for the literal — the literal is one function away, where it is correctly annotated as a
fallback.

The five that were unwired at the sites reached here, and what each cost on a renamed board:

- **`isParkedTaskColumn` ×2** (`agent-heartbeat`) — the stale-link clear never fired, so a durable agent
  kept claiming a parked card and Reports Health Check rendered it **RUNNING**.
- **`getTaskMergeBlocker` ×2** (`mergeTaskImpl`, the completion move) — a card that had passed review
  **could not be merged or completed at all**: `Cannot merge …: task is in 'checking', must be in
  'in-review'`.
- **`isPlanningContinuationTaskDispatchable`** (`in-process-runtime`) — partially threaded: the enclosing
  function applied the caller's resolved set to its own check, then delegated *without* it.

Note the second entry: `task-artifacts-ops` **already resolved the completion lane four lines above** the
call that re-asked with the literal. The outer question was resolved and the inner one was not, inside one
function.

## Two traps when fixing these

**1. The legacy id is a FALLBACK, not a member.** The tempting shape is wrong:

```ts
const reviewColumns = new Set(["in-review"]);              // WRONG
for (const c of resolveReviewColumns(ir)) reviewColumns.add(c);
```

That admits a board which *declares* `in-review` as its WIP column — a card mid-implementation passes the
merge check. The legacy id is only correct when the board tells us nothing:

```ts
let reviewColumns: ReadonlySet<string> = new Set(["in-review"]);
const resolved = ir ? resolveReviewColumns(ir) : [];
if (resolved.length > 0) reviewColumns = new Set(resolved);   // a real answer REPLACES the default
```

**2. Two guards, one assertion.** When two call sites can refuse the same operation, a loose assertion
passes with either fixed. Measured: `expect(message).toContain("must be in")` passed with `mergeTaskImpl`
reverted, because the completion guard caught the card instead. Assert something that names the site —
here the message prefix (`Cannot merge` vs `Cannot move … to done`) — so the sites fail independently.

## Related

- `docs/solutions/architecture-patterns/hardcoded-movetask-destinations-are-census-invisible.md` — the
  destination half of a conversion, also invisible to the census.
- `docs/solutions/architecture-patterns/self-healing-sweeps-are-blind-on-a-renamed-board.md` — the query
  half; a guard behind a hardcoded `listTasks({ column })` never runs at all.
- `docs/solutions/test-failures/optional-flags-seam-hides-unconverted-column-guards.md` — the same blind
  spot one level down, in the tests rather than the callers.

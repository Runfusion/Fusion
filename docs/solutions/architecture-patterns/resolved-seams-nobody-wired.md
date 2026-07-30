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

## The arity trap: first-per-role where membership was meant

Six occurrences in this program, and the sixth was found only because a reviewer caught the fifth. It
deserves naming separately because it survives every check the others fail:

```ts
const parked = [lifecycle.hold, lifecycle.intake].filter(isString);   // FIRST per role
…
if (parked.includes(task.column)) …                                    // MEMBERSHIP test
```

`resolveLifecycleColumns` / `resolveTaskLifecycleColumns` answer **"which column is THE hold lane?"**.
A `.includes()` / `.has()` test asks **"is this column ANY hold lane?"**. On a workflow declaring two
columns with the same trait, the first answer silently covers one of them.

**Why nothing catches it:**

- The census sees no literal — the lanes are resolved.
- The types are identical: `string | undefined` either way.
- A default-vs-renamed differential passes, because **the default board declares one column per role and
  therefore cannot express the failing shape**. It needs a *structurally* different fixture, not a
  differently-named one.

Measured across production code — collections built from two or more first-per-role reads: **12 sites**.
Two are fixed here (`agent-heartbeat` ×2 call sites, `task-agent-sync.resolveLinkSyncColumnRoles`). The
rest are recorded for per-site classification, since some are legitimately ordered tuples rather than
membership sets:

| site | disposition |
| --- | --- |
| `engine/src/agent-heartbeat.ts` ×2 | **fixed** |
| `engine/src/task-agent-sync.ts:62-63` | **fixed** |
| `engine/src/executor.ts:12535` | **fixed** — a card in a second wip lane read as INACTIVE and its prompt file as reclaimable |
| `engine/src/executor.ts:3041` | **blocked** — reads `resolvePlannerLanes`, i.e. the sync IR reader, which returns the default workflow for every task in production. Converting the arity here changes nothing until that is fixed. |
| `engine/src/scheduler.ts:1593` | **blocked** — same, via `resolveTaskParkedColumnsSync` |
| `core/src/workflow-lifecycle-traits.ts:231` | **not a membership use** — a returned 2-tuple |
| `engine/src/planner-lane-resolution.ts:70, 84` | **ordering-sensitive** — a precedence list, not a set; converting would change which lane wins |
| `core/src/default-workflow-hooks.ts:274, 280` | **genuine, but a contract change** — `planningColumnsOf`/`liveWorkColumnsOf` take a `LifecycleColumns`, which is first-per-role *by construction*. Fixing the arity means `DefaultWorkflowMoveContext` carrying the IR (or trait sets) instead, which is a shared hook contract touching every caller. Not a local edit. |
| `engine/src/triage.ts:833` | **blocked twice over** — built from `resolvePlannerLanes` (the sync reader) *and* used to build `listTasks({ column })` queries, so it is in the query-filter class too |
| `dashboard/src/routes/register-task-workflow-routes.ts:304` | **FALSE POSITIVE of the scan** — already correct: `columnsWithFlag` for both roles, unioned, legacy only when the resolved set is empty |

So of twelve: **four fixed, three blocked (two on the sync reader, one also query-shaped), one needs a
contract change, three are not defects, one was my scan misfiring.**

Two things that spread is worth saying out loud:

1. A sweep converting all twelve would have **broken** the ordering-sensitive pair, delivered **nothing**
   at the sync-blocked ones, and "fixed" a site that was already right.
2. **The scan itself has false positives**, because it classifies by syntax — two role-shaped reads and a
   bracket on one line. That is the same failure this program has documented about the census: an
   instrument that counts syntax and is read as counting meaning. Treat the twelve as candidates, never
   as a backlog.

Re-measure with: for each file importing a lifecycle resolver, flag lines containing **two or more**
`.hold`/`.intake`/`.review`/`.wip`/`.complete`/`.archived` reads **and** an array or `new Set(`.

The fix is always `columnsWithFlag(ir, trait)`, which returns every column carrying it.

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

## When the conservative verdict needs reporting — and when it does not

`resolveWorkflowIrForTask` **substitutes** the built-in IR rather than failing, so `resolved.length > 0`
reads as *"this board answered"* when nobody did. Both self-healing sweeps in #2838 hit this: a card whose
workflow could not be resolved was measured against the built-in lane, rejected, and rejected again on
every pass **with nothing recorded**. They now use `...WithProvenance` — not to change the verdict
(measured: identical in every state, because the built-in lane already *is* the legacy id) but to make the
unrepaired card **reportable**.

The merge-blocker sites in this PR sit on the same shape and deliberately do **not** get that treatment.
Measured the verdict first — also identical — then checked visibility, which is where they differ:

```ts
throw new Error(`Cannot merge ${id}: ${mergeBlocker}`);
//  → "Cannot merge FN-1: task is in 'checking', must be in 'in-review'"
```

The refusal is already surfaced to the operator, and the message **names the lane it expected**, which is
the diagnostic a report would have added. A sweep that skips silently needs the report; a call that throws
with the expected lane in the string does not.

**The rule, so this is not applied by reflex:** provenance buys *visibility*, never a different answer.
Add it where the conservative verdict would otherwise be invisible. Adding it where the failure already
surfaces is ceremony — and, since it changes no behaviour, ceremony that reads like a fix.

## Related

- `docs/solutions/architecture-patterns/hardcoded-movetask-destinations-are-census-invisible.md` — the
  destination half of a conversion, also invisible to the census.
- `docs/solutions/architecture-patterns/self-healing-sweeps-are-blind-on-a-renamed-board.md` — the query
  half; a guard behind a hardcoded `listTasks({ column })` never runs at all.
- `docs/solutions/test-failures/optional-flags-seam-hides-unconverted-column-guards.md` — the same blind
  spot one level down, in the tests rather than the callers.

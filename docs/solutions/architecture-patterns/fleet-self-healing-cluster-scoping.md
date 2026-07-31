---
category: architecture-patterns
module: engine/self-healing
tags: [lifecycle-columns, census, fleet, sync-readers]
problem_type: conversion-hazard
applies_when: converting lifecycle-column literals in engine sweeps (self-healing.ts, executor.ts, scheduler.ts)
---

# The self-healing cluster is not a mechanical conversion — read this before batching it

Recorded 2026-07-30 at `origin/main@bc782d8d92` (census: 722 backlog, triage 0). Scoping note from
a fleet worker who claimed the largest cluster, measured it, and is handing it back sized rather
than half-converted.

## Shape of the cluster

`packages/engine/src/self-healing.ts` — **110 guards**, the largest single file in the work order.

  by column:   in-review 48 · in-progress 20 · done 17 · todo 13 · archived 12
  by receiver: `column` 100 · `to` 7 · `from` 3

## Why "replace the literal with a role helper" is not safe here

The engine has no synchronous way to learn a task's workflow. `resolveTaskWorkflowIrSync` returns
the DEFAULT workflow IR for every task in production — `getTaskWorkflowSelection` returns
`undefined` unconditionally (a PG-cutover stub), so the reader always takes its `!workflowId`
branch. It is typed non-optional, so **no caller can detect the substitution**.

Consequence for this cluster: a conversion that resolves traits through the sync reader produces a
guard that reads the DEFAULT workflow's lanes for every task. It compiles, it reads better than the
literal, the census counts it as progress, and it is wrong for every custom workflow — silently.
That is a strictly worse outcome than leaving the literal, because the literal is at least honest
about being a literal.

The correct form uses the async store-aware helper (`resolveTaskLifecycleColumns(store, taskId)`),
which means each converted site needs resolved lanes IN SCOPE. Sampled sites (926, 932, 984) sit in
`async` methods, so that is reachable — but it is a per-method change, not a per-line one, and the
sweeps iterate task lists, so a naive per-task resolve turns one sweep into N store reads.

## The shape that works, with precedent in-tree

`triage.ts` `discoverReadyPlanningTasks` solved exactly this: a store-free `couldBeCandidate`
prefilter narrows the set, then a bounded (8) concurrent `resolveTaskLifecycleColumns` pass resolves
the survivors, and the decision stays synchronous over a resolved map. Any batch over this file
should follow that shape per sweep.

## Recommended split

110 sites in one PR cannot honour "census before/after, baseline shrinks by exactly the converted
count" while also restructuring six-plus sweeps. Split by SWEEP, not by column id — each sweep is
one resolve-then-decide unit:

  1. the merge/review sweeps (`in-review` 48) — largest, and the one where a wrong lane silently
     changes merge eligibility. Do it first and alone.
  2. the WIP/rebound sweeps (`in-progress` 20, `todo` 13).
  3. the terminal sweeps (`done` 17, `archived` 12) — these read `complete`/`archived` traits and
     are the most mechanical of the three.
  4. the 10 `from`/`to` sites: these are MOVE-transition arms, not task-column reads. Different
     question ("is this transition into a review lane?"), so they should not ride along with the
     `task.column` conversions.

## Fleet rule this cluster proves

**Never resolve a workflow synchronously in a converted guard.** Use
`resolveWorkflowIrForTaskWithProvenance` (branch on `source`) or `resolveTaskLifecycleColumns`, and
if neither is reachable at the site, FLAG AND SKIP per the fleet rules — a sync-resolved trait read
is the "guard that cannot fire" pattern wearing better clothes.

## Second rule, from sizing the dashboard clusters: traits-first does NOT lower the count

Checked `TaskContextMenu.tsx` (9) next, expecting an easy cluster, and found the opposite lesson.

Its guards live in ROLE HELPERS that already read traits:

```ts
// isReviewColumn
return column === "in-review" || flags?.mergeBlocker === true || flags?.humanReview === true;
```

Rewriting that traits-first (`if (flags) return …; return column === "in-review"`) is the correct
shape — it is what #2664 did to `isPreExecutionHoldColumn` — but **the census still counts it**,
because the literal survives as the no-metadata fallback. The count is per literal, not per
code-quality improvement.

So for a file of role helpers, "N -> 0" is reached by MARKING the fallbacks
(`DELIBERATE-LITERAL`), not by converting them. And the failure mode is specific: a worker chasing
0 by DELETING the fallback silently breaks degraded mode — the pre-load window (board renders before
the workflows fetch resolves) and a card stranded on an id its workflow no longer declares both
arrive with no flags at all, so the helper starts answering "no role" for every column and
affordances vanish during first paint.

That is not hypothetical: `columnRoles.ts` documents the pre-load window explicitly, and the
`Column.tsx` / `taskActivity.ts` conversions earlier in this program each had to keep exactly this
fallback.

**Rule for the fleet:** in a role helper, convert the ORDER (traits first, id as fallback) and then
MARK the fallback. Deleting it is a behavior change in degraded mode — flag and skip per the rules.
Expect the dashboard clusters (`TaskCard.tsx` 42, `TaskDetailModal.tsx` 30) to be mostly marks, and
size them accordingly: the count moves the same either way, but only one of the two is safe.

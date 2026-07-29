---
title: "U9 safeguard baseline: what actually holds merge safe today"
type: characterization
status: measured
date: 2026-07-28
measured_against: "main @ 46f35323c"
origin: docs/plans/2026-07-26-001-refactor-workflow-owned-lifecycle-plan.md
---

# U9 safeguard baseline

U9 converts review and merge onto graph nodes. Merge is where irreversible things
happen, so the conversion needs a baseline that is **verified, not asserted**: for
each safeguard, where it is consulted today, and which test actually proves it.

Every row below was verified by **mutation delta** — record the failing-test set at
baseline, break the guard in production code, re-run the identical selection, and
report only the NEW failures. A cited test that does not fail is not evidence, and
this program has already shipped four guards that looked like enforcement and were
not. The first version of this document made that same mistake in its own
measurement; see Methodology.

**Result: four of the six safeguards are covered. Safeguards 1 (user pause) and 4
(capacity single-flight) have no test coverage at all.**

## The six safeguards

> **CORRECTED 2026-07-28 (second pass).** The first version of this table was
> **wrong for rows 1 and 4**, and wrong in the exact way this program keeps
> producing: it reported the ABSOLUTE failure count under mutation with **no
> baseline**. `merge-error-recovery.test.ts` (10) and `self-healing.test.ts` (1)
> are **already red on clean `main`**, so the "11 failed" I credited to the row 1
> mutation was pre-existing red — the mutation added nothing. Every row below is
> now a **delta**: failing-test SET at baseline vs under mutation, reporting only
> NEW failures, with each new failure named.

| # | Safeguard | Consulted at | Baseline fails | Mutated fails | **NEW** | Verdict |
|---|---|---|---|---|---|---|
| 1 | **user pause** | `project-engine.ts:645` merge admission filter | 11 | 11 | **0** | **NOT COVERED** |
| 2 | **`autoMerge:false`** | `project-engine.ts:2797` `allowsAutoMergeProcessing` | 0 | 9 | **9** | covered |
| 3 | **dependency gating** | `task-merge.ts:402` unresolved-dependency reason | 0 | 5 | **5** | covered |
| 4 | **capacity** | `project-engine.ts:3178` single-flight `mergeRunning` | 10 | 10 | **0** | **NOT COVERED** |
| 5a | **merge-proof** (pre-enqueue) | `project-engine.ts:2609` `getTaskMergeBlocker` consult | 0 | 1 | **1** | covered, thin |
| 5b | **merge-proof** (file scope) | `merger-file-scope.ts:200` `FileScopeViolationError` | 0 | 6 | **6** | covered |
| 6 | **at-most-once** | `project-engine.ts:2730` `mergeActive` dedupe | 0 | 3 | **3** | covered |

**Four of six hold. Two do not.**

### Safeguards 1 and 4 have NO test coverage

Deleting the user-pause filter from merge admission, or the single-flight guard
from the merge pump, produces **zero new test failures** anywhere in the merge,
project-engine, self-healing, or concurrency suites.

- **Safeguard 1** is the one re-ratified in #2486: never MUTATE lifecycle state of
  a user-paused card. Removing `task.paused || task.userPaused` from the admission
  provider admits a user-paused card into the merge pump — and nothing fails.
- **Safeguard 4** is the single-flight guard that makes merge serialized. Removing
  it permits concurrent `drainMergeQueue` entry — and nothing fails.

Both are guards that exist and work today; what is missing is any test that would
notice if they stopped. That is precisely the state U9 must not convert on top of.

Named tests for the four that do hold are in the delta output; rows 2 and 6 are
`project-engine.test.ts`, row 3 is core's `task-merge.test.ts`, row 5b is
`merger-file-scope-invariant.test.ts`, row 5a is a single `project-engine.test.ts`
case.

## Gate coverage

Of the test files proving the four surviving safeguards, **only
`merger-merge-lifecycle.test.ts` is in the `engine-core` merge-gate allow-list**,
and it is not the file that proves any of them — rows 2/5a/6 rest on
`project-engine.test.ts` and row 3 on core's `task-merge.test.ts`, neither of which
is in the gate (the core gate is two PG tests via `test:pg-gate`).

Per AGENTS.md the gate is thin and trusted; a red non-blocking run is "information,
not a merge stopper". So **no safeguard on this table is currently defended by
blocking CI.**

## Methodology — three ways I got this wrong

Recorded because each produced a confident, wrong result, and all three are the
same family of error this program is trying to stamp out.

1. **Absolute counts with no baseline.** Rows 1 and 4 were reported as covered
   because the mutated run showed failures. The selection was already red. **A
   mutation run must diff fail-SETS against a baseline of the identical selection
   and report only NEW failures.**
2. **Too-narrow selection.** An earlier pass measured rows 1 and 3 at zero
   failures and I nearly filed both as gaps; widening changed row 3. Narrow runs
   cannot prove absence — but see (1), because widening is also how the
   pre-existing red crept in. Both directions need the baseline diff.
3. **A harness whose parser silently matched nothing.** The delta harness's regex
   required a `|project|` segment in vitest's `FAIL` line. Core's config does not
   emit one, so for `@fusion/core` it parsed **zero** failures at both baseline and
   mutation and printed "NOT COVERED" for row 3 — which is in fact covered by 5
   tests. A verification tool that reports success without checking anything is
   worse than no tool; it has to be tested against a known-failing case before its
   output is trusted.

Harness: baseline run → assert patch applied (a no-op patch is an abort, not a
pass) → mutated run → `comm -13` the sorted fail-sets → restore → assert clean.

## What this baseline does not cover

- **Reviewer-lane safeguards.** This is the merge lane only. The review nodes
  (verdict routing, provider-outage hold-in-place) need the same treatment before
  the reviewer converts.
- **FN-7720 operator bypass** and **FN-8492 orphaned-pending-step rewrite** are
  named U9 invariants but are not safeguards on this table; they need their own
  verified rows.
- **Branch-group member integration / promotion sequencing** (the FN-5819 scoped
  exception to safeguard 2) is covered incidentally by row 2's mutation but has no
  dedicated verified row yet.

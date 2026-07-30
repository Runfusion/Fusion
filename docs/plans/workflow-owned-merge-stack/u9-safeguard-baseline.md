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

**Result: five of the six safeguards are covered. Safeguard 1 (user pause) has no
test coverage at all.**

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
| 4 | **capacity** | `project-engine.ts:3178` single-flight `mergeRunning` | 0 | 1 | **1** | covered — `merge-single-flight-invariant.test.ts` |
| 5a | **merge-proof** (pre-enqueue) | `project-engine.ts:2609` `getTaskMergeBlocker` consult | 0 | 1 | **1** | covered, thin |
| 5b | **merge-proof** (file scope) | `merger-file-scope.ts:200` `FileScopeViolationError` | 0 | 6 | **6** | covered |
| 6 | **at-most-once** | `project-engine.ts:2730` `mergeActive` dedupe | 0 | 3 | **3** | covered |

**Five of six hold. One does not: safeguard 1.**

### Safeguard 1 has NO test coverage

Deleting the user-pause filter from merge admission produces **zero new test
failures** — verified against a deliberately wide selection (`project-engine`,
`merge-single-flight-invariant`, `concurrency`, `merge-active-status`,
`merge-reclaim-policy`, `merger-merge-lifecycle`).

Safeguard 1 is the one re-ratified in #2486: never MUTATE lifecycle state of a
user-paused card. Removing `task.paused || task.userPaused` from the admission
provider admits a user-paused card into the merge pump — and nothing fails. The
guard exists and works today; what is missing is any test that would notice if it
stopped. That is precisely the state U9 must not convert on top of.

> **Row 4 corrected 2026-07-28 (third pass, #2520 review — greptile P1).** Capacity
> single-flight IS covered, by `merge-single-flight-invariant.test.ts` (landed in
> #2502, "capacity, part 1"). My row-4 run reported it uncovered because **that file
> was not in the selection** — methodology error #2 below, committed *after* I wrote
> error #2 down. The lesson is not "widen once"; it is that a NOT-COVERED verdict
> needs a deliberate search for existing coverage by name, not just a wider run of
> whatever files came to mind.

Named tests for the four that do hold are in the delta output; rows 2 and 6 are
`project-engine.test.ts`, row 3 is core's `task-merge.test.ts`, row 5b is
`merger-file-scope-invariant.test.ts`, row 5a is a single `project-engine.test.ts`
case.

## Gate coverage

At the time of measurement, of the files proving these safeguards **only
`merger-merge-lifecycle.test.ts` was in the `engine-core` allow-list**, and it is
not the file that proves any of them — rows 2/5a/6 rest on `project-engine.test.ts`,
row 3 on core's `task-merge.test.ts`, row 4 on `merge-single-flight-invariant.test.ts`.

**Being fixed in #2526:** `project-engine.test.ts` and
`merge-single-flight-invariant.test.ts` are admitted to the gate, which brings rows
1, 2, 4, 5a and 6 into blocking CI for +~1.0s (5.19–5.51s → 6.18–6.32s against a
~60s ceiling). Row 3 stays outside — core's gate is two PG tests via `test:pg-gate`
and admitting a non-PG core file is a separate change.

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
2. **Too-narrow selection — twice.** An earlier pass measured rows 1 and 3 at zero
   and I nearly filed both as gaps; widening changed row 3. Then row 4 was filed as
   NOT COVERED because `merge-single-flight-invariant.test.ts` was not in the
   selection — an error I made *after* writing this very item down. Widening the run
   is not the fix. **A NOT-COVERED verdict requires a deliberate search for existing
   coverage by name** (`ls`/grep the suite for the guard's concept) before the
   verdict is allowed to stand.
3. **A harness whose parser silently matched nothing.** The delta harness's regex
   required a `|project|` segment in vitest's `FAIL` line. Core's config does not
   emit one, so for `@fusion/core` it parsed **zero** failures at both baseline and
   mutation and printed "NOT COVERED" for row 3 — which is in fact covered by 5
   tests. A verification tool that reports success without checking anything is
   worse than no tool; it has to be tested against a known-failing case before its
   output is trusted.

Harness: baseline run → assert patch applied (a no-op patch is an abort, not a
pass) → mutated run → `comm -13` the sorted fail-sets → restore → assert clean.

## Why the merge-region nodes cannot be tested as nodes (and what U9 actually is)

Three attempts to give safeguard 2 (`autoMerge:false` is terminal-until-human) a
graph-level E2E all failed, and the third failure found the reason. It is the single
most useful thing in this document for whoever lands the conversion.

`workflow-graph-executor.ts:310` says it plainly:

> Until the workflow interpreter owns merge policy end-to-end, graph execution treats
> any entry into this region as the terminal legacy `merge` seam so observable
> lifecycle behavior stays byte-identical with the legacy executor.

`MERGE_REGION_KINDS` is `merge-gate`, `merge-attempt`, `manual-merge-hold`,
`retry-backoff`, `recovery-router`, `branch-group-member-integration`,
`branch-group-promotion`. **Entering any of them short-circuits to the legacy merge
seam, so none of their handlers ever runs.** Consequences worth stating separately,
because each one burned an attempt:

- `createMergeGateHandler` (`merge-runner.ts:44`) DOES read
  `task.autoMerge !== false && settings.autoMerge !== false` and emit
  `auto-on`/`auto-off` — and is **never called by the graph**. A test that drives a
  graph and expects the gate to park an `autoMerge:false` card will watch the card
  complete, no matter how the IR is shaped.
- The `outcome:auto-on` / `outcome:auto-off` edges the builtin coding IR declares are
  therefore unreachable in graph execution today.
- This is the mechanism behind the very first U9 finding
  (`u9-merge-region-node-config-authority.test.ts`): the IR's merge-region config is
  unread not because a handler ignores it, but because the executor bypasses the whole
  region.

**So U9's conversion, stated concretely, is: stop short-circuiting
`MERGE_REGION_KINDS` to the legacy seam and let those nodes run.** Everything else —
S06's capability extraction, S07's completion handoff, S08's queue processing — hangs
off that one behavioural change, and the safeguard table above is the contract it must
not break. Safeguard 2 in particular has NO node-level representation today, so a
conversion that simply enables the region without carrying the `autoMerge` contract
into it would let an `autoMerge:false` card merge on PR-readiness alone.

Attempts, recorded so they are not repeated:
1. Fixture with an auto-off edge alongside its existing bare `success` edge — the
   `autoMerge:false` card COMPLETED, because both edges match
   `{ outcome: "success", value: "auto-off" }` and `end` won on target-id sort. (Real
   IR-authoring hazard; the builtin routes `outcome:auto-on` explicitly for this
   reason.)
2. Dropped `merge-blocker` from the review column to isolate the gate — broke the route
   to `end`, so the CONTROL card parked too and the flag was still not the
   discriminator.
3. Mirrored the builtin region (`merge-gate --auto-on--> merge-attempt --> end`,
   `--auto-off--> manual-hold`) — control passed, `autoMerge:false` still completed.
   That is what exposed the short-circuit: the nodes are not executing.

Testing safeguard 2 at the node level requires a harness that does NOT substitute
merge-region nodes, which is a change to the executor's substitution boundary rather
than a test addition — i.e. it becomes possible as part of the conversion, not before
it.

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

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

Every row below was verified by **mutation** — break the guard in production code,
run the cited tests, confirm they go red, restore. A cited test that does not fail
is not evidence, and this program has already shipped four guards that looked like
enforcement and were not.

## The six safeguards

| # | Safeguard | Consulted at | Mutation applied | Result | Proven by |
|---|---|---|---|---|---|
| 1 | **user pause** | `project-engine.ts:645` — merge admission provider filters `task.paused \|\| task.userPaused` | dropped both pause checks | **11 failed** / 1865 passed | `merge-error-recovery.test.ts`, `self-healing.test.ts` |
| 2 | **`autoMerge:false`** | `project-engine.ts:2797` — `allowsAutoMergeProcessing(task, settings) \|\| isLiveSharedBranchGroupMemberIntegration(...)` | forced `return true` | **9 failed** / 250 passed | `automerge-toggle-legacy-advisory.test.ts`, `executor-live-branch-group-auto-merge-hold.test.ts`, `merger-merge-lifecycle.test.ts`, `project-engine.test.ts` |
| 3 | **dependency gating** | `task-merge.ts:402` — `getTaskCompletionBlocker` returns the unresolved-dependency reason | returned `undefined` | **5 failed** / 94 passed | `packages/core/.../task-merge.test.ts` |
| 4 | **capacity** | `project-engine.ts:3178` — `if (this.mergeRunning) return;` single-flight merge pump | removed the guard | **11 failed** / 1445 passed | `merge-error-recovery.test.ts`, `project-engine.test.ts` |
| 5a | **merge-proof** (pre-enqueue) | `project-engine.ts:2609` — `if (this.options.getTaskMergeBlocker?.(task)) return false;` | removed the consult | **1 failed** / 272 passed | `project-engine.test.ts` — a single test |
| 5b | **merge-proof** (file scope) | `merger-file-scope.ts:200` — `throw new FileScopeViolationError(...)` | removed the throw | **6 failed** / 172 passed | `merger-file-scope-invariant.test.ts` |
| 6 | **at-most-once merge** | `project-engine.ts:2730` — `mergeActive` membership rejects a duplicate enqueue | let the duplicate through | **3 failed** / 263 passed | `merge-active-status.test.ts`, `merger-merge-lifecycle.test.ts`, `project-engine.test.ts` |

All six hold. Nothing here is currently broken.

## The two findings that matter for U9

### 1. One of nine safeguard test files runs in blocking CI

Of the nine test files above, **exactly one — `merger-merge-lifecycle.test.ts` — is in
the `engine-core` merge-gate allow-list.** The core gate is two PG tests
(`test:pg-gate`), and `task-merge.test.ts` is not among them.

Per AGENTS.md the merge gate is "thin and trusted": CI blocks on Lint, Typecheck,
Build, and Gate, and "a red non-blocking run is information, not a merge stopper."

So today a change that breaks **user pause on merge admission, dependency gating,
capacity single-flight, or the file-scope invariant** does not block a PR. It goes
red in full-suite, after the merge.

That is a safe-enough posture for a lane nobody is rewriting. It is the wrong
posture for the lane U9 is about to rewrite. **Recommendation: admit the
highest-value safeguard tests to the gate before the conversion begins**, with the
budget cost measured rather than assumed (the gate's stated ceiling is ~60s
wall-clock; engine-core is currently 5.36s).

### 2. Safeguard 5a rests on a single non-gate test

Removing the pre-enqueue merge-blocker consult fails exactly **one** test, in
`engine-default`. Of the six safeguards it has the thinnest coverage, and it is one
of the two flagged destructive-risk. Its sibling 5b (file scope) is well covered at
6 tests, so the *invariant* is not unguarded — but the specific consult that keeps a
blocked task out of the queue in the first place very nearly is.

## Methodology note — read this before trusting a "no failures" result

Rows 1 and 3 **initially measured zero failures** and looked like coverage gaps.
Both were wrong: the test selection was too narrow. Widening row 1 from three files
to the `project-engine|merge|concurrency|self-healing` set turned 0 failures into 11.
Row 3's real coverage lives in `@fusion/core`'s suite, which an engine-only
`--filter` never runs.

Two rules follow, and they cost an hour to learn:

- **A narrow mutation run cannot prove absence of coverage.** Widen before
  concluding a gap exists, and say which selection produced the number.
- **Cross-package guards need cross-package runs.** `packages/engine/vitest.config.ts`
  aliases `@fusion/core` to *source*, so a core mutation is live in engine tests —
  but the tests that actually assert on it may sit in the core package, which
  `pnpm --filter @fusion/engine` will not run.

Harness used: mutate → run cited tests → record → restore, asserting the patch
actually applied (a silently non-applying patch reports a false "no failures").

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

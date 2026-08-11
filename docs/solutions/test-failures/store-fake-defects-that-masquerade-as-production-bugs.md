---
category: test-failures
module: "@fusion/engine, @fusion/core"
date: 2026-07-28
problem_type: convention
component: test-fixtures
severity: high
applies_when:
  - "Hand-rolling a TaskStore fake with vi.fn() for a triage/scheduler/self-healing test"
  - "A new test fails and the production code looks wrong on first reading"
  - "A branch under test appears not to run, or only its first loop iteration runs"
  - "A suite exits non-zero while reporting every test green"
  - "Writing a guard/ratchet and needing to prove it fails on the original defect"
tags:
  - test-fixtures
  - taskstore-fake
  - false-red
  - false-green
  - vitest
  - guard-cannot-fire
---

# Store fakes that lie: six defects that each looked like a production bug

Over six consecutive slices of one unit (U7, workflow-owned lifecycle), **every
single slice produced a test-fixture defect that first presented as a production
bug.** Six for six. Not one was a real defect in the code under test.

Each cost between fifteen minutes and an hour of debugging the wrong file. Two
would have shipped a *false green* — a test that passes while asserting nothing —
if the failure had happened to look plausible instead of implausible.

This is not a story about carelessness. Every one of these fakes was modelled on an
existing fixture in the repo, and the repo's fixtures are inconsistent about exactly
the things that matter.

## The catalogue

| # | Defect | How it presented | Real cause |
|---|---|---|---|
| 1 | `moveTaskIf` fake ignores its predicate and always moves | Test passed. In-transaction guard was untested and indistinguishable from absent | Fake never invoked the callback it was handed |
| 2 | `updateTaskAtomic: vi.fn()` never invokes its callback | *Every* finalize reported "no longer in the planning stage" and bailed before the branch under test | `updatePlanningStateIfStillCurrent` derives success from whether the callback ran |
| 3 | Harness default parameter swallows the interesting input | "Task vanished" case silently became a duplicate of the control | `harness(undefined)` triggers the default; `null` was needed |
| 4 | `logEntry: vi.fn()` returns `undefined` | Sweep appeared to match only one column | Production does `await store.logEntry(...).catch(...)`; `.catch` on `undefined` throws and aborts the loop after its first item |
| 5 | Harness lets `poll()` reach the real `specifyTask` | **Suite exit code 1 with every test green** | Real agent path threw *asynchronously*, after the assertions had passed |
| 6 | `updateTask: vi.fn()` returns `undefined` | Branch under test "did not run" | Same as #4 — `.catch` on a non-promise |

Defects 4 and 6 are the same shape, found a week apart, because nothing prevented
the second.

## The three rules that would have prevented all six

### 1. Every store method a fake exposes must return what the real one returns

Overwhelmingly that means **a promise**. Production code routinely writes
`await store.method(...).catch(handler)` as a fail-soft idiom, and `.catch` on
`undefined` throws a `TypeError` that unwinds to the nearest `try` — which is
usually a broad "never let housekeeping break the poll" handler that swallows it.

```ts
// WRONG — throws on `.catch`, aborts the caller mid-branch
updateTask: vi.fn(),
logEntry: vi.fn(),

// RIGHT
updateTask: vi.fn().mockResolvedValue(undefined),
logEntry: vi.fn().mockResolvedValue(undefined),
```

The symptom is never "your fake is wrong". It is "the loop only processed the first
item" or "the branch didn't run" — both of which read as production bugs.

### 2. A fake that is handed a predicate or callback must invoke it

`moveTaskIf`, `updateTaskAtomic`, `deleteTaskIf`, and `withTaskLock` all take a
function and use its result. A fake that ignores it does not just lose coverage —
it makes the guarded and unguarded implementations **indistinguishable**, so a test
named for the guard cannot detect the guard's removal.

```ts
// WRONG — the conditional move is now unconditional
function createStore(task: Task): TaskStore {
  return {
    moveTaskIf: vi.fn(async (id, column) => ({ moved: true, task })),
  } as unknown as TaskStore;
}

// RIGHT — honors the predicate, and takes a hook for the racing case.
// `onLockedRead` models the row AS THE TASK LOCK SEES IT, which is not
// necessarily the snapshot the caller loaded earlier in the pass.
function createStore(
  task: Task,
  onLockedRead?: (live: Task) => Task,
): TaskStore {
  return {
    moveTaskIf: vi.fn(async (id, column, predicate) => {
      const live = onLockedRead ? onLockedRead(task) : task;
      if (!(await predicate(live))) return { moved: false, task };
      return { moved: true, task: { ...task, column } };
    }),
  } as unknown as TaskStore;
}

// A test that needs the race then supplies the divergence explicitly:
const store = createStore(card, (live) => ({ ...live, status: "awaiting-approval" }));
```

The `onLockedRead` hook matters: an in-transaction re-check exists to catch state
that changed *after* the caller's snapshot. Without a way to make the locked read
differ from the snapshot, the recheck is untestable even once the predicate is
invoked.

### 3. Stub the agent-dispatch boundary, or the real one runs past your assertion

Triage's `poll()`, the scheduler's dispatch, and the continuation drain all end in
"start an agent". In a unit test that reaches module-mocked provider code and
throws **after** the test has resolved.

```ts
vi.spyOn(processor as unknown as { specifyTask: (t: Task) => Promise<void> }, "specifyTask")
  .mockResolvedValue(undefined);
```

This is the one that produces a *false green*: `Tests 17 passed`, `exit code 1`. On
CI that reads as infrastructure noise.

> **Never accept a non-zero exit on a green run.** It is the only signal that
> something escaped your assertions entirely.

## How to tell a fixture defect from a real bug, fast

The tell is **failing for the wrong reason**. Before editing production code, ask:

1. Does the failure message match the hypothesis the test was written to check? If
   the test is about column resolution and the error is `Cannot read properties of
   undefined (reading 'catch')`, it is the fixture.
2. Does the *control* case fail too? A conversion test that runs the same scenario
   under default and renamed vocabularies should fail only on the renamed half. If
   both fail, suspect the harness — the default half is asserting today's shipped
   behavior, which is by definition working.
3. Did *only the first* item of a loop get processed? Almost always rule 1.

Point 2 is why **differential tests are worth writing even when they feel
redundant**: the control half doubles as a fixture self-check.

## The connected lesson: guards that cannot fire

The same failure mode appears in production guards, not just fixtures. On this
program six guards were found that could not fire — a flag whose body was
`return true`, a ratchet matching only a double-quoted literal, a scope list that
excluded two packages that needed it.

The discipline is identical in both cases:

> **Prove the check fails on the thing it claims to catch, before trusting that it
> passes.**

For a test: revert your production change and confirm the test goes red, and read
*which* cases went red. For a ratchet: inject the violation into real source, in the
form most likely to evade it — and confirm the injection actually landed before
trusting the red. (One injection attempt on this program silently failed to apply,
leaving a green run that would have "proven" the ratchet worked.)

## Recommended next step

The rules above want to be a shared helper —
`createTaskStoreFake({ tasks, workflowIr })` returning promise-resolving,
callback-invoking defaults — rather than prose each unit rediscovers. That is a
single small PR and it removes the whole class. It is not built yet because it is
cross-unit and needs adopters; if you are about to hand-roll a seventh store fake,
build it instead and link it here.

## FN-8949: complete self-healing fake call surfaces

`self-healing-query-filter-blindness.test.ts` required both
`transitionQueuedEpisode: vi.fn(async () => ({ appended: true }))` and
`peekMergeQueue: vi.fn(async () => [])`. The first tracks the current queued
`blockedBy` transition seam; the second prevents `surfaceInReviewStalls` from
throwing before its renamed-lane assertion. The merge-queue-peek addition was
**kept**: it changed no per-case verdict while removing the missing-method path.

See `dead-vi-mock-specifiers-fail-silently.md` for the related case where a mock
factory is unwired rather than a store fake being incomplete.

## Related

- `docs/testing.md` — testing lanes and the taxonomy for trim-vs-keep.
- AGENTS.md → "Standing Rule: Fix the Invariant, Not the Repro" — the same
  discipline applied to regression coverage.
- `docs/solutions/test-failures/optional-flags-seam-hides-unconverted-column-guards.md` — the mirror
  image of this entry. HERE a fake is MISSING a method, so a branch silently does not run. THERE the
  fake is complete and the test is correct, but an OPTIONAL parameter is omitted, so the production path
  takes its documented legacy fallback and the suite stays green through a conversion AND through a
  broken one.

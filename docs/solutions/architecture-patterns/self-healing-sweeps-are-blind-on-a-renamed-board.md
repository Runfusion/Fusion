---
category: architecture-patterns
module: workflow-resolved-columns
date: 2026-07-30
problem_type: systemic_gap
component: engine
severity: high
applies_when:
  - "Converting a lifecycle-column literal in packages/engine/src/self-healing.ts"
  - "Reading the lifecycle-column census total as the remaining work"
  - "Writing or reviewing a test whose fake implements listTasks"
tags:
  - workflow-resolved-columns
  - column-census
  - self-healing
  - store-fake
  - query-filter
---

# The self-healing sweeps do not run at all on a renamed board — and converting their 97 comparisons would not change that

## The measurement

`packages/engine/src/self-healing.ts` carries, on `origin/main` at the time of writing:

- **97** lifecycle-column comparisons the census counts, and
- **49** calls of the shape `this.store.listTasks({ column: "<literal>", … })`.

The second number is the one that matters. `listTasks`' option is `column?: ColumnId` — a **single literal column**, applied as a query filter in the store. On a workflow whose lanes are named anything else, every one of those 49 queries returns an **empty array**, so the sweep it feeds does nothing at all.

That means the sweeps are not *mostly* correct with a few unconverted guards. They never execute. The `in-review` family alone accounts for roughly half the calls, which is the merge-recovery, wedged-merge, branch-rebind, and pending-step reconciliation surface.

## Why the census points at the wrong thing here

A sweep looks like this:

```ts
const tasks = await this.store.listTasks({ column: "in-review", slim: true });
for (const task of tasks) {
  if (task.column !== "in-review") continue;   // <-- the census counts THIS
  …
}
```

The census scores the **comparison**, not the query. Converting the comparison to a resolved role is a legal-looking change that drops a census count and changes **nothing an operator can observe** — the loop body still never runs, because the list was already empty.

This is the *query-filter-bounded* class. Roughly 31 of self-healing's remaining comparisons are re-assertions of a filter the query already applied. They are not conversion work; they are downstream of one architectural fix.

**So the census total is a floor, and in this file it is actively misleading.** Driving `self-healing.ts` to 0 would report the subsystem as converted while it remains entirely inert on custom boards.

## Why the test suite cannot see this

Measured across `packages/engine/src/__tests__/self-healing*.test.ts`:

- **30** test files define a `listTasks` on their store fake.
- **17** of them ignore the `column` option entirely — they return every seeded task regardless of what the sweep asked for.

```ts
// self-healing-orphaned-pending-step-results.test.ts — representative of the 17
listTasks: vi.fn(async (options?: { limit?: number; offset?: number }) => {
  const all = [...tasksById.values()];          // `options.column` is not read
  return all.slice(offset, offset + limit);
}),
```

The fake is **more permissive than production**. The sweep under test receives rows that the real query would have filtered out, so the test proves the sweep's *logic* while saying nothing about whether the sweep is ever *reached*. A green self-healing suite is therefore not evidence that self-healing runs.

This is the mirror image of `store-fake-defects-that-masquerade-as-production-bugs.md`. There, a fake is missing a method the production path needs, so a branch silently does not run and the production code looks broken. Here the fake supplies **more** than production would, so the production gap looks fixed.

## What an actual fix requires

Not a literal conversion. `column?: ColumnId` accepts one id, and the resolution is circular at the query layer: you need a task to know its workflow, and you are querying to find the tasks.

The two shapes that work:

1. **Widen the query.** Add a multi-column option (`columns?: readonly ColumnId[]`), resolve the union of column ids carrying the wanted trait across all live workflow definitions, and pass that set. One extra read per sweep, no per-task resolution.
2. **Drop the filter and post-filter by role.** `listTasks({ slim: true })` then filter with the per-task resolved lane. Correct, but it moves a store-side filter into the engine for every sweep on every poll — a real cost on a large board.

(1) is the better default. Either is a **behaviour change to a shared store API plus 49 call sites**, which is a coordinator-level decision, not something a conversion PR should take unilaterally — the same reasoning that kept membership predicates out of the census.

## What to do until then

- Do **not** convert a comparison that sits behind a column-filtered query in this file and report it as progress. Mark it, or leave it.
- When you touch a self-healing test, make its `listTasks` fake **honor `options.column`**. That is a one-line change per fake and it converts this whole class from invisible to failing-loudly.
- Read `self-healing.ts: N` in the census as "N comparisons", never as "N remaining defects" — in this file the two numbers are not related.

## Converting a sweep: the four-part shape, and the part that is easy to miss

**Eight sweeps are converted**, all deliberately identical because the second one drifted from the first —
it was written from the pre-review version and reproduced a flaw review had already fixed one commit
earlier:

```text
  reconcileDoneTaskIntegrity                 recoverMergeableReviewTasks
  recoverAlreadyMergedReviewTasks            recoverReviewTasksWithFailedPreMergeSteps
  recoverStuckMergeDeadlocks                 finalizeNoOpReviewTasks
  recoverInterruptedMergingTasks             recoverCompletionHandoffLimbo
```

**Measured, and the measurement needed three corrections — recount before quoting it.** Literal column
queries in `self-healing.ts`, comments stripped: **47 before, 36 now.**

Every intermediate number I published was wrong, and each in a different way:

- The per-commit "N remaining" counts were **arithmetic on an assumed starting point**, not measurements.
- A raw `grep -c` counts **explanatory comments that quote the old query form** — including the ones this
  conversion adds, so converting a sweep could leave the count unchanged.
- The obvious comment filter (`startsWith("//") || startsWith("*")`) misses block-comment lines that begin
  with ordinary prose, which is most of them here.

Count with block comments actually stripped:

```bash
node -e 'const s=require("fs").readFileSync("packages/engine/src/self-healing.ts","utf8")
  .replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"");
  console.log((s.match(/listTasks\(\{ column: "/g)||[]).length)'
```

1. **Read** — `resolveProjectColumnsForRoles(store, ROLES)`, then query each column and dedupe by id. A
   read happens before any task is in hand, so there is nothing to resolve a per-task lane from. The
   legacy ids are unioned in, so a board mid-rename whose rows are still stored under the old id is not
   skipped.
2. **Verdict** — resolved per card against **its own** workflow. Widening the read and widening the
   verdict are different decisions: a missed row is invisible, a wrong row is a write. Using the project
   union as a per-card test claims a card because *some other board* calls its column that role.
3. **Provenance** — `resolveWorkflowIrForTaskWithProvenance`, because the resolver **substitutes** the
   built-in IR rather than failing. Without it, `columnsWithFlag(ir, role).length > 0` reads as "this card
   answered" when nobody did. It does not change the verdict (measured: identical, since the built-in lane
   already *is* the legacy id) — it makes the unrepaired card **reportable** instead of invisible.
4. **The log strings.** Widening a query silently invalidates every message naming the old literal.
   `recoverInterruptedMergingTasks` logged `"stale merging task(s) in in-review"` after its read covered
   several lanes — an operator debugging a renamed board would have been told the wrong column.
5. **The guards the widened query now ACTIVATES.** This is the one that bites hardest, because it makes a
   conversion look complete while delivering nothing.

## Converting a query is also an activation

A guard downstream of a literal query is **unreachable on a renamed board** — the sweep never hands it a
row. Unreachable and correct are indistinguishable from the outside, which is exactly why these guards sit
unwired for years without anyone noticing.

Widen the read and they become reachable for the first time. `recoverMergeableReviewTasks` called
`getTaskMergeBlocker(t)` unwired; the moment its query found renamed-board cards, that call declined every
one of them. **The sweep would have found the cards and refused them** — strictly worse than not finding
them, because it looks fixed.

Measured across `self-healing.ts`: **2 sweeps hold both a literal column query and a genuinely unwired lane
guard**; 34 hold a literal query with no such guard.

```text
  recoverOrphanOnlyScopeViolations    getTaskHardMergeBlocker
  recoverPostDoneNonContinuableWedge  getTaskHardMergeBlocker
```

**That number was 6 in the first version of this doc, and both extra rows were my scanner lying.** Worth
recording, because the scan is the thing the next worker will re-run:

- `recoverAlreadyMergedReviewTasks` was reported unwired **after I had wired it** — the options object sits
  on the call's *last* line and the check read only the *first*. A multi-line call needs its whole span.
- `recoverReviewTasksWithFailedPreMergeSteps` was reported with a second unwired guard that is **prose
  inside a doc comment** (`"because getTaskMergeBlocker() correctly blocks incomplete steps"`).

Both are the same failure this program keeps documenting about the census: **an instrument that matches
syntax, read as if it measured meaning.** I published 6, corrected to 5, and only reached 4 by re-checking
the correction itself. Re-run the scan with the span-aware and comment-skipping form, and spot-check each
row against the source before acting on it.

The scan must also run **before** the query is widened, not after: I converted
`recoverAlreadyMergedReviewTasks` two commits before noticing its guard, so for two commits it found
renamed-board cards and declined them.

`getTaskHardMergeBlocker` was the blind spot for four of the six: it is a *wrapper*, it had no lane
parameter at all, and every one of its callers sat behind a literal query. Nothing exercised it.

Parts 4 and 5 are both invisible to the census — one is string contents, the other is reachability — and
each of the **36 remaining queries** carries both risks.

## Testing a sweep: assert what happens ONLY when the change is correct

Four assertions on this branch were vacuous — they passed with the fix reverted — and all four shared one
shape: **I asserted something the sweep does regardless of the code under test.** The surface presentation
differed every time, which is why recognising it took four rounds:

| the assertion | why it proved nothing |
| --- | --- |
| `commitSha` stayed undefined | the write needs a real git repo, so it never happens in the fixture either way |
| `toContain("must be in")` | **two** guards can refuse; the other one caught the card and produced the same substring |
| a warn was emitted | the sweep warns on a path unrelated to the conversion |
| `getSettings` was called | the sweep calls it **unconditionally on its first line** |

The reliable question is not *"did something observable happen"* but *"what happens **only** when this
change is correct"*. In a self-healing sweep that is almost always **candidacy** — the first thing that
runs once per accepted row, after the filter:

```ts
// getSettings runs before the filter → useless
// isBranchAheadOfBase runs once per CANDIDATE → separates accepted from declined
const aheadCheck = vi.spyOn(manager as never, "isBranchAheadOfBase").mockResolvedValue(false);
```

**Asserting the query is only safe when nothing downstream can veto.** Once a sweep has a lane-sensitive
guard (part 5), a query-only assertion passes while the guard silently rejects every row — which is
precisely the bug being fixed. Where a guard exists, assert the end-to-end outcome instead.

And run the revert. Every one of the four above was found that way and none by reading.

### "It needs a git fixture" is usually a private method you have not stubbed

Twice on this branch I judged a sweep's lane-sensitive guard unreachable in a unit test because it sat
behind git-backed calls, and shipped a candidacy-only assertion with the limit stated in the PR. Review
pushed back on the second one, and the objection was right: the git-backed calls —
`resolveSelfHealingMergeTarget`, `findAlreadyMergedTaskCommit` — are **private instance methods**, so
stubbing them on the manager reaches the guard with no git anywhere on the path.

```ts
const manager = new SelfHealingManager(store, { rootDir: "/repo" });
Object.assign(manager, {
  resolveSelfHealingMergeTarget: vi.fn(async () => ({ branch: "main", source: "settings" })),
  findAlreadyMergedTaskCommit: vi.fn(async () => ({ sha: "abcdef1234567890" })),
});
```

`executor-worktree-owner-renamed-lanes.test.ts` already did exactly this for `findActiveWorktreeOwner`,
with a header explaining why. I had read that file the same week. The guard was never unreachable — it
was unreachable *the way I first tried to reach it*, and "I stated the limit honestly in the PR" made a
gap feel resolved when it was merely disclosed.

Once you are past the guard, the assertion writes itself: the sweep's own write differs by exactly the
wiring under test — blocker clear → `status: null`, blocker fires → `status: "failed"` with a
finalization-blocked error. Prefer that over candidacy whenever a lane-sensitive guard exists.

**Before writing "this cannot be tested without a fixture", check whether the thing in the way is
private.** If it is, it is a stub, not a fixture.

## Related

- `docs/solutions/test-failures/optional-flags-seam-hides-unconverted-column-guards.md` — the same lesson one level down: the census counts syntax, and a green suite that omits the new parameter carries no information about the change.
- `docs/solutions/architecture-patterns/sync-workflow-ir-readers-always-return-the-default.md` — the other way a conversion can look done and be inert.
- `docs/solutions/test-failures/store-fake-defects-that-masquerade-as-production-bugs.md` — the inverse fake defect.

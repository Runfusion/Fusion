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

Four sweeps are converted (`reconcileDoneTaskIntegrity`, `recoverAlreadyMergedReviewTasks`,
`recoverStuckMergeDeadlocks`, `recoverInterruptedMergingTasks`). They are deliberately identical, because
the second one drifted from the first — it was written from the pre-review version and reproduced a flaw
review had already fixed one commit earlier.

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

Part 4 is the one to check last and forget first. It is invisible to the census (string contents, not
comparisons), invisible to types, and survives indefinitely because nobody diffs log strings. Each of the
**44 remaining queries** carries the same risk: grep the enclosing sweep for its own lane names after
widening its read.

## Related

- `docs/solutions/test-failures/optional-flags-seam-hides-unconverted-column-guards.md` — the same lesson one level down: the census counts syntax, and a green suite that omits the new parameter carries no information about the change.
- `docs/solutions/architecture-patterns/sync-workflow-ir-readers-always-return-the-default.md` — the other way a conversion can look done and be inert.
- `docs/solutions/test-failures/store-fake-defects-that-masquerade-as-production-bugs.md` — the inverse fake defect.

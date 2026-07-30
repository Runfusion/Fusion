---
category: architecture-patterns
module: core/task-store
tags: [lifecycle-columns, census, archived, sentinels, false-positives]
problem_type: wrong-conversion
applies_when: converting a `=== "archived"` comparison, or reading the lifecycle-column census for a file that is mostly archive code
---

# `=== "archived"` is usually a SENTINEL, and converting it breaks the contract

Found 2026-07-30 while triaging the query class the census read/write split (#2837) exposed. The
census counts `=== "archived"` as a column guard. In archive code it usually is not one.

## The measurement

`packages/core/src/task-store/async-comments-attachments.ts` carries **9** census guards — the
second-largest single-file count outside `self-healing.ts`. Reading all nine:

| line | shape | convertible? |
|---|---|---|
| 142 | `row.column === "archived"` on a raw DB row | **yes** |
| 213, 332, 345 | `task.column === "archived"` on a row `select` | **yes** — a real board lane |
| 439, 499, 559, 616, 674 | `column === "archived"` where `column` came from `getLiveTaskColumn` | **no — sentinel** |

**Corrected 2026-07-30** (PR #2877 review). This table first said "8 of 9 must not be converted",
which contradicted the rule stated further down and — much worse — would have told the next reader
that three genuine defects were intentional. Lines 213/332/345 read `task.column` off a row `select`,
so they are board lanes by exactly the test this document gives. The real split is **5 sentinels, 4
convertible**, and the fact that both classes live in one file, spelled identically, is the actual
lesson rather than the ratio.

Consequence of getting it wrong, since it is the point of the document: on a board whose archived lane
is renamed, line 213 keeps a card's documents WRITABLE and 332/345 reject a legitimate archived-document
publication as `parent-not-archived` / `archived-state-inconsistent`.

`getLiveTaskColumn` returns *either* the task's real column *or* the literal string `"archived"`,
which it manufactures for an archived-or-soft-deleted parent:

```ts
if (row.column === "archived" || row.deletedAt != null) return "archived";
return row.column;
```

Every later `column === "archived"` is therefore comparing against **that function's return
vocabulary**, not against a board lane. Converting them to `isArchivedColumnRole(flags, column)`
would keep passing on the built-in board and start *failing* on a renamed one — the sentinel
`"archived"` is not `vault`, so a soft-deleted parent's documents would become readable. The
conversion makes the renamed board *worse*, which is the opposite of what the census number
suggests.

So: **5 of the 9 guards in that file must not be converted.** A file's census count is still an upper
bound on convertible sites rather than a work estimate — the point stands with the corrected number,
and it stands more sharply now that the same file is known to hold both classes.

## The four that are real, and why they are deferred rather than done

Line 142's own test *is* a board-column comparison, and so are 213/332/345. A live row sitting in a workflow-declared
archived lane named anything but `archived` is not recognised, so `getLiveTaskColumn` returns
`"vault"`, every downstream sentinel check is false, and the card's documents stay writable while
the board shows it archived.

All four are narrow for the same reason — archived rows normally move to the archive *table*, and the
`deletedAt` companion on each covers soft-delete, which is why only a live row in a renamed archived
lane reaches them. None is a rename to fix. `getLiveTaskColumn` takes a `db` handle, not a store:
it has no task, no workflow, and no lane vocabulary. Converting it means threading a resolved
archived-lane set through a low-level DB helper and every caller of it, which is a design change
with a measurable read cost on a hot path. Stated here rather than done quietly, in the shape
`register-task-workflow-routes.ts` used for its own deferral — which was later converted, correctly,
once the project-scoped resolver existed.

## How to tell the two apart

Look at where the compared value came from, not at its type:

- came from `task.column` / a DB `column` field -> a board lane, convertible;
- came from a function that *returns* `"archived"` as one of its documented outcomes -> a sentinel,
  leave it and say so.

The same rule catches `resolveTaskLifecycleColumns`'s `undefined` and `getLiveTaskColumn`'s
`"archived"`: a manufactured value in a lane-shaped position is a vocabulary of its own.

## Related

- `docs/solutions/architecture-patterns/hardcoded-movetask-destinations-are-census-invisible.md`
  — the mirror-image error: sites the census *cannot* see.
- `docs/solutions/architecture-patterns/self-healing-sweeps-are-blind-on-a-renamed-board.md`
  — why a file at census-zero is not a converted file.

## Addendum 2026-07-30: lane literals inside raw `sql` are invisible to every check we have

Found while fixing the Reliability health panel (#2861). Two of its three inputs were call arguments
and converting them was routine. The third, `getInReviewDurationEvents`
(`packages/core/src/task-store/async-audit.ts`), encodes the lane in a raw SQL fragment:

```sql
metadata->>'to' = 'in-review'
  OR (metadata->>'from' = 'in-review' AND metadata->>'to' = 'done')
```

On a renamed board this matches nothing, so the duration metric reports `no-in-review-entries` while
the counts beside it are correct — the panel goes from uniformly blind to partially blind, which is
harder to notice than either.

**Nothing detects this shape.** The lifecycle census scans `===`/`!==` comparisons.
`scripts/lib/unwired-lane-parameter.mjs` scans declarations. Neither sees a string inside a `sql`
template. This is the second known instance — the archived gate in PR #2724 was the first — which is
enough to call it a pattern rather than an accident, and enough to say plainly that **the census
total does not include this class at all**, so it is a floor in a second, independent way.

Fixing this one is not a rename: it means threading a resolved lane set into a raw `sql` fragment
inside a `projectId`-scoped query. **Done in #2875** — the lanes resolve in the impl (which holds the
store; the query function takes a bare `db` handle) and arrive as parameterised equality fragments,
tested against real PostgreSQL because a mocked store would assert the arguments and prove nothing
about the query that runs. `scripts/check-sql-column-literals.mjs` (#2841) is the detector for the
class and freezes the surface at 28 sites; the two are complementary. (That number moves as sites are
converted and the baseline is re-recorded — the gate fails on a DROP too, so it cannot drift silently.)

Sibling importers are the other half of the same lesson: the GitLab importer's `column: "triage"` was
fixed in #2843 and the Linear importer — written from the same template — still had it, found only by
re-grepping an area already declared clean (#2860). When a defect is found in a file that has a
sibling, the sibling is the next place to look, and no tool will tell you that.

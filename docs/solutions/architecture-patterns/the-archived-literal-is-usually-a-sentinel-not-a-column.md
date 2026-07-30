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
| 142 | `row.column === "archived"` on a raw DB row | **yes** — the only one |
| 213, 332, 345 | `task.column === "archived" \|\| task.deletedAt != null` | mixed, see below |
| 439, 499, 559, 616, 674 | `column === "archived"` where `column` came from `getLiveTaskColumn` | **no — sentinel** |

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

So: **8 of 9 guards in that file must not be converted.** A file's census count is an upper bound on
convertible sites, not a work estimate.

## The one that is real, and why it is deferred rather than done

Line 142's own test *is* a board-column comparison. A live row sitting in a workflow-declared
archived lane named anything but `archived` is not recognised, so `getLiveTaskColumn` returns
`"vault"`, every downstream sentinel check is false, and the card's documents stay writable while
the board shows it archived.

It is narrow — archived rows normally move to the archive *table*, and `deletedAt` covers
soft-delete — and it is not a rename to fix. `getLiveTaskColumn` takes a `db` handle, not a store:
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

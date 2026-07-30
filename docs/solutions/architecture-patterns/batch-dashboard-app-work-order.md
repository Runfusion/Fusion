---
category: architecture-patterns
module: dashboard/app
tags: [lifecycle-columns, census, fleet, batch]
problem_type: work-order
applies_when: converting lifecycle-column literals under packages/dashboard/app
---

# batch-dashboard-app — the work order

## CLAIMED — do not re-convert (u12 worker, 2026-07-30)

TWO WORKERS ARE ON THIS BRANCH. The coordinator assigned this batch to the u12 worker and another
agent opened it; rather than contest ownership we are both feeding it, taking from opposite ends of
the list. One of us should stand down — flagged to the coordinator, unresolved as of this note.

ALREADY CONVERTED IN GREEN PRs, so converting them here duplicates work and will conflict:

  Column.tsx    7 -> 0   PR #2738 (green, mergeable) — also fixes a board-level `workflowMode`
                         flag answering a per-column question, which blanked every affordance on a
                         column the workflow no longer declares
  ListView.tsx  6 -> 0   PR #2738 — same change, plus per-TASK flag resolution for bulk actions

Those are the next two entries in the list below by size. Skip them.

SIZED AND NOT CONVERTED — the ORIGINAL seven, u12: six now wired, one genuinely blocked

UPDATE 2026-07-30-20:10. Six of the seven below are now converted end to end, each threaded from a
parent that already resolves flags (TaskDetailModal's `detailColumnFlags`, or MainContent's
`columnFlagsByTaskId`). The exception is the last one, and it is worth reading before anyone
"finishes" it:

  ResearchTaskActionModal — threading the board's flags map here is the WRONG fix. The modal fetches
    its OWN page via `fetchTasks(50, 0, projectId)`, not the board's task set, and the rows this
    filter cares about are ARCHIVED ones — exactly the rows a board-built map does not contain. It
    would look converted, drop the count, and leave the case it exists for unresolved. The honest fix
    is resolving lanes for the page it fetched: a `fetchTasks` variant returning flags, or a per-task
    resolution over the 50 rows. Data-fetch change, not prop threading.

  DevServerView — CLOSED 2026-07-30-20:30. Was converted on its MainContent surface only, with the
    right-dock `overflowViewRegistry` path still falling back; both surfaces are now covered because
    `OverflowViewRenderProps` carries `columnFlagsByTaskId`. Kept here because the reasoning matters:
    the guard count read 0 for the file the entire time ONE surface was broken.

BATCH CLOSE-OUT — 75 -> 6, and the six are the TRUE number (u12, 2026-07-30-22:40)

This section was rewritten three times as the batch progressed and had gone self-contradictory —
claiming 75 -> 6 in one line, "TWO guards" in the next, and listing files the dock fix had already
closed. Replaced wholesale with the measured final state rather than patched again.

  2  utils/taskRevert.ts             REVERTED to literals — `findOpenUndoTaskForSource`'s only
                                     caller sits ~60 lines above where `detailColumnFlags` is
                                     derived, so it cannot supply them.
  2  utils/taskTiming.ts             REVERTED to literals — both callers reach these from
                                     module-level helpers with no flags in scope.
  1  components/ResearchTaskActionModal.tsx
                                     Fetches its OWN page; a board-built map misses the archived
                                     rows this filter is about. Needs a data-fetch change.
  1  components/TaskCard.tsx         Left counted by an earlier pass on purpose, "so the census
                                     keeps pointing at the class". Not overridden from outside.

WHY THE COUNT WENT UP AT THE END. It read 2 before the seam guard
(`__tests__/resolved-flags-seams-have-suppliers.test.ts`) was added. That guard found FIVE inert
conversions in one tranche of mine — parameters and props that no caller supplied, so the literal was
gone, the census had banked the credit, and the legacy fallback ran forever. Three were wired; three
were reverted to literals because their callers genuinely cannot supply flags.

So 6 is honest and 2 was not. An optional parameter every caller omits is strictly worse than the
literal it replaced.

CLOSED SINCE THE EARLIER DRAFTS: DockTaskList (3) and DevServerView's dock surface, both by the one
registry change; useTasks (1), by deleting a check the line below it already implied.

RESOLVED 2026-07-30-06:20 — the cross-batch coupling is GONE, and my flag of it was wrong

  I previously recorded `useTasks.ts` <-> `core/src/in-review-stall.ts` as a coupling that had to be
  ordered: both keyed on the literal, so no badge was produced and none needed clearing, and
  converting the core gate alone would regress.

  THAT WAS WRONG ON ONE OF THE THREE SIGNALS. `getInReviewStalledSignal` is ALREADY trait-converted
  (U4), so `inReviewStalled` is produced on a renamed board today — and the dashboard literal was
  already refusing to clear it while a review agent wrote logs. A live bug, not a scheduled one.

  Fixed by DELETING the dashboard column check, which the line below it already implies: all three
  stall fields are only ever produced for review-lane cards, because each producer gates on review
  itself. Converting was not an option anyway — it would need a flags map threaded into `useTasks`,
  and that map is built in App FROM the list this hook produces.

  NOTHING IS BLOCKED ON ORDERING ANY MORE. batch-core can convert `getInReviewStallReason` and
  `detectStalledReview` whenever it likes; the dashboard side no longer cares.

ORIGINAL SIZING (kept for the reasoning):



These have NO column flags in scope. Adding an optional `columnFlags` parameter to each and calling
it a conversion would be inert: no caller passes anything, behaviour is unchanged, and the census
drops by seven. That is the half-conversion trap this program has hit repeatedly, so they are sized
here instead of faked.

Each needs its CALLER threaded, which is a per-component change, not a sweep:

  MergeDetails.tsx            complete role   `task.column !== "done"` gates the whole panel
  ChangesDiffModal.tsx        complete role   `const isDone = column === "done"`
  RoutingTab.tsx              wip role        active-task check, same shape as taskActivity's
  TaskPlannerChatTab.tsx      wip role        `const agentRunning = task.column === "in-progress"`
  DevServerView.tsx           wip role        filters worktree-bearing wip cards
  ResearchTaskActionModal.tsx archived role   filters archived out of a picker
  PrPanel.tsx                 hold role       renders one hint string; lowest value of the seven

The cheapest route for most of them is the prop their parent already resolves — `TaskCard` and
`ListView` both hold per-task flags today, and four of these seven render beneath one of those.

MARKED, NOT CONVERTED (census false positive):

  command-center/liveSnapshotMetrics.ts  `isInProgressColumn` matches DISPLAY-NAME aliases
    ("in progress", "doing") for a funnel stage against snapshot labels. No task, no workflow, bare
    string signature. The aliases exist so custom boards do not show zero work — widening them is the
    documented intent, converting them is impossible without inventing a task to resolve.

DONE ON THIS BRANCH BY u12 (working the tail upward, so the largest-first pass does not collide):

  taskActivity.ts 3, worktreeGrouping.ts 3, taskRevert.ts 2, taskTiming.ts 2,
  inReviewStallCopy.ts 1, stalePausedReviewCopy.ts 1, taskStuck.ts 1, useExecutorStats.ts 1



Branch: `batch-dashboard-app`. Feed conversions here as commits; do not open per-file PRs.
Measured at the branch point, `packages/dashboard/app` only (tests excluded).

```text
9  packages/dashboard/app/components/TaskContextMenu.tsx
  7  packages/dashboard/app/components/Column.tsx
  6  packages/dashboard/app/components/ListView.tsx
  4  packages/dashboard/app/components/TaskDetailModal.tsx
  3  packages/dashboard/app/components/DockTaskList.tsx
  3  packages/dashboard/app/components/TaskCard.tsx
  3  packages/dashboard/app/components/TaskChangesTab.tsx
  3  packages/dashboard/app/components/TaskChatTab.tsx
  3  packages/dashboard/app/hooks/useTaskDiffStats.ts
  3  packages/dashboard/app/utils/taskActivity.ts
  3  packages/dashboard/app/utils/worktreeGrouping.ts
  2  packages/dashboard/app/App.tsx
  2  packages/dashboard/app/components/Board.tsx
  2  packages/dashboard/app/components/DocumentsView.tsx
  2  packages/dashboard/app/components/WorkflowResultsTab.tsx
  2  packages/dashboard/app/components/effective-model-resolution.ts
  2  packages/dashboard/app/utils/taskRevert.ts
  2  packages/dashboard/app/utils/taskTiming.ts
  1  packages/dashboard/app/components/ChangesDiffModal.tsx
  1  packages/dashboard/app/components/DevServerView.tsx
  1  packages/dashboard/app/components/MergeDetails.tsx
  1  packages/dashboard/app/components/PrPanel.tsx
  1  packages/dashboard/app/components/ResearchTaskActionModal.tsx
  1  packages/dashboard/app/components/RoutingTab.tsx
  1  packages/dashboard/app/components/TaskPlannerChatTab.tsx
  1  packages/dashboard/app/components/command-center/liveSnapshotMetrics.ts
  1  packages/dashboard/app/hooks/useExecutorStats.ts
  1  packages/dashboard/app/hooks/useTasks.ts
  1  packages/dashboard/app/utils/inReviewStallCopy.ts
  1  packages/dashboard/app/utils/quickAddStart.ts
  1  packages/dashboard/app/utils/stalePausedReviewCopy.ts
  1  packages/dashboard/app/utils/taskStuck.ts
TOTAL 75
```

## Before you convert: the two rules this batch keeps getting wrong

**1. A literal after `??`, or in the `else` of a `flags ?` ternary, is a DEGRADED-MODE answer — not
an unconverted guard.** The trait path above it is already correct; the literal runs when the trait
path has no input. Two states reach it and both are real: the PRE-LOAD WINDOW (the board renders
before the workflows fetch resolves) and a card stranded on an id its workflow no longer declares —
in both, `columnFlagsById` has no entry at all. Deleting the fallback does not remove a decision, it
substitutes "no role" silently, and affordances vanish during first paint.

So those sites reach 0 by MARKING (`DELIBERATE-LITERAL` with the reason), not by deleting. Files in
this list that are mostly role helpers — `TaskContextMenu.tsx`, `columnRoles`-adjacent utils,
`taskActivity.ts` — should be expected to be mostly marks. A "9 -> 0" here that deleted 9 fallbacks
is a regression wearing a green census.

**2. A marker excuses ONLY the construct it is attached to.** Attach it to the statement or function
holding the literal — not to a sibling declaration, and not to the enclosing file comment. This has
now cost three separate passes (including two of mine); my first attempt on `reliability-metrics.ts`
scored 1 of 6. **Verify a marker by the count moving, not by the comment existing** — the ratchet is
gate-blocking now, so a mis-marked batch either wedges the gate or locks the miss into a re-recorded
baseline.

## Per-file census in the PR body

Rule from the brief. Take the number from `node scripts/lifecycle-column-census.mjs` before and
after, per file, and re-record the baseline in the same commit that lowers it.

---
category: architecture-patterns
module: dashboard/app
tags: [lifecycle-columns, census, fleet, batch]
problem_type: work-order
applies_when: converting lifecycle-column literals under packages/dashboard/app
---

# batch-dashboard-app — the work order

## CLAIMED — do not re-convert (u12 worker, 2026-08-01)

TWO WORKERS ARE ON THIS BRANCH. The coordinator assigned this batch to the u12 worker and another
agent opened it; rather than contest ownership we are both feeding it, taking from opposite ends of
the list. One of us should stand down — flagged to the coordinator, unresolved as of this note.

ALREADY CONVERTED IN GREEN PRs, so converting them here duplicates work and will conflict:

  Column.tsx    7 -> 0   PR #2738 (green, mergeable) — also fixes a board-level `workflowMode`
                         flag answering a per-column question, which blanked every affordance on a
                         column the workflow no longer declares
  ListView.tsx  6 -> 0   PR #2738 — same change, plus per-TASK flag resolution for bulk actions

Those are the next two entries in the list below by size. Skip them.

DONE ON THIS BRANCH BY u12 (working the tail upward, so the largest-first pass does not collide):

  taskActivity.ts 3, worktreeGrouping.ts 3, taskRevert.ts 2, taskTiming.ts 2,
  inReviewStallCopy.ts 1, stalePausedReviewCopy.ts 1, taskStuck.ts 1, useExecutorStats.ts 1



Branch: `batch-dashboard-app`. Feed conversions here as commits; do not open per-file PRs.
Measured at the branch point, `packages/dashboard/app` only (tests excluded).

```
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

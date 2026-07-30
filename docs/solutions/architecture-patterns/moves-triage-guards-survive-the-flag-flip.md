---
category: architecture-patterns
module: core/task-store/moves
tags: [workflow-columns, feature-flag, lifecycle-columns, census]
problem_type: false-premise
applies_when: planning the U12 flag resolution, or asserting the lifecycle-column census reaches triage 0
---

# The last four `triage` guards are in the flag-ON branch, not the flag-OFF one

Recorded 2026-07-30 at `origin/main@a6138abeff` (census: 748 guards, triage 4).

## The premise everyone has been carrying

"The four remaining `moves.ts` triage guards die with U12's flag flip, so the bar closes at
triage 0 with no further conversion work."

I said this three turns running. It is wrong, and it is wrong in the direction that matters:
flipping the flag does not delete these guards, it makes them the LIVE path.

## What the code says

`moves.ts` (`moveTaskInternalImpl`):

  - line 364 — `const useWorkflow = isWorkflowColumnsCompatibilityFlagEnabled(...)`
  - line 790 — `if (useWorkflow) {`
  - **line 981 — that block closes**

The four counted guards are at **890, 967, 968, 973** — all inside 790..981, i.e. inside the
flag-**ON** branch:

  - 888-892: `isReopenToTodoOrTriage` — `(fromColumn === "in-progress" | "done" | "in-review")
    && (toColumn === "todo" || toColumn === "triage")`, guarding the reopen side-effects.
  - 966-974: the in-review/done rebound arms that clear `task.branch`.

There is no `else` at 981; the next statement is the unrelated worktree-allocation block. So the
flag-OFF path simply does not run this reopen logic, and deleting the flag-OFF branch wholesale
leaves all four guards in place.

## Consequence for the closing bar

Flipping the flag and deleting the flag-OFF branch leaves the census at **triage 4, not 0**. The
bar needs a decision that nobody has made yet:

  1. CONVERT them — these are reopen/rebound transitions, so the honest question is "is the target
     a pre-implementation lane?", which is a trait read (`intake`/`hold`) rather than two ids. This
     is a real behavior change on the live path once the flag is on, and needs its own test.
  2. MARK them — if the ids are genuinely the right answer for a reopen (they are the legacy
     rebound targets), record why at each site and they move to reviewed.

Either is a slice. Neither is free, and neither happens as a side effect of the flip.

## How the premise survived so long

The census reports FILE and LINE, and `moves.ts` was the file everyone associated with "the flag
branch". Nobody checked which side of the branch the lines fell on — the count told us where the
guards were, not which code path owned them. A per-file count cannot answer "does this die with
that refactor?", and we treated it as though it could.

Verify with brace-depth from the `if (useWorkflow) {` line, not by proximity in the file.

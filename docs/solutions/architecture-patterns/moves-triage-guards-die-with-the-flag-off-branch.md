---
category: architecture-patterns
module: core/task-store/moves
tags: [workflow-columns, feature-flag, lifecycle-columns, census]
problem_type: false-premise
applies_when: planning the U12 flag resolution, or asserting the lifecycle-column census reaches triage 0
---

# The last four `triage` guards are in the flag-OFF branch — and a brace scan will tell you otherwise

Recorded 2026-07-30 at `origin/main@a6138abeff` (census: 748 guards, triage 4).

## The correction, up front

This document originally claimed the opposite. The guards ARE in the flag-OFF branch, they DO die
when U12 deletes it, and the closing bar's assumption was right all along. What follows is kept
because the WAY it went wrong is reusable: the measurement method, not the conclusion, was the
defect.

## The premise everyone has been carrying

"The four remaining `moves.ts` triage guards die with U12's flag flip, so the bar closes at
triage 0 with no further conversion work."

I said this three turns running. It is wrong, and it is wrong in the direction that matters:
flipping the flag does not delete these guards, it makes them the LIVE path.

## What the code says

`moves.ts` (`moveTaskInternalImpl`):

  - line 364 — `const useWorkflow = isWorkflowColumnsCompatibilityFlagEnabled(...)`
  - line 790 — `if (useWorkflow) {`
  - **line 858 — `} else {` — the flag-ON branch ENDS here**
  - line 981 — the ELSE block closes

The four counted guards are at **890, 967, 968, 973** — all AFTER 858, i.e. inside the
flag-**OFF** branch:

  - 888-892: `isReopenToTodoOrTriage` — `(fromColumn === "in-progress" | "done" | "in-review")
    && (toColumn === "todo" || toColumn === "triage")`, guarding the reopen side-effects.
  - 966-974: the in-review/done rebound arms that clear `task.branch`.

CORRECTED 2026-07-31 (PR #2667 review — greptile). This document originally read 790..981 as the
flag-ON branch and concluded the guards SURVIVE the flip. That was wrong, and the error is worth
naming because it is easy to repeat: a naive brace scan from `if (useWorkflow) {` returns 981,
because the `} else {` at 858 is brace-BALANCED — the `}` closes the if-branch and the `{` opens the
else on the same line, so depth never reaches zero there. Scanning for "where does depth hit 0"
therefore measures the whole if/else construct, not the if-branch.

Tracking depth character-by-character and stopping at the first `}` that returns depth to 0 gives
858, and line 858 reads `} else {` followed by the comment "Flag-OFF legacy inline side effects
(UNCHANGED — the flag-off path)". The code says so in words directly above the guards.

So all four guards are in the flag-OFF branch and DO die with it. Deleting that branch when U12
flips the flag removes them, and the closing bar's assumption holds.

## Consequence for the closing bar

None. Flipping the flag and deleting the flag-OFF branch removes all four, taking the census to
**triage 0**. No conversion slice is needed and no decision is outstanding.

That is the opposite of what this document said when it was written, and the reversal is the whole
point of keeping it.

## How the WRONG premise survived a round of review

Two failures stacked, and the second is the interesting one.

First: the census reports FILE and LINE, and `moves.ts` is the file everyone associates with "the
flag branch". A per-file count cannot answer "does this die with that refactor?" — it says where
the guards are, not which code path owns them.

Second, and the reason this document existed at all: checking that question with a brace scan
returns the WRONG answer confidently. `} else {` is brace-balanced, so a scan for "where does depth
return to zero" skips straight past it and reports the end of the ELSE block. The method looks
rigorous, produces a specific line number, and is wrong — which is far more dangerous than an
obvious guess. The correct scan stops at the first `}` that returns depth to zero, which lands on
858.

The tell was in the source the whole time: line 858 carries the comment "Flag-OFF legacy inline
side effects (UNCHANGED — the flag-off path)", directly above the guards. Reading the code beat
measuring it.

Verify with brace-depth from the `if (useWorkflow) {` line, not by proximity in the file.

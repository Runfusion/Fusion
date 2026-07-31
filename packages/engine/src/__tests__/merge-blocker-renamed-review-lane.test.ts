/*
FNXC:WorkflowResolvedColumns 2026-07-30-17:20 (merging was broken outright on a renamed board):

`getTaskMergeBlocker`'s column-identity check RETURNS A BLOCKER when the task's column is not a review
lane. Both merge entry points called it WITHOUT `reviewColumns`, so on a board whose review lane is
renamed the literal check failed and the merge threw:

    Cannot merge FN-1: task is in 'signoff', must be in 'in-review'

That is not a degraded message — no task on such a board could be merged at all. The helper's own
comment records this exact defect being found and fixed in `moves.ts`; these two callers were missed,
which is the same half-conversion shape (outer question resolved, inner one still literal).

WHY THE SEAM, NOT THE MERGE. These cases drive `getTaskMergeBlocker` directly. Reaching it through
`aiMergeTask`/`runAiMerge` needs a real git repo, a worktree and a merge run; the defect is entirely in
which columns the blocker is asked about, so the seam is where it is decidable. The wiring at the two
call sites is covered by the unwired-lane-parameter guard plus tsc.

REVERT CHECK, measured: drop `reviewColumns` from either call and the renamed case reports
`task is in 'signoff', must be in 'in-review'` instead of undefined.
*/
import { describe, expect, it } from "vitest";
import { getTaskMergeBlocker } from "@fusion/core";
import type { Task } from "@fusion/core";

function reviewReadyCard(column: string): Task {
  return {
    id: "FN-MERGE",
    column,
    paused: false,
    status: null,
    error: null,
    steps: [{ id: "s1", status: "done" }],
    workflowStepResults: [],
  } as unknown as Task;
}

describe("the merge blocker judges the board's OWN review lanes", () => {
  it("does not block a merge-ready card sitting in a RENAMED review lane", () => {
    const blocker = getTaskMergeBlocker(reviewReadyCard("signoff"), {
      reviewColumns: new Set(["signoff", "in-review"]),
    });

    expect(blocker).toBeUndefined();
  });

  it("reproduces the shipped failure when the lanes are not supplied", () => {
    /*
    This is exactly what both merge entry points did before the fix, and it is the operator-visible
    string: the merge threw with this as its reason.
    */
    const blocker = getTaskMergeBlocker(reviewReadyCard("signoff"));

    expect(blocker).toBe("task is in 'signoff', must be in 'in-review'");
  });

  it("still blocks a card that is genuinely outside the review lanes", () => {
    /*
    Non-vacuous companion: supplying lanes must not turn the identity check off — a card in the wip
    lane is not merge-ready on any board, and the message names the resolved lanes rather than a
    column the board does not have.
    */
    const blocker = getTaskMergeBlocker(reviewReadyCard("building"), {
      reviewColumns: new Set(["signoff"]),
    });

    expect(blocker).toBe("task is in 'building', must be in 'signoff'");
  });
});

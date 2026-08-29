/*
FNXC:WorkflowResolvedColumns 2026-07-30-18:10 (finalization parked ALREADY-MERGED work as failed):

`project-engine.ts`'s merge-confirmed finalization spread the task's REAL column into
`getTaskHardMergeBlocker` and supplied no `reviewColumns`, so the identity check ran against the literal
`in-review`. On a board whose review lane is renamed it returned

    task is in 'signoff', must be in 'in-review'

and the caller parked the card `failed` with "Merge confirmed but finalization blocked" — for a branch
that had ALREADY LANDED. The worst symptom in this family: the work is merged and the board says it
failed.

The sibling recovery path in `auto-merge-finalization.ts` had already solved this by passing the
review-eligible SENTINEL column rather than the card's own, with the rationale recorded at that site.
This pins the shared contract both paths now rely on.

WHY THE SEAM. Driving `project-engine`'s finalization end to end needs a live engine, a merge run and a
real repo. The defect is entirely in what the blocker is asked, so the helper is where it is decidable —
and the assertion below is the exact string the operator saw in `task.error`.

REVERT CHECK, measured: pass the renamed column instead of the sentinel and the first case fails with
that string.
*/
import { describe, expect, it } from "vitest";
import { getTaskHardMergeBlocker, clearMergeConfirmedTransientStatus } from "@fusion/core";
import type { Task } from "@fusion/core";

/** A merge-confirmed card as finalization sees it: landed, steps done, transient status cleared. */
function mergeConfirmedCard(column: string): Task {
  return {
    id: "FN-LANDED",
    column,
    paused: false,
    status: undefined,
    error: undefined,
    steps: [{ id: "s1", status: "done" }],
    workflowStepResults: [],
  } as unknown as Task;
}

describe("merge-confirmed finalization does not park landed work as failed", () => {
  it("reports no blocker for a landed card evaluated as review-eligible", () => {
    /* What both finalization paths now do: judge the blocker set, not the card's column identity. */
    const blocker = getTaskHardMergeBlocker({ ...mergeConfirmedCard("signoff"), column: "in-review" });

    expect(blocker).toBeUndefined();
  });

  it("reproduces the shipped failure when the card's own renamed column is used", () => {
    /* This string went into `task.error` behind "Merge confirmed but finalization blocked: …". */
    const blocker = getTaskHardMergeBlocker(mergeConfirmedCard("signoff"));

    expect(blocker).toBe("task is in 'signoff', must be in 'in-review'");
  });

  /*
  FNXC:WorkflowMerge 2026-07-30-21:35 (#2964 review — coderabbitai): THE SECOND HALF OF THE SAME BUG.

  The two finalization paths normalized transient status independently and diverged:
  auto-merge-finalization cleared `queued`, project-engine did not. `queued` BLOCKS
  (`SCHEDULER_TRANSIENT_STATUSES`), so a merge-confirmed card the scheduler had queued reached the
  blocker check with it intact and was parked `failed` — already-landed work, same as the column bug,
  one layer down. Asserted through the shared helper both paths now call, so a future third caller
  cannot re-diverge silently.
  */
  it.each(["merging", "merging-pr", "queued"])(
    "clears transient status %s on a merge-confirmed card, so finalization is not blocked",
    (status) => {
      expect(clearMergeConfirmedTransientStatus(status)).toBeUndefined();

      const blocker = getTaskHardMergeBlocker({
        ...mergeConfirmedCard("signoff"),
        column: "in-review",
        status: clearMergeConfirmedTransientStatus(status),
      } as unknown as Task);

      expect(blocker).toBeUndefined();
    },
  );

  it("does NOT clear a genuinely blocking status — the paired negative", () => {
    /* Without this, a helper that returned undefined unconditionally would pass the cases above. */
    expect(clearMergeConfirmedTransientStatus("stuck-killed")).toBe("stuck-killed");

    const blocker = getTaskHardMergeBlocker({
      ...mergeConfirmedCard("signoff"),
      column: "in-review",
      status: clearMergeConfirmedTransientStatus("stuck-killed"),
    } as unknown as Task);

    expect(blocker).toBeDefined();
  });

  it("still reports real blockers on a landed card", () => {
    /*
    Non-vacuous companion: evaluating as review-eligible must not suppress genuine blockers. Incomplete
    steps still block finalization regardless of which lane the card sits in.
    */
    const blocker = getTaskHardMergeBlocker({
      ...mergeConfirmedCard("signoff"),
      column: "in-review",
      steps: [{ id: "s1", status: "in-progress" }],
    } as unknown as Task);

    expect(blocker).toBe("task has incomplete steps");
  });
});

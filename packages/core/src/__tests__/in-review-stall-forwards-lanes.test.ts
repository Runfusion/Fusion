/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:10 (a false-alarm generator, not a silent miss):

`getInReviewStallReason` satisfied its OWN lane check from `context.reviewColumns`, then called
`getTaskMergeBlocker` WITHOUT them. That helper re-ran its column-identity check against the literal
`in-review`, so on a renamed board a perfectly healthy review card came back with

    task is in 'signoff', must be in 'in-review'

which was surfaced as `{ code: "merge-blocker" }` — a stall reason naming a column the board does not
have, for EVERY card in review.

This is the failure mode worth distinguishing from the rest of the family: the others went quiet on a
renamed board, this one shouted. An operator would see every in-review card flagged as stalled, each
citing a lane that does not exist, which is how a signal stops being read at all.

The outer question was resolved and the inner one was not — the same half-conversion the helper's own
comment records for `moves.ts`, and #2963/#2964 fixed for the merge paths.
*/
import { describe, expect, it } from "vitest";
import { getInReviewStallReason } from "../in-review-stall.js";
import { getTaskMergeBlocker } from "../task-merge.js";
import type { Task } from "../types.js";

/** A healthy card sitting in a renamed review lane: nothing wrong with it. */
function healthyReviewCard(column: string): Task {
  return {
    id: "FN-HEALTHY",
    column,
    paused: false,
    status: null,
    error: null,
    steps: [{ id: "s1", status: "done" }],
    workflowStepResults: [],
    worktree: "/tmp/wt",
    mergeDetails: {},
    mergeRetries: 0,
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
}

describe("the stall signal forwards its resolved lanes to the merge blocker", () => {
  it("reports NO stall for a healthy card on a RENAMED review lane", () => {
    const signal = getInReviewStallReason(healthyReviewCard("signoff"), {
      reviewColumns: new Set(["signoff"]),
      now: Date.now(),
    });

    expect(signal).toBeUndefined();
  });

  it("reproduces the shipped false alarm when the lanes are not forwarded", () => {
    /*
    Drives the helper the way the unfixed code did — lanes known to the caller, not passed on. The
    reason string is the operator-visible text, so a regression reports what they would actually see.
    */
    const blocker = getTaskMergeBlocker(healthyReviewCard("signoff"));

    expect(blocker).toBe("task is in 'signoff', must be in 'in-review'");
  });

  it("still reports a genuine stall on a renamed lane", () => {
    /*
    Non-vacuous companion: forwarding lanes must not silence REAL blockers, or the fix would trade a
    wall of false alarms for silence. A failed card in the board's own review lane is genuinely stalled
    and must still be reported.

    Note `paused` is deliberately not the case used here — an earlier guard returns undefined for a
    paused card before the merge blocker is ever consulted, so it would pass whether or not the lanes
    are forwarded. That is the vacuous shape this file exists to avoid.
    */
    const signal = getInReviewStallReason(
      { ...healthyReviewCard("signoff"), status: "failed", error: "merge verification failed" } as Task,
      { reviewColumns: new Set(["signoff"]), now: Date.now() },
    );

    expect(signal?.code).toBe("merge-blocker");
    expect(signal?.reason).toContain("failed");
  });
});

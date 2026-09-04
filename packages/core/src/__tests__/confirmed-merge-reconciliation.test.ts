import { describe, expect, it } from "vitest";
import { getPostMergeFinalizeBlocker, planConfirmedMergeChecklistReconciliation } from "../merge/confirmed-merge-reconciliation.js";

describe("confirmed merge reconciliation", () => {
  it("does not re-run stale review or checklist gates after a confirmed merge", () => {
    expect(getPostMergeFinalizeBlocker({ status: "merging", error: undefined })).toBeUndefined();
    expect(planConfirmedMergeChecklistReconciliation({
      steps: [{ name: "Implementation", status: "pending" }, { name: "Done", status: "done" }],
      workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code Review", status: "pending" }],
    })).toEqual({ skippedStepIndexes: [0], reconciledWorkflowStepIds: ["code-review"] });
  });

  it("does not let a finalizer-inflicted failed status wedge proven-landed work", () => {
    expect(getPostMergeFinalizeBlocker({
      status: "failed",
      error: "Cannot move FN-221 to 'done': Forbidden lifecycle path F3…",
    })).toBeUndefined();
  });

  it("retains independent task blockers", () => {
    expect(getPostMergeFinalizeBlocker({ status: "awaiting-approval", error: "operator action" }))
      .toBe("task is marked 'awaiting-approval': operator action");
  });

  it.each([
    "awaiting-inspection",
    "awaiting-user-review",
    "planning",
    "specifying",
    "needs-replan",
    "mission-validation",
    "stuck-killed",
  ])("keeps the %s post-merge blocker", (status) => {
    expect(getPostMergeFinalizeBlocker({ status, error: undefined }))
      .toBe(`task is marked '${status}'`);
  });
});

/*
FNXC:ConfirmedMergeFinalization 2026-09-01-05:51:
This planner runs on the merge-CONFIRMED fast path — the work has already landed. A row that reaches
it without `steps` (an older row, a partial projection) used to throw "Cannot read properties of
undefined (reading 'map')", which the merge loop's catch absorbed, so the landed task simply never
finalized and never emitted task:merged. Asserting the type does not make the row real.
*/
describe("planConfirmedMergeChecklistReconciliation with an incomplete row", () => {
  it("does not throw when the row carries no steps, so a landed merge still finalizes", () => {
    expect(() =>
      planConfirmedMergeChecklistReconciliation({ workflowStepResults: [] } as never),
    ).not.toThrow();
    expect(
      planConfirmedMergeChecklistReconciliation({ workflowStepResults: [] } as never),
    ).toEqual({ skippedStepIndexes: [], reconciledWorkflowStepIds: [] });
  });

  it("still reconciles pending workflow step results when steps are absent", () => {
    expect(
      planConfirmedMergeChecklistReconciliation({
        workflowStepResults: [{ workflowStepId: "code-review", status: "pending" }],
      } as never),
    ).toEqual({ skippedStepIndexes: [], reconciledWorkflowStepIds: ["code-review"] });
  });
});

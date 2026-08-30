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

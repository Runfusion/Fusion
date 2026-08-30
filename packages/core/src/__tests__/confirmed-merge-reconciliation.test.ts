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

  it("retains independent task blockers", () => {
    expect(getPostMergeFinalizeBlocker({ status: "awaiting-approval", error: "operator action" }))
      .toBe("task is marked 'awaiting-approval': operator action");
  });
});

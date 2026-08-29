import { describe, expect, it, vi } from "vitest";

vi.mock("../execution/reviewer.js", () => ({
  reviewStep: vi.fn(),
}));

import { reviewStep } from "../execution/reviewer.js";
import { runReviewArbitration } from "../executor/review-arbitration.js";

function failedTask() {
  return {
    id: "FN-149", title: "Review convergence", description: "", column: "in-review", dependencies: [], steps: [], currentStep: 0,
    log: [], prompt: "# Task", worktree: "/tmp/review", createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
    workflowStepResults: [{
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", source: "optional-group", status: "failed", reviewKind: "code",
      verdict: "REVISE", reviewInputFingerprint: "first", startedAt: "2026-08-22T00:00:00.000Z", completedAt: "2026-08-22T00:01:00.000Z",
      findings: [{ id: "finding-1", title: "Needs change", body: "Fix it", disputedAt: "2026-08-22T00:01:00.000Z" }],
    }],
  };
}

/*
FNXC:ReviewConvergence 2026-08-22-06:06:
FN-149 fences every arbitration disposition, not only an implementer release. A review-upheld
arbiter response for a replaced attempt is stale evidence and must not schedule a bounce that
injects obligations from the review it never examined.
*/
describe("review arbitration fence", () => {
  it("declines a stale uphold ruling without dispatching remediation", async () => {
    const task = failedTask();
    vi.mocked(reviewStep).mockResolvedValue({
      review: '{"decision":"UPHOLD_REVIEW","notes":"keep fixing","bindingFindingIds":["finding-1"]}',
    });
    const sendTaskBackForFix = vi.fn();
    const store = {
      getSettings: vi.fn(async () => ({ reviewArbitrationEnabled: true })),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        task.workflowStepResults[0] = {
          ...task.workflowStepResults[0],
          completedAt: "2026-08-22T00:02:00.000Z",
          reviewInputFingerprint: "newer",
        };
        const patch = await callback(task);
        if (patch) Object.assign(task, patch);
        return task;
      }),
    };

    await expect(runReviewArbitration({ store, getRunContextFor: () => undefined, sendTaskBackForFix }, task, "code-review", "Code Review", "feedback", 2, 3)).resolves.toBe("declined");
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(task.workflowStepResults[0]).toMatchObject({ completedAt: "2026-08-22T00:02:00.000Z", reviewInputFingerprint: "newer" });
  });
});

import { describe, expect, it, vi } from "vitest";

import { WorkflowReviewService } from "../workflows/workflow-review-service.js";

describe("WorkflowReviewService", () => {
  it("forwards single-cwd step review input through the injected invoker", async () => {
    const invoke = vi.fn(async () => ({
      verdict: "APPROVE" as const,
      review: "looks good",
      summary: "approved",
    }));
    const service = new WorkflowReviewService(invoke);
    const input = {
      cwd: "/tmp/worktree",
      taskId: "FN-7302",
      stepIndex: 1,
      stepName: "Implement",
      type: "code" as const,
      promptContent: "# Task",
      baselineSha: "abc123",
    };

    const result = await service.reviewStep(input);

    expect(result.verdict).toBe("APPROVE");
    expect(invoke).toHaveBeenCalledWith(input);
  });
});

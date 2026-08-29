import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { getTaskMergeBlocker } from "@fusion/core";

/*
 * FNXC:MergeGateSingleAuthority 2026-08-23-09:15:
 * FN-180 requires periodic queue admission and landing to share the positive pre-merge gate.
 * A resultless enabled Code Review is therefore a deferral before a merger can be enqueued.
 */
describe("FN-180 merge gate single authority", () => {
  it("refuses the FN-175 resultless Code Review shape before queue admission", () => {
    const task = {
      id: "FN-180", column: "in-review", steps: [{ name: "implementation", status: "done" }],
      enabledWorkflowSteps: ["plan-review", "code-review"],
      workflowStepResults: [{ workflowStepId: "plan-review", status: "passed", verdict: "APPROVE" }],
    } as unknown as Task;
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: new Set(["plan-review", "code-review"]) })).toMatch(/never ran/);
  });

  it("routes ProjectEngine admission through its shared canMergeTask gate", async () => {
    const source = await (await import("node:fs/promises")).readFile(
      new URL("../project-engine.ts", import.meta.url), "utf8",
    );
    expect(source).toContain("private canMergeTask");
    expect(source).toContain("isTaskExecutionLive");
    expect((source.match(/this\.canMergeTask\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

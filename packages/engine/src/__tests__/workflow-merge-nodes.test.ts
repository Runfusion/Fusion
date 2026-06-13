import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { classifyMergePrimitiveResult, runWorkflowMergeAttemptNode } from "../workflow-merge-nodes.js";
import type { WorkflowPrimitiveContext } from "../runtime-primitives.js";

const task = { id: "FN-MERGE" } as TaskDetail;
const ctx: WorkflowPrimitiveContext = {
  run: { runId: "run-1", taskId: task.id, workflowId: "builtin:coding" },
  node: { node: { id: "merge-attempt", kind: "merge-attempt" } },
};

describe("workflow merge nodes", () => {
  it("classifies guarded merge primitive results into workflow outcomes", () => {
    expect(classifyMergePrimitiveResult({ status: "merged" }, undefined, "success")).toEqual({
      outcome: "success",
      value: "merged",
    });
    expect(classifyMergePrimitiveResult({ status: "merged", noOp: true }, undefined, "success")).toEqual({
      outcome: "success",
      value: "already-landed",
    });
    expect(classifyMergePrimitiveResult({ status: "manual-required", reason: "conflict" }, undefined, "failure")).toEqual({
      outcome: "success",
      value: "manual-required",
    });
    expect(classifyMergePrimitiveResult({ status: "timeout" }, undefined, "failure")).toEqual({
      outcome: "success",
      value: "transient-failure",
    });
    expect(classifyMergePrimitiveResult({ status: "failed", reason: "File scope violation" }, undefined, "failure")).toEqual({
      outcome: "failure",
      value: "file-scope-violation",
    });
    expect(classifyMergePrimitiveResult({ status: "merged-requested" }, undefined, "failure")).toEqual({
      outcome: "success",
      value: "merged-requested",
    });
    expect(classifyMergePrimitiveResult({ status: "stale-head" }, undefined, "failure")).toEqual({
      outcome: "failure",
      value: "stale-head",
    });
    expect(classifyMergePrimitiveResult(undefined, "transient-failure", "failure")).toEqual({
      outcome: "success",
      value: "transient-failure",
    });
    expect(classifyMergePrimitiveResult(undefined, "merged-requested", "failure")).toEqual({
      outcome: "success",
      value: "merged-requested",
    });
  });

  it("runs the existing merge primitive and emits a workflow capability audit event", async () => {
    const audit = vi.fn();
    const requestMerge = vi.fn().mockResolvedValue({
      outcome: "success",
      data: { status: "merged" },
      contextPatch: { mergedBranch: "main" },
    });

    const result = await runWorkflowMergeAttemptNode({ primitives: { requestMerge, audit } }, ctx, task);

    expect(requestMerge).toHaveBeenCalledWith(ctx, task);
    expect(audit).toHaveBeenCalledWith(ctx, expect.objectContaining({
      type: "workflow-merge-node",
      metadata: expect.objectContaining({ taskId: task.id, primitiveOutcome: "success" }),
    }));
    expect(result).toEqual({
      outcome: "success",
      value: "merged",
      contextPatch: { mergedBranch: "main", "workflow:merge-status": "merged" },
    });
  });

  it("does not retry the merge primitive when audit fails after classification", async () => {
    const audit = vi.fn().mockRejectedValue(new Error("audit unavailable"));
    const requestMerge = vi.fn().mockResolvedValue({
      outcome: "success",
      data: { status: "merged" },
    });

    const result = await runWorkflowMergeAttemptNode({ primitives: { requestMerge, audit } }, ctx, task);

    expect(requestMerge).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      outcome: "success",
      value: "merged",
      contextPatch: { "workflow:merge-status": "merged" },
    });
  });
});

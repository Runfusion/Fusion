import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflow-graph-executor.js";

const task = { id: "FN-6051" } as TaskDetail;

function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } };
}

describe("WorkflowGraphExecutor built-in coding workflow retries", () => {
  it("retries the execute node on exception then succeeds", async () => {
    let executeCalls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
      if (node.id === "execute") {
        executeCalls += 1;
        if (executeCalls === 1) throw new Error("transient execute failure");
      }
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("success");
    expect(executeCalls).toBe(2);
    expect(result.context["node:execute:outcome"]).toBe("success");
    // U6: the legacy `workflow-step` seam is gone; the pre-merge browser-verification
    // optional-group is bypassed here (task has no enabledWorkflowSteps), so its
    // group node is visited but its template body is not.
    expect(result.visitedNodeIds).toEqual(
      expect.arrayContaining(["execute", "browser-verification", "review", "merge"]),
    );
    expect(result.visitedNodeIds).not.toContain("workflow-step");
    expect(result.visitedNodeIds).not.toContain("browser-verification::browser-verification-step");
  });

  it("exhausts execute node retries and routes failure to end", async () => {
    let executeCalls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
      if (node.id === "execute") {
        executeCalls += 1;
        throw new Error("persistent execute failure");
      }
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    expect(executeCalls).toBe(2);
    expect(result.context["node:execute:outcome"]).toBe("failure");
    expect(result.context["node:execute:value"]).toBe("exception");
    expect(result.context["node:execute:error"]).toBe("persistent execute failure");
    expect(result.outcome).toBe("failure");
    expect(BUILTIN_CODING_WORKFLOW_IR.edges).toContainEqual({ from: "execute", to: "end", condition: "failure" });
    expect(result.visitedNodeIds).toEqual(["start", "planning", "execute"]);
    expect(result.visitedNodeIds).not.toContain("browser-verification");
  });

  it("does not retry when the execute node returns a clean failure outcome", async () => {
    let executeCalls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
      if (node.id === "execute") {
        executeCalls += 1;
        return { outcome: "failure", value: "clean-failure" };
      }
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    expect(executeCalls).toBe(1);
    expect(result.context["node:execute:outcome"]).toBe("failure");
    expect(result.context["node:execute:value"]).toBe("clean-failure");
    expect(result.context["node:execute:error"]).toBeUndefined();
    expect(result.outcome).toBe("failure");
    expect(BUILTIN_CODING_WORKFLOW_IR.edges).toContainEqual({ from: "execute", to: "end", condition: "failure" });
    expect(result.visitedNodeIds).toEqual(["start", "planning", "execute"]);
  });

  it("uses the executor default retry count for a review node without maxRetries config", async () => {
    let reviewCalls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) => {
      if (node.id === "review") {
        reviewCalls += 1;
        throw new Error("review seam failed");
      }
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settingsOn(), BUILTIN_CODING_WORKFLOW_IR);

    expect(reviewCalls).toBe(2);
    expect(result.context["node:review:outcome"]).toBe("failure");
    expect(result.context["node:review:value"]).toBe("exception");
    expect(result.context["node:review:error"]).toBe("review seam failed");
    expect(result.outcome).toBe("failure");
    // U6: with browser-verification disabled (bypassed), the group node sits
    // between execute and review where the workflow-step seam used to.
    expect(result.visitedNodeIds).toEqual(["start", "planning", "execute", "browser-verification", "review"]);
  });

  it("respects a per-node maxRetries override", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "custom-retry-override",
      nodes: [
        { id: "start", kind: "start" },
        { id: "custom", kind: "prompt", config: { maxRetries: 4 } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "custom" },
        { from: "custom", to: "end", condition: "success" },
      ],
    };
    let calls = 0;
    const prompt = vi.fn<WorkflowNodeHandler>(async () => {
      calls += 1;
      if (calls < 4) throw new Error(`temporary failure ${calls}`);
      return { outcome: "success" };
    });
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      maxRetriesPerNode: 2,
    });

    const result = await executor.run(task, settingsOn(), ir);

    expect(calls).toBe(4);
    expect(result.outcome).toBe("success");
    expect(result.context["node:custom:outcome"]).toBe("success");
    expect(result.context["node:custom:error"]).toBeUndefined();
  });
});

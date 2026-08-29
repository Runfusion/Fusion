import { describe, expect, it, vi } from "vitest";
import type { Settings, TaskDetail, WorkflowColumnAgent, WorkflowIrNode } from "@fusion/core";

import { WorkflowCustomNodeExecutionService } from "../workflows/workflow-custom-node-execution.js";

describe("WorkflowCustomNodeExecutionService", () => {
  it("adapts a custom-node executor into the graph runner contract with column binding", async () => {
    const binding = { agentId: "agent-reviewer", mode: "override" } as WorkflowColumnAgent;
    const execute = vi.fn(async () => ({ outcome: "success" as const, value: "ran" }));
    const service = new WorkflowCustomNodeExecutionService({
      execute,
      resolveColumnBinding: (nodeId) => (nodeId === "review-node" ? binding : undefined),
    });
    const settings = { experimentalFeatures: { workflowGraphExecutor: true } } as Settings;
    const node = { id: "review-node", kind: "prompt", config: { prompt: "review" } } as WorkflowIrNode;
    const task = { id: "FN-7301" } as TaskDetail;
    const context = { "workflow:optionalGroupActive": "review-node" };

    const result = await service.runner(settings)(node, task, context);

    expect(result).toEqual({ outcome: "success", value: "ran" });
    expect(execute).toHaveBeenCalledWith(node, task, settings, binding, context);
  });
});

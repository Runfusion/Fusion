// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_EXTENSION_SCHEMA_VERSION,
  __resetWorkflowExtensionRegistryForTests,
  getWorkflowExtensionRegistry,
  workflowExtensionRegistryId,
  type TaskDetail,
  type WorkflowIr,
} from "@fusion/core";
import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";

const settingsOn = { experimentalFeatures: { workflowGraphExecutor: true } };

describe("workflow node-handler extensions", () => {
  afterEach(() => {
    __resetWorkflowExtensionRegistryForTests();
  });

  it("executes an extension-marked node and routes custom outcomes", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    const handle = vi.fn().mockResolvedValue({
      outcome: "outcome:needs-human",
      contextPatch: { decidedBy: "plugin" },
    });
    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      handle,
    });
    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", extensions: { [extensionKey]: {} } },
        { id: "human", kind: "prompt", column: "work", config: { prompt: "human" } },
        { id: "default", kind: "end" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "human", condition: "outcome:needs-human" },
        { from: "decide", to: "default", condition: "success" },
        { from: "human", to: "end" },
      ],
    };
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toEqual(["start", "decide", "human"]);
    expect(result.context).toMatchObject({ decidedBy: "plugin" });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      node: expect.objectContaining({ id: "decide" }),
      workflow,
    }));
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ id: "human" }), expect.any(Object));
  });

  it("preserves plugin-provided values for custom outcomes", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "failClosed",
      handle: vi.fn().mockResolvedValue({
        outcome: "outcome:ignored-route",
        value: "needs-human",
      }),
    });
    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", extensions: { [extensionKey]: {} } },
        { id: "human", kind: "prompt", column: "work", config: { prompt: "human" } },
        { id: "default", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "human", condition: "outcome:needs-human" },
        { from: "decide", to: "default", condition: "outcome:ignored-route" },
      ],
    };
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toEqual(["start", "decide", "human"]);
  });

  it("degrades faulty node handlers before falling through to default handler", async () => {
    const extensionKey = workflowExtensionRegistryId("node-plugin", "decision");
    getWorkflowExtensionRegistry().register("node-plugin", {
      extensionId: "decision",
      name: "Decision",
      kind: "node-handler",
      nodeKind: "prompt",
      schemaVersion: WORKFLOW_EXTENSION_SCHEMA_VERSION,
      fallback: "degradeToDefault",
      handle: vi.fn().mockRejectedValue(new Error("handler failed")),
    });
    const workflow: WorkflowIr = {
      version: "v2",
      name: "node-extension",
      columns: [{ id: "work", name: "Work", traits: [] }],
      nodes: [
        { id: "start", kind: "start" },
        { id: "decide", kind: "prompt", column: "work", extensions: { [extensionKey]: {} } },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "decide" },
        { from: "decide", to: "end" },
      ],
    };
    const prompt = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run({ id: "FN-NODE" } as TaskDetail, settingsOn, workflow);

    expect(result.outcome).toBe("success");
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ id: "decide" }), expect.any(Object));
    expect(getWorkflowExtensionRegistry().get(extensionKey)?.degraded).toMatchObject({
      reason: "runtime-fault",
      message: "handler failed",
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { NotificationPayload, TaskDetail, WorkflowIr, WorkflowIrNode } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";
import { createDefaultNodeHandlers, createNoopLegacySeams } from "../workflows/workflow-node-handlers.js";
import type { WorkflowNodeExecutionContext } from "../workflows/workflow-graph-executor.js";

const notifyNode: WorkflowIrNode = {
  id: "notify",
  kind: "notify",
  column: "todo",
  config: {
    event: "workflow-notify",
    title: "{{taskTitle}} in {{workflowName}}",
    message: "Task {{taskId}} hit {{context:stage}} with {{context:object}}",
  },
};

function ctx(overrides: Partial<WorkflowNodeExecutionContext> = {}): WorkflowNodeExecutionContext {
  return {
    task: {
      id: "FN-6031",
      title: "Notify task",
      description: "Task body",
    } as TaskDetail,
    settings: undefined,
    context: {
      "workflow:id": "Custom Workflow",
      stage: "review",
      object: { ok: true },
    },
    ...overrides,
  };
}

describe("workflow notify node handler", () => {
  it("dispatches an interpolated notification payload", async () => {
    const dispatch = vi.fn(async () => undefined);
    const handlers = createDefaultNodeHandlers(createNoopLegacySeams(), undefined, {
      notifyDispatch: dispatch,
    });

    const result = await handlers.notify(notifyNode, ctx());

    expect(result).toEqual({ outcome: "success" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      "workflow-notify",
      expect.objectContaining({
        taskId: "FN-6031",
        taskTitle: "Notify task",
        taskDescription: "Task body",
        event: "workflow-notify",
        metadata: expect.objectContaining({
          nodeId: "notify",
          workflowName: "Custom Workflow",
          title: "Notify task in Custom Workflow",
          message: 'Task FN-6031 hit review with {"ok":true}',
        }),
      } satisfies Partial<NotificationPayload>),
    );
  });

  it("skips successfully when dispatch is unwired", async () => {
    const handlers = createDefaultNodeHandlers(createNoopLegacySeams(), undefined, {});

    await expect(handlers.notify(notifyNode, ctx())).resolves.toEqual({
      outcome: "success",
      value: "notify-skipped",
    });
  });

  it("handles missing config gracefully", async () => {
    const dispatch = vi.fn(async () => undefined);
    const handlers = createDefaultNodeHandlers(createNoopLegacySeams(), undefined, {
      notifyDispatch: dispatch,
    });

    await expect(handlers.notify({ id: "notify", kind: "notify" } as WorkflowIrNode, ctx())).resolves.toEqual({
      outcome: "success",
      value: "notify-skipped",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not fail the node when dispatch throws", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("provider down");
    });
    const handlers = createDefaultNodeHandlers(createNoopLegacySeams(), undefined, {
      notifyDispatch: dispatch,
    });

    await expect(handlers.notify(notifyNode, ctx())).resolves.toEqual({ outcome: "success" });
  });

  it("is wired into the graph executor default handlers", async () => {
    const dispatch = vi.fn(async () => undefined);
    const ir: WorkflowIr = {
      version: "v2",
      name: "Notify Workflow",
      columns: [{ id: "todo", name: "Todo", traits: [] }],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        { id: "notify", kind: "notify", column: "todo", config: { event: "custom-event", message: "{{workflowName}}" } },
        { id: "end", kind: "end", column: "todo" },
      ],
      edges: [
        { from: "start", to: "notify" },
        { from: "notify", to: "end" },
      ],
    };
    const executor = new WorkflowGraphExecutor({ notifyDispatch: dispatch });

    const result = await executor.run(
      { id: "FN-6031", description: "body" } as TaskDetail,
      { experimentalFeatures: { workflowGraphExecutor: true } },
      ir,
    );

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toEqual(["start", "notify"]);
    expect(dispatch).toHaveBeenCalledWith(
      "custom-event",
      expect.objectContaining({
        taskTitle: "FN-6031",
        metadata: expect.objectContaining({ message: "Notify Workflow" }),
      }),
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowIrNode } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import {
  WorkflowNodeRunnerRegistry,
  handlerBackedRunner,
  type WorkflowNodeRunner,
} from "../workflow-node-runner.js";

const task = { id: "FN-7300" } as TaskDetail;

function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } };
}

function linearIr(node: WorkflowIrNode): WorkflowIr {
  return {
    version: "v1",
    name: "runner-linear",
    nodes: [
      { id: "start", kind: "start" },
      node,
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: node.id },
      { from: node.id, to: "end", condition: "success" },
    ],
  };
}

describe("WorkflowNodeRunnerRegistry", () => {
  it("adapts a registered runner into graph execution", async () => {
    const run = vi.fn(async () => ({ outcome: "success" as const, value: "sent" }));
    const registry = new WorkflowNodeRunnerRegistry({
      runners: [{
        kind: "notify",
        run,
      } satisfies WorkflowNodeRunner],
    });

    const notifyNode: WorkflowIrNode = { id: "notify-team", kind: "notify" };
    const executor = new WorkflowGraphExecutor({ runnerRegistry: registry });
    const result = await executor.run(task, settingsOn(), linearIr(notifyNode));

    expect(result.outcome).toBe("success");
    expect(run).toHaveBeenCalledWith(
      notifyNode,
      expect.objectContaining({
        task,
        context: expect.any(Object),
      }),
    );
  });

  it("lets explicit handler overrides win over registered runners", async () => {
    const runner = vi.fn(async () => ({ outcome: "success" as const, value: "runner" }));
    const handler = vi.fn(async () => ({ outcome: "failure" as const, value: "handler" }));
    const registry = new WorkflowNodeRunnerRegistry({
      runners: [{
        kind: "prompt",
        run: runner,
      } satisfies WorkflowNodeRunner],
    });

    const executor = new WorkflowGraphExecutor({
      runnerRegistry: registry,
      handlers: { prompt: handler },
    });
    const result = await executor.run(task, settingsOn(), linearIr({ id: "p", kind: "prompt" }));

    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).toEqual(["start", "p"]);
    expect(handler).toHaveBeenCalledOnce();
    expect(runner).not.toHaveBeenCalled();
  });

  it("preserves default fail-closed behavior when no runner dependency is registered", async () => {
    const registry = new WorkflowNodeRunnerRegistry();
    const executor = new WorkflowGraphExecutor({ runnerRegistry: registry });
    const result = await executor.run(task, settingsOn(), linearIr({ id: "parse", kind: "parse-steps" }));

    expect(result).toMatchObject({
      outcome: "failure",
      visitedNodeIds: ["start", "parse"],
    });
    expect(result.context["node:parse:value"]).toBe("parse-steps-unwired");
  });

  it("adapts existing handlers into runners for migration compatibility", async () => {
    const handler = vi.fn(async () => ({ outcome: "success" as const, value: "handler-backed" }));
    const registry = new WorkflowNodeRunnerRegistry({
      runners: [handlerBackedRunner("script", handler)],
    });
    const scriptNode: WorkflowIrNode = { id: "script", kind: "script" };

    const executor = new WorkflowGraphExecutor({ runnerRegistry: registry });
    const result = await executor.run(task, settingsOn(), linearIr(scriptNode));

    expect(result.outcome).toBe("success");
    expect(result.context["node:script:value"]).toBe("handler-backed");
    expect(handler).toHaveBeenCalledWith(scriptNode, expect.objectContaining({ task }));
  });
});

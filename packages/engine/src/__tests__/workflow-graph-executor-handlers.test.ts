import { describe, expect, it, vi } from "vitest";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

const task = { id: "FN-5767" } as TaskDetail;

function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } };
}

describe("WorkflowGraphExecutor traversal", () => {
  it("walks linear graph", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "linear",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };
    const handler = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: handler } });

    const result = await executor.run(task, settingsOn(), ir);
    expect(result.outcome).toBe("success");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("routes failure edges", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "failure-route",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "b", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b", condition: "failure" },
        { from: "b", to: "end", condition: "success" },
      ],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({ outcome: "failure" }),
        script: async () => ({ outcome: "success" }),
      },
    });

    const result = await executor.run(task, settingsOn(), ir);
    expect(result.visitedNodeIds).toContain("b");
  });

  it("supports outcome:value conditions", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "outcome-value",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "left", kind: "script" },
        { id: "right", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "left", condition: "outcome:left" },
        { from: "a", to: "right", condition: "outcome:right" },
        { from: "left", to: "end" },
        { from: "right", to: "end" },
      ],
    };
    const script = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({ outcome: "success", value: "right" }),
        script,
      },
    });

    const result = await executor.run(task, settingsOn(), ir);
    expect(result.visitedNodeIds).toContain("right");
    expect(result.visitedNodeIds).not.toContain("left");
  });

  it("leaves outcome unchanged when outcome:value does not match any edge", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "outcome-miss",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "left", kind: "script" },
        { id: "right", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "left", condition: "outcome:left" },
        { from: "a", to: "right", condition: "outcome:right" },
      ],
    };

    const executor = new WorkflowGraphExecutor({ handlers: { prompt: async () => ({ outcome: "success", value: "miss" }) } });
    const result = await executor.run(task, settingsOn(), ir);
    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).not.toContain("left");
    expect(result.visitedNodeIds).not.toContain("right");
  });

  it("publishes workflow node task projections for dispatcher and UI", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "projection",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };
    const publishTaskProjection = vi.fn();
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          contextPatch: {
            touchedFiles: ["./packages/engine/src/workflow-graph-executor.ts", "packages\\core\\src\\store.ts"],
            filesChanged: 2,
            summary: "workflow published task metadata",
          },
        }),
      },
      publishTaskProjection,
    });

    await executor.run(task, settingsOn(), ir);

    expect(publishTaskProjection).toHaveBeenCalledWith(
      task.id,
      {
        modifiedFiles: ["packages/core/src/store.ts", "packages/engine/src/workflow-graph-executor.ts"],
        mergeDetails: { filesChanged: 2 },
        summary: "workflow published task metadata",
      },
      { nodeId: "a", nodeKind: "prompt" },
    );
  });

  it("keeps projection writes to safe task metadata fields", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "safe-projection",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };
    const publishTaskProjection = vi.fn();
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          contextPatch: {
            modifiedFiles: ["src/index.ts"],
            mergeDetails: {
              commitSha: "engine-owned",
              mergeConfirmed: true,
              filesChanged: 3,
              insertions: 12.8,
              deletions: 1,
            },
            status: "done",
            error: "bypass",
            review: {},
            reviewState: {},
            workflowStepResults: [{}],
            tokenUsage: {},
          },
        }),
      },
      publishTaskProjection,
    });

    await executor.run(task, settingsOn(), ir);

    expect(publishTaskProjection).toHaveBeenCalledWith(
      task.id,
      {
        modifiedFiles: ["src/index.ts"],
        mergeDetails: { filesChanged: 3, insertions: 12, deletions: 1 },
      },
      { nodeId: "a", nodeKind: "prompt" },
    );
  });

  it("publishes projections from loop template nodes", async () => {
    const ir: WorkflowIr = {
      version: "v2",
      name: "loop-projection",
      columns: [
        { id: "todo", name: "Todo", traits: [] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "todo" },
        {
          id: "loop",
          kind: "loop",
          column: "todo",
          config: {
            maxIterations: 1,
            exitWhen: { type: "output-contains", value: "done" },
            template: {
              nodes: [{ id: "inner", kind: "prompt" }],
              edges: [],
            },
          },
        },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "loop" },
        { from: "loop", to: "end", condition: "success" },
      ],
    };
    const publishTaskProjection = vi.fn();
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          value: "done",
          contextPatch: { modifiedFiles: ["src/from-loop.ts"] },
        }),
      },
      publishTaskProjection,
    });

    await executor.run(task, settingsOn(), ir);

    expect(publishTaskProjection).toHaveBeenCalledWith(
      task.id,
      { modifiedFiles: ["src/from-loop.ts"] },
      { nodeId: "inner", nodeKind: "prompt" },
    );
  });

  it("does not retry an already-executed node when projection publishing fails", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "projection-failure",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "failure" },
      ],
    };
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      contextPatch: { modifiedFiles: ["src/once.ts"] },
    }));
    const publishTaskProjection = vi.fn(async () => {
      throw new Error("store unavailable");
    });
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      maxRetriesPerNode: 3,
      publishTaskProjection,
    });

    const result = await executor.run(task, settingsOn(), ir);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(publishTaskProjection).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("failure");
    expect(result.context["node:a:projectionError"]).toBe("store unavailable");
  });

  it("does not fail the node when the deprecated touched-files hook fails", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "legacy-touched-files-failure",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "success" },
      ],
    };
    const publishTaskProjection = vi.fn();
    const publishTouchedFiles = vi.fn(async () => {
      throw new Error("legacy sink unavailable");
    });
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({
          outcome: "success",
          contextPatch: { modifiedFiles: ["src/projected.ts"] },
        }),
      },
      publishTaskProjection,
      publishTouchedFiles,
    });

    const result = await executor.run(task, settingsOn(), ir);

    expect(publishTaskProjection).toHaveBeenCalledTimes(1);
    expect(publishTouchedFiles).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("success");
    expect(result.context["node:a:projectionError"]).toBeUndefined();
  });

  it("caps retries and converts exceptions to failure", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "retry",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "end", condition: "failure" },
      ],
    };
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: handler }, maxRetriesPerNode: 3 });

    const result = await executor.run(task, settingsOn(), ir);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(result.outcome).toBe("failure");
  });

  it("fan-out executes deterministic sorted order", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "fanout",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "b", kind: "script" },
        { id: "c", kind: "script" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "c" },
        { from: "a", to: "b" },
        { from: "b", to: "end" },
        { from: "c", to: "end" },
      ],
    };
    const order: string[] = [];
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => ({ outcome: "success" }),
        script: async (node) => {
          order.push(node.id);
          return { outcome: "success" };
        },
      },
    });
    await executor.run(task, settingsOn(), ir);
    expect(order).toEqual(["b", "c"]);
  });

  it("builtin coding workflow ir exposes expected lifecycle and merge-policy nodes", () => {
    expect(BUILTIN_CODING_WORKFLOW_IR.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        "start",
        "execute",
        "review",
        "merge-gate",
        "branch-group-member-integration",
        "branch-group-promotion",
        "merge-attempt",
        "end",
      ]),
    );
  });

  it("rejects malformed cyclic graphs", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "cycle",
      nodes: [
        { id: "start", kind: "start" },
        { id: "a", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "a" },
      ],
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: async () => ({ outcome: "success" }) } });

    await expect(executor.run(task, settingsOn(), ir)).rejects.toThrow("Cycle detected");
  });

  // FN-7579: ask-user (chat reach-out) + exit-gate (early termination) end-to-end
  // through the real registered handlers (no override), using deps.runCustomNode
  // exactly as the ask-user node is dispatched in production.
  describe("ask-user / exit-gate (FN-7579)", () => {
    it("ask-user node parks the task awaiting-user-input via the custom-node runner", async () => {
      const ir: WorkflowIr = {
        version: "v1",
        name: "ask-user",
        nodes: [
          { id: "start", kind: "start" },
          { id: "ask", kind: "ask-user", config: { question: "Looks good?" } },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "ask" },
          { from: "ask", to: "end", condition: "success" },
        ],
      };
      const runCustomNode = vi.fn(async () => ({ outcome: "failure" as const, value: "awaiting-user-input" }));
      const executor = new WorkflowGraphExecutor({ runCustomNode });

      const result = await executor.run(task, settingsOn(), ir);
      expect(runCustomNode).toHaveBeenCalledOnce();
      expect(runCustomNode.mock.calls[0][0]).toMatchObject({ id: "ask", kind: "ask-user" });
      expect(result.outcome).toBe("failure");
      expect(result.visitedNodeIds).not.toContain("end");
    });

    it("unconditional exit-gate terminates early, skipping downstream nodes", async () => {
      const ir: WorkflowIr = {
        version: "v1",
        name: "exit-gate-unconditional",
        nodes: [
          { id: "start", kind: "start" },
          { id: "exit", kind: "exit-gate" },
          { id: "never", kind: "prompt" },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "exit" },
          { from: "exit", to: "end", condition: "outcome:exit" },
          { from: "exit", to: "never", condition: "outcome:continue" },
        ],
      };
      const never = vi.fn(async () => ({ outcome: "success" as const }));
      const executor = new WorkflowGraphExecutor({ handlers: { prompt: never } });

      const result = await executor.run(task, settingsOn(), ir);
      expect(never).not.toHaveBeenCalled();
      expect(result.outcome).toBe("success");
      expect(result.visitedNodeIds).toContain("exit");
      expect(result.visitedNodeIds).not.toContain("never");
    });

    it("conditional exit-gate falls through to the next node when the condition does not match", async () => {
      const ir: WorkflowIr = {
        version: "v1",
        name: "exit-gate-conditional",
        nodes: [
          { id: "start", kind: "start" },
          { id: "exit", kind: "exit-gate", config: { condition: { type: "output-contains", nodeId: "ask", value: "looks good" } } },
          { id: "refine", kind: "prompt" },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "exit" },
          { from: "exit", to: "end", condition: "outcome:exit" },
          { from: "exit", to: "refine", condition: "outcome:continue" },
        ],
      };
      const refine = vi.fn(async () => ({ outcome: "success" as const }));
      const executor = new WorkflowGraphExecutor({
        handlers: { prompt: refine },
      });

      const result = await executor.run(task, settingsOn(), ir);
      expect(refine).toHaveBeenCalledOnce();
      expect(result.visitedNodeIds).toContain("refine");
    });

    it("conditional exit-gate exits early when the referenced context value matches", async () => {
      // Seed the ask-user answer via runCustomNode's contextPatch by running a
      // graph that first visits an ask-user node, then the exit-gate reads its
      // published `input:ask` context key.
      const irWithAsk: WorkflowIr = {
        version: "v1",
        name: "exit-gate-conditional-match-full",
        nodes: [
          { id: "start", kind: "start" },
          { id: "ask", kind: "ask-user", config: { question: "Anything to refine?" } },
          { id: "exit", kind: "exit-gate", config: { condition: { type: "output-contains", nodeId: "ask", value: "looks good" } } },
          { id: "refine", kind: "prompt" },
          { id: "end", kind: "end" },
        ],
        edges: [
          { from: "start", to: "ask" },
          { from: "ask", to: "exit", condition: "success" },
          { from: "exit", to: "end", condition: "outcome:exit" },
          { from: "exit", to: "refine", condition: "outcome:continue" },
        ],
      };
      const refine = vi.fn(async () => ({ outcome: "success" as const }));
      const runCustomNode = vi.fn(async () => ({
        outcome: "success" as const,
        contextPatch: { "input:ask": "yes, looks good to me" },
      }));
      const executor2 = new WorkflowGraphExecutor({ runCustomNode, handlers: { prompt: refine } });

      const result = await executor2.run(task, settingsOn(), irWithAsk);
      expect(refine).not.toHaveBeenCalled();
      expect(result.visitedNodeIds).toContain("exit");
      expect(result.visitedNodeIds).not.toContain("refine");
    });
  });
});

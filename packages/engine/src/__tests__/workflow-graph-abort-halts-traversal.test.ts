import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";

const task = { id: "FN-249", column: "work" } as TaskDetail;
const settings = { experimentalFeatures: { graphNativePostMerge: true } };

function signalAbortingOnRead(readNumber: number): AbortSignal {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads >= readNumber;
    },
  } as AbortSignal;
}

function graph(nodes: WorkflowIr["nodes"], edges: WorkflowIr["edges"]): WorkflowIr {
  return {
    version: "v2",
    name: "abort-halts-traversal",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes,
    edges,
  };
}

describe("WorkflowGraphExecutor abort traversal fence", () => {
  it("does not enter a merge region from an aborted advisory optional-group failure", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const executor = new WorkflowGraphExecutor({
      signal: controller.signal,
      handlers: {
        prompt: async (node) => {
          calls.push(node.id);
          if (node.id === "documentation-step") {
            controller.abort();
            return { outcome: "failure", value: "failed" };
          }
          return { outcome: "success" };
        },
      },
    });

    const result = await executor.run(task, settings, graph(
      [
        { id: "start", kind: "start" },
        {
          id: "documentation-delivery",
          kind: "optional-group",
          config: {
            defaultOn: true,
            template: {
              nodes: [{ id: "documentation-step", kind: "prompt", config: { prompt: "document" } }],
              edges: [],
            },
          },
        },
        { id: "merge-attempt", kind: "merge-attempt", config: { capability: "task-merge" } },
      ],
      [
        { from: "start", to: "documentation-delivery" },
        { from: "documentation-delivery", to: "merge-attempt", condition: "failure" },
      ],
    ));

    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).not.toContain("merge");
    expect(calls).toEqual(["documentation-step"]);
  });

  it("does not enter an optional-group success child after its run aborts", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const executor = new WorkflowGraphExecutor({
      signal: controller.signal,
      handlers: {
        prompt: async (node) => {
          calls.push(node.id);
          if (node.id === "review-step") controller.abort();
          return { outcome: "success" };
        },
      },
    });

    const result = await executor.run(task, settings, graph(
      [
        { id: "start", kind: "start" },
        {
          id: "review",
          kind: "optional-group",
          config: {
            defaultOn: true,
            template: { nodes: [{ id: "review-step", kind: "prompt", config: { prompt: "review" } }], edges: [] },
          },
        },
        { id: "downstream", kind: "prompt", config: { prompt: "downstream" } },
      ],
      [
        { from: "start", to: "review" },
        { from: "review", to: "downstream", condition: "success" },
      ],
    ));

    expect(result.outcome).toBe("failure");
    expect(calls).toEqual(["review-step"]);
    expect(result.visitedNodeIds).not.toContain("downstream");
  });

  it("does not enter a normal child after the run signal aborts", async () => {
    const prompt = vi.fn<WorkflowNodeHandler>(async () => ({ outcome: "success" }));
    const executor = new WorkflowGraphExecutor({
      signal: signalAbortingOnRead(6),
      handlers: { prompt },
    });

    const result = await executor.run(task, settings, graph(
      [
        { id: "start", kind: "start" },
        { id: "first", kind: "prompt", config: { prompt: "first" } },
        { id: "child", kind: "prompt", config: { prompt: "child" } },
      ],
      [{ from: "start", to: "first" }, { from: "first", to: "child", condition: "success" }],
    ));

    expect(result).toMatchObject({ outcome: "failure" });
    expect(result.visitedNodeIds).toEqual(["start", "first"]);
    expect(prompt.mock.calls.map(([node]) => node.id)).toEqual(["first"]);
  });

  it("does not enter the collapsed merge region after the run signal aborts", async () => {
    const prompt = vi.fn<WorkflowNodeHandler>(async () => ({ outcome: "success" }));
    const executor = new WorkflowGraphExecutor({
      signal: signalAbortingOnRead(6),
      handlers: { prompt },
    });

    const result = await executor.run(task, settings, graph(
      [
        { id: "start", kind: "start" },
        { id: "work", kind: "prompt", config: { prompt: "work" } },
        { id: "merge-attempt", kind: "merge-attempt", config: { capability: "task-merge" } },
      ],
      [{ from: "start", to: "work" }, { from: "work", to: "merge-attempt", condition: "success" }],
    ));

    expect(result).toMatchObject({ outcome: "failure" });
    expect(result.visitedNodeIds).toEqual(["start", "work"]);
    expect(prompt.mock.calls.map(([node]) => node.id)).toEqual(["work"]);
  });

  it("does not begin another rework iteration after the run signal aborts", async () => {
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) =>
      node.id === "fix" ? { outcome: "failure", value: "revise" } : { outcome: "success" },
    );
    const executor = new WorkflowGraphExecutor({
      signal: signalAbortingOnRead(11),
      handlers: { prompt },
    });

    const result = await executor.run(task, settings, graph(
      [
        { id: "start", kind: "start" },
        { id: "review", kind: "prompt", config: { prompt: "review", maxReworkCycles: 1 } },
        { id: "fix", kind: "prompt", config: { prompt: "fix" } },
      ],
      [
        { from: "start", to: "review" },
        { from: "review", to: "fix", condition: "success" },
        { from: "fix", to: "review", condition: "failure", kind: "rework" },
      ],
    ));

    expect(result).toMatchObject({ outcome: "failure" });
    expect(result.visitedNodeIds).toEqual(["start", "review", "fix"]);
    expect(prompt.mock.calls.map(([node]) => node.id)).toEqual(["review", "fix"]);
  });

  it("does not enter post-merge work after the run signal aborts", async () => {
    const prompt = vi.fn<WorkflowNodeHandler>(async () => ({ outcome: "success" }));
    const executor = new WorkflowGraphExecutor({
      signal: signalAbortingOnRead(9),
      handlers: { prompt },
    });

    const result = await executor.run(task, settings, graph(
      [
        { id: "start", kind: "start" },
        { id: "work", kind: "prompt", config: { prompt: "work" } },
        { id: "merge-attempt", kind: "merge-attempt", config: { capability: "task-merge" } },
        { id: "post", kind: "prompt", config: { prompt: "post" } },
      ],
      [
        { from: "start", to: "work" },
        { from: "work", to: "merge-attempt", condition: "success" },
        { from: "merge-attempt", to: "post", condition: "success" },
      ],
    ));

    expect(result).toMatchObject({ outcome: "failure" });
    expect(result.visitedNodeIds).toEqual(["start", "work", "merge"]);
    expect(prompt.mock.calls.map(([node]) => node.id)).toEqual(["work", "merge"]);
  });

  it("continues authored value:'aborted' failure edges when the run signal is not aborted", async () => {
    const prompt = vi.fn<WorkflowNodeHandler>(async (node) =>
      node.id === "first" ? { outcome: "failure", value: "aborted" } : { outcome: "success" },
    );
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settings, graph(
      [
        { id: "start", kind: "start" },
        { id: "first", kind: "prompt", config: { prompt: "first" } },
        { id: "recovery", kind: "prompt", config: { prompt: "recovery" } },
      ],
      [
        { from: "start", to: "first" },
        { from: "first", to: "recovery", condition: "failure" },
      ],
    ));

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toEqual(["start", "first", "recovery"]);
    expect(prompt.mock.calls.map(([node]) => node.id)).toEqual(["first", "recovery"]);
  });
});

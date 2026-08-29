import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowIrNode } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });
const task = { id: "FN-LOOP" } as TaskDetail;

function loopIr(config: Record<string, unknown>, extraEdges: WorkflowIr["edges"] = []): WorkflowIr {
  return {
    version: "v2",
    name: "loop-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "loop",
        kind: "loop",
        config: {
          template: {
            nodes: [
              { id: "ask", kind: "prompt", config: { prompt: "try" } },
              { id: "check", kind: "gate", config: { prompt: "done?" } },
            ],
            edges: [{ from: "ask", to: "check" }],
          },
          ...config,
        },
      },
      { id: "exhausted", kind: "hold", config: { release: "manual" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "loop" },
      { from: "loop", to: "end", condition: "success" },
      ...extraEdges,
    ],
  };
}

describe("WorkflowGraphExecutor loop", () => {
  it("exits successfully when the template output matches immediately", async () => {
    const calls: string[] = [];
    const prompt: WorkflowNodeHandler = async (node) => {
      calls.push(node.id);
      return { outcome: "success", value: node.id === "check" ? "DONE" : "working" };
    };
    const executor = new WorkflowGraphExecutor({ handlers: { prompt, gate: prompt } });

    const result = await executor.run(
      task,
      settingsOn(),
      loopIr({ maxIterations: 3, exitWhen: { type: "output-contains", value: "DONE" } }),
    );

    expect(result.outcome).toBe("success");
    expect(calls).toEqual(["ask", "check"]);
    expect(result.visitedNodeIds).toEqual(expect.arrayContaining(["loop", "loop#1:ask", "loop#1:check"]));
    expect(result.context["node:loop:loop"]).toMatchObject({ iterations: 1, exitReason: "matched" });
    expect(result.context["loop:active"]).toBeUndefined();
  });

  it("keeps iterating until the configured output string appears", async () => {
    let checks = 0;
    const handler: WorkflowNodeHandler = async (node) => {
      if (node.id !== "check") return { outcome: "success", value: "working" };
      checks += 1;
      return { outcome: "success", value: checks === 3 ? "DONE" : "KEEP_GOING" };
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler, gate: handler, hold: async () => ({ outcome: "success" }) },
    });

    const result = await executor.run(
      task,
      settingsOn(),
      loopIr({ maxIterations: 4, exitWhen: { type: "output-contains", value: "DONE" } }),
    );

    expect(result.outcome).toBe("success");
    expect(checks).toBe(3);
    expect(result.context["node:loop:loop"]).toMatchObject({ iterations: 3, exitReason: "matched" });
    expect(result.context["node:check:value"]).toBe("DONE");
  });

  it("routes iteration exhaustion as a failure outcome value", async () => {
    const handler = vi.fn(async () => ({ outcome: "success" as const, value: "not yet" }));
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler, gate: handler, hold: async () => ({ outcome: "success" }) },
    });

    const result = await executor.run(
      task,
      settingsOn(),
      loopIr(
        { maxIterations: 2, exitWhen: { type: "output-contains", value: "DONE" } },
        [{ from: "loop", to: "exhausted", condition: "outcome:loop-iteration-exhausted" }],
      ),
    );

    expect(result.outcome).toBe("success");
    expect(handler).toHaveBeenCalledTimes(4);
    expect(result.context["node:loop:outcome"]).toBe("failure");
    expect(result.context["node:loop:value"]).toBe("loop-iteration-exhausted");
  });

  it("routes timeout as a failure outcome value", async () => {
    let now = 0;
    const handler: WorkflowNodeHandler = async () => {
      now += 10;
      return { outcome: "success", value: "not yet" };
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler, gate: handler, hold: async () => ({ outcome: "success" }) },
      runLoopNowForTests: () => now,
    });

    const result = await executor.run(
      task,
      settingsOn(),
      loopIr(
        { maxIterations: 10, timeoutMs: 15, exitWhen: { type: "output-contains", value: "DONE" } },
        [{ from: "loop", to: "exhausted", condition: "outcome:loop-timeout" }],
      ),
    );

    expect(result.outcome).toBe("success");
    expect(result.context["node:loop:value"]).toBe("loop-timeout");
  });

  it("can match a regex against a selected template node value", async () => {
    const handler: WorkflowNodeHandler = async (node: WorkflowIrNode) => ({
      outcome: "success",
      value: node.id === "ask" ? "ticket READY-42" : "ignored",
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt: handler, gate: handler } });

    const result = await executor.run(
      task,
      settingsOn(),
      loopIr({
        maxIterations: 2,
        exitWhen: { type: "output-matches", nodeId: "ask", pattern: "READY-\\d+" },
      }),
    );

    expect(result.outcome).toBe("success");
    expect(result.context["node:loop:loop"]).toMatchObject({ exitReason: "matched" });
  });
});

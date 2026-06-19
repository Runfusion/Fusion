import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import { parseWorkflowStepOutput } from "../executor.js";
import { createDefaultNodeHandlers } from "../workflow-node-handlers.js";
import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";

/*
FNXC:WorkflowGates 2026-06-17-18:27:
FN-6582 requires malformed workflow-step verdicts to remain explicit failures for blocking gates while advisory gates may record a non-blocking advisory failure. These tests pin the shared imperative parser seam and the graph handler path so malformed output cannot be mistaken for APPROVE.
*/

const task = { id: "FN-6582" } as TaskDetail;

const noopSeams = () => ({
  planning: vi.fn(async () => ({ outcome: "success" as const })),
  execute: vi.fn(async () => ({ outcome: "success" as const })),
  workflowStep: vi.fn(async () => ({ outcome: "success" as const })),
  review: vi.fn(async () => ({ outcome: "success" as const })),
  merge: vi.fn(async () => ({ outcome: "success" as const })),
  schedule: vi.fn(async () => ({ outcome: "success" as const })),
});

describe("workflow malformed-verdict gate", () => {
  it("parses structured, fenced, prose, and malformed verdict shapes at the imperative seam", () => {
    expect(parseWorkflowStepOutput('{"verdict":"APPROVE","notes":"ok"}')).toEqual({
      output: "ok",
      verdict: "APPROVE",
      notes: "ok",
    });
    expect(parseWorkflowStepOutput('```json\n{"verdict":"APPROVE_WITH_NOTES","notes":"ship it"}\n```')).toEqual({
      output: "ship it",
      verdict: "APPROVE_WITH_NOTES",
      notes: "ship it",
    });
    expect(parseWorkflowStepOutput("REQUEST REVISION\nfix the gate")).toEqual({
      output: "fix the gate",
      verdict: "REVISE",
      notes: "fix the gate",
    });
    expect(parseWorkflowStepOutput("looks good to me")).toEqual({
      output: "looks good to me",
      verdict: "APPROVE",
      notes: "",
    });
    expect(parseWorkflowStepOutput("lorem ipsum")).toEqual({ output: "lorem ipsum", malformed: true });
  });

  it("keeps a malformed blocking graph gate from producing a passing outcome", async () => {
    const malformed = parseWorkflowStepOutput("lorem ipsum");
    const runCustomNode = vi.fn(async () => ({
      outcome: malformed.malformed ? "failure" as const : "success" as const,
      value: malformed.malformed ? "malformed" : malformed.verdict,
      contextPatch: malformed.malformed ? { "workflow:gate:malformed": true } : undefined,
    }));
    const handlers = createDefaultNodeHandlers(noopSeams(), runCustomNode);

    const result = await handlers.gate(
      { id: "quality-gate", kind: "gate", config: { prompt: "Return APPROVE or REVISE", gateMode: "gate" } },
      { task, settings: undefined, context: {} },
    );

    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("malformed");
    expect(result.contextPatch).toEqual({ "workflow:gate:malformed": true });
    expect(runCustomNode).toHaveBeenCalledOnce();
  });

  it("allows advisory malformed gates to record advisory_failure without blocking the graph", async () => {
    const malformed = parseWorkflowStepOutput("lorem ipsum");
    const handlers = createDefaultNodeHandlers(noopSeams(), async (node: WorkflowIrNode) => ({
      outcome: "success",
      value: node.config?.gateMode === "advisory" && malformed.malformed ? "advisory_failure" : "passed",
      contextPatch: { "workflow:gate:malformed": malformed.malformed, "workflow:gate:advisory": true },
    }));

    const result = await handlers.gate(
      { id: "advisory-gate", kind: "gate", config: { prompt: "Return APPROVE or REVISE", gateMode: "advisory" } },
      { task, settings: undefined, context: {} },
    );

    expect(result.outcome).toBe("success");
    expect(result.value).toBe("advisory_failure");
    expect(result.contextPatch).toEqual({ "workflow:gate:malformed": true, "workflow:gate:advisory": true });
  });

  it("terminates a graph run as failed when a malformed gate routes to failure", async () => {
    const malformed = parseWorkflowStepOutput("lorem ipsum");
    const executor = new WorkflowGraphExecutor({
      handlers: createDefaultNodeHandlers(noopSeams(), async () => ({
        outcome: malformed.malformed ? "failure" : "success",
        value: malformed.malformed ? "malformed" : "APPROVE",
      })),
      runCustomNode: async () => ({ outcome: "success" }),
    });

    const result = await executor.run(task, { experimentalFeatures: { workflowGraphExecutor: true } }, {
      version: "v1",
      name: "malformed-gate",
      nodes: [
        { id: "start", kind: "start" },
        { id: "gate", kind: "gate", config: { prompt: "Return APPROVE or REVISE", gateMode: "gate" } },
        { id: "zend", kind: "end" },
      ],
      edges: [
        { from: "start", to: "gate", condition: "success" },
        { from: "gate", to: "zend", condition: "success" },
      ],
    });

    expect(result.outcome).toBe("failure");
    expect(result.visitedNodeIds).toEqual(["start", "gate"]);
  });
});

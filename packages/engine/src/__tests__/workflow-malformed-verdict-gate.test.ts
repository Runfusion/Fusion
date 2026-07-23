import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import { parseWorkflowStepOutput } from "../executor.js";
import { createDefaultNodeHandlers } from "../workflows/workflow-node-handlers.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

/*
FNXC:WorkflowGates 2026-06-17-18:27:
FN-6582 requires malformed workflow-step verdicts to remain explicit failures for blocking gates while advisory gates may record a non-blocking advisory failure. These tests pin the shared imperative parser seam and the graph handler path so malformed output cannot be mistaken for APPROVE.

FNXC:ReviewLeniency 2026-07-02-00:30:
POLICY CHANGE (operator request): malformed gate output (no parseable verdict, even after the executeWorkflowStep fallback-model retry) is now treated as a NON-BLOCKING advisory, relaxing the FN-6582 hard block. The real mapping lives in runGraphCustomNode (`outcome: success || !blocking || malformed ? "success" : "failure"`). A genuine PARSED non-pass verdict (REVISE) still blocks. The parser seam still classifies unparseable text as `malformed` (it is NOT silently promoted to APPROVE) — only the downstream blocking decision was relaxed. These handler/executor tests mock the node result to pin the graph PLUMBING for a genuine-failure verdict; they intentionally do not re-assert a malformed→block mapping that no longer exists.
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
    expect(parseWorkflowStepOutput("native skill output", { requireVerdict: false })).toEqual({ output: "native skill output" });
  });

  it("keeps a blocking graph gate with a genuine REVISE verdict from passing", async () => {
    // A PARSED non-pass verdict still blocks (only unparseable/malformed output
    // was relaxed to a non-blocking advisory — see the ReviewLeniency note above).
    const revise = parseWorkflowStepOutput("REQUEST REVISION\nfix the gate");
    const runCustomNode = vi.fn(async () => ({
      outcome: revise.verdict === "REVISE" ? "failure" as const : "success" as const,
      value: revise.verdict,
    }));
    const handlers = createDefaultNodeHandlers(noopSeams(), runCustomNode);

    const result = await handlers.gate(
      { id: "quality-gate", kind: "gate", config: { prompt: "Return APPROVE or REVISE", gateMode: "gate" } },
      { task, settings: undefined, context: {} },
    );

    expect(result.outcome).toBe("failure");
    expect(result.value).toBe("REVISE");
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

  it("terminates a graph run as failed when a blocking gate returns REVISE", async () => {
    const revise = parseWorkflowStepOutput("REQUEST REVISION\nfix the gate");
    const executor = new WorkflowGraphExecutor({
      handlers: createDefaultNodeHandlers(noopSeams(), async () => ({
        outcome: revise.verdict === "REVISE" ? "failure" : "success",
        value: revise.verdict === "REVISE" ? "REVISE" : "APPROVE",
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

import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIrNode } from "@fusion/core";

import { parseWorkflowStepOutput } from "../executor.js";
import { createDefaultNodeHandlers } from "../workflows/workflow-node-handlers.js";
import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

/*
FNXC:WorkflowGates 2026-06-17-18:27:
FN-6582 requires malformed workflow-step verdicts to remain explicit failures for blocking gates while advisory gates may record a non-blocking advisory failure. These tests pin the shared imperative parser seam and the graph handler path so malformed output cannot be mistaken for APPROVE.

FNXC:ReviewLeniency 2026-07-02-00:30:
POLICY CHANGE (operator request): malformed gate output was treated as a NON-BLOCKING advisory, relaxing the FN-6582 hard block, and the malformed→block assertion was removed with it.

POLICY CHANGE REVERSED (operator request, 2026-08-26): a BLOCKING gate no longer approves on malformed output, and the assertion is restored below. The stated rule is that the only legitimate stop is an LLM problem; since `executeWorkflowStep` already retries a malformed response (fallback model, or a self-retry on the primary when none is configured), reaching this decision means the reviewer failed across every attempt — which is that LLM-class condition, and is never grounds to record approval. Advisory gates keep the relaxation, because a step that was never allowed to hold a card must not start holding one. The real mapping lives in runGraphCustomNode (`outcome: success || (!blocking && verdict !== "UNAVAILABLE") ? "success" : "failure"`).
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

  /* FNXC:ReviewLeniency 2026-08-11-18:44: Visible but unreadable structured
   * verdict intent is malformed, never a lenient prose approval. */
  it("does not launder unreadable structured verdicts into prose approval", () => {
    for (const output of [
      'looks good\n{"verdict":"REVISE","notes":"truncated',
      'looks good\n{"verdict":"PASS"}',
    ]) {
      expect(parseWorkflowStepOutput(output)).toEqual({ output, malformed: true });
      expect(parseWorkflowStepOutput(output, { requireVerdict: false })).toEqual({ output });
    }
    expect(parseWorkflowStepOutput("looks good")).toMatchObject({ verdict: "APPROVE" });
    expect(parseWorkflowStepOutput("my verdict: looks good")).toMatchObject({ verdict: "APPROVE" });
  });

  it("extracts only validated findings from the selected trailing verdict JSON", () => {
    expect(parseWorkflowStepOutput('prose {"verdict":"REVISE","notes":"old"}\n{"verdict":"REVISE","notes":"new","findings":[{"id":"a","title":"Issue","body":"Fix it","line":3,"severity":"high"},{"id":"a","title":"Second","body":"Also fix"},{"title":"bad","body":""}]}')).toMatchObject({
      verdict: "REVISE",
      notes: "new",
      findings: [
        { id: "a", title: "Issue", body: "Fix it", line: 3, severity: "high" },
        { id: "a-2", title: "Second", body: "Also fix" },
      ],
    });
    expect(parseWorkflowStepOutput("REQUEST REVISION\n1. prose only").findings).toBeUndefined();
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

  /*
  FNXC:ReviewLeniency 2026-08-26-09:34:
  FN-6582's blocking-gate rule is RESTORED, and this is the test the relaxation deliberately removed.

  Operator decision, with the reason the first reversal lacked: "the only valid reason a task can be
  blocked is an LLM problem (429, 503); everything else is fixed at the source, or the AI is made
  unable to return anything other than what is expected — and if it does anyway, restart cleanly".

  Restarting cleanly already happens twice inside `executeWorkflowStep` (fallback-model retry, or a
  self-retry on the primary when no fallback is configured), so `malformed` reaching this decision
  means the reviewer failed across every attempt — exactly the LLM-class condition an operator accepts
  as a legitimate stop, and never a reason to record approval.

  Measured cost of the relaxation: a reviewer reported in prose that the deliverables were absent,
  carried no verdict JSON, and the gate recorded success — unreviewed work merged on a rejection
  nobody could see. A prose classifier cannot close this; that text held no rejection marker at all,
  because it was a factual statement of absence. Only the ABSENCE of a verdict is detectable.
  */
  it("keeps a blocking gate from passing on malformed output", async () => {
    const malformed = parseWorkflowStepOutput(
      "The requested repo1.txt and repo2.txt files are not present in the worktree. No modified files were detected.",
    );
    // The reviewer's text carries no rejection marker at all — absence of a verdict is the only signal.
    expect(malformed.malformed).toBe(true);
    expect(malformed.verdict).toBeUndefined();

    const handlers = createDefaultNodeHandlers(noopSeams(), async () => ({
      outcome: "failure",
      value: "advisory_failure",
      contextPatch: { "workflow:gate:malformed": true },
    }));

    const result = await handlers.gate(
      { id: "code-review-step", kind: "gate", config: { prompt: "Return APPROVE or REVISE", gateMode: "gate" } },
      { task, settings: undefined, context: {} },
    );

    expect(result.outcome, "a blocking gate must not approve without a usable verdict").toBe("failure");
    expect(result.value).toBe("advisory_failure");
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

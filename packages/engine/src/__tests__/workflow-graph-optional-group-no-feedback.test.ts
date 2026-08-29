import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";

/*
FNXC:WorkflowStepResults 2026-07-07-00:00:
Regression coverage for Runfusion/Fusion#1946: a non-verdict optional-group /
`source:"node"` failure (dispatch/infra exception, not a reviewer verdict) must
never be recorded with `status:"failed"` and an absent `output` — the
`(no feedback captured)` signature that stranded cards in `in-review`. These
tests drive `WorkflowGraphExecutor` with a recorder-fake (mirrors
`workflow-graph-optional-group.test.ts` / `builtin-coding-workflow-step-results.test.ts`)
and assert the synthesized diagnostic `output`, while control cases prove
genuine verdicts and disabled groups are byte-inert.
*/

const settingsOn = () => ({ experimentalFeatures: { workflowGraphExecutor: true } });

function taskWith(enabled: string[] | undefined): TaskDetail {
  return { id: "FN-NFC", enabledWorkflowSteps: enabled } as TaskDetail;
}

/** A single-node `code-review` optional-group between start/end, configurable phase. */
function codeReviewGroupIr(options: { phase?: "pre-merge" | "post-merge" } = {}): WorkflowIr {
  return {
    version: "v2",
    name: "code-review-no-feedback-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "code-review",
        kind: "optional-group",
        config: {
          name: "Code Review",
          defaultOn: true,
          phase: options.phase,
          template: {
            nodes: [{ id: "review", kind: "prompt", config: { prompt: "review" } }],
            edges: [],
          },
        },
      },
      { id: "after", kind: "prompt", config: { prompt: "after" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "code-review" },
      { from: "code-review", to: "after", condition: "success" },
      { from: "code-review", to: "end", condition: "failure" },
      { from: "after", to: "end" },
    ],
  };
}

/** A single top-level `gate` node (CE `source:"node"` skill gate) — no optional-group wrapper. */
function nodeGateIr(): WorkflowIr {
  return {
    version: "v2",
    name: "node-gate-no-feedback-test",
    columns: [{ id: "work", name: "Work", traits: [] }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "gatecheck", kind: "gate", config: { prompt: "check", skillName: "security-gate" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: "gatecheck" },
      { from: "gatecheck", to: "end" },
    ],
  };
}

describe("workflow-graph-executor: non-verdict failure diagnostic (Runfusion/Fusion#1946)", () => {
  it("SYMPTOM: a code-review dispatch exception records a non-empty diagnostic output, never (no feedback captured)", async () => {
    const records: Array<Record<string, unknown>> = [];
    const handler: WorkflowNodeHandler = async (node) => {
      if (node.id === "review") throw new Error("model provider dispatch failed");
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      maxRetriesPerNode: 3,
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result as unknown as Record<string, unknown>); },
    });

    await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());

    const terminal = records.find((r) => r.workflowStepId === "code-review" && r.status === "failed");
    expect(terminal).toBeDefined();
    expect(terminal?.verdict).toBeUndefined();
    expect(typeof terminal?.output).toBe("string");
    expect((terminal?.output as string).length).toBeGreaterThan(0);
    expect(terminal?.output).toContain("model provider dispatch failed");
    expect(terminal?.output).not.toBe("(no feedback captured)");
  });

  it("SYMPTOM (post-merge phase): a post-merge optional-group dispatch exception also records a diagnostic output", async () => {
    const records: Array<Record<string, unknown>> = [];
    const handler: WorkflowNodeHandler = async (node) => {
      if (node.id === "review") throw new Error("session dispatch race");
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      maxRetriesPerNode: 3,
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result as unknown as Record<string, unknown>); },
    });

    await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr({ phase: "post-merge" }));

    const terminal = records.find((r) => r.workflowStepId === "code-review" && r.status === "failed");
    expect(terminal).toBeDefined();
    expect(terminal?.phase).toBe("post-merge");
    expect(terminal?.output).toContain("session dispatch race");
  });

  it("SYMPTOM (source:'node'): a CE skill-gate node exception records a diagnostic output, not a field-absent failure", async () => {
    const records: Array<Record<string, unknown>> = [];
    const handler: WorkflowNodeHandler = async () => {
      throw new Error("gate dispatch exploded");
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { gate: handler },
      maxRetriesPerNode: 2,
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result as unknown as Record<string, unknown>); },
    });

    await executor.run(taskWith(undefined), settingsOn(), nodeGateIr());

    const terminal = records.find((r) => r.workflowStepId === "gatecheck" && r.status === "failed");
    expect(terminal).toBeDefined();
    expect(terminal?.status).toBe("failed");
    expect(terminal?.source).toBe("node");
    expect(typeof terminal?.output).toBe("string");
    expect((terminal?.output as string).length).toBeGreaterThan(0);
    expect(terminal?.output).toContain("gate dispatch exploded");
  });

  it("SURFACE: an 'aborted' failure value with no recoverable error text still yields a non-blank fallback output", async () => {
    const records: Array<Record<string, unknown>> = [];
    // The template node itself directly returns a failure with a bare `value` and
    // no `contextPatch` (the same shape `runOptionalGroup`/`executeNodeWithRetries`
    // produce for a mid-retry abort) — no recoverable `:error` text anywhere.
    const handler: WorkflowNodeHandler = async (node) =>
      node.id === "review" ? { outcome: "failure", value: "aborted" } : { outcome: "success" };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result as unknown as Record<string, unknown>); },
    });

    await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());

    const terminal = records.find((r) => r.workflowStepId === "code-review" && r.status === "failed");
    expect(terminal).toBeDefined();
    expect(typeof terminal?.output).toBe("string");
    expect((terminal?.output as string).trim().length).toBeGreaterThan(0);
  });

  it("CONTROL: a genuine REVISE verdict keeps its verdict + populated output unchanged (not overwritten by the diagnostic path)", async () => {
    const records: Array<Record<string, unknown>> = [];
    const handler: WorkflowNodeHandler = async (node) =>
      node.id === "review"
        ? { outcome: "failure", value: "REVISE", contextPatch: { output: "Please add tests for the edge case" } }
        : { outcome: "success" };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result as unknown as Record<string, unknown>); },
    });

    await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());

    const terminal = records.find((r) => r.workflowStepId === "code-review" && r.status === "failed");
    expect(terminal).toBeDefined();
    expect(terminal?.verdict).toBe("REVISE");
    expect(terminal?.output).toBe("Please add tests for the edge case");
  });

  it("CONTROL: APPROVE and APPROVE_WITH_NOTES verdicts are unchanged", async () => {
    for (const verdict of ["APPROVE", "APPROVE_WITH_NOTES"] as const) {
      const records: Array<Record<string, unknown>> = [];
      const handler: WorkflowNodeHandler = async (node) =>
        node.id === "review"
          ? { outcome: "success", value: verdict, contextPatch: { output: `${verdict} notes` } }
          : { outcome: "success" };
      const executor = new WorkflowGraphExecutor({
        handlers: { prompt: handler },
        recordWorkflowStepResult: async (_taskId, result) => { records.push(result as unknown as Record<string, unknown>); },
      });

      await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());

      const terminal = records.find((r) => r.workflowStepId === "code-review" && r.status !== "pending");
      expect(terminal).toBeDefined();
      expect(terminal?.verdict).toBe(verdict);
      expect(terminal?.output).toBe(`${verdict} notes`);
    }
  });

  it("CONTROL: a disabled code-review group records nothing (byte-inert)", async () => {
    const records: Array<Record<string, unknown>> = [];
    const handler: WorkflowNodeHandler = async (node) => {
      if (node.id === "review") throw new Error("should never run");
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result as unknown as Record<string, unknown>); },
    });

    // defaultOn: true but not explicitly enabled — group defaults follow the
    // fixture's `enabledWorkflowSteps` gate the same way as the sibling suite.
    const ir = codeReviewGroupIr();
    (ir.nodes.find((n) => n.id === "code-review")!.config as { defaultOn?: boolean }).defaultOn = false;

    const result = await executor.run(taskWith(undefined), settingsOn(), ir);

    expect(records.filter((r) => r.workflowStepId === "code-review")).toHaveLength(0);
    expect(result.outcome).toBe("success");
  });

  it("keeps status/verdict/edge-routing untouched so self-healing's status==='failed' selection is unaffected", async () => {
    const records: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const handler: WorkflowNodeHandler = async (node) => {
      calls.push(node.id);
      if (node.id === "review") throw new Error("dispatch race");
      return { outcome: "success" };
    };
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt: handler },
      maxRetriesPerNode: 2,
      recordWorkflowStepResult: async (_taskId, result) => { records.push(result as unknown as Record<string, unknown>); },
    });

    await executor.run(taskWith(["code-review"]), settingsOn(), codeReviewGroupIr());

    // The failure edge routes to `end`, not the success edge to `after` —
    // `self-healing.ts`'s `latestFailedPreMergeStep` relies on this same
    // `status:"failed"` signal; only `output` gained a diagnostic, nothing else.
    expect(calls).not.toContain("after");
    const terminal = records.find((r) => r.workflowStepId === "code-review" && r.status === "failed");
    expect(terminal?.status).toBe("failed");
  });
});

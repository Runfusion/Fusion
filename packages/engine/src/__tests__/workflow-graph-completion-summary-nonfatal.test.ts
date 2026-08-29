import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_CODING_WORKFLOW_IR,
  BUILTIN_MARKETING_WORKFLOW_IR,
  BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
  BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR,
  BUILTIN_LEAD_GENERATION_WORKFLOW_IR,
  COMPLETION_SUMMARY_NODE_ID,
} from "@fusion/core";
import type { TaskDetail, WorkflowIr } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflows/workflow-graph-executor.js";

/*
 * FNXC:WorkflowCompletion 2026-07-01-16:30:
 * Regression for issue #1863 (v0.52.0 triage loop). The built-in
 * completion-summary node is best-effort — a deterministic fallback backfills
 * task.summary — and every built-in workflow wires it with a success-only edge.
 * A thrown handler exception or a failed summary projection write bypasses the
 * advisory `!blocking → success` coercion and, absent a failure edge, terminates
 * the graph at 'completion-summary'; the in-review→todo resume router then bounces
 * the task back to execution forever. These tests assert the invariant across BOTH
 * failure modes: a failing completion-summary node never terminates or loops the
 * graph, while a non-summary node still fails normally.
 */

const task = { id: "FN-1863" } as TaskDetail;

function settingsOn() {
  return { experimentalFeatures: { workflowGraphExecutor: true } };
}

function summaryGraph(): WorkflowIr {
  // Mirror the built-in wiring: completion-summary has a success-only outgoing
  // edge and no failure edge.
  return {
    version: "v1",
    name: "summary-nonfatal",
    nodes: [
      { id: "start", kind: "start" },
      { id: COMPLETION_SUMMARY_NODE_ID, kind: "prompt", config: { summaryTarget: "task" } },
      { id: "end", kind: "end" },
    ],
    edges: [
      { from: "start", to: COMPLETION_SUMMARY_NODE_ID },
      { from: COMPLETION_SUMMARY_NODE_ID, to: "end", condition: "success" },
    ],
  };
}

describe("completion-summary node is non-fatal (issue #1863)", () => {
  it("advances past a completion-summary node whose handler throws", async () => {
    const prompt = vi.fn(async () => {
      throw new Error("worktree missing during summary");
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt }, maxRetriesPerNode: 1 });

    const result = await executor.run(task, settingsOn(), summaryGraph());

    // Success (not a terminal graph failure) proves the node was degraded and
    // the graph advanced instead of terminating at completion-summary. (`end`
    // nodes are not recorded in visitedNodeIds, so assert on outcome.)
    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toContain(COMPLETION_SUMMARY_NODE_ID);
    expect(prompt).toHaveBeenCalled();
  });

  it("advances past a completion-summary node whose summary projection write fails", async () => {
    const prompt = vi.fn(async () => ({
      outcome: "success" as const,
      contextPatch: { summary: "Did the thing." },
    }));
    const publishTaskProjection = vi.fn(async () => {
      throw new Error("db write failed");
    });
    const executor = new WorkflowGraphExecutor({
      handlers: { prompt },
      publishTaskProjection,
      maxRetriesPerNode: 1,
    });

    const result = await executor.run(task, settingsOn(), summaryGraph());

    expect(result.outcome).toBe("success");
    expect(result.visitedNodeIds).toContain(COMPLETION_SUMMARY_NODE_ID);
    // The write was attempted (and swallowed) — not skipped.
    expect(publishTaskProjection).toHaveBeenCalled();
  });

  it("still fails the graph when a NON-summary node throws (degrade is summary-scoped)", async () => {
    const ir: WorkflowIr = {
      version: "v1",
      name: "plain-throws",
      nodes: [
        { id: "start", kind: "start" },
        { id: "work", kind: "prompt" },
        { id: "end", kind: "end" },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "end", condition: "success" },
      ],
    };
    const executor = new WorkflowGraphExecutor({
      handlers: {
        prompt: async () => {
          throw new Error("boom");
        },
      },
      maxRetriesPerNode: 1,
    });

    const result = await executor.run(task, settingsOn(), ir);

    expect(result.outcome).toBe("failure");
  });

  // Surface enumeration: the fix matters because NONE of the built-in workflows
  // give completion-summary a failure edge — so any failure there terminates the
  // graph unless the executor degrades it.
  const builtins: Array<[string, WorkflowIr]> = [
    ["coding", BUILTIN_CODING_WORKFLOW_IR],
    ["stepwise-coding", BUILTIN_STEPWISE_CODING_WORKFLOW_IR],
    ["stepwise-final-review-coding", BUILTIN_STEPWISE_FINAL_REVIEW_CODING_WORKFLOW_IR],
    ["marketing", BUILTIN_MARKETING_WORKFLOW_IR],
    ["lead-generation", BUILTIN_LEAD_GENERATION_WORKFLOW_IR],
  ];

  it.each(builtins)("built-in %s workflow wires completion-summary with no failure edge", (_name, ir) => {
    const node = ir.nodes.find((n) => n.id === COMPLETION_SUMMARY_NODE_ID);
    expect(node, "built-in workflow should contain a completion-summary node").toBeTruthy();
    const outgoing = ir.edges.filter((e) => e.from === COMPLETION_SUMMARY_NODE_ID);
    expect(outgoing.length).toBeGreaterThan(0);
    expect(outgoing.some((e) => e.condition === "failure")).toBe(false);
  });
});

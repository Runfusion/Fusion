import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowIrNodeKind } from "@fusion/core";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";

import { WorkflowGraphExecutor, type WorkflowNodeHandler } from "../workflows/workflow-graph-executor.js";

const task = { id: "FN-6294" } as TaskDetail;
const settings = { experimentalFeatures: { workflowGraphExecutor: true } };

const mergeRegionEntries: Array<{ id: string; kind: WorkflowIrNodeKind }> = [
  { id: "merge-gate", kind: "merge-gate" },
  { id: "merge-attempt", kind: "merge-attempt" },
  { id: "merge-manual-hold", kind: "manual-merge-hold" },
  { id: "merge-retry", kind: "retry-backoff" },
  { id: "recovery-router", kind: "recovery-router" },
  { id: "branch-group-member-integration", kind: "branch-group-member-integration" },
  { id: "branch-group-promotion", kind: "branch-group-promotion" },
];
const rawMergeRegionNodeIds = mergeRegionEntries.map((entry) => entry.id);

/*
 * FNXC:WorkflowGraphTests 2026-07-01-20:10:
 * Post-cutover harness. The built-in coding workflow now routes every task through
 * the graph by default, inserting the default-on `plan-review` group before execute
 * and the default-on `code-review` template + `completion-summary` before review,
 * plus a `post-merge-verification` hop after a successful collapsed merge. The legacy
 * seams-only harness routed `plan-review` to `plan-replan` and never reached merge.
 * We drive the graph with a single `prompt` handler (mirroring the passing
 * workflow-graph-executor-retry-coding-workflow reference) so every plan/code-review
 * gate APPROVES via a plain `{ outcome: "success" }`. The `merge` seam node is a
 * synthetic prompt node with id `"merge"` (config.seam:"merge") that the collapse
 * emits, so merge spying/failure-injection now keys on `node.id === "merge"` inside
 * the prompt handler instead of a legacy `seams.merge`. The MERGE-REGION COLLAPSE
 * invariant is unchanged: raw merge primitives (merge-gate/merge-attempt/...) must
 * never appear in `visitedNodeIds`, and the whole region must collapse to the single
 * legacy `merge` node dispatched exactly once.
 */

type PromptOverrides = {
  merge?: () => { outcome: "success" | "failure"; value?: string };
  review?: () => { outcome: "success" | "failure"; value?: string };
};

function createPrompt(overrides: PromptOverrides = {}) {
  return vi.fn<WorkflowNodeHandler>(async (node) => {
    if (node.id === "merge" && overrides.merge) return overrides.merge();
    if (node.id === "review" && overrides.review) return overrides.review();
    return { outcome: "success" };
  });
}

function expectNoRawMergeRegionVisits(visitedNodeIds: string[]) {
  for (const rawNodeId of rawMergeRegionNodeIds) {
    expect(visitedNodeIds).not.toContain(rawNodeId);
  }
}

function irEnteringMergeRegionAt(entryId: string): WorkflowIr {
  return {
    ...BUILTIN_CODING_WORKFLOW_IR,
    edges: BUILTIN_CODING_WORKFLOW_IR.edges.map((edge) =>
      edge.from === "review" && edge.to === "merge-gate" && edge.condition === "success"
        ? { ...edge, to: entryId }
        : edge,
    ),
  };
}

// FNXC:WorkflowGraphTests 2026-07-01-20:10: Post-cutover success topology for
// builtin:coding, derived empirically and sanity-checked against the passing
// workflow-graph-executor-retry-coding-workflow reference test.
const SUCCESS_PATH = [
  "start",
  "planning",
  "plan-review",
  "plan-review::plan-review-step",
  "execute",
  "browser-verification",
  "code-review",
  "code-review::code-review-step",
  "completion-summary",
  "review",
  "merge",
  "post-merge-verification",
];
// Same path, stopped before the post-merge hop (merge itself failed).
const MERGE_FAILURE_PATH = SUCCESS_PATH.slice(0, SUCCESS_PATH.indexOf("merge") + 1);
// Same path, stopped at review (review failed before the merge-policy region).
const REVIEW_FAILURE_PATH = SUCCESS_PATH.slice(0, SUCCESS_PATH.indexOf("review") + 1);

describe("WorkflowGraphExecutor merge-region collapse", () => {
  it("collapses the built-in merge-policy region to one legacy merge seam", async () => {
    const calls: string[] = [];
    const prompt = createPrompt({
      merge: () => {
        calls.push("merge");
        return { outcome: "success" as const };
      },
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settings, BUILTIN_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("success");
    // The whole merge-policy region collapses to exactly one merge dispatch.
    expect(calls).toEqual(["merge"]);
    expect(prompt.mock.calls.filter(([node]) => node.id === "merge")).toHaveLength(1);
    expect(result.visitedNodeIds).toEqual(SUCCESS_PATH);
    expect(result.context["node:merge:outcome"]).toBe("success");
    expectNoRawMergeRegionVisits(result.visitedNodeIds);
  });

  it("routes legacy merge seam failures to a failure terminal without visiting raw merge primitives", async () => {
    const calls: string[] = [];
    const prompt = createPrompt({
      merge: () => {
        calls.push("merge");
        return { outcome: "failure" as const, value: "FileScopeViolationError" };
      },
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settings, BUILTIN_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("failure");
    expect(calls).toEqual(["merge"]);
    expect(result.visitedNodeIds).toEqual(MERGE_FAILURE_PATH);
    expect(result.context["node:merge:outcome"]).toBe("failure");
    expect(result.context["node:merge:value"]).toBe("FileScopeViolationError");
    expectNoRawMergeRegionVisits(result.visitedNodeIds);
  });

  it("does not collapse to merge when review fails before the merge-policy region", async () => {
    const calls: string[] = [];
    const prompt = createPrompt({
      review: () => ({ outcome: "failure" as const, value: "manual-merge-required" }),
      merge: () => {
        calls.push("merge");
        return { outcome: "success" as const };
      },
    });
    const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

    const result = await executor.run(task, settings, BUILTIN_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("failure");
    expect(calls).toEqual([]);
    expect(result.visitedNodeIds).toEqual(REVIEW_FAILURE_PATH);
    expect(result.visitedNodeIds).not.toContain("merge");
    expectNoRawMergeRegionVisits(result.visitedNodeIds);
  });

  it.each(mergeRegionEntries)(
    "treats $kind as a merge-region boundary when entered directly",
    async ({ id }) => {
      const calls: string[] = [];
      const prompt = createPrompt({
        merge: () => {
          calls.push("merge");
          return { outcome: "success" as const };
        },
      });
      const executor = new WorkflowGraphExecutor({ handlers: { prompt } });

      const result = await executor.run(task, settings, irEnteringMergeRegionAt(id));

      expect(result.outcome).toBe("success");
      expect(calls).toEqual(["merge"]);
      expect(result.visitedNodeIds).toEqual(SUCCESS_PATH);
      expectNoRawMergeRegionVisits(result.visitedNodeIds);
    },
  );
});

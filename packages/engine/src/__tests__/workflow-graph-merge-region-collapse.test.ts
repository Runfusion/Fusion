import { describe, expect, it, vi } from "vitest";
import type { TaskDetail, WorkflowIr, WorkflowIrNodeKind } from "@fusion/core";
import { BUILTIN_CODING_WORKFLOW_IR } from "@fusion/core";

import { WorkflowGraphExecutor } from "../workflow-graph-executor.js";
import type { WorkflowLegacySeams } from "../workflow-node-handlers.js";

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

// U6: the task carries no `enabledWorkflowSteps`, so the pre-merge
// browser-verification optional-group is BYPASSED — its node is visited but its
// body never runs. The legacy `workflowStep` seam is retained here only for shape
// (it is no longer reached by the migrated coding IR).
function createSeams(overrides: Partial<WorkflowLegacySeams> = {}): WorkflowLegacySeams {
  return {
    planning: async () => ({ outcome: "success" }),
    execute: async () => ({ outcome: "success" }),
    workflowStep: async () => ({ outcome: "success" }),
    review: async () => ({ outcome: "success" }),
    merge: async () => ({ outcome: "success" }),
    schedule: async () => ({ outcome: "success" }),
    ...overrides,
  };
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

describe("WorkflowGraphExecutor merge-region collapse", () => {
  it("collapses the built-in merge-policy region to one legacy merge seam", async () => {
    const calls: string[] = [];
    const merge = vi.fn(async () => {
      calls.push("merge");
      return { outcome: "success" as const };
    });
    const executor = new WorkflowGraphExecutor({ seams: createSeams({ merge }) });

    const result = await executor.run(task, settings, BUILTIN_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("success");
    expect(merge).toHaveBeenCalledOnce();
    expect(calls).toEqual(["merge"]);
    expect(result.visitedNodeIds).toEqual(["start", "planning", "execute", "browser-verification", "review", "merge"]);
    expect(result.context["node:merge:outcome"]).toBe("success");
    expectNoRawMergeRegionVisits(result.visitedNodeIds);
  });

  it("routes legacy merge seam failures to a failure terminal without visiting raw merge primitives", async () => {
    const merge = vi.fn(async () => ({ outcome: "failure" as const, value: "FileScopeViolationError" }));
    const executor = new WorkflowGraphExecutor({ seams: createSeams({ merge }) });

    const result = await executor.run(task, settings, BUILTIN_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("failure");
    expect(merge).toHaveBeenCalledOnce();
    expect(result.visitedNodeIds).toEqual(["start", "planning", "execute", "browser-verification", "review", "merge"]);
    expect(result.context["node:merge:outcome"]).toBe("failure");
    expect(result.context["node:merge:value"]).toBe("FileScopeViolationError");
    expectNoRawMergeRegionVisits(result.visitedNodeIds);
  });

  it("does not collapse to merge when review fails before the merge-policy region", async () => {
    const merge = vi.fn(async () => ({ outcome: "success" as const }));
    const executor = new WorkflowGraphExecutor({
      seams: createSeams({
        review: async () => ({ outcome: "failure", value: "manual-merge-required" }),
        merge,
      }),
    });

    const result = await executor.run(task, settings, BUILTIN_CODING_WORKFLOW_IR);

    expect(result.outcome).toBe("failure");
    expect(merge).not.toHaveBeenCalled();
    expect(result.visitedNodeIds).toEqual(["start", "planning", "execute", "browser-verification", "review"]);
    expect(result.visitedNodeIds).not.toContain("merge");
    expectNoRawMergeRegionVisits(result.visitedNodeIds);
  });

  it.each(mergeRegionEntries)(
    "treats $kind as a merge-region boundary when entered directly",
    async ({ id }) => {
      const merge = vi.fn(async () => ({ outcome: "success" as const }));
      const executor = new WorkflowGraphExecutor({ seams: createSeams({ merge }) });

      const result = await executor.run(task, settings, irEnteringMergeRegionAt(id));

      expect(result.outcome).toBe("success");
      expect(merge).toHaveBeenCalledOnce();
      expect(result.visitedNodeIds).toEqual(["start", "planning", "execute", "browser-verification", "review", "merge"]);
      expectNoRawMergeRegionVisits(result.visitedNodeIds);
    },
  );
});

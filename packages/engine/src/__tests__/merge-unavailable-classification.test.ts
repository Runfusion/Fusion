import { describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import { createAuthoritativeWorkflowSeams } from "../executor/create-authoritative-workflow-seams.js";
import { graphFailureValue, isMergeGraphFailure } from "../executor/graph-failure-pure.js";
import { routeGraphMergeFailureToRetry } from "../executor/route-graph-merge-failure-to-retry.js";
import { isTerminalMergeGraphFailureValue } from "../executor/task-predicates.js";
import { createMergeAttemptHandler } from "../workflow-node-runners/merge-runner.js";

/*
FNXC:WorkflowMerge 2026-08-20-02:36:
FN-9170 reproduces the original merge-unavailable symptom through the real legacy seam and
runner before changing the classifier. The legacy branch is the executable baseline: no wired
merge requester preserves the literal, while the pre-fix primitive branch renames its failed-data
sentinel to merge-failed.
*/

const task = { id: "FN-9170" } as TaskDetail;
const node = { id: "merge-attempt", kind: "merge-attempt" } as any;
const context = { source: "merge-unavailable-regression" };
const signal = new AbortController().signal;

function createHandlerContext() {
  return {
    task,
    settings: {},
    context,
    signal,
  } as any;
}

describe("FN-9170 merge-unavailable dispatch classification", () => {
  it("keeps the real legacy seam as the pre-fix dispatch baseline", async () => {
    // The unavailable guard is the seam's first statement, so this narrow deps bag proves no later dependency is touched.
    const ensureWorkflowMergeBoundaryTask = vi.fn();
    const realSeams = createAuthoritativeWorkflowSeams({
      mergeRequester: undefined,
      ensureWorkflowMergeBoundaryTask,
    } as any, {} as any);
    const merge = vi.fn(realSeams.merge);
    const buildPrimitiveContext = vi.fn();
    const handler = createMergeAttemptHandler({
      seams: { merge },
      buildPrimitiveContext,
    });

    await expect(handler(node, createHandlerContext())).resolves.toEqual({
      outcome: "failure",
      value: "merge-unavailable",
    });
    expect(merge).toHaveBeenCalledWith(task, context, signal);
    expect(buildPrimitiveContext).not.toHaveBeenCalled();
    expect(ensureWorkflowMergeBoundaryTask).not.toHaveBeenCalled();
  });

  it("keeps both real dispatch paths on the merge-unavailable literal", async () => {
    const requestMerge = vi.fn().mockResolvedValue({
      outcome: "failure",
      value: "merge-unavailable",
      data: { status: "failed", reason: "merge-unavailable" },
    });
    const buildPrimitiveContext = vi.fn().mockReturnValue({
      run: { runId: "run-9170", taskId: task.id, workflowId: "builtin:coding" },
      node: { node },
    });
    const handler = createMergeAttemptHandler({
      primitives: { requestMerge, audit: vi.fn() } as any,
      seams: { merge: vi.fn() },
      buildPrimitiveContext,
    });

    await expect(handler(node, createHandlerContext())).resolves.toEqual({
      outcome: "failure",
      value: "merge-unavailable",
      contextPatch: { "workflow:merge-status": "merge-unavailable" },
    });
    expect(requestMerge).toHaveBeenCalledTimes(1);
  });

  it("keeps merge-unavailable readable but non-terminal across merge graph node ids", () => {
    for (const nodeId of ["merge-attempt", "merge"]) {
      expect(graphFailureValue({
        visitedNodeIds: [nodeId],
        context: { [`node:${nodeId}:value`]: "merge-unavailable" },
      } as any)).toBe("merge-unavailable");
    }
    for (const nodeId of ["merge-attempt", "merge", "requestMerge", "merge-gate", "merge-retry", "merge-manual-hold"]) {
      expect(isMergeGraphFailure(nodeId)).toBe(true);
    }
    expect(isTerminalMergeGraphFailureValue("merge-unavailable")).toBe(false);
  });

  it("does not route unavailable merge infrastructure to a retry", async () => {
    const ensureWorkflowMergeBoundaryTask = vi.fn();
    const updateTask = vi.fn();
    const logEntry = vi.fn();

    // This non-terminal literal is deliberate: the absent requester is the first retry guard.
    await expect(routeGraphMergeFailureToRetry({
      store: { updateTask, logEntry } as any,
      getRunContextFor: () => undefined,
      mergeRequester: undefined,
      ensureWorkflowMergeBoundaryTask,
      persistTokenUsage: vi.fn(),
    }, task, {
      visitedNodeIds: ["merge-attempt"],
      context: { "node:merge-attempt:value": "merge-unavailable" },
    } as any, undefined)).resolves.toBe(false);

    expect(ensureWorkflowMergeBoundaryTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalled();
  });
});

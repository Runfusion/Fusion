import { describe, expect, it } from "vitest";
import {
  BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR,
  BUILTIN_STEPWISE_CODING_WORKFLOW_IR,
  FAST_LANE_STEP_NAME,
  type TaskDetail,
  type TaskStep,
  type WorkflowIr,
  type WorkflowIrNode,
} from "@fusion/core";

import { runForeach } from "../workflows/workflow-graph-foreach.js";
import { FOREACH_ACTIVE_CONTEXT_KEY, type ForeachActiveContext } from "../workflows/workflow-node-handlers.js";

function builtinForeach(ir: WorkflowIr, isolation: "shared" | "worktree"): WorkflowIrNode {
  const node = ir.nodes.find((candidate) => candidate.kind === "foreach" && candidate.config?.source === "task-steps");
  if (!node) throw new Error("Expected a task-steps foreach in the built-in workflow");
  return {
    ...node,
    config: { ...node.config, isolation, mode: "sequential" },
  };
}

async function runRoute(options: {
  ir?: WorkflowIr;
  executionMode: "fast" | "standard";
  isolation: "shared" | "worktree";
  steps?: TaskStep[];
}) {
  const steps = options.steps ?? [{ name: FAST_LANE_STEP_NAME, status: "pending" as const }];
  const task = {
    id: `FN-252-foreach-${options.executionMode}-${options.isolation}`,
    executionMode: options.executionMode,
    steps,
  } as TaskDetail;
  const deferred: boolean[] = [];
  const observedVerdicts: Array<ForeachActiveContext["verdict"]> = [];
  const pinnedCounts: number[] = [];
  let executeCount = 0;
  let reviewCount = 0;

  const context: Record<string, unknown> = {};
  const result = await runForeach(
    builtinForeach(options.ir ?? BUILTIN_STEPWISE_CODING_WORKFLOW_IR, options.isolation),
    {
      task,
      runId: `${task.id}:run`,
      steps,
      getLiveSteps: () => steps,
      context,
      runTemplateNode: async (node, _signal, contextOverride) => {
        const nodeContext = contextOverride ?? context;
        const active = nodeContext[FOREACH_ACTIVE_CONTEXT_KEY] as ForeachActiveContext;
        if (node.id === "step-execute") {
          executeCount += 1;
          deferred.push(active.deferDoneToReview === true);
          observedVerdicts.push(active.verdict);
          if (options.isolation === "shared" && active.deferDoneToReview !== true) {
            steps[active.stepIndex]!.status = "done";
          }
          return { outcome: "success" as const, value: "step-done" };
        }
        if (node.kind === "step-review") {
          reviewCount += 1;
          // Standard review remains the done authority in shared isolation.
          if (options.isolation === "shared") steps[active.stepIndex]!.status = "done";
          return { outcome: "success" as const, value: "approve" };
        }
        return { outcome: "success" as const };
      },
      persistence: {
        saveInstanceState: (state) => { pinnedCounts.push(state.pinnedStepCount); },
      },
      shouldTraverseEdge: (edge, source) => !edge.condition
        ? source.outcome === "success"
        : edge.condition === "success"
          ? source.outcome === "success"
          : edge.condition.startsWith("outcome:")
            ? source.value === edge.condition.slice("outcome:".length)
            : source.outcome === "failure",
      ...(options.isolation === "worktree" ? {
        allocateInstanceWorktree: async (stepIndex: number) => ({
          worktreePath: `/tmp/fn-252-step-${stepIndex}`,
          branchName: `fusion/fn-252-step-${stepIndex}`,
        }),
        resolveIntegrationBase: async () => "base",
        integrationGitOps: {
          integrate: async () => ({ kind: "integrated" as const, integratedAt: "2026-08-29T00:00:00.000Z" }),
          discardBranch: async () => {},
        },
        integrationProjection: {
          markStepDone: async (stepIndex: number) => {
            steps[stepIndex]!.status = "done";
          },
        },
      } : {}),
    },
  );

  return { result, steps, deferred, observedVerdicts, pinnedCounts, executeCount, reviewCount };
}

describe("FN-252 Fast foreach route", () => {
  it.each(["shared", "worktree"] as const)("executes exactly one Fast step without dispatching step review under %s isolation", async (isolation) => {
    const route = await runRoute({ executionMode: "fast", isolation });

    expect(route.result).toMatchObject({ outcome: "success" });
    expect(route.executeCount).toBe(1);
    expect(route.reviewCount).toBe(0);
    expect(route.deferred).toEqual([false]);
    expect(route.observedVerdicts).toEqual([undefined]);
    expect(route.pinnedCounts.every((count) => count === 1)).toBe(true);
    expect(route.steps).toEqual([{ name: FAST_LANE_STEP_NAME, status: "done" }]);
    // This is the anti-no-op proof: a Fast foreach success always includes an implementation occurrence.
    expect(route.result.visitedNodeIds).toContain("steps#0:step-execute");
  });

  it.each(["shared", "worktree"] as const)("fails Fast empty expansion instead of silently succeeding under %s isolation", async (isolation) => {
    const route = await runRoute({ executionMode: "fast", isolation, steps: [] });

    expect(route.result).toMatchObject({ outcome: "failure", value: "fast-lane-empty-steps" });
    expect(route.executeCount).toBe(0);
    expect(route.reviewCount).toBe(0);
    expect(route.pinnedCounts).toEqual([]);
    expect(route.result.visitedNodeIds).toEqual([]);
  });

  it.each(["shared", "worktree"] as const)("keeps standard step review and deferred done-marking under %s isolation", async (isolation) => {
    const route = await runRoute({ executionMode: "standard", isolation });

    expect(route.result).toMatchObject({ outcome: "success" });
    expect(route.executeCount).toBe(1);
    expect(route.reviewCount).toBe(1);
    expect(route.deferred).toEqual([true]);
    expect(route.steps[0]?.status).toBe("done");
  });

  it("leaves a no-step-review template byte-equivalent across Fast and standard routes", async () => {
    const fast = await runRoute({ ir: BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR, executionMode: "fast", isolation: "shared" });
    const standard = await runRoute({ ir: BUILTIN_CODING_IDEAS_V2_WORKFLOW_IR, executionMode: "standard", isolation: "shared" });

    expect(fast.deferred).toEqual([false]);
    expect(standard.deferred).toEqual([false]);
    expect(fast.reviewCount).toBe(0);
    expect(standard.reviewCount).toBe(0);
    expect(fast.steps).toEqual(standard.steps);
  });
});

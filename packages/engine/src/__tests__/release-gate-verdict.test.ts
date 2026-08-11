import { describe, expect, it } from "vitest";
import type { WorkflowIr } from "@fusion/core";
import { evaluateTaskReleaseGate, evaluateUnplannedForExecution, isUnplannedForExecution } from "../execution/hold-release.js";

function ir(withReview = true): WorkflowIr {
  return {
    version: "v2", name: "gate", columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "Progress", traits: [{ trait: "wip" }] },
    ],
    nodes: [{ id: "start", kind: "start", column: "todo" }, ...(withReview ? [{ id: "plan-review", kind: "optional-group" as const, column: "todo", config: { defaultOn: true, template: { nodes: [], edges: [] } } }] : [])],
    edges: [],
  } as WorkflowIr;
}

describe("release-gate verdict", () => {
  it("reports an omitted plan-review node as releasable", async () => {
    const task = { id: "T-1", description: "real", column: "todo", updatedAt: "2026-08-11T00:00:00.000Z" } as any;
    const verdict = await evaluateTaskReleaseGate({ getTasksDir: () => "/missing" } as any, task, { ir: ir(false) });
    expect(verdict).toMatchObject({ promoteBlocked: false, unplannedForExecution: false, readyAtCapacityBoundary: false, evaluatedForUpdatedAt: task.updatedAt });
    expect(verdict?.planReview).toBeUndefined();
    expect(Number.isFinite(Date.parse(verdict!.evaluatedAt))).toBe(true);
  });

  it("reports a plan-in-place default-on gate and preserves boolean equivalence", async () => {
    const task = { id: "T-2", description: "real", column: "todo" } as any;
    const store = {} as any;
    const result = await evaluateUnplannedForExecution(store, task, ir());
    const verdict = await evaluateTaskReleaseGate(store, task, { ir: ir() });
    expect(result).toMatchObject({ unplanned: true, reason: "plan-review-pending", readyAtCapacityBoundary: false });
    await expect(isUnplannedForExecution(store, task, ir())).resolves.toBe(result.unplanned);
    expect(verdict).toMatchObject({ promoteBlocked: true, reason: "plan-review-pending", blockedOnApproval: false });
  });

  it("treats a capacity continuation as plan-review readiness", async () => {
    const task = { id: "T-3", description: "real", column: "todo" } as any;
    const store = { listWorkflowWorkItemsForTask: async () => [{ state: "held", waitReason: "capacity", sourceColumn: "todo" }] } as any;
    await expect(evaluateTaskReleaseGate(store, task, { ir: ir() })).resolves.toMatchObject({ promoteBlocked: false, readyAtCapacityBoundary: true });
  });
});

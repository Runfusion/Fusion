import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { ProjectEngine } from "../project-engine.js";

vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  resolveWorkflowIrForTask: async (store: { workflowIr: unknown }) => store.workflowIr,
}));

describe("overseer contained failed execution recovery", () => {
  it.each(["working", "repair", "review"].flatMap((column) =>
    ["unchanged", "paused", "live", "changed"].map((state) => [column, state] as const),
  ))("checks task workflow role and write races for %s / %s", async (column, state) => {
    const eligible = column !== "review";
    const expectedResume = eligible && state === "unchanged";
    const task = {
      id: "FN-9349", column, status: "failed", error: "completion refused",
      updatedAt: "before", taskDoneRetryCount: 3, worktree: "/repo/repair", branch: "fusion/fn-9349",
      steps: [{ name: "Required evidence", status: "pending" }],
    } as Task;
    const original = structuredClone(task);
    let live = false;
    const appliedPatches: Array<Partial<Task>> = [];
    const store = {
      workflowIr: {
        version: "v2", name: "Two implementation lanes", nodes: [], edges: [],
        columns: [
          { id: "working", name: "Build", traits: [{ trait: "wip" }] },
          { id: "repair", name: "Repair", traits: [{ trait: "wip" }] },
          { id: "review", name: "Review", traits: [{ trait: "review" }] },
        ],
      },
      logEntry: vi.fn().mockResolvedValue(undefined),
      /*
      FNXC:OverseerRecovery 2026-09-24-16:50:
      FN-9362 made contained recovery re-read the durable row before choosing a lifecycle target.
      This fixture models that reader from the same mutable task used by its atomic race states,
      so unchanged, paused, live, and changed outcomes remain observable under the production fence.
      */
      getTask: vi.fn(async () => structuredClone(task)),
      updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task> | null) => {
        if (state === "paused") Object.assign(task, { userPaused: true });
        if (state === "live") live = true;
        if (state === "changed") task.updatedAt = "after";
        const patch = update(task);
        if (patch) { appliedPatches.push(patch); Object.assign(task, patch); }
      }),
    };
    const engine = Object.create(ProjectEngine.prototype) as any;
    engine.runtime = { getExecutor: () => ({ isTaskLiveForOverseerRetry: () => live }) };
    engine.plannerLiveRetrySkipLogDedup = new Set();
    engine.emitOverseerInterventionSafe = vi.fn();
    const handlers = engine.buildPlannerRecoveryHandlers(store);
    const result = await handlers.retryStep(original, {
      watchedStage: "executor", reason: "failed", attemptCount: 0, attemptLimit: 3, sourceLinks: [],
    });
    expect(result).toBe(expectedResume);
    expect(task.status).toBe(expectedResume ? "queued" : "failed");
    expect(task.error).toBe(expectedResume ? null : "completion refused");
    expect(task.column).toBe(column);
    expect(appliedPatches).toHaveLength(expectedResume ? 1 : 0);
    expect(task.worktree).toBe(original.worktree);
    expect(task.branch).toBe(original.branch);
    expect(task.steps).toEqual(original.steps);
    expect(task.taskDoneRetryCount).toBe(3);
  });
});

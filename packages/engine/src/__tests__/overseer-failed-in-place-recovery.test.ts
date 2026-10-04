import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { ProjectEngine } from "../project-engine.js";

vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  resolveWorkflowIrForTask: async (store: { workflowIr: unknown }) => store.workflowIr,
}));

describe("overseer contained failed execution recovery", () => {
  it.each(["working", "repair", "review"].flatMap((column) =>
    ["unchanged", "paused", "live", "changed", "active", "seed-race", "global-pause", "engine-pause", "seed-error", "missing-pin", "wrong-pin", "wrong-column", "task-paused", "deleted", "reset-during-seed"].map((state) => [column, state] as const),
  ))("checks task workflow role and write races for %s / %s", async (column, state) => {
    const eligible = column !== "review";
    const expectedResume = eligible && state === "unchanged";
    const task = {
      id: "FN-9349", column, status: "failed", error: "completion refused",
      workflowIrPinNodeId: "steps", updatedAt: "before", taskDoneRetryCount: 3, worktree: "/repo/repair", branch: "fusion/fn-9349",
      steps: [{ name: "Required evidence", status: "pending" }],
    } as Task;
    if (state === "missing-pin") task.workflowIrPinNodeId = undefined;
    if (state === "wrong-pin") task.workflowIrPinNodeId = "review-node";
    const original = structuredClone(task);
    let live = false;
    const appliedPatches: Array<Partial<Task>> = [];
    const store = {
      workflowIr: {
        version: "v2", name: "Two implementation lanes", nodes: [{ id: "steps", kind: "foreach", column: state === "wrong-column" ? "other" : column }], edges: [],
        columns: [
          { id: "working", name: "Build", traits: [{ trait: "wip" }] },
          { id: "repair", name: "Repair", traits: [{ trait: "wip" }] },
          { id: "review", name: "Review", traits: [{ trait: "review" }] },
        ],
      },
      logEntry: vi.fn(async () => { task.updatedAt = "log-updated"; }),
      getSettings: vi.fn(async () => ({ globalPause: state === "global-pause", enginePaused: state === "engine-pause" })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => null),
      listWorkflowWorkItemsForTask: vi.fn(async () => []),
      seedWorkspaceCodeReviewContinuationIfIdle: vi.fn(async () => {
        if (state === "seed-error") throw new Error("durable seed unavailable");
        if (state === "reset-during-seed") Object.assign(task, { updatedAt: "reset", userPaused: true });
        return { seeded: state !== "active" && state !== "seed-race" };
      }),
      getTask: vi.fn(async () => structuredClone(task)),
      updateTaskAtomic: vi.fn(async (_id: string, update: (current: Task) => Partial<Task> | null | Promise<Partial<Task> | null>, _context: unknown, shouldPersist: () => boolean, fence: { expectedUpdatedAt: string }) => {
        if (state === "paused") Object.assign(task, { userPaused: true });
        if (state === "task-paused") Object.assign(task, { paused: true });
        if (state === "deleted") Object.assign(task, { deletedAt: "deleted" });
        if (state === "live") live = true;
        if (state === "changed") task.updatedAt = "after";
        const snapshot = structuredClone(task);
        const patch = await update(snapshot);
        if (patch && shouldPersist() && task.updatedAt === fence.expectedUpdatedAt) {
          appliedPatches.push(patch); Object.assign(task, patch);
          return structuredClone(task);
        }
        return snapshot;
      }),
    };
    const engine = Object.create(ProjectEngine.prototype) as any;
    engine.runtime = { getExecutor: () => ({ isTaskLiveForOverseerRetry: () => live }) };
    engine.plannerLiveRetrySkipLogDedup = new Set();
    engine.emitOverseerInterventionSafe = vi.fn();
    const handlers = engine.buildPlannerRecoveryHandlers(store);
    const attempt = handlers.retryStep(original, {
      watchedStage: "executor", reason: "failed", attemptCount: 0, attemptLimit: 3, sourceLinks: [],
    });
    if (eligible && state === "seed-error") {
      await expect(attempt).rejects.toThrow("durable seed unavailable");
    } else {
      expect(await attempt).toBe(expectedResume);
    }
    expect(task.status).toBe(expectedResume ? "queued" : "failed");
    expect(task.error).toBe(expectedResume ? null : "completion refused");
    expect(task.column).toBe(column);
    expect(appliedPatches).toHaveLength(expectedResume ? 1 : 0);
    expect(task.worktree).toBe(original.worktree);
    expect(task.branch).toBe(original.branch);
    expect(task.steps).toEqual(original.steps);
    expect(task.taskDoneRetryCount).toBe(3);
    expect(store.logEntry).not.toHaveBeenCalled();
    if (expectedResume) {
      expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledWith(expect.objectContaining({
        taskId: task.id, nodeId: "steps", sourceColumn: column, targetColumn: column,
        expectedTaskUpdatedAt: "before", state: "runnable",
      }));
      expect(await handlers.retryStep(original, {
        watchedStage: "executor", reason: "failed", attemptCount: 0, attemptLimit: 3, sourceLinks: [],
      })).toBe(false);
      expect(store.seedWorkspaceCodeReviewContinuationIfIdle).toHaveBeenCalledTimes(1);
      expect(appliedPatches).toHaveLength(1);
    }
  });
});

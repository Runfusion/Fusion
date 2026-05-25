import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SelfHealingManager } from "../../self-healing.js";

type TestTask = any;

function makeTask(overrides: Record<string, unknown>): TestTask {
  return {
    id: "FN-X",
    title: "task",
    description: "",
    column: "todo",
    status: null,
    mergeRetries: 0,
    paused: false,
    worktree: null,
    blockedBy: null,
    dependencies: [],
    log: [],
    steps: [],
    updatedAt: "2026-05-22T00:00:00.000Z",
    createdAt: "2026-05-22T00:00:00.000Z",
    ...overrides,
  };
}

function createStore(tasks: TestTask[], leakDeleted = false) {
  const taskMap = new Map(tasks.map((task) => [task.id, { ...task }]));
  const store = {
    getSettings: vi.fn().mockResolvedValue({
      globalPause: false,
      enginePaused: false,
      autoMerge: true,
      taskStuckTimeoutMs: 60_000,
      inReviewStalledThresholdMs: 60_000,
      stalePausedReviewThresholdMs: 60_000,
      engineActiveSinceMs: null,
      engineActivationGraceMs: 0,
      inReviewStallDeadlockThreshold: 3,
    }),
    listTasks: vi.fn(async (options?: { column?: string; includeDeleted?: boolean }) => {
      return [...taskMap.values()]
        .filter((task) => (options?.column ? task.column === options.column : true))
        .filter((task) => (options?.includeDeleted || leakDeleted ? true : !task.deletedAt))
        .map((task) => ({ ...task }));
    }),
    getTask: vi.fn(async (id: string, options?: { includeDeleted?: boolean }) => {
      const task = taskMap.get(id);
      if (!task) throw new Error("not found");
      if (!options?.includeDeleted && task.deletedAt) throw new Error("not found");
      return { ...task };
    }),
    updateTask: vi.fn(async () => ({})),
    moveTask: vi.fn(async () => ({})),
    logEntry: vi.fn(async () => ({})),
    recordRunAuditEvent: vi.fn(async () => ({})),
  };
  return store as any;
}

describe("reliability interactions: FN-5566/FN-5528 soft-delete deadlock scan exclusion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T02:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores soft-deleted in-review deadlock candidates when listTasks excludes deleted rows", async () => {
    const deleted = makeTask({
      id: "FN-DELETED",
      column: "in-review",
      status: "failed",
      mergeRetries: 3,
      paused: false,
      worktree: "/tmp/wt-deleted",
      deletedAt: "2026-05-20T05:50:51.015Z",
    });
    const dependent = makeTask({ id: "FN-DEP", column: "todo", blockedBy: "FN-DELETED" });
    const store = createStore([deleted, dependent], false);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.recoverStuckMergeDeadlocks()).toBe(0);
    expect(await manager.recoverMergedReviewTasks()).toBe(0);
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(await manager.surfaceInReviewStalled()).toBe(0);
    expect(await manager.surfaceStalePausedReviews()).toBe(0);

    expect(store.updateTask).not.toHaveBeenCalledWith("FN-DELETED", expect.anything());
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-DELETED", expect.anything(), expect.anything());
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-DELETED", expect.anything(), expect.anything());
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("defensive guards skip leaked soft-deleted in-review rows", async () => {
    const deleted = makeTask({
      id: "FN-DELETED",
      column: "in-review",
      status: "failed",
      mergeRetries: 3,
      paused: false,
      worktree: "/tmp/wt-deleted",
      deletedAt: "2026-05-20T05:50:51.015Z",
    });
    const store = createStore([deleted], true);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.recoverStuckMergeDeadlocks()).toBe(0);
    expect(await manager.recoverMergedReviewTasks()).toBe(0);
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(await manager.surfaceInReviewStalled()).toBe(0);
    expect(await manager.surfaceStalePausedReviews()).toBe(0);

    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("still evaluates active stuck-merge tasks without deletedAt", async () => {
    const live = makeTask({
      id: "FN-LIVE",
      column: "in-review",
      status: "failed",
      mergeRetries: 3,
      paused: false,
      worktree: "/tmp/wt-live",
      updatedAt: "2026-05-21T00:00:00.000Z",
    });
    const store = createStore([live], false);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    const landedSpy = vi.spyOn(manager as any, "findLandedTaskCommit").mockResolvedValue(null);
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: false });

    await manager.recoverStuckMergeDeadlocks();

    expect(landedSpy).toHaveBeenCalled();
  });

  it("preserves clearStaleBlockedBy soft-deleted-blocker branch", async () => {
    const deleted = makeTask({
      id: "FN-DELETED",
      column: "archived",
      status: "failed",
      mergeRetries: 3,
      deletedAt: "2026-05-20T05:50:51.015Z",
    });
    const dependent = makeTask({ id: "FN-DEP", column: "todo", blockedBy: "FN-DELETED" });
    const store = createStore([deleted, dependent], false);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    const repaired = await manager.clearStaleBlockedBy();

    expect(repaired).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-DEP", expect.objectContaining({ blockedBy: null }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-DEP",
      expect.stringContaining("soft-deleted-blocker"),
    );
  });
});

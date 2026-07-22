import { beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import { TaskExecutor } from "../../executor.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import { ActiveSessionWorktreeRemovalError, RemovalReason } from "../../worktree/worktree-backend.js";
import { executorLog } from "../../logger.js";
import { WorktreePool } from "../../worktree/worktree-pool.js";
import * as worktreePoolModule from "../../worktree/worktree-pool.js";
import { createMockStore, mockedExistsSync, resetExecutorMocks } from "../executor-test-helpers.js";

const ROOT = "/tmp/test";
const PATH = "/tmp/test/.worktrees/fn-5346";
const TASK_ID = "FN-5346";

describe("FN-5346 reliability interactions: post-completion stale self-owned binding", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.restoreAllMocks();
    activeSessionRegistry.clear();
    mockedExistsSync.mockReturnValue(true);
  });

  it("reconciles stale same-task registry entry during cleanup()", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).addActiveWorktree(TASK_ID, PATH);
    activeSessionRegistry.registerPath(PATH, { taskId: TASK_ID, kind: "executor", ownerKey: TASK_ID });
    (activeSessionRegistry.lookupByPath(PATH) as any).registeredAt = 0;
    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);

    await executor.cleanup(TASK_ID);

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(activeSessionRegistry.lookupByPath(PATH)).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(
      TASK_ID,
      "Cleared stale self-owned active-session entry before remove",
      PATH,
    );
    expect((executorLog.warn as any).mock.calls.some((call: unknown[]) => String(call[0]).includes("[FN-5346]"))).toBe(true);
  });

  it("recovers same stale registry entry on first attempt after restart-style fresh executor", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    activeSessionRegistry.registerPath(PATH, { taskId: TASK_ID, kind: "executor", ownerKey: TASK_ID });
    (activeSessionRegistry.lookupByPath(PATH) as any).registeredAt = 0;
    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);

    await (executor as any).handleDepAbortCleanup(TASK_ID, PATH);

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(activeSessionRegistry.lookupByPath(PATH)).toBeNull();
  });

  it("preserves refusal for truly-live same-task bindings", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).addActiveWorktree(TASK_ID, PATH);
    activeSessionRegistry.registerPath(PATH, { taskId: TASK_ID, kind: "executor", ownerKey: TASK_ID });
    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new ActiveSessionWorktreeRemovalError({
        worktreePath: PATH,
        taskId: TASK_ID,
        kind: "executor",
        ownerKey: TASK_ID,
        reason: RemovalReason.ExecutorDispose,
      }),
    );

    await (executor as any).cleanupConflictingWorktree(PATH, "fusion/fn-5346", TASK_ID);

    expect(activeSessionRegistry.lookupByPath(PATH)?.taskId).toBe(TASK_ID);
    expect(store.logEntry).not.toHaveBeenCalledWith(
      TASK_ID,
      "Cleared stale self-owned active-session entry before remove",
      PATH,
    );
  });

  it("preserves FN-4811 refusal for foreign active owner", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([]);
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).addActiveWorktree("FN-FOREIGN", PATH);
    activeSessionRegistry.registerPath(PATH, { taskId: "FN-FOREIGN", kind: "executor", ownerKey: "FN-FOREIGN" });
    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);

    const cleaned = await (executor as any).cleanupConflictingWorktree(PATH, "fusion/fn-5346", TASK_ID);

    expect(cleaned).toBe(false);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(activeSessionRegistry.lookupByPath(PATH)?.taskId).toBe("FN-FOREIGN");
  });

  it("is idempotent across repeated cleanup sweeps", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).addActiveWorktree(TASK_ID, PATH);
    activeSessionRegistry.registerPath(PATH, { taskId: TASK_ID, kind: "executor", ownerKey: TASK_ID });
    (activeSessionRegistry.lookupByPath(PATH) as any).registeredAt = 0;
    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);

    await executor.cleanup(TASK_ID);
    (executor as any).addActiveWorktree(TASK_ID, PATH);
    await executor.cleanup(TASK_ID);

    const clearedCalls = (store.logEntry as any).mock.calls.filter(
      (call: unknown[]) => call[1] === "Cleared stale self-owned active-session entry before remove",
    );
    expect(clearedCalls).toHaveLength(1);
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves FN-4954 pool lease bookkeeping while reconciling stale registry", async () => {
    const pool = new WorktreePool();
    pool.rehydrate([PATH]);
    expect(pool.acquire(TASK_ID)).toBe(PATH);
    const beforeLeased = new Map(pool.getLeasedPaths());

    const store = createMockStore();
    const executor = new TaskExecutor(store, ROOT);
    (executor as any).addActiveWorktree(TASK_ID, PATH);
    activeSessionRegistry.registerPath(PATH, { taskId: TASK_ID, kind: "executor", ownerKey: TASK_ID });
    vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);

    await executor.cleanup(TASK_ID);

    expect(new Map(pool.getLeasedPaths())).toEqual(beforeLeased);
  });
});

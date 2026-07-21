import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { activeSessionRegistry } from "../active-session-registry.js";
import { ActiveSessionWorktreeRemovalError } from "../worktree-backend.js";
import * as worktreePoolModule from "../worktree-pool.js";
import * as branchConflictModule from "../branch-conflicts.js";
import { createMockStore, mockedGenerateWorktreeName, resetExecutorMocks } from "./executor-test-helpers.js";

const CONFLICT_PATH = "/tmp/test/.worktrees/stale-self-owned";

describe("FN-4973: executor worktree conflict cleanup", () => {
  beforeEach(() => {
    resetExecutorMocks();
    activeSessionRegistry.clear();
  });

  it("clears stale self-owned registry entry before removal", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-4973", kind: "executor", ownerKey: "FN-4973" });
    // FN-5256: backdate so the new min-idle window doesn't refuse the reconcile.
    (activeSessionRegistry.lookupByPath(CONFLICT_PATH) as any).registeredAt = 0;

    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree").mockResolvedValue(undefined);
    const result = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", "FN-4973");

    expect(result).toBe(true);
    expect(removeSpy).toHaveBeenCalled();
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)).toBeNull();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4973",
      "Cleared stale self-owned active-session entry before remove",
      CONFLICT_PATH,
    );
  });

  it("does not reconcile when same-task in-memory binding is live and refuses removal", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);
    (executor as any).addActiveWorktree("FN-4973", CONFLICT_PATH);
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-4973", kind: "executor", ownerKey: "FN-4973" });

    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new ActiveSessionWorktreeRemovalError({
        worktreePath: CONFLICT_PATH,
        taskId: "FN-4973",
        kind: "executor",
        ownerKey: "FN-4973",
        reason: worktreePoolModule.RemovalReason.ExecutorDispose,
      }),
    );

    const result = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", "FN-4973");
    expect(result).toBe(false);
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)?.taskId).toBe("FN-4973");
  });

  it("defers out-of-root reclaim instead of moving a live same-task checkout", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const outsidePath = "/tmp/legacy-worktrees/recover-fn-8400";
    const targetPath = "/tmp/test/.worktrees/recover-fn-8400";
    (executor as any).addActiveWorktree("FN-8400", outsidePath);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "reclaimable",
      livePath: outsidePath,
      tipSha: "abc123",
      taskAttributedCommitCount: 1,
      strandedCommits: [{ sha: "abc123", subject: "fix(FN-8400): preserve implementation" }],
    } as any);
    const relocate = vi.spyOn(worktreePoolModule, "relocateReclaimableWorktreeIntoRoot");

    const result = await (executor as any).handleWorktreeConflict(
      outsidePath,
      "fusion/fn-8400",
      targetPath,
      "FN-8400",
      "main",
      0,
      false,
      {},
    );

    expect(result).toEqual({ path: outsidePath, branch: "fusion/fn-8400" });
    expect(relocate).toHaveBeenCalledWith(expect.objectContaining({
      sourcePath: outsidePath,
      targetPath,
      taskId: "FN-8400",
    }));
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-8400",
      expect.stringContaining("deferred relocation of active preserved worktree"),
      outsidePath,
    );
  });

  it("does not reconcile foreign-task registry entries and keeps refusal behavior", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-OTHER", kind: "executor", ownerKey: "FN-OTHER" });

    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new ActiveSessionWorktreeRemovalError({
        worktreePath: CONFLICT_PATH,
        taskId: "FN-OTHER",
        kind: "executor",
        ownerKey: "FN-OTHER",
        reason: worktreePoolModule.RemovalReason.ExecutorDispose,
      }),
    );

    const result = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", "FN-4973");
    expect(result).toBe(false);
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)?.taskId).toBe("FN-OTHER");
  });

  it("recovers a genuine orphan dir when git reports 'is not a working tree'", async () => {
    // FN-6782: a leaked orphan dir (dir on disk, admin entry gone) makes `git worktree remove`
    // fail with "is not a working tree". The stale-path recovery should prune, clean up, and
    // return true so fresh creation can proceed.
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);

    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new Error("fatal: '/tmp/test/.worktrees/stale-self-owned' is not a working tree"),
    );

    const result = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", "FN-4973");

    expect(result).toBe(true);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4973",
      expect.stringContaining("Cleaned up stale conflicting worktree"),
      CONFLICT_PATH,
    );
  });

  it("refuses stale-path cleanup (no force-rm) for a conflict path outside .worktrees/", async () => {
    // Security regression: the recovery's rm must be bounded to .worktrees/. A git admin entry
    // can point anywhere; an out-of-bounds path must be refused, not force-removed.
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);
    const OUTSIDE_PATH = "/tmp/test/not-worktrees/escapee";

    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new Error("fatal: '/tmp/test/not-worktrees/escapee' is not a working tree"),
    );

    const result = await (executor as any).cleanupConflictingWorktree(OUTSIDE_PATH, "fusion/fn-4973", "FN-4973");

    expect(result).toBe(false);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-4973",
      expect.stringContaining("Refused stale-path cleanup"),
      OUTSIDE_PATH,
    );
  });

  it("falls back to a fresh sibling branch for a DB-only live owner", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      executorAllowSiblingBranchRename: true,
    });
    store.listTasks.mockResolvedValue([
      { id: "FN-LIVE", worktree: CONFLICT_PATH, column: "in-progress", paused: false },
    ]);
    mockedGenerateWorktreeName.mockReturnValueOnce("fresh-eagle");
    const executor = new TaskExecutor(store, "/tmp/test");
    const createSpy = vi.spyOn(executor as any, "tryCreateWorktree").mockResolvedValue({
      path: "/tmp/test/.worktrees/fresh-eagle",
      branch: "fusion/fn-4973-2",
    });

    const result = await (executor as any).handleWorktreeConflict(
      CONFLICT_PATH,
      "fusion/fn-4973",
      "/tmp/test/.worktrees/stale-self-owned",
      "FN-4973",
      "main",
      0,
      true,
      await store.getSettings(),
    );

    expect(result).toEqual({ path: "/tmp/test/.worktrees/fresh-eagle", branch: "fusion/fn-4973-2" });
    expect(createSpy).toHaveBeenCalledWith(
      "fusion/fn-4973-2",
      "/tmp/test/.worktrees/fresh-eagle",
      "FN-4973",
      "fusion/fn-4973",
      0,
      0,
      true,
      expect.any(Object),
    );
  });

  it("keeps non-live cleanup failures unrecoverable", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);
    vi.spyOn(executor as any, "cleanupConflictingWorktree").mockResolvedValue(false);

    const result = await (executor as any).handleWorktreeConflict(
      CONFLICT_PATH,
      "fusion/fn-4973",
      "/tmp/test/.worktrees/stale-self-owned",
      "FN-4973",
      "main",
      0,
      true,
      await store.getSettings(),
    );

    expect(result).toBeNull();
  });

  it("bounds fresh sibling fallback when every generated branch is already used", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);
    activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-4973", kind: "workflow-step", ownerKey: "FN-4973/workflow-step" });
    (executor as any).addActiveWorktree("FN-4973", CONFLICT_PATH);
    mockedGenerateWorktreeName
      .mockReturnValueOnce("fresh-2")
      .mockReturnValueOnce("fresh-3")
      .mockReturnValueOnce("fresh-4")
      .mockReturnValueOnce("fresh-5")
      .mockReturnValueOnce("fresh-6");
    vi.spyOn(worktreePoolModule, "removeWorktree").mockRejectedValue(
      new ActiveSessionWorktreeRemovalError({
        worktreePath: CONFLICT_PATH,
        taskId: "FN-4973",
        kind: "workflow-step",
        ownerKey: "FN-4973/workflow-step",
        reason: worktreePoolModule.RemovalReason.ExecutorDispose,
      }),
    );
    vi.spyOn(executor as any, "tryCreateWorktree").mockImplementation(async (branch: string) => {
      throw new Error(`fatal: '${branch}' is already used by worktree at '/tmp/test/.worktrees/other'`);
    });

    await expect((executor as any).handleWorktreeConflict(
      CONFLICT_PATH,
      "fusion/fn-4973",
      "/tmp/test/.worktrees/stale-self-owned",
      "FN-4973",
      "main",
      0,
      true,
      await store.getSettings(),
    )).rejects.toThrow(/live conflicting worktree .* was preserved and suffixes -2 through -6/);
  });

  it("reconciles once on race-window ActiveSessionWorktreeRemovalError then retries removal", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    store.listTasks.mockResolvedValue([]);

    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree");
    removeSpy
      .mockImplementationOnce(async () => {
        activeSessionRegistry.registerPath(CONFLICT_PATH, { taskId: "FN-4973", kind: "executor", ownerKey: "FN-4973" });
        // FN-5256: backdate so the post-throw reconcile is not refused by min-idle.
        (activeSessionRegistry.lookupByPath(CONFLICT_PATH) as any).registeredAt = 0;
        throw new ActiveSessionWorktreeRemovalError({
          worktreePath: CONFLICT_PATH,
          taskId: "FN-4973",
          kind: "executor",
          ownerKey: "FN-4973",
          reason: worktreePoolModule.RemovalReason.ExecutorDispose,
        });
      })
      .mockResolvedValueOnce(undefined);

    const result = await (executor as any).cleanupConflictingWorktree(CONFLICT_PATH, "fusion/fn-4973", "FN-4973");

    expect(result).toBe(true);
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(activeSessionRegistry.lookupByPath(CONFLICT_PATH)).toBeNull();
  });
});

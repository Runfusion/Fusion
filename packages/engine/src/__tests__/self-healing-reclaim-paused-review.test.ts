import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import * as branchConflicts from "../branch-conflicts.js";
import * as worktreePool from "../worktree-pool.js";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false });
  (emitter as any).listTasks = vi.fn();
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).handoffToReview = vi.fn().mockImplementation(async (taskId: string) => {
    await (emitter as any).moveTask(taskId, "in-review");
  });
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

describe("self-healing reclaim paused review", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test" });
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  it("reclaims paused in-review branch conflict, clears paused state, and requeues to todo with audit metadata", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-4485", column: "in-review", checkedOutBy: null, branch: "fusion/fn-4485", worktree: "/tmp/fn-4485", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed", lineageId: "lin-1" },
      ]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "reclaimable",
      livePath: "/tmp/fn-4485",
      tipSha: "abc123def456",
      taskAttributedCommitCount: 0,
      strandedCommits: [],
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4485", expect.objectContaining({ paused: false, pausedReason: undefined, status: null, error: null }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-4485", "todo", expect.objectContaining({ moveSource: "engine" }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-4485", expect.stringContaining("[recovery] reclaim-paused-review"));
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "branch:auto-reclaim",
      metadata: expect.objectContaining({ recoveredFromPaused: true, previousPausedReason: "branch-conflict-unrecoverable" }),
    }));
  });

  it("reclaims paused in-progress branch-conflict task without moving columns", async () => {
    const activeStore = { listActiveHeartbeatRuns: vi.fn().mockResolvedValue([{ startedAt: new Date().toISOString(), contextSnapshot: { taskId: "FN-9998" } }]) } as any;
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test", agentStore: activeStore });
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);

    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-4486", column: "in-progress", checkedOutBy: null, branch: "fusion/fn-4486", worktree: "/tmp/fn-4486", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" },
        { id: "FN-9998", column: "in-progress", checkedOutBy: null, branch: "fusion/fn-9998", worktree: "/tmp/fn-9998", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" },
      ])
      .mockResolvedValueOnce([]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "fully-subsumed", livePath: "/tmp/fn-4486", tipSha: "abc123def456" } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-4486", "todo", expect.anything());
    expect((store.updateTask as any).mock.calls.some((call: any[]) => call[0] === "FN-9998")).toBe(false);
  });

  it("leaves foreign conflicts parked", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-4487", column: "in-review", checkedOutBy: null, branch: "fusion/fn-4487", worktree: "/tmp/fn-4487", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" },
      ]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "live-foreign",
      livePath: "/tmp/foreign",
      error: new Error("foreign owner"),
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(store.moveTask).toHaveBeenCalledWith("FN-4487", "in-review");
  });

  it("does not reclaim userPaused tasks without branch-conflict paused reason", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([
        { id: "FN-4488", column: "todo", checkedOutBy: null, branch: "fusion/fn-4488", worktree: "/tmp/fn-4488", userPaused: true, paused: true, pausedReason: undefined },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const inspectSpy = vi.spyOn(branchConflicts, "inspectBranchConflict");
    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
  });

  it("does not reclaim userPaused tasks even when pausedReason is branch-conflict-unrecoverable", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-4490", column: "in-progress", checkedOutBy: null, branch: "fusion/fn-4490", worktree: "/tmp/fn-4490", userPaused: true, paused: true, pausedReason: "branch-conflict-unrecoverable" },
      ])
      .mockResolvedValueOnce([]);

    const inspectSpy = vi.spyOn(branchConflicts, "inspectBranchConflict");
    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
  });
});

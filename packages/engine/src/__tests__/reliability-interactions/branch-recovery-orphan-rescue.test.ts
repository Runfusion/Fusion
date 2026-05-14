import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import * as branchConflicts from "../../branch-conflicts.js";
import * as worktreePool from "../../worktree-pool.js";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false });
  (emitter as any).listTasks = vi.fn();
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  (emitter as any).createTask = vi.fn();
  (emitter as any).clearStaleExecutionStartBranchReferences = vi.fn().mockReturnValue([]);
  return emitter;
}

describe("reliability interactions: branch recovery + orphan rescue", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  it("keeps userPaused tasks unswept even if reclaimable", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([{ id: "FN-4429", column: "todo", checkedOutBy: null, branch: "fusion/fn-4429", worktree: "/tmp/fn-4429", paused: true, userPaused: true, pausedReason: "branch-conflict-unrecoverable" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const inspectSpy = vi.spyOn(branchConflicts, "inspectBranchConflict");
    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
  });

  it("orphan-rescue sweep is idempotent across consecutive runs", async () => {
    const branch = "fusion/fn-4470";
    vi.spyOn(worktreePool, "scanOrphanedBranches")
      .mockResolvedValueOnce([branch])
      .mockResolvedValueOnce([branch]);
    vi.spyOn(manager as any, "inspectOrphanedBranch")
      .mockResolvedValueOnce({ branch, tipSha: "abc123", uniqueCommitCount: 2, uniqueCommitSubjects: ["feat: keep work"], derivedTaskId: "FN-4470", registeredWorktreePath: null })
      .mockResolvedValueOnce({ branch, tipSha: "abc123", uniqueCommitCount: 2, uniqueCommitSubjects: ["feat: keep work"], derivedTaskId: "FN-4470", registeredWorktreePath: null });

    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "FN-5001", column: "triage", branch }]);
    (store.createTask as any).mockResolvedValueOnce({ id: "FN-5001", lineageId: "lin-5001" });

    await manager.cleanupOrphanedBranches();
    await manager.cleanupOrphanedBranches();

    expect(store.createTask).toHaveBeenCalledTimes(1);
  });
});

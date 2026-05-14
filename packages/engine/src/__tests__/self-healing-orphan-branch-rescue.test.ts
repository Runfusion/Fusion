import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execSyncFn = vi.fn(() => Buffer.from(""));
  const execFn: any = vi.fn((cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    if (typeof callback === "function") callback(null, "", "");
  });
  execFn[promisify.custom] = () => Promise.resolve({ stdout: "", stderr: "" });
  return { exec: execFn, execSync: execSyncFn };
});

import type { TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import * as worktreePool from "../worktree-pool.js";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).listTasks = vi.fn();
  (emitter as any).createTask = vi.fn();
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).clearStaleExecutionStartBranchReferences = vi.fn().mockReturnValue([]);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

describe("self-healing orphan branch rescue", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
  });

  it("prunes subsumed orphan branches and emits branch:orphan-prune", async () => {
    vi.spyOn(worktreePool, "scanOrphanedBranches").mockResolvedValueOnce(["fusion/fn-4470"]);
    vi.spyOn(manager as any, "inspectOrphanedBranch").mockResolvedValueOnce({
      branch: "fusion/fn-4470",
      tipSha: "abc123",
      uniqueCommitCount: 0,
      uniqueCommitSubjects: [],
      derivedTaskId: "FN-4470",
      registeredWorktreePath: null,
    });
    vi.spyOn(store, "listTasks" as any).mockResolvedValueOnce([]);

    const result = await manager.cleanupOrphanedBranches();

    expect(result).toBe(1);
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "branch:orphan-prune" }));
  });

  it("creates a rescue triage task when unique commits exist and no task row exists", async () => {
    vi.spyOn(worktreePool, "scanOrphanedBranches").mockResolvedValueOnce(["fusion/fn-4470"]);
    vi.spyOn(manager as any, "inspectOrphanedBranch").mockResolvedValueOnce({
      branch: "fusion/fn-4470",
      tipSha: "deadbeef",
      uniqueCommitCount: 2,
      uniqueCommitSubjects: ["feat: preserve orphan"],
      derivedTaskId: "FN-4470",
      registeredWorktreePath: "/tmp/wt-fn-4470",
    });
    vi.spyOn(store, "listTasks" as any).mockResolvedValueOnce([]);
    (store.createTask as any).mockResolvedValueOnce({ id: "FN-5000", lineageId: "lin-5000" });

    const result = await manager.cleanupOrphanedBranches();

    expect(result).toBe(0);
    expect(store.createTask).toHaveBeenCalledWith(expect.objectContaining({
      title: "Recover orphaned branch fusion/fn-4470",
      column: "triage",
      branch: "fusion/fn-4470",
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-5000", { worktree: "/tmp/wt-fn-4470" });
    expect(store.logEntry).toHaveBeenCalledWith("FN-5000", expect.stringContaining("[recovery] orphan-rescue-created"));
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "branch:orphan-rescued" }));
  });

  it("leaves archived matching tasks untouched and only acknowledges once", async () => {
    const archivedTask = { id: "FN-4470", column: "archived", metadata: {} };
    vi.spyOn(worktreePool, "scanOrphanedBranches").mockResolvedValueOnce(["fusion/fn-4470"]);
    vi.spyOn(manager as any, "inspectOrphanedBranch").mockResolvedValueOnce({
      branch: "fusion/fn-4470",
      tipSha: "deadbeef",
      uniqueCommitCount: 1,
      uniqueCommitSubjects: ["feat: preserve orphan"],
      derivedTaskId: "FN-4470",
      registeredWorktreePath: null,
    });
    vi.spyOn(store, "listTasks" as any).mockResolvedValueOnce([archivedTask]);

    const result = await manager.cleanupOrphanedBranches();

    expect(result).toBe(0);
    expect(store.updateTask).toHaveBeenCalledWith("FN-4470", expect.objectContaining({
      metadata: expect.objectContaining({ orphanRescueAcknowledged: true }),
    }));
    expect(store.createTask).not.toHaveBeenCalled();
  });
});

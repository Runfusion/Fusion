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

import { execSync } from "node:child_process";
import type { TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import * as worktreePool from "../../worktree-pool.js";

function createStore(bootstrappedAt: number | null, tasks: any[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getBootstrappedAt = vi.fn(() => bootstrappedAt);
  (emitter as any).listTasks = vi.fn().mockResolvedValue(tasks);
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  (emitter as any).createTask = vi.fn();
  (emitter as any).clearStaleExecutionStartBranchReferences = vi.fn().mockReturnValue([]);
  return emitter;
}

describe("reliability interactions: orphan-rescue fresh-db gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves both subsumed and unique orphan branches untouched for a fresh DB", async () => {
    const store = createStore(Date.now(), []);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    const scanSpy = vi.spyOn(worktreePool, "scanOrphanedBranches").mockResolvedValue([
      "fusion/fn-subsumed",
      "fusion/fn-unique",
    ]);
    const inspectSpy = vi.spyOn(manager as any, "inspectOrphanedBranch");
    const execSyncMock = vi.mocked(execSync);

    const cleaned = await manager.cleanupOrphanedBranches();

    expect(cleaned).toBe(0);
    expect(scanSpy).not.toHaveBeenCalled();
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining("git branch -d"),
      expect.anything(),
    );
    expect(store.createTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "self-healing:orphan-rescue-skipped-fresh-db" }),
    );
  });

  it("preserves prune-and-rescue behavior for non-fresh DBs", async () => {
    const store = createStore(Date.now() - 1_000_000, [{ id: "FN-0001", column: "done" }]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    vi.spyOn(worktreePool, "scanOrphanedBranches").mockResolvedValue([
      "fusion/fn-subsumed",
      "fusion/fn-unique",
    ]);
    vi.spyOn(manager as any, "inspectOrphanedBranch")
      .mockResolvedValueOnce({
        branch: "fusion/fn-subsumed",
        tipSha: "aaa111",
        uniqueCommitCount: 0,
        uniqueCommitSubjects: [],
        derivedTaskId: "FN-SUBSUMED",
        registeredWorktreePath: null,
      })
      .mockResolvedValueOnce({
        branch: "fusion/fn-unique",
        tipSha: "bbb222",
        uniqueCommitCount: 2,
        uniqueCommitSubjects: ["feat: keep work"],
        derivedTaskId: "FN-UNIQUE",
        registeredWorktreePath: null,
      });
    (store.createTask as any).mockResolvedValueOnce({ id: "FN-5001", lineageId: "lin-5001" });

    const cleaned = await manager.cleanupOrphanedBranches();

    expect(cleaned).toBe(1);
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining("git branch -d"),
      expect.objectContaining({ cwd: "/tmp/repo" }),
    );
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Recover orphaned branch fusion/fn-unique" }),
    );
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "branch:orphan-prune" }),
    );
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "branch:orphan-rescued" }),
    );
  });

  it("remains idempotent across repeated fresh-DB sweeps", async () => {
    const store = createStore(Date.now(), []);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    const scanSpy = vi.spyOn(worktreePool, "scanOrphanedBranches").mockResolvedValue([
      "fusion/fn-subsumed",
      "fusion/fn-unique",
    ]);
    const execSyncMock = vi.mocked(execSync);

    const first = await manager.cleanupOrphanedBranches();
    const second = await manager.cleanupOrphanedBranches();
    const third = await manager.cleanupOrphanedBranches();

    expect([first, second, third]).toEqual([0, 0, 0]);
    expect(scanSpy).not.toHaveBeenCalled();
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining("git branch -d"),
      expect.anything(),
    );
    expect(store.createTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledTimes(3);
  });
});

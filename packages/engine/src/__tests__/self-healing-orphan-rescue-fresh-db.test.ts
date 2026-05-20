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

function createStore(bootstrappedAt: number | null, tasks: any[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getBootstrappedAt = vi.fn(() => bootstrappedAt);
  (emitter as any).listTasks = vi.fn().mockResolvedValue(tasks);
  (emitter as any).createTask = vi.fn();
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).clearStaleExecutionStartBranchReferences = vi.fn().mockReturnValue([]);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

describe("self-healing fresh-db orphan rescue gate", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips orphan rescue entirely for fresh databases with zero task history", async () => {
    const store = createStore(Date.now(), []);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    const scanSpy = vi.spyOn(worktreePool, "scanOrphanedBranches").mockResolvedValue([
      "fusion/foo",
      "fusion/bar",
    ]);

    const result = await manager.cleanupOrphanedBranches();

    expect(result).toBe(0);
    expect(scanSpy).not.toHaveBeenCalled();
    expect(store.createTask).not.toHaveBeenCalled();
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationType: "self-healing:orphan-rescue-skipped-fresh-db",
        metadata: expect.objectContaining({
          bootstrappedAt: expect.any(Number),
          processBootStartedAt: expect.any(Number),
          taskCount: 0,
          candidateBranches: 0,
        }),
      }),
    );
  });

  it("preserves existing orphan rescue behavior when the database is not fresh", async () => {
    const store = createStore(Date.now() - 1_000_000, []);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    vi.spyOn(worktreePool, "scanOrphanedBranches").mockResolvedValueOnce(["fusion/fn-4470"]);
    vi.spyOn(manager as any, "inspectOrphanedBranch").mockResolvedValueOnce({
      branch: "fusion/fn-4470",
      tipSha: "deadbeef",
      uniqueCommitCount: 2,
      uniqueCommitSubjects: ["feat: preserve orphan"],
      derivedTaskId: "FN-4470",
      registeredWorktreePath: null,
    });
    (store.createTask as any).mockResolvedValueOnce({ id: "FN-5000", lineageId: "lin-5000" });

    const result = await manager.cleanupOrphanedBranches();

    expect(result).toBe(0);
    expect(store.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Recover orphaned branch fusion/fn-4470" }),
    );
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mutationType: "branch:orphan-rescued" }),
    );
  });
});

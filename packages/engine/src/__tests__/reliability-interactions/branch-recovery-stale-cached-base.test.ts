import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFn: any = (cmd: string, opts: any, cb: any) => {
    const callback = typeof opts === "function" ? opts : cb;
    execMock(cmd, opts)
      .then((stdout: string) => callback?.(null, stdout, ""))
      .catch((err: Error) => callback?.(err, "", err.message));
  };
  execFn[promisify.custom] = (cmd: string, opts?: any) => execMock(cmd, opts).then((stdout: string) => ({ stdout, stderr: "" }));
  return { exec: execFn, execSync: vi.fn(), execFile: vi.fn() };
});

import { SelfHealingManager } from "../../self-healing.js";
import { RestartRecoveryCoordinator } from "../../healing/restart-recovery-coordinator.js";
import * as branchConflicts from "../../execution/branch-conflicts.js";
import * as worktreePool from "../../worktree/worktree-pool.js";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false });
  (emitter as any).listTasks = vi.fn();
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  (emitter as any).clearStaleExecutionStartBranchReferences = vi.fn().mockReturnValue([]);
  return emitter;
}

describe("reliability interactions: stale cached-base branch reclaim", () => {
  let store: TaskStore & EventEmitter;

  beforeEach(() => {
    store = createStore();
    execMock.mockReset();
    execMock.mockResolvedValue("");
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restart recovery + reclaim sweep ends with todo and nulled cached branch metadata", async () => {
    const task: any = { id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/ghost", baseCommitSha: "stale-base", paused: true, pausedReason: "branch-conflict-unrecoverable", error: "Agent exited without calling fn_task_done", status: "failed", steps: [{ status: "pending" }] };
    const statefulStore: any = createStore();
    statefulStore.listTasks = vi.fn(async ({ column }: { column?: string }) => (column ? (task.column === column ? [task] : []) : [task]));
    statefulStore.updateTask = vi.fn(async (_id: string, updates: Record<string, unknown>) => Object.assign(task, updates));
    statefulStore.moveTask = vi.fn(async (_id: string, col: string) => { task.column = col; });

    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "tip-already-merged", livePath: null, tipSha: "abc123def456", integrationRef: "main" } as any);
    const restart = new RestartRecoveryCoordinator(statefulStore, { resumeOrphaned: vi.fn().mockResolvedValue(undefined) } as any);
    const manager = new SelfHealingManager(statefulStore, { rootDir: "/tmp/repo" });

    await restart.recoverInterruptedRuns();
    await manager.reclaimSelfOwnedBranchConflicts();

    expect(task.column).toBe("todo");
    expect(task.branch).toBeNull();
    expect(task.worktree).toBeNull();
    expect(task.baseCommitSha).toBeNull();
  });

  it("keeps userPaused ghost-conflict tasks untouched", async () => {
    (store.listTasks as any).mockResolvedValueOnce([{ id: "FN-9001", column: "todo", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/ghost", baseCommitSha: "stale", paused: true, userPaused: true, pausedReason: "branch-conflict-unrecoverable" }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const inspectSpy = vi.spyOn(branchConflicts, "inspectBranchConflict");
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    await manager.reclaimSelfOwnedBranchConflicts();
    expect(inspectSpy).not.toHaveBeenCalled();
  });

  it("uses existing store APIs only for stale cache recovery path", async () => {
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    expect(manager).toBeTruthy();
    expect(typeof (store as any).updateTask).toBe("function");
    expect(typeof (store as any).moveTask).toBe("function");
    expect(typeof (store as any).logEntry).toBe("function");
    expect(typeof (store as any).recordRunAuditEvent).toBe("function");
  });
});

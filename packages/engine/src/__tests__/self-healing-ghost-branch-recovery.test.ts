import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  execFn[promisify.custom] = (cmd: string, opts?: any) =>
    execMock(cmd, opts).then((stdout: string) => ({ stdout, stderr: "" }));
  return { exec: execFn, execSync: vi.fn() };
});

import { SelfHealingManager } from "../self-healing.js";
import * as branchConflicts from "../branch-conflicts.js";
import * as worktreePool from "../worktree-pool.js";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false });
  (emitter as any).listTasks = vi.fn();
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

describe("self-healing ghost branch recovery", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test" });
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
    execMock.mockReset();
    execMock.mockResolvedValue("");
  });

  function mockSweepTask(task: any) {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task]);
  }

  it("recovers tip-already-merged FN-4471 signature by clearing cached metadata", async () => {
    mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/ghost-cat", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed", lineageId: "lin-1" });
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "tip-already-merged",
      livePath: null,
      tipSha: "1234567890abcdef",
      integrationRef: "main",
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ worktree: null, branch: null, baseCommitSha: null }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-9001", "todo", expect.objectContaining({ preserveProgress: true, preserveResumeState: true }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-9001", expect.stringContaining("[recovery] tip-already-merged FN-9001"));
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "branch:auto-reclaim", metadata: expect.objectContaining({ phase: "tip-already-merged" }) }));
  });

  it("invalidates cached metadata on stale-resolved and preserves branch ref", async () => {
    mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/ghost-cat", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" });
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "stale-resolved" } as any);

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", { worktree: null, branch: null, baseCommitSha: null });
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git branch -D"), expect.anything());
  });

  it("keeps genuine live-foreign conflicts parked", async () => {
    mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "topic/other", worktree: "/tmp/live", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" });
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "live-foreign",
      livePath: "/tmp/live",
      error: new branchConflicts.BranchConflictError({
        branchName: "topic/other",
        conflictingWorktreePath: "/tmp/live",
        existingTipSha: "abc",
        strandedCommits: [{ sha: "abc", subject: "x" }],
        startPoint: "main",
        recommendedAction: "manual",
      }),
    } as any);

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ pausedReason: "branch-conflict-unrecoverable", status: "failed" }));
  });

  it("is idempotent after tip-already-merged cleanup", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/ghost", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed", lineageId: "lin-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "tip-already-merged", livePath: null, tipSha: "1234567890abcdef", integrationRef: "main" } as any);

    await manager.reclaimSelfOwnedBranchConflicts();
    await manager.reclaimSelfOwnedBranchConflicts();

    const tipLogs = (store.logEntry as any).mock.calls.filter((c: any[]) => String(c[1]).includes("tip-already-merged"));
    expect(tipLogs).toHaveLength(1);
  });

  it("does not half-corrupt state when tip-already-merged cleanup fails", async () => {
    execMock.mockImplementation(async (command: string) => {
      if (command.includes("git branch -D")) throw new Error("delete failed");
      return "";
    });
    mockSweepTask({ id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/live", baseCommitSha: "m0", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" });
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "tip-already-merged", livePath: "/tmp/live", tipSha: "1234567890abcdef", integrationRef: "main" } as any);

    await manager.reclaimSelfOwnedBranchConflicts();

    const nullingCalls = (store.updateTask as any).mock.calls.filter((c: any[]) => c[1]?.baseCommitSha === null);
    expect(nullingCalls).toHaveLength(0);
    expect(store.logEntry).toHaveBeenCalledWith("FN-9001", expect.stringContaining("tip-already-merged cleanup failed"));
  });
});

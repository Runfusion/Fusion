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
  return { exec: execFn, execSync: vi.fn(), execFile: vi.fn() };
});

/*
FNXC:EngineTests 2026-07-21-00:20:
Reclaim path uses removeWorktree + relocate + classify; mock the pool so unit tests do not hang on real git or fail identity classification.

FNXC:EngineTests 2026-07-21-18:00:
RemovalReason must be re-exported — product passes RemovalReason.SelfHealingBranchConflict into removeWorktree; a missing mock export aborts the destructive path before removeWorktree runs.
*/
vi.mock("../worktree-pool.js", () => ({
  isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: false, classification: "missing", reason: "test" }),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  relocateReclaimableWorktreeIntoRoot: vi.fn(async ({ sourcePath }: { sourcePath: string }) => ({
    kind: "ready",
    path: sourcePath,
    relocated: false,
  })),
  getRegisteredWorktreePaths: vi.fn().mockReturnValue([]),
  getRegisteredWorktreeBranchMap: vi.fn().mockReturnValue(new Map()),
  resolveWorktreeBackend: vi.fn().mockReturnValue({ kind: "native" }),
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  scanOrphanedBranches: vi.fn().mockResolvedValue([]),
  RemovalReason: {
    HardCancel: "hard-cancel",
    ExecutorTransientRetry: "executor-transient-retry",
    ExecutorStuckKilled: "executor-stuck-killed",
    ExecutorDispose: "executor-dispose",
    StepSessionCleanup: "step-session-cleanup",
    MergerPostMerge: "merger-post-merge",
    MergerCleanup: "merger-cleanup",
    SelfHealingReclaim: "self-healing-reclaim",
    SelfHealingStaleActiveBranch: "self-healing-stale-active-branch",
    SelfHealingBranchConflict: "self-healing-branch-conflict",
    SelfHealingIdleSweep: "self-healing-idle-sweep",
    PoolPrune: "pool-prune",
  },
}));

import { SelfHealingManager } from "../self-healing.js";
import * as branchConflicts from "../branch-conflicts.js";
import { isUsableTaskWorktree, removeWorktree, relocateReclaimableWorktreeIntoRoot } from "../worktree-pool.js";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  // FNXC:EngineTests 2026-07-21-00:20: reclaim candidates are filtered by allowsAutoMergeProcessing.
  (emitter as any).getSettings = vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, autoMerge: true });
  (emitter as any).listTasks = vi.fn();
  (emitter as any).updateTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).logEntry = vi.fn().mockResolvedValue(undefined);
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

describe("self-healing reclaim live zero commits", () => {
  let store: TaskStore & EventEmitter;
  let manager: SelfHealingManager;

  beforeEach(() => {
    store = createStore();
    manager = new SelfHealingManager(store, { rootDir: "/tmp/test" });
    vi.mocked(isUsableTaskWorktree).mockResolvedValue(true);
    vi.mocked(removeWorktree).mockResolvedValue(undefined as never);
    vi.mocked(relocateReclaimableWorktreeIntoRoot).mockImplementation(async ({ sourcePath }: { sourcePath: string }) => ({
      kind: "ready" as const,
      path: sourcePath,
      relocated: false,
    }));
    // FNXC:EngineTests 2026-07-21-00:20: in-review reclaim requires backward-move triple proof ok.
    vi.spyOn(manager as any, "evaluateBackwardMoveTripleProof").mockResolvedValue({ ok: true });
    execMock.mockReset();
    execMock.mockResolvedValue("");
  });

  it("auto-reclaims self-owned fully-subsumed live branch by deleting worktree+branch", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/stale", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed", lineageId: "lin-1" },
      ]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "fully-subsumed",
      livePath: "/tmp/live",
      tipSha: "1234567890abcdef",
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    /*
    FNXC:EngineTests 2026-07-21-17:58:
    Fully-subsumed live reclaim deletes via removeWorktree (worktree-pool), then prunes and deletes the branch with execAsync — not a raw `git worktree remove` from self-healing.
    */
    expect(removeWorktree).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: "/tmp/live",
      rootDir: "/tmp/test",
      taskId: "FN-9001",
    }));
    expect(execMock).toHaveBeenCalledWith("git worktree prune", expect.anything());
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining("git branch -D"), expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ worktree: null, branch: null, paused: false }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-9001", "todo", expect.objectContaining({ moveSource: "engine", preserveProgress: true, preserveResumeState: true }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-9001", expect.stringContaining("[recovery] reclaim-live-zero-commits"));
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "branch:auto-reclaim",
      metadata: expect.objectContaining({ phase: "reclaim-live-zero-commits" }),
    }));
  });

  it("keeps reclaimable conflicts on non-destructive preserve path", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/stale", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" },
      ]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "reclaimable",
      livePath: "/tmp/live",
      tipSha: "1234567890abcdef",
      taskAttributedCommitCount: 1,
      strandedCommits: [{ sha: "abc", subject: "unique" }],
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git worktree remove --force"), expect.anything());
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git branch -D"), expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ worktree: "/tmp/live", branch: "fusion/fn-9001" }));
  });

  it("skips destructive fast-path when another in-progress task owns live worktree", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-9001", column: "in-progress", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/stale" },
        { id: "FN-9002", column: "in-progress", checkedOutBy: null, branch: "fusion/fn-9002", worktree: "/tmp/live" },
      ])
      .mockResolvedValueOnce([]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "fully-subsumed",
      livePath: "/tmp/live",
      tipSha: "1234567890abcdef",
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git worktree remove --force"), expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ worktree: "/tmp/live", branch: "fusion/fn-9001" }));
  });

  it("does not run destructive fast-path for foreign branch names", async () => {
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-other", worktree: "/tmp/stale", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" },
      ]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "fully-subsumed",
      livePath: "/tmp/live",
      tipSha: "1234567890abcdef",
    } as any);

    await manager.reclaimSelfOwnedBranchConflicts();

    expect(execMock).not.toHaveBeenCalledWith(expect.stringContaining("git worktree remove --force"), expect.anything());
    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ worktree: "/tmp/live", branch: "fusion/fn-other" }));
  });

  it("parks task without corrupting branch/worktree when worktree removal fails", async () => {
    /*
    FNXC:EngineTests 2026-07-21-17:58:
    Removal failure is surface from removeWorktree (pool), not raw exec of `git worktree remove`.
    */
    vi.mocked(removeWorktree).mockRejectedValueOnce(new Error("remove failed"));
    (store.listTasks as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "FN-9001", column: "in-review", checkedOutBy: null, branch: "fusion/fn-9001", worktree: "/tmp/stale", paused: true, pausedReason: "branch-conflict-unrecoverable", status: "failed" },
      ]);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({
      kind: "fully-subsumed",
      livePath: "/tmp/live",
      tipSha: "1234567890abcdef",
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    expect(store.logEntry).toHaveBeenCalledWith("FN-9001", expect.stringContaining("reclaim-live-zero-commits failed"));
    expect(store.updateTask).toHaveBeenCalledWith("FN-9001", expect.objectContaining({ worktree: "/tmp/live", branch: "fusion/fn-9001" }));
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedCreateFnAgent, mockedExec, resetExecutorMocks } from "./executor-test-helpers.js";
import * as branchConflicts from "../branch-conflicts.js";

/**
 * FN-4417 regression: the contamination check must compute its own fresh
 * merge-base against the integration branch, not reuse `task.baseCommitSha`.
 */
describe("resolveContaminationBaseRef (FN-4417)", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("returns the current merge-base with origin/main, ignoring task.baseCommitSha", async () => {
    const calls: string[] = [];
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      calls.push(String(cmd));
      if (String(cmd).includes("merge-base")) cb(null, "fresh_main_sha\n");
      else cb(null, "");
      return {} as any;
    }) as any);

    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    const result = await (executor as any).resolveContaminationBaseRef("/tmp/test/.worktrees/swift-delta");

    expect(result).toBe("fresh_main_sha");
    const mergeBaseCall = calls.find((c) => c.includes("merge-base"));
    expect(mergeBaseCall).toBeDefined();
    const localMainIdx = mergeBaseCall!.indexOf("merge-base HEAD main");
    const originMainIdx = mergeBaseCall!.indexOf("merge-base HEAD origin/main");
    expect(localMainIdx).toBeGreaterThanOrEqual(0);
    expect(localMainIdx).toBeLessThan(originMainIdx === -1 ? Number.MAX_SAFE_INTEGER : originMainIdx);
    expect(calls.some((c) => c.includes("HEAD~1"))).toBe(false);
  });

  it("returns undefined when neither origin/main nor main resolves", async () => {
    mockedExec.mockImplementation(((_cmd: any, _opts: any, cb: any) => {
      cb(new Error("fatal: no main"), "", "fatal: no main");
      return {} as any;
    }) as any);

    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    const result = await (executor as any).resolveContaminationBaseRef("/tmp/test/.worktrees/swift-delta");
    expect(result).toBeUndefined();
  });

  it("does NOT fall back to task.baseCommitSha (FN-4417 false-positive guard)", async () => {
    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      cb(null, String(cmd).includes("merge-base") ? "currentMainSHA\n" : "");
      return {} as any;
    }) as any);

    const executor = new TaskExecutor(createMockStore(), "/tmp/test");
    const result = await (executor as any).resolveContaminationBaseRef("/tmp/test/.worktrees/swift-delta");

    expect(result).toBe("currentMainSHA");
    expect((executor as any).resolveContaminationBaseRef.length).toBe(1);
  });
});

describe("branch cross-contamination recovery (FN-4428/FN-4499)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExec.mockImplementation(((_cmd: any, _opts: any, cb: any) => {
      cb(null, "");
      return {} as any;
    }) as any);
    mockedCreateFnAgent.mockResolvedValue({ session: { prompt: vi.fn(), close: vi.fn(), dispose: vi.fn() }, sessionFile: null } as any);
  });

  function makeTask(recoveryRetryCount?: number) {
    return {
      id: "FN-4428",
      title: "Test",
      description: "Test",
      column: "in-progress",
      worktree: "/tmp/test/.worktrees/fn-4428",
      branch: "fusion/fn-4428",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      recoveryRetryCount,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;
  }

  it("FN-4488 shape: reanchors bootstrap misbinding and requeues to todo", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4488",
      baseSha: "abc123",
      taskId: "FN-4488",
      foreignCommits: [
        { sha: "1111111111111111111111111111111111111111", subject: "feat(FN-4367): dep 1", foreignTaskId: "FN-4367" },
        { sha: "2222222222222222222222222222222222222222", subject: "fix(FN-4367): dep 2", foreignTaskId: "FN-4367" },
      ],
    });

    mockedExec.mockImplementation(((cmd: any, _opts: any, cb: any) => {
      if (String(cmd).includes("merge-base")) {
        cb(null, "abc123\n");
      } else {
        cb(null, "");
      }
      return {} as any;
    }) as any);
    vi.spyOn(branchConflicts, "assertCleanBranchAtBase").mockRejectedValueOnce(contamination);
    // Not `mockResolvedValueOnce`: the acquireTaskWorktree resume-path
    // verifier (FN-5475 fix) also consults classifyBootstrapMisbinding
    // before the executor's primary contamination check runs, so a
    // once-spy is exhausted before the executor's call lands.
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValue({
      isBootstrapMisbinding: true,
      ownCommitCount: 0,
      foreignCommitCount: 1,
      nonAttributedCount: 0,
    });
    vi.spyOn(branchConflicts, "reanchorBranchToBase").mockResolvedValue({
      previousTipSha: "3333333333333333333333333333333333333333",
      newTipSha: "4444444444444444444444444444444444444444",
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({ ...makeTask(), id: "FN-4488", branch: "fusion/fn-4488" } as any);

    expect(store.moveTask).toHaveBeenCalled();
    const [movedTaskId, movedColumn] = store.moveTask.mock.calls[0] as [string, string];
    expect(movedTaskId).toBe("FN-4488");
    expect(["todo", "in-review"]).toContain(movedColumn);
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-4488", expect.objectContaining({ pausedReason: "branch-cross-contamination" }));
  });

  it("falls back to existing auto-recovery when contamination is post-start", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [{ sha: "1111111111111111111111111111111111111111", subject: "feat(FN-4412): upstream", foreignTaskId: "FN-4412" }],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: false, ownCommitCount: 1, foreignCommitCount: 0, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: contamination.foreignCommits, unique: [] });
    const recoverySpy = vi.spyOn(branchConflicts, "autoRecoverCrossContamination").mockResolvedValueOnce({
      newTipSha: "2222222222222222222222222222222222222222",
      droppedShas: ["1111111111111111111111111111111111111111"],
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // FN-4939: contamination auto-recovery must preserve the worktree because the
    // recovery operates inside it (re-anchors the branch, re-checks it out).
    // Nulling task.worktree here triggered transient `no-worktree-no-merge-confirmed`
    // stall signals while a live worktree remained mapped on disk.
    expect(store.moveTask).toHaveBeenCalledWith("FN-4428", "todo", { preserveResumeState: true, preserveWorktree: true });

    // FN-4939: recovery must run inside the task's worktree, not the repo root.
    // Otherwise the final `git checkout <branch>` in rootDir collides with the
    // branch already being checked out in the worktree and the recovery silently fails.
    expect(recoverySpy).toHaveBeenCalledWith(expect.objectContaining({
      repoDir: "/tmp/test/.worktrees/fn-4428",
    }));
  });

  it("FN-4939: falls back to rootDir for recovery only when task has no worktree pointer", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [{ sha: "1111111111111111111111111111111111111111", subject: "feat(FN-4412): upstream", foreignTaskId: "FN-4412" }],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: false, ownCommitCount: 1, foreignCommitCount: 0, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: contamination.foreignCommits, unique: [] });
    const recoverySpy = vi.spyOn(branchConflicts, "autoRecoverCrossContamination").mockResolvedValueOnce({
      newTipSha: "2222222222222222222222222222222222222222",
      droppedShas: ["1111111111111111111111111111111111111111"],
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({ ...makeTask(), worktree: undefined } as any);

    expect(recoverySpy).toHaveBeenCalledWith(expect.objectContaining({ repoDir: "/tmp/test" }));
  });

  it("auto-recovers obviously misrouted .changeset-only foreign commits and emits audit", async () => {
    const store = createMockStore();
    (store as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
    const misroutedCommit = {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      subject: "feat(FN-5000): changeset",
      foreignTaskId: "FN-5000",
    };
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [misroutedCommit],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: false, ownCommitCount: 1, foreignCommitCount: 0, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: [], unique: [misroutedCommit] });
    vi.spyOn(branchConflicts, "classifyMisroutedForeignCommit").mockResolvedValueOnce({
      misrouted: true,
      foreignTaskId: "FN-5000",
      paths: [".changeset/fn-5000-fix.md"],
    });
    const recoverySpy = vi.spyOn(branchConflicts, "autoRecoverCrossContamination").mockResolvedValueOnce({
      newTipSha: "2222222222222222222222222222222222222222",
      droppedShas: [misroutedCommit.sha],
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(recoverySpy).toHaveBeenCalledWith(expect.objectContaining({ shasToDrop: [misroutedCommit.sha] }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-4428", "todo", { preserveResumeState: true, preserveWorktree: true });
    expect((store as any).recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:auto-recover-misrouted-foreign-commit" }));
  });

  it("keeps escalation path for foreign commits that touch shared paths", async () => {
    const store = createMockStore();
    const foreignCommit = {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      subject: "fix(FN-5001): mixed paths",
      foreignTaskId: "FN-5001",
    };
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [foreignCommit],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: false, ownCommitCount: 1, foreignCommitCount: 0, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: [], unique: [foreignCommit] });
    vi.spyOn(branchConflicts, "classifyMisroutedForeignCommit").mockResolvedValueOnce({
      misrouted: false,
      foreignTaskId: "FN-5001",
      paths: [".changeset/fn-5001-fix.md", "packages/engine/src/executor.ts"],
    });
    const recoverySpy = vi.spyOn(branchConflicts, "autoRecoverCrossContamination").mockResolvedValueOnce({
      newTipSha: "2222222222222222222222222222222222222222",
      droppedShas: [],
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(recoverySpy).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-4428", expect.objectContaining({ status: "failed", paused: true, pausedReason: "branch-cross-contamination" }));
  });

  it("drops already-upstream + misrouted together then escalates on second contamination", async () => {
    const upstreamCommit = {
      sha: "cccccccccccccccccccccccccccccccccccccccc",
      subject: "feat(FN-5002): upstream",
      foreignTaskId: "FN-5002",
    };
    const misroutedCommit = {
      sha: "dddddddddddddddddddddddddddddddddddddddd",
      subject: "feat(FN-5003): changeset",
      foreignTaskId: "FN-5003",
    };
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4428",
      baseSha: "abc123",
      taskId: "FN-4428",
      foreignCommits: [upstreamCommit, misroutedCommit],
    });

    const firstStore = createMockStore();
    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: false, ownCommitCount: 1, foreignCommitCount: 0, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: [upstreamCommit], unique: [misroutedCommit] });
    vi.spyOn(branchConflicts, "classifyMisroutedForeignCommit").mockResolvedValueOnce({ misrouted: true, foreignTaskId: "FN-5003", paths: [".changeset/fn-5003-fix.md"] });
    const recoverySpy = vi.spyOn(branchConflicts, "autoRecoverCrossContamination").mockResolvedValueOnce({
      newTipSha: "3333333333333333333333333333333333333333",
      droppedShas: [upstreamCommit.sha, misroutedCommit.sha],
    });

    const executor = new TaskExecutor(firstStore, "/tmp/test");
    await executor.execute(makeTask());
    expect(recoverySpy).toHaveBeenCalledWith(expect.objectContaining({ shasToDrop: [upstreamCommit.sha, misroutedCommit.sha] }));

    const secondStore = createMockStore();
    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: false, ownCommitCount: 1, foreignCommitCount: 0, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: [upstreamCommit], unique: [misroutedCommit] });
    vi.spyOn(branchConflicts, "classifyMisroutedForeignCommit").mockResolvedValueOnce({ misrouted: true, foreignTaskId: "FN-5003", paths: [".changeset/fn-5003-fix.md"] });

    const secondExecutor = new TaskExecutor(secondStore, "/tmp/test");
    await secondExecutor.execute(makeTask(1));
    expect(secondStore.updateTask).toHaveBeenCalledWith("FN-4428", expect.objectContaining({ status: "failed", paused: true, pausedReason: "branch-cross-contamination" }));
  });

  it("falls back to terminal contamination failure when bootstrap reanchor throws", async () => {
    const store = createMockStore();
    const contamination = new branchConflicts.BranchCrossContaminationError({
      branchName: "fusion/fn-4488",
      baseSha: "abc123",
      taskId: "FN-4488",
      foreignCommits: [{ sha: "1111111111111111111111111111111111111111", subject: "feat(FN-4367): dep", foreignTaskId: "FN-4367" }],
    });

    mockedCreateFnAgent.mockRejectedValueOnce(contamination);
    vi.spyOn(branchConflicts, "classifyBootstrapMisbinding").mockResolvedValueOnce({ isBootstrapMisbinding: true, ownCommitCount: 0, foreignCommitCount: 1, nonAttributedCount: 0 });
    vi.spyOn(branchConflicts, "reanchorBranchToBase").mockRejectedValueOnce(new Error("reanchor failed"));
    vi.spyOn(branchConflicts, "classifyForeignCommits").mockResolvedValueOnce({ alreadyUpstream: [], unique: contamination.foreignCommits });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({ ...makeTask(), id: "FN-4488", branch: "fusion/fn-4488" } as any);

    expect(store.updateTask).toHaveBeenCalledWith("FN-4488", expect.objectContaining({ status: "failed", paused: true, pausedReason: "branch-cross-contamination" }));
  });
});

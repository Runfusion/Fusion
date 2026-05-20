import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NativeWorktreeBackend,
  WorktrunkOperationError,
  WorktrunkWorktreeBackend,
  removeWorktree,
  resolveWorktreeBackend,
  RemovalReason,
} from "../worktree-backend.js";

const { execMock, accessMock, existsSyncMock, parseIndexLockPathMock, classifyStaleLockMock, tryRemoveStaleLockMock, parseStaleRegistrationPathMock, recoverStaleRegistrationMock, installGuardMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return {
    execMock: mock,
    accessMock: vi.fn(),
    existsSyncMock: vi.fn(),
    parseIndexLockPathMock: vi.fn(),
    classifyStaleLockMock: vi.fn(),
    tryRemoveStaleLockMock: vi.fn(),
    parseStaleRegistrationPathMock: vi.fn(),
    recoverStaleRegistrationMock: vi.fn(),
    installGuardMock: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({ exec: execMock }));
vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));
vi.mock("node:fs/promises", () => ({ access: accessMock }));
vi.mock("../branch-conflicts.js", () => ({
  inspectBranchConflict: vi.fn().mockResolvedValue({ kind: "stale" }),
}));
vi.mock("../worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: installGuardMock,
}));
vi.mock("../worktree-stale-lock.js", () => ({
  StaleWorktreeIndexLockError: class StaleWorktreeIndexLockError extends Error {
    lockPath: string;
    classification: string;
    reason: string;
    constructor(input: { message: string; lockPath: string; classification: string; reason: string }) {
      super(input.message);
      this.name = "StaleWorktreeIndexLockError";
      this.lockPath = input.lockPath;
      this.classification = input.classification;
      this.reason = input.reason;
    }
  },
  parseIndexLockPath: parseIndexLockPathMock,
  classifyStaleLock: classifyStaleLockMock,
  tryRemoveStaleLock: tryRemoveStaleLockMock,
}));
vi.mock("../worktree-stale-registration.js", () => ({
  parseStaleRegistrationPath: parseStaleRegistrationPathMock,
  recoverStaleRegistration: recoverStaleRegistrationMock,
}));

beforeEach(() => {
  execMock.mockReset();
  accessMock.mockReset();
  existsSyncMock.mockReset();
  accessMock.mockResolvedValue(undefined);
  existsSyncMock.mockReturnValue(true);
  parseIndexLockPathMock.mockReset();
  classifyStaleLockMock.mockReset();
  tryRemoveStaleLockMock.mockReset();
  installGuardMock.mockReset();
  installGuardMock.mockResolvedValue(undefined);
  parseIndexLockPathMock.mockReturnValue(null);
  parseStaleRegistrationPathMock.mockReset();
  parseStaleRegistrationPathMock.mockReturnValue(null);
  recoverStaleRegistrationMock.mockReset();
  recoverStaleRegistrationMock.mockResolvedValue({ recovered: true, actions: ["prune"] });
  classifyStaleLockMock.mockResolvedValue({ kind: "fresh", reason: "fresh" });
  tryRemoveStaleLockMock.mockResolvedValue({ removed: true });
});

describe("NativeWorktreeBackend", () => {
  it("creates worktree with expected command", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new NativeWorktreeBackend();

    const result = await backend.create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      startPoint: "main",
      taskId: "FN-1",
    });

    expect(result).toEqual({ path: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" });
    expect(execMock).toHaveBeenCalledWith(
      'git worktree add -b "fusion/fn-1" "/repo/.worktrees/fn-1" "main"',
      expect.objectContaining({ cwd: "/repo", timeout: 120000, maxBuffer: 10485760 }),
    );
    expect(installGuardMock).toHaveBeenCalledWith({ worktreePath: "/repo/.worktrees/fn-1", taskId: "FN-1" });
  });

  it("propagates installer failure after cleanup", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    installGuardMock.mockRejectedValueOnce(new Error("guard failed"));

    await expect(
      new NativeWorktreeBackend().create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
      }),
    ).rejects.toThrow("guard failed");

    expect(execMock).toHaveBeenCalledWith(
      'rm -rf "/repo/.worktrees/fn-1"',
      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
    );
  });

  it("retries with suffix and resolves", async () => {
    execMock.mockRejectedValueOnce(new Error("exists")).mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await new NativeWorktreeBackend().create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      taskId: "FN-1",
      allowSiblingBranchRename: true,
    });

    expect(result.branch).toBe("fusion/fn-1-2");
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'git worktree add -b "fusion/fn-1-2" "/repo/.worktrees/fn-1"',
      expect.any(Object),
    );
  });

  it("removes worktree with expected command", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });

    await new NativeWorktreeBackend().remove({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
    });

    expect(execMock).toHaveBeenCalledWith(
      'git worktree remove --force "/repo/.worktrees/fn-1"',
      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
    );
  });

  it("syncs by fetching then rebasing", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });

    const result = await new NativeWorktreeBackend().sync({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "main",
    });

    expect(result).toEqual({ skipped: false });
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      "git fetch --all --prune",
      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1", timeout: 120000, maxBuffer: 10485760 }),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'git rebase "origin/main"',
      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1", timeout: 120000, maxBuffer: 10485760 }),
    );
  });

  it("prunes worktrees with expected command", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });

    await new NativeWorktreeBackend().prune({ rootDir: "/repo" });

    expect(execMock).toHaveBeenCalledWith(
      "git worktree prune",
      expect.objectContaining({ cwd: "/repo", timeout: 120000, maxBuffer: 10485760 }),
    );
  });

  it("resolves stale index.lock and retries create once", async () => {
    const audit = { git: vi.fn().mockResolvedValue(undefined) };
    parseIndexLockPathMock.mockReturnValue("/repo/.git/worktrees/fn-1/index.lock");
    classifyStaleLockMock.mockResolvedValue({ kind: "stale", reason: "old-lock", ageMs: 60000 });
    tryRemoveStaleLockMock.mockResolvedValue({ removed: true });
    execMock
      .mockRejectedValueOnce({ message: "fatal", stderr: "fatal: unable to create '/repo/.git/worktrees/fn-1/index.lock': File exists" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await new NativeWorktreeBackend({ audit }).create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      taskId: "FN-1",
    });

    expect(result).toEqual({ path: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" });
    expect(tryRemoveStaleLockMock).toHaveBeenCalledWith({ lockPath: "/repo/.git/worktrees/fn-1/index.lock" });
    expect(audit.git).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "worktree:stale-lock-detected" }),
    );
    expect(audit.git).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "worktree:stale-lock-recovered" }),
    );
  });

  it("throws StaleWorktreeIndexLockError when lock is non-stale", async () => {
    const audit = { git: vi.fn().mockResolvedValue(undefined) };
    parseIndexLockPathMock.mockReturnValue("/repo/.git/worktrees/fn-1/index.lock");
    classifyStaleLockMock.mockResolvedValue({ kind: "fresh", reason: "lock-younger-than-threshold", ageMs: 1000 });
    execMock.mockRejectedValueOnce({
      message: "fatal",
      stderr: "fatal: unable to create '/repo/.git/worktrees/fn-1/index.lock': File exists",
    });

    await expect(
      new NativeWorktreeBackend({ audit }).create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
      }),
    ).rejects.toMatchObject({ name: "StaleWorktreeIndexLockError" });

    expect(tryRemoveStaleLockMock).not.toHaveBeenCalled();
    expect(audit.git).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "worktree:stale-lock-detected" }),
    );
    expect(audit.git).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "worktree:stale-lock-refused" }),
    );
  });

  it("recovers stale registration and retries add", async () => {
    const audit = { git: vi.fn().mockResolvedValue(undefined) };
    const stalePath = "/repo/.worktrees/fn-1";
    parseStaleRegistrationPathMock
      .mockReturnValueOnce(stalePath)
      .mockReturnValueOnce(null);
    recoverStaleRegistrationMock.mockResolvedValue({ recovered: true, actions: ["prune", "remove-force"] });
    execMock
      .mockRejectedValueOnce({ message: "fatal", stderr: `fatal: '${stalePath}' is a missing but already registered worktree` })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await new NativeWorktreeBackend({ audit }).create({
      rootDir: "/repo",
      worktreePath: stalePath,
      branch: "fusion/fn-1",
      taskId: "FN-1",
    });

    expect(result).toEqual({ path: stalePath, branch: "fusion/fn-1" });
    expect(recoverStaleRegistrationMock).toHaveBeenCalledWith({
      rootDir: "/repo",
      worktreePath: stalePath,
      logger: undefined,
    });
    expect(audit.git).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ type: "worktree:stale-registration-detected" }),
    );
    expect(audit.git).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "worktree:stale-registration-recovered", metadata: { actions: ["prune", "remove-force"] } }),
    );
    expect(installGuardMock).toHaveBeenCalledTimes(1);
  });

  it("uses add -f retry when stale registration persists", async () => {
    const audit = { git: vi.fn().mockResolvedValue(undefined) };
    const stalePath = "/repo/.worktrees/fn-1";
    parseStaleRegistrationPathMock.mockReturnValue(stalePath);
    recoverStaleRegistrationMock.mockResolvedValue({ recovered: true, actions: ["prune"] });
    execMock
      .mockRejectedValueOnce({ message: "fatal", stderr: `fatal: '${stalePath}' is a missing but already registered worktree` })
      .mockRejectedValueOnce({ message: "fatal", stderr: `fatal: '${stalePath}' is a missing but already registered worktree` })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await new NativeWorktreeBackend({ audit }).create({
      rootDir: "/repo",
      worktreePath: stalePath,
      branch: "fusion/fn-1",
      taskId: "FN-1",
    });

    expect(result).toEqual({ path: stalePath, branch: "fusion/fn-1" });
    expect(execMock).toHaveBeenNthCalledWith(
      3,
      'git worktree add -f "/repo/.worktrees/fn-1" "fusion/fn-1"',
      expect.any(Object),
    );
    expect(audit.git).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "worktree:stale-registration-recovered",
        metadata: { actions: ["prune", "add-force-retry"] },
      }),
    );
  });

  it("emits recovery failed and throws when add -f also fails", async () => {
    const audit = { git: vi.fn().mockResolvedValue(undefined) };
    const stalePath = "/repo/.worktrees/fn-1";
    parseStaleRegistrationPathMock.mockReturnValue(stalePath);
    recoverStaleRegistrationMock.mockResolvedValue({ recovered: true, actions: ["prune"] });
    const staleError = { message: "fatal", stderr: `fatal: '${stalePath}' is a missing but already registered worktree` };
    execMock.mockRejectedValueOnce(staleError).mockRejectedValueOnce(staleError).mockRejectedValueOnce(staleError);

    await expect(
      new NativeWorktreeBackend({ audit }).create({
        rootDir: "/repo",
        worktreePath: stalePath,
        branch: "fusion/fn-1",
        taskId: "FN-1",
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("missing but already registered worktree") });

    expect(audit.git).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "worktree:stale-registration-recovery-failed" }),
    );
  });

  it("does not emit stale-registration events on healthy create", async () => {
    const audit = { git: vi.fn().mockResolvedValue(undefined) };
    execMock.mockResolvedValue({ stdout: "", stderr: "" });

    await new NativeWorktreeBackend({ audit }).create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      taskId: "FN-1",
    });

    expect(recoverStaleRegistrationMock).not.toHaveBeenCalled();
    expect(audit.git).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^worktree:stale-registration-/) }));
  });

  it("prefers stale-lock recovery when both stale-lock and stale-registration signatures appear", async () => {
    const audit = { git: vi.fn().mockResolvedValue(undefined) };
    parseIndexLockPathMock.mockReturnValue("/repo/.git/worktrees/fn-1/index.lock");
    classifyStaleLockMock.mockResolvedValue({ kind: "stale", reason: "old-lock", ageMs: 60000 });
    tryRemoveStaleLockMock.mockResolvedValue({ removed: true });
    parseStaleRegistrationPathMock.mockReturnValue("/repo/.worktrees/fn-1");
    execMock
      .mockRejectedValueOnce({
        message: "fatal",
        stderr:
          "fatal: unable to create '/repo/.git/worktrees/fn-1/index.lock': File exists\nfatal: '/repo/.worktrees/fn-1' is a missing but already registered worktree",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    await new NativeWorktreeBackend({ audit }).create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      taskId: "FN-1",
    });

    expect(tryRemoveStaleLockMock).toHaveBeenCalledTimes(1);
    expect(recoverStaleRegistrationMock).not.toHaveBeenCalled();
    expect(audit.git).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "worktree:stale-lock-detected" }));
  });

  it("resolves native worktree path via configured worktreesDir", async () => {
    const backend = new NativeWorktreeBackend({ settings: { worktreesDir: "../{repo}.worktrees" } as any });
    await expect(
      backend.resolveWorktreePath({ rootDir: "/repo/project", worktreeName: "fn-1", branch: "fusion/fn-1" }),
    ).resolves.toBe("/repo/project.worktrees/fn-1");
  });
});

describe("WorktrunkWorktreeBackend", () => {
  it("throws missing binary error", async () => {
    const backend = new WorktrunkWorktreeBackend({ binaryPath: null });

    await expect(
      backend.create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
      }),
    ).rejects.toMatchObject({
      name: "WorktrunkOperationError",
      code: "worktrunk_binary_missing",
      operation: "create",
      stderr: "worktrunk binary not configured",
      exitCode: null,
    });
  });

  it("memoizes successful binary path resolver results", async () => {
    const binaryPathResolver = vi.fn().mockResolvedValue("/p");
    execMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "worktree /repo/.worktrees/fn-1\nbranch refs/heads/fusion/fn-1\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: binaryPathResolver });

    await backend.create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      taskId: "FN-1",
    });
    await backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" });

    expect(binaryPathResolver).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      '"/p" "switch" "--create" "fusion/fn-1" "--no-hooks" "--no-cd"',
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      3,
      '"/p" "remove" "--foreground" "fusion/fn-1"',
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("does not negative-cache null resolver results", async () => {
    const binaryPathResolver = vi.fn().mockResolvedValue(null);
    const backend = new WorktrunkWorktreeBackend({ binaryPath: binaryPathResolver });

    await expect(
      backend.create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
      }),
    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "create" });

    await expect(
      backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" }),
    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "remove" });

    expect(binaryPathResolver).toHaveBeenCalledTimes(2);
  });

  it("propagates WorktrunkOperationError thrown by resolver", async () => {
    const resolverError = new WorktrunkOperationError({
      operation: "remove",
      code: "worktrunk_timeout",
      stderr: "timed out",
      exitCode: null,
    });
    const binaryPathResolver = vi.fn().mockRejectedValue(resolverError);
    const backend = new WorktrunkWorktreeBackend({ binaryPath: binaryPathResolver });

    await expect(
      backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" }),
    ).rejects.toBe(resolverError);
  });

  it("throws operation failed with stderr/exitCode", async () => {
    execMock.mockRejectedValue({ stderr: "bad news", status: 7 });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
      }),
    ).rejects.toMatchObject({ code: "worktrunk_operation_failed", stderr: "bad news", exitCode: 7 });
  });

  it("invokes create mapping with timeout/maxBuffer and cwd", async () => {
    execMock
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "worktree /repo/.worktrees/fusion/fn-1\nbranch refs/heads/fusion/fn-1\n",
        stderr: "",
      });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await backend.create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      startPoint: "main",
      taskId: "FN-1",
    });

    expect(execMock).toHaveBeenNthCalledWith(
      1,
      '"worktrunk" "switch" "--create" "fusion/fn-1" "--no-hooks" "--no-cd" "--base" "main"',
      expect.objectContaining({ cwd: "/repo", timeout: 120000, maxBuffer: 10485760 }),
    );
  });

  describe("create() — path resolution", () => {
    it("returns porcelain-resolved path and warns on drift", async () => {
      const logger = { log: vi.fn(), warn: vi.fn() };
      execMock
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({
          stdout:
            "worktree /repo/.worktrees/custom/fusion-fn-1\nbranch refs/heads/fusion/fn-1\n\nworktree /repo\nbranch refs/heads/main\n",
          stderr: "",
        });
      existsSyncMock.mockImplementation((path: string) => path === "/repo/.worktrees/custom/fusion-fn-1");

      const result = await new WorktrunkWorktreeBackend({ binaryPath: "worktrunk", logger }).create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
      });

      expect(result).toEqual({ path: "/repo/.worktrees/custom/fusion-fn-1", branch: "fusion/fn-1" });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "[worktree-backend] worktrunk created branch fusion/fn-1 at /repo/.worktrees/custom/fusion-fn-1 (fusion assumed /repo/.worktrees/fn-1); using worktrunk-assigned path",
      );
    });

    it("fails when no branch match exists", async () => {
      execMock
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({ stdout: "worktree /repo/.worktrees/other\nbranch refs/heads/other\n", stderr: "" });

      await expect(
        new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" }).create({
          rootDir: "/repo",
          worktreePath: "/repo/.worktrees/fn-1",
          branch: "fusion/fn-1",
          taskId: "FN-1",
        }),
      ).rejects.toMatchObject({
        name: "WorktrunkOperationError",
        code: "worktrunk_operation_failed",
        stderr: expect.stringContaining("fusion/fn-1"),
      });
    });

    it("fails when multiple branch matches exist", async () => {
      execMock
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({
          stdout:
            "worktree /repo/.worktrees/a\nbranch refs/heads/fusion/fn-1\n\nworktree /repo/.worktrees/b\nbranch refs/heads/fusion/fn-1\n",
          stderr: "",
        });

      await expect(
        new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" }).create({
          rootDir: "/repo",
          worktreePath: "/repo/.worktrees/fn-1",
          branch: "fusion/fn-1",
          taskId: "FN-1",
        }),
      ).rejects.toMatchObject({
        name: "WorktrunkOperationError",
        code: "worktrunk_operation_failed",
        stderr: expect.stringContaining("/repo/.worktrees/a, /repo/.worktrees/b"),
      });
    });

    it("fails when resolved path does not exist on disk", async () => {
      existsSyncMock.mockReturnValue(false);
      execMock
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockResolvedValueOnce({
          stdout: "worktree /repo/.worktrees/missing\nbranch refs/heads/fusion/fn-1\n",
          stderr: "",
        });

      await expect(
        new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" }).create({
          rootDir: "/repo",
          worktreePath: "/repo/.worktrees/fn-1",
          branch: "fusion/fn-1",
          taskId: "FN-1",
        }),
      ).rejects.toMatchObject({
        name: "WorktrunkOperationError",
        code: "worktrunk_operation_failed",
        stderr: "worktrunk reported worktree at /repo/.worktrees/missing but the path does not exist",
      });
    });

    it("wraps porcelain command failures as worktrunk operation errors", async () => {
      execMock
        .mockResolvedValueOnce({ stdout: "", stderr: "" })
        .mockRejectedValueOnce({ stderr: "porcelain failed", status: 2 });

      await expect(
        new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" }).create({
          rootDir: "/repo",
          worktreePath: "/repo/.worktrees/fn-1",
          branch: "fusion/fn-1",
          taskId: "FN-1",
        }),
      ).rejects.toMatchObject({
        name: "WorktrunkOperationError",
        code: "worktrunk_operation_failed",
        stderr: "porcelain failed",
        exitCode: 2,
      });
    });
  });

  it("invokes remove mapping", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await backend.remove({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
    });

    expect(execMock).toHaveBeenCalledWith(
      '"worktrunk" "remove" "--foreground" "fusion/fn-1"',
      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
    );
  });

  it("treats remove not-found style failures as idempotent success", async () => {
    execMock.mockRejectedValue({ stderr: "branch not found", status: 1 });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" }),
    ).resolves.toBeUndefined();
  });

  it("maps ENOENT to worktrunk_binary_missing", async () => {
    execMock.mockRejectedValue({ code: "ENOENT", stderr: "not found" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
      }),
    ).rejects.toMatchObject({ code: "worktrunk_binary_missing" });
  });

  it("maps SIGTERM timeout to worktrunk_timeout", async () => {
    execMock.mockRejectedValue({ signal: "SIGTERM", stderr: "timed out" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
      }),
    ).rejects.toMatchObject({ code: "worktrunk_timeout" });
  });

  it("syncs by fetching then rebasing branch", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.sync({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "main" }),
    ).resolves.toEqual({ skipped: false });

    expect(execMock).toHaveBeenNthCalledWith(
      1,
      'git fetch origin "main"',
      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1", timeout: 180000, maxBuffer: 10485760 }),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'git rebase "main"',
      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1", timeout: 180000, maxBuffer: 10485760 }),
    );
  });

  it("sync supports explicit trunk target", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await backend.sync({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1", trunk: "release" });
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      'git fetch origin "release"',
      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1" }),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'git rebase "release"',
      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1" }),
    );
  });

  it("maps rebase conflicts to worktrunk_sync_conflict", async () => {
    execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockRejectedValueOnce({ stderr: "CONFLICT" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.sync({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "main" }),
    ).rejects.toMatchObject({ code: "worktrunk_sync_conflict", operation: "sync" });
  });

  it("resolves worktrunk path from wt config show template", async () => {
    execMock.mockResolvedValue({ stdout: '{"config":{"worktree-path":"{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}"}}', stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.resolveWorktreePath({ rootDir: "/repo/project", worktreeName: "ignored", branch: "fusion/fn-1" }),
    ).resolves.toBe("/repo/project.fusion-fn-1");
    expect(execMock).toHaveBeenCalledWith(
      '"worktrunk" "config" "show" "--format" "json"',
      expect.objectContaining({ cwd: "/repo/project", timeout: 5000, maxBuffer: 10485760 }),
    );
  });

  it("falls back to default layout template when config cannot be read", async () => {
    execMock.mockRejectedValue(new Error("missing config"));
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.resolveWorktreePath({ rootDir: "/repo/project", worktreeName: "ignored", branch: "fusion/fn-1" }),
    ).resolves.toBe("/repo/project/.worktrees/fusion-fn-1");
  });

  it("prunes by listing worktrees and removing worktrunk managed entries", async () => {
    execMock
      .mockResolvedValueOnce({
        stdout:
          "worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.worktrees/fusion-fn-1\nbranch refs/heads/fusion/fn-1\n\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(backend.prune({ rootDir: "/repo" })).resolves.toBeUndefined();
    expect(execMock).toHaveBeenNthCalledWith(
      1,
      "git worktree list --porcelain",
      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
    );
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      '"worktrunk" "remove" "--foreground" "fusion/fn-1"',
      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
    );
  });
});

describe("WorktrunkOperationError", () => {
  it("preserves shape", () => {
    const error = new WorktrunkOperationError({
      operation: "create",
      code: "worktrunk_operation_failed",
      stderr: "stderr",
      exitCode: 2,
    });
    expect(error.name).toBe("WorktrunkOperationError");
    expect(error.operation).toBe("create");
    expect(error.code).toBe("worktrunk_operation_failed");
    expect(error.stderr).toBe("stderr");
    expect(error.exitCode).toBe(2);
  });
});

describe("removeWorktree", () => {
  it("uses native remove and emits worktree:remove audit", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;

    await removeWorktree({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      settings: {},
      audit,
      reason: RemovalReason.SelfHealingReclaim,
    });

    expect(execMock).toHaveBeenCalledWith(
      'git worktree remove --force "/repo/.worktrees/fn-1"',
      expect.objectContaining({ cwd: "/repo", timeout: 60000 }),
    );
    expect(audit.git).toHaveBeenCalledWith({ type: "worktree:remove", target: "/repo/.worktrees/fn-1" });
  });

  it("uses worktrunk remove and emits worktree:worktrunk-remove", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;

    await removeWorktree({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      settings: { worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fail" } as any },
      audit,
      taskId: "FN-1",
      reason: RemovalReason.SelfHealingReclaim,
    });

    expect(audit.git).toHaveBeenCalledWith({ type: "worktree:worktrunk-remove", target: "/repo/.worktrees/fn-1" });
  });

  it("falls back to native when worktrunk remove fails and onFailure=fallback-native", async () => {
    execMock
      .mockRejectedValueOnce(new WorktrunkOperationError({ operation: "remove", code: "worktrunk_operation_failed", stderr: "boom", exitCode: 1 }))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });
    const audit = { git: vi.fn().mockResolvedValue(undefined) } as any;

    await removeWorktree({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      settings: { worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fallback-native" } as any },
      audit,
      reason: RemovalReason.SelfHealingReclaim,
    });

    expect(audit.git).toHaveBeenCalledWith(
      expect.objectContaining({ type: "worktree:worktrunk-fallback", target: "/repo/.worktrees/fn-1" }),
    );
    expect(audit.git).toHaveBeenCalledWith({ type: "worktree:remove", target: "/repo/.worktrees/fn-1" });
  });

  it("rethrows worktrunk remove failure when onFailure=fail", async () => {
    execMock.mockRejectedValue(
      new WorktrunkOperationError({ operation: "remove", code: "worktrunk_operation_failed", stderr: "boom", exitCode: 1 }),
    );

    await expect(
      removeWorktree({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        settings: { worktrunk: { enabled: true, binaryPath: "worktrunk", onFailure: "fail" } as any },
        reason: RemovalReason.SelfHealingReclaim,
      }),
    ).rejects.toMatchObject({ code: "worktrunk_operation_failed", operation: "remove" });
  });

  it("surfaces missing worktrunk binary errors", async () => {
    await expect(
      removeWorktree({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        settings: { worktrunk: { enabled: true, onFailure: "fail" } as any },
        reason: RemovalReason.SelfHealingReclaim,
      }),
    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "remove" });
  });
});

describe("resolveWorktreeBackend", () => {
  it("uses native for undefined worktrunk", () => {
    expect(resolveWorktreeBackend({}).kind).toBe("native");
  });

  it("uses native when disabled", () => {
    expect(resolveWorktreeBackend({ worktrunk: { enabled: false } as any }).kind).toBe("native");
  });

  it("uses worktrunk when enabled with binaryPath", () => {
    expect(resolveWorktreeBackend({ worktrunk: { enabled: true, binaryPath: "worktrunk" } as any }).kind).toBe("worktrunk");
  });

  it("uses literal binaryPath over resolver when both are provided", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const resolver = vi.fn().mockResolvedValue("/resolved");
    const backend = resolveWorktreeBackend(
      { worktrunk: { enabled: true, binaryPath: " /literal " } as any },
      { binaryPathResolver: resolver },
    );

    await (backend as WorktrunkWorktreeBackend).remove({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith(
      '"/literal" "remove" "--foreground" "fusion/fn-1"',
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("wires binaryPathResolver when literal is absent", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const resolver = vi.fn().mockResolvedValue("/resolved");
    const backend = resolveWorktreeBackend({ worktrunk: { enabled: true } as any }, { binaryPathResolver: resolver });

    await (backend as WorktrunkWorktreeBackend).remove({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith(
      '"/resolved" "remove" "--foreground" "fusion/fn-1"',
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("preserves null behavior when literal and resolver are absent", async () => {
    const backend = resolveWorktreeBackend({ worktrunk: { enabled: true } as any });

    await expect(
      (backend as WorktrunkWorktreeBackend).remove({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
      }),
    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "remove" });
  });

  it("uses worktrunk when enabled without binaryPath", () => {
    expect(resolveWorktreeBackend({ worktrunk: { enabled: true } as any }).kind).toBe("worktrunk");
  });
});

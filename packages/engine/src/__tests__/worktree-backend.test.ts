import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NativeWorktreeBackend,
  WorktrunkOperationError,
  WorktrunkWorktreeBackend,
  resolveWorktreeBackend,
} from "../worktree-backend.js";

const { execMock, execFileMock, accessMock } = vi.hoisted(() => {
  const mock = vi.fn();
  const fileMock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  (fileMock as any)[Symbol.for("nodejs.util.promisify.custom")] = fileMock;
  return { execMock: mock, execFileMock: fileMock, accessMock: vi.fn() };
});

vi.mock("node:child_process", () => ({ exec: execMock, execFile: execFileMock }));
vi.mock("node:fs/promises", () => ({ access: accessMock }));
vi.mock("../branch-conflicts.js", () => ({
  inspectBranchConflict: vi.fn().mockResolvedValue({ kind: "stale" }),
}));

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
  accessMock.mockReset();
  accessMock.mockResolvedValue(undefined);
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

  it("throws operation failed with stderr/exitCode", async () => {
    execFileMock.mockRejectedValue({ stderr: "bad news", status: 7 });
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
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    execMock.mockResolvedValue({ stdout: "worktree /repo/.worktrees/fusion/fn-1\n", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await backend.create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      startPoint: "main",
      taskId: "FN-1",
    });

    expect(execFileMock).toHaveBeenCalledWith(
      "worktrunk",
      ["switch", "--create", "fusion/fn-1", "--no-hooks", "--no-cd", "--base", "main"],
      expect.objectContaining({ cwd: "/repo", timeout: 120000, maxBuffer: 10485760 }),
    );
  });

  it("invokes remove mapping", async () => {
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await backend.remove({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
    });

    expect(execFileMock).toHaveBeenCalledWith(
      "worktrunk",
      ["remove", "--foreground", "fusion/fn-1"],
      expect.objectContaining({ cwd: "/repo", timeout: 60000, maxBuffer: 10485760 }),
    );
  });

  it("treats remove not-found style failures as idempotent success", async () => {
    execFileMock.mockRejectedValue({ stderr: "branch not found", status: 1 });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" }),
    ).resolves.toBeUndefined();
  });

  it("maps ENOENT to worktrunk_binary_missing", async () => {
    execFileMock.mockRejectedValue({ code: "ENOENT", stderr: "not found" });
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
    execFileMock.mockRejectedValue({ signal: "SIGTERM", stderr: "timed out" });
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

  it("maps rebase conflicts to worktrunk_sync_conflict", async () => {
    execMock.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockRejectedValueOnce({ stderr: "CONFLICT" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.sync({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", branch: "main" }),
    ).rejects.toMatchObject({ code: "worktrunk_sync_conflict", operation: "sync" });
  });

  it("prunes via git worktree prune fallback", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(backend.prune({ rootDir: "/repo" })).resolves.toBeUndefined();
    expect(execMock).toHaveBeenCalledWith(
      "git worktree prune",
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

  it("uses worktrunk when enabled without binaryPath", () => {
    expect(resolveWorktreeBackend({ worktrunk: { enabled: true } as any }).kind).toBe("worktrunk");
  });
});

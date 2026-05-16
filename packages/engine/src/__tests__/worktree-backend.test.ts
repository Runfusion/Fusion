import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NativeWorktreeBackend,
  WorktrunkOperationError,
  WorktrunkWorktreeBackend,
  resolveWorktreeBackend,
} from "../worktree-backend.js";

const { execMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return { execMock: mock };
});

vi.mock("node:child_process", () => ({ exec: execMock }));
vi.mock("../branch-conflicts.js", () => ({
  inspectBranchConflict: vi.fn().mockResolvedValue({ kind: "stale" }),
}));

beforeEach(() => {
  execMock.mockReset();
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

  it("passes timeout/maxBuffer and cwd", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await backend.create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      taskId: "FN-1",
    });

    expect(execMock).toHaveBeenCalledWith(
      '"worktrunk" --help',
      expect.objectContaining({ cwd: "/repo", timeout: 120000, maxBuffer: 10485760 }),
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

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

  it("rethrows immediately when rename disabled", async () => {
    const error = new Error("branch exists");
    execMock.mockRejectedValue(error);

    await expect(
      new NativeWorktreeBackend().create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
        allowSiblingBranchRename: false,
      }),
    ).rejects.toBe(error);

    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("retries with suffixes and resolves on first success", async () => {
    execMock
      .mockRejectedValueOnce(new Error("branch exists"))
      .mockResolvedValueOnce({ stdout: "", stderr: "" });

    const result = await new NativeWorktreeBackend().create({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      taskId: "FN-1",
      allowSiblingBranchRename: true,
    });

    expect(result).toEqual({ path: "/repo/.worktrees/fn-1", branch: "fusion/fn-1-2" });
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'git worktree add -b "fusion/fn-1-2" "/repo/.worktrees/fn-1"',
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("rethrows original error after exhausting suffix retries", async () => {
    const originalError = new Error("branch exists");
    execMock.mockRejectedValue(originalError);

    await expect(
      new NativeWorktreeBackend().create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
        allowSiblingBranchRename: true,
      }),
    ).rejects.toBe(originalError);

    expect(execMock).toHaveBeenCalledTimes(50);
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
      stderr: "worktrunk binary not configured",
      exitCode: null,
    });
  });

  it("throws operation failed with stderr/exitCode", async () => {
    execMock.mockRejectedValue({ stderr: "bad news", code: 7 });
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

  it("returns input path/branch on success", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.create({
        rootDir: "/repo",
        worktreePath: "/repo/.worktrees/fn-1",
        branch: "fusion/fn-1",
        taskId: "FN-1",
      }),
    ).resolves.toEqual({ path: "/repo/.worktrees/fn-1", branch: "fusion/fn-1" });
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
      '"worktrunk" switch --create "fusion/fn-1"',
      expect.objectContaining({ cwd: "/repo", timeout: 120000, maxBuffer: 10485760 }),
    );
  });
});

describe("WorktrunkOperationError", () => {
  it("preserves shape", () => {
    const error = new WorktrunkOperationError("create", "worktrunk_operation_failed", "stderr", 2);
    expect(error.name).toBe("WorktrunkOperationError");
    expect(error.operation).toBe("create");
    expect(error.code).toBe("worktrunk_operation_failed");
    expect(error.stderr).toBe("stderr");
    expect(error.exitCode).toBe(2);
  });
});

describe("resolveWorktreeBackend", () => {
  it("uses native for empty settings", () => {
    expect(resolveWorktreeBackend({}).kind).toBe("native");
  });

  it("uses native for empty worktrunk object", () => {
    expect(resolveWorktreeBackend({ worktrunk: {} }).kind).toBe("native");
  });

  it("uses native when worktrunk disabled", () => {
    expect(resolveWorktreeBackend({ worktrunk: { enabled: false } }).kind).toBe("native");
  });

  it("uses worktrunk when enabled with or without binaryPath", () => {
    expect(resolveWorktreeBackend({ worktrunk: { enabled: true, binaryPath: "worktrunk" } }).kind).toBe("worktrunk");
    expect(resolveWorktreeBackend({ worktrunk: { enabled: true } }).kind).toBe("worktrunk");
  });
});

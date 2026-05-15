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

  it("removes worktree", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new NativeWorktreeBackend();
    await backend.remove({ rootDir: "/repo", worktreePath: "/repo/.worktrees/fn-1", taskId: "FN-1" });
    expect(execMock).toHaveBeenCalledWith(
      'git worktree remove --force "/repo/.worktrees/fn-1"',
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("prunes worktrees", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new NativeWorktreeBackend();
    await backend.prune({ rootDir: "/repo", taskId: "FN-1" });
    expect(execMock).toHaveBeenCalledWith(
      "git worktree prune",
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("implements required methods", () => {
    const backend = new NativeWorktreeBackend();
    expect(backend.kind).toBe("native");
    expect(typeof backend.create).toBe("function");
    expect(typeof backend.remove).toBe("function");
    expect(typeof backend.sync).toBe("function");
    expect(typeof backend.prune).toBe("function");
  });
});

describe("WorktrunkWorktreeBackend", () => {
  it("throws typed error when binary is missing", async () => {
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
      exitCode: null,
    });
  });

  it("maps non-zero exit to worktrunk_operation_failed and preserves stderr", async () => {
    execMock.mockRejectedValue({ stderr: "bad", code: 17 });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await expect(
      backend.prune({ rootDir: "/repo", taskId: "FN-1" }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorktrunkOperationError>>({
        code: "worktrunk_operation_failed",
        stderr: "bad",
        exitCode: 17,
        operation: "prune",
      }),
    );
  });

  it("passes timeout and maxBuffer to exec", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const backend = new WorktrunkWorktreeBackend({ binaryPath: "worktrunk" });

    await backend.sync({
      rootDir: "/repo",
      worktreePath: "/repo/.worktrees/fn-1",
      branch: "fusion/fn-1",
      taskId: "FN-1",
    });

    expect(execMock).toHaveBeenCalledWith(
      '"worktrunk" --help',
      expect.objectContaining({ cwd: "/repo/.worktrees/fn-1", timeout: 120000, maxBuffer: 10485760 }),
    );
  });
});

describe("resolveWorktreeBackend", () => {
  it("defaults to native when worktrunk undefined", () => {
    expect(resolveWorktreeBackend({}).kind).toBe("native");
  });

  it("uses native when enabled=false", () => {
    expect(resolveWorktreeBackend({ worktrunk: { enabled: false } as any }).kind).toBe("native");
  });

  it("uses worktrunk when enabled=true and binaryPath present", () => {
    expect(resolveWorktreeBackend({ worktrunk: { enabled: true, binaryPath: "worktrunk" } as any }).kind).toBe("worktrunk");
  });

  it("uses worktrunk when enabled=true and binaryPath missing", () => {
    expect(resolveWorktreeBackend({ worktrunk: { enabled: true } as any }).kind).toBe("worktrunk");
  });
});

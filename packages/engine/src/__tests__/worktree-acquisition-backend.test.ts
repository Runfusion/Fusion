import { beforeEach, describe, expect, it, vi } from "vitest";
import { acquireTaskWorktree } from "../worktree-acquisition.js";
import type { WorktreeBackend } from "../worktree-backend.js";

vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return { ...actual, isUsableTaskWorktree: vi.fn().mockResolvedValue(true) };
});

vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1 }),
}));

const { execMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return { execMock: mock };
});

vi.mock("node:child_process", () => ({ exec: execMock }));

describe("acquireTaskWorktree backend wiring", () => {
  const task = { id: "FN-1", title: "Task", description: "Desc", branch: null, worktree: null } as any;
  const store = {
    updateTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as any;

  beforeEach(() => {
    execMock.mockReset();
    store.updateTask.mockClear();
    store.logEntry.mockClear();
  });

  it("uses native backend by default and emits no worktrunk audit", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    const result = await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store,
      settings: { worktreeNaming: "task-id" } as any,
      audit,
    });

    expect(result.branch).toBe("fusion/fn-1");
    expect(result.worktreePath).toBe("/repo/.worktrees/fn-1");
    expect(execMock).toHaveBeenCalledWith(
      'git worktree add -b "fusion/fn-1" "/repo/.worktrees/fn-1"',
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(audit.git).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "worktree:worktrunk-create" }),
    );
  });

  it("routes through worktrunk backend when enabled and emits audit once", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store,
      settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, binaryPath: "worktrunk" } } as any,
      audit,
    });

    expect(execMock).toHaveBeenCalledWith(
      '"worktrunk" --help',
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(audit.git).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worktree:worktrunk-create",
        metadata: expect.objectContaining({ branch: "fusion/fn-1" }),
      }),
    );
    expect(
      audit.git.mock.calls.filter(([event]) => event?.type === "worktree:worktrunk-create"),
    ).toHaveLength(1);
    expect(audit.git).toHaveBeenCalledWith(
      expect.objectContaining({ type: "worktree:create" }),
    );
  });

  it("throws worktrunk_binary_missing with no binaryPath", async () => {
    await expect(
      acquireTaskWorktree({
        task,
        rootDir: "/repo",
        store,
        settings: { worktreeNaming: "task-id", worktrunk: { enabled: true } } as any,
      }),
    ).rejects.toMatchObject({ name: "WorktrunkOperationError", code: "worktrunk_binary_missing" });

    expect(execMock).not.toHaveBeenCalled();
  });

  it("throws worktrunk_operation_failed and preserves stderr", async () => {
    execMock.mockRejectedValue({ stderr: "worktrunk exploded", status: 17 });

    await expect(
      acquireTaskWorktree({
        task,
        rootDir: "/repo",
        store,
        settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, binaryPath: "worktrunk" } } as any,
      }),
    ).rejects.toMatchObject({
      name: "WorktrunkOperationError",
      code: "worktrunk_operation_failed",
      stderr: "worktrunk exploded",
      exitCode: 17,
    });
  });

  it("uses explicit backend override", async () => {
    const create = vi.fn().mockResolvedValue({ path: "/tmp/backend", branch: "fusion/fn-backend" });
    const backend: WorktreeBackend = {
      kind: "native",
      create,
      remove: vi.fn(),
      sync: vi.fn().mockResolvedValue({ skipped: true as const }),
      prune: vi.fn(),
    };

    const result = await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store,
      settings: { worktreeNaming: "task-id", worktrunk: { enabled: true } } as any,
      backend,
    });

    expect(result.worktreePath).toBe("/tmp/backend");
    expect(result.branch).toBe("fusion/fn-backend");
    expect(create).toHaveBeenCalledTimes(1);
    expect(execMock).not.toHaveBeenCalled();
  });
});

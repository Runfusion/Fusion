import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
}));
import { acquireTaskWorktree } from "../worktree-acquisition.js";
import type { WorktreeBackend } from "../worktree-backend.js";

vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return { ...actual, isUsableTaskWorktree: vi.fn().mockResolvedValue(true) };
});

vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1 }),
}));

const { execMock, existsSyncMock, accessMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return { execMock: mock, existsSyncMock: vi.fn(), accessMock: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("node:child_process", () => ({ exec: execMock }));
vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));
vi.mock("node:fs/promises", () => ({ access: accessMock }));

describe("acquireTaskWorktree backend wiring", () => {
  const task = { id: "FN-1", title: "Task", description: "Desc", branch: null, worktree: null } as any;
  const store = {
    updateTask: vi.fn().mockResolvedValue(undefined),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as any;

  beforeEach(() => {
    execMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    accessMock.mockReset();
    accessMock.mockResolvedValue(undefined);
    store.updateTask.mockClear();
    store.logEntry.mockClear();
    store.pauseTask.mockClear();
  });

  it("uses native backend by default and emits no worktrunk audit", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const audit = {
      git: vi.fn().mockResolvedValue(undefined),
      database: vi.fn().mockResolvedValue(undefined),
      filesystem: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn().mockResolvedValue(undefined),
    };

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
    execMock.mockImplementation((command: string) => {
      if (command.includes('"config" "show"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command.includes('"switch" "--create"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command === "git worktree list --porcelain") {
        return Promise.resolve({
          stdout: "worktree /repo/.worktrees/fusion/fn-1\nbranch refs/heads/fusion/fn-1\n",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    const audit = {
      git: vi.fn().mockResolvedValue(undefined),
      database: vi.fn().mockResolvedValue(undefined),
      filesystem: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn().mockResolvedValue(undefined),
    };

    await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store,
      settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, binaryPath: "wt" } } as any,
      audit,
    });

    expect(execMock.mock.calls.some((call) => String(call[0]).includes('"wt" "switch" "--create" "fusion/fn-1"'))).toBe(true);
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
    const explicitBinaryPath = "/opt/wt";

    await expect(
      acquireTaskWorktree({
        task,
        rootDir: "/repo",
        store,
        settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, binaryPath: explicitBinaryPath } } as any,
      }),
    ).rejects.toMatchObject({
      name: "WorktrunkOperationError",
      code: "worktrunk_operation_failed",
      stderr: "worktrunk exploded",
      exitCode: 17,
    });
    expect(execMock.mock.calls.some((call) => String(call[0]).includes(`"${explicitBinaryPath}" "switch" "--create"`))).toBe(true);
  });

  it("uses explicit backend override", async () => {
    const create = vi.fn().mockResolvedValue({ path: "/tmp/backend", branch: "fusion/fn-backend" });
    const backend: WorktreeBackend = {
      kind: "native",
      create,
      remove: vi.fn(),
      sync: vi.fn().mockResolvedValue({ skipped: true as const }),
      prune: vi.fn(),
      resolveWorktreePath: vi.fn().mockResolvedValue("/tmp/custom-path"),
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

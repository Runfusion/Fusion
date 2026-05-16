import { describe, it, expect, vi, beforeEach } from "vitest";
import { promisify } from "node:util";
import { acquireTaskWorktree } from "../worktree-acquisition.js";

vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return { ...actual, isUsableTaskWorktree: vi.fn().mockResolvedValue(true) };
});

vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1 }),
}));

describe("acquireTaskWorktree", () => {
  const task = {
    id: "FN-1",
    title: "Task",
    description: "Desc",
    branch: null,
    worktree: null,
  } as any;

  let store: any;
  beforeEach(() => {
    store = {
      updateTask: vi.fn().mockResolvedValue(undefined),
      logEntry: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("reuses existing usable worktree", async () => {
    const result = await acquireTaskWorktree({
      task: { ...task, worktree: process.cwd(), branch: "fusion/fn-1" },
      rootDir: process.cwd(),
      store,
      settings: {},
      createWorktree: vi.fn(),
    });
    expect(result.source).toBe("existing");
    expect(result.worktreePath).toBe(process.cwd());
  });

  it("acquires from pool when enabled", async () => {
    const prepareForTask = vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath: "/tmp/pooled", reclaimed: false });
    const release = vi.fn();
    const result = await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true } as any,
      pool: {
        acquire: () => "/tmp/pooled",
        prepareForTask,
        release,
      } as any,
      createWorktree: vi.fn(),
    });
    expect(release).not.toHaveBeenCalled();
    expect(result.source).toBe("pool");
    expect(prepareForTask).toHaveBeenCalledWith(
      "/tmp/pooled",
      "fusion/fn-1",
      undefined,
      expect.objectContaining({ requestingTaskId: "FN-1" }),
    );
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: "/tmp/pooled", branch: "fusion/fn-1" });
  });

  it("releases acquired pooled worktree when prepareForTask returns reclaimed path", async () => {
    const release = vi.fn();
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true } as any,
      pool: {
        acquire: () => "/tmp/pooled",
        prepareForTask: vi.fn().mockResolvedValue({
          branch: "fusion/fn-1",
          worktreePath: "/tmp/live-existing",
          reclaimed: true,
          existingTipSha: "abc123",
          strandedCommitCount: 2,
        }),
        release,
      } as any,
      createWorktree: vi.fn(),
    });

    expect(release).toHaveBeenCalledWith("/tmp/pooled");
  });

  it("creates fresh when pool disabled", async () => {
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const result = await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: {},
      createWorktree,
    });
    expect(result.source).toBe("fresh");
    expect(createWorktree).toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: "/tmp/new", branch: "fusion/fn-1" });
  });

  it("skips init command when runInitCommand false", async () => {
    const runConfiguredCommand = vi.fn();
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { worktreeInitCommand: "pnpm i" } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" }),
      runConfiguredCommand,
      runInitCommand: false,
    });
    expect(runConfiguredCommand).not.toHaveBeenCalled();
  });
});

describe("acquireTaskWorktree foreign start-point warning", () => {
  it("emits warning/log for fusion/fn-* start point with foreign-attributed tip and stays silent for main", async () => {
    vi.resetModules();
    const warn = vi.fn();
    const logEntry = vi.fn().mockResolvedValue(undefined);

    const execMock: any = (command: string, _opts: any, cb: any) => cb(null, "", "");
    execMock[promisify.custom] = (command: string) => {
      if (command.startsWith("git rev-parse --verify \"fusion/fn-4367^")) {
        return Promise.resolve({ stdout: "deadbeefdeadbeef\n", stderr: "" });
      }
      if (command.startsWith("git log -1 --format=%s%x1f%b")) {
        return Promise.resolve({ stdout: "feat(FN-4367): dep\u001fFusion-Task-Id: FN-4367\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    };

    vi.doMock("node:child_process", () => ({ exec: execMock, execFile: execMock }));
    const mod = await import("../worktree-acquisition.js");

    await mod.acquireTaskWorktree({
      task: { id: "FN-4488", title: "Task", description: "Desc", branch: null, worktree: null, executionStartBranch: "fusion/fn-4367" } as any,
      rootDir: "/tmp/repo",
      store: { updateTask: vi.fn().mockResolvedValue(undefined), logEntry } as any,
      settings: {},
      logger: { log: vi.fn(), warn, error: vi.fn() },
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/repo/.worktrees/x", branch: "fusion/fn-4488" }),
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("worktree acquired with foreign-task start point: fusion/fn-4367"));
    expect(logEntry).toHaveBeenCalledWith("FN-4488", expect.stringContaining("worktree acquired with foreign-task start point: fusion/fn-4367"), undefined, undefined);

    warn.mockClear();
    logEntry.mockClear();

    await mod.acquireTaskWorktree({
      task: { id: "FN-4488", title: "Task", description: "Desc", branch: null, worktree: null, executionStartBranch: "main" } as any,
      rootDir: "/tmp/repo",
      store: { updateTask: vi.fn().mockResolvedValue(undefined), logEntry } as any,
      settings: {},
      logger: { log: vi.fn(), warn, error: vi.fn() },
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/repo/.worktrees/x", branch: "fusion/fn-4488" }),
    });

    expect(warn).not.toHaveBeenCalled();
    expect(logEntry).not.toHaveBeenCalledWith("FN-4488", expect.stringContaining("foreign-task start point"), undefined, undefined);
  });
});

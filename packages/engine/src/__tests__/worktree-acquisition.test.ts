import { describe, it, expect, vi, beforeEach } from "vitest";
import { promisify } from "node:util";
import { acquireTaskWorktree } from "../worktree-acquisition.js";
import { classifyTaskWorktree, PoolDoubleLeaseError } from "../worktree-pool.js";
import { hydrateWorktreeDb } from "../worktree-db-hydrate.js";
import * as desktopArtifacts from "../worktree-desktop-artifacts.js";

vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return {
    ...actual,
    classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: true }),
    isInsideWorktreesDir: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1 }),
}));

vi.mock("../worktree-desktop-artifacts.js", () => ({
  removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }),
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
    vi.clearAllMocks();
    vi.mocked(desktopArtifacts.removeDesktopBuildArtifacts).mockResolvedValue({ removed: [], skipped: [], failures: [] });
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
        acquire: (_taskId: string) => "/tmp/pooled",
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
    expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledWith("/tmp/pooled", undefined);
  });

  it("releases acquired pooled worktree when prepareForTask returns reclaimed path", async () => {
    const release = vi.fn();
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true } as any,
      pool: {
        acquire: (_taskId: string) => "/tmp/pooled",
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

    expect(release).toHaveBeenCalledWith("/tmp/pooled", "FN-1");
  });

  it("falls through to fresh creation when pooled worktree is incomplete and emits detection audit", async () => {
    vi.mocked(classifyTaskWorktree).mockResolvedValueOnce({ ok: false, classification: "incomplete", reason: "missing or invalid .git metadata" });
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const auditGit = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);

    const result = await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true } as any,
      pool: {
        acquire: (_taskId: string) => "/tmp/pooled",
        prepareForTask: vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath: "/tmp/pooled", reclaimed: false }),
        release: vi.fn(),
      } as any,
      createWorktree,
      audit: { git: auditGit } as any,
      backend: { kind: "native", create: vi.fn(), remove } as any,
    });

    expect(result.source).toBe("fresh");
    expect(auditGit).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:incomplete-detected",
      metadata: expect.objectContaining({ classification: "incomplete", source: "pool-acquire" }),
    }));
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("Pool returned incomplete worktree"), undefined, undefined);
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-1", expect.stringMatching(/Refusing to start coding agent/), expect.anything(), expect.anything());
  });

  it("emits resume detection audit and clears session file when assigned worktree is unregistered", async () => {
    vi.mocked(classifyTaskWorktree).mockResolvedValueOnce({ ok: false, classification: "unregistered", reason: "not registered in git worktree list" });
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const auditGit = vi.fn().mockResolvedValue(undefined);

    await acquireTaskWorktree({
      task: { ...task, worktree: process.cwd(), branch: "fusion/fn-1", sessionFile: "/tmp/session.json" },
      rootDir: process.cwd(),
      store,
      settings: {} as any,
      createWorktree,
      audit: { git: auditGit } as any,
    });

    expect(auditGit).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:incomplete-detected",
      metadata: expect.objectContaining({ classification: "unregistered", source: "resume" }),
    }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: null, branch: null, sessionFile: null });
  });

  it("falls through to fresh creation when pool acquire throws PoolDoubleLeaseError", async () => {
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const result = await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true } as any,
      pool: {
        acquire: () => {
          throw new PoolDoubleLeaseError("/tmp/pooled", "FN-OTHER", "FN-1", "acquire");
        },
        prepareForTask: vi.fn(),
        release: vi.fn(),
      } as any,
      createWorktree,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.source).toBe("fresh");
    expect(createWorktree).toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith("FN-1", expect.stringContaining("Pool double-lease guard triggered"), undefined, undefined);
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
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { worktree: "/tmp/new", branch: "fusion/fn-1", executionStartBranch: "fusion/fn-1" });
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

  it("invokes desktop artifact cleanup before init command for fresh acquisition", async () => {
    const runConfiguredCommand = vi.fn().mockResolvedValue({ exitCode: 0, stderr: "", stdout: "" });

    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { worktreeInitCommand: "pnpm install" } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" }),
      runConfiguredCommand,
      runInitCommand: true,
    });

    expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledWith("/tmp/new", undefined);
    const cleanupOrder = vi.mocked(desktopArtifacts.removeDesktopBuildArtifacts).mock.invocationCallOrder[0];
    const initOrder = runConfiguredCommand.mock.invocationCallOrder[0];
    expect(cleanupOrder).toBeLessThan(initOrder);
  });

  it("invokes desktop artifact cleanup once for pooled acquisition", async () => {
    const runConfiguredCommand = vi.fn();

    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true, worktreeInitCommand: "pnpm install" } as any,
      pool: {
        acquire: (_taskId: string) => "/tmp/pooled",
        prepareForTask: vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath: "/tmp/pooled", reclaimed: false }),
        release: vi.fn(),
      } as any,
      createWorktree: vi.fn(),
      runConfiguredCommand,
      runInitCommand: true,
    });

    expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledTimes(1);
    expect(desktopArtifacts.removeDesktopBuildArtifacts).toHaveBeenCalledWith("/tmp/pooled", undefined);
    expect(runConfiguredCommand).not.toHaveBeenCalled();
  });

  it("FN-4834: logs worktree init stderr in task log outcome", async () => {
    const runConfiguredCommand = vi.fn().mockResolvedValue({
      exitCode: 1,
      stderr: "ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date",
      stdout: "",
    });

    await expect(acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { worktreeInitCommand: "pnpm install --frozen-lockfile" } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" }),
      runConfiguredCommand,
      runInitCommand: true,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })).resolves.toBeTruthy();

    const failureCall = store.logEntry.mock.calls.find((call: unknown[]) => String(call[1]).startsWith("Worktree init command failed"));
    expect(failureCall).toBeDefined();
    expect(failureCall?.[2]).toContain("ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE");
  });

  it("FN-043: fresh acquisition persists worktree, branch, and executionStartBranch before hydration", async () => {
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: {},
      createWorktree,
    });
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", {
      worktree: "/tmp/new",
      branch: "fusion/fn-1",
      executionStartBranch: "fusion/fn-1",
    });
    const updateOrder = store.updateTask.mock.invocationCallOrder[0];
    const hydrateOrder = vi.mocked(hydrateWorktreeDb).mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(hydrateOrder);
  });

  it("FN-043: fresh acquisition defaults executionStartBranch to resolved branch when renamed", async () => {
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1-renamed" });
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: {},
      createWorktree,
    });
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", {
      worktree: "/tmp/new",
      branch: "fusion/fn-1-renamed",
      executionStartBranch: "fusion/fn-1-renamed",
    });
  });

  it("FN-043: fresh acquisition preserves existing executionStartBranch", async () => {
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    await acquireTaskWorktree({
      task: { ...task, executionStartBranch: "fusion/fn-0" },
      rootDir: process.cwd(),
      store,
      settings: {},
      createWorktree,
    });
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", {
      worktree: "/tmp/new",
      branch: "fusion/fn-1",
      executionStartBranch: "fusion/fn-0",
    });
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

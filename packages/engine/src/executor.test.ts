import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentSemaphore } from "./concurrency.js";

// Mock external dependencies
vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
}));
vi.mock("./reviewer.js", () => ({
  reviewStep: vi.fn(),
}));
vi.mock("./merger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./merger.js")>();
  return {
    ...actual,
    findWorktreeUser: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("./worktree-names.js", () => ({
  generateWorktreeName: vi.fn().mockReturnValue("swift-falcon"),
}));

// Mock node modules used by executor
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

import { TaskExecutor, buildExecutionPrompt } from "./executor.js";
import { createKbAgent } from "./pi.js";
import { reviewStep as mockedReviewStepFn } from "./reviewer.js";
import { execSync } from "node:child_process";
import { findWorktreeUser, aiMergeTask } from "./merger.js";
import { WorktreePool } from "./worktree-pool.js";
import { generateWorktreeName } from "./worktree-names.js";
import type { Column, Task, TaskDetail } from "@kb/core";

const mockedCreateHaiAgent = vi.mocked(createKbAgent);

function createMockStore() {
  const listeners = new Map<string, Function[]>();
  const store = {
    on: vi.fn((event: string, fn: Function) => {
      const existing = listeners.get(event) || [];
      existing.push(fn);
      listeners.set(event, existing);
    }),
    /** Trigger registered listeners for an event (test helper). */
    _trigger(event: string, ...args: any[]) {
      for (const fn of listeners.get(event) || []) fn(...args);
    },
    emit: vi.fn(),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue({
      id: "KB-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    updateTask: vi.fn().mockResolvedValue({}),
    moveTask: vi.fn().mockResolvedValue({}),
    logEntry: vi.fn().mockResolvedValue(undefined),
    parseStepsFromPrompt: vi.fn().mockResolvedValue([]),
    updateSettings: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn().mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: undefined,
    }),
    updateStep: vi.fn().mockResolvedValue({}),
  };
  return store as any;
}

describe("TaskExecutor with semaphore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acquires semaphore before creating agent and releases after", async () => {
    const sem = new AgentSemaphore(2);
    const store = createMockStore();
    const acquireSpy = vi.spyOn(sem, "acquire");
    const releaseSpy = vi.spyOn(sem, "release");

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", { semaphore: sem });

    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(acquireSpy).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledOnce();
    expect(sem.activeCount).toBe(0);
  });

  it("releases semaphore on agent error", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();

    mockedCreateHaiAgent.mockRejectedValue(new Error("agent failed"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {
      semaphore: sem,
      onError,
    });

    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(sem.activeCount).toBe(0);
    expect(onError).toHaveBeenCalled();
  });

  it("sets task status to 'failed' when execution throws", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockRejectedValue(new Error("agent crashed"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "failed" });
    expect(onError).toHaveBeenCalled();
  });

  it("concurrent executions respect semaphore limit", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();
    let concurrent = 0;
    let maxConcurrent = 0;

    mockedCreateHaiAgent.mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 10));
            concurrent--;
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test", { semaphore: sem });

    const task = (id: string) => ({
      id,
      title: "Test",
      description: "Test",
      column: "in-progress" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await Promise.all([
      executor.execute(task("KB-001")),
      executor.execute(task("KB-002")),
      executor.execute(task("KB-003")),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(sem.activeCount).toBe(0);
  });
});

const mockedExecSync = vi.mocked(execSync);
const { existsSync: mockedExistsSyncRaw } = await import("node:fs");
const mockedExistsSync = vi.mocked(mockedExistsSyncRaw);

describe("TaskExecutor worktreeInitCommand", () => {
  const makeTask = (id = "KB-010") => ({
    id,
    title: "Test",
    description: "Test",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: worktree does NOT exist (new worktree)
    mockedExistsSync.mockReturnValue(false);
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("runs worktreeInitCommand in new worktree when configured", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: "pnpm install",
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // execSync is called for worktree creation + init command
    const initCall = mockedExecSync.mock.calls.find(
      (call) => call[0] === "pnpm install",
    );
    expect(initCall).toBeDefined();
    expect(initCall![1]).toMatchObject({
      cwd: expect.stringContaining(".worktrees/"),
      timeout: 120_000,
    });

    // Should log success
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-010",
      "Worktree init command completed",
      "pnpm install",
    );
  });

  it("does NOT run init command when worktreeInitCommand is not set", async () => {
    const store = createMockStore();
    // getSettings returns default (no worktreeInitCommand)

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Only worktree creation calls to execSync, no "pnpm install" etc.
    const initCall = mockedExecSync.mock.calls.find(
      (call) => typeof call[0] === "string" && !call[0].startsWith("git"),
    );
    expect(initCall).toBeUndefined();
  });

  it("catches init command failure and logs without aborting", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: "npm run setup",
    });

    // Make the init command fail (but not git worktree commands)
    mockedExecSync.mockImplementation((cmd: any) => {
      if (cmd === "npm run setup") {
        const err: any = new Error("command failed");
        err.stderr = Buffer.from("setup script error");
        throw err;
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    await executor.execute(makeTask());

    // Should log the failure
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-010",
      expect.stringContaining("Worktree init command failed"),
    );

    // Should NOT have called onError (task continues)
    expect(onError).not.toHaveBeenCalled();

    // Agent should still have been created
    expect(mockedCreateHaiAgent).toHaveBeenCalled();
  });

  it("does NOT run init command on worktree resume", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: "pnpm install",
    });

    // Worktree already exists (resume)
    mockedExistsSync.mockReturnValue(true);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // getSettings is called (for project commands in execution prompt) but init command should not run
    expect(store.getSettings).toHaveBeenCalled();
  });
});

describe("TaskExecutor worktree naming", () => {
  const makeTask = (id = "KB-030", worktree?: string) => ({
    id,
    title: "Test",
    description: "Test",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(worktree ? { worktree } : {}),
  });

  const mockedGenerateWorktreeName = vi.mocked(generateWorktreeName);

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedGenerateWorktreeName.mockReturnValue("swift-falcon");
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("uses generateWorktreeName for fresh worktree directories", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask());

    // The worktree path stored should use the generated name, not the task ID
    expect(store.updateTask).toHaveBeenCalledWith("KB-030", {
      worktree: "/tmp/test/.worktrees/swift-falcon",
    });
    expect(mockedGenerateWorktreeName).toHaveBeenCalledWith("/tmp/test");
  });

  it("does NOT use task ID as worktree directory name for fresh worktrees", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask("KB-099"));

    // Verify the worktree path does NOT contain the task ID
    const updateCalls = store.updateTask.mock.calls;
    const worktreeUpdate = updateCalls.find(
      (call: any[]) => call[1]?.worktree !== undefined,
    );
    expect(worktreeUpdate).toBeDefined();
    expect(worktreeUpdate![1].worktree).not.toContain("KB-099");
    expect(worktreeUpdate![1].worktree).toContain("swift-falcon");
  });

  it("reuses stored worktree path for resumed tasks", async () => {
    const existingPath = "/tmp/test/.worktrees/calm-river";
    mockedExistsSync.mockReturnValue(true);

    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask("KB-031", existingPath));

    // Should NOT generate a new name — reuse the stored path
    expect(mockedGenerateWorktreeName).not.toHaveBeenCalled();
  });
});

describe("TaskExecutor dependency-based worktree creation", () => {
  const makeTask = (overrides: Partial<Task> = {}) => ({
    id: "KB-060",
    title: "Test",
    description: "Test",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("creates worktree from baseBranch when set on task", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask({
      id: "KB-060",
      baseBranch: "kb/kb-059",
    }));

    // The git worktree add command should include the startPoint
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);
    expect(worktreeAddCalls[0][0]).toContain("kb/kb-059");
  });

  it("creates worktree from HEAD when baseBranch is not set", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask({
      id: "KB-061",
      // no baseBranch
    }));

    // The git worktree add command should NOT include a startPoint
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add -b"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);
    // Command format: git worktree add -b "branch" "path" (no extra ref after path)
    const cmd = worktreeAddCalls[0][0] as string;
    // Count quoted segments: branch + path = 2 quoted args
    const quoted = cmd.match(/"[^"]+"/g) || [];
    expect(quoted).toHaveLength(2);
  });

  it("logs base branch in worktree creation log entry", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask({
      id: "KB-062",
      baseBranch: "kb/kb-061",
    }));

    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-062",
      expect.stringContaining("based on kb/kb-061"),
    );
  });

  it("does not mention base branch in log when baseBranch is not set", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask({
      id: "KB-063",
    }));

    // Check that log entry does NOT mention "based on"
    const logCalls = store.logEntry.mock.calls.filter(
      (call: any[]) => typeof call[1] === "string" && call[1].includes("Worktree created"),
    );
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls[0][1]).not.toContain("based on");
  });

  it("passes baseBranch to pool prepareForTask when using pooled worktree", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/idle-wt");
    mockedExistsSync.mockImplementation(
      (p) => p === "/tmp/test/.worktrees/idle-wt",
    );

    const prepareSpy = vi.spyOn(pool, "prepareForTask");

    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      recycleWorktrees: true,
    });

    const executor = new TaskExecutor(store, "/tmp/test", { pool });

    await executor.execute(makeTask({
      id: "KB-064",
      baseBranch: "kb/kb-063",
    }));

    expect(prepareSpy).toHaveBeenCalledWith(
      "/tmp/test/.worktrees/idle-wt",
      "kb/kb-064",
      "kb/kb-063",
    );
  });

  it("passes undefined to pool prepareForTask when no baseBranch", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/idle-wt");
    mockedExistsSync.mockImplementation(
      (p) => p === "/tmp/test/.worktrees/idle-wt",
    );

    const prepareSpy = vi.spyOn(pool, "prepareForTask");

    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      recycleWorktrees: true,
    });

    const executor = new TaskExecutor(store, "/tmp/test", { pool });

    await executor.execute(makeTask({
      id: "KB-065",
    }));

    expect(prepareSpy).toHaveBeenCalledWith(
      "/tmp/test/.worktrees/idle-wt",
      "kb/kb-065",
      undefined,
    );
  });
});

describe("TaskExecutor worktree pool integration", () => {
  const makeTask = (id = "KB-020") => ({
    id,
    title: "Test",
    description: "Test",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: worktree does NOT exist (new worktree)
    mockedExistsSync.mockReturnValue(false);
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);
  });

  it("acquires from pool when recycleWorktrees is true and pool has idle worktrees", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/idle-wt");
    // Pool path exists on disk, task worktree path does not (not a resume)
    mockedExistsSync.mockImplementation(
      (p) => p === "/tmp/test/.worktrees/idle-wt",
    );

    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      recycleWorktrees: true,
    });

    const executor = new TaskExecutor(store, "/tmp/test", { pool });
    await executor.execute(makeTask());

    // Should NOT call git worktree add (no fresh worktree)
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add"),
    );
    expect(worktreeAddCalls).toHaveLength(0);

    // Should log pool acquisition
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-020",
      expect.stringContaining("Acquired worktree from pool"),
    );

    // Pool should be empty after acquire
    expect(pool.size).toBe(0);
  });

  it("creates fresh worktree when pool is empty", async () => {
    const pool = new WorktreePool();
    // Pool is empty

    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      recycleWorktrees: true,
    });

    const executor = new TaskExecutor(store, "/tmp/test", { pool });
    await executor.execute(makeTask());

    // Should call git worktree add (fresh worktree)
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);

    // Should log worktree creation, NOT pool acquisition
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-020",
      expect.stringContaining("Worktree created at"),
    );
  });

  it("skips worktree init command for pooled worktrees", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/warm-wt");
    // Pool path exists on disk, task worktree path does not
    mockedExistsSync.mockImplementation(
      (p) => p === "/tmp/test/.worktrees/warm-wt",
    );

    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      recycleWorktrees: true,
      worktreeInitCommand: "pnpm install",
    });

    const executor = new TaskExecutor(store, "/tmp/test", { pool });
    await executor.execute(makeTask());

    // "pnpm install" should NOT have been called (pooled worktree has warm cache)
    const initCalls = mockedExecSync.mock.calls.filter(
      (c) => c[0] === "pnpm install",
    );
    expect(initCalls).toHaveLength(0);
  });

  it("does not use pool when recycleWorktrees is false", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/idle-wt");

    const store = createMockStore();
    // recycleWorktrees defaults to false

    const executor = new TaskExecutor(store, "/tmp/test", { pool });
    await executor.execute(makeTask());

    // Should create a fresh worktree, NOT acquire from pool
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);

    // Pool should still have the entry (not acquired)
    expect(pool.size).toBe(1);
  });
});

describe("WorktreePool capacity", () => {
  it("pool does not enforce maxWorktrees — scheduler is the capacity gatekeeper", () => {
    const pool = new WorktreePool();
    pool.release("/tmp/a");
    pool.release("/tmp/b");
    pool.release("/tmp/c");
    pool.release("/tmp/d");
    pool.release("/tmp/e");
    expect(pool.size).toBe(5);
  });
});

describe("Merger worktree pool integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMergerMockStore(overrides: Record<string, any> = {}) {
    const listeners = new Map<string, Function[]>();
    return {
      on: vi.fn((event: string, fn: Function) => {
        const existing = listeners.get(event) || [];
        existing.push(fn);
        listeners.set(event, existing);
      }),
      emit: vi.fn(),
      getTask: vi.fn().mockResolvedValue({
        id: "KB-050",
        title: "Test merge",
        description: "Test",
        column: "in-review",
        dependencies: [],
        worktree: "/tmp/test/.worktrees/KB-050",
        steps: [],
        currentStep: 0,
        log: [],
        prompt: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      updateTask: vi.fn().mockResolvedValue({}),
      moveTask: vi.fn().mockResolvedValue({
        id: "KB-050",
        column: "done",
        dependencies: [],
        steps: [],
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      listTasks: vi.fn().mockResolvedValue([]),
      logEntry: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        groupOverlappingFiles: false,
        autoMerge: false,
        recycleWorktrees: false,
        ...overrides,
      }),
    } as any;
  }

  function mockMergerExecSync(cmd: any, opts?: any): any {
    const s = typeof cmd === "string" ? cmd : "";
    const isString = opts?.encoding === "utf-8";
    if (s.includes("rev-parse --verify")) return isString ? "abc123" : Buffer.from("abc123");
    if (s.includes("git log")) return isString ? "- test commit" : Buffer.from("- test commit");
    if (s.includes("git diff") && s.includes("--stat")) return isString ? "file.ts | 5 +++++" : Buffer.from("file.ts | 5 +++++");
    if (s.includes("diff --cached --quiet")) return isString ? "0" : Buffer.from("0");
    if (s.includes("diff --name-only --diff-filter=U")) return isString ? "" : Buffer.from("");
    return isString ? "" : Buffer.from("");
  }

  it("releases worktree to pool instead of removing when recycleWorktrees is true", async () => {
    const pool = new WorktreePool();
    const store = createMergerMockStore({ recycleWorktrees: true });
    mockedExistsSync.mockReturnValue(true);

    mockedExecSync.mockImplementation(mockMergerExecSync);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const result = await aiMergeTask(store, "/tmp/test", "KB-050", { pool });

    // Worktree should be in the pool, NOT removed
    expect(pool.has("/tmp/test/.worktrees/KB-050")).toBe(true);
    expect(result.worktreeRemoved).toBe(false);

    // git worktree remove should NOT have been called
    const removeCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(removeCalls).toHaveLength(0);
  });

  it("removes worktree normally when recycleWorktrees is false", async () => {
    const pool = new WorktreePool();
    const store = createMergerMockStore({ recycleWorktrees: false });
    mockedExistsSync.mockReturnValue(true);

    mockedExecSync.mockImplementation(mockMergerExecSync);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const result = await aiMergeTask(store, "/tmp/test", "KB-050", { pool });

    // Worktree should NOT be in the pool
    expect(pool.size).toBe(0);
    expect(result.worktreeRemoved).toBe(true);

    // git worktree remove should have been called
    const removeCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(removeCalls.length).toBeGreaterThan(0);
  });
});

function createMockTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "KB-001",
    title: "Test Task",
    description: "A test task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("buildExecutionPrompt", () => {
  it("includes attachment section with absolute paths for image attachments", () => {
    const task = createMockTaskDetail({
      attachments: [
        { filename: "abc123-screenshot.png", originalName: "screenshot.png", mimeType: "image/png", size: 2048, createdAt: new Date().toISOString() },
      ],
    });
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).toContain("## Attachments");
    expect(result).toContain("**screenshot.png** (screenshot)");
    expect(result).toContain("/home/user/project/.kb/tasks/KB-001/attachments/abc123-screenshot.png");
  });

  it("includes attachment section with absolute paths for text attachments", () => {
    const task = createMockTaskDetail({
      attachments: [
        { filename: "def456-error.log", originalName: "error.log", mimeType: "text/plain", size: 512, createdAt: new Date().toISOString() },
      ],
    });
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).toContain("## Attachments");
    expect(result).toContain("**error.log** (text/plain)");
    expect(result).toContain("read for context");
    expect(result).toContain("/home/user/project/.kb/tasks/KB-001/attachments/def456-error.log");
  });

  it("includes both image and text attachments", () => {
    const task = createMockTaskDetail({
      attachments: [
        { filename: "abc-shot.png", originalName: "shot.png", mimeType: "image/png", size: 1024, createdAt: new Date().toISOString() },
        { filename: "def-config.json", originalName: "config.json", mimeType: "application/json", size: 256, createdAt: new Date().toISOString() },
      ],
    });
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).toContain("**shot.png** (screenshot)");
    expect(result).toContain("**config.json** (application/json)");
  });

  it("omits attachment section when no attachments", () => {
    const task = createMockTaskDetail({ attachments: [] });
    const result = buildExecutionPrompt(task, "/home/user/project");

    expect(result).not.toContain("## Attachments");
  });

  it("omits attachment section when attachments is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Attachments");
  });

  it("omits attachment section when rootDir is not provided", () => {
    const task = createMockTaskDetail({
      attachments: [
        { filename: "abc.png", originalName: "test.png", mimeType: "image/png", size: 1024, createdAt: new Date().toISOString() },
      ],
    });
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Attachments");
  });

  it("includes Project Commands section with test command when settings.testCommand is set", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {
      testCommand: "pnpm test",
    } as any);

    expect(result).toContain("## Project Commands");
    expect(result).toContain("- **Test:** `pnpm test`");
    expect(result).not.toContain("- **Build:**");
  });

  it("includes Project Commands section with build command when settings.buildCommand is set", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {
      buildCommand: "pnpm build",
    } as any);

    expect(result).toContain("## Project Commands");
    expect(result).toContain("- **Build:** `pnpm build`");
    expect(result).not.toContain("- **Test:**");
  });

  it("includes both commands when both are set", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {
      testCommand: "pnpm test",
      buildCommand: "pnpm build",
    } as any);

    expect(result).toContain("## Project Commands");
    expect(result).toContain("- **Test:** `pnpm test`");
    expect(result).toContain("- **Build:** `pnpm build`");
  });

  it("omits Project Commands section when neither command is set", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task, "/home/user/project", {} as any);

    expect(result).not.toContain("## Project Commands");
  });

  it("omits Project Commands section when settings is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Project Commands");
  });

  it("passes settings to buildExecutionPrompt in TaskExecutor.execute()", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      testCommand: "npm test",
      buildCommand: "npm run build",
    });

    const mockPrompt = vi.fn().mockResolvedValue(undefined);
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: mockPrompt,
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(mockPrompt).toHaveBeenCalledOnce();
    const agentPrompt = mockPrompt.mock.calls[0][0];
    expect(agentPrompt).toContain("## Project Commands");
    expect(agentPrompt).toContain("- **Test:** `npm test`");
    expect(agentPrompt).toContain("- **Build:** `npm run build`");
  });
});

// Import the summarizeToolArgs helper directly (not affected by mocks above)
describe("summarizeToolArgs", () => {
  // Dynamic import to avoid mock interference
  let summarizeToolArgs: (name: string, args?: Record<string, unknown>) => string | undefined;

  beforeEach(async () => {
    const mod = await vi.importActual<typeof import("./executor.js")>("./executor.js");
    summarizeToolArgs = mod.summarizeToolArgs;
  });

  it("returns command for bash tool", () => {
    expect(summarizeToolArgs("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(summarizeToolArgs("bash", { command: "echo hello" })).toBe("echo hello");
  });

  it("returns long bash commands in full without truncation", () => {
    const longCmd = "a".repeat(100);
    const result = summarizeToolArgs("Bash", { command: longCmd });
    expect(result).toBe(longCmd);
  });

  it("returns path for read/edit/write tools", () => {
    expect(summarizeToolArgs("Read", { path: "src/types.ts" })).toBe("src/types.ts");
    expect(summarizeToolArgs("edit", { path: "src/store.ts" })).toBe("src/store.ts");
    expect(summarizeToolArgs("Write", { path: "out.txt", content: "data" })).toBe("out.txt");
  });

  it("returns first string arg for unknown tools", () => {
    expect(summarizeToolArgs("task_update", { step: 1, status: "done" })).toBe("done");
  });

  it("returns undefined when no args provided", () => {
    expect(summarizeToolArgs("Bash")).toBeUndefined();
    expect(summarizeToolArgs("Bash", {})).toBeUndefined();
  });

  it("returns undefined when no string args found", () => {
    expect(summarizeToolArgs("unknown", { count: 42, flag: true })).toBeUndefined();
  });
});

describe("TaskExecutor pause behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("terminates agent and moves task to todo when paused during execution", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate pause happening during agent execution
            store._trigger("task:updated", { id: "KB-001", paused: true, column: "in-progress" });
            // Simulate the dispose causing an error (session terminated)
            throw new Error("Session terminated");
          }),
          dispose: disposeFn,
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should move to todo, NOT mark as failed
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("KB-001", { status: "failed" });
  });

  it("does not move to in-review when paused during execution (graceful session end)", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate pause — session ends gracefully (no throw)
            store._trigger("task:updated", { id: "KB-001", paused: true, column: "in-progress" });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should NOT move to in-review (paused tasks skip that logic)
    expect(store.moveTask).not.toHaveBeenCalledWith("KB-001", "in-review");
  });

  it("skips paused tasks during resumeOrphaned", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      { id: "KB-001", column: "in-progress", paused: true, title: "Paused task" },
      { id: "KB-002", column: "in-progress", paused: false, title: "Active task" },
    ]);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.resumeOrphaned();

    // Only KB-002 should be resumed (KB-001 is paused)
    expect(store.logEntry).toHaveBeenCalledWith("KB-002", "Resumed after engine restart");
    expect(store.logEntry).not.toHaveBeenCalledWith("KB-001", expect.anything());
  });
});

describe("TaskExecutor global pause behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("disposes all active sessions when settings:updated fires with globalPause: true", async () => {
    const store = createMockStore();
    const disposeFn1 = vi.fn();
    const disposeFn2 = vi.fn();
    let callCount = 0;

    mockedCreateHaiAgent.mockImplementation(async () => {
      callCount++;
      const dispose = callCount === 1 ? disposeFn1 : disposeFn2;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Wait for the global pause to fire; only fire once for first task
            if (callCount === 2) {
              store._trigger("settings:updated", {
                settings: { globalPause: true },
                previous: { globalPause: false },
              });
            }
            throw new Error("Session terminated");
          }),
          dispose,
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");

    // Execute two tasks concurrently
    await Promise.all([
      executor.execute({
        id: "KB-001", title: "T1", description: "T", column: "in-progress",
        dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
      executor.execute({
        id: "KB-002", title: "T2", description: "T", column: "in-progress",
        dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    ]);

    // Both tasks should be moved to todo (not marked as failed)
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
    expect(store.moveTask).toHaveBeenCalledWith("KB-002", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("KB-001", { status: "failed" });
    expect(store.updateTask).not.toHaveBeenCalledWith("KB-002", { status: "failed" });
  });

  it("moves paused tasks to todo (not marked as failed)", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { globalPause: true },
            previous: { globalPause: false },
          });
          throw new Error("Session terminated");
        }),
        dispose: vi.fn(),
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("KB-001", { status: "failed" });
  });

  it("takes no action when globalPause remains false", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Trigger settings:updated but globalPause stays false
          store._trigger("settings:updated", {
            settings: { globalPause: false },
            previous: { globalPause: false },
          });
        }),
        dispose: disposeFn,
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("KB-001", "todo");
  });

  it("takes no action when globalPause transitions from true to true", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Trigger settings:updated but globalPause is already true
          store._trigger("settings:updated", {
            settings: { globalPause: true },
            previous: { globalPause: true },
          });
        }),
        dispose: vi.fn(),
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("KB-001", "todo");
  });
});

describe("TaskExecutor enginePaused agent termination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("disposes all active sessions when enginePaused transitions false→true", async () => {
    const store = createMockStore();
    const disposeFn1 = vi.fn();
    const disposeFn2 = vi.fn();
    let callCount = 0;

    mockedCreateHaiAgent.mockImplementation(async () => {
      callCount++;
      const dispose = callCount === 1 ? disposeFn1 : disposeFn2;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Fire engine pause when the second task starts
            if (callCount === 2) {
              store._trigger("settings:updated", {
                settings: { enginePaused: true },
                previous: { enginePaused: false },
              });
            }
            throw new Error("Session terminated");
          }),
          dispose,
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");

    await Promise.all([
      executor.execute({
        id: "KB-001", title: "T1", description: "T", column: "in-progress",
        dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
      executor.execute({
        id: "KB-002", title: "T2", description: "T", column: "in-progress",
        dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    ]);

    // Both tasks should be moved to todo (not marked as failed)
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
    expect(store.moveTask).toHaveBeenCalledWith("KB-002", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("KB-001", { status: "failed" });
    expect(store.updateTask).not.toHaveBeenCalledWith("KB-002", { status: "failed" });
  });

  it("moves terminated tasks to todo (not failed)", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });
          throw new Error("Session terminated");
        }),
        dispose: vi.fn(),
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("KB-001", { status: "failed" });
  });

  it("takes no action when enginePaused stays false (false→false)", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { enginePaused: false },
            previous: { enginePaused: false },
          });
        }),
        dispose: vi.fn(),
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("KB-001", "todo");
  });

  it("takes no action when enginePaused stays true (true→true)", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: true },
          });
        }),
        dispose: vi.fn(),
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("KB-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("KB-001", "todo");
  });
});

// ── Code review verdict enforcement tests ────────────────────────────

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

/**
 * Helper: executes a task and captures the custom tools passed to createKbAgent.
 * Returns a map of tool name → tool execute function for direct testing.
 */
async function captureTools(): Promise<Record<string, (id: string, params: any) => Promise<any>>> {
  const store = createMockStore();
  store.updateStep.mockResolvedValue({
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "in-progress" },
      { name: "Testing", status: "pending" },
    ],
  });
  mockedExistsSync.mockReturnValue(true);

  let capturedTools: any[] = [];
  mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
    capturedTools = opts.customTools || [];
    return {
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue("leaf-id"),
          branchWithSummary: vi.fn(),
        },
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      },
    } as any;
  });

  const executor = new TaskExecutor(store, "/tmp/test");
  await executor.execute({
    id: "KB-TEST",
    title: "Test",
    description: "Test",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const tools: Record<string, any> = {};
  for (const t of capturedTools) {
    tools[t.name] = t.execute;
  }
  return tools;
}

describe("Code review verdict tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("code review REVISE sets tracking state", async () => {
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Fix the bug",
      summary: "Needs fixes",
    });

    const tools = await captureTools();
    const result = await tools.review_step("call1", {
      step: 1,
      type: "code",
      step_name: "Implement",
      baseline: "abc123",
    });

    expect(result.content[0].text).toContain("REVISE");
    expect(result.content[0].text).toContain("cannot be marked done");

    // Now task_update(step=1, status="done") should be blocked
    const updateResult = await tools.task_update("call2", { step: 1, status: "done" });
    expect(updateResult.content[0].text).toContain("Cannot mark Step 1 as done");
    expect(updateResult.content[0].text).toContain("REVISE");
  });

  it("code review APPROVE clears tracking state", async () => {
    // First: REVISE
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Fix the bug",
      summary: "Needs fixes",
    });

    const tools = await captureTools();
    await tools.review_step("call1", {
      step: 1,
      type: "code",
      step_name: "Implement",
      baseline: "abc123",
    });

    // Verify it's blocked
    const blocked = await tools.task_update("call2", { step: 1, status: "done" });
    expect(blocked.content[0].text).toContain("Cannot mark Step 1 as done");

    // Now: APPROVE
    mockedReviewStep.mockResolvedValue({
      verdict: "APPROVE",
      review: "Looks good",
      summary: "All good",
    });

    await tools.review_step("call3", {
      step: 1,
      type: "code",
      step_name: "Implement",
      baseline: "def456",
    });

    // Now task_update should succeed
    const updateResult = await tools.task_update("call4", { step: 1, status: "done" });
    expect(updateResult.content[0].text).toContain("→ done");
  });

  it("plan review REVISE does NOT set tracking state", async () => {
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Reconsider approach",
      summary: "Plan issues",
    });

    const tools = await captureTools();
    const result = await tools.review_step("call1", {
      step: 1,
      type: "plan",
      step_name: "Implement",
    });

    // Plan REVISE should use the non-enforced text format
    expect(result.content[0].text).toContain("REVISE");
    expect(result.content[0].text).not.toContain("cannot be marked done");

    // task_update should still work (plan reviews are advisory)
    const updateResult = await tools.task_update("call2", { step: 1, status: "done" });
    expect(updateResult.content[0].text).toContain("→ done");
  });
});

describe("Code review verdict enforcement - task_update blocking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("task_update(status='done') is rejected when last code review was REVISE", async () => {
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE",
      review: "Fix issues",
      summary: "Needs work",
    });

    const tools = await captureTools();
    await tools.review_step("call1", {
      step: 1,
      type: "code",
      step_name: "Implement",
      baseline: "abc",
    });

    const result = await tools.task_update("call2", { step: 1, status: "done" });
    expect(result.content[0].text).toContain("Cannot mark Step 1 as done");
    expect(result.content[0].text).toContain("review_step");
  });

  it("task_update succeeds after a subsequent APPROVE", async () => {
    const tools = await captureTools();

    // REVISE first
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Fix", summary: "Bad" });
    await tools.review_step("c1", { step: 1, type: "code", step_name: "Impl", baseline: "a" });

    // Then APPROVE
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "OK", summary: "Good" });
    await tools.review_step("c2", { step: 1, type: "code", step_name: "Impl", baseline: "b" });

    const result = await tools.task_update("c3", { step: 1, status: "done" });
    expect(result.content[0].text).toContain("→ done");
  });

  it("task_update succeeds when no code review was requested (review level 0)", async () => {
    const tools = await captureTools();

    // No review_step calls at all
    const result = await tools.task_update("c1", { step: 1, status: "done" });
    expect(result.content[0].text).toContain("→ done");
  });

  it("plan-only REVISE does NOT block advancement", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Rethink", summary: "Plan issue" });

    const tools = await captureTools();
    await tools.review_step("c1", { step: 1, type: "plan", step_name: "Impl" });

    const result = await tools.task_update("c2", { step: 1, status: "done" });
    expect(result.content[0].text).toContain("→ done");
  });

  it("multiple steps tracked independently (REVISE on step 1 doesn't block step 2)", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Fix", summary: "Bad" });

    const tools = await captureTools();
    await tools.review_step("c1", { step: 1, type: "code", step_name: "Step1", baseline: "a" });

    // Step 1 is blocked
    const blocked = await tools.task_update("c2", { step: 1, status: "done" });
    expect(blocked.content[0].text).toContain("Cannot mark Step 1 as done");

    // Step 2 is NOT blocked (no review for step 2)
    const allowed = await tools.task_update("c3", { step: 2, status: "done" });
    expect(allowed.content[0].text).toContain("→ done");
  });

  it("REVISE tool response text includes re-review instructions", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Bug found", summary: "Issues" });

    const tools = await captureTools();
    const result = await tools.review_step("c1", { step: 1, type: "code", step_name: "Implement", baseline: "abc" });

    expect(result.content[0].text).toContain("cannot be marked done");
    expect(result.content[0].text).toContain("review_step");
    expect(result.content[0].text).toContain('type="code"');
  });

  it("EXECUTOR_SYSTEM_PROMPT contains code review enforcement language", async () => {
    // Capture the system prompt passed to createKbAgent
    let capturedSystemPrompt = "";
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedSystemPrompt = opts.systemPrompt || "";
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: { getLeafId: vi.fn(), branchWithSummary: vi.fn() },
          navigateTree: vi.fn(),
        },
      } as any;
    });

    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-SYS",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Verify enforcement language is present in system prompt
    expect(capturedSystemPrompt).toContain("enforced");
    expect(capturedSystemPrompt).toContain("will be rejected until the code review passes");
    expect(capturedSystemPrompt).toContain("REVISE (plan review)");
    expect(capturedSystemPrompt).toContain("advisory");
  });

  it("task_update with non-done status is not blocked by REVISE", async () => {
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Fix", summary: "Bad" });

    const tools = await captureTools();
    await tools.review_step("c1", { step: 1, type: "code", step_name: "Step1", baseline: "a" });

    // "in-progress" should still work even with REVISE
    const result = await tools.task_update("c2", { step: 1, status: "in-progress" });
    expect(result.content[0].text).toContain("→ in-progress");
  });
});

// ── RETHINK verdict handling tests ───────────────────────────────────

describe("RETHINK verdict handling", () => {
  const makeTask = (id = "KB-040") => ({
    id,
    title: "Test",
    description: "Test",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  /** Return value for store.updateStep that satisfies the task_update tool. */
  function makeStepResult(stepIndex: number, status: string) {
    const steps = Array.from({ length: Math.max(stepIndex + 1, 3) }, (_, i) => ({
      name: `Step ${i}`,
      status: i === stepIndex ? status : "pending",
    }));
    return { steps };
  }

  /**
   * Helper: run executor and capture custom tools from createKbAgent mock.
   * Returns the tools map keyed by tool name.
   */
  async function captureRethinkTools(store: any, options?: any) {
    let capturedTools: any[] = [];
    const mockSessionManager = {
      getLeafId: vi.fn().mockReturnValue("leaf-checkpoint-123"),
      branchWithSummary: vi.fn().mockReturnValue("new-branch-id"),
    };
    const mockNavigateTree = vi.fn().mockResolvedValue({ cancelled: false });
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      sessionManager: mockSessionManager,
      navigateTree: mockNavigateTree,
    };

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return { session: mockSession } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test", options);
    await executor.execute(makeTask());

    const toolMap = new Map<string, any>();
    for (const tool of capturedTools) {
      toolMap.set(tool.name, tool);
    }
    return { toolMap, mockSession, mockSessionManager, mockNavigateTree };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("RETHINK verdict triggers git reset --hard to baseline SHA", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong approach, try something else",
      summary: "Rejected approach",
    });

    const { toolMap } = await captureRethinkTools(store);
    const reviewTool = toolMap.get("review_step");

    // First call task_update to set in-progress (captures checkpoint)
    const updateTool = toolMap.get("task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    // Now call review_step with a baseline
    const result = await reviewTool.execute("call-2", {
      step: 1,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123def",
    });

    // Verify git reset was called
    expect(mockedExecSync).toHaveBeenCalledWith(
      "git reset --hard abc123def",
      expect.objectContaining({ cwd: expect.stringContaining(".worktrees/") }),
    );
  });

  it("RETHINK verdict rewinds session to pre-step checkpoint", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Fundamentally wrong",
      summary: "Bad approach",
    });

    const { toolMap, mockNavigateTree } = await captureRethinkTools(store);

    // Capture checkpoint
    const updateTool = toolMap.get("task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    // Trigger RETHINK
    await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    // Verify navigateTree was called with checkpoint and summarize: false
    expect(mockNavigateTree).toHaveBeenCalledWith("leaf-checkpoint-123", { summarize: false });
  });

  it("RETHINK verdict resets step status to pending", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Try again",
      summary: "Rejected",
    });

    const { toolMap } = await captureRethinkTools(store);

    const updateTool = toolMap.get("task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    // updateStep should be called: once for in-progress, once for pending (reset)
    expect(store.updateStep).toHaveBeenCalledWith("KB-040", 1, "pending");
  });

  it("RETHINK re-prompt includes reviewer feedback", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Your approach uses polling when it should use events",
      summary: "Wrong architecture",
    });

    const { toolMap } = await captureRethinkTools(store);

    const updateTool = toolMap.get("task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    const result = await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    const text = result.content[0].text;
    expect(text).toContain("RETHINK");
    expect(text).toContain("Your approach uses polling when it should use events");
    expect(text).toContain("Take a different approach");
    expect(text).toContain("Do NOT repeat the rejected strategy");
  });

  it("RETHINK without baseline SHA skips git reset but still rewinds conversation", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong approach",
      summary: "Rejected",
    });

    const { toolMap, mockNavigateTree } = await captureRethinkTools(store);

    const updateTool = toolMap.get("task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    // Call review_step WITHOUT baseline
    await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "code",
      step_name: "Test Step",
      // no baseline
    });

    // git reset should NOT be called (no baseline)
    const gitResetCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("git reset --hard"),
    );
    expect(gitResetCalls).toHaveLength(0);

    // But session rewind should still happen
    expect(mockNavigateTree).toHaveBeenCalledWith("leaf-checkpoint-123", { summarize: false });
  });

  it("RETHINK without session checkpoint falls back gracefully", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Bad approach",
      summary: "Rejected",
    });

    const { toolMap, mockNavigateTree } = await captureRethinkTools(store);

    // Do NOT call task_update for step 2, so no checkpoint exists

    // Call review_step for step 2 — should not crash
    const result = await toolMap.get("review_step").execute("call-2", {
      step: 2,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    // navigateTree should NOT be called (no checkpoint)
    expect(mockNavigateTree).not.toHaveBeenCalled();

    // Should still return RETHINK feedback
    expect(result.content[0].text).toContain("RETHINK");
  });

  it("pre-step checkpoint is captured when task_update sets status to in-progress", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { toolMap, mockSessionManager } = await captureRethinkTools(store);

    const updateTool = toolMap.get("task_update");
    await updateTool.execute("call-1", { step: 1, status: "in-progress" });

    // Verify getLeafId was called
    expect(mockSessionManager.getLeafId).toHaveBeenCalled();
  });

  it("RETHINK falls back to branchWithSummary when navigateTree fails", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong approach",
      summary: "Rejected",
    });

    // Create tools but make navigateTree throw
    let capturedTools: any[] = [];
    const mockSessionManager = {
      getLeafId: vi.fn().mockReturnValue("leaf-checkpoint-456"),
      branchWithSummary: vi.fn().mockReturnValue("new-branch-id"),
    };
    const mockNavigateTree = vi.fn().mockRejectedValue(new Error("navigateTree not available"));
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      sessionManager: mockSessionManager,
      navigateTree: mockNavigateTree,
    };

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return { session: mockSession } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    const toolMap = new Map<string, any>();
    for (const tool of capturedTools) toolMap.set(tool.name, tool);

    // Capture checkpoint
    await toolMap.get("task_update").execute("call-1", { step: 1, status: "in-progress" });

    // Trigger RETHINK
    await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "code",
      step_name: "Test Step",
      baseline: "abc123",
    });

    // navigateTree was called but failed → should fall back to branchWithSummary
    expect(mockNavigateTree).toHaveBeenCalled();
    expect(mockSessionManager.branchWithSummary).toHaveBeenCalledWith(
      "leaf-checkpoint-456",
      expect.stringContaining("RETHINK"),
    );
  });
});

// ── Plan RETHINK verdict handling tests ──────────────────────────────

describe("Plan RETHINK verdict handling", () => {
  const makeTask = (id = "KB-050") => ({
    id,
    title: "Test",
    description: "Test",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  function makeStepResult(stepIndex: number, status: string) {
    const steps = Array.from({ length: Math.max(stepIndex + 1, 3) }, (_, i) => ({
      name: `Step ${i}`,
      status: i === stepIndex ? status : "pending",
    }));
    return { steps };
  }

  async function capturePlanRethinkTools(store: any) {
    let capturedTools: any[] = [];
    const mockSessionManager = {
      getLeafId: vi.fn().mockReturnValue("plan-checkpoint-789"),
      branchWithSummary: vi.fn().mockReturnValue("new-branch-id"),
    };
    const mockNavigateTree = vi.fn().mockResolvedValue({ cancelled: false });
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      sessionManager: mockSessionManager,
      navigateTree: mockNavigateTree,
    };

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return { session: mockSession } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    const toolMap = new Map<string, any>();
    for (const tool of capturedTools) {
      toolMap.set(tool.name, tool);
    }
    return { toolMap, mockSession, mockSessionManager, mockNavigateTree };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("plan RETHINK verdict rewinds session to pre-step checkpoint", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Plan is fundamentally flawed",
      summary: "Bad plan",
    });

    const { toolMap, mockNavigateTree } = await capturePlanRethinkTools(store);

    // Capture checkpoint by starting step
    await toolMap.get("task_update").execute("call-1", { step: 1, status: "in-progress" });

    // Trigger plan RETHINK
    await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "plan",
      step_name: "Test Step",
    });

    // Session should be rewound to checkpoint
    expect(mockNavigateTree).toHaveBeenCalledWith("plan-checkpoint-789", { summarize: false });
  });

  it("plan RETHINK verdict does NOT trigger git reset", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong plan",
      summary: "Rejected",
    });

    const { toolMap } = await capturePlanRethinkTools(store);

    await toolMap.get("task_update").execute("call-1", { step: 1, status: "in-progress" });

    // Even if baseline is passed, plan RETHINK should NOT git reset
    await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "plan",
      step_name: "Test Step",
      baseline: "some-sha-that-should-be-ignored",
    });

    // git reset should NOT be called for plan reviews
    const gitResetCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("git reset --hard"),
    );
    expect(gitResetCalls).toHaveLength(0);
  });

  it("plan RETHINK verdict resets step status to pending", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Try another plan",
      summary: "Rejected plan",
    });

    const { toolMap } = await capturePlanRethinkTools(store);

    await toolMap.get("task_update").execute("call-1", { step: 1, status: "in-progress" });

    await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "plan",
      step_name: "Test Step",
    });

    // updateStep should be called with "pending" to reset the step
    expect(store.updateStep).toHaveBeenCalledWith("KB-050", 1, "pending");
  });

  it("plan RETHINK re-prompt includes reviewer feedback and plan-specific language", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "This plan overlooks critical edge cases in error handling",
      summary: "Insufficient plan",
    });

    const { toolMap } = await capturePlanRethinkTools(store);

    await toolMap.get("task_update").execute("call-1", { step: 1, status: "in-progress" });

    const result = await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "plan",
      step_name: "Test Step",
    });

    const text = result.content[0].text;
    expect(text).toContain("RETHINK");
    expect(text).toContain("Your plan was rejected");
    expect(text).toContain("This plan overlooks critical edge cases in error handling");
    expect(text).toContain("Take a different approach to planning this step");
    expect(text).toContain("Do NOT repeat the rejected strategy");
  });

  it("plan RETHINK without session checkpoint falls back gracefully", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Bad plan",
      summary: "Rejected",
    });

    const { toolMap, mockNavigateTree } = await capturePlanRethinkTools(store);

    // Do NOT call task_update for step 2, so no checkpoint exists

    // Call review_step for step 2 — should not crash
    const result = await toolMap.get("review_step").execute("call-2", {
      step: 2,
      type: "plan",
      step_name: "Test Step",
    });

    // navigateTree should NOT be called (no checkpoint)
    expect(mockNavigateTree).not.toHaveBeenCalled();

    // Should still return RETHINK feedback with plan-specific text
    expect(result.content[0].text).toContain("RETHINK");
    expect(result.content[0].text).toContain("Your plan was rejected");
  });

  it("plan RETHINK logs correctly without git reset info", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK",
      review: "Wrong plan",
      summary: "Plan rejected",
    });

    const { toolMap } = await capturePlanRethinkTools(store);

    await toolMap.get("task_update").execute("call-1", { step: 1, status: "in-progress" });

    await toolMap.get("review_step").execute("call-2", {
      step: 1,
      type: "plan",
      step_name: "Test Step",
    });

    // Verify log entry uses plan-specific message (no git reset reference)
    expect(store.logEntry).toHaveBeenCalledWith(
      "KB-050",
      expect.stringContaining("plan rewound"),
      "Plan rejected",
    );
  });
});

// ── task_add_dep tool tests ──────────────────────────────────────────

describe("task_add_dep tool", () => {
  /**
   * Helper: run executor with a customized mock store and capture custom tools.
   * The mock store's getTask is configured to:
   * - Return the executing task (KB-TEST) with configurable dependencies
   * - Return a target task (KB-OTHER) when requested
   * - Throw for unknown task IDs
   */
  async function captureAddDepTools(opts?: { existingDeps?: string[]; targetExists?: boolean }) {
    const existingDeps = opts?.existingDeps ?? [];
    const targetExists = opts?.targetExists ?? true;

    const store = createMockStore();
    store.getTask.mockImplementation(async (id: string) => {
      if (id === "KB-TEST") {
        return {
          id: "KB-TEST",
          title: "Test",
          description: "Test task",
          column: "in-progress",
          dependencies: existingDeps,
          steps: [],
          currentStep: 0,
          log: [],
          prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      if (id === "KB-OTHER" && targetExists) {
        return {
          id: "KB-OTHER",
          title: "Other task",
          description: "Another task",
          column: "todo",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          prompt: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      throw new Error(`Task ${id} not found`);
    });

    store.updateStep.mockResolvedValue({
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "in-progress" },
      ],
    });

    mockedExistsSync.mockReturnValue(true);

    let capturedTools: any[] = [];
    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue("leaf-id"),
            branchWithSummary: vi.fn(),
          },
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-TEST",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: existingDeps,
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const tools: Record<string, any> = {};
    for (const t of capturedTools) {
      tools[t.name] = t.execute;
    }
    return { tools, store };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("adds a valid dependency via store.updateTask when confirm=true", async () => {
    const { tools, store } = await captureAddDepTools();

    const result = await tools.task_add_dep("call1", { task_id: "KB-OTHER", confirm: true });

    expect(result.content[0].text).toContain("Added dependency");
    expect(result.content[0].text).toContain("triage");
    expect(store.updateTask).toHaveBeenCalledWith("KB-TEST", {
      dependencies: ["KB-OTHER"],
    });
  });

  it("returns error for self-dependency", async () => {
    const { tools, store } = await captureAddDepTools();

    const result = await tools.task_add_dep("call1", { task_id: "KB-TEST" });

    expect(result.content[0].text).toContain("Cannot add self-dependency");
    expect(result.content[0].text).toContain("KB-TEST cannot depend on itself");
    // store.updateTask should NOT have been called for dependency update
    // (it may be called for worktree path updates, so we check specifically for dependencies)
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
  });

  it("returns error for non-existent target task", async () => {
    const { tools, store } = await captureAddDepTools({ targetExists: false });

    const result = await tools.task_add_dep("call1", { task_id: "KB-OTHER" });

    expect(result.content[0].text).toContain("KB-OTHER not found");
    expect(result.content[0].text).toContain("Cannot add dependency on a non-existent task");
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
  });

  it("returns informational message for duplicate dependency without duplicating", async () => {
    const { tools, store } = await captureAddDepTools({ existingDeps: ["KB-OTHER"] });

    const result = await tools.task_add_dep("call1", { task_id: "KB-OTHER" });

    expect(result.content[0].text).toContain("already a dependency");
    expect(result.content[0].text).toContain("No changes made");
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
  });

  it("logs the dependency addition via store.logEntry when confirm=true", async () => {
    const { tools, store } = await captureAddDepTools();

    await tools.task_add_dep("call1", { task_id: "KB-OTHER", confirm: true });

    expect(store.logEntry).toHaveBeenCalledWith("KB-TEST", "Added dependency on KB-OTHER — stopping execution for re-specification");
  });

  it("appends to existing dependencies without overwriting when confirm=true", async () => {
    const { tools, store } = await captureAddDepTools({ existingDeps: ["KB-001"] });

    const result = await tools.task_add_dep("call1", { task_id: "KB-OTHER", confirm: true });

    expect(result.content[0].text).toContain("Added dependency");
    expect(store.updateTask).toHaveBeenCalledWith("KB-TEST", {
      dependencies: ["KB-001", "KB-OTHER"],
    });
  });

  it("is registered in customTools array", async () => {
    const { tools } = await captureAddDepTools();

    expect(tools.task_add_dep).toBeDefined();
    expect(typeof tools.task_add_dep).toBe("function");
  });

  it("returns warning without confirm=true and does NOT add dependency", async () => {
    const { tools, store } = await captureAddDepTools();

    const result = await tools.task_add_dep("call1", { task_id: "KB-OTHER" });

    expect(result.content[0].text).toContain("stop execution and discard current work");
    expect(result.content[0].text).toContain("confirm=true");
    // Should NOT have updated dependencies
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
    // Should NOT have logged any dep addition
    const logCalls = store.logEntry.mock.calls.filter(
      (call: any[]) => typeof call[1] === "string" && call[1].includes("Added dependency"),
    );
    expect(logCalls).toHaveLength(0);
  });

  it("validation errors (self-dep, not-found, dedup) return immediately without requiring confirm", async () => {
    // Self-dep — no confirm needed
    const { tools: tools1 } = await captureAddDepTools();
    const selfResult = await tools1.task_add_dep("call1", { task_id: "KB-TEST" });
    expect(selfResult.content[0].text).toContain("Cannot add self-dependency");

    // Not found — no confirm needed
    const { tools: tools2 } = await captureAddDepTools({ targetExists: false });
    const notFoundResult = await tools2.task_add_dep("call1", { task_id: "KB-OTHER" });
    expect(notFoundResult.content[0].text).toContain("not found");

    // Dedup — no confirm needed
    const { tools: tools3 } = await captureAddDepTools({ existingDeps: ["KB-OTHER"] });
    const dedupResult = await tools3.task_add_dep("call1", { task_id: "KB-OTHER" });
    expect(dedupResult.content[0].text).toContain("already a dependency");
  });

  it("with confirm=true triggers depAborted and disposes session", async () => {
    const store = createMockStore();
    store.getTask.mockImplementation(async (id: string) => {
      if (id === "KB-DEP") {
        return {
          id: "KB-DEP",
          title: "Test",
          description: "Test task",
          column: "in-progress",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      if (id === "KB-TARGET") {
        return {
          id: "KB-TARGET",
          title: "Target",
          description: "Target task",
          column: "todo",
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [],
          prompt: "",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      throw new Error(`Task ${id} not found`);
    });

    mockedExistsSync.mockReturnValue(true);

    const disposeFn = vi.fn();
    let capturedTools: any[] = [];

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedTools = opts.customTools || [];
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // The agent calls task_add_dep with confirm=true during execution
            const addDepTool = capturedTools.find((t: any) => t.name === "task_add_dep");
            await addDepTool.execute("call1", { task_id: "KB-TARGET", confirm: true });
            // After dispose is called, session.prompt throws
            throw new Error("Session terminated");
          }),
          dispose: disposeFn,
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue("leaf-id"),
            branchWithSummary: vi.fn(),
          },
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "KB-DEP",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Worktree removal should have been attempted
    const worktreeRemoveCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree remove"),
    );
    expect(worktreeRemoveCalls.length).toBeGreaterThan(0);

    // Branch deletion should have been attempted
    const branchDeleteCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("branch -D") && (c[0] as string).includes("kb/kb-dep"),
    );
    expect(branchDeleteCalls.length).toBeGreaterThan(0);

    // Task should be moved to triage
    expect(store.moveTask).toHaveBeenCalledWith("KB-DEP", "triage");

    // Worktree and status should be cleared
    expect(store.updateTask).toHaveBeenCalledWith("KB-DEP", { worktree: undefined, status: undefined });

    // Task should NOT be marked as failed
    expect(store.updateTask).not.toHaveBeenCalledWith("KB-DEP", { status: "failed" });
  });
});

// ── Usage limit detection in executor ────────────────────────────────

import { UsageLimitPauser } from "./usage-limit-detector.js";

describe("TaskExecutor usage limit detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("triggers global pause when executor catches a usage-limit error", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {
      onError,
      usageLimitPauser: pauser,
    });

    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "executor",
      "KB-001",
      "rate_limit_error: Rate limit exceeded",
    );
    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true });
    // Task should still be marked as failed
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "failed" });
    expect(onError).toHaveBeenCalled();
  });

  it("does NOT trigger global pause for non-usage-limit errors", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockRejectedValue(new Error("connection refused"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {
      onError,
      usageLimitPauser: pauser,
    });

    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(onUsageLimitHitSpy).not.toHaveBeenCalled();
    // Task should still be marked as failed
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "failed" });
  });

  it("works without usageLimitPauser (backward compatible)", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should not crash — just mark as failed
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "failed" });
    expect(onError).toHaveBeenCalled();
  });

  it("triggers global pause when session.prompt() resolves with exhausted-retry error on state.error", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    // session.prompt() resolves normally, but session.state.error is set
    // (this is what happens when pi-coding-agent exhausts retries)
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      state: { error: "rate_limit_error: Rate limit exceeded" },
    };
    mockedCreateHaiAgent.mockResolvedValue({ session: mockSession } as any);

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {
      onError,
      usageLimitPauser: pauser,
    });

    await executor.execute({
      id: "KB-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // UsageLimitPauser should be called
    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "executor",
      "KB-001",
      "rate_limit_error: Rate limit exceeded",
    );
    // Task should be marked as failed
    expect(store.updateTask).toHaveBeenCalledWith("KB-001", { status: "failed" });
    // onError callback should fire
    expect(onError).toHaveBeenCalled();
  });

  it("triggers global pause for overloaded error", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateHaiAgent.mockRejectedValue(new Error("overloaded_error: Overloaded"));

    const executor = new TaskExecutor(store, "/tmp/test", {
      usageLimitPauser: pauser,
    });

    await executor.execute({
      id: "KB-002",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(onUsageLimitHitSpy).toHaveBeenCalledWith(
      "executor",
      "KB-002",
      "overloaded_error: Overloaded",
    );
  });
});

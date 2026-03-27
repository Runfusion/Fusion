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
import { reviewStep } from "./reviewer.js";
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

const mockedReviewStep = vi.mocked(reviewStep);

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
  async function captureTools(store: any, options?: any) {
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

    const { toolMap } = await captureTools(store);
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

    const { toolMap, mockNavigateTree } = await captureTools(store);

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

    const { toolMap } = await captureTools(store);

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

    const { toolMap } = await captureTools(store);

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

    const { toolMap, mockNavigateTree } = await captureTools(store);

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

    const { toolMap, mockNavigateTree } = await captureTools(store);

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

    const { toolMap, mockSessionManager } = await captureTools(store);

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

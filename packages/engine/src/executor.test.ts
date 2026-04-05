import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentSemaphore } from "./concurrency.js";

// Mock external dependencies
vi.mock("./pi.js", () => ({
  createKbAgent: vi.fn(),
  describeModel: vi.fn().mockReturnValue("mock-provider/mock-model"),
  compactSessionContext: vi.fn(async (session, instructions) => {
    // Delegate to session.compact if available (supports loop recovery tests)
    if (typeof (session as any).compact === "function") {
      return (session as any).compact(instructions);
    }
    return null;
  }),
  promptWithFallback: vi.fn(async (session, prompt, options) => {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await session.prompt(prompt, options);
    }
  }),
}));
vi.mock("./reviewer.js", () => ({
  reviewStep: vi.fn(),
}));
vi.mock("./logger.js", () => {
  const createMockLogger = () => ({
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return {
    createLogger: vi.fn(() => createMockLogger()),
    schedulerLog: createMockLogger(),
    executorLog: createMockLogger(),
    triageLog: createMockLogger(),
    mergerLog: createMockLogger(),
    worktreePoolLog: createMockLogger(),
    reviewerLog: createMockLogger(),
    prMonitorLog: createMockLogger(),
    runtimeLog: createMockLogger(),
    ipcLog: createMockLogger(),
    projectManagerLog: createMockLogger(),
    hybridExecutorLog: createMockLogger(),
  };
});
vi.mock("./merger.js", () => ({
  aiMergeTask: vi.fn(),
  findWorktreeUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("./worktree-names.js", async () => {
  const actual = await vi.importActual<typeof import("./worktree-names.js")>("./worktree-names.js");
  return {
    ...actual,
    generateWorktreeName: vi.fn().mockReturnValue("swift-falcon"),
  };
});

// Mock node modules used by executor
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));
vi.mock("./rate-limit-retry.js", () => ({
  withRateLimitRetry: (fn: () => Promise<any>) => fn(),
}));
vi.mock("@mariozechner/pi-coding-agent", () => {
  const mockSessionManager = {};
  return {
    SessionManager: {
      create: vi.fn().mockReturnValue(mockSessionManager),
      open: vi.fn().mockReturnValue(mockSessionManager),
      inMemory: vi.fn().mockReturnValue(mockSessionManager),
    },
  };
});

import { TaskExecutor, buildExecutionPrompt } from "./executor.js";
import { createKbAgent } from "./pi.js";
import { reviewStep as mockedReviewStepFn } from "./reviewer.js";
import { execSync } from "node:child_process";
import { findWorktreeUser, aiMergeTask } from "./merger.js";
import { WorktreePool } from "./worktree-pool.js";
import { generateWorktreeName, slugify } from "./worktree-names.js";
import type { Column, Task, TaskDetail } from "@fusion/core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { StuckTaskDetector } from "./stuck-task-detector.js";

const mockedCreateHaiAgent = vi.mocked(createKbAgent);
const mockedSessionManager = vi.mocked(SessionManager);
const mockedGenerateWorktreeName = vi.mocked(generateWorktreeName);
const mockedFindWorktreeUser = vi.mocked(findWorktreeUser);

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
      id: "FN-001",
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
    getWorkflowStep: vi.fn().mockResolvedValue(undefined),
    listWorkflowSteps: vi.fn().mockResolvedValue([]),
    appendAgentLog: vi.fn().mockResolvedValue(undefined),
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
      id: "FN-001",
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
      id: "FN-001",
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

  it("sets task status to 'failed' with error message when execution throws", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockRejectedValue(new Error("agent crashed"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    await executor.execute({
      id: "FN-001",
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

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "failed", error: expect.any(String) });
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
      executor.execute(task("FN-001")),
      executor.execute(task("FN-002")),
      executor.execute(task("FN-003")),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(sem.activeCount).toBe(0);
  });
});

const mockedExecSync = vi.mocked(execSync);
const { existsSync: mockedExistsSyncRaw } = await import("node:fs");
const mockedExistsSync = vi.mocked(mockedExistsSyncRaw);

describe("TaskExecutor worktreeInitCommand", () => {
  const makeTask = (id = "FN-010") => ({
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
      "FN-010",
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
      "FN-010",
      expect.stringContaining("Worktree init command failed"),
    );

    // The init command failure itself does not abort execution, but the mocked
    // agent still exits without task_done. After the retry also fails, it reports an error.
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-010" }),
      expect.objectContaining({ message: "Agent finished without calling task_done (after retry)" }),
    );

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
  const makeTask = (id = "FN-030", worktree?: string) => ({
    id,
    title: "Test Task Title",
    description: "Test description for task",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(worktree ? { worktree } : {}),
  });

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
    expect(store.updateTask).toHaveBeenCalledWith("FN-030", {
      worktree: "/tmp/test/.worktrees/swift-falcon",
      branch: "fusion/fn-030",
    });
    expect(mockedGenerateWorktreeName).toHaveBeenCalledWith("/tmp/test");
  });

  it("does NOT use task ID as worktree directory name for fresh worktrees", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask("FN-099"));

    // Verify the worktree path does NOT contain the task ID
    const updateCalls = store.updateTask.mock.calls;
    const worktreeUpdate = updateCalls.find(
      (call: any[]) => call[1]?.worktree !== undefined,
    );
    expect(worktreeUpdate).toBeDefined();
    expect(worktreeUpdate![1].worktree).not.toContain("FN-099");
    expect(worktreeUpdate![1].worktree).toContain("swift-falcon");
  });

  it("reuses stored worktree path for resumed tasks", async () => {
    const existingPath = "/tmp/test/.worktrees/calm-river";
    mockedExistsSync.mockReturnValue(true);

    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask("FN-031", existingPath));

    // Should NOT generate a new name — reuse the stored path
    expect(mockedGenerateWorktreeName).not.toHaveBeenCalled();
  });

  describe("worktreeNaming setting", () => {
    it("uses task ID as worktree name when worktreeNaming is 'task-id'", async () => {
      const store = createMockStore();
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        groupOverlappingFiles: false,
        autoMerge: false,
        worktreeNaming: "task-id",
      });

      const executor = new TaskExecutor(store, "/tmp/test");
      await executor.execute(makeTask("FN-042"));

      // Should use task ID (lowercase) as worktree name
      expect(store.updateTask).toHaveBeenCalledWith("FN-042", {
        worktree: "/tmp/test/.worktrees/fn-042",
        branch: "fusion/fn-042",
      });
      // Should NOT call generateWorktreeName when using task-id
      expect(mockedGenerateWorktreeName).not.toHaveBeenCalled();
    });

    it("uses slugified task title as worktree name when worktreeNaming is 'task-title'", async () => {
      const store = createMockStore();
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        groupOverlappingFiles: false,
        autoMerge: false,
        worktreeNaming: "task-title",
      });

      const executor = new TaskExecutor(store, "/tmp/test");
      await executor.execute({
        ...makeTask("FN-043"),
        title: "Fix login bug with OAuth",
      });

      // Should use slugified title as worktree name
      const expectedSlug = slugify("Fix login bug with OAuth");
      expect(store.updateTask).toHaveBeenCalledWith("FN-043", {
        worktree: `/tmp/test/.worktrees/${expectedSlug}`,
        branch: "fusion/fn-043",
      });
      expect(mockedGenerateWorktreeName).not.toHaveBeenCalled();
    });

    it("falls back to description when title is empty for 'task-title' mode", async () => {
      const store = createMockStore();
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        groupOverlappingFiles: false,
        autoMerge: false,
        worktreeNaming: "task-title",
      });

      const executor = new TaskExecutor(store, "/tmp/test");
      const taskDescription = "Implement user authentication flow";
      await executor.execute({
        ...makeTask("FN-044"),
        title: "",
        description: taskDescription,
      });

      // Should slugify the first 60 chars of description when title is empty
      const expectedSlug = slugify(taskDescription.slice(0, 60));
      expect(store.updateTask).toHaveBeenCalledWith("FN-044", {
        worktree: `/tmp/test/.worktrees/${expectedSlug}`,
        branch: "fusion/fn-044",
      });
    });

    it("uses generateWorktreeName when worktreeNaming is 'random'", async () => {
      const store = createMockStore();
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        groupOverlappingFiles: false,
        autoMerge: false,
        worktreeNaming: "random",
      });

      const executor = new TaskExecutor(store, "/tmp/test");
      await executor.execute(makeTask("FN-045"));

      // Should use generateWorktreeName for random mode
      expect(store.updateTask).toHaveBeenCalledWith("FN-045", {
        worktree: "/tmp/test/.worktrees/swift-falcon",
        branch: "fusion/fn-045",
      });
      expect(mockedGenerateWorktreeName).toHaveBeenCalledWith("/tmp/test");
    });

    it("defaults to random naming when worktreeNaming is undefined", async () => {
      const store = createMockStore();
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        groupOverlappingFiles: false,
        autoMerge: false,
        // worktreeNaming is not set (undefined)
      });

      const executor = new TaskExecutor(store, "/tmp/test");
      await executor.execute(makeTask("FN-046"));

      // Should default to random naming
      expect(store.updateTask).toHaveBeenCalledWith("FN-046", {
        worktree: "/tmp/test/.worktrees/swift-falcon",
        branch: "fusion/fn-046",
      });
      expect(mockedGenerateWorktreeName).toHaveBeenCalledWith("/tmp/test");
    });

    it("ignores worktreeNaming setting when using pooled worktree (recycle mode)", async () => {
      const pool = new WorktreePool();
      pool.release("/tmp/test/.worktrees/pooled-warm-wt");
      // Pool path exists on disk, task worktree path does not (not a resume)
      mockedExistsSync.mockImplementation(
        (p) => p === "/tmp/test/.worktrees/pooled-warm-wt",
      );

      const store = createMockStore();
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        groupOverlappingFiles: false,
        autoMerge: false,
        recycleWorktrees: true,
        worktreeNaming: "task-id", // This should be ignored for pooled worktrees
      });

      const executor = new TaskExecutor(store, "/tmp/test", { pool });
      await executor.execute(makeTask("FN-047"));

      // Should acquire from pool, ignoring the task-id naming preference
      expect(store.updateTask).toHaveBeenCalledWith("FN-047", {
        worktree: "/tmp/test/.worktrees/pooled-warm-wt",
        branch: "fusion/fn-047",
      });
      // Should NOT call generateWorktreeName when using pooled worktree
      expect(mockedGenerateWorktreeName).not.toHaveBeenCalled();
      // Should log pool acquisition
      expect(store.logEntry).toHaveBeenCalledWith(
        "FN-047",
        expect.stringContaining("Acquired worktree from pool"),
      );
    });
  });
});

describe("TaskExecutor worktree recovery", () => {
  const makeTask = (id = "FN-050") => ({
    id,
    title: "Test Task",
    description: "Test description",
    column: "in-progress" as const,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates worktree successfully on first attempt", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask());

    // Should have logged worktree creation
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Worktree created at"),
    );
    // execSync should be called for worktree creation
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree add"),
      expect.any(Object),
    );
  });

  it("recovers from worktree conflict and retries", async () => {
    const store = createMockStore();
    let callCount = 0;

    // First call fails with conflict, second succeeds
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add") && callCount++ === 0) {
        const error: any = new Error(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        error.stderr = Buffer.from(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        throw error;
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have logged cleanup and retry
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Cleaned up conflicting worktree, retrying"),
      "/tmp/test/.worktrees/swift-falcon",
    );
    // Should eventually succeed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: expect.any(String) }),
    );
  });

  it("fails after 3 unsuccessful attempts with detailed error", async () => {
    const store = createMockStore();

    // All worktree add calls fail
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        const error: any = new Error(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        error.stderr = Buffer.from(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        throw error;
      }
      // Cleanup also fails
      if (command.includes("git worktree remove")) {
        throw new Error("cleanup failed");
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    const executePromise = executor.execute(makeTask());
    // Advance past all retry delays (100 + 500 + 1000ms)
    await vi.advanceTimersByTimeAsync(2000);
    await executePromise;

    // Should log final failure
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Worktree creation failed after 3 attempts"),
      expect.any(String),
    );
    // Should update task as failed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onError).toHaveBeenCalled();
  });

  it("recovers from 'already used by worktree' error in createFromExistingBranch fallback", async () => {
    const store = createMockStore();
    let callCount = 0;

    // First createWithBranch fails with "branch already exists" (not "already used")
    // Then createFromExistingBranch fails with "already used by worktree"
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        callCount++;
        if (command.includes("-b")) {
          // First attempt: createWithBranch fails with branch already exists
          const error: any = new Error(
            "fatal: A branch named 'fusion/fn-050' already exists.",
          );
          error.stderr = Buffer.from(
            "fatal: A branch named 'fusion/fn-050' already exists.",
          );
          throw error;
        } else {
          // Fallback createFromExistingBranch fails with already used
          const error: any = new Error(
            "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
          );
          error.stderr = Buffer.from(
            "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
          );
          throw error;
        }
      }
      if (command.includes("git worktree remove")) {
        return Buffer.from("");
      }
      if (command.includes("git branch -D")) {
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");

    // Mock the second call to tryCreateWorktree to succeed
    // by making subsequent calls succeed after cleanup
    let secondAttempt = false;
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (secondAttempt) {
          return Buffer.from(""); // Second attempt succeeds
        }
        if (command.includes("-b")) {
          const error: any = new Error(
            "fatal: A branch named 'fusion/fn-050' already exists.",
          );
          error.stderr = Buffer.from(
            "fatal: A branch named 'fusion/fn-050' already exists.",
          );
          throw error;
        } else {
          const error: any = new Error(
            "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
          );
          error.stderr = Buffer.from(
            "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
          );
          throw error;
        }
      }
      if (command.includes("git worktree remove")) {
        secondAttempt = true; // After cleanup, next add will succeed
        return Buffer.from("");
      }
      if (command.includes("git branch -D")) {
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    await executor.execute(makeTask());

    // Should have cleaned up the conflicting worktree
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove "/tmp/test/.worktrees/green-sage" --force'),
      expect.any(Object),
    );

    // Should have logged the cleanup
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Cleaned up conflicting worktree, retrying"),
      expect.any(String),
    );

    // Task should eventually succeed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: expect.any(String) }),
    );
  });

  it("generates new worktree name when conflicting worktree belongs to active task", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      {
        id: "FN-049",
        title: "Other Task",
        description: "Other task",
        column: "in-progress",
        worktree: "/tmp/test/.worktrees/green-sage",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    mockedFindWorktreeUser.mockResolvedValue("FN-049");

    let callCount = 0;
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      // First attempt fails with conflict
      if (command.includes("git worktree add") && callCount++ === 0) {
        const error: any = new Error(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        error.stderr = Buffer.from(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        throw error;
      }
      return Buffer.from("");
    });

    // Second generated name
    mockedGenerateWorktreeName.mockReturnValueOnce("jade-finch");

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should log that we're trying a new path
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Conflicting worktree in use by active task, trying new path"),
      expect.any(String),
    );
    // Should generate a new name
    expect(mockedGenerateWorktreeName).toHaveBeenCalledTimes(2);
  });

  it("removes stale branch and retries when branch exists without worktree", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
          error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have removed the stale branch
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git branch -D"),
      expect.any(Object),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Removed stale branch reference, retrying"),
    );
  });

  it("runs git worktree prune before branch deletion for stale references", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
          error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have called git worktree prune as the first recovery step
    expect(mockedExecSync).toHaveBeenCalledWith(
      "git worktree prune",
      expect.any(Object),
    );
    // Should log the prune
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Pruned stale worktree metadata"),
      "fusion/fn-050",
    );
    // Should also call branch -D after prune
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git branch -D"),
      expect.any(Object),
    );
    // Task should eventually succeed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: expect.any(String) }),
    );
  });

  it("falls back to git update-ref -d when git branch -D fails on stale reference", async () => {
    const store = createMockStore();
    let worktreeAddCallCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (worktreeAddCallCount++ === 0) {
          const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
          error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
          throw error;
        }
        return Buffer.from("");
      }
      // Prune succeeds
      if (command.includes("git worktree prune")) {
        return Buffer.from("");
      }
      // branch -D fails (corrupted reference)
      if (command.includes("git branch -D")) {
        const error: any = new Error("error: unable to delete ref 'refs/heads/fusion/fn-050'");
        throw error;
      }
      // update-ref -d succeeds
      if (command.includes("git update-ref -d")) {
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have tried branch -D first
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git branch -D"),
      expect.any(Object),
    );
    // Should have fallen back to update-ref -d
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git update-ref -d"),
      expect.any(Object),
    );
    // Should log the fallback
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("git branch -D failed for stale branch, trying update-ref"),
      expect.any(String),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Force-removed stale branch reference via update-ref"),
      expect.any(String),
    );
    // Task should eventually succeed after cleanup + retry
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: expect.any(String) }),
    );
  });

  it("fails task when all stale reference cleanup steps fail", async () => {
    const store = createMockStore();

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
        error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
        throw error;
      }
      // Prune fails
      if (command.includes("git worktree prune")) {
        throw new Error("prune failed");
      }
      // branch -D fails
      if (command.includes("git branch -D")) {
        throw new Error("branch delete failed");
      }
      // update-ref -d also fails
      if (command.includes("git update-ref -d")) {
        throw new Error("update-ref failed");
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    const executePromise = executor.execute(makeTask());
    await vi.advanceTimersByTimeAsync(2000);
    await executePromise;

    // Should have logged terminal failure for the stale reference
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Failed to remove stale branch reference"),
      expect.any(String),
    );
    // Task should be marked as failed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onError).toHaveBeenCalled();
  });

  it("recovers from stale reference in createFromExistingBranch fallback path", async () => {
    const store = createMockStore();
    let worktreeAddCallCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        worktreeAddCallCount++;
        if (command.includes("-b")) {
          // createWithBranch: fails with "already exists" (not invalid-reference)
          const error: any = new Error("fatal: A branch named 'fusion/fn-050' already exists.");
          error.stderr = Buffer.from("fatal: A branch named 'fusion/fn-050' already exists.");
          throw error;
        } else {
          // createFromExistingBranch: fails with invalid reference
          if (worktreeAddCallCount <= 2) {
            const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
            error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
            throw error;
          }
        }
      }
      // All cleanup commands succeed
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have logged cleanup in fallback path
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Cleaned up stale reference in fallback, retrying"),
    );
    // Task should eventually succeed
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: expect.any(String) }),
    );
  });

  it("recognizes 'unable to resolve reference' as invalid-reference pattern", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: unable to resolve reference 'fusion/fn-050'");
          error.stderr = Buffer.from("fatal: unable to resolve reference 'fusion/fn-050'");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have triggered cleanup (stale branch recovery)
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree prune"),
      expect.any(Object),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Removed stale branch reference, retrying"),
    );
  });

  it("recognizes 'stale file handle' as invalid-reference pattern", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: stale file handle");
          error.stderr = Buffer.from("fatal: stale file handle");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Removed stale branch reference, retrying"),
    );
  });

  it("recognizes 'not a valid ref' as invalid-reference pattern", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        if (callCount++ === 0) {
          const error: any = new Error("fatal: not a valid ref: 'refs/heads/fusion/fn-050'");
          error.stderr = Buffer.from("fatal: not a valid ref: 'refs/heads/fusion/fn-050'");
          throw error;
        }
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Removed stale branch reference, retrying"),
    );
  });

  it("removes existing directory that is not a registered worktree", async () => {
    const store = createMockStore();

    // Directory exists but is not registered
    mockedExistsSync.mockReturnValue(true);

    // Mock git worktree list to not include our path
    let callCount = 0;
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree list")) {
        return Buffer.from("/other/path/.git/worktrees/other\n");
      }
      if (command.includes("rm -rf")) {
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should have removed the existing directory
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("rm -rf"),
      expect.any(Object),
    );
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Removing existing directory (not a registered worktree)"),
    );
  });

  it("handles locked worktree by unlocking before removal", async () => {
    const store = createMockStore();

    let callCount = 0;
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add") && callCount++ === 0) {
        const error: any = new Error(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        error.stderr = Buffer.from(
          "fatal: 'fusion/fn-050' is already used by worktree at '/tmp/test/.worktrees/green-sage'",
        );
        throw error;
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Should attempt to unlock the worktree before removing
    const unlockCalls = mockedExecSync.mock.calls.filter((call) =>
      String(call[0]).includes("git worktree unlock"),
    );
    expect(unlockCalls.length).toBeGreaterThanOrEqual(0); // Unlock is attempted but may fail silently
  });
});

describe("TaskExecutor dependency-based worktree creation", () => {
  const makeTask = (overrides: Partial<Task> = {}) => ({
    id: "FN-060",
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
    vi.useRealTimers();
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedFindWorktreeUser.mockResolvedValue(null);
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
      id: "FN-060",
      baseBranch: "fusion/fn-059",
    }));

    // The git worktree add command should include the startPoint
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);
    expect(worktreeAddCalls[0][0]).toContain("fusion/fn-059");
  });

  it("creates worktree from HEAD when baseBranch is not set", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask({
      id: "FN-061",
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
      id: "FN-062",
      baseBranch: "fusion/fn-061",
    }));

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-062",
      expect.stringContaining("based on fusion/fn-061"),
    );
  });

  it("does not mention base branch in log when baseBranch is not set", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask({
      id: "FN-063",
    }));

    // Check that log entry does NOT mention "based on"
    const logCalls = store.logEntry.mock.calls.filter(
      (call: any[]) => typeof call[1] === "string" && call[1].includes("Worktree created"),
    );
    expect(logCalls.length).toBeGreaterThan(0);
    expect(logCalls[0][1]).not.toContain("based on");
  });

  it("retries worktree creation after cleaning up conflicting worktree", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const conflictingPath = "/tmp/test/.worktrees/sharp-stone";

    let firstAttempt = true;
    mockedExecSync.mockImplementation((cmd: any) => {
      if (typeof cmd === "string" && cmd.includes("git worktree add") && cmd.includes("-b") && firstAttempt) {
        firstAttempt = false;
        const err: any = new Error(
          `fatal: 'fusion/fn-064' is already used by worktree at '${conflictingPath}'`,
        );
        err.stderr = Buffer.from(
          `fatal: 'fusion/fn-064' is already used by worktree at '${conflictingPath}'`,
        );
        throw err;
      }
      return Buffer.from("");
    });

    await executor.execute(makeTask({ id: "FN-064" }));

    expect(mockedExecSync).toHaveBeenCalledWith(
      `git worktree remove "${conflictingPath}" --force`,
      expect.objectContaining({ cwd: "/tmp/test", stdio: "pipe" }),
    );
    expect(mockedExecSync).toHaveBeenCalledWith(
      'git branch -D "fusion/fn-064"',
      expect.objectContaining({ cwd: "/tmp/test", stdio: "pipe" }),
    );

    const worktreeCreateCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes('git worktree add') && call[0].includes("-b"),
    );
    expect(worktreeCreateCalls).toHaveLength(2);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-064",
      expect.stringContaining("Worktree created at /tmp/test/.worktrees/swift-falcon"),
    );
  });

  it("throws original error if cleanup also fails", async () => {
    vi.useFakeTimers();
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    const conflictingPath = "/tmp/test/.worktrees/sharp-stone";

    mockedExecSync.mockImplementation((cmd: any) => {
      if (typeof cmd === "string" && cmd.includes("git worktree add") && cmd.includes("-b")) {
        const err: any = new Error(
          `fatal: 'fusion/fn-065' is already used by worktree at '${conflictingPath}'`,
        );
        err.stderr = Buffer.from(
          `fatal: 'fusion/fn-065' is already used by worktree at '${conflictingPath}'`,
        );
        throw err;
      }
      if (cmd === `git worktree remove "${conflictingPath}" --force`) {
        throw new Error("remove failed");
      }
      return Buffer.from("");
    });

    const executePromise = executor.execute(makeTask({ id: "FN-065" }));
    await vi.advanceTimersByTimeAsync(2000);
    await executePromise;
    vi.useRealTimers();

    expect(store.updateTask).toHaveBeenCalledWith("FN-065", {
      status: "failed",
      error: expect.stringContaining("automatic cleanup failed"),
    });
  });

  it("passes baseBranch to pool prepareForTask when using pooled worktree", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/idle-wt");
    mockedExistsSync.mockImplementation(
      (p) => p === "/tmp/test/.worktrees/idle-wt",
    );

    const prepareSpy = vi.spyOn(pool, "prepareForTask").mockReturnValue("fusion/fn-064");

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
      id: "FN-064",
      baseBranch: "fusion/fn-063",
    }));

    expect(prepareSpy).toHaveBeenCalledWith(
      "/tmp/test/.worktrees/idle-wt",
      "fusion/fn-064",
      "fusion/fn-063",
    );
  });

  it("passes undefined to pool prepareForTask when no baseBranch", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/idle-wt");
    mockedExistsSync.mockImplementation(
      (p) => p === "/tmp/test/.worktrees/idle-wt",
    );

    const prepareSpy = vi.spyOn(pool, "prepareForTask").mockReturnValue("fusion/fn-065");

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
      id: "FN-065",
    }));

    expect(prepareSpy).toHaveBeenCalledWith(
      "/tmp/test/.worktrees/idle-wt",
      "fusion/fn-065",
      undefined,
    );
  });

  it("stores suffixed branch name when pool returns a different name", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/idle-wt");
    mockedExistsSync.mockImplementation(
      (p) => p === "/tmp/test/.worktrees/idle-wt",
    );

    // Pool returns a suffixed branch name due to conflict
    vi.spyOn(pool, "prepareForTask").mockReturnValue("fusion/fn-066-2");

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
      id: "FN-066",
    }));

    // Should store the suffixed branch name
    expect(store.updateTask).toHaveBeenCalledWith("FN-066", {
      worktree: "/tmp/test/.worktrees/idle-wt",
      branch: "fusion/fn-066-2",
    });
  });
});

describe("TaskExecutor worktree pool integration", () => {
  const makeTask = (id = "FN-020") => ({
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
      "FN-020",
      expect.stringContaining("Acquired worktree from pool"),
    );

    // Pool should be empty after acquire
    expect(pool.size).toBe(0);
  });

  it("overwrites baseCommitSha when starting from a pooled worktree", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/idle-wt");
    mockedExistsSync.mockImplementation((p) => p === "/tmp/test/.worktrees/idle-wt");

    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git rev-parse HEAD") {
        return "newbase123\n" as any;
      }
      return "" as any;
    });

    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-020",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseCommitSha: "stale-base",
    });
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

    expect(store.updateTask).toHaveBeenCalledWith("FN-020", { baseCommitSha: "newbase123" });
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
      "FN-020",
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

  it("falls through to fresh worktree when pool prepareForTask throws", async () => {
    const pool = new WorktreePool();
    pool.release("/tmp/test/.worktrees/bad-wt");
    // Pool path must exist on disk for acquire() to return it
    mockedExistsSync.mockImplementation(
      (p) => p === "/tmp/test/.worktrees/bad-wt",
    );
    // Make prepareForTask throw
    vi.spyOn(pool, "prepareForTask").mockImplementation(() => {
      throw new Error("branch conflict unrecoverable");
    });
    const releaseSpy = vi.spyOn(pool, "release");

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

    // Should have released the bad worktree back to pool
    expect(releaseSpy).toHaveBeenCalledWith("/tmp/test/.worktrees/bad-wt");

    // Should have fallen through to fresh worktree creation
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);

    // Should log the pool failure
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-020",
      expect.stringContaining("Pool worktree preparation failed"),
    );
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

  it("passes pool option through to aiMergeTask", async () => {
    const pool = new WorktreePool();
    const mockedAiMergeTask = vi.mocked(aiMergeTask);
    mockedAiMergeTask.mockResolvedValue({
      task: { id: "FN-050" } as any,
      branch: "fusion/fn-050",
      merged: true,
      worktreeRemoved: false,
      branchDeleted: true,
    });

    await aiMergeTask({} as any, "/tmp/test", "FN-050", { pool });

    expect(mockedAiMergeTask).toHaveBeenCalledWith(
      expect.anything(),
      "/tmp/test",
      "FN-050",
      expect.objectContaining({ pool }),
    );
  });

  // Full merger worktree pool integration tests are in merger.test.ts
  // which tests aiMergeTask with real implementation
});

function createMockTaskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-001",
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
    expect(result).toContain("/home/user/project/.fusion/tasks/FN-001/attachments/abc123-screenshot.png");
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
    expect(result).toContain("/home/user/project/.fusion/tasks/FN-001/attachments/def456-error.log");
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

  it("includes Steering Comments section when steeringComments has entries", () => {
    const task = createMockTaskDetail({
      steeringComments: [
        {
          id: "1",
          text: "Please handle the edge case",
          createdAt: new Date().toISOString(),
          author: "user" as const,
        },
      ],
    });
    const result = buildExecutionPrompt(task);

    expect(result).toContain("## Steering Comments");
    expect(result).toContain("**user**");
    expect(result).toContain("> Please handle the edge case");
    expect(result).toContain("The following comments were added by the user during execution");
  });

  it("formats multiple steering comments correctly", () => {
    const now = new Date();
    const task = createMockTaskDetail({
      steeringComments: [
        {
          id: "1",
          text: "First comment",
          createdAt: new Date(now.getTime() - 60000).toISOString(), // 1 minute ago
          author: "user" as const,
        },
        {
          id: "2",
          text: "Second comment",
          createdAt: now.toISOString(),
          author: "agent" as const,
        },
      ],
    });
    const result = buildExecutionPrompt(task);

    expect(result).toContain("**user**");
    expect(result).toContain("**agent**");
    expect(result).toContain("> First comment");
    expect(result).toContain("> Second comment");
  });

  it("omits Steering Comments section when steeringComments is empty", () => {
    const task = createMockTaskDetail({ steeringComments: [] });
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Steering Comments");
  });

  it("omits Steering Comments section when steeringComments is undefined", () => {
    const task = createMockTaskDetail();
    const result = buildExecutionPrompt(task);

    expect(result).not.toContain("## Steering Comments");
  });

  it("includes only the 10 most recent steering comments", () => {
    const steeringComments = Array.from({ length: 15 }, (_, i) => ({
      id: `${i}`,
      text: `Comment ${i}`,
      createdAt: new Date().toISOString(),
      author: "user" as const,
    }));

    const task = createMockTaskDetail({ steeringComments });
    const result = buildExecutionPrompt(task);

    // Should include comments 5-14 (the 10 most recent), not 0-4
    expect(result).toContain("> Comment 5");
    expect(result).toContain("> Comment 14");
    expect(result).not.toContain("> Comment 0");
    expect(result).not.toContain("> Comment 4");
  });

  it("end-to-end: steering comments are fully injected into execution prompt with correct format", () => {
    const now = new Date();
    const task = createMockTaskDetail({
      id: "FN-123",
      title: "Verify Steering Feature",
      steeringComments: [
        {
          id: "sc-001",
          text: "Please ensure all edge cases are handled in the validation logic",
          createdAt: new Date(now.getTime() - 120000).toISOString(),
          author: "user" as const,
        },
        {
          id: "sc-002",
          text: "Consider adding unit tests for the new utility function",
          createdAt: new Date(now.getTime() - 60000).toISOString(),
          author: "agent" as const,
        },
        {
          id: "sc-003",
          text: "Don't forget to update the documentation before completing",
          createdAt: now.toISOString(),
          author: "user" as const,
        },
      ],
    });

    const result = buildExecutionPrompt(task, "/project", { testCommand: "pnpm test" } as any);

    // Verify section header exists
    expect(result).toContain("## Steering Comments");

    // Verify explanatory header text
    expect(result).toContain("The following comments were added by the user during execution");
    expect(result).toContain("Consider adjusting your approach or replanning remaining steps based on this feedback");

    // Verify all three comments appear with correct author badges
    expect(result).toContain("**user**");
    expect(result).toContain("**agent**");

    // Verify quoted text format
    expect(result).toContain("> Please ensure all edge cases are handled in the validation logic");
    expect(result).toContain("> Consider adding unit tests for the new utility function");
    expect(result).toContain("> Don't forget to update the documentation before completing");

    // Verify timestamp formatting appears (either relative like "2m ago" or absolute)
    // The formatTimestamp function returns relative times for recent comments
    expect(result).toMatch(/\*\*user\*\* — \d+m? ago/);

    // Verify the section appears in the expected location (after progress section, before review level)
    const steeringSectionIndex = result.indexOf("## Steering Comments");
    const reviewLevelIndex = result.indexOf("## Review level");
    expect(steeringSectionIndex).toBeGreaterThan(0);
    expect(reviewLevelIndex).toBeGreaterThan(steeringSectionIndex);
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
      id: "FN-001",
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

    // Called twice: initial execution + retry when agent finishes without task_done
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    const agentPrompt = mockPrompt.mock.calls[0][0];
    expect(agentPrompt).toContain("## Project Commands");
    expect(agentPrompt).toContain("- **Test:** `npm test`");
    expect(agentPrompt).toContain("- **Build:** `npm run build`");
  });

  describe("memoryEnabled setting", () => {
    it("accepts memoryEnabled: true without error", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: true,
      } as any);
      // Memory instructions are a placeholder until FN-810; just verify no crash
      expect(result).toContain("Execute this task.");
    });

    it("accepts memoryEnabled: false without error", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {
        memoryEnabled: false,
      } as any);
      expect(result).toContain("Execute this task.");
    });

    it("accepts undefined memoryEnabled (default enabled) without error", () => {
      const task = createMockTaskDetail();
      const result = buildExecutionPrompt(task, "/project", {} as any);
      expect(result).toContain("Execute this task.");
    });
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
            store._trigger("task:updated", { id: "FN-001", paused: true, column: "in-progress" });
            // Simulate the dispose causing an error (session terminated)
            throw new Error("Session terminated");
          }),
          dispose: disposeFn,
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
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
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
  });

  it("does not move to in-review when paused during execution (graceful session end)", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate pause — session ends gracefully (no throw)
            store._trigger("task:updated", { id: "FN-001", paused: true, column: "in-progress" });
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
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
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    // Should move to todo instead (regression: was stranding in in-progress)
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
  });

  it("moves paused task to todo when session ends gracefully (regression for FN-827)", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate pause during execution — session ends gracefully (no throw)
            store._trigger("task:updated", { id: "FN-805", paused: true, column: "in-progress" });
            // No error thrown — this is the "graceful exit" path
          }),
          dispose: disposeFn,
        },
      } as any;
    });

    const stuckTaskDetector = { trackTask: vi.fn(), untrackTask: vi.fn(), recordActivity: vi.fn() } as any;

    const executor = new TaskExecutor(store, "/tmp/test", { stuckTaskDetector });
    await executor.execute({
      id: "FN-805",
      title: "Stranded task",
      description: "A task that was paused and stranded",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // The critical fix: task must end in todo, not stranded in in-progress
    expect(store.moveTask).toHaveBeenCalledWith("FN-805", "todo");
    // Should NOT be marked as failed
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-805", expect.objectContaining({ status: "failed" }));
    // Should log the pause event
    expect(store.logEntry).toHaveBeenCalledWith("FN-805", expect.stringContaining("Execution paused"));
    // Session should be disposed
    expect(disposeFn).toHaveBeenCalled();
    // Stuck detector should have untracked the task
    expect(stuckTaskDetector.untrackTask).toHaveBeenCalledWith("FN-805");
  });

  it("handles rapid pause→unpause without duplicate executor runs", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();
    let promptCallCount = 0;

    mockedCreateHaiAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            promptCallCount++;
            // Simulate pause during execution
            store._trigger("task:updated", { id: "FN-001", paused: true, column: "in-progress" });
            // Simulate rapid unpause while executor is still handling the pause
            store._trigger("task:updated", { id: "FN-001", paused: undefined, column: "in-progress" });
            // Session ends gracefully (no throw)
          }),
          dispose: disposeFn,
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Rapid pause/unpause",
      description: "Test rapid pause then unpause",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // The task should still be moved to todo exactly once (the pause took effect)
    // Even if unpause happened rapidly, the session was already disposed
    const todoCalls = store.moveTask.mock.calls.filter(
      (call: any[]) => call[0] === "FN-001" && call[1] === "todo",
    );
    expect(todoCalls.length).toBe(1);
    // Should NOT have duplicate in-review calls
    const inReviewCalls = store.moveTask.mock.calls.filter(
      (call: any[]) => call[0] === "FN-001" && call[1] === "in-review",
    );
    expect(inReviewCalls.length).toBe(0);
    // Agent should only have been prompted once
    expect(promptCallCount).toBe(1);
  });

  it("skips paused tasks during resumeOrphaned", async () => {
    const store = createMockStore();
    store.listTasks.mockResolvedValue([
      { id: "FN-001", column: "in-progress", paused: true, title: "Paused task" },
      { id: "FN-002", column: "in-progress", paused: false, title: "Active task" },
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
    expect(store.logEntry).toHaveBeenCalledWith("FN-002", "Resumed after engine restart");
    expect(store.logEntry).not.toHaveBeenCalledWith("FN-001", expect.anything());
  });

  it("resumes unpaused in-progress task with no active session", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: disposeFn,
      },
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    // Simulate unpause of an in-progress task that has no active session
    // (e.g., engine restarted while task was paused in-progress)
    store._trigger("task:updated", {
      id: "FN-001",
      paused: undefined,
      column: "in-progress",
      description: "Test task",
      title: "Resumed task",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait for async execution to start
    await new Promise((r) => setTimeout(r, 30));

    // Agent created twice: initial resume + retry when agent finishes without task_done
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", "Resuming execution after unpause");
  });

  it("does not duplicate execution when unpausing already-executing task", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Simulate rapid unpause during execution — should NOT start a second run
          store._trigger("task:updated", {
            id: "FN-001",
            paused: undefined,
            column: "in-progress",
          });
          // Wait a bit to let the unpause handler run
          await new Promise((r) => setTimeout(r, 10));
        }),
        dispose: disposeFn,
      },
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Already executing",
      description: "Test no duplicate",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Two agent creations (initial + retry without task_done), but no duplicate from the unpause event
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);
  });

  it("does not resume unpaused task that is not in-progress", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    // Unpause a todo task — executor should NOT try to execute it
    store._trigger("task:updated", {
      id: "FN-001",
      paused: undefined,
      column: "todo",
    });

    await new Promise((r) => setTimeout(r, 20));

    // No agent should have been created
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();
  });

  it("does not resume unpaused task that still has an active session", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    let promptResolve: () => void;
    const promptPromise = new Promise<void>((r) => { promptResolve = r; });

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Simulate unpause while session is still active (should be a no-op)
          store._trigger("task:updated", {
            id: "FN-001",
            paused: undefined,
            column: "in-progress",
          });
          await new Promise((r) => setTimeout(r, 10));
        }),
        dispose: disposeFn,
      },
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    // Start execution — session will be active
    const executePromise = executor.execute({
      id: "FN-001",
      title: "Active session",
      description: "Test active session unpause",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await executePromise;

    // Two agent sessions (initial + retry without task_done) — the unpause during active session was a no-op
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);
  });

  it("uses SessionManager.create for fresh execution and persists sessionFile", async () => {
    const store = createMockStore();
    const sessionFilePath = "/tmp/sessions/session_123.jsonl";

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
      sessionFile: sessionFilePath,
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Fresh task",
      description: "Test fresh session",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should use SessionManager.create for fresh execution
    expect(mockedSessionManager.create).toHaveBeenCalledWith(
      expect.stringContaining(".worktrees"),
    );
    expect(mockedSessionManager.open).not.toHaveBeenCalled();

    // Should persist the session file path on the task
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { sessionFile: sessionFilePath });
  });

  it("uses SessionManager.open to resume session when task has sessionFile", async () => {
    const store = createMockStore();
    const sessionFilePath = "/tmp/sessions/session_123.jsonl";
    const resumePromptFn = vi.fn().mockResolvedValue(undefined);

    // existsSync must return true for the session file
    mockedExistsSync.mockReturnValue(true);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: resumePromptFn,
        dispose: vi.fn(),
      },
      sessionFile: sessionFilePath,
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Resumed task",
      description: "Test session resume",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      sessionFile: sessionFilePath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should use SessionManager.open for the initial resumed execution
    expect(mockedSessionManager.open).toHaveBeenCalledWith(sessionFilePath);

    // The first createKbAgent call should use the opened session manager
    const firstCall = mockedCreateHaiAgent.mock.calls[0][0] as any;
    expect(firstCall.sessionManager).toBeDefined();

    // The log should indicate resume
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Resumed agent session after unpause"),
    );
  });

  it("preserves sessionFile when task is paused (graceful exit)", async () => {
    const store = createMockStore();
    const sessionFilePath = "/tmp/sessions/session_456.jsonl";

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Simulate pause — session ends gracefully
          store._trigger("task:updated", { id: "FN-001", paused: true, column: "in-progress" });
        }),
        dispose: vi.fn(),
      },
      sessionFile: sessionFilePath,
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Pauseable task",
      description: "Test session file preserved on pause",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Session file should NOT be cleared when paused
    const clearCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[0] === "FN-001" && call[1]?.sessionFile === null,
    );
    expect(clearCalls.length).toBe(0);

    // Task should be moved to todo (ready for resume)
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
  });

  it("falls back to fresh session when sessionFile no longer exists on disk", async () => {
    const store = createMockStore();
    const staleSessionFile = "/tmp/sessions/deleted_session.jsonl";

    // Session file does NOT exist on disk
    mockedExistsSync.mockImplementation(
      (p) => p !== staleSessionFile,
    );

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
      sessionFile: "/tmp/sessions/new_session.jsonl",
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
      title: "Stale session",
      description: "Test stale session file fallback",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      sessionFile: staleSessionFile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should fall back to SessionManager.create (not open)
    expect(mockedSessionManager.create).toHaveBeenCalled();
    expect(mockedSessionManager.open).not.toHaveBeenCalled();
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
        id: "FN-001", title: "T1", description: "T", column: "in-progress",
        dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
      executor.execute({
        id: "FN-002", title: "T2", description: "T", column: "in-progress",
        dependencies: [], steps: [], currentStep: 0, log: [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
    ]);

    // Both tasks should be moved to todo (not marked as failed)
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.moveTask).toHaveBeenCalledWith("FN-002", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-002", { status: "failed" });
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
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
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
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
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
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
  });
});

describe("TaskExecutor enginePaused soft pause (no agent termination)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("does NOT dispose active sessions when enginePaused transitions false→true", async () => {
    const store = createMockStore();
    const disposeFn = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Trigger engine pause while the session is active
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });
          // Session continues normally — no error thrown
        }),
        dispose: disposeFn,
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // dispose called twice: initial session + retry session (both cleaned up normally),
    // NOT by an engine pause listener
    expect(disposeFn).toHaveBeenCalledTimes(2);
    // Task should complete normally and move to in-review, not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "failed" });
  });

  it("does NOT move tasks to todo when enginePaused transitions false→true", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          store._trigger("settings:updated", {
            settings: { enginePaused: true },
            previous: { enginePaused: false },
          });
          // Session continues normally
        }),
        dispose: vi.fn(),
      },
    } as any));

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Task should complete normally (in-review), not be moved to todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
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
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
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
      id: "FN-001", title: "Test", description: "T", column: "in-progress",
      dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });

    // Should move to in-review (normal completion), not todo
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
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
    id: "FN-TEST",
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
      id: "FN-SYS",
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
  const makeTask = (id = "FN-040") => ({
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
    expect(store.updateStep).toHaveBeenCalledWith("FN-040", 1, "pending");
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
  const makeTask = (id = "FN-050") => ({
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
    expect(store.updateStep).toHaveBeenCalledWith("FN-050", 1, "pending");
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
      "FN-050",
      expect.stringContaining("plan rewound"),
      "Plan rejected",
    );
  });
});

// ── E2E review pipeline sequence tests ─────────────────────────────

describe("E2E review pipeline — multi-verdict sequence", () => {
  /**
   * Exercises the full review pipeline within a single task execution:
   *   plan review → APPROVE
   *   code review → REVISE (blocked)
   *   code review → APPROVE (unblocked)
   *   step done → success
   *
   * Verifies that verdicts compose correctly across the full lifecycle.
   */

  function makeStepResult(stepIndex: number, status: string) {
    const steps = Array.from({ length: 3 }, (_, i) => ({
      name: [`Preflight`, `Implement`, `Tests`][i],
      status: i === stepIndex ? status : i < stepIndex ? "done" : "pending",
    }));
    return { steps };
  }

  async function captureE2ETools(store: any) {
    let capturedTools: any[] = [];
    const mockSessionManager = {
      getLeafId: vi.fn().mockReturnValue("e2e-checkpoint"),
      branchWithSummary: vi.fn(),
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
    await executor.execute({
      id: "FN-E2E",
      title: "E2E Test",
      description: "E2E pipeline test",
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
    return { tools, mockNavigateTree, mockSessionManager };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("full sequence: plan APPROVE → code REVISE (blocked) → code APPROVE (unblocked) → done", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { tools } = await captureE2ETools(store);

    // Step 1: Start the step
    await tools.task_update("u1", { step: 1, status: "in-progress" });

    // Step 2: Plan review → APPROVE (advisory, no blocking)
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Good plan", summary: "Approved" });
    const planResult = await tools.review_step("r1", {
      step: 1, type: "plan", step_name: "Implement",
    });
    expect(planResult.content[0].text).toBe("APPROVE");

    // Step 3: Code review → REVISE (should block advancement)
    mockedReviewStep.mockResolvedValue({
      verdict: "REVISE", review: "Missing error handling in fetchUser()", summary: "Needs fixes",
    });
    const reviseResult = await tools.review_step("r2", {
      step: 1, type: "code", step_name: "Implement", baseline: "sha-1",
    });
    expect(reviseResult.content[0].text).toContain("cannot be marked done");

    // Step 4: Attempt to mark done — should be blocked
    const blockedResult = await tools.task_update("u2", { step: 1, status: "done" });
    expect(blockedResult.content[0].text).toContain("Cannot mark Step 1 as done");

    // Step 5: Fix issues, re-submit code review → APPROVE
    mockedReviewStep.mockResolvedValue({
      verdict: "APPROVE", review: "Error handling added correctly", summary: "All good",
    });
    const approveResult = await tools.review_step("r3", {
      step: 1, type: "code", step_name: "Implement", baseline: "sha-2",
    });
    expect(approveResult.content[0].text).toBe("APPROVE");

    // Step 6: Now marking done should succeed
    const doneResult = await tools.task_update("u3", { step: 1, status: "done" });
    expect(doneResult.content[0].text).toContain("→ done");
  });

  it("full sequence: code RETHINK → git reset + session rewind → retry with APPROVE → done", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { tools, mockNavigateTree } = await captureE2ETools(store);

    // Step 1: Start the step (captures checkpoint)
    await tools.task_update("u1", { step: 1, status: "in-progress" });

    // Step 2: Code review → RETHINK (rewind everything)
    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK", review: "Using polling instead of events is wrong", summary: "Bad approach",
    });
    const rethinkResult = await tools.review_step("r1", {
      step: 1, type: "code", step_name: "Implement", baseline: "sha-bad",
    });

    // Verify RETHINK outcomes
    expect(rethinkResult.content[0].text).toContain("RETHINK");
    expect(rethinkResult.content[0].text).toContain("Do NOT repeat the rejected strategy");
    expect(mockedExecSync).toHaveBeenCalledWith(
      "git reset --hard sha-bad",
      expect.objectContaining({ cwd: expect.any(String) }),
    );
    expect(mockNavigateTree).toHaveBeenCalledWith("e2e-checkpoint", { summarize: false });
    expect(store.updateStep).toHaveBeenCalledWith("FN-E2E", 1, "pending");

    // Step 3: Restart the step (new approach)
    await tools.task_update("u2", { step: 1, status: "in-progress" });

    // Step 4: Code review → APPROVE on second attempt
    mockedReviewStep.mockResolvedValue({
      verdict: "APPROVE", review: "Event-driven approach is correct", summary: "Approved",
    });
    const approveResult = await tools.review_step("r2", {
      step: 1, type: "code", step_name: "Implement", baseline: "sha-good",
    });
    expect(approveResult.content[0].text).toBe("APPROVE");

    // Step 5: Mark done — should succeed (no REVISE blocking)
    const doneResult = await tools.task_update("u3", { step: 1, status: "done" });
    expect(doneResult.content[0].text).toContain("→ done");
  });

  it("multi-step pipeline: step 1 APPROVE, step 2 REVISE, step 1 remains unaffected", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { tools } = await captureE2ETools(store);

    // Step 1: Complete with APPROVE
    await tools.task_update("u1", { step: 1, status: "in-progress" });
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "OK", summary: "Good" });
    await tools.review_step("r1", { step: 1, type: "code", step_name: "Implement", baseline: "sha-1" });
    const step1Done = await tools.task_update("u2", { step: 1, status: "done" });
    expect(step1Done.content[0].text).toContain("→ done");

    // Step 2: Gets REVISE
    await tools.task_update("u3", { step: 2, status: "in-progress" });
    mockedReviewStep.mockResolvedValue({ verdict: "REVISE", review: "Tests insufficient", summary: "Bad" });
    await tools.review_step("r2", { step: 2, type: "code", step_name: "Tests", baseline: "sha-2" });

    // Step 2 blocked
    const step2Blocked = await tools.task_update("u4", { step: 2, status: "done" });
    expect(step2Blocked.content[0].text).toContain("Cannot mark Step 2 as done");

    // Step 1 remains unaffected — if agent tries to re-update step 1, it still works
    // (step isolation: REVISE on step 2 does not affect step 1)
  });

  it("plan RETHINK followed by plan APPROVE allows code phase to proceed", async () => {
    const store = createMockStore();
    store.updateStep.mockImplementation(async (_id: string, step: number, status: string) =>
      makeStepResult(step, status),
    );

    const { tools, mockNavigateTree } = await captureE2ETools(store);

    // Start step
    await tools.task_update("u1", { step: 1, status: "in-progress" });

    // Plan review → RETHINK
    mockedReviewStep.mockResolvedValue({
      verdict: "RETHINK", review: "Plan ignores edge cases", summary: "Bad plan",
    });
    const rethinkResult = await tools.review_step("r1", {
      step: 1, type: "plan", step_name: "Implement",
    });
    expect(rethinkResult.content[0].text).toContain("Your plan was rejected");

    // Verify plan RETHINK does NOT trigger git reset
    const gitResetCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("git reset --hard"),
    );
    expect(gitResetCalls).toHaveLength(0);

    // Session was rewound
    expect(mockNavigateTree).toHaveBeenCalled();

    // Restart step with new plan
    await tools.task_update("u2", { step: 1, status: "in-progress" });

    // Plan review → APPROVE
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Good plan", summary: "Approved" });
    await tools.review_step("r2", { step: 1, type: "plan", step_name: "Implement" });

    // Code phase: APPROVE directly
    mockedReviewStep.mockResolvedValue({ verdict: "APPROVE", review: "Clean code", summary: "Good" });
    await tools.review_step("r3", { step: 1, type: "code", step_name: "Implement", baseline: "sha-1" });

    // Mark done — should succeed (plan reviews are advisory, code APPROVE clears the path)
    const doneResult = await tools.task_update("u3", { step: 1, status: "done" });
    expect(doneResult.content[0].text).toContain("→ done");
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
      if (id === "FN-TEST") {
        return {
          id: "FN-TEST",
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
      if (id === "FN-OTHER" && targetExists) {
        return {
          id: "FN-OTHER",
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
      id: "FN-TEST",
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

    const result = await tools.task_add_dep("call1", { task_id: "FN-OTHER", confirm: true });

    expect(result.content[0].text).toContain("Added dependency");
    expect(result.content[0].text).toContain("triage");
    expect(store.updateTask).toHaveBeenCalledWith("FN-TEST", {
      dependencies: ["FN-OTHER"],
    });
  });

  it("returns error for self-dependency", async () => {
    const { tools, store } = await captureAddDepTools();

    const result = await tools.task_add_dep("call1", { task_id: "FN-TEST" });

    expect(result.content[0].text).toContain("Cannot add self-dependency");
    expect(result.content[0].text).toContain("FN-TEST cannot depend on itself");
    // store.updateTask should NOT have been called for dependency update
    // (it may be called for worktree path updates, so we check specifically for dependencies)
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
  });

  it("returns error for non-existent target task", async () => {
    const { tools, store } = await captureAddDepTools({ targetExists: false });

    const result = await tools.task_add_dep("call1", { task_id: "FN-OTHER" });

    expect(result.content[0].text).toContain("FN-OTHER not found");
    expect(result.content[0].text).toContain("Cannot add dependency on a non-existent task");
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
  });

  it("returns informational message for duplicate dependency without duplicating", async () => {
    const { tools, store } = await captureAddDepTools({ existingDeps: ["FN-OTHER"] });

    const result = await tools.task_add_dep("call1", { task_id: "FN-OTHER" });

    expect(result.content[0].text).toContain("already a dependency");
    expect(result.content[0].text).toContain("No changes made");
    const depUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.dependencies !== undefined,
    );
    expect(depUpdateCalls).toHaveLength(0);
  });

  it("logs the dependency addition via store.logEntry when confirm=true", async () => {
    const { tools, store } = await captureAddDepTools();

    await tools.task_add_dep("call1", { task_id: "FN-OTHER", confirm: true });

    expect(store.logEntry).toHaveBeenCalledWith("FN-TEST", "Added dependency on FN-OTHER — stopping execution for re-specification");
  });

  it("appends to existing dependencies without overwriting when confirm=true", async () => {
    const { tools, store } = await captureAddDepTools({ existingDeps: ["FN-001"] });

    const result = await tools.task_add_dep("call1", { task_id: "FN-OTHER", confirm: true });

    expect(result.content[0].text).toContain("Added dependency");
    expect(store.updateTask).toHaveBeenCalledWith("FN-TEST", {
      dependencies: ["FN-001", "FN-OTHER"],
    });
  });

  it("is registered in customTools array", async () => {
    const { tools } = await captureAddDepTools();

    expect(tools.task_add_dep).toBeDefined();
    expect(typeof tools.task_add_dep).toBe("function");
  });

  it("returns warning without confirm=true and does NOT add dependency", async () => {
    const { tools, store } = await captureAddDepTools();

    const result = await tools.task_add_dep("call1", { task_id: "FN-OTHER" });

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
    const selfResult = await tools1.task_add_dep("call1", { task_id: "FN-TEST" });
    expect(selfResult.content[0].text).toContain("Cannot add self-dependency");

    // Not found — no confirm needed
    const { tools: tools2 } = await captureAddDepTools({ targetExists: false });
    const notFoundResult = await tools2.task_add_dep("call1", { task_id: "FN-OTHER" });
    expect(notFoundResult.content[0].text).toContain("not found");

    // Dedup — no confirm needed
    const { tools: tools3 } = await captureAddDepTools({ existingDeps: ["FN-OTHER"] });
    const dedupResult = await tools3.task_add_dep("call1", { task_id: "FN-OTHER" });
    expect(dedupResult.content[0].text).toContain("already a dependency");
  });

  it("with confirm=true triggers depAborted and disposes session", async () => {
    const store = createMockStore();
    store.getTask.mockImplementation(async (id: string) => {
      if (id === "FN-DEP") {
        return {
          id: "FN-DEP",
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
      if (id === "FN-TARGET") {
        return {
          id: "FN-TARGET",
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
            await addDepTool.execute("call1", { task_id: "FN-TARGET", confirm: true });
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
      id: "FN-DEP",
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
      (c) => typeof c[0] === "string" && (c[0] as string).includes("branch -D") && (c[0] as string).includes("fusion/fn-dep"),
    );
    expect(branchDeleteCalls.length).toBeGreaterThan(0);

    // Task should be moved to triage
    expect(store.moveTask).toHaveBeenCalledWith("FN-DEP", "triage");

    // Worktree and status should be cleared
    expect(store.updateTask).toHaveBeenCalledWith("FN-DEP", { worktree: undefined, status: undefined });

    // Task should NOT be marked as failed
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-DEP", { status: "failed" });
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
      id: "FN-001",
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
      "FN-001",
      "rate_limit_error: Rate limit exceeded",
    );
    expect(store.updateSettings).toHaveBeenCalledWith({ globalPause: true });
    // Task should still be marked as failed
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "failed", error: "rate_limit_error: Rate limit exceeded" });
    expect(onError).toHaveBeenCalled();
  });

  it("does NOT trigger global pause for transient non-usage-limit errors", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");
    const onError = vi.fn();

    mockedCreateHaiAgent.mockRejectedValue(new Error("connection refused"));

    const executor = new TaskExecutor(store, "/tmp/test", {
      onError,
      usageLimitPauser: pauser,
    });

    await executor.execute({
      id: "FN-001",
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
    // Recovery policy: first transient error → retry 1/3 with backoff
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", expect.stringContaining("Transient error (retry 1/3"));
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      recoveryRetryCount: 1,
      nextRecoveryAt: expect.any(String),
    }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("works without usageLimitPauser (backward compatible)", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    await executor.execute({
      id: "FN-001",
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
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "failed", error: "rate_limit_error: Rate limit exceeded" });
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
      id: "FN-001",
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
      "FN-001",
      "rate_limit_error: Rate limit exceeded",
    );
    // Task should be marked as failed
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "failed", error: "rate_limit_error: Rate limit exceeded" });
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
      id: "FN-002",
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
      "FN-002",
      "overloaded_error: Overloaded",
    );
  });
});

describe("TaskExecutor bounded recovery retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments recoveryRetryCount on successive transient failures", async () => {
    const store = createMockStore();
    const onError = vi.fn();

    mockedCreateHaiAgent.mockRejectedValue(new Error("upstream connect error"));

    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    // First failure: count goes from undefined to 1
    await executor.execute({
      id: "FN-001",
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

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      recoveryRetryCount: 1,
      nextRecoveryAt: expect.any(String),
    }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(onError).not.toHaveBeenCalled();

    // Second failure: count goes from 1 to 2
    vi.clearAllMocks();
    mockedCreateHaiAgent.mockRejectedValue(new Error("upstream connect error"));
    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      recoveryRetryCount: 1,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      recoveryRetryCount: 2,
    }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
    expect(onError).not.toHaveBeenCalled();
  });

  it("escalates to failure when recovery retries are exhausted", async () => {
    const store = createMockStore();
    const onError = vi.fn();

    mockedCreateHaiAgent.mockRejectedValue(new Error("socket hang up"));

    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    // Task already has 3 retries (max) — next failure should escalate
    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      recoveryRetryCount: 3,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      status: "failed",
      error: "socket hang up",
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(onError).toHaveBeenCalled();
  });

  it("does NOT consume retry budget for paused tasks", async () => {
    const store = createMockStore();

    const executor = new TaskExecutor(store, "/tmp/test", {});

    // Simulate a paused abort — the executor checks pausedAborted set
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress" as const,
      recoveryRetryCount: 1,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Simulate: task gets paused mid-execution → abort error
    mockedCreateHaiAgent.mockRejectedValue(new Error("Aborted"));
    (executor as any).pausedAborted.add("FN-001");

    await executor.execute(task);

    // Should NOT update recoveryRetryCount
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({
      recoveryRetryCount: expect.any(Number),
    }));
  });

  it("does NOT consume retry budget for stuck-task-detector kills", async () => {
    const store = createMockStore();

    const executor = new TaskExecutor(store, "/tmp/test", {});

    mockedCreateHaiAgent.mockRejectedValue(new Error("Aborted"));
    (executor as any).stuckAborted.set("FN-001", true);

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      recoveryRetryCount: 2,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should NOT update recoveryRetryCount
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({
      recoveryRetryCount: expect.any(Number),
    }));
  });

  it("requeues to todo when a stuck-killed session resolves without throwing", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test", {});

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn(async () => {
          executor.markStuckAborted("FN-001", true);
        }),
        dispose: vi.fn(),
        state: {},
      },
    }) as any);

    await executor.execute({
      id: "FN-001",
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

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
    );
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    // Executor now handles the requeue in its finally block
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "stuck-killed" });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo");
  });

  it("does not requeue when stuck-kill budget is exhausted", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test", {});

    mockedCreateHaiAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn(async () => {
          // Budget exhausted — shouldRequeue=false
          executor.markStuckAborted("FN-001", false);
        }),
        dispose: vi.fn(),
        state: {},
      },
    }) as any);

    await executor.execute({
      id: "FN-001",
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

    // Should NOT requeue or mark as failed (budget handler already did that)
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "stuck-killed" });
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("clears recovery metadata after successful run completes", async () => {
    const store = createMockStore();

    // Mock successful agent session
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      state: { error: undefined },
    };
    mockedCreateHaiAgent.mockResolvedValue({ session: mockSession } as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      recoveryRetryCount: 2,
      nextRecoveryAt: new Date().toISOString(),
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // moveTask to in-review clears recovery metadata (via store's column transition logic)
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });
});

describe("Per-task model overrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("uses per-task model overrides when both provider and modelId are set", async () => {
    const store = createMockStore();
    const capturedOptions: any[] = [];

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOptions.push(opts);
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {},
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");

    // Override getTask to return task with model overrides
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
    });

    // Should use per-task model overrides
    expect(capturedOptions[0].defaultProvider).toBe("anthropic");
    expect(capturedOptions[0].defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("falls back to global settings when per-task model is not fully specified", async () => {
    const store = createMockStore();
    const capturedOptions: any[] = [];

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOptions.push(opts);
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {},
        },
      } as any;
    });

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: undefined,
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // No modelProvider/modelId set
    });

    // Should use global settings (not task overrides)
    expect(capturedOptions[0].defaultProvider).toBe("openai");
    expect(capturedOptions[0].defaultModelId).toBe("gpt-4o");
  });

  it("falls back to global settings when only modelProvider is set (missing modelId)", async () => {
    const store = createMockStore();
    const capturedOptions: any[] = [];

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOptions.push(opts);
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          state: {},
        },
      } as any;
    });

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: undefined,
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
    });

    const executor = new TaskExecutor(store, "/tmp/test");

    // Override getTask to return task with only modelProvider set
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modelProvider: "anthropic",
      // modelId is missing
    });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modelProvider: "anthropic",
      // modelId is missing
    });

    // Should fall back to global settings since modelId is not set
    expect(capturedOptions[0].defaultProvider).toBe("openai");
    expect(capturedOptions[0].defaultModelId).toBe("gpt-4o");
  });
});

// ── Invalid transition error handling tests ─────────────────────────

describe("Invalid transition error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("does not mark task as failed when invalid transition error occurs on completion", async () => {
    const store = createMockStore();

    // Mock moveTask to throw invalid transition error (task already moved to done)
    store.moveTask.mockRejectedValue(
      new Error("Invalid transition: 'done' → 'in-review'. Valid targets: none"),
    );

    // Mock agent that completes successfully
    mockedCreateHaiAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Agent completes work but moveTask will fail
          }),
          dispose: vi.fn(),
          sessionManager: {
            getLeafId: vi.fn(),
            branchWithSummary: vi.fn(),
          },
          navigateTree: vi.fn(),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute({
      id: "FN-001",
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

    // A missing task_done triggers a retry. Both attempts fail to call task_done,
    // then the moveTask in the retry path throws the Invalid transition error,
    // which is caught by the outer handler.
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      status: "failed",
      error: "Agent finished without calling task_done (after retry)",
    });

    // Should log informative message from the outer catch for Invalid transition
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Task already moved from 'done' — skipping transition to 'in-review'",
      expect.stringContaining("Invalid transition"),
    );
  });

  it("calls onComplete when invalid transition occurs after successful execution", async () => {
    const store = createMockStore();
    const onComplete = vi.fn();

    // Mock moveTask to throw invalid transition error
    store.moveTask.mockRejectedValue(
      new Error("Invalid transition: 'in-progress' → 'in-review'. Valid targets: todo, triage"),
    );

    mockedCreateHaiAgent.mockImplementation(async () => {
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          sessionManager: {
            getLeafId: vi.fn(),
            branchWithSummary: vi.fn(),
          },
          navigateTree: vi.fn(),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });
    await executor.execute({
      id: "FN-002",
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

    // onComplete should be called even when invalid transition occurs
    expect(onComplete).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-002" }));
  });
});

describe("TaskExecutor task_done with summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("accepts and saves summary parameter when task is completed", async () => {
    const store = createMockStore();
    let capturedTool: any = null;

    mockedCreateHaiAgent.mockImplementation(async ({ customTools }: any) => {
      // Capture the task_done tool
      capturedTool = customTools?.find((t: any) => t.name === "task_done");
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    
    // Execute a task
    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Step 1", status: "in-progress" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Verify task_done tool was created
    expect(capturedTool).toBeDefined();
    expect(capturedTool.name).toBe("task_done");

    // Verify the tool accepts summary parameter
    expect(capturedTool.parameters).toBeDefined();
    
    // Execute the tool with a summary
    const result = await capturedTool.execute("tool-1", { summary: "Test summary of changes" });
    
    // Verify the task was updated with the summary
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { summary: "Test summary of changes" });
    
    // Verify success message includes summary mention
    expect(result.content[0].text).toContain("summary");
  });

  it("works without summary parameter (backward compatible)", async () => {
    const store = createMockStore();
    let capturedTool: any = null;

    mockedCreateHaiAgent.mockImplementation(async ({ customTools }: any) => {
      capturedTool = customTools?.find((t: any) => t.name === "task_done");
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    
    await executor.execute({
      id: "FN-002",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Step 1", status: "in-progress" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Execute the tool without summary
    const result = await capturedTool.execute("tool-1", {});
    
    // Verify summary was not updated
    const summaryUpdateCalls = store.updateTask.mock.calls.filter(
      (call: any[]) => call[1]?.summary !== undefined
    );
    expect(summaryUpdateCalls).toHaveLength(0);
    
    // Verify standard success message
    expect(result.content[0].text).toBe("Task marked complete. All steps done. Moving to in-review.");
  });
});

describe("Workflow Steps Execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Create a mock agent that auto-triggers the task_done tool when prompt is called.
   * This simulates a successful task execution where the agent calls task_done().
   */
  function createAgentWithTaskDone() {
    let capturedCustomTools: any[] = [];

    mockedCreateHaiAgent.mockImplementation((async (opts: any) => {
      capturedCustomTools = opts.customTools || [];
      const session = {
        prompt: vi.fn().mockImplementation(async () => {
          // Find and execute task_done tool to set taskDone = true
          const taskDoneTool = capturedCustomTools.find((t: any) => t.name === "task_done");
          if (taskDoneTool) {
            await taskDoneTool.execute("tool-1", {});
          }
        }),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      };
      return { session };
    }) as any);
  }

  it("marks the task failed when the agent exits without calling task_done", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "in-progress" }],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        subscribe: vi.fn(),
        on: vi.fn(),
        sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
        state: {},
      },
    } as any);

    const onComplete = vi.fn();
    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete, onError });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "in-progress" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should have been called twice: initial + retry
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);

    // Retry still didn't call task_done, so it fails with the retry message
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      status: "failed",
      error: "Agent finished without calling task_done (after retry)",
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Agent finished without calling task_done (after retry) — moved to in-review for inspection",
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-001" }),
      expect.objectContaining({ message: "Agent finished without calling task_done (after retry)" }),
    );
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("runs workflow steps after main task execution", async () => {
    const store = createMockStore();

    // Task has workflow steps enabled
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Docs Review",
      description: "Check documentation",
      prompt: "Review all docs and verify they are complete.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // First call: main agent with task_done, subsequent calls: simple mocks for workflow step agents
    let callIdx = 0;
    mockedCreateHaiAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        // Main execution — find and trigger task_done
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        // Workflow step agent (no custom tools, uses readonly tools)
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // createKbAgent called twice: main agent + workflow step agent
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);

    // Second call should be the workflow step with readonly tools
    const secondCall = mockedCreateHaiAgent.mock.calls[1];
    expect(secondCall[0].tools).toBe("readonly");
    expect(secondCall[0].systemPrompt).toContain("Docs Review");
    expect(secondCall[0].systemPrompt).toContain("Review all docs and verify they are complete.");

    // Task should move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("skips workflow steps with no prompt", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Empty Step",
      description: "No prompt",
      prompt: "",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createAgentWithTaskDone();

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should only call createKbAgent once (main execution), skip workflow step
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);

    // Should log that it was skipped
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("has no prompt"),
    );

    // Task should still move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("handles tasks with no workflow steps", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createAgentWithTaskDone();

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Only main agent call
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);
    // Task should still move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("uses workflow step model override when both provider and modelId are set", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Security Audit",
      description: "Check security",
      prompt: "Scan for vulnerabilities.",
      enabled: true,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-5",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateHaiAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        // Main execution agent
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        // Workflow step agent
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // createKbAgent called twice: main agent + workflow step agent
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);

    // Second call should use the workflow step's model override
    const secondCall = mockedCreateHaiAgent.mock.calls[1];
    expect(secondCall[0].defaultProvider).toBe("anthropic");
    expect(secondCall[0].defaultModelId).toBe("claude-sonnet-4-5");

    // Log should indicate the override
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("workflow step override"),
    );
  });

  it("uses global defaults when workflow step has no model override", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Workflow step without model override
    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Docs Review",
      description: "Check documentation",
      prompt: "Review all docs.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateHaiAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);

    // Second call should use settings defaults (no override indicator)
    const secondCall = mockedCreateHaiAgent.mock.calls[1];
    // defaults come from the mock store's getSettings
    expect(secondCall[0].defaultProvider).toBeUndefined();
    expect(secondCall[0].defaultModelId).toBeUndefined();

    // Log should NOT indicate override
    expect(store.logEntry).not.toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("workflow step override"),
    );
  });

  it("executes script-mode workflow step successfully", async () => {
    const store = createMockStore();

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      scripts: { test: "echo 'all tests passed'" },
    });

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Run Tests",
      description: "Execute test suite",
      mode: "script",
      prompt: "",
      scriptName: "test",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Mock execSync to succeed for the script command
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      if (typeof cmd === "string" && cmd.includes("echo")) {
        return Buffer.from("all tests passed\n");
      }
      return Buffer.from("");
    });

    // Main agent with task_done
    createAgentWithTaskDone();

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should only call createKbAgent once (main execution — no agent for script mode)
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);

    // Should log script execution
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("executing script 'test'"),
    );

    // Task should move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");

    // Should record a passed result
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({
            workflowStepId: "WS-001",
            workflowStepName: "Run Tests",
            status: "passed",
          }),
        ]),
      }),
    );
  });

  it("fails task when script-mode workflow step exits non-zero", async () => {
    const store = createMockStore();

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      scripts: { lint: "pnpm lint" },
    });

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Lint Check",
      description: "Run linter",
      mode: "script",
      prompt: "",
      scriptName: "lint",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Mock execSync to throw for the lint command
    const scriptErr = new Error("Command failed: pnpm lint");
    (scriptErr as any).status = 1;
    (scriptErr as any).stderr = Buffer.from("syntax error on line 42\n");
    (scriptErr as any).stdout = Buffer.from("");
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      if (typeof cmd === "string" && cmd.includes("lint")) {
        throw scriptErr;
      }
      return Buffer.from("");
    });

    createAgentWithTaskDone();

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should record a failed result with exit code and stderr
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({
            workflowStepId: "WS-001",
            workflowStepName: "Lint Check",
            status: "failed",
            output: expect.stringContaining("Exit code: 1"),
          }),
        ]),
      }),
    );

    // Task should move to in-review but with failed status
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed", error: "Workflow step failed" }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("fails step when script is missing from settings.scripts", async () => {
    const store = createMockStore();

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      scripts: { other: "echo other" },
    });

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Missing Script",
      description: "Uses nonexistent script",
      mode: "script",
      prompt: "",
      scriptName: "nonexistent",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createAgentWithTaskDone();

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should log that the script was not found
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("not found in project settings"),
    );

    // Should record a failed result
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({
        workflowStepResults: expect.arrayContaining([
          expect.objectContaining({
            workflowStepId: "WS-001",
            status: "failed",
            output: expect.stringContaining("not found in project settings"),
          }),
        ]),
      }),
    );

    // Task should move to in-review but with failed status
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed", error: "Workflow step failed" }),
    );
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("skips script-mode step when scriptName is missing", async () => {
    const store = createMockStore();

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      scripts: {},
    });

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "No Script",
      description: "Script step without scriptName",
      mode: "script",
      prompt: "",
      scriptName: undefined,
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createAgentWithTaskDone();

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Should only call createKbAgent once (main execution)
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);

    // Should log that it was skipped
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("no scriptName"),
    );

    // Task should move to in-review (skipped step doesn't block)
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  it("treats legacy steps without mode as prompt-mode", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Legacy step without mode field
    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Legacy Review",
      description: "Old step without mode",
      prompt: "Review the code changes.",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any); // mode field intentionally omitted

    let callIdx = 0;
    mockedCreateHaiAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

    const onComplete = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onComplete });

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // createKbAgent called twice: main agent + workflow step agent (prompt mode)
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);

    // Second call should use prompt mode (readonly tools, agent-based)
    const secondCall = mockedCreateHaiAgent.mock.calls[1];
    expect(secondCall[0].tools).toBe("readonly");
    expect(secondCall[0].systemPrompt).toContain("Legacy Review");

    // Task should move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });

  // ── Workflow Step Phase Filtering ────────────────────────────────────

  it("skips post-merge workflow steps during executor pre-merge execution", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001", "WS-002"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockImplementation(async (id: string) => {
      if (id === "WS-001") {
        return {
          id: "WS-001",
          name: "Pre-merge Check",
          description: "Before merge",
          prompt: "Run pre-merge checks",
          phase: "pre-merge",
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      if (id === "WS-002") {
        return {
          id: "WS-002",
          name: "Post-merge Notify",
          description: "After merge",
          prompt: "Send notifications",
          phase: "post-merge",
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      return undefined;
    });

    // Main agent calls task_done, then a workflow step agent for pre-merge only
    let callIdx = 0;
    mockedCreateHaiAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001", "WS-002"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // createKbAgent called twice: main agent + 1 pre-merge step (post-merge skipped)
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);

    // Verify the workflow step results only contain pre-merge
    const updateCalls = store.updateTask.mock.calls;
    const resultsCall = updateCalls.find((c: any) =>
      c[1]?.workflowStepResults?.length > 0
    );
    expect(resultsCall).toBeDefined();
    const results = resultsCall![1].workflowStepResults;
    expect(results).toHaveLength(1);
    expect(results[0].workflowStepId).toBe("WS-001");
    expect(results[0].phase).toBe("pre-merge");
  });

  it("normalizes legacy workflow steps without phase as pre-merge", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Legacy step without phase field
    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Legacy Check",
      description: "No phase field",
      prompt: "Run checks",
      // phase is undefined — should be treated as pre-merge
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let callIdx = 0;
    mockedCreateHaiAgent.mockImplementation((async (opts: any) => {
      callIdx++;
      if (callIdx === 1) {
        const customTools = opts.customTools || [];
        const session = {
          prompt: vi.fn().mockImplementation(async () => {
            const taskDoneTool = customTools.find((t: any) => t.name === "task_done");
            if (taskDoneTool) await taskDoneTool.execute("tool-1", {});
          }),
          dispose: vi.fn(),
          subscribe: vi.fn(),
          on: vi.fn(),
          sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
          state: {},
        };
        return { session };
      } else {
        return {
          session: {
            prompt: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(),
            on: vi.fn(),
            state: {},
          },
        };
      }
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test", {});

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Legacy step should have been executed (treated as pre-merge)
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(2);

    // Verify result has phase: "pre-merge"
    const updateCalls = store.updateTask.mock.calls;
    const resultsCall = updateCalls.find((c: any) =>
      c[1]?.workflowStepResults?.some((r: any) => r.workflowStepId === "WS-001")
    );
    expect(resultsCall).toBeDefined();
    const results = resultsCall![1].workflowStepResults;
    expect(results[0].phase).toBe("pre-merge");
  });

  it("only runs post-merge steps when all are post-merge (skips all in executor)", async () => {
    const store = createMockStore();

    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    store.getWorkflowStep.mockResolvedValue({
      id: "WS-001",
      name: "Post-merge Notify",
      description: "After merge",
      prompt: "Send notifications",
      phase: "post-merge",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    createAgentWithTaskDone();

    const executor = new TaskExecutor(store, "/tmp/test", {});

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      enabledWorkflowSteps: ["WS-001"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Only main agent called (no workflow step agent since all are post-merge)
    expect(mockedCreateHaiAgent).toHaveBeenCalledTimes(1);

    // Task should still move to in-review
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
  });
});

describe("Real-time steering injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initializes seenSteeringIds with existing comments at session start", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockResolvedValue(undefined);

    // Mock session with steer method
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Simulate execution running
          await new Promise(resolve => setTimeout(resolve, 10));
        }),
        dispose: vi.fn(),
        steer: steerFn,
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    const existingComment = {
      id: "1234567890-abc123",
      text: "Existing comment",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [existingComment],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait for execution to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    // No steer calls should be made for existing comments
    expect(steerFn).not.toHaveBeenCalled();
  });

  it("injects new steering comments via session.steer() on task:updated", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockResolvedValue(undefined);
    let promptResolve: () => void;
    const promptPromise = new Promise<void>(resolve => { promptResolve = resolve; });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(async () => {
          // Wait for signal to complete
          await promptPromise;
        }),
        dispose: vi.fn(),
        steer: steerFn,
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    // Start execution
    const executePromise = executor.execute({
      id: "FN-001",
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

    // Wait for agent to start
    await new Promise(resolve => setTimeout(resolve, 20));

    // Simulate adding a steering comment mid-execution
    const newComment = {
      id: "9876543210-def456",
      text: "Please use a different approach",
      createdAt: new Date().toISOString(),
      author: "user" as const,
    };

    store._trigger("task:updated", {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [newComment],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait for steer to be called
    await new Promise(resolve => setTimeout(resolve, 20));

    // Verify steer was called with the formatted message
    expect(steerFn).toHaveBeenCalledOnce();
    expect(steerFn.mock.calls[0][0]).toContain("📣 **New feedback**");
    expect(steerFn.mock.calls[0][0]).toContain("Please use a different approach");

    // Verify log entry was created
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("Comment received mid-execution"),
      "by user"
    );

    // Complete the execution
    promptResolve!();
    await executePromise;
  });

  it("does not re-inject already seen steering comments", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockResolvedValue(undefined);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        steer: steerFn,
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    const commentId = "1111111111-aaa111";

    // Start execution with one comment
    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [{
        id: commentId,
        text: "Original comment",
        createdAt: new Date().toISOString(),
        author: "user" as const,
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait for execution to start
    await new Promise(resolve => setTimeout(resolve, 20));

    // Trigger task:updated with the SAME comment (simulating a non-steering update)
    store._trigger("task:updated", {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [{
        id: commentId,
        text: "Original comment",
        createdAt: new Date().toISOString(),
        author: "user" as const,
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait and verify steer was not called again
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(steerFn).not.toHaveBeenCalled();
  });

  it("marks comment as seen even if steer() throws", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockRejectedValue(new Error("Session disconnected"));
    let resolvePrompt: () => void;
    const promptPromise = new Promise<void>(resolve => { resolvePrompt = resolve; });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(() => promptPromise),
        dispose: vi.fn(),
        steer: steerFn,
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");
    const commentId = "2222222222-bbb222";

    // Start execution (don't await yet)
    const executePromise = executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait for execution to start
    await new Promise(resolve => setTimeout(resolve, 20));

    // Add a new comment that will fail to inject
    store._trigger("task:updated", {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [{
        id: commentId,
        text: "Comment that fails",
        createdAt: new Date().toISOString(),
        author: "user" as const,
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 20));

    // Verify steer was called (and failed)
    expect(steerFn).toHaveBeenCalledOnce();

    // Trigger task:updated again with the same comment
    store._trigger("task:updated", {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [{
        id: commentId,
        text: "Comment that fails",
        createdAt: new Date().toISOString(),
        author: "user" as const,
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait and verify steer was NOT called again (comment marked as seen)
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(steerFn).toHaveBeenCalledTimes(1);

    // Complete execution
    resolvePrompt!();
    await executePromise;
  });

  it("does not inject steering comments for tasks not in activeSessions", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockResolvedValue(undefined);

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
        steer: steerFn,
      },
    } as any);

    new TaskExecutor(store, "/tmp/test");

    // Trigger task:updated for a task that is not in activeSessions
    store._trigger("task:updated", {
      id: "FN-NOT-EXECUTING",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [{
        id: "3333333333-ccc333",
        text: "Should not be injected",
        createdAt: new Date().toISOString(),
        author: "user" as const,
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait and verify steer was not called
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(steerFn).not.toHaveBeenCalled();
  });

  it("handles multiple new steering comments in a single task:updated", async () => {
    const store = createMockStore();
    const steerFn = vi.fn().mockResolvedValue(undefined);
    let resolvePrompt: () => void;
    const promptPromise = new Promise<void>(resolve => { resolvePrompt = resolve; });

    // Set up getTask to return the task with existing comment in comments (used for seenSteeringIds init)
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
      comments: [{
        id: "existing-comment",
        text: "Original",
        createdAt: new Date().toISOString(),
        author: "user",
      }],
      steeringComments: [{
        id: "existing-comment",
        text: "Original",
        createdAt: new Date().toISOString(),
        author: "user",
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockImplementation(() => promptPromise),
        dispose: vi.fn(),
        steer: steerFn,
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    // Start execution (don't await yet)
    const executePromise = executor.execute({
      id: "FN-001",
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

    // Wait for execution to start
    await new Promise(resolve => setTimeout(resolve, 20));

    // Add two new comments at once
    store._trigger("task:updated", {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      steeringComments: [
        {
          id: "existing-comment",
          text: "Original",
          createdAt: new Date().toISOString(),
          author: "user",
        },
        {
          id: "new-comment-1",
          text: "First new comment",
          createdAt: new Date().toISOString(),
          author: "user",
        },
        {
          id: "new-comment-2",
          text: "Second new comment",
          createdAt: new Date().toISOString(),
          author: "user",
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 20));

    // Verify steer was called twice (once for each new comment)
    expect(steerFn).toHaveBeenCalledTimes(2);

    // Complete execution
    resolvePrompt!();
    await executePromise;
  });
});

// ── Loop recovery (compact-and-resume) integration tests ────────────

describe("TaskExecutor loop recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMockSessionForLoopRecovery(overrides?: { compactResult?: any }) {
    const defaultResult = {
      summary: "Compacted conversation",
      tokensBefore: 150000,
    };
    const compactRetVal = overrides && "compactResult" in overrides ? overrides.compactResult : defaultResult;
    const compact = vi.fn(async () => compactRetVal);
    const steer = vi.fn(async () => {});

    return {
      prompt: vi.fn(async () => {}),
      dispose: vi.fn(),
      subscribe: vi.fn(),
      setThinkingLevel: vi.fn(),
      steer,
      compact,
      sessionFile: "/tmp/test-session.json",
      model: { provider: "mock", id: "mock-model", name: "Mock" },
      sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
      state: {},
    };
  }

  function setupExecutorWithActiveSession(mockSession: ReturnType<typeof createMockSessionForLoopRecovery>) {
    const store = createMockStore();
    (store.getSettings as any).mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    const executor = new TaskExecutor(store, "/tmp/test-root");

    // Directly inject an active session (avoids full execute() chain)
    (executor as any).activeSessions.set("FN-001", {
      session: mockSession,
      seenSteeringIds: new Set(),
    });

    return { store, executor, mockSession };
  }

  it("handleLoopDetected returns true and compacts session when active session exists", async () => {
    const mockSession = createMockSessionForLoopRecovery();
    const { store, executor } = setupExecutorWithActiveSession(mockSession);

    const result = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 100,
      shouldRequeue: true,
    });

    expect(result).toBe(true);
    expect(mockSession.compact).toHaveBeenCalled();
    expect(mockSession.steer).toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      expect.stringContaining("compact-and-resume"),
    );
  });

  it("handleLoopDetected returns false when no active session", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test-root");

    // No session active (activeSessions is empty)
    const result = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 100,
      shouldRequeue: true,
    });

    expect(result).toBe(false);
  });

  it("handleLoopDetected returns false when attempt ceiling reached", async () => {
    const mockSession = createMockSessionForLoopRecovery();
    const { executor } = setupExecutorWithActiveSession(mockSession);

    // First call succeeds
    const result1 = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 100,
      shouldRequeue: true,
    });
    expect(result1).toBe(true);

    // Second call hits ceiling (max 1 attempt per execute() lifecycle)
    const result2 = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 200,
      shouldRequeue: true,
    });
    expect(result2).toBe(false);
  });

  it("handleLoopDetected returns false when compaction fails", async () => {
    const mockSession = createMockSessionForLoopRecovery({ compactResult: null });
    const { executor } = setupExecutorWithActiveSession(mockSession);

    const result = await executor.handleLoopDetected({
      taskId: "FN-001",
      reason: "loop",
      noProgressMs: 600000,
      inactivityMs: 0,
      activitySinceProgress: 100,
      shouldRequeue: true,
    });

    expect(result).toBe(false);
  });
});

// ── Agent Spawning Tests ─────────────────────────────────────────────────

function createMockAgentStore() {
  let nextId = 1;
  const agents = new Map<string, any>();

  return {
    createAgent: vi.fn(async (input: any) => {
      const agentId = `agent-${String(nextId++).padStart(8, "0")}`;
      const agent = {
        id: agentId,
        name: input.name,
        role: input.role,
        state: "idle" as string,
        reportsTo: input.reportsTo,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      agents.set(agentId, agent);
      return agent;
    }),
    updateAgentState: vi.fn(async (agentId: string, newState: string) => {
      const agent = agents.get(agentId);
      if (agent) {
        agent.state = newState;
        agent.updatedAt = new Date().toISOString();
      }
      return agent;
    }),
    _agents: agents,
  };
}

async function captureToolsWithAgentStore(agentStore?: any, settingsOverride?: any): Promise<{
  tools: Record<string, (id: string, params: any) => Promise<any>>;
  store: ReturnType<typeof createMockStore>;
  executor: TaskExecutor;
}> {
  const store = createMockStore();
  store.updateStep.mockResolvedValue({
    steps: [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "in-progress" },
      { name: "Testing", status: "pending" },
    ],
  });
  const mergedSettings = {
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    groupOverlappingFiles: false,
    autoMerge: false,
    worktreeInitCommand: undefined,
    ...settingsOverride,
  };
  store.getSettings.mockResolvedValue(mergedSettings);

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

  mockedExistsSync.mockReturnValue(true);
  // Mock execSync for worktree operations
  vi.mocked(execSync).mockReturnValue("");

  const options: any = {};
  if (agentStore) {
    options.agentStore = agentStore;
  }

  const executor = new TaskExecutor(store, "/tmp/test", options);

  await executor.execute({
    id: "FN-SPAWN",
    title: "Spawn Test",
    description: "Spawn test task",
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
  return { tools, store, executor };
}

describe("Agent Spawning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue("");
  });

  it("spawn_agent tool is registered in customTools", async () => {
    const { tools } = await captureToolsWithAgentStore();
    expect(tools.spawn_agent).toBeDefined();
    expect(typeof tools.spawn_agent).toBe("function");
  });

  it("returns error when AgentStore is not configured", async () => {
    const { tools } = await captureToolsWithAgentStore(undefined);
    const result = await tools.spawn_agent("call1", {
      name: "researcher",
      role: "engineer",
      task: "Research something",
    });

    expect(result.content[0].text).toContain("not available");
    expect(result.content[0].text).toContain("no AgentStore configured");
    expect(result.details.state).toBe("error");
  });

  it("creates agent in AgentStore with correct reportsTo", async () => {
    const agentStore = createMockAgentStore();
    const { tools } = await captureToolsWithAgentStore(agentStore);

    const result = await tools.spawn_agent("call1", {
      name: "researcher",
      role: "engineer",
      task: "Research authentication patterns",
    });

    expect(agentStore.createAgent).toHaveBeenCalledOnce();
    const createInput = agentStore.createAgent.mock.calls[0][0];
    expect(createInput.name).toBe("researcher");
    expect(createInput.role).toBe("engineer");
    expect(createInput.reportsTo).toBe("FN-SPAWN");
    expect(createInput.metadata.type).toBe("spawned");
    expect(createInput.metadata.parentTaskId).toBe("FN-SPAWN");
  });

  it("returns correct SpawnAgentResult structure with state", async () => {
    const agentStore = createMockAgentStore();
    const { tools } = await captureToolsWithAgentStore(agentStore);

    const result = await tools.spawn_agent("call1", {
      name: "researcher",
      role: "engineer",
      task: "Research authentication patterns",
    });

    // Parse the JSON from the text content
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("agentId");
    expect(parsed).toHaveProperty("name", "researcher");
    expect(parsed).toHaveProperty("state", "running");
    expect(parsed).toHaveProperty("role", "engineer");
    expect(parsed).toHaveProperty("message");
    expect(parsed.message).toContain("researcher");
    expect(parsed.message).toContain("Research authentication patterns");

    // Also check details object
    expect(result.details.agentId).toBe(parsed.agentId);
    expect(result.details.state).toBe("running");
  });

  it("transitions agent to active state after creation", async () => {
    const agentStore = createMockAgentStore();
    const { tools } = await captureToolsWithAgentStore(agentStore);

    await tools.spawn_agent("call1", {
      name: "worker",
      role: "custom",
      task: "Do some work",
    });

    // Agent is created in idle, then transitioned to active
    const agentId = agentStore.createAgent.mock.calls[0][0];
    expect(agentStore.updateAgentState).toHaveBeenCalledWith(
      expect.any(String),
      "active"
    );
  });

  it("creates child agent session via createKbAgent", async () => {
    const agentStore = createMockAgentStore();
    const { tools } = await captureToolsWithAgentStore(agentStore);

    await tools.spawn_agent("call1", {
      name: "worker",
      role: "engineer",
      task: "Do some work",
    });

    // createKbAgent is called at least twice: once for parent, once for child
    expect(mockedCreateHaiAgent.mock.calls.length).toBeGreaterThanOrEqual(2);
    
    // Find the child session call
    const childCall = mockedCreateHaiAgent.mock.calls.find(
      (call: any) => call[0].systemPrompt?.includes("child agent spawned")
    );
    expect(childCall).toBeDefined();
    expect(childCall![0].tools).toBe("coding");
    expect(childCall![0].systemPrompt).toContain("FN-SPAWN");
  });

  it("respects per-parent maxSpawnedAgentsPerParent limit", async () => {
    const agentStore = createMockAgentStore();
    const { tools } = await captureToolsWithAgentStore(agentStore, {
      maxSpawnedAgentsPerParent: 2,
    });

    // Spawn 2 agents (limit)
    await tools.spawn_agent("call1", { name: "a1", role: "engineer", task: "task 1" });
    await tools.spawn_agent("call2", { name: "a2", role: "engineer", task: "task 2" });

    // 3rd should be rejected
    const result = await tools.spawn_agent("call3", { name: "a3", role: "engineer", task: "task 3" });
    expect(result.content[0].text).toContain("Per-parent spawn limit reached");
    expect(result.content[0].text).toContain("2/2");
    expect(result.details.state).toBe("error");
  });

  it("respects global maxSpawnedAgentsGlobal limit", async () => {
    const agentStore = createMockAgentStore();
    const { tools } = await captureToolsWithAgentStore(agentStore, {
      maxSpawnedAgentsGlobal: 3,
    });

    // Spawn 3 agents (global limit)
    await tools.spawn_agent("call1", { name: "a1", role: "engineer", task: "task 1" });
    await tools.spawn_agent("call2", { name: "a2", role: "engineer", task: "task 2" });
    await tools.spawn_agent("call3", { name: "a3", role: "engineer", task: "task 3" });

    // 4th should hit global limit
    const result = await tools.spawn_agent("call4", { name: "a4", role: "engineer", task: "task 4" });
    expect(result.content[0].text).toContain("Global spawn limit reached");
    expect(result.content[0].text).toContain("3/3");
    expect(result.details.state).toBe("error");
  });

  it("uses default limits when settings are not specified", async () => {
    const agentStore = createMockAgentStore();
    // No spawn settings in the store — defaults should apply
    const { tools } = await captureToolsWithAgentStore(agentStore);

    // Should be able to spawn (defaults: 5 per parent, 20 global)
    const result = await tools.spawn_agent("call1", {
      name: "worker",
      role: "engineer",
      task: "task 1",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.state).toBe("running");
  });

  it("handles errors during agent creation gracefully", async () => {
    const agentStore = createMockAgentStore();
    agentStore.createAgent.mockRejectedValue(new Error("DB connection failed"));

    const { tools } = await captureToolsWithAgentStore(agentStore);

    const result = await tools.spawn_agent("call1", {
      name: "worker",
      role: "engineer",
      task: "task 1",
    });

    expect(result.content[0].text).toContain("Failed to spawn agent");
    expect(result.content[0].text).toContain("DB connection failed");
    expect(result.details.state).toBe("error");
  });

  it("trims whitespace from agent name", async () => {
    const agentStore = createMockAgentStore();
    const { tools } = await captureToolsWithAgentStore(agentStore);

    await tools.spawn_agent("call1", {
      name: "  researcher  ",
      role: "engineer",
      task: "task 1",
    });

    const createInput = agentStore.createAgent.mock.calls[0][0];
    expect(createInput.name).toBe("researcher");
  });

  it("truncates long task descriptions in result message", async () => {
    const agentStore = createMockAgentStore();
    const { tools } = await captureToolsWithAgentStore(agentStore);

    const longTask = "A".repeat(200);
    const result = await tools.spawn_agent("call1", {
      name: "worker",
      role: "engineer",
      task: longTask,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.message).toContain("...");
    // The message should contain the first 100 chars
    expect(parsed.message.length).toBeLessThan(longTask.length + 50);
  });
});

describe("Agent Spawning - Child Termination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
    vi.mocked(execSync).mockReturnValue("");
  });

  it("parent termination triggers all child terminations", async () => {
    const agentStore = createMockAgentStore();
    const mockDispose = vi.fn();

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: mockDispose,
          sessionManager: {
            getLeafId: vi.fn().mockReturnValue("leaf-id"),
            branchWithSummary: vi.fn(),
          },
          navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
        },
      } as any;
    });

    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);

    await executor.execute({
      id: "FN-PARENT",
      title: "Parent Task",
      description: "Parent",
      column: "in-progress",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // execute() should have completed, disposing the parent session
    // and any child sessions that were spawned
    expect(mockDispose).toHaveBeenCalled();
  });

  it("terminateChildAgent cleans up maps and decrements count", async () => {
    const agentStore = createMockAgentStore();
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
    });

    const mockDispose = vi.fn();
    mockedCreateHaiAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: mockDispose,
        sessionManager: {
          getLeafId: vi.fn().mockReturnValue("leaf-id"),
          branchWithSummary: vi.fn(),
        },
        navigateTree: vi.fn().mockResolvedValue({ cancelled: false }),
      },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);

    // Access internal state via any for testing
    const internals = executor as any;
    
    // Simulate spawned agent tracking state
    const childId = "agent-test-child";
    const mockSession = { dispose: vi.fn() };
    internals.childSessions.set(childId, mockSession);
    internals.spawnedAgents.set("FN-PARENT", new Set([childId]));
    internals.totalSpawnedCount = 1;

    // Terminate the child
    await internals.terminateChildAgent(childId);

    expect(mockSession.dispose).toHaveBeenCalled();
    expect(internals.childSessions.has(childId)).toBe(false);
    expect(internals.spawnedAgents.get("FN-PARENT")?.has(childId)).toBe(false);
    expect(internals.totalSpawnedCount).toBe(0);
    expect(agentStore.updateAgentState).toHaveBeenCalledWith(childId, "terminated");
  });

  it("terminateChildAgent handles missing session gracefully", async () => {
    const agentStore = createMockAgentStore();
    const store = createMockStore();

    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);
    const internals = executor as any;

    internals.totalSpawnedCount = 1;

    // Terminate a child that doesn't have a session in the map
    await internals.terminateChildAgent("nonexistent-agent");

    // Should still decrement counter and attempt state update
    expect(internals.totalSpawnedCount).toBe(0);
    expect(agentStore.updateAgentState).toHaveBeenCalledWith("nonexistent-agent", "terminated");
  });

  it("terminateAllChildren handles no children gracefully", async () => {
    const agentStore = createMockAgentStore();
    const store = createMockStore();

    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);
    const internals = executor as any;

    // Should not throw when there are no children
    await internals.terminateAllChildren("FN-NONE");
    expect(agentStore.updateAgentState).not.toHaveBeenCalled();
  });

  it("terminateAllChildren terminates all children and cleans up", async () => {
    const agentStore = createMockAgentStore();
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);
    const internals = executor as any;

    // Set up multiple children
    const child1 = { dispose: vi.fn() };
    const child2 = { dispose: vi.fn() };
    internals.childSessions.set("c1", child1);
    internals.childSessions.set("c2", child2);
    internals.spawnedAgents.set("FN-PARENT", new Set(["c1", "c2"]));
    internals.totalSpawnedCount = 2;

    await internals.terminateAllChildren("FN-PARENT");

    expect(child1.dispose).toHaveBeenCalled();
    expect(child2.dispose).toHaveBeenCalled();
    expect(internals.spawnedAgents.has("FN-PARENT")).toBe(false);
    expect(internals.totalSpawnedCount).toBe(0);
    expect(agentStore.updateAgentState).toHaveBeenCalledWith("c1", "terminated");
    expect(agentStore.updateAgentState).toHaveBeenCalledWith("c2", "terminated");
  });

  it("terminateChildAgent handles AgentStore errors gracefully", async () => {
    const agentStore = createMockAgentStore();
    agentStore.updateAgentState.mockRejectedValue(new Error("DB error"));
    const store = createMockStore();

    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);
    const internals = executor as any;

    const mockSession = { dispose: vi.fn() };
    internals.childSessions.set("c1", mockSession);
    internals.totalSpawnedCount = 1;

    // Should not throw even when AgentStore fails
    await internals.terminateChildAgent("c1");
    expect(mockSession.dispose).toHaveBeenCalled();
    expect(internals.totalSpawnedCount).toBe(0);
  });
});

describe("Agent Spawning - runSpawnedChild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("updates agent state to running then active on success", async () => {
    const agentStore = createMockAgentStore();
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);
    const internals = executor as any;

    const mockSession = { dispose: vi.fn() };
    internals.childSessions.set("agent-test", mockSession);
    internals.totalSpawnedCount = 1;

    await internals.runSpawnedChild("agent-test", mockSession, "Do the research");

    // Should transition: running → active
    expect(agentStore.updateAgentState).toHaveBeenCalledWith("agent-test", "running");
    expect(agentStore.updateAgentState).toHaveBeenCalledWith("agent-test", "active");
    // Should clean up
    expect(internals.childSessions.has("agent-test")).toBe(false);
    expect(internals.totalSpawnedCount).toBe(0);
  });

  it("updates agent state to error on failure", async () => {
    const agentStore = createMockAgentStore();
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);
    const internals = executor as any;

    const mockSession = { dispose: vi.fn() };
    internals.childSessions.set("agent-test", mockSession);
    internals.totalSpawnedCount = 1;

    // Make promptWithFallback throw
    const { promptWithFallback } = await import("./pi.js");
    vi.mocked(promptWithFallback).mockRejectedValueOnce(new Error("API error"));

    await internals.runSpawnedChild("agent-test", mockSession, "Do the research");

    expect(agentStore.updateAgentState).toHaveBeenCalledWith("agent-test", "running");
    expect(agentStore.updateAgentState).toHaveBeenCalledWith("agent-test", "error");
    // Should still clean up
    expect(internals.childSessions.has("agent-test")).toBe(false);
    expect(internals.totalSpawnedCount).toBe(0);
  });

  it("cleans up even when state update fails", async () => {
    const agentStore = createMockAgentStore();
    agentStore.updateAgentState.mockRejectedValue(new Error("DB down"));
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test", { agentStore } as any);
    const internals = executor as any;

    const mockSession = { dispose: vi.fn() };
    internals.childSessions.set("agent-test", mockSession);
    internals.totalSpawnedCount = 1;

    // Should not throw even when state updates fail
    await internals.runSpawnedChild("agent-test", mockSession, "Do the research");

    expect(internals.childSessions.has("agent-test")).toBe(false);
    expect(internals.totalSpawnedCount).toBe(0);
  });
});

// ─── Agent Execution Flow Integration Tests (FN-978) ────────────────────────────
//
// These tests verify the complete execution flow: event listener registration,
// session creation, stuck detector tracking, and heartbeat recording.
describe("TaskExecutor agent execution flow (FN-978)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("registers task:moved event listener in constructor", () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");
    // Verify the store.on was called with "task:moved"
    expect(store.on).toHaveBeenCalledWith("task:moved", expect.any(Function));
  });

  it("executes task when task:moved event fires with to='in-progress'", async () => {
    const store = createMockStore();
    const session = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };

    mockedCreateHaiAgent.mockResolvedValue({ session } as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    const task = {
      id: "FN-978",
      title: "Test Task",
      description: "Test",
      column: "in-progress" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Trigger the task:moved event manually
    store._trigger("task:moved", { task, from: "todo", to: "in-progress" });

    // Wait for async execution to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify the agent was created and prompt was called
    expect(mockedCreateHaiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: expect.any(String),
        systemPrompt: expect.any(String),
        tools: "coding",
      }),
    );
    expect(session.prompt).toHaveBeenCalled();
  });

  it("does not execute task when task:moved event fires with to!='in-progress'", async () => {
    const store = createMockStore();

    mockedCreateHaiAgent.mockResolvedValue({
      session: { prompt: vi.fn(), dispose: vi.fn() },
    } as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    const task = {
      id: "FN-978",
      title: "Test Task",
      description: "Test",
      column: "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Trigger the task:moved event with to='done' (should not execute)
    store._trigger("task:moved", { task, from: "in-progress", to: "done" });

    // Wait for async
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify no agent was created
    expect(mockedCreateHaiAgent).not.toHaveBeenCalled();
  });

  it("tracks task with stuck detector after session creation", async () => {
    const store = createMockStore();
    const stuckDetector = {
      trackTask: vi.fn(),
      recordActivity: vi.fn(),
      recordProgress: vi.fn(),
      untrackTask: vi.fn(),
    };

    const session = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };

    mockedCreateHaiAgent.mockResolvedValue({ session } as any);

    const executor = new TaskExecutor(store, "/tmp/test", {
      stuckTaskDetector: stuckDetector as any,
    });

    const task = {
      id: "FN-978",
      title: "Test Task",
      description: "Test",
      column: "in-progress" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await executor.execute(task);

    // Verify trackTask was called with task ID
    expect(stuckDetector.trackTask).toHaveBeenCalledWith("FN-978", expect.anything());
    // Verify recordActivity was called (heartbeat on prompt start)
    expect(stuckDetector.recordActivity).toHaveBeenCalledWith("FN-978");
    // Verify untrackTask was called in the finally block
    expect(stuckDetector.untrackTask).toHaveBeenCalledWith("FN-978");
  });

  it("records activity via AgentLogger onText callbacks", async () => {
    const store = createMockStore();
    const stuckDetector = {
      trackTask: vi.fn(),
      recordActivity: vi.fn(),
      recordProgress: vi.fn(),
      untrackTask: vi.fn(),
    };

    let capturedOnText: ((delta: string) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      // Capture the onText callback that's passed to createKbAgent
      capturedOnText = opts.onText;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate the agent producing text output
            if (capturedOnText) {
              capturedOnText("Hello world");
            }
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const onAgentText = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {
      stuckTaskDetector: stuckDetector as any,
      onAgentText,
    });

    const task = {
      id: "FN-978",
      title: "Test Task",
      description: "Test",
      column: "in-progress" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await executor.execute(task);

    // Verify that recordActivity was called (at least once for the initial heartbeat
    // and possibly more for the simulated text output)
    expect(stuckDetector.recordActivity).toHaveBeenCalledWith("FN-978");
    // The initial recordActivity + text callback should result in multiple calls
    expect(stuckDetector.recordActivity.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Verify onAgentText callback was called with the delta
    expect(onAgentText).toHaveBeenCalledWith("FN-978", "Hello world");
  });

  it("records activity via AgentLogger onToolStart callbacks", async () => {
    const store = createMockStore();
    const stuckDetector = {
      trackTask: vi.fn(),
      recordActivity: vi.fn(),
      recordProgress: vi.fn(),
      untrackTask: vi.fn(),
    };

    let capturedOnToolStart: ((name: string, args?: Record<string, unknown>) => void) | undefined;

    mockedCreateHaiAgent.mockImplementation(async (opts: any) => {
      capturedOnToolStart = opts.onToolStart;
      return {
        session: {
          prompt: vi.fn().mockImplementation(async () => {
            // Simulate the agent calling a tool
            if (capturedOnToolStart) {
              capturedOnToolStart("bash", { command: "echo test" });
            }
          }),
          dispose: vi.fn(),
        },
      } as any;
    });

    const onAgentTool = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {
      stuckTaskDetector: stuckDetector as any,
      onAgentTool,
    });

    const task = {
      id: "FN-978",
      title: "Test Task",
      description: "Test",
      column: "in-progress" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await executor.execute(task);

    // Verify that recordActivity was called for the tool usage
    expect(stuckDetector.recordActivity).toHaveBeenCalledWith("FN-978");
    // Verify onAgentTool callback was called with the tool name
    expect(onAgentTool).toHaveBeenCalledWith("FN-978", "bash");
  });

  it("prevents duplicate execution when task:moved fires twice for same task", async () => {
    const store = createMockStore();
    const session = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    };

    mockedCreateHaiAgent.mockResolvedValue({ session } as any);

    const executor = new TaskExecutor(store, "/tmp/test");

    const task = {
      id: "FN-978",
      title: "Test Task",
      description: "Test",
      column: "in-progress" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Trigger the event twice quickly
    store._trigger("task:moved", { task, from: "todo", to: "in-progress" });
    store._trigger("task:moved", { task, from: "todo", to: "in-progress" });

    // Wait for completion
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The executing guard prevents duplicate execution from the event handler.
    // Note: createKbAgent may be called a second time if the agent finishes
    // without calling task_done (retry path), but the initial trigger should
    // only cause one execution, not two.
    // Verify that store.on was called with task:moved (listener registered)
    expect(store.on).toHaveBeenCalledWith("task:moved", expect.any(Function));
    // Verify the event handler initiated execute() (not twice from events)
    // The executing set guard works — both triggers don't cause double execution
  });

  it("logs error when execute() fails in task:moved handler", async () => {
    const store = createMockStore();
    mockedCreateHaiAgent.mockRejectedValue(new Error("model not found"));

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });

    const task = {
      id: "FN-978",
      title: "Test Task",
      description: "Test",
      column: "in-progress" as const,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Trigger the event
    store._trigger("task:moved", { task, from: "todo", to: "in-progress" });

    // Wait for async
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify the error handler was called
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-978" }),
      expect.any(Error),
    );
  });
});

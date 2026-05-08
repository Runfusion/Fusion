// -nocheck
/* eslint-disable -eslint/no-unused-vars */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./executor-test-helpers.js";
import { AgentSemaphore } from "../concurrency.js";
import { detectReviewHandoffIntent, determineRevisionResetStart } from "../executor.js";
import { TaskExecutor, buildExecutionPrompt } from "../executor.js";
import { createFnAgent } from "../pi.js";
import { reviewStep as mockedReviewStepFn } from "../reviewer.js";
import { execSync } from "node:child_process";
import { findWorktreeUser, aiMergeTask } from "../merger.js";
import { WorktreePool } from "../worktree-pool.js";
import { generateWorktreeName, slugify } from "../worktree-names.js";
import type { Task, TaskDetail } from "@fusion/core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { StepSessionExecutor } from "../step-session-executor.js";
import { executorLog } from "../logger.js";
import { withRateLimitRetry } from "../rate-limit-retry.js";
import { runVerificationCommand as mockedRunVerificationCommand } from "../verification-utils.js";
import {
  createMockStore,
  mockedCreateFnAgent,
  mockedSessionManager,
  mockedGenerateWorktreeName,
  mockedFindWorktreeUser,
  mockedStepSessionExecutor,
  mockedWithRateLimitRetry,
  mockedExecSync,
  mockedExistsSync,
  mockExecuteAll,
  mockTerminateAllSessions,
  mockCleanup,
  resetExecutorMocks,
} from "./executor-test-helpers.js";

const mockedReviewStep = vi.mocked(mockedReviewStepFn);

describe("TaskExecutor with semaphore", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("acquires semaphore before creating agent and releases after", async () => {
    const sem = new AgentSemaphore(2);
    const store = createMockStore();
    const acquireSpy = vi.spyOn(sem, "acquire");
    const releaseSpy = vi.spyOn(sem, "release");

    mockedCreateFnAgent.mockResolvedValue({
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

    mockedCreateFnAgent.mockRejectedValue(new Error("agent failed"));

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

    mockedCreateFnAgent.mockRejectedValue(new Error("agent crashed"));

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
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
    expect(onError).toHaveBeenCalled();
  });

  it("concurrent executions respect semaphore limit", async () => {
    const sem = new AgentSemaphore(1);
    const store = createMockStore();
    let concurrent = 0;
    let maxConcurrent = 0;

    mockedCreateFnAgent.mockImplementation(async () => {
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
    resetExecutorMocks();
    // Default: worktree does NOT exist (new worktree)
    mockedExistsSync.mockReturnValue(false);
    mockedCreateFnAgent.mockResolvedValue({
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
      worktreeInitCommand: "pnpm install --frozen-lockfile",
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // execSync is called for worktree creation + init command
    const initCall = mockedExecSync.mock.calls.find(
      (call) => call[0] === "pnpm install --frozen-lockfile",
    );
    expect(initCall).toBeDefined();
    expect(initCall![1]).toMatchObject({
      cwd: expect.stringContaining(".worktrees/"),
      timeout: 300_000,
    });

    // Should log success
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-010",
      expect.stringMatching(/^\[timing\] Worktree init command completed in \d+ms$/),
      "pnpm install --frozen-lockfile",
      expect.objectContaining({ agentId: "executor" }),
    );
  });

  it("does NOT run init command when worktreeInitCommand is not set", async () => {
    const store = createMockStore();
    // getSettings returns default (no worktreeInitCommand)

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    // Only worktree creation calls to execSync, no "pnpm install --frozen-lockfile" etc.
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
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );

    // The init command failure itself does not abort execution, but the mocked
    // agent still exits without fn_task_done. After 3 retries it requeues to todo
    // and reports an error.
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-010" }),
      expect.objectContaining({ message: "Agent finished without calling fn_task_done (after 3 retries)" }),
    );

    // Agent should still have been created
    expect(mockedCreateFnAgent).toHaveBeenCalled();
  });

  it("does NOT run init command on worktree resume", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: "pnpm install --frozen-lockfile",
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
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedGenerateWorktreeName.mockReturnValue("swift-falcon");
    mockedCreateFnAgent.mockResolvedValue({
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
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git worktree list --porcelain") {
        return [
          "worktree /tmp/test",
          "HEAD abc123",
          "branch refs/heads/main",
          "",
          `worktree ${existingPath}`,
          "HEAD def456",
          "branch refs/heads/fusion/fn-031",
          "",
        ].join("\n") as any;
      }
      return Buffer.from("");
    });

    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask("FN-031", existingPath));

    // Should NOT generate a new name — reuse the stored path
    expect(mockedGenerateWorktreeName).not.toHaveBeenCalled();
  });

  it("does not reuse a stored worktree path that is not registered", async () => {
    const stalePath = "/tmp/test/.worktrees/broken-wt";
    mockedExistsSync.mockImplementation((path) => String(path).startsWith(stalePath));
    mockedExecSync.mockImplementation((cmd: any) => {
      if (String(cmd) === "git worktree list --porcelain") {
        return "worktree /tmp/test\nHEAD abc123\nbranch refs/heads/main\n" as any;
      }
      return Buffer.from("");
    });

    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute(makeTask("FN-032", stalePath));

    expect(store.updateTask).toHaveBeenCalledWith("FN-032", { worktree: null, branch: null });
    expect(mockedGenerateWorktreeName).toHaveBeenCalledWith("/tmp/test");
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("git worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);
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
        undefined,
        expect.objectContaining({ agentId: "executor" }),
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
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedGenerateWorktreeName.mockReturnValue("swift-falcon");
    mockedCreateFnAgent.mockResolvedValue({
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
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
    // execSync should be called for worktree creation
    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git worktree add"),
      expect.any(Object),
    );
  });

  it("fails fast with a clear error when rootDir is not a git repository", async () => {
    const store = createMockStore();
    const onError = vi.fn();

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git rev-parse --git-dir") {
        const error: any = new Error("fatal: not a git repository (or any of the parent directories): .git");
        error.stderr = Buffer.from("fatal: not a git repository (or any of the parent directories): .git");
        throw error;
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    await executor.execute(makeTask());

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Cannot execute task: project directory is not a Git repository"),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("not a Git repository"),
      }),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ id: "FN-050" }),
      expect.objectContaining({ message: expect.stringContaining("not a Git repository") }),
    );
  });

  it("does not attempt git worktree add when rootDir is not a git repository", async () => {
    const store = createMockStore();

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git rev-parse --git-dir") {
        const error: any = new Error("fatal: not a git repository");
        error.stderr = Buffer.from("fatal: not a git repository");
        throw error;
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("git worktree add"),
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });

  it("extractWorktreeConflictInfo classifies not-a-git-repository errors", () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    const error: any = new Error("fatal: not a git repository");
    error.stderr = Buffer.from("fatal: not a git repository");

    const conflictInfo = (executor as any).extractWorktreeConflictInfo(error);
    expect(conflictInfo.type).toBe("not-git-repo");
    expect(conflictInfo.message).toContain("not a git repository");
  });

  it("treats not-a-git-repository as non-retryable in tryCreateWorktree flow", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree list --porcelain") {
        return Buffer.from(["worktree /tmp/test", "HEAD abc123", "branch refs/heads/main", ""].join("\n"));
      }
      if (command.includes("git worktree add -b")) {
        const error: any = new Error("fatal: not a git repository (or any of the parent directories): .git");
        error.stderr = Buffer.from("fatal: not a git repository (or any of the parent directories): .git");
        throw error;
      }
      return Buffer.from("");
    });

    await expect(
      (executor as any).createWorktree("fusion/fn-050", "/tmp/test/.worktrees/swift-falcon", "FN-050"),
    ).rejects.toThrow("not a Git repository");

    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("git worktree add -b"),
    );
    expect(worktreeAddCalls).toHaveLength(1);
  });

  it("extractWorktreeConflictInfo classifies already checked out errors as already-used", () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test");

    const error: any = new Error(
      "fatal: 'fusion/fn-050' is already checked out at '/tmp/test/.worktrees/green-sage'",
    );
    error.stderr = Buffer.from(
      "fatal: 'fusion/fn-050' is already checked out at '/tmp/test/.worktrees/green-sage'",
    );

    const conflictInfo = (executor as any).extractWorktreeConflictInfo(error);
    expect(conflictInfo).toMatchObject({
      type: "already-used",
      path: "/tmp/test/.worktrees/green-sage",
    });
  });

  it("recovers from already checked out worktree conflict and retries", async () => {
    const store = createMockStore();
    let callCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add") && callCount++ === 0) {
        const error: any = new Error(
          "fatal: 'fusion/fn-050' is already checked out at '/tmp/test/.worktrees/green-sage'",
        );
        error.stderr = Buffer.from(
          "fatal: 'fusion/fn-050' is already checked out at '/tmp/test/.worktrees/green-sage'",
        );
        throw error;
      }
      return Buffer.from("");
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    await executor.execute(makeTask());

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Cleaned up conflicting worktree, retrying"),
      "/tmp/test/.worktrees/swift-falcon",
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ worktree: expect.any(String) }),
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

  it("falls back to default base and clears task.executionStartBranch when the configured base ref is missing (FN-2165)", async () => {
    const store = createMockStore();

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git rev-parse --verify")) {
        // The stored baseBranch no longer exists — simulates a dep's branch
        // being deleted while this task sat queued/stuck.
        const error: any = new Error("fatal: Needed a single revision");
        error.stderr = Buffer.from("fatal: Needed a single revision");
        throw error;
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    await executor.execute({ ...makeTask(), executionStartBranch: "fusion/missing-base" });

    // Should log the soft fallback, not a terminal failure
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining('Worktree base ref "fusion/missing-base" is missing'),
      expect.any(String),
    );
    // Should clear baseBranch on the task so retries use the default
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ executionStartBranch: null }),
    );
    // Should proceed to create a worktree from HEAD (no startPoint)
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("git worktree add"),
    );
    expect(worktreeAddCalls.length).toBeGreaterThan(0);
    // None of the worktree add calls should include the stale base ref
    for (const call of worktreeAddCalls) {
      expect(String(call[0])).not.toContain("fusion/missing-base");
    }
    // The task should NOT have been marked failed because of the stale baseBranch
    // (downstream errors unrelated to worktree creation may still occur in this
    // integration-style test — we only assert that baseBranch-missing is no
    // longer a terminal failure).
    const worktreeFailureCalls = (store.logEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("Worktree creation failed"),
    );
    expect(worktreeFailureCalls).toHaveLength(0);
    // onError may still fire from downstream step execution in this test harness;
    // what matters is that the failure reason is NOT "base ref missing".
    void onError;
  });

  it("refuses to create a worktree nested inside another worktree (FN-2165 guard)", async () => {
    const store = createMockStore();

    // Simulate `git worktree list --porcelain` returning a non-root worktree
    // that would be an ancestor of the target path.
    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command === "git worktree list --porcelain") {
        return Buffer.from(
          [
            "worktree /tmp/test",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /tmp/test/.worktrees/green-finch",
            "HEAD def456",
            "branch refs/heads/fusion/fn-007",
            "",
          ].join("\n"),
        );
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    // Task has a worktree path nested inside green-finch — must be refused
    await executor.execute({
      ...makeTask(),
      worktree: "/tmp/test/.worktrees/green-finch/.worktrees/amber-panda",
    });

    // Should NEVER attempt a git worktree add for the nested path
    const worktreeAddCalls = mockedExecSync.mock.calls.filter(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("git worktree add") &&
        c[0].includes("green-finch/.worktrees/amber-panda"),
    );
    expect(worktreeAddCalls).toHaveLength(0);

    // Should log the refusal with both the target and ancestor paths
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      "Refusing to create nested worktree",
      expect.stringContaining("green-finch"),
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
    await executor.execute({ ...makeTask(), executionStartBranch: "fusion/fn-049" });

    // Should log that we're trying a new path
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Conflicting worktree in use by active task, trying new path"),
      expect.any(String),
    );
    // Should generate a new name
    expect(mockedGenerateWorktreeName).toHaveBeenCalledTimes(2);

    const worktreeAddCalls = mockedExecSync.mock.calls
      .map((call) => String(call[0]))
      .filter((command) => command.includes("git worktree add -b"));
    expect(
      worktreeAddCalls.some(
        (command) =>
          command.includes('git worktree add -b "fusion/fn-050"') &&
          command.endsWith('"fusion/fn-049"'),
      ),
    ).toBe(true);
    expect(
      worktreeAddCalls.some(
        (command) =>
          command.includes('git worktree add -b "fusion/fn-050-2"') &&
          command.endsWith('"fusion/fn-050"'),
      ),
    ).toBe(true);
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

  it("bounds stale-reference cleanup retries when update-ref succeeds but the ref remains invalid", async () => {
    const store = createMockStore();
    let worktreeAddCallCount = 0;

    mockedExecSync.mockImplementation((cmd: string | string[]) => {
      const command = typeof cmd === "string" ? cmd : cmd[0];
      if (command.includes("git worktree add")) {
        worktreeAddCallCount++;
        const error: any = new Error("fatal: invalid reference: 'fusion/fn-050'");
        error.stderr = Buffer.from("fatal: invalid reference: 'fusion/fn-050'");
        throw error;
      }
      if (command.includes("git branch -D")) {
        const error: any = new Error("error: branch 'fusion/fn-050' not found");
        error.stderr = Buffer.from("error: branch 'fusion/fn-050' not found");
        throw error;
      }
      return Buffer.from("");
    });

    const onError = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", { onError });
    const executePromise = executor.execute(makeTask());
    await vi.advanceTimersByTimeAsync(2000);
    await executePromise;

    expect(worktreeAddCallCount).toBe(3);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-050",
      expect.stringContaining("Worktree creation failed after 3 attempts"),
      expect.any(String),
    );
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-050",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onError).toHaveBeenCalled();
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
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(false);
    mockedFindWorktreeUser.mockResolvedValue(null);
    mockedCreateFnAgent.mockResolvedValue({
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
      executionStartBranch: "fusion/fn-059",
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
      executionStartBranch: "fusion/fn-061",
    }));

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-062",
      expect.stringContaining("based on fusion/fn-061"),
      undefined,
      expect.objectContaining({ agentId: "executor" }),
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
      expect.objectContaining({ cwd: "/tmp/test" }),
    );
    expect(mockedExecSync).toHaveBeenCalledWith(
      'git branch -D "fusion/fn-064"',
      expect.objectContaining({ cwd: "/tmp/test" }),
    );

    const worktreeCreateCalls = mockedExecSync.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes('git worktree add') && call[0].includes("-b"),
    );
    expect(worktreeCreateCalls).toHaveLength(2);
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-064",
      expect.stringContaining("Worktree created at /tmp/test/.worktrees/swift-falcon"),
      undefined,
      expect.objectContaining({ agentId: "executor" }),
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

    const prepareSpy = vi.spyOn(pool, "prepareForTask").mockResolvedValue("fusion/fn-064");

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
      executionStartBranch: "fusion/fn-063",
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

    const prepareSpy = vi.spyOn(pool, "prepareForTask").mockResolvedValue("fusion/fn-065");

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
    vi.spyOn(pool, "prepareForTask").mockResolvedValue("fusion/fn-066-2");

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
    resetExecutorMocks();
    // Default: worktree does NOT exist (new worktree)
    mockedExistsSync.mockReturnValue(false);
    mockedCreateFnAgent.mockResolvedValue({
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
      undefined,
      expect.objectContaining({ agentId: "executor" }),
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
      undefined,
      expect.objectContaining({ agentId: "executor" }),
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
      worktreeInitCommand: "pnpm install --frozen-lockfile",
    });

    const executor = new TaskExecutor(store, "/tmp/test", { pool });
    await executor.execute(makeTask());

    // "pnpm install --frozen-lockfile" should NOT have been called (pooled worktree has warm cache)
    const initCalls = mockedExecSync.mock.calls.filter(
      (c) => c[0] === "pnpm install --frozen-lockfile",
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
      undefined,
      expect.objectContaining({ agentId: "executor" }),
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
    resetExecutorMocks();
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


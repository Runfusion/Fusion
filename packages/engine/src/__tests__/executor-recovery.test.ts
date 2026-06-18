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
import { WorktreePool, removeWorktree } from "../worktree-pool.js";
import { generateWorktreeName, slugify } from "../worktree-names.js";
import type { Task, TaskDetail } from "@fusion/core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { StepSessionExecutor } from "../step-session-executor.js";
import { executingTaskLock } from "../active-session-registry.js";
import { executorLog } from "../logger.js";
import { withRateLimitRetry } from "../rate-limit-retry.js";
import { runVerificationCommand as mockedRunVerificationCommand } from "../verification-utils.js";
import { UsageLimitPauser } from "../usage-limit-detector.js";
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

describe("TaskExecutor usage limit detection", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("triggers global pause when executor catches a usage-limit error", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");

    mockedCreateFnAgent.mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded"));

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
    expect(store.updateSettings).toHaveBeenCalledWith({
      globalPause: true,
      globalPauseReason: "rate-limit",
    });
    // Task should still be marked as failed
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "failed", error: "rate_limit_error: Rate limit exceeded" });
    expect(onError).toHaveBeenCalled();
  });

  it("does NOT trigger global pause for transient non-usage-limit errors", async () => {
    const store = createMockStore();
    const pauser = new UsageLimitPauser(store);
    const onUsageLimitHitSpy = vi.spyOn(pauser, "onUsageLimitHit");
    const onError = vi.fn();

    mockedCreateFnAgent.mockRejectedValue(new Error("connection refused"));

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
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", expect.stringContaining("Transient error (retry 1/3"), undefined, expect.objectContaining({ agentId: "executor" }));
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", expect.objectContaining({
      recoveryRetryCount: 1,
      nextRecoveryAt: expect.any(String),
    }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it("works without usageLimitPauser (backward compatible)", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockRejectedValue(new Error("rate_limit_error: Rate limit exceeded"));

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
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession } as any);

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

    mockedCreateFnAgent.mockRejectedValue(new Error("overloaded_error: Overloaded"));

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
    resetExecutorMocks();
  });

  it("increments recoveryRetryCount on successive transient failures", async () => {
    const store = createMockStore();
    const onError = vi.fn();

    mockedCreateFnAgent.mockRejectedValue(new Error("upstream connect error"));

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
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    expect(onError).not.toHaveBeenCalled();

    // Second failure: count goes from 1 to 2
    resetExecutorMocks();
    mockedCreateFnAgent.mockRejectedValue(new Error("upstream connect error"));
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
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    expect(onError).not.toHaveBeenCalled();
  });

  it("moves task to in-review when transient retries are exhausted (single-session)", async () => {
    const store = createMockStore();
    const onError = vi.fn();

    mockedCreateFnAgent.mockRejectedValue(new Error("socket hang up"));

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

    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      status: "failed",
      error: "socket hang up",
      recoveryRetryCount: null,
      nextRecoveryAt: null,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "in-review");
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
    mockedCreateFnAgent.mockRejectedValue(new Error("Aborted"));
    (executor as any).markPausedAborted("FN-001", "hard-cancel");

    await executor.execute(task);

    // Should NOT update recoveryRetryCount
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({
      recoveryRetryCount: expect.any(Number),
    }));
  });

  it("does not clobber self-healing parked incomplete-task pause metadata during abort cleanup", async () => {
    const store = createMockStore();
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "todo",
      status: "queued",
      paused: true,
      userPaused: false,
      pausedReason: undefined,
      branch: "fusion/fn-001",
      worktree: null,
      dependencies: [],
      steps: [{ name: "Testing & Verification", status: "in-progress" }],
      currentStep: 6,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const executor = new TaskExecutor(store, "/tmp/test", {});
    mockedCreateFnAgent.mockRejectedValue(new Error("Aborted"));
    (executor as any).markPausedAborted("FN-001", "hard-cancel");

    await executor.execute({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      recoveryRetryCount: 1,
      branch: "fusion/fn-001",
      dependencies: [],
      steps: [{ name: "Testing & Verification", status: "in-progress" }],
      currentStep: 6,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({
      worktree: undefined,
      branch: undefined,
    }));
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Execution abort cleanup skipped — incomplete stuck-loop task is already parked with progress preserved",
      undefined,
      expect.anything(),
    );
  });

  it("does NOT consume retry budget for stuck-task-detector kills", async () => {
    const store = createMockStore();

    const executor = new TaskExecutor(store, "/tmp/test", {});

    mockedCreateFnAgent.mockRejectedValue(new Error("Aborted"));
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

    mockedCreateFnAgent.mockImplementation(async () => ({
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

    expect(mockedCreateFnAgent).toHaveBeenCalledTimes(1);
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
    );
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review");
    // Executor now handles the requeue in its finally block
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      status: "queued",
      error: null,
      worktree: null,
      branch: null,
    });
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
  });

  it("does not requeue when stuck-kill budget is exhausted", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test", {});

    mockedCreateFnAgent.mockImplementation(async () => ({
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
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", expect.objectContaining({
      status: "queued",
      worktree: null,
      branch: null,
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("skips stuck-requeue cleanup when task was concurrently recovered to in-review", async () => {
    const store = createMockStore();
    // Self-healing already moved the task to in-review while execute() was unwinding.
    store.getTask.mockResolvedValue({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-review",
      dependencies: [],
      steps: [{ name: "step", status: "done" }],
      currentStep: 1,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});

    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn(async () => {
          executor.markStuckAborted("FN-001", true);
          throw new Error("Stuck task");
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
      steps: [{ name: "step", status: "done" }],
      currentStep: 1,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Must NOT undo the recovery: no move, no stuck-killed status, no worktree clearing.
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo");
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo", expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      { status: "stuck-killed", worktree: null, branch: null },
    );
  });

  it("force-requeue timeout reaps hung in-flight surfaces and removes the worktree before clearing guards", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockStore();
      const agentStore = {
        updateAgentState: vi.fn().mockResolvedValue(undefined),
        deleteAgent: vi.fn().mockResolvedValue(undefined),
      };
      const executor = new TaskExecutor(store, "/tmp/test", { agentStore: agentStore as any });
      const taskId = "FN-001";
      const worktreePath = "/tmp/test/.worktrees/FN-001";
      const session = { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: {} };
      const workflowSession = { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: {} };
      const stepExecutor = {
        abortAllSessionBash: vi.fn(),
        terminateAllSessions: vi.fn().mockResolvedValue(undefined),
      };
      const controller = new AbortController();
      const controllerAbort = vi.spyOn(controller, "abort");
      const subagent = { dispose: vi.fn(), state: {} };
      const cliSession = { kill: vi.fn().mockResolvedValue(undefined) };
      const childSession = { dispose: vi.fn(), state: {} };
      vi.mocked(removeWorktree).mockResolvedValue(undefined as any);
      store.getTask.mockResolvedValue({
        id: taskId,
        title: "Test",
        description: "Test task",
        column: "in-progress",
        worktree: worktreePath,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (executor as any).executing.add(taskId);
      executingTaskLock.tryClaim(taskId);
      (executor as any).activeWorktrees.set(taskId, worktreePath);
      (executor as any).activeSessions.set(taskId, { session });
      (executor as any).activeStepExecutors.set(taskId, stepExecutor);
      (executor as any).activeWorkflowStepSessions.set(taskId, workflowSession);
      (executor as any).activeConfiguredCommandControllers.set(taskId, new Set([controller]));
      (executor as any).activeSubagentSessions.set(taskId, new Set([subagent]));
      (executor as any).activeCliTaskSessions.set(taskId, cliSession);
      (executor as any).spawnedAgents.set(taskId, new Set(["child-agent"]));
      (executor as any).childSessions.set("child-agent", childSession);
      (executor as any).loopRecoveryState.set(taskId, { attempts: 1, pending: true });

      executor.markStuckAborted(taskId, true);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(agentStore.updateAgentState).toHaveBeenCalledWith("child-agent", "paused");
      expect(agentStore.deleteAgent).toHaveBeenCalledWith("child-agent");
      expect(childSession.dispose).toHaveBeenCalledTimes(1);
      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(stepExecutor.abortAllSessionBash).toHaveBeenCalledTimes(1);
      expect(stepExecutor.terminateAllSessions).toHaveBeenCalled();
      expect(workflowSession.abort).toHaveBeenCalledTimes(1);
      expect(workflowSession.dispose).toHaveBeenCalledTimes(1);
      expect(controllerAbort).toHaveBeenCalledTimes(1);
      expect(subagent.dispose).toHaveBeenCalledTimes(1);
      expect(cliSession.kill).toHaveBeenCalledWith("killed");
      expect(removeWorktree).toHaveBeenCalledWith(expect.objectContaining({
        worktreePath,
        rootDir: "/tmp/test",
        taskId,
        expectedOwnerTaskId: taskId,
      }));
      expect(store.updateTask).toHaveBeenCalledWith(taskId, {
        status: "queued",
        error: null,
        worktree: null,
        branch: null,
      });
      expect(store.moveTask).toHaveBeenCalledWith(taskId, "todo", { preserveProgress: true });
      expect(session.abort.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(removeWorktree).mock.invocationCallOrder[0]);
      expect(vi.mocked(removeWorktree).mock.invocationCallOrder[0]).toBeLessThan(store.moveTask.mock.invocationCallOrder[0]);
      const cleanupCompleteLogIndex = store.logEntry.mock.calls.findIndex(([, message]: any[]) => String(message).includes("Force-kill cleanup completed"));
      expect(cleanupCompleteLogIndex).toBeGreaterThanOrEqual(0);
      expect(store.moveTask.mock.invocationCallOrder[0]).toBeLessThan(store.logEntry.mock.invocationCallOrder[cleanupCompleteLogIndex]);
      expect((executor as any).activeWorktrees.has(taskId)).toBe(false);
      expect((executor as any).executing.has(taskId)).toBe(false);
      expect(executingTaskLock.has(taskId)).toBe(false);
      expect((executor as any).stuckAborted.has(taskId)).toBe(false);
      expect((executor as any).loopRecoveryState.has(taskId)).toBe(false);
      expect((executor as any).pausedAborted.has(taskId)).toBe(false);
      expect(store.logEntry).toHaveBeenCalledWith(taskId, expect.stringContaining("Force-kill cleanup starting"));
      expect(store.logEntry).toHaveBeenCalledWith(taskId, expect.stringContaining("Force-requeued after stuck-kill"));
      expect(store.logEntry).toHaveBeenCalledWith(taskId, expect.stringContaining("progress preserved"));
      expect(store.logEntry).toHaveBeenCalledWith(taskId, expect.stringContaining("Force-kill cleanup completed"));
    } finally {
      vi.useRealTimers();
      executingTaskLock._clearForTest();
    }
  });

  it("force-requeue timeout preserves concurrent non-in-progress recovery without reaping surfaces", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test", {});
      const session = { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: {} };
      store.getTask.mockResolvedValue({
        id: "FN-001",
        title: "Test",
        description: "Test task",
        column: "in-review",
        worktree: "/tmp/test/.worktrees/FN-001",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      (executor as any).executing.add("FN-001");
      executingTaskLock.tryClaim("FN-001");
      (executor as any).activeWorktrees.set("FN-001", "/tmp/test/.worktrees/FN-001");
      (executor as any).activeSessions.set("FN-001", { session });

      executor.markStuckAborted("FN-001", true);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(session.abort).not.toHaveBeenCalled();
      expect(session.dispose).not.toHaveBeenCalled();
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo", expect.anything());
      expect((executor as any).executing.has("FN-001")).toBe(false);
      expect(executingTaskLock.has("FN-001")).toBe(false);
    } finally {
      vi.useRealTimers();
      executingTaskLock._clearForTest();
    }
  });

  it("force-requeue timeout no-ops when the executor unwound before the grace timer", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test", {});
      const session = { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: {} };
      (executor as any).executing.add("FN-001");
      executingTaskLock.tryClaim("FN-001");
      (executor as any).activeSessions.set("FN-001", { session });

      executor.markStuckAborted("FN-001", true);
      (executor as any).executing.delete("FN-001");
      executingTaskLock.release("FN-001");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(session.abort).not.toHaveBeenCalled();
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo", expect.anything());
    } finally {
      vi.useRealTimers();
      executingTaskLock._clearForTest();
    }
  });

  it("force-requeue timeout logs non-fatal worktree cleanup failures distinctly", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockStore();
      const executor = new TaskExecutor(store, "/tmp/test", {});
      const session = { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: {} };
      store.getTask.mockResolvedValue({
        id: "FN-001",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        worktree: "/tmp/test/.worktrees/FN-001",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(removeWorktree).mockRejectedValue(new Error("worktree busy"));
      (executor as any).executing.add("FN-001");
      executingTaskLock.tryClaim("FN-001");
      (executor as any).activeWorktrees.set("FN-001", "/tmp/test/.worktrees/FN-001");
      (executor as any).activeSessions.set("FN-001", { session });

      executor.markStuckAborted("FN-001", true);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(store.logEntry).toHaveBeenCalledWith("FN-001", expect.stringContaining("Force-kill cleanup failed to remove worktree"));
      expect(store.logEntry).toHaveBeenCalledWith("FN-001", expect.stringContaining("Force-kill cleanup completed with non-fatal worktree removal failure"));
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    } finally {
      vi.useRealTimers();
      executingTaskLock._clearForTest();
    }
  });

  it("force-requeue timeout honors disabled preserveProgressOnStuckRequeue", async () => {
    vi.useFakeTimers();
    try {
      const store = createMockStore();
      store.getSettings.mockResolvedValue({
        maxConcurrent: 2,
        maxWorktrees: 4,
        pollIntervalMs: 15000,
        groupOverlappingFiles: false,
        autoMerge: false,
        worktreeInitCommand: undefined,
        preserveProgressOnStuckRequeue: false,
      });
      const executor = new TaskExecutor(store, "/tmp/test", {});
      const resetSpy = vi.spyOn(executor as any, "resetStepsIfWorkLost").mockResolvedValue(undefined);
      const session = { abort: vi.fn().mockResolvedValue(undefined), dispose: vi.fn(), state: {} };
      store.getTask.mockResolvedValue({
        id: "FN-001",
        title: "Test",
        description: "Test task",
        column: "in-progress",
        worktree: "/tmp/test/.worktrees/FN-001",
        dependencies: [],
        steps: [{ name: "step", status: "in-progress" }],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      vi.mocked(removeWorktree).mockResolvedValue(undefined as any);
      (executor as any).executing.add("FN-001");
      executingTaskLock.tryClaim("FN-001");
      (executor as any).activeWorktrees.set("FN-001", "/tmp/test/.worktrees/FN-001");
      (executor as any).activeSessions.set("FN-001", { session });

      executor.markStuckAborted("FN-001", true);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(resetSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-001" }));
      expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", undefined);
    } finally {
      vi.useRealTimers();
      executingTaskLock._clearForTest();
    }
  });

  it("does not let a late graph failure clobber a retryable requeue", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "todo",
      status: "queued",
      error: null,
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await (executor as any).handleGraphFailure(task, {
      visitedNodeIds: ["execute"],
    });

    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "in-review", expect.anything());
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Workflow graph run ended after task already advanced to 'todo' — no further action needed",
      undefined,
      undefined,
    );
  });

  it.each(["in-review", "done"] as const)(
    "treats a graph exit after task advanced to %s as benign",
    async (column) => {
      const store = createMockStore();
      const task = {
        id: "FN-001",
        title: "Test",
        description: "Test",
        column: "in-progress",
        status: undefined,
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      store.getTask.mockResolvedValue({
        ...task,
        column,
        status: undefined,
        error: null,
      });
      const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => undefined);
      const executor = new TaskExecutor(store, "/tmp/test", {});

      await (executor as any).handleGraphFailure(task, {
        visitedNodeIds: ["execute"],
      });

      const expectedMessage = `Workflow graph run ended after task already advanced to '${column}' — no further action needed`;
      expect(store.logEntry).toHaveBeenCalledWith("FN-001", expectedMessage, undefined, undefined);
      expect(store.logEntry.mock.calls.map((call) => call[1]).join("\n")).not.toContain("terminated with failure");
      expect(store.updateTask).not.toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ status: "failed" }),
        expect.anything(),
      );
      expect(store.updateTask).not.toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ error: expect.anything() }),
        expect.anything(),
      );
      expect(store.handoffToReview).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("terminated with failure"));
      warnSpy.mockRestore();
    },
  );

  it("treats a graph exit while task is paused as benign", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "in-progress",
      paused: true,
      status: undefined,
      error: null,
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await (executor as any).handleGraphFailure(task, {
      visitedNodeIds: ["execute"],
    });

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Workflow graph run ended while task is paused — pause state preserved",
      undefined,
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it.each([
    ["plain execute", ["execute"], "awaiting-user-input", { "node:execute:value": "awaiting-user-input" }, "Workflow graph run ended awaiting user input at node 'execute' — awaiting state preserved"],
    ["progress then execute", ["plan", "execute"], "awaiting-cli-approval", { "node:execute:value": "awaiting-cli-approval" }, "Workflow graph run ended awaiting CLI approval at node 'execute' — awaiting state preserved"],
    ["step-execute foreach seam", ["foreach#0:step-execute"], "awaiting-user-input", { "node:foreach:value": "awaiting-user-input" }, "Workflow graph run ended awaiting user input at node 'foreach#0:step-execute' — awaiting state preserved"],
  ] as const)(
    "preserves awaiting graph failure values instead of terminal execute parking: %s",
    async (_name, visitedNodeIds, value, context, message) => {
      const store = createMockStore();
      const task = {
        id: "FN-001",
        title: "Test",
        description: "Test",
        column: "in-progress",
        status: undefined,
        dependencies: [],
        steps: [{ name: "Step 1", status: "pending" }],
        currentStep: 0,
        log: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      store.getTask.mockResolvedValue({
        ...task,
        column: "in-progress",
        paused: false,
        status: value,
        error: null,
      });
      const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => undefined);
      const executor = new TaskExecutor(store, "/tmp/test", {});

      await (executor as any).handleGraphFailure(task, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds,
        context,
      });

      expect(store.logEntry).toHaveBeenCalledWith("FN-001", message, undefined, undefined);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: value, paused: true }, undefined);
      expect(store.logEntry.mock.calls.map((call) => call[1]).join("\n")).not.toContain("Workflow graph terminated with failure at node");
      expect(store.updateTask).not.toHaveBeenCalledWith(
        "FN-001",
        expect.objectContaining({ status: "failed" }),
        expect.anything(),
      );
      expect(store.handoffToReview).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Workflow graph terminated with failure at node"));
      warnSpy.mockRestore();
    },
  );

  it("preserves genuine step-execute-unwired failures as terminal graph failures", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [{ name: "Step 1", status: "pending" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({ ...task, column: "in-progress", paused: false, status: undefined, error: null });
    const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => undefined);
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["foreach#0:step-execute"],
      context: { "node:foreach#0:step-execute:value": "step-execute-unwired" },
    });

    const message = "Workflow graph terminated with failure at node 'foreach#0:step-execute'";
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { error: message, status: "failed" }, undefined);
    expect(store.handoffToReview).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ evidence: expect.objectContaining({ reason: "workflow-graph-failed" }) }),
    );
    warnSpy.mockRestore();
  });

  /*
  FNXC:WorkflowLifecycle 2026-06-15-01:38:
  FN-6478 established that a workflow graph exit while paused is benign only while the task remains in-progress. If the live row already advanced to in-review or another non-execution column, the executor must preserve explicit user pauses and autoMerge:false terminal review state while surfacing an operator-actionable workflow failure instead of the generic pause-preserved log.
  */
  it("surfaces an operator-actionable failure for user-paused in-review graph exits", async () => {
    const store = createMockStore();
    const steps = [
      { name: "Preflight", status: "pending" },
      { name: "Implement", status: "pending" },
    ];
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps,
      currentStep: 0,
      log: [{ timestamp: new Date().toISOString(), action: "Resuming execution after unpause" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "in-review",
      paused: true,
      userPaused: true,
      status: undefined,
      error: null,
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await (executor as any).handleGraphFailure(task, {
      visitedNodeIds: ["execute"],
    });

    const messages = store.logEntry.mock.calls.map((call) => call[1]).join("\n");
    expect(store.logEntry.mock.calls.map((call) => call[1])).toEqual([
      "Workflow graph failure surfaced after paused explicit user pause in 'in-review' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task",
    ]);
    expect(messages).toContain("Workflow graph failure surfaced");
    expect(messages).toContain("explicit user pause");
    expect(messages).toContain("operator action required");
    expect(messages).not.toContain("Workflow graph run ended while task is paused — pause state preserved");
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      {
        error: "Workflow graph failure surfaced after paused explicit user pause in 'in-review' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task",
        status: "failed",
      },
      undefined,
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  describe("completion-finalize abort classification (FN-6625)", () => {
    /*
    Surface Enumeration coverage:
    - Classifier branch: completion-finalize provenance bypasses operator-action parking while hard-cancel, userPaused, and global-pause coverage remains in this suite.
    - Abort provenance sources: the new completion-finalize value is asserted here; FN-6568 below covers merge-seam/global-pause and the hard-cancel test in this block preserves generic operator-cancel behavior.
    - Completion-finalize paths: executor.ts marks both graceful-session-exit and finally-block handoffTaskToReview("paused-after-completion") sites; this direct classifier test reproduces the shared trailing graph failure.
    - Failed-node identity: the symptom uses execute, but the production predicate keys on provenance/completion state, not a node-id allow-list.
    - Column/progress states: in-review finalized-completion is benign; existing adjacent tests cover in-progress pause preservation and done/todo non-execution exits.
    - Data states: userPaused true is covered above, paused true without userPaused is covered below, completion-finalize and hard-cancel are covered here, global-pause/merge-seam are covered in the FN-6568 block, and already-status/error-set guard is preserved here.
    - Preserved semantics: genuine user/global pause parking, merge-seam retry routing, and genuine hard-cancel parking remain asserted without backward moveTask calls.
    - No leftover shells: completion-finalize is stored in pausedAbortProvenance and cleared through the existing clearPausedAborted helper used by every cleanup site.
    */
    it("treats completion-finalize pausedAborted in-review graph exits as benign", async () => {
    const store = createMockStore();
    const steps = [
      { name: "Preflight", status: "done" },
      { name: "Implement", status: "done" },
    ];
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps,
      currentStep: 1,
      log: [{ timestamp: new Date().toISOString(), action: "Execution paused after completion — finalizing to in-review" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "in-review",
      paused: false,
      userPaused: false,
      status: undefined,
      error: null,
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});
    (executor as any).markPausedAborted("FN-001", "completion-finalize");

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["execute"],
    });

    const messages = store.logEntry.mock.calls.map((call) => call[1]).join("\n");
    expect(messages).toContain("Workflow graph run ended after task already advanced to 'in-review' — no further action needed");
    expect(messages).not.toContain("engine abort during pause/resume");
    expect(messages).not.toContain("operator action required");
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("surfaces genuine hard-cancel pausedAborted in-review graph exits as workflow failures", async () => {
    const store = createMockStore();
    const steps = [
      { name: "Preflight", status: "pending" },
      { name: "Implement", status: "pending" },
    ];
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps,
      currentStep: 0,
      log: [{ timestamp: new Date().toISOString(), action: "Resuming execution after unpause" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "in-review",
      paused: false,
      status: undefined,
      error: null,
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});
    (executor as any).markPausedAborted("FN-001", "hard-cancel");

    await (executor as any).handleGraphFailure(task, {
      visitedNodeIds: ["execute"],
    });

    const messages = store.logEntry.mock.calls.map((call) => call[1]).join("\n");
    expect(store.logEntry.mock.calls.map((call) => call[1])).toEqual([
      "Workflow graph failure surfaced after paused engine abort during pause/resume in 'in-review' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task",
    ]);
    expect(messages).toContain("Workflow graph failure surfaced");
    expect(messages).toContain("engine abort during pause/resume");
    expect(messages).toContain("operator action required");
    expect(messages).not.toContain("Workflow graph run ended while task is paused — pause state preserved");
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      {
        error: "Workflow graph failure surfaced after paused engine abort during pause/resume in 'in-review' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task",
        status: "failed",
      },
      undefined,
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("does not overwrite an already-surfaced in-review failure during paused abort cleanup", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "in-review",
      paused: false,
      status: "failed",
      error: "Task reached in-review without calling fn_task_done",
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});
    (executor as any).markPausedAborted("FN-001", "hard-cancel");

    await (executor as any).handleGraphFailure(task, {
      visitedNodeIds: ["execute"],
    });

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Workflow graph failure surfaced after paused engine abort during pause/resume in 'in-review' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task",
      undefined,
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("preserves global-pause provenance as operator-action parking for execute-node in-review graph exits", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [{ name: "Preflight", status: "done" }],
      currentStep: 1,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "in-review",
      paused: false,
      userPaused: false,
      status: undefined,
      error: null,
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});
    (executor as any).markPausedAborted("FN-001", "global-pause");

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["execute"],
    });

    const expectedMessage = "Workflow graph failure surfaced after paused global pause in 'in-review' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task";
    const messages = store.logEntry.mock.calls.map((call) => call[1]).join("\n");
    expect(messages).toContain("global pause");
    expect(messages).toContain("operator action required");
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { error: expectedMessage, status: "failed" }, undefined);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("keeps genuine in-progress hard-cancel aborts active and pause-preserved", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [{ name: "Preflight", status: "pending" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "in-progress",
      paused: false,
      userPaused: false,
      status: undefined,
      error: null,
    });
    const abort = vi.fn().mockResolvedValue(undefined);
    const dispose = vi.fn();
    const executor = new TaskExecutor(store, "/tmp/test", {});
    (executor as any).activeSessions.set("FN-001", { session: { abort, dispose, state: {} } });

    await (executor as any).awaitAbortInFlightTaskWork("FN-001", "user move in-progress to todo", { userCanceled: true });
    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["execute"],
    });

    expect(abort).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect((executor as any).userCanceledTaskIds.has("FN-001")).toBe(true);
    expect((executor as any).pausedAbortProvenance.get("FN-001")).toBe("hard-cancel");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Workflow graph run ended while task is paused — pause state preserved",
      undefined,
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
  });

  });

  it("keeps genuine in-progress user pauses benign even with partial step progress", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "pending" },
      ],
      currentStep: 1,
      log: [{ timestamp: new Date().toISOString(), action: "Started execution" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      paused: true,
      userPaused: true,
      status: undefined,
      error: null,
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await (executor as any).handleGraphFailure(task, {
      visitedNodeIds: ["execute"],
    });

    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Workflow graph run ended while task is paused — pause state preserved",
      undefined,
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("surfaces non-in-progress paused graph exits even after partial progress without requeueing autoMerge-off review", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [
        { name: "Preflight", status: "done" },
        { name: "Implement", status: "pending" },
      ],
      currentStep: 1,
      log: [{ timestamp: new Date().toISOString(), action: "Resuming execution after unpause" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "in-review",
      paused: true,
      userPaused: true,
      status: undefined,
      error: null,
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await (executor as any).handleGraphFailure(task, {
      visitedNodeIds: ["execute"],
    });

    const expectedMessage = "Workflow graph failure surfaced after paused explicit user pause in 'in-review' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task";
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", expectedMessage, undefined, undefined);
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { error: expectedMessage, status: "failed" }, undefined);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it.each(["todo", "done"] as const)(
    "surfaces paused graph exits in already-advanced %s column without lifecycle movement",
    async (column) => {
      const store = createMockStore();
      const task = {
        id: "FN-001",
        title: "Test",
        description: "Test",
        column: "in-progress",
        status: undefined,
        dependencies: [],
        steps: [{ name: "Preflight", status: "pending" }],
        currentStep: 0,
        log: [{ timestamp: new Date().toISOString(), action: "Resuming execution after unpause" }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Task;
      store.getTask.mockResolvedValue({
        ...task,
        column,
        paused: true,
        status: undefined,
        error: null,
      });
      const executor = new TaskExecutor(store, "/tmp/test", {});

      await (executor as any).handleGraphFailure(task, {
        visitedNodeIds: ["execute"],
      });

      const expectedMessage = `Workflow graph failure surfaced after paused task pause in '${column}' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task`;
      expect(store.logEntry).toHaveBeenCalledWith("FN-001", expectedMessage, undefined, undefined);
      if (column === "done") {
        expect(store.updateTask).not.toHaveBeenCalledWith(
          "FN-001",
          expect.objectContaining({ status: "failed" }),
          expect.anything(),
        );
      } else {
        expect(store.updateTask).toHaveBeenCalledWith("FN-001", { error: expectedMessage, status: "failed" }, undefined);
      }
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.handoffToReview).not.toHaveBeenCalled();
    },
  );

  describe("merge-seam abort classification (FN-6568)", () => {
    /*
    Surface Enumeration coverage:
    - Pause-branch classifier: merge-seam provenance bypasses operator-action pause parking; user/global pause provenance still parks.
    - handleGraphFailure call surfaces: direct graph-failure handling for merge/requestMerge nodes plus existing execute-node hard-cancel tests.
    - pausedAborted provenance: hard-cancel, global-pause, merge-seam, and no-provenance/clean merge failure behavior are explicit.
    - Failed-node identity: legacy `merge` seam and graph primitive `requestMerge` are both treated as merge failures.
    - Column/progress states: in-review merge failures retry; existing in-progress genuine pause tests preserve pause state.
    - Data states: userPaused true, paused true, merge-seam provenance, global-pause provenance, and hard-cancel provenance are covered.
    - autoMerge:false review parking: a genuinely paused in-review task remains parked without backward movement.
    */
    const makeGraphTask = (overrides: Partial<Task> = {}) => ({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [{ name: "Preflight", status: "done" }],
      currentStep: 1,
      log: [{ timestamp: new Date().toISOString(), action: "Resuming execution after unpause" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    }) as Task;

    it.each(["merge", "requestMerge"] as const)(
      "routes non-paused merge-seam abort at %s into bounded auto-merge retry instead of pause parking",
      async (nodeId) => {
        const store = createMockStore();
        const task = makeGraphTask();
        store.getTask.mockResolvedValue({
          ...task,
          column: "in-review",
          paused: false,
          userPaused: false,
          status: undefined,
          error: null,
          mergeRetries: null,
        });
        const executor = new TaskExecutor(store, "/tmp/test", {});
        const mergeRequester = vi.fn(async () => ({ merged: false, noOp: false, reason: "merge-conflict" }));
        executor.setMergeRequester(mergeRequester as any);
        (executor as any).markPausedAborted("FN-001", "merge-seam");

        await (executor as any).handleGraphFailure(task, {
          disposition: "failed",
          outcome: "failure",
          visitedNodeIds: [nodeId],
        });

        const messages = store.logEntry.mock.calls.map((call) => call[1]).join("\n");
        expect(messages).toContain(`Workflow graph merge failure at node '${nodeId}' routed to bounded auto-merge retry after merge-seam abort`);
        expect(messages).not.toContain("engine abort during pause/resume");
        expect(messages).not.toContain("operator action required");
        expect(store.updateTask).not.toHaveBeenCalledWith(
          "FN-001",
          expect.objectContaining({ status: "failed" }),
          expect.anything(),
        );
        expect(store.handoffToReview).not.toHaveBeenCalled();
        expect(store.moveTask).not.toHaveBeenCalled();
        expect(mergeRequester).toHaveBeenCalledWith("FN-001");
      },
    );

    it("preserves global-pause provenance as operator-action parking for in-review graph exits", async () => {
      const store = createMockStore();
      const task = makeGraphTask();
      store.getTask.mockResolvedValue({
        ...task,
        column: "in-review",
        paused: false,
        userPaused: false,
        status: undefined,
        error: null,
      });
      const executor = new TaskExecutor(store, "/tmp/test", {});
      (executor as any).markPausedAborted("FN-001", "global-pause");

      await (executor as any).handleGraphFailure(task, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["merge"],
      });

      const expectedMessage = "Workflow graph failure surfaced after paused global pause in 'in-review' at node 'merge' — operator action required; retry or explicitly unpause/resume after inspecting the task";
      const messages = store.logEntry.mock.calls.map((call) => call[1]).join("\n");
      expect(messages).toContain("global pause");
      expect(messages).toContain("operator action required");
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { error: expectedMessage, status: "failed" }, undefined);
      expect(store.moveTask).not.toHaveBeenCalled();
      expect(store.handoffToReview).not.toHaveBeenCalled();
    });

    it("keeps autoMerge:false genuinely paused in-review tasks parked without moving backward", async () => {
      const store = createMockStore();
      const task = makeGraphTask({ autoMerge: false } as Partial<Task>);
      store.getTask.mockResolvedValue({
        ...task,
        column: "in-review",
        paused: true,
        userPaused: true,
        status: undefined,
        error: null,
        autoMerge: false,
      });
      const executor = new TaskExecutor(store, "/tmp/test", {});

      await (executor as any).handleGraphFailure(task, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["merge"],
      });

      const expectedMessage = "Workflow graph failure surfaced after paused explicit user pause in 'in-review' at node 'merge' — operator action required; retry or explicitly unpause/resume after inspecting the task";
      expect(store.logEntry).toHaveBeenCalledWith("FN-001", expectedMessage, undefined, undefined);
      expect(store.updateTask).toHaveBeenCalledWith("FN-001", { error: expectedMessage, status: "failed" }, undefined);
      expect(store.moveTask).not.toHaveBeenCalledWith("FN-001", "todo", expect.anything());
      expect(store.handoffToReview).not.toHaveBeenCalled();
    });
  });

  it("auto-retries a bounded transient resume-after-restart graph failure instead of parking", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [{ name: "Step 1", status: "pending" }],
      currentStep: 0,
      log: [{ timestamp: new Date().toISOString(), action: "Resumed after engine restart" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      graphResumeRetryCount: 0,
    } as Task;
    store.getTask.mockResolvedValue({ ...task, paused: false, error: null });
    const executor = new TaskExecutor(store, "/tmp/test", {});
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["execute"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      { graphResumeRetryCount: 1, status: null, error: null },
      undefined,
    );
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
      expect.anything(),
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-001" }));
  });

  it("auto-retries a bounded transient graph failure after unpause resume instead of parking", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [{ name: "Step 1", status: "pending" }],
      currentStep: 0,
      log: [{ timestamp: new Date().toISOString(), action: "Resuming execution after unpause" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      graphResumeRetryCount: 0,
    } as Task;
    store.getTask.mockResolvedValue({ ...task, paused: false, error: null });
    const executor = new TaskExecutor(store, "/tmp/test", {});
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["execute"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      { graphResumeRetryCount: 1, status: null, error: null },
      undefined,
    );
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({ id: "FN-001" }));
  });

  it("parks a transient resume graph failure once the retry budget is exhausted", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [{ name: "Step 1", status: "pending" }],
      currentStep: 0,
      log: [{ timestamp: new Date().toISOString(), action: "Resumed after engine restart" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      graphResumeRetryCount: 2,
    } as Task;
    store.getTask.mockResolvedValue({ ...task, paused: false, error: null });
    const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => undefined);
    const executor = new TaskExecutor(store, "/tmp/test", {});
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      visitedNodeIds: ["execute"],
    });

    const message = "Workflow graph terminated with failure at node 'execute'";
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { error: message, status: "failed" }, undefined);
    expect(store.handoffToReview).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ evidence: expect.objectContaining({ reason: "workflow-graph-failed" }) }),
    );
    expect(executeSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it.each([
    ["non-empty execute-seam reason", { result: { reason: "interpreter-error: boom", visitedNodeIds: ["execute"] } }],
    ["settings/workflow-selection reason before node progress", { result: { reason: "settings-load-failed: boom", visitedNodeIds: [] } }],
    ["completed step progress", { task: { steps: [{ name: "Step 1", status: "done" }] }, result: { visitedNodeIds: ["execute"] } }],
    ["lastError", { task: { lastError: "boom" }, result: { visitedNodeIds: ["execute"] } }],
    ["failureReason", { task: { failureReason: "boom" }, result: { visitedNodeIds: ["execute"] } }],
  ])("preserves terminal failed handling for genuine graph failure: %s", async (_name, fixture) => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [{ name: "Step 1", status: "pending" }],
      currentStep: 0,
      log: [{ timestamp: new Date().toISOString(), action: "Resumed after engine restart" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      graphResumeRetryCount: 0,
      ...(fixture.task ?? {}),
    } as Task;
    store.getTask.mockResolvedValue({ ...task, paused: false, error: null });
    const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => undefined);
    const executor = new TaskExecutor(store, "/tmp/test", {});
    const executeSpy = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).handleGraphFailure(task, {
      disposition: "failed",
      outcome: "failure",
      ...fixture.result,
    });

    const failedNode = fixture.result.visitedNodeIds.at(-1) ?? "unknown";
    const message = `Workflow graph terminated with failure at node '${failedNode}'`;
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { error: message, status: "failed" }, undefined);
    expect(store.handoffToReview).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ evidence: expect.objectContaining({ reason: "workflow-graph-failed" }) }),
    );
    expect(executeSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  describe("transient resume-after-restart graph failure classifier", () => {
    const makeClassifierTask = (overrides: Partial<Task> = {}) => ({
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [
        { name: "Step 1", status: "pending" },
        { name: "Step 2", status: "pending" },
      ],
      currentStep: 0,
      log: [{ timestamp: new Date().toISOString(), action: "Resumed after engine restart" }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    }) as Task;

    const isTransient = (task: Task, result: any) => {
      const executor = new TaskExecutor(createMockStore(), "/tmp/test", {});
      return (executor as any).isTransientResumeAfterRestartGraphFailure(task, result);
    };

    it("accepts only the exact no-progress execute-seam post-resume signature", () => {
      expect(isTransient(makeClassifierTask(), { visitedNodeIds: ["execute"] })).toBe(true);
      expect(isTransient(makeClassifierTask({ log: [{ timestamp: new Date().toISOString(), action: "Resuming execution after unpause" }] }), { visitedNodeIds: ["execute"] })).toBe(true);
      expect(isTransient(makeClassifierTask(), { visitedNodeIds: [] })).toBe(true);
    });

    it.each([
      ["non-empty reason", makeClassifierTask(), { visitedNodeIds: ["execute"], reason: "settings-load-failed: boom" }],
      ["non-execute failed node", makeClassifierTask(), { visitedNodeIds: ["planning"] }],
      ["completed step progress", makeClassifierTask({ steps: [{ name: "Step 1", status: "done" }] }), { visitedNodeIds: ["execute"] }],
      ["lastError", makeClassifierTask({ lastError: "boom" } as any), { visitedNodeIds: ["execute"] }],
      ["failureReason", makeClassifierTask({ failureReason: "boom" } as any), { visitedNodeIds: ["execute"] }],
      ["missing resume log", makeClassifierTask({ log: [{ timestamp: new Date().toISOString(), action: "Started execution" }] }), { visitedNodeIds: ["execute"] }],
    ])("rejects %s as genuine/non-transient", (_name, task, result) => {
      expect(isTransient(task as Task, result)).toBe(false);
    });
  });

  it("preserves genuine in-progress graph failure handling", async () => {
    const store = createMockStore();
    const task = {
      id: "FN-001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      status: undefined,
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as Task;
    store.getTask.mockResolvedValue({
      ...task,
      column: "in-progress",
      paused: false,
      status: undefined,
      error: null,
    });
    const warnSpy = vi.spyOn(executorLog, "warn").mockImplementation(() => undefined);
    const executor = new TaskExecutor(store, "/tmp/test", {});

    await (executor as any).handleGraphFailure(task, {
      visitedNodeIds: [],
    });

    const message = "Workflow graph terminated with failure at node 'unknown'";
    expect(warnSpy).toHaveBeenCalledWith(`FN-001: ${message}`);
    expect(store.logEntry).toHaveBeenCalledWith("FN-001", message, undefined, undefined);
    expect(store.updateTask).toHaveBeenCalledWith(
      "FN-001",
      { error: message, status: "failed" },
      undefined,
    );
    expect(store.handoffToReview).toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ evidence: expect.objectContaining({ reason: "workflow-graph-failed" }) }),
    );
    warnSpy.mockRestore();
  });

  it("preserves step progress when requeuing stuck task by default", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store, "/tmp/test", {});
    const resetSpy = vi.spyOn(executor as any, "resetStepsIfWorkLost").mockResolvedValue(undefined);

    mockedCreateFnAgent.mockImplementation(async () => ({
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

    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
    // resetStepsIfWorkLost MUST be skipped when preserveProgress is on, otherwise
    // the requeue would silently drop committed step status before moveTask preserves it.
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it("resets step progress when preserveProgressOnStuckRequeue is disabled", async () => {
    const store = createMockStore();
    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: undefined,
      preserveProgressOnStuckRequeue: false,
    });
    const executor = new TaskExecutor(store, "/tmp/test", {});
    const resetSpy = vi.spyOn(executor as any, "resetStepsIfWorkLost").mockResolvedValue(undefined);

    mockedCreateFnAgent.mockImplementation(async () => ({
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

    // No options arg → moveTask defaults to resetting steps
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", undefined);
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });

  it("clears recovery metadata after successful run completes", async () => {
    const store = createMockStore();

    // Mock successful agent session
    const mockSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      state: { error: undefined },
    };
    mockedCreateFnAgent.mockResolvedValue({ session: mockSession } as any);

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

    // Exhausted no-fn_task_done retries now requeue immediately to todo.
    expect(store.moveTask).toHaveBeenCalledWith("FN-001", "todo", { preserveProgress: true });
  });
});

describe("Per-task model overrides", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("uses per-task model overrides when both provider and modelId are set", async () => {
    const store = createMockStore();
    const capturedOptions: any[] = [];

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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

// ── Lane hierarchy model resolution tests ─────────────────────────────────────

describe("Executor lane hierarchy model resolution", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("resolves task override when both provider and modelId are set", async () => {
    const store = createMockStore();
    const capturedOptions: any[] = [];

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      executionGlobalProvider: "google",
      executionGlobalModelId: "gemini-2.5",
      executionProvider: undefined,
      executionModelId: undefined,
    });

    const executor = new TaskExecutor(store, "/tmp/test");

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

    // Task override takes precedence
    expect(capturedOptions[0].defaultProvider).toBe("anthropic");
    expect(capturedOptions[0].defaultModelId).toBe("claude-sonnet-4-5");
  });

  it("resolves project execution override when task override is not set", async () => {
    const store = createMockStore();
    const capturedOptions: any[] = [];

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      executionGlobalProvider: "google",
      executionGlobalModelId: "gemini-2.5",
      executionProvider: "anthropic",
      executionModelId: "claude-opus-4",
    });

    const executor = new TaskExecutor(store, "/tmp/test");

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
      // No task-level model override
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
      // No task-level model override
    });

    // Project execution override takes precedence over global lane
    expect(capturedOptions[0].defaultProvider).toBe("anthropic");
    expect(capturedOptions[0].defaultModelId).toBe("claude-opus-4");
  });

  it("resolves global execution lane when project override is not set", async () => {
    const store = createMockStore();
    const capturedOptions: any[] = [];

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      executionGlobalProvider: "google",
      executionGlobalModelId: "gemini-2.5",
      executionProvider: undefined,
      executionModelId: undefined,
    });

    const executor = new TaskExecutor(store, "/tmp/test");

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
      // No task-level model override
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
      // No task-level model override
    });

    // Global execution lane takes precedence over default
    expect(capturedOptions[0].defaultProvider).toBe("google");
    expect(capturedOptions[0].defaultModelId).toBe("gemini-2.5");
  });

  it("resolves project default override when execution lanes are not set", async () => {
    const store = createMockStore();
    const capturedOptions: any[] = [];

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      defaultProvider: "anthropic",
      defaultModelId: "claude-sonnet-4-5",
      defaultProviderOverride: "openai",
      defaultModelIdOverride: "gpt-4o",
      executionGlobalProvider: undefined,
      executionGlobalModelId: undefined,
      executionProvider: undefined,
      executionModelId: undefined,
    });

    const executor = new TaskExecutor(store, "/tmp/test");

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
      // No task-level model override
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
      // No task-level model override
    });

    expect(capturedOptions[0].defaultProvider).toBe("openai");
    expect(capturedOptions[0].defaultModelId).toBe("gpt-4o");
  });

  it("falls back to default when no lane overrides are set", async () => {
    const store = createMockStore();
    const capturedOptions: any[] = [];

    mockedCreateFnAgent.mockImplementation(async (opts: any) => {
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
      defaultProvider: "openai",
      defaultModelId: "gpt-4o",
      executionGlobalProvider: undefined,
      executionGlobalModelId: undefined,
      executionProvider: undefined,
      executionModelId: undefined,
    });

    const executor = new TaskExecutor(store, "/tmp/test");

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
      // No task-level model override
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
      // No task-level model override
    });

    // Default takes precedence when no lane overrides are set
    expect(capturedOptions[0].defaultProvider).toBe("openai");
    expect(capturedOptions[0].defaultModelId).toBe("gpt-4o");
  });
});

// ── Per-task thinkingLevel override tests ───────────────────────────

describe("Per-task thinkingLevel override", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("uses per-task thinkingLevel when set on the task", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    // Override getTask to return task with thinkingLevel override
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
      thinkingLevel: "high",
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
      thinkingLevel: "high",
    });

    // Should use per-task thinkingLevel override
    const callArgs = mockedCreateFnAgent.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs[0].defaultThinkingLevel).toBe("high");
  });

  it("falls back to global defaultThinkingLevel when task has no thinkingLevel", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: undefined,
      defaultThinkingLevel: "medium",
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
      // No thinkingLevel set
    });

    // Should fall back to global defaultThinkingLevel
    const callArgs = mockedCreateFnAgent.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs[0].defaultThinkingLevel).toBe("medium");
  });

  it("uses explicit 'off' thinkingLevel from task over global setting", async () => {
    const store = createMockStore();

    mockedCreateFnAgent.mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn(),
      },
    } as any);

    store.getSettings.mockResolvedValue({
      maxConcurrent: 2,
      maxWorktrees: 4,
      pollIntervalMs: 15000,
      groupOverlappingFiles: false,
      autoMerge: false,
      worktreeInitCommand: undefined,
      defaultThinkingLevel: "high",
    });

    // Override getTask to return task with thinkingLevel: "off"
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
      thinkingLevel: "off",
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
      thinkingLevel: "off",
    });

    // Should use task's explicit "off" instead of global "high"
    const callArgs = mockedCreateFnAgent.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs[0].defaultThinkingLevel).toBe("off");
  });
});

describe("TaskExecutor no-fn_task_done reclaim retry handling", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("silently requeues to todo when worktree/branch is reclaimed mid-retry", async () => {
    const store = createMockStore();
    const onError = vi.fn();
    const taskState: any = {
      id: "FN-001",
      title: "Test",
      description: "Test task",
      column: "in-progress",
      paused: false,
      worktree: "/tmp/test/.worktrees/swift-falcon",
      branch: "fusion/fn-001",
      baseCommitSha: "abc123",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      prompt: "# test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      taskDoneRetryCount: 0,
    };

    store.getTask.mockImplementation(async () => ({ ...taskState }));
    store.updateTask.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      Object.assign(taskState, patch);
      return { ...taskState };
    });
    store.moveTask.mockImplementation(async (_id: string, column: string) => {
      taskState.column = column;
      return { ...taskState };
    });

    let promptCalls = 0;
    mockedCreateFnAgent.mockImplementation(async () => ({
      session: {
        prompt: vi.fn(async () => {
          promptCalls += 1;
          if (promptCalls === 1) {
            taskState.column = "todo";
          }
        }),
        dispose: vi.fn(),
        sessionManager: {
          getLeafId: vi.fn(),
          branchWithSummary: vi.fn(),
        },
        navigateTree: vi.fn(),
      },
    }) as any);

    const executor = new TaskExecutor(store, "/tmp/test", { onError });

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
    });

    expect(taskState.column).toBe("todo");
    expect(taskState.status).not.toBe("failed");
    expect(taskState.error ?? null).toBeNull();
    expect(taskState.taskDoneRetryCount).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Worktree/branch reclaimed mid-retry — requeued to todo (engine self-heal, no failure)",
      undefined,
      expect.objectContaining({ agentId: "executor" }),
    );
    expect(taskState.worktree).toBeNull();
    expect(taskState.branch).toBeNull();
    expect(taskState.baseCommitSha).toBeNull();
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-001",
      expect.objectContaining({ status: "failed" }),
    );
  });
});

// ── Invalid transition error handling tests ─────────────────────────

describe("Invalid transition error handling", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("does not mark task as failed when invalid transition error occurs on completion", async () => {
    const store = createMockStore();

    // Mock moveTask to throw invalid transition error (task already moved to done)
    store.moveTask.mockRejectedValue(
      new Error("Invalid transition: 'done' → 'in-review'. Valid targets: none"),
    );

    // Mock agent that completes successfully
    mockedCreateFnAgent.mockImplementation(async () => {
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

    // A missing fn_task_done triggers 3 retries. The final requeue-to-todo move
    // then throws the Invalid transition error,
    // which is caught by the outer handler.
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", {
      status: "queued",
      error: null,
      taskDoneRetryCount: 1,
    });

    // Should log informative message from the outer catch for Invalid transition
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-001",
      "Task already moved from 'done' — skipping transition to 'in-review'",
      expect.stringContaining("Invalid transition"),
      expect.objectContaining({ agentId: "executor" }),
    );
  });

  it("calls onComplete when invalid transition occurs after successful execution", async () => {
    const store = createMockStore();
    const onComplete = vi.fn();

    // Mock moveTask to throw invalid transition error
    store.moveTask.mockRejectedValue(
      new Error("Invalid transition: 'in-progress' → 'in-review'. Valid targets: todo, triage"),
    );

    mockedCreateFnAgent.mockImplementation(async () => {
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

  it("finalizes an already-reviewed task when it is ready to merge", async () => {
    const store = createMockStore();
    store.getTask.mockResolvedValue({
      id: "FN-003",
      title: "Test",
      description: "Test",
      column: "in-review",
      paused: false,
      status: null,
      error: null,
      worktree: "/tmp/test/.worktrees/fn-003",
      dependencies: [],
      steps: [{ name: "Done", status: "done" }],
      workflowStepResults: [{ id: "ws-1", status: "passed", phase: "pre-merge" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const executor = new TaskExecutor(store, "/tmp/test");
    const result = await (executor as any).finalizeAlreadyReviewedTask("FN-003");

    expect(result).toBe("merged");
    expect(store.mergeTask).toHaveBeenCalledWith("FN-003");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-003",
      "Task already in-review after completion — finalizing merge",
      undefined,
      undefined,
    );
  });
});

describe("TaskExecutor fn_task_done with summary", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("accepts and saves summary parameter when task is completed", async () => {
    const store = createMockStore();
    let capturedTool: any = null;

    mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
      // Capture the fn_task_done tool
      capturedTool = customTools?.find((t: any) => t.name === "fn_task_done");
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

    // Verify fn_task_done tool was created
    expect(capturedTool).toBeDefined();
    expect(capturedTool.name).toBe("fn_task_done");

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

    mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
      capturedTool = customTools?.find((t: any) => t.name === "fn_task_done");
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

describe("TaskExecutor fn_task_done blockers", () => {
  beforeEach(() => {
    resetExecutorMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it("rejects fn_task_done when the task is explicitly blocked", async () => {
    const store = createMockStore();
    let capturedTool: any = null;

    store.getTask.mockImplementation(async (taskId: string) => {
      if (taskId === "FN-001") {
        return {
          id: "FN-001",
          title: "Blocked task",
          description: "Blocked task",
          column: "in-progress",
          blockedBy: "FN-DEP-1",
          dependencies: [],
          steps: [{ name: "Step 1", status: "in-progress" }],
          currentStep: 0,
          log: [],
          prompt: "# test\n## Steps\n### Step 0: Preflight\n- [ ] check",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }
      return {
        id: taskId,
        column: taskId === "FN-DEP-1" ? "in-progress" : "done",
      };
    });

    mockedCreateFnAgent.mockImplementation(async ({ customTools }: any) => {
      capturedTool = customTools?.find((t: any) => t.name === "fn_task_done");
      return {
        session: {
          prompt: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
        },
      } as any;
    });

    const executor = new TaskExecutor(store, "/tmp/test");

    await executor.execute({
      id: "FN-001",
      title: "Blocked task",
      description: "Blocked task",
      column: "in-progress",
      dependencies: [],
      steps: [{ name: "Step 1", status: "in-progress" }],
      currentStep: 0,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(capturedTool).toBeDefined();

    store.updateStep.mockClear();
    store.updateTask.mockClear();

    const result = await capturedTool.execute("tool-1", {});

    expect(result.content[0].text).toContain("Cannot mark task done yet");
    expect(store.updateStep).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});


describe("TaskExecutor recoverCompletedTask", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("uses todo -> in-progress -> in-review transitions for todo-origin recovery", async () => {
    const store = createMockStore();
    const executor = new TaskExecutor(store as any, "/tmp/test");

    const task = {
      id: "FN-4086",
      title: "Recover todo completed task",
      description: "Recover todo completed task",
      column: "todo",
      dependencies: [],
      steps: [{ name: "s1", status: "done" }],
      currentStep: 1,
      log: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any;

    const ok = await executor.recoverCompletedTask(task);

    expect(ok).toBe(true);
    expect(store.moveTask).toHaveBeenNthCalledWith(1, "FN-4086", "in-progress");
    expect(store.moveTask).toHaveBeenNthCalledWith(2, "FN-4086", "in-review");
  });
});

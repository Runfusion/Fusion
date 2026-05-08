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
    expect(store.updateTask).toHaveBeenCalledWith("FN-001", { status: "stuck-killed", worktree: null, branch: null });
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
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-001", { status: "stuck-killed", worktree: null, branch: null });
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
      status: "failed",
      error: "Agent finished without calling fn_task_done (after 3 retries)",
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
        column: "done",
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


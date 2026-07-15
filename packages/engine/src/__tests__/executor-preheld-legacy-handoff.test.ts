import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import {
  AgentSemaphore,
  clearPreHeldExecutorSlotsForTests,
  hasPreHeldExecutorSlot,
  registerPreHeldExecutorSlot,
} from "../concurrency.js";
import { TaskExecutor } from "../executor.js";
import { executingTaskLock } from "../active-session-registry.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

/*
FNXC:GlobalConcurrencyControls 2026-07-15-02:55:
Regression for Greptile P1 on PR #2107 (legacy handoff leaks reserved slot). When
maybeExecuteWorkflowGraph falls back it re-registers any scheduler pre-held slot for
the legacy execute path. execute() must drop that registration on every early return
that never reaches runWithExecutorSemaphore.take — authoritative dispatch accept,
workflow work-engine claim, and heartbeat defer — or the shared semaphore permanently
shrinks global capacity. Surface enumeration covers all three named leak paths.

FNXC:GlobalConcurrencyControls 2026-07-15-03:10:
Also cover authoritative dispatch rejection: a thrown callback exits execute() before the
accept-path drop and before the main try/finally, so the re-registered slot would leak
unless drop runs in the catch-before-rethrow path.
*/

const now = "2026-07-15T00:00:00.000Z";

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-PREHELD-HANDOFF",
    title: "Pre-held legacy handoff",
    description: "Graph fallback re-registers a pre-held concurrency slot",
    column: "in-progress",
    dependencies: [],
    // No enabledWorkflowSteps: minimal mock store lacks workflow-selection API and
    // falls back to legacy without fail-closing (transferPreHeldToLegacy=true).
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-preheld-handoff",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-preheld-handoff",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    autoMerge: true,
    maxAutoMergeRetries: 3,
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    ephemeralAgentsEnabled: true,
    ...overrides,
  };
}

/** Simulate the hold/release sweep: tryAcquire + register before execute. */
function reservePreHeld(taskId: string, sem: AgentSemaphore): void {
  expect(sem.tryAcquire()).toBe(true);
  registerPreHeldExecutorSlot(taskId);
  expect(hasPreHeldExecutorSlot(taskId)).toBe(true);
  expect(sem.activeCount).toBe(1);
}

afterEach(() => {
  clearPreHeldExecutorSlotsForTests();
  executingTaskLock._clearForTest();
});

describe("executor pre-held legacy handoff (graph fallback)", () => {
  it("drops the re-registered slot when authoritative dispatch owns the task", async () => {
    resetExecutorMocks();
    clearPreHeldExecutorSlotsForTests();
    executingTaskLock._clearForTest();

    const sem = new AgentSemaphore(2);
    const live = task();
    const store = createMockStore();
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings());
    // Ensure graph takes the minimal-store fallback path (no selection API).
    delete (store as { getTaskWorkflowSelection?: unknown }).getTaskWorkflowSelection;
    delete (store as { getTaskWorkflowSelectionAsync?: unknown }).getTaskWorkflowSelectionAsync;

    reservePreHeld(live.id, sem);

    const workflowAuthoritativeDispatch = vi.fn().mockResolvedValue(true);
    const executor = new TaskExecutor(store, "/tmp/test", {
      semaphore: sem,
      workflowAuthoritativeDispatch,
    } as any);

    await executor.execute(live);

    expect(workflowAuthoritativeDispatch).toHaveBeenCalledTimes(1);
    expect(hasPreHeldExecutorSlot(live.id)).toBe(false);
    expect(sem.activeCount).toBe(0);
  });

  it("drops the re-registered slot when authoritative dispatch rejects", async () => {
    resetExecutorMocks();
    clearPreHeldExecutorSlotsForTests();
    executingTaskLock._clearForTest();

    const sem = new AgentSemaphore(2);
    const live = task();
    const store = createMockStore();
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings());
    delete (store as { getTaskWorkflowSelection?: unknown }).getTaskWorkflowSelection;
    delete (store as { getTaskWorkflowSelectionAsync?: unknown }).getTaskWorkflowSelectionAsync;

    reservePreHeld(live.id, sem);

    const dispatchError = new Error("authoritative dispatch failed");
    const workflowAuthoritativeDispatch = vi.fn().mockRejectedValue(dispatchError);
    const executor = new TaskExecutor(store, "/tmp/test", {
      semaphore: sem,
      workflowAuthoritativeDispatch,
    } as any);

    await expect(executor.execute(live)).rejects.toThrow("authoritative dispatch failed");

    expect(workflowAuthoritativeDispatch).toHaveBeenCalledTimes(1);
    expect(hasPreHeldExecutorSlot(live.id)).toBe(false);
    expect(sem.activeCount).toBe(0);
  });

  it("drops the re-registered slot when the workflow work engine claims execution", async () => {
    resetExecutorMocks();
    clearPreHeldExecutorSlotsForTests();
    executingTaskLock._clearForTest();

    const sem = new AgentSemaphore(2);
    const live = task();
    const store = createMockStore();
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings());
    delete (store as { getTaskWorkflowSelection?: unknown }).getTaskWorkflowSelection;
    delete (store as { getTaskWorkflowSelectionAsync?: unknown }).getTaskWorkflowSelectionAsync;

    reservePreHeld(live.id, sem);

    const executor = new TaskExecutor(store, "/tmp/test", {
      semaphore: sem,
      workflowAuthoritativeDispatch: vi.fn().mockResolvedValue(false),
    } as any);
    vi.spyOn(executor as any, "maybeDispatchWorkflowWorkEngine").mockResolvedValue(true);

    await executor.execute(live);

    expect(hasPreHeldExecutorSlot(live.id)).toBe(false);
    expect(sem.activeCount).toBe(0);
  });

  it("drops the re-registered slot when heartbeat deferral skips legacy execution", async () => {
    resetExecutorMocks();
    clearPreHeldExecutorSlotsForTests();
    executingTaskLock._clearForTest();

    const sem = new AgentSemaphore(2);
    const live = task({ assignedAgentId: "agent-serial" });
    const store = createMockStore();
    store.getTask.mockResolvedValue(live);
    store.getSettings.mockResolvedValue(settings());
    delete (store as { getTaskWorkflowSelection?: unknown }).getTaskWorkflowSelection;
    delete (store as { getTaskWorkflowSelectionAsync?: unknown }).getTaskWorkflowSelectionAsync;

    reservePreHeld(live.id, sem);

    const executor = new TaskExecutor(store, "/tmp/test", {
      semaphore: sem,
      workflowAuthoritativeDispatch: vi.fn().mockResolvedValue(false),
    } as any);
    vi.spyOn(executor as any, "maybeDispatchWorkflowWorkEngine").mockResolvedValue(false);
    vi.spyOn(executor as any, "resolveEffectivePrincipalId").mockReturnValue("agent-serial");
    vi.spyOn(executor as any, "shouldDeferForHeartbeat").mockResolvedValue(true);

    await executor.execute(live);

    expect(hasPreHeldExecutorSlot(live.id)).toBe(false);
    expect(sem.activeCount).toBe(0);
  });
});

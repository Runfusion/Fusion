import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "@fusion/core";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const now = "2026-07-16T00:00:00.000Z";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-7996",
    title: "Tool failure retry",
    description: "Reproduce executor tool errors",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "in-progress" }],
    currentStep: 0,
    log: [],
    branch: "fusion/fn-7996",
    baseBranch: "main",
    worktree: "/tmp/fusion-fn-7996",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    toolFailureDetectorLogCursor: 0,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function graphFailure() {
  return {
    disposition: "failed" as const,
    outcome: "failure" as const,
    visitedNodeIds: ["steps#0:step-execute"],
    context: { "node:steps#0:step-execute:value": "failure" },
  };
}

function makeHarness(options: { retries: number; entries: Array<{ type: string }>; settings?: Record<string, unknown>; task?: Partial<TaskDetail> }) {
  const store = createMockStore();
  const task = makeTask(options.task);
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15_000,
    autoMerge: true,
    executorToolFailureRetryCount: options.retries,
    executorToolFailureRetryBackoffMs: 0,
    executorToolFailureThreshold: 3,
    ...options.settings,
  });
  store.getAgentLogCount = vi.fn().mockResolvedValue(options.entries.length);
  store.getAgentLogs = vi.fn().mockResolvedValue(options.entries);
  store.claimNextToolFailureRetry = vi.fn().mockResolvedValue({ outcome: "claimed", attempt: 1 });
  store.updateTask.mockImplementation(async (_id: string, patch: Partial<TaskDetail>) => Object.assign(task, patch));
  store.updateTaskAtomic = vi.fn(async (_id: string, updater: (current: TaskDetail) => Partial<TaskDetail> | null) => {
    const updates = updater(task);
    if (updates) Object.assign(task, updates);
    return task;
  });
  store.markToolFailureRetryExhaustedAudit = vi.fn().mockResolvedValue(true);
  store.recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  const executor = new TaskExecutor(store, "/tmp/test");
  (executor as any).graphToolFailureRunCursors.set(task.id, 0);
  return { executor, store, task };
}

describe("executor consecutive tool-failure retry (FN-7996)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("retries a qualifying terminal step failure and records metadata-only audit evidence", async () => {
    const { executor, store, task } = makeHarness({
      retries: 2,
      entries: [{ type: "tool_error" }, { type: "tool_error" }, { type: "tool_error" }],
    });
    const execute = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).handleGraphFailure(task, graphFailure());
    await vi.advanceTimersByTimeAsync(0);

    expect(execute).toHaveBeenCalledWith(task);
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }), expect.anything());
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ graphResumeRetryCount: expect.anything() }), expect.anything());
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:execution-tool-failure-retry",
      metadata: {
        taskId: task.id,
        nodeId: "steps#0:step-execute",
        attempt: 1,
        maxAttempts: 2,
        consecutiveToolFailures: 3,
        mode: "same-model",
      },
    }));
  });

  it("parks unchanged after a spent retry budget and emits one exhaustion audit", async () => {
    const { executor, store, task } = makeHarness({
      retries: 2,
      entries: [{ type: "tool_error" }, { type: "tool_error" }, { type: "tool_error" }],
    });
    store.claimNextToolFailureRetry.mockResolvedValue({ outcome: "exhausted" });

    await (executor as any).handleGraphFailure(task, graphFailure());

    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:execution-tool-failure-retry-exhausted",
      metadata: expect.objectContaining({ taskId: task.id, attempts: 2, limit: 2, outcome: "terminal-park" }),
    }));
    expect(store.updateTaskAtomic).toHaveBeenCalledWith(task.id, expect.any(Function), undefined);
    expect(task).toMatchObject({
      status: "failed",
      error: "Workflow graph terminated with failure at node 'steps#0:step-execute'",
    });
  });

  it("escalates once to a configured model after same-model retries exhaust", async () => {
    const { executor, store, task } = makeHarness({
      retries: 2,
      entries: [{ type: "tool_error" }, { type: "tool_error" }, { type: "tool_error" }],
      settings: { executorModelEscalationEnabled: true, executorEscalationProvider: "anthropic", executorEscalationModelId: "claude-sonnet" },
    });
    store.claimNextToolFailureRetry.mockResolvedValue({ outcome: "exhausted" });
    const execute = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).handleGraphFailure(task, graphFailure());
    await vi.advanceTimersByTimeAsync(0);

    expect(task).toMatchObject({ modelProvider: "anthropic", modelId: "claude-sonnet", executorEscalationAttempted: true, status: null, error: null });
    expect(execute).toHaveBeenCalledWith(task);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:execution-escalation-retry", metadata: expect.objectContaining({ taskId: task.id, hasModelTarget: true, hasNodeTarget: false }) }));
    expect(store.updateTaskAtomic).toHaveBeenCalledWith(task.id, expect.any(Function), undefined);
  });

  it("requeues a node escalation for scheduler effective-node resolution", async () => {
    const { executor, store, task } = makeHarness({
      retries: 2,
      entries: [{ type: "tool_error" }, { type: "tool_error" }, { type: "tool_error" }],
      settings: { executorModelEscalationEnabled: true, executorEscalationNodeId: "cursor-node" },
    });
    store.claimNextToolFailureRetry.mockResolvedValue({ outcome: "exhausted" });
    const execute = vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

    await (executor as any).handleGraphFailure(task, graphFailure());

    expect(task).toMatchObject({ nodeId: "cursor-node", column: "todo", executorEscalationAttempted: true, status: null, error: null });
    expect(execute).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:execution-escalation-retry", metadata: expect.objectContaining({ hasNodeTarget: true }) }));
  });

  it("parks the single escalated attempt and records escalation exhaustion", async () => {
    const { executor, store, task } = makeHarness({
      retries: 2,
      entries: [{ type: "tool_error" }, { type: "tool_error" }, { type: "tool_error" }],
      task: { executorEscalationAttempted: true },
      settings: { executorModelEscalationEnabled: true, executorEscalationProvider: "anthropic", executorEscalationModelId: "claude-sonnet" },
    });
    store.claimNextToolFailureRetry.mockResolvedValue({ outcome: "exhausted" });

    await (executor as any).handleGraphFailure(task, graphFailure());

    expect(task.status).toBe("failed");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:execution-escalation-exhausted" }));
  });

  it("does not let a concurrent exhausted handler park the escalation it lost", async () => {
    const { executor, store, task } = makeHarness({
      retries: 2,
      entries: [{ type: "tool_error" }, { type: "tool_error" }, { type: "tool_error" }],
      settings: { executorModelEscalationEnabled: true, executorEscalationProvider: "anthropic", executorEscalationModelId: "claude-sonnet" },
    });
    store.claimNextToolFailureRetry.mockResolvedValue({ outcome: "exhausted" });
    task.executorEscalationAttempted = true;
    // The atomic escalation claim invalidates its exhausted cursor before scheduling.
    task.toolFailureDetectorLogCursor = null;

    await (executor as any).handleGraphFailure(task, graphFailure());

    expect(task).toMatchObject({ status: null, error: null, executorEscalationAttempted: true });
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }), expect.anything());
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:execution-escalation-exhausted",
    }));
  });

  it("audits a terminal escalated failure even after escalation is disabled", async () => {
    const { executor, store, task } = makeHarness({
      retries: 0,
      entries: [],
      task: { executorEscalationAttempted: true, modelProvider: "anthropic", modelId: "claude-sonnet" },
    });

    await (executor as any).handleGraphFailure(task, graphFailure());

    expect(task.status).toBe("failed");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:execution-escalation-exhausted",
      metadata: expect.objectContaining({ hadModelTarget: true, hadNodeTarget: false }),
    }));
  });

  it("does not let an exhausted stale handler park a newer cursor-owned run", async () => {
    const { executor, store, task } = makeHarness({
      retries: 2,
      entries: [{ type: "tool_error" }, { type: "tool_error" }, { type: "tool_error" }],
    });
    store.claimNextToolFailureRetry.mockResolvedValue({ outcome: "exhausted" });
    const newRun = makeTask({ toolFailureDetectorLogCursor: 99 });
    store.updateTaskAtomic.mockImplementation(async (_id: string, updater: (current: TaskDetail) => Partial<TaskDetail> | null) => {
      // A new execution captured its own log cursor after the old run's claim exhausted.
      expect(updater(newRun)).toBeNull();
      return newRun;
    });

    await (executor as any).handleGraphFailure(task, graphFailure());

    expect(newRun).toMatchObject({ status: null, error: null, toolFailureDetectorLogCursor: 99 });
    expect(store.markToolFailureRetryExhaustedAudit).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:execution-tool-failure-retry-exhausted",
    }));
    expect(store.updateTask).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ status: "failed" }), expect.anything());
  });

  it("preserves the immediate legacy park when disabled or errors are not consecutive", async () => {
    const disabled = makeHarness({ retries: 0, entries: [{ type: "tool_error" }, { type: "tool_error" }, { type: "tool_error" }] });
    await (disabled.executor as any).handleGraphFailure(disabled.task, graphFailure());
    expect(disabled.store.claimNextToolFailureRetry).not.toHaveBeenCalled();
    expect(disabled.store.updateTask).toHaveBeenCalledWith(disabled.task.id, expect.objectContaining({ status: "failed" }), undefined);

    const interleaved = makeHarness({ retries: 2, entries: [{ type: "tool_error" }, { type: "tool_result" }, { type: "tool_error" }, { type: "tool_error" }] });
    await (interleaved.executor as any).handleGraphFailure(interleaved.task, graphFailure());
    expect(interleaved.store.claimNextToolFailureRetry).not.toHaveBeenCalled();
    expect(interleaved.store.updateTask).toHaveBeenCalledWith(interleaved.task.id, expect.objectContaining({ status: "failed" }), undefined);
  });
});

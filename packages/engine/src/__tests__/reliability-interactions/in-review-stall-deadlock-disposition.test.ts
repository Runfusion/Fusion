import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function createStore(task: Task, settings: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const auditEvents: any[] = [];

  (emitter as any).__auditEvents = auditEvents;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    inReviewStallDeadlockThreshold: 3,
    ...settings,
  });
  (emitter as any).listTasks = vi.fn().mockImplementation(async () => [task]);
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date(Date.now()).toISOString(), action });
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    Object.assign(task, updates);
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    auditEvents.push(event);
  });
  (emitter as any).moveTask = vi.fn().mockResolvedValue(undefined);
  (emitter as any).enqueueMergeQueue = vi.fn().mockResolvedValue(undefined);

  return emitter;
}

describe("reliability interactions: in-review stall deadlock disposition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("FN-4885: auto-disposes repeated merge-blocker stalls once, then no-ops", async () => {
    const task = {
      id: "FN-4860",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "Failed to create worktree after 3 attempts: Branch fusion/fn-4860 conflict could not be auto-resolved",
      branch: "fusion/fn-4860",
      worktree: "/tmp/missing-fn-4860",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.status).toBe("failed");

    const disposedEntries = task.log.filter((entry: { action: string }) =>
      entry.action.startsWith("In-review stall auto-disposed [merge-blocker]:"),
    );
    expect(disposedEntries).toHaveLength(1);

    const auditEvents = (store as any).__auditEvents as any[];
    const disposeAuditEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-deadlock-disposed");
    expect(disposeAuditEvents).toHaveLength(1);

    expect(disposeAuditEvents[0]).toMatchObject({
      domain: "database",
      taskId: "FN-4860",
      target: "FN-4860",
      metadata: expect.objectContaining({
        code: "merge-blocker",
        repetitionCount: 3,
        threshold: 3,
        branch: "fusion/fn-4860",
        worktree: "/tmp/missing-fn-4860",
      }),
    });

    const logCountBeforeFourth = task.log.length;
    const auditCountBeforeFourth = disposeAuditEvents.length;
    const updateCallsBeforeFourth = (store.updateTask as any).mock.calls.length;

    vi.setSystemTime(new Date("2026-01-01T00:16:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);

    expect(task.log).toHaveLength(logCountBeforeFourth);
    expect((store.updateTask as any).mock.calls.length).toBe(updateCallsBeforeFourth);
    const disposeAuditsAfterFourth = ((store as any).__auditEvents as any[]).filter(
      (event) => event.mutationType === "task:in-review-stall-deadlock-disposed",
    );
    expect(disposeAuditsAfterFourth).toHaveLength(auditCountBeforeFourth);

    manager.stop();
  });

  it("FN-6113: terminal provider errors dispose in a single stall cycle", async () => {
    const task = {
      id: "FN-6113-TERMINAL",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
      branch: "fusion/fn-6113-terminal",
      worktree: "/tmp/fn-6113-terminal",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("non-retryable-provider-error");
    expect(task.status).toBe("failed");
    expect(task.error).toBe(
      "Terminal provider error (non-retryable): Terminal provider error: HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
    );
    expect(task.log.filter((entry: { action: string }) => entry.action.startsWith("In-review stall terminal disposed [non-retryable-provider-error]:"))).toHaveLength(1);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed ["))).toBe(false);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall surfaced ["))).toBe(false);

    const auditEvents = (store as any).__auditEvents as any[];
    const terminalAuditEvents = auditEvents.filter((event) => event.mutationType === "task:in-review-stall-terminal-provider-error");
    expect(terminalAuditEvents).toHaveLength(1);
    expect(terminalAuditEvents[0]).toMatchObject({
      domain: "database",
      taskId: "FN-6113-TERMINAL",
      target: "FN-6113-TERMINAL",
      metadata: expect.objectContaining({
        code: "non-retryable-provider-error",
        reason: "Terminal provider error: HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
        branch: "fusion/fn-6113-terminal",
        worktree: "/tmp/fn-6113-terminal",
      }),
    });

    manager.stop();
  });

  it("FN-6113: terminal provider errors are ignored when autoMerge is disabled", async () => {
    const task = {
      id: "FN-6113-AUTOMERGE-OFF",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "HTTP 400 invalid_request_error: model gpt-5.3-codex is not supported",
      branch: "fusion/fn-6113-automerge-off",
      worktree: "/tmp/fn-6113-automerge-off",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task, { autoMerge: false });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(task.paused).toBe(false);
    expect((store.updateTask as any).mock.calls.length).toBe(0);
    expect(task.log).toHaveLength(0);

    manager.stop();
  });

  it("FN-6113: terminal provider errors do not auto-dispose userPaused tasks", async () => {
    const task = {
      id: "FN-6113-USER-PAUSED",
      column: "in-review",
      paused: false,
      userPaused: true,
      status: "failed",
      error: "HTTP 403 forbidden for model access",
      branch: "fusion/fn-6113-user-paused",
      worktree: "/tmp/fn-6113-user-paused",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(false);
    expect(task.pausedReason).toBeUndefined();
    expect((store.updateTask as any).mock.calls.length).toBe(0);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall terminal disposed ["))).toBe(false);
    expect(((store as any).__auditEvents as any[]).some((event) => event.mutationType === "task:in-review-stall-terminal-provider-error")).toBe(false);

    manager.stop();
  });

  it("FN-6113: retryable provider errors still use repeated-stall deadlock disposition", async () => {
    const task = {
      id: "FN-6113-RETRYABLE",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: "failed",
      error: "HTTP 503 service unavailable",
      branch: "fusion/fn-6113-retryable",
      worktree: "/tmp/fn-6113-retryable",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(false);
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(false);
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);

    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(task.log.filter((entry: { action: string }) => entry.action.startsWith("In-review stall surfaced [merge-blocker]:"))).toHaveLength(2);
    expect(task.log.filter((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed [merge-blocker]:"))).toHaveLength(1);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall terminal disposed ["))).toBe(false);

    manager.stop();
  });

  it("FN-6070: rejected limbo requeues do not increment into deadlock disposition", async () => {
    const task = {
      id: "FN-6070-REJECTED",
      column: "in-review",
      paused: false,
      userPaused: false,
      status: undefined,
      error: undefined,
      branch: "fusion/fn-6070-rejected",
      worktree: "/tmp/fn-6070-rejected",
      mergeDetails: undefined,
      mergeRetries: 0,
      completionHandoffLimboRecoveryCount: 2,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [{ action: "Task marked done by agent", timestamp: "2026-01-01T00:00:00.000Z" }],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/repo",
      requeueForAutoMerge: vi.fn(() => false),
    });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    await manager.recoverCompletionHandoffLimbo();
    vi.setSystemTime(new Date("2026-01-01T00:25:00.000Z"));
    await manager.recoverCompletionHandoffLimbo();
    vi.setSystemTime(new Date("2026-01-01T00:40:00.000Z"));
    await manager.recoverCompletionHandoffLimbo();

    expect(task.completionHandoffLimboRecoveryCount).toBe(2);
    expect(task.status).toBeUndefined();
    expect(task.error).toBeUndefined();
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(task.pausedReason).not.toBe("in-review-stall-deadlock");
    expect(task.log.some((entry: { action: string }) => entry.action.includes("Completion handoff limbo recovery exhausted"))).toBe(false);

    manager.stop();
  });

  it("does not auto-dispose userPaused tasks with repeated identical stalls", async () => {
    const task = {
      id: "FN-4860-PAUSED",
      column: "in-review",
      paused: false,
      userPaused: true,
      status: "failed",
      error: "Failed to create worktree after 3 attempts: Branch fusion/fn-4860 conflict could not be auto-resolved",
      branch: "fusion/fn-4860-paused",
      worktree: "/tmp/missing-fn-4860-paused",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      log: [],
    } as any satisfies Task;

    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T00:10:00.000Z"));
    await manager.surfaceInReviewStalls();
    vi.setSystemTime(new Date("2026-01-01T00:12:00.000Z"));
    await manager.surfaceInReviewStalls();
    vi.setSystemTime(new Date("2026-01-01T00:14:00.000Z"));
    await manager.surfaceInReviewStalls();

    expect(task.pausedReason).not.toBe("in-review-stall-deadlock");
    expect((store.updateTask as any).mock.calls.length).toBe(0);
    expect(task.log.some((entry: { action: string }) => entry.action.startsWith("In-review stall auto-disposed ["))).toBe(false);
    expect(((store as any).__auditEvents as any[]).some((event) => event.mutationType === "task:in-review-stall-deadlock-disposed")).toBe(false);

    manager.stop();
  });
});

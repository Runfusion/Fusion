import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { SelfHealingManager, COMPLETION_HANDOFF_LIMBO_GRACE_MS, MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES } from "../../self-healing.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4999-T",
    title: "t",
    description: "d",
    column: "in-review",
    dependencies: [],
    steps: [{ id: "1", title: "s", status: "done" as const }],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function createStore(task: Task) {
  let current = { ...task } as Task;
  return {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(async () => [current]),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => {
      current = { ...current, ...updates } as Task;
      return current;
    }),
    moveTask: vi.fn(async () => undefined),
    enqueueMergeQueue: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    _get: () => current,
  } as any;
}

describe("FN-4999 reliability interactions: completion-handoff-limbo", () => {
  it("recovers exact signature by requeueing auto-merge", async () => {
    const task = makeTask({
      worktree: "/tmp/wt",
      status: undefined,
      review: undefined,
      reviewState: undefined,
      mergeDetails: undefined,
      log: [{ action: "Task marked done by agent", timestamp: new Date(Date.now() - 6 * 60_000).toISOString() } as any],
    });
    const store = createStore(task);
    const requeueForAutoMerge = vi.fn();
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });

    await manager.recoverCompletionHandoffLimbo();

    expect(requeueForAutoMerge).toHaveBeenCalledTimes(1);
    expect(requeueForAutoMerge).toHaveBeenCalledWith("FN-4999-T");
    expect(store.enqueueMergeQueue).toHaveBeenCalledWith("FN-4999-T");
    expect(store.logEntry).toHaveBeenCalledWith("FN-4999-T", expect.stringMatching(/Auto-recovered \(FN-4999\)/));
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-completion-handoff-limbo",
      target: "FN-4999-T",
      metadata: expect.objectContaining({ ageMs: expect.any(Number), source: "self-healing-in-review-sweep" }),
    }));
    const event = store.recordRunAuditEvent.mock.calls.find((call: any[]) => call[0].mutationType === "task:auto-recover-completion-handoff-limbo")?.[0];
    expect(event.metadata.ageMs).toBeGreaterThanOrEqual(COMPLETION_HANDOFF_LIMBO_GRACE_MS);
  });

  it("is no-op before grace period elapses", async () => {
    const store = createStore(makeTask({ status: undefined, review: undefined, reviewState: undefined, mergeDetails: undefined, log: [{ action: "Task marked done by agent", timestamp: new Date(Date.now() - 30_000).toISOString() } as any] }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge: vi.fn() });
    await manager.recoverCompletionHandoffLimbo();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).not.toHaveBeenCalled();
  });

  it("skips active tasks", async () => {
    const requeueForAutoMerge = vi.fn();
    const store = createStore(makeTask({ status: undefined, review: undefined, reviewState: undefined, mergeDetails: undefined, log: [{ action: "Task marked done by agent", timestamp: new Date(Date.now() - 6 * 60_000).toISOString() } as any] }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge, isTaskActive: () => true });
    await manager.recoverCompletionHandoffLimbo();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
  });

  it("honors legitimate merge blockers", async () => {
    const requeueForAutoMerge = vi.fn();
    const store = createStore(makeTask({ status: "failed", review: undefined, reviewState: undefined, mergeDetails: undefined, log: [{ action: "Task marked done by agent", timestamp: new Date(Date.now() - 6 * 60_000).toISOString() } as any] }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    await manager.recoverCompletionHandoffLimbo();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
  });

  it("is no-op when marker is absent", async () => {
    const requeueForAutoMerge = vi.fn();
    const store = createStore(makeTask({ status: undefined, review: undefined, reviewState: undefined, mergeDetails: undefined, log: [{ action: "workflow step", timestamp: new Date(Date.now() - 6 * 60_000).toISOString() } as any] }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    await manager.recoverCompletionHandoffLimbo();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
  });

  it("emits exhausted event and fails task at cap", async () => {
    const requeueForAutoMerge = vi.fn();
    const store = createStore(makeTask({ completionHandoffLimboRecoveryCount: MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES, status: undefined, review: undefined, reviewState: undefined, mergeDetails: undefined, log: [{ action: "Task marked done by agent", timestamp: new Date(Date.now() - 6 * 60_000).toISOString() } as any] }));
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge });
    await manager.recoverCompletionHandoffLimbo();
    expect(requeueForAutoMerge).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith("FN-4999-T", expect.objectContaining({ status: "failed", error: "Completion handoff limbo recovery exhausted" }));
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ mutationType: "task:auto-recover-completion-handoff-limbo-exhausted" }));
  });

  it("increments completionHandoffLimboRecoveryCount on each successful recovery", async () => {
    const task = makeTask({ status: undefined, review: undefined, reviewState: undefined, mergeDetails: undefined, log: [{ action: "Task marked done by agent", timestamp: new Date(Date.now() - 6 * 60_000).toISOString() } as any] });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/repo", requeueForAutoMerge: vi.fn() });

    await manager.recoverCompletionHandoffLimbo();
    await manager.recoverCompletionHandoffLimbo();
    await manager.recoverCompletionHandoffLimbo();

    const increments = store.updateTask.mock.calls
      .map((call: any[]) => call[1]?.completionHandoffLimboRecoveryCount)
      .filter((value: unknown) => typeof value === "number");
    expect(increments).toEqual([1, 2, 3]);
  });
});

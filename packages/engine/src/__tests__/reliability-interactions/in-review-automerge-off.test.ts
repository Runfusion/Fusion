import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5147-RI",
    title: "t",
    description: "d",
    column: "in-review",
    paused: false,
    status: undefined,
    error: undefined,
    steps: [{ name: "s", status: "done" as const }],
    workflowStepResults: [],
    dependencies: [],
    log: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function createStore(tasks: Task[], settingsOverrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  const audits: any[] = [];
  (emitter as any).__audits = audits;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: false,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    inReviewStalledThresholdMs: 60_000,
    inReviewStallDeadlockThreshold: 3,
    maxPostReviewFixes: 2,
    ...settingsOverrides,
  });
  (emitter as any).listTasks = vi.fn().mockImplementation(async ({ column }: { column?: string } = {}) => {
    if (!column) return tasks;
    return tasks.filter((t) => t.column === column);
  });
  (emitter as any).logEntry = vi.fn().mockImplementation(async (taskId: string, action: string) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.log = t.log ?? [];
    t.log.push({ timestamp: new Date(Date.now()).toISOString(), action } as any);
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (taskId: string, updates: Partial<Task>) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    Object.assign(t, updates, { updatedAt: new Date(Date.now()).toISOString() });
    return t;
  });
  (emitter as any).moveTask = vi.fn().mockImplementation(async (taskId: string, column: string) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.column = column as any;
    t.updatedAt = new Date(Date.now()).toISOString();
    return t;
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockImplementation(async (event: any) => {
    audits.push(event);
  });
  (emitter as any).getAgentLogs = vi.fn().mockResolvedValue([]);
  (emitter as any).getTask = vi.fn().mockImplementation(async (id: string) => tasks.find((t) => t.id === id));
  return emitter;
}

describe("FN-5147 reliability interactions: in-review autoMerge off", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("long-quiet in-review remains unchanged across startup + maintenance", async () => {
    const task = makeTask({ id: "FN-5147-Q1", steps: [{ name: "s", status: "done" as const }] });
    const store = createStore([task], { taskStuckTimeoutMs: 1_000, inReviewStalledThresholdMs: 1_000 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T05:00:00.000Z"));
    await manager.runStartupRecovery();
    await (manager as any).runMaintenance();

    expect(task.column).toBe("in-review");
    expect(task.paused).toBe(false);
    expect(task.status).toBeUndefined();
    expect(task.taskDoneRetryCount).toBeUndefined();
    expect(task.mergeRetries).toBeUndefined();
    expect((store.moveTask as any).mock.calls.length).toBe(0);
    expect((task.log ?? []).some((entry: any) => /Auto-recovered|Auto-revived|Auto-retry|kicked back to todo|in-review-stall-deadlock/.test(entry.action))).toBe(false);
    manager.stop();
  });

  it("stale transient merging status does not requeue/finalize with autoMerge off", async () => {
    const task = makeTask({ id: "FN-5147-Q2", status: "merging" as any, error: "x" });
    const store = createStore([task], { taskStuckTimeoutMs: 1_000 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T05:00:00.000Z"));
    await (manager as any).runMaintenance();

    expect(task.column).toBe("in-review");
    expect((store.moveTask as any).mock.calls.length).toBe(0);
    manager.stop();
  });

  it("partial-progress no-task-done failure stays in-review", async () => {
    const task = makeTask({
      id: "FN-5147-Q3",
      status: "failed",
      error: "Agent exited without calling fn_task_done",
      taskDoneRetryCount: 1,
      steps: [{ name: "s1", status: "done" as const }, { name: "s2", status: "pending" as const }],
    });
    const store = createStore([task]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    await manager.recoverPartialProgressNoTaskDoneFailures();
    expect(task.column).toBe("in-review");
    expect(task.taskDoneRetryCount).toBe(1);
    expect((store.moveTask as any).mock.calls.length).toBe(0);
    manager.stop();
  });

  it("incomplete in-review task is not moved by stale-incomplete sweep", async () => {
    const task = makeTask({
      id: "FN-5147-Q4",
      status: undefined,
      steps: [{ name: "s1", status: "pending" as const }],
    });
    const store = createStore([task], { taskStuckTimeoutMs: 1_000 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T05:00:00.000Z"));
    await manager.recoverStaleIncompleteReviewTasks();
    expect(task.column).toBe("in-review");
    expect((store.moveTask as any).mock.calls.length).toBe(0);
    manager.stop();
  });

  it("unusable-worktree review failure is not requeued", async () => {
    const task = makeTask({
      id: "FN-5147-Q5",
      status: "failed",
      error: "Failed to create worktree after 3 attempts: missing worktree",
      worktree: "/tmp/missing",
      steps: [{ name: "s1", status: "done" as const }, { name: "s2", status: "pending" as const }],
    });
    const store = createStore([task]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    await manager.recoverMissingWorktreeReviewFailures();
    expect(task.column).toBe("in-review");
    expect((store.moveTask as any).mock.calls.length).toBe(0);
    manager.stop();
  });

  it("reason-driven stall signals are fully suppressed", async () => {
    const task = makeTask({
      id: "FN-5147-Q6",
      status: "failed",
      error: "Failed to create worktree after 3 attempts: branch conflict",
      worktree: "/tmp/missing",
      branch: "fusion/fn-5147-q6",
    });
    const store = createStore([task], { taskStuckTimeoutMs: 1_000, inReviewStallDeadlockThreshold: 1 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    for (let i = 0; i < 4; i++) {
      await manager.surfaceInReviewStalls();
      await manager.surfaceInReviewStalled();
    }

    expect(task.inReviewStall).toBeUndefined();
    expect((task.log ?? []).some((entry: any) => entry.action.includes("Stall surfaced") || entry.action.includes("in-review-stall-deadlock"))).toBe(false);
    expect((store as any).__audits.some((e: any) => e.mutationType === "task:in-review-stall-deadlock-disposed")).toBe(false);
    manager.stop();
  });

  it("direct stall detectors return 0 and emit no logs", async () => {
    const task = makeTask({ id: "FN-5147-Q7", status: "failed", error: "x" });
    const store = createStore([task], { taskStuckTimeoutMs: 1_000, inReviewStalledThresholdMs: 1_000 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(await manager.surfaceInReviewStalled()).toBe(0);
    expect((task.log ?? []).length).toBe(0);
    manager.stop();
  });
});

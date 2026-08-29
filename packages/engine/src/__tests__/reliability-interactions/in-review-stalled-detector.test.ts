import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function createStore(task: Task, settings: Record<string, unknown> = {}, mergeQueuedTaskIds: string[] = []): TaskStore & EventEmitter {
  const emitter = new EventEmitter() as TaskStore & EventEmitter;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    inReviewStallDeadlockThreshold: 3,
    inReviewStalledThresholdMs: 3_600_000,
    stalePausedReviewThresholdMs: 3_600_000,
    ...settings,
  });
  (emitter as any).listTasks = vi.fn().mockImplementation(async ({ column }: { column?: string } = {}) => {
    if (!column || task.column === column) return [task];
    return [];
  });
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date(Date.now()).toISOString(), action });
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, updates: Partial<Task>) => {
    Object.assign(task, updates, { updatedAt: new Date(Date.now()).toISOString() });
  });
  (emitter as any).moveTask = vi.fn().mockImplementation(async (_id: string, column: string) => {
    task.column = column as any;
    task.updatedAt = new Date(Date.now()).toISOString();
  });
  (emitter as any).peekMergeQueue = vi.fn(() => mergeQueuedTaskIds.map((taskId) => ({
    taskId,
    enqueuedAt: new Date().toISOString(),
    priority: "normal",
    leasedBy: null,
    leasedAt: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    lastError: null,
  })));
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

describe("reliability interactions: in-review-stalled detector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function baseTask(overrides: Record<string, unknown> = {}): Task {
    return {
      id: "FN-5093-RI",
      column: "in-review",
      paused: false,
      status: "failed",
      error: "Failed to create worktree after 3 attempts: Branch fusion/fn-5093-ri conflict could not be auto-resolved",
      branch: "fusion/fn-5093-ri",
      worktree: "/tmp/missing-fn-5093-ri",
      mergeDetails: {},
      mergeRetries: 0,
      steps: [{ name: "merge", status: "done" }],
      workflowStepResults: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
      columnMovedAt: "2026-01-01T00:00:00.000Z",
      log: [],
      dependencies: [],
      ...overrides,
    } as any;
  }

  it("reason-driven stall suppresses quiet detector until reason entry ages out", async () => {
    const task = baseTask();
    const store = createStore(task, { inReviewStalledThresholdMs: 3_600_000, taskStuckTimeoutMs: 48 * 3_600_000 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(await manager.surfaceInReviewStalled()).toBe(0);

    vi.setSystemTime(new Date("2026-01-01T04:00:00.000Z"));
    expect(await manager.surfaceInReviewStalled()).toBe(1);
    expect(task.log.some((entry) => entry.action.startsWith("In-review stalled surfaced [in-review-stalled]"))).toBe(true);

    manager.stop();
  });

  it("does not surface merge-stalled badges for tasks already queued in the merge lane", async () => {
    const task = baseTask({
      id: "FN-6088",
      status: "merging",
      error: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      columnMovedAt: "2026-01-01T00:00:00.000Z",
    });
    const store = createStore(task, { inReviewStalledThresholdMs: 3_600_000 }, ["FN-6088"]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo", getExecutingTaskIds: () => new Set() });

    vi.setSystemTime(new Date("2026-01-01T06:00:00.000Z"));

    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(await manager.surfaceInReviewStalled()).toBe(0);
    expect(await manager.recoverGhostReviewTasks()).toBe(0);
    expect(task.column).toBe("in-review");
    expect(task.log?.some((entry) => entry.action.includes("stall"))).toBe(false);

    manager.stop();
  });

  it("does not kick queued completed review tasks back to todo as ghost reviews", async () => {
    const task = baseTask({
      id: "FN-6086",
      status: null,
      error: null,
      steps: [],
      inReviewStall: undefined,
      worktree: "/tmp/wt",
    });
    const store = createStore(task, { inReviewStalledThresholdMs: 3_600_000, taskStuckTimeoutMs: 12 * 3_600_000 }, ["FN-6086"]);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo", getExecutingTaskIds: () => new Set() });

    vi.setSystemTime(new Date("2026-01-01T13:00:00.000Z"));

    expect(await manager.recoverGhostReviewTasks()).toBe(0);
    expect(await manager.surfaceInReviewStalled()).toBe(0);
    expect(task.column).toBe("in-review");

    manager.stop();
  });

  it("paused in-review tasks are owned by stale-paused-review detector", async () => {
    const task = baseTask({ paused: true, pausedReason: "manual-hold", status: "failed", error: null });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    expect(await manager.surfaceStalePausedReviews()).toBe(1);
    expect(await manager.surfaceInReviewStalled()).toBe(0);

    manager.stop();
  });

  it("ghost-review recovery can move task to todo after quiet detector logs first", async () => {
    const task = baseTask({
      status: null,
      error: null,
      steps: [],
      inReviewStall: undefined,
      worktree: "/tmp/wt",
    });
    const store = createStore(task, { inReviewStalledThresholdMs: 3_600_000, taskStuckTimeoutMs: 12 * 3_600_000 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo", getExecutingTaskIds: () => new Set() });

    vi.setSystemTime(new Date("2026-01-01T05:00:00.000Z"));
    expect(await manager.surfaceInReviewStalled()).toBe(1);
    expect(task.column).toBe("in-review");

    vi.setSystemTime(new Date("2026-01-01T13:00:00.000Z"));
    expect(await manager.recoverGhostReviewTasks()).toBe(1);
    expect(task.column).toBe("todo");
    expect(await manager.surfaceInReviewStalled()).toBe(0);

    manager.stop();
  });

  it("deadlock-disposed paused task is ignored by quiet detector", async () => {
    const task = baseTask();
    const store = createStore(task, { inReviewStallDeadlockThreshold: 1 });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(1);
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("in-review-stall-deadlock");
    expect(await manager.surfaceInReviewStalled()).toBe(0);

    manager.stop();
  });

  it("autoMerge false suppresses both detectors", async () => {
    const task = baseTask();
    const store = createStore(task, { autoMerge: false });
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });

    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(await manager.surfaceInReviewStalled()).toBe(0);

    manager.stop();
  });
});

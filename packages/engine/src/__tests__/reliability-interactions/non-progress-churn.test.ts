import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../executor-test-helpers.js";
import type { Task, TaskStore } from "@fusion/core";
import { TaskExecutor } from "../../executor.js";
import { SelfHealingManager } from "../../self-healing.js";
import { isRunnableQueuedOverlapCandidate } from "../../scheduler.js";
import { StuckTaskDetector } from "../../stuck-task-detector.js";

type MockTaskStore = TaskStore & EventEmitter & {
  getSettings: ReturnType<typeof vi.fn>;
  getTask: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
  updateTask: ReturnType<typeof vi.fn>;
  moveTask: ReturnType<typeof vi.fn>;
  handoffToReview: ReturnType<typeof vi.fn>;
  logEntry: ReturnType<typeof vi.fn>;
  recordRunAuditEvent: ReturnType<typeof vi.fn>;
};

function createStore(task: Task, settings: Record<string, unknown> = {}): MockTaskStore {
  const emitter = new EventEmitter() as MockTaskStore;
  (emitter as any).getSettings = vi.fn().mockResolvedValue({
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    taskStuckTimeoutMs: 60_000,
    maxStuckKills: 6,
    inReviewStallDeadlockThreshold: 3,
    inReviewStalledThresholdMs: 3_600_000,
    stalePausedReviewThresholdMs: 3_600_000,
    ...settings,
  });
  (emitter as any).getTask = vi.fn().mockImplementation(async () => task);
  (emitter as any).listTasks = vi.fn().mockImplementation(async ({ column }: { column?: string } = {}) => {
    if (!column || task.column === column) return [task];
    return [];
  });
  (emitter as any).updateTask = vi.fn().mockImplementation(async (_taskId: string, patch: Partial<Task>) => {
    Object.assign(task, patch, { updatedAt: new Date(Date.now()).toISOString() });
  });
  (emitter as any).moveTask = vi.fn().mockImplementation(async (_taskId: string, column: string) => {
    task.column = column as any;
    task.updatedAt = new Date(Date.now()).toISOString();
  });
  (emitter as any).handoffToReview = vi.fn().mockImplementation(async (_taskId: string, _opts: any) => {
    task.column = "in-review" as any;
    task.updatedAt = new Date(Date.now()).toISOString();
    return task;
  });
  (emitter as any).logEntry = vi.fn().mockImplementation(async (_taskId: string, action: string) => {
    task.log = task.log ?? [];
    task.log.push({ timestamp: new Date(Date.now()).toISOString(), action });
  });
  (emitter as any).recordRunAuditEvent = vi.fn().mockResolvedValue(undefined);
  return emitter;
}

function baseTask(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "FN-5168-RI",
    lineageId: "lin-fn-5168-ri",
    title: "non-progress churn",
    description: "reliability interaction harness",
    column: "in-progress",
    status: null,
    error: null,
    steps: [{ name: "Implement", status: "in-progress" }],
    workflowStepResults: [],
    log: [],
    dependencies: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    stuckKillCount: 0,
    ...overrides,
  } as any;
}

async function runNoProgressChurnFlow(options: { autoMerge?: boolean } = {}) {
  const task = baseTask();
  const store = createStore(task, { autoMerge: options.autoMerge ?? true });
  const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
  const detector = new StuckTaskDetector(store, {
    beforeRequeue: (taskId, reason, event) => manager.checkStuckBudget(taskId, reason, event),
  });
  const executor = new TaskExecutor(store, "/tmp/repo", { stuckTaskDetector: detector });
  (detector as any).onLoopDetected = (event: any) => executor.handleLoopDetected(event);

  const session = {
    compact: vi.fn(async () => ({ summary: "Compacted conversation", tokensBefore: 150000 })),
    steer: vi.fn(async () => {}),
    dispose: vi.fn(),
    sessionManager: { getLeafId: vi.fn().mockReturnValue("leaf-1") },
    state: {},
  };
  (executor as any).activeSessions.set(task.id, {
    session,
    seenSteeringIds: new Set(),
  });

  detector.trackTask(task.id, session as any);
  vi.advanceTimersByTime(61_000);
  for (let i = 0; i < 80; i++) {
    detector.recordActivity(task.id);
  }

  await detector.killAndRetry(task.id, 60_000);
  detector.recordProgress(task.id);

  vi.advanceTimersByTime(61_000);
  for (let i = 0; i < 25; i++) {
    detector.recordIgnoredStepUpdate(task.id);
  }

  await detector.checkNow();

  return { task, store, manager, detector, executor, session };
}

describe("reliability interactions: non-progress churn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("compacts once, then escalates repeated rebuffs to no-progress-churn without a second compact attempt", async () => {
    const { task, session, manager } = await runNoProgressChurnFlow();

    expect(session.compact).toHaveBeenCalledTimes(1);
    expect(task.error).toMatch(/^STUCK_NO_PROGRESS_CHURN:/);
    expect(task.column).toBe("in-review");

    manager.stop();
  });

  it("beforeRequeue prevents requeue and parks the task in in-review failed", async () => {
    const { task, store, manager } = await runNoProgressChurnFlow();

    expect(task.status).toBe("failed");
    expect(task.column).toBe("in-review");
    expect(task.error).toMatch(/^STUCK_NO_PROGRESS_CHURN:/);
    expect(store.handoffToReview).toHaveBeenCalledWith(task.id, expect.objectContaining({
      ownerAgentId: null,
      evidence: expect.objectContaining({ reason: "stuck-no-progress-churn", agentId: "self-healing" }),
    }));

    manager.stop();
  });

  it("writes the operator guidance log entry", async () => {
    const { task, manager } = await runNoProgressChurnFlow();

    expect(task.log.some((entry) => entry.action.includes("manually decompose the work via fn_task_create child tasks"))).toBe(true);

    manager.stop();
  });

  it("emits the no-progress churn audit event payload", async () => {
    const { task, store, manager } = await runNoProgressChurnFlow();

    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "database",
      mutationType: "task:stuck-no-progress-churn-terminalized",
      target: task.id,
      metadata: expect.objectContaining({
        taskId: task.id,
        ignoredStepUpdateCount: 25,
        stuckKillStreak: 1,
        lastReason: "no-progress-churn",
      }),
    }));

    manager.stop();
  });

  it("respects FN-5147 autoMerge false by leaving the terminalized task in in-review", async () => {
    const { task, manager } = await runNoProgressChurnFlow({ autoMerge: false });

    expect(task.column).toBe("in-review");
    expect(task.status).toBe("failed");

    expect(await manager.surfaceInReviewStalls()).toBe(0);
    expect(await manager.surfaceInReviewStalled()).toBe(0);
    expect(task.column).toBe("in-review");

    manager.stop();
  });

  it("does not route active verification churn into loop recovery or stuck-kill budget", async () => {
    const task = baseTask({ id: "FN-6598-RI" });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    const beforeRequeue = vi.fn((taskId, reason, event) => manager.checkStuckBudget(taskId, reason, event));
    const onLoopDetected = vi.fn().mockResolvedValue(false);
    const detector = new StuckTaskDetector(store, { beforeRequeue, onLoopDetected });
    const session = { dispose: vi.fn() };

    detector.trackTask(task.id, session as any);
    detector.beginVerification(task.id, 120_000);
    vi.advanceTimersByTime(61_000);
    for (let i = 0; i < 80; i++) {
      detector.recordActivity(task.id);
    }

    await detector.checkNow();

    expect(onLoopDetected).not.toHaveBeenCalled();
    expect(beforeRequeue).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(task.column).toBe("in-progress");
    expect(task.stuckKillCount).toBe(0);

    manager.stop();
  });

  it("control: identical churn without active verification still reaches loop recovery and budget", async () => {
    const task = baseTask({ id: "FN-6598-RI-CONTROL" });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    const beforeRequeue = vi.fn((taskId, reason, event) => manager.checkStuckBudget(taskId, reason, event));
    const onLoopDetected = vi.fn().mockResolvedValue(false);
    const detector = new StuckTaskDetector(store, { beforeRequeue, onLoopDetected });
    const session = { dispose: vi.fn() };

    detector.trackTask(task.id, session as any);
    vi.advanceTimersByTime(61_000);
    for (let i = 0; i < 80; i++) {
      detector.recordActivity(task.id);
    }

    await detector.checkNow();

    expect(onLoopDetected).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, reason: "loop" }));
    expect(beforeRequeue).toHaveBeenCalledWith(
      task.id,
      "loop",
      expect.objectContaining({ taskId: task.id, reason: "loop" }),
    );
    expect(session.dispose).toHaveBeenCalledTimes(1);

    manager.stop();
  });

  it("parks incomplete STUCK_LOOP_EXHAUSTED tasks in todo when the churn signal does not fire", async () => {
    const task = baseTask({ id: "FN-5168-LOOP", stuckKillCount: 6 });
    const store = createStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/repo" });
    const detector = new StuckTaskDetector(store, {
      beforeRequeue: (taskId, reason, event) => manager.checkStuckBudget(taskId, reason, event),
      onLoopDetected: vi.fn().mockResolvedValue(false),
    });
    const session = {
      dispose: vi.fn(),
    };

    detector.trackTask(task.id, session as any);
    vi.advanceTimersByTime(61_000);
    for (let i = 0; i < 80; i++) {
      detector.recordActivity(task.id);
    }

    await detector.killAndRetry(task.id, 60_000);

    expect(task.error).toContain("STUCK_LOOP_EXHAUSTED: incomplete task exhausted stuck kill budget");
    expect(task.status).toBe("failed");
    expect(task.column).toBe("todo");
    expect(task.paused).toBe(true);
    // FN-6252 / Move-Task contract: engine rebounds do not write userPaused,
    // so a never-user-paused task remains undefined while still not user-paused.
    expect(task.userPaused).not.toBe(true);
    expect(task.pausedReason).toBe("stuck-loop-exhausted-manual-intervention-required");
    expect(task.stuckKillCount).toBe(7);
    expect(task.steps).toEqual([{ name: "Implement", status: "in-progress" }]);
    expect(task.log?.some((entry) => entry.action.includes("Parked in todo with progress preserved"))).toBe(true);
    expect(store.handoffToReview).not.toHaveBeenCalled();
    expect(isRunnableQueuedOverlapCandidate(task, [task])).toBe(false);

    manager.stop();
  });
});

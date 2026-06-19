import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { Scheduler } from "../../scheduler.js";
import { SelfHealingManager } from "../../self-healing.js";
import * as branchConflictModule from "../../branch-conflicts.js";
import * as worktreePoolModule from "../../worktree-pool.js";

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

type MutableSettings = Settings & {
  autoMerge?: boolean;
  globalPause?: boolean;
  enginePaused?: boolean;
  dispatchOscillationSettleMs?: number;
};

function makeTask(rootDir: string, overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5941",
    title: "flapping",
    description: "test",
    column: "in-progress",
    branch: "fusion/fn-5941",
    worktree: join(rootDir, ".worktrees", "fn-5941"),
    paused: false,
    userPaused: false,
    checkedOutBy: undefined,
    dependencies: [],
    steps: [{ id: "s1", title: "step", status: "in-progress" } as any],
    currentStep: 1,
    log: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    columnMovedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    executionStartedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    ...overrides,
  } as Task;
}

function makeStore(rootDir: string, task: Task, settingsOverrides: Partial<MutableSettings> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    baseBranch: "main",
    mergeStrategy: "direct",
    autoRecovery: { mode: "deterministic-only", maxRetries: 3 },
    maxStuckKills: 6,
    ...settingsOverrides,
  } as unknown as Settings;

  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async (id: string) => (id === task.id ? task : null)),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (column === task.column ? [task] : [])),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"], opts?: Record<string, unknown>) => {
      task.column = column;
      (task as any).__lastMoveOpts = opts;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => settings),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    mergeTask: vi.fn(async () => undefined),
    handoffToReview: vi.fn(async () => task),
    getRootDir: vi.fn(() => rootDir),
  }) as unknown as TaskStore & EventEmitter;
}

function makeSchedulerStore(rootDir: string, task: Task, settingsOverrides: Partial<MutableSettings> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    maxConcurrent: 1,
    maxWorktrees: 10,
    groupOverlappingFiles: false,
    dispatchOscillationSettleMs: 5_000,
    worktreeNaming: "task-id",
    ...settingsOverrides,
  } as unknown as Settings;

  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async (id: string) => (id === task.id ? task : null)),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => {
      if (!column) return [task];
      return task.column === column ? [task] : [];
    }),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"], opts?: Record<string, unknown>) => {
      const from = task.column;
      task.column = column;
      task.columnMovedAt = new Date(Date.now()).toISOString();
      emitter.emit("task:moved", { task, from, to: column, source: (opts?.moveSource as "user" | "engine" | "scheduler" | undefined) ?? "engine" });
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => rootDir),
    getTasksDir: vi.fn(() => join(rootDir, ".fusion", "tasks")),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-5941 reliability interactions: todo/in-progress flapping", () => {
  let rootDir = "";

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    vi.spyOn(Scheduler.prototype as any, "validateTaskFilesystem").mockResolvedValue({ valid: true });
    rootDir = join(tmpdir(), `fn-5941-${Math.random().toString(36).slice(2)}`);
    mkdirSync(rootDir, { recursive: true });
    git(rootDir, "init -b main");
    git(rootDir, "config user.name 'Fusion'");
    git(rootDir, "config user.email 'hi@runfusion.ai'");
    writeFileSync(join(rootDir, "README.md"), "root\n");
    git(rootDir, "add README.md");
    git(rootDir, "commit -m 'init'");
    mkdirSync(join(rootDir, ".worktrees"), { recursive: true });
    mkdirSync(join(rootDir, ".worktrees", "fn-5941"), { recursive: true });
    vi.spyOn(worktreePoolModule, "isUsableTaskWorktree").mockResolvedValue(true);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({
      kind: "reclaimable",
      taskAttributedCommitCount: 1,
      strandedCommits: [{ sha: "c1", authorName: "a", subject: "s", timestamp: Date.now() }],
      livePath: join(rootDir, ".worktrees", "fn-5941"),
      tipSha: "abc123abc123abc123abc123abc123abc123abcd",
    } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  });

  it("does not requeue a genuinely executing in-progress task during resume-limbo reclaim", async () => {
    const task = makeTask(rootDir, {
      resumeLimboCount: 1,
      resumeLimboTipSha: "abc123abc123abc123abc123abc123abc123abcd",
      resumeLimboStepSignature: JSON.stringify({ currentStep: 1, steps: ["in-progress"] }),
      executionStartedAt: new Date(Date.now() - 30_000).toISOString(),
    });
    const store = makeStore(rootDir, task);
    const manager = new SelfHealingManager(store as any, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>([task.id]),
    } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(task.column).toBe("in-progress");
    expect(task.resumeLimboCount).toBe(1);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reclaim-self-owned-branch-conflict-no-action",
      target: task.id,
      metadata: expect.objectContaining({ reason: "executor-active" }),
    }));

    manager.stop();
  });

  it("defers resume-limbo reclaim when execution started within the grace window", async () => {
    const task = makeTask(rootDir, {
      resumeLimboCount: 1,
      resumeLimboTipSha: "abc123abc123abc123abc123abc123abc123abcd",
      resumeLimboStepSignature: JSON.stringify({ currentStep: 1, steps: ["in-progress"] }),
      executionStartedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const store = makeStore(rootDir, task);
    const manager = new SelfHealingManager(store as any, { rootDir } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reclaim-self-owned-branch-conflict-no-action",
      target: task.id,
      metadata: expect.objectContaining({ reason: "recent-execution-started" }),
    }));

    manager.stop();
  });

  it("does not requeue a task tracked by an active heartbeat run during resume-limbo reclaim", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-HEARTBEAT",
      resumeLimboCount: 1,
      resumeLimboTipSha: "abc123abc123abc123abc123abc123abc123abcd",
      resumeLimboStepSignature: JSON.stringify({ currentStep: 1, steps: ["in-progress"] }),
      executionStartedAt: new Date("2025-12-31T20:00:00.000Z").toISOString(),
    });
    const store = makeStore(rootDir, task);
    const agentStore = {
      listActiveHeartbeatRuns: vi.fn().mockResolvedValue([
        { startedAt: new Date().toISOString(), contextSnapshot: { taskId: task.id } },
      ]),
    };
    const manager = new SelfHealingManager(store as any, { rootDir, agentStore } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reclaim-self-owned-branch-conflict-no-action",
      target: task.id,
      metadata: expect.objectContaining({ reason: "active-heartbeat-run" }),
    }));

    manager.stop();
  });

  it("does not requeue an executor-active task when stuck-kill budget is exhausted", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-STUCK",
      stuckKillCount: 6,
      executionStartedAt: new Date(Date.now() - 15_000).toISOString(),
      steps: [{ id: "s1", title: "step", status: "in-progress" } as any],
      currentStep: 1,
    });
    const store = makeStore(rootDir, task, { maxStuckKills: 6 });
    const manager = new SelfHealingManager(store as any, {
      rootDir,
      getExecutingTaskIds: () => new Set<string>([task.id]),
    } as any);

    const allowedRetry = await manager.checkStuckBudget(task.id, "inactivity");

    expect(allowedRetry).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(task.column).toBe("in-progress");
    expect(task.stuckKillCount).toBe(6);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:stuck-loop-exhausted-no-action",
      target: task.id,
      metadata: expect.objectContaining({
        reason: "executor-active",
        attemptedStuckKillCount: 7,
        maxStuckKills: 6,
      }),
    }));

    manager.stop();
  });

  it("does not requeue a recent resume-limbo task when execution just started", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-RESUME",
      resumeLimboCount: 1,
      resumeLimboTipSha: "abc123abc123abc123abc123abc123abc123abcd",
      resumeLimboStepSignature: JSON.stringify({ currentStep: 1, steps: ["in-progress"] }),
      executionStartedAt: new Date(Date.now() - 15_000).toISOString(),
    });
    const store = makeStore(rootDir, task);
    const manager = new SelfHealingManager(store as any, { rootDir } as any);

    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(task.column).toBe("in-progress");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:reclaim-self-owned-branch-conflict-no-action",
      target: task.id,
      metadata: expect.objectContaining({ reason: "recent-execution-started" }),
    }));

    manager.stop();
  });

  it("parks a genuinely dead incomplete task when stuck-kill budget is exhausted", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-DEAD",
      stuckKillCount: 6,
      branch: undefined,
      worktree: join(rootDir, ".worktrees", "fn-5941-missing-dead"),
      executionStartedAt: new Date("2025-12-31T20:00:00.000Z").toISOString(),
      steps: [{ id: "s1", title: "step", status: "in-progress" } as any],
      currentStep: 1,
    });
    const store = makeStore(rootDir, task, { maxStuckKills: 6 });
    const manager = new SelfHealingManager(store as any, { rootDir } as any);

    const allowedRetry = await manager.checkStuckBudget(task.id, "inactivity");

    expect(allowedRetry).toBe(false);
    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", expect.objectContaining({
      preserveProgress: true,
      preserveStatus: true,
      moveSource: "engine",
      recoveryRehome: true,
    }));
    expect(task.column).toBe("todo");
    expect(task.stuckKillCount).toBe(7);
    expect(task.status).toBe("failed");
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("stuck-loop-exhausted-manual-intervention-required");
    expect(task.error).toContain("STUCK_LOOP_EXHAUSTED");
    expect(task.userPaused).not.toBe(true);

    manager.stop();
  });

  it("does not requeue an in-progress limbo candidate while a checkout lease is still live", async () => {
    const task = makeTask(rootDir, {
      branch: undefined,
      worktree: join(rootDir, ".worktrees", "fn-5941-missing"),
      checkedOutBy: "agent-123",
      executionStartedAt: new Date("2025-12-31T23:00:00.000Z").toISOString(),
      updatedAt: new Date("2025-12-31T23:00:00.000Z").toISOString(),
      columnMovedAt: new Date("2025-12-31T23:00:00.000Z").toISOString(),
      steps: [{ id: "s1", title: "step", status: "pending" } as any],
      currentStep: 1,
    });
    const store = makeStore(rootDir, task);
    const manager = new SelfHealingManager(store as any, { rootDir } as any);

    const recovered = await manager.recoverInProgressLimbo();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(task.column).toBe("in-progress");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:auto-recover-in-progress-limbo-no-action",
      target: task.id,
      metadata: expect.objectContaining({ reason: "checked-out-lease-active" }),
    }));

    manager.stop();
  });

  it("waits for the settle window before re-dispatching an engine-requeued todo task", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-SCHED",
      column: "todo",
      branch: undefined,
      worktree: undefined,
      steps: [],
      currentStep: 0,
      status: "queued",
      columnMovedAt: new Date().toISOString(),
    });
    const store = makeSchedulerStore(rootDir, task);
    const scheduler = new Scheduler(store as any);

    store.emit("task:moved", { task, from: "in-progress", to: "todo", source: "engine" });
    (scheduler as any).running = true;

    await scheduler.schedule();
    expect(store.moveTask).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_001);
    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith(task.id, "in-progress", expect.objectContaining({ moveSource: "scheduler" }));
  });

  it("auto-pauses a task once dispatch oscillation exceeds the threshold", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-BREAKER",
      column: "todo",
      branch: undefined,
      worktree: undefined,
      steps: [],
      currentStep: 0,
      status: "queued",
      dispatchStormCount: 5,
      lastDispatchAt: new Date(Date.now() - 1_000).toISOString(),
      columnMovedAt: new Date().toISOString(),
      error: undefined,
    });
    const store = makeSchedulerStore(rootDir, task, {
      dispatchOscillationThreshold: 5,
      dispatchOscillationWindowMs: 60_000,
    });
    const scheduler = new Scheduler(store as any);
    (scheduler as any).running = true;

    await scheduler.schedule();

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(task.paused).toBe(true);
    expect(task.pausedReason).toBe("dispatch-oscillation");
    expect(task.dispatchStormCount).toBe(6);
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:dispatch-oscillation-terminalized",
      target: task.id,
      metadata: expect.objectContaining({ cycleCount: 6, windowMs: 60_000 }),
    }));
  });

  it("keeps dispatching while oscillation count stays under the threshold", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-UNDER",
      column: "todo",
      branch: undefined,
      worktree: undefined,
      steps: [],
      currentStep: 0,
      status: "queued",
      dispatchStormCount: 1,
      lastDispatchAt: new Date(Date.now() - 1_000).toISOString(),
      columnMovedAt: new Date().toISOString(),
    });
    const store = makeSchedulerStore(rootDir, task, {
      dispatchOscillationThreshold: 5,
      dispatchOscillationWindowMs: 60_000,
    });
    const scheduler = new Scheduler(store as any);
    (scheduler as any).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith(task.id, "in-progress", expect.objectContaining({ moveSource: "scheduler" }));
    expect(task.dispatchStormCount).toBe(2);
    expect(task.paused).toBe(false);
  });

  it("resets the oscillation counter after the window ages out", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-AGED",
      column: "todo",
      branch: undefined,
      worktree: undefined,
      steps: [],
      currentStep: 0,
      status: "queued",
      dispatchStormCount: 4,
      lastDispatchAt: new Date(Date.now() - 120_000).toISOString(),
      columnMovedAt: new Date().toISOString(),
    });
    const store = makeSchedulerStore(rootDir, task, {
      dispatchOscillationThreshold: 5,
      dispatchOscillationWindowMs: 60_000,
    });
    const scheduler = new Scheduler(store as any);
    (scheduler as any).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith(task.id, "in-progress", expect.objectContaining({ moveSource: "scheduler" }));
    expect(task.dispatchStormCount).toBe(1);
  });

  it("resets dispatch oscillation state on forward transition to in-review", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-RESET-MOVE",
      column: "todo",
      branch: undefined,
      worktree: undefined,
      steps: [],
      currentStep: 0,
      dispatchStormCount: 3,
      lastDispatchAt: new Date().toISOString(),
    });
    const store = makeSchedulerStore(rootDir, task);
    const scheduler = new Scheduler(store as any);

    store.emit("task:moved", { task, from: "todo", to: "in-review", source: "engine" });
    await Promise.resolve();

    expect(task.dispatchStormCount).toBeNull();
    expect(task.lastDispatchAt).toBeNull();
    expect((scheduler as any).recentEngineTodoRequeues.has(task.id)).toBe(false);
  });

  it("resets dispatch oscillation state on manual unpause", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-RESET-UNPAUSE",
      column: "todo",
      branch: undefined,
      worktree: undefined,
      steps: [],
      currentStep: 0,
      paused: true,
      userPaused: false,
      dispatchStormCount: 4,
      lastDispatchAt: new Date().toISOString(),
    });
    const store = makeSchedulerStore(rootDir, task);
    new Scheduler(store as any);

    store.emit("task:updated", task);
    task.paused = false;
    store.emit("task:updated", task);
    await Promise.resolve();

    expect(task.dispatchStormCount).toBeNull();
    expect(task.lastDispatchAt).toBeNull();
  });

  it("clears the settle-window guard when the task is deleted", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-DELETE",
      column: "todo",
      branch: undefined,
      worktree: undefined,
      steps: [],
      currentStep: 0,
      status: "queued",
      columnMovedAt: new Date().toISOString(),
    });
    const store = makeSchedulerStore(rootDir, task);
    const scheduler = new Scheduler(store as any);

    store.emit("task:moved", { task, from: "in-progress", to: "todo", source: "engine" });
    store.emit("task:deleted", task);
    (scheduler as any).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith(task.id, "in-progress", expect.objectContaining({ moveSource: "scheduler" }));
  });

  it("does not delay a user-moved todo task with the settle-window guard", async () => {
    const task = makeTask(rootDir, {
      id: "FN-5941-USER",
      column: "todo",
      branch: undefined,
      worktree: undefined,
      steps: [],
      currentStep: 0,
      status: "queued",
      columnMovedAt: new Date().toISOString(),
    });
    const store = makeSchedulerStore(rootDir, task);
    const scheduler = new Scheduler(store as any);

    store.emit("task:moved", { task, from: "in-progress", to: "todo", source: "engine" });
    task.columnMovedAt = new Date().toISOString();
    store.emit("task:moved", { task, from: "in-progress", to: "todo", source: "user" });
    (scheduler as any).running = true;

    await scheduler.schedule();

    expect(store.moveTask).toHaveBeenCalledWith(task.id, "in-progress", expect.objectContaining({ moveSource: "scheduler" }));
  });
});

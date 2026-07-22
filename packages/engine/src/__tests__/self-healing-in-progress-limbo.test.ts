import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

const { logger } = vi.hoisted(() => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => logger),
  schedulerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../worktree/worktree-pool.js", () => ({
  WorktreePool: vi.fn(),
  RemovalReason: {
    HardCancel: "hard-cancel",
    ExecutorTransientRetry: "executor-transient-retry",
    ExecutorStuckKilled: "executor-stuck-killed",
    ExecutorDispose: "executor-dispose",
    StepSessionCleanup: "step-session-cleanup",
    MergerPostMerge: "merger-post-merge",
    MergerCleanup: "merger-cleanup",
    SelfHealingReclaim: "self-healing-reclaim",
    SelfHealingStaleActiveBranch: "self-healing-stale-active-branch",
    SelfHealingBranchConflict: "self-healing-branch-conflict",
    SelfHealingIdleSweep: "self-healing-idle-sweep",
    PoolPrune: "pool-prune",
  },
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  resolveWorktreeBackend: vi.fn(),
}));

vi.mock("../merger.js", () => ({ classifyOwnedLandedEvidence: vi.fn() }));

import { existsSync } from "node:fs";
import { SelfHealingManager } from "../self-healing.js";
import type { Settings, Task, TaskStore } from "@fusion/core";

function createMockStore(overrides: Record<string, unknown> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({
      autoMerge: true,
      globalPause: false,
      enginePaused: false,
      maintenanceIntervalMs: 0,
    } as unknown as Settings),
    listTasks: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue({} as Task),
    logEntry: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
    ...overrides,
  }) as unknown as TaskStore & EventEmitter;
}

describe("recoverInProgressLimbo", () => {
  let store: TaskStore & EventEmitter;

  const baseTask = {
    id: "FN-5149",
    column: "in-progress",
    paused: false,
    branch: null,
    worktree: "/tmp/test-project/.worktrees/missing-fn-5149",
    checkedOutBy: "agent-1",
    executionStartedAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    steps: [{ status: "pending" }, { status: "pending" }],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:05:00.000Z"));
    vi.mocked(existsSync).mockImplementation(() => false);
    store = createMockStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("requeues FN-5149-signature limbo tasks to todo with audit telemetry", async () => {
    const reconcileLeaseRow = vi.fn().mockResolvedValue(undefined);
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([baseTask]);

    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
      leaseManager: {
        recoverAbandonedLease: vi.fn().mockResolvedValue(true),
        reconcileLeaseRow,
      } as any,
    });

    const recovered = await manager.recoverInProgressLimbo();

    expect(recovered).toBe(1);
    expect(reconcileLeaseRow).toHaveBeenCalledWith("FN-5149");
    expect(store.updateTask).toHaveBeenCalledWith("FN-5149", expect.objectContaining({
      worktree: null,
      branch: null,
      status: null,
      error: null,
      checkedOutBy: null,
      executionStartedAt: null,
      worktreeSessionRetryCount: null,
      taskDoneRetryCount: null,
      sessionFile: null,
    }));
    expect(store.moveTask).toHaveBeenCalledWith("FN-5149", "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      domain: "database",
      mutationType: "task:auto-recover-in-progress-limbo",
      target: "FN-5149",
    }));
  });

  it("skips tasks whose worktree still exists on disk", async () => {
    vi.mocked(existsSync).mockImplementation((path) => path === baseTask.worktree);
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([baseTask]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverInProgressLimbo();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("skips tasks whose branch is still set", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...baseTask, branch: "fusion/fn-5149" }]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverInProgressLimbo();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("skips tasks currently claimed by the executor", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([baseTask]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(["FN-5149"]),
    });

    const recovered = await manager.recoverInProgressLimbo();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("skips paused tasks", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...baseTask, paused: true }]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverInProgressLimbo();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("skips tasks still within the grace window", async () => {
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([{ ...baseTask, updatedAt: "2026-05-20T12:04:30.000Z" }]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverInProgressLimbo();

    expect(recovered).toBe(0);
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("skips entirely when the engine is globally paused", async () => {
    store = createMockStore({
      getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: true, enginePaused: false } as unknown as Settings),
    });
    (store.listTasks as ReturnType<typeof vi.fn>).mockResolvedValue([baseTask]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverInProgressLimbo();

    expect(recovered).toBe(0);
    expect(store.listTasks).not.toHaveBeenCalled();
  });
});

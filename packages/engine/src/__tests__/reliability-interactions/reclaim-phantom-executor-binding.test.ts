import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager, STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS } from "../../self-healing.js";
import { activeSessionRegistry } from "../../active-session-registry.js";
import * as branchConflictModule from "../../branch-conflicts.js";
import * as worktreePoolModule from "../../worktree-pool.js";

type AuditRow = { timestamp: string };

type Harness = {
  rootDir: string;
  worktree: string;
  task: Task;
  store: TaskStore & EventEmitter;
  clearPhantomExecutorBinding: ReturnType<typeof vi.fn>;
  manager: SelfHealingManager;
  cleanup: () => void;
};

const NOW = new Date("2026-06-19T12:00:00.000Z");
const OLD_EXECUTION_STARTED_AT = new Date(NOW.getTime() - STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS * 9.5).toISOString();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-6736",
    title: "phantom binding",
    description: "test",
    column: "in-progress",
    branch: "fusion/fn-6736",
    worktree: "/tmp/fn-6736/.worktrees/crisp-lotus",
    paused: false,
    userPaused: false,
    checkedOutBy: undefined,
    dependencies: [],
    steps: [{ id: "s1", title: "step", status: "in-progress" } as any],
    currentStep: 5,
    log: [],
    createdAt: new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString(),
    updatedAt: new Date(NOW.getTime() - 90 * 60_000).toISOString(),
    executionStartedAt: OLD_EXECUTION_STARTED_AT,
    ...overrides,
  } as Task;
}

function makeStore(task: Task, options: { recentAuditRows?: AuditRow[] } = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    baseBranch: "main",
    mergeStrategy: "direct",
    autoRecovery: { mode: "deterministic-only", maxRetries: 3 },
  } as unknown as Settings;

  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn(async () => task),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => (column === task.column ? [task] : [])),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"], opts?: Record<string, unknown>) => {
      task.column = column;
      (task as any).__lastMoveOpts = opts;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => settings),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getRunAuditEvents: vi.fn(() => options.recentAuditRows ?? []),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/test"),
  }) as unknown as TaskStore & EventEmitter;
}

function makeHarness(overrides: Partial<Task> = {}, options: {
  recentAuditRows?: AuditRow[];
  activeHeartbeat?: boolean;
  missingWorktree?: boolean;
} = {}): Harness {
  const rootDir = mkdtempSync(join(tmpdir(), "fn-6736-"));
  const worktree = join(rootDir, ".worktrees", "crisp-lotus");
  if (!options.missingWorktree) {
    mkdirSync(worktree, { recursive: true });
  }
  const task = makeTask({ worktree, ...overrides });
  const store = makeStore(task, { recentAuditRows: options.recentAuditRows });
  const clearPhantomExecutorBinding = vi.fn();
  const agentStore = options.activeHeartbeat
    ? { listActiveHeartbeatRuns: vi.fn(async () => [{ startedAt: new Date(NOW.getTime() - 60_000).toISOString(), contextSnapshot: { taskId: task.id } }]) }
    : { listActiveHeartbeatRuns: vi.fn(async () => []) };
  const manager = new SelfHealingManager(store as any, {
    rootDir,
    getExecutingTaskIds: () => new Set([task.id]),
    clearPhantomExecutorBinding,
    agentStore,
  } as any);
  return {
    rootDir,
    worktree,
    task,
    store,
    clearPhantomExecutorBinding,
    manager,
    cleanup: () => {
      manager.stop();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function findAudit(store: TaskStore & EventEmitter, mutationType: string): any | undefined {
  return (store.recordRunAuditEvent as any).mock.calls.find((call: any[]) => call[0].mutationType === mutationType)?.[0];
}

describe("FN-6736: phantom executor binding reclaim", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.restoreAllMocks();
    activeSessionRegistry.clear();
    vi.spyOn(worktreePoolModule, "isUsableTaskWorktree").mockResolvedValue(true);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({ kind: "stale" } as any);
  });

  afterEach(() => {
    activeSessionRegistry.clear();
    vi.useRealTimers();
  });

  it("requeues an old in-progress task when executor-active is only a phantom binding", async () => {
    const h = makeHarness();
    expect(existsSync(h.worktree)).toBe(true);

    const recovered = await h.manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(1);
    expect(h.clearPhantomExecutorBinding).toHaveBeenCalledWith(h.task.id, { preserveWorktrees: true });
    expect(h.store.moveTask).toHaveBeenCalledWith(h.task.id, "todo", expect.objectContaining({
      moveSource: "engine",
      recoveryRehome: true,
      preserveProgress: true,
      preserveWorktree: true,
    }));
    expect(h.task.column).toBe("todo");
    expect(h.task.userPaused).toBe(false);
    expect(h.task.paused).toBe(false);
    expect((h.task as any).status).not.toBe("failed");
    expect(findAudit(h.store, "task:reclaim-self-owned-branch-conflict-no-action")).toBeUndefined();
    const event = findAudit(h.store, "task:reclaim-phantom-executor-binding");
    expect(event).toBeTruthy();
    expect(event.metadata).toEqual(expect.objectContaining({
      taskId: h.task.id,
      signalReason: "executor-active",
      checkedOutBy: null,
      agentPresent: false,
      lastActivityMs: null,
      worktree: h.worktree,
      branch: h.task.branch,
      worktreeExists: true,
    }));
    expect(event.metadata.executionAgeMs).toBeGreaterThan(STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS * 3);
    h.cleanup();
  });

  it("keeps FN-4811 protection when recent run-audit activity proves a live owner", async () => {
    const h = makeHarness({}, { recentAuditRows: [{ timestamp: new Date(NOW.getTime() - 60_000).toISOString() }] });

    await h.manager.reclaimSelfOwnedBranchConflicts();

    expect(h.clearPhantomExecutorBinding).not.toHaveBeenCalled();
    expect(h.store.moveTask).not.toHaveBeenCalled();
    expect(findAudit(h.store, "task:reclaim-phantom-executor-binding")).toBeUndefined();
    expect(findAudit(h.store, "task:reclaim-self-owned-branch-conflict-no-action")?.metadata).toEqual(expect.objectContaining({ reason: "executor-active" }));
    expect(h.task.column).toBe("in-progress");
    h.cleanup();
  });

  it("keeps FN-4811 protection when checkedOutBy is set", async () => {
    const h = makeHarness({ checkedOutBy: "agent-1" } as Partial<Task>);

    await h.manager.reclaimSelfOwnedBranchConflicts();

    expect(h.clearPhantomExecutorBinding).not.toHaveBeenCalled();
    expect(h.store.moveTask).not.toHaveBeenCalled();
    expect(findAudit(h.store, "task:reclaim-self-owned-branch-conflict-no-action")?.metadata).toEqual(expect.objectContaining({ reason: "executor-active" }));
    h.cleanup();
  });

  it("keeps FN-4811 protection when an active heartbeat row exists", async () => {
    const h = makeHarness({}, { activeHeartbeat: true });

    await h.manager.reclaimSelfOwnedBranchConflicts();

    expect(h.clearPhantomExecutorBinding).not.toHaveBeenCalled();
    expect(h.store.moveTask).not.toHaveBeenCalled();
    expect(findAudit(h.store, "task:reclaim-self-owned-branch-conflict-no-action")?.metadata).toEqual(expect.objectContaining({ reason: "executor-active" }));
    h.cleanup();
  });

  it("protects tasks just past grace but below the phantom age multiplier", async () => {
    const h = makeHarness({
      executionStartedAt: new Date(NOW.getTime() - STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS - 1_000).toISOString(),
    });

    await h.manager.reclaimSelfOwnedBranchConflicts();

    expect(h.clearPhantomExecutorBinding).not.toHaveBeenCalled();
    expect(h.store.moveTask).not.toHaveBeenCalled();
    expect(findAudit(h.store, "task:reclaim-self-owned-branch-conflict-no-action")?.metadata).toEqual(expect.objectContaining({ reason: "executor-active" }));
    h.cleanup();
  });

  it("does not double-handle missing worktrees owned by FN-5219 in-progress limbo recovery", async () => {
    const h = makeHarness({}, { missingWorktree: true });
    expect(existsSync(h.worktree)).toBe(false);

    await h.manager.reclaimSelfOwnedBranchConflicts();

    expect(h.clearPhantomExecutorBinding).not.toHaveBeenCalled();
    expect(h.store.moveTask).not.toHaveBeenCalled();
    expect(findAudit(h.store, "task:reclaim-self-owned-branch-conflict-no-action")?.metadata).toEqual(expect.objectContaining({ reason: "executor-active" }));
    h.cleanup();
  });

  it("does not increment FN-5704 resume-limbo counters on the phantom-binding requeue", async () => {
    const h = makeHarness({ resumeLimboCount: 1 } as Partial<Task>);

    await h.manager.reclaimSelfOwnedBranchConflicts();
    await h.manager.reclaimSelfOwnedBranchConflicts();

    expect(h.store.moveTask).toHaveBeenCalledTimes(1);
    expect(h.task.resumeLimboCount).toBe(1);
    expect(findAudit(h.store, "task:resume-limbo-escalated")).toBeUndefined();
    h.cleanup();
  });
});

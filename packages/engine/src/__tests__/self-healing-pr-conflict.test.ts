import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { AutoRecoveryDispatcher } from "../auto-recovery.js";
import * as branchConflicts from "../branch-conflicts.js";
import * as worktreePool from "../worktree-pool.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4763",
    title: "task",
    description: "task",
    column: "in-progress",
    branch: "fusion/fn-4763",
    worktree: "/tmp/test/.worktrees/fn-4763",
    paused: false,
    userPaused: false,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    prInfo: { url: "u", number: 1, status: "open", title: "t", headBranch: "h", baseBranch: "b", commentCount: 0, mergeable: "conflicting" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeStore(task: Task, paused = false): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = { globalPause: paused, enginePaused: false, autoRecovery: { mode: "deterministic-only", maxRetries: 3 } } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn((id: string) => (id === task.id ? task : null)),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => {
      if (!column) return [task];
      if (column === "in-progress") return [task];
      return [];
    }),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      task.column = column;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    getRootDir: vi.fn(() => "/tmp/test"),
  }) as unknown as TaskStore & EventEmitter;
}

describe("SelfHealingManager.reclaimPrConflictForTask", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  it("returns stale-resolved when inspection reports stale-resolved", async () => {
    const task = makeTask();
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "stale-resolved" } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result.outcome).toBe("stale-resolved");
    expect(task.branch).toBeNull();
  });

  it("skips user-paused task", async () => {
    const task = makeTask({ userPaused: true });
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "user-paused" });
  });

  it("delegates tip-already-merged through reclaim sweep", async () => {
    const task = makeTask();
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "tip-already-merged", livePath: null, tipSha: "abc123", integrationRef: "main" } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const sweepSpy = vi.spyOn(manager, "reclaimSelfOwnedBranchConflicts").mockResolvedValue(1);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result.outcome).toBe("tip-already-merged");
    expect(sweepSpy).toHaveBeenCalled();
  });

  it("returns paused-unrecoverable when conflict is unrecoverable and dispatcher pauses", async () => {
    const task = makeTask();
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "live-foreign", error: new Error("unrecoverable") } as any);
    vi.spyOn(AutoRecoveryDispatcher.prototype, "dispatch").mockResolvedValue({ action: "pause", reason: "test" } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result.outcome).toBe("paused-unrecoverable");
    expect((store.updateTask as any).mock.calls.some((c: any[]) => c[1]?.pausedReason === "branch-conflict-unrecoverable")).toBe(true);
  });

  it("skips worktrunk operation failed paused tasks", async () => {
    const task = makeTask({ pausedReason: "worktrunk_operation_failed" as any });
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "worktrunk-paused" });
  });

  it("skips when global pause is active", async () => {
    const task = makeTask();
    const store = makeStore(task, true);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "engine-paused" });
  });
});

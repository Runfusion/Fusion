import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import * as branchConflicts from "../execution/branch-conflicts.js";
import * as worktreePool from "../worktree/worktree-pool.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";

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

function makeStore(
  task: Task | null,
  paused = false,
  enginePaused = false,
  settingsOverrides: Partial<Settings> = {},
): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = {
    globalPause: paused,
    enginePaused,
    autoRecovery: { mode: "deterministic-only", maxRetries: 3 },
    ...settingsOverrides,
  } as Settings;
  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
    getTask: vi.fn((id: string) => (task && id === task.id ? task : null)),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => {
      if (!task) return [];
      if (!column) return [task];
      if (column === "in-progress") return [task];
      return [];
    }),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => (task ? Object.assign(task, updates) : null)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      if (!task) return null;
      task.column = column;
      return task;
    }),
    handoffToReview: vi.fn(async (id: string) => {
      if (!task || id !== task.id) return null;
      task.column = "in-review";
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
    activeSessionRegistry.clear();
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

  it("returns reclaimed for reclaimable conflicts", async () => {
    const task = makeTask({ column: "in-review", paused: true, pausedReason: "branch-conflict-unrecoverable" as any, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "reclaimable", livePath: task.worktree, tipSha: "abc123", taskAttributedCommitCount: 1, strandedCommits: [{ sha: "abc123" }] } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result.outcome).toBe("reclaimed");
    expect((store.moveTask as any).mock.calls.some((c: any[]) => c[1] === "todo")).toBe(true);
  });

  it("returns reclaimed for fully-subsumed conflicts", async () => {
    const task = makeTask({ branch: "feature/non-fusion-branch" });
    const store = makeStore(task);
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValue({ kind: "fully-subsumed", livePath: task.worktree, tipSha: "abc123", taskAttributedCommitCount: 0, strandedCommits: [] } as any);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result.outcome).toBe("reclaimed");
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

  it("skips when engine pause is active", async () => {
    const task = makeTask();
    const store = makeStore(task, false, true);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "engine-paused" });
  });

  it("skips when global pause is active", async () => {
    const task = makeTask();
    const store = makeStore(task, true);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "engine-paused" });
  });

  it("returns task-not-found for missing task", async () => {
    const store = makeStore(null);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask("FN-404");
    expect(result).toEqual({ outcome: "skipped", reason: "task-not-found" });
  });

  it("skips when branch or worktree is missing", async () => {
    const task = makeTask({ branch: undefined });
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "missing-branch-or-worktree" });
  });

  it("skips checked out tasks", async () => {
    const task = makeTask({ checkedOutBy: "agent-1" as any });
    const store = makeStore(task);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "checked-out" });
  });

  it("only sweeps tasks marked as conflicting", async () => {
    const task = makeTask({ prInfo: { ...makeTask().prInfo!, mergeable: "clean" } as any });
    const store = makeStore(task, false, false, { worktrunk: { enabled: true } as any });
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const reclaimSpy = vi.spyOn(manager, "reclaimPrConflictForTask");
    const reclaimed = await manager.reclaimPrConflicts();
    expect(reclaimed).toBe(0);
    expect(reclaimSpy).not.toHaveBeenCalled();
  });

  it("skips when worktree has an active session", async () => {
    const task = makeTask();
    const store = makeStore(task);
    activeSessionRegistry.registerPath(task.worktree!, { taskId: task.id, kind: "executor", ownerKey: task.id });
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "active-session" });
    activeSessionRegistry.clear();
  });

  it("skips unusable worktree", async () => {
    const task = makeTask();
    const store = makeStore(task);
    vi.spyOn(worktreePool, "isUsableTaskWorktree").mockResolvedValueOnce(false);
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const result = await manager.reclaimPrConflictForTask(task.id);
    expect(result).toEqual({ outcome: "skipped", reason: "unusable-worktree" });
  });
});

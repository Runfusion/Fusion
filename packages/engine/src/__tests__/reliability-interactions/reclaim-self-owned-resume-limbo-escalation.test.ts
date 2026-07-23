import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import * as branchConflictModule from "../../execution/branch-conflicts.js";
import * as worktreePoolModule from "../../worktree/worktree-pool.js";

type MutableSettings = Settings & {
  autoMerge?: boolean;
  globalPause?: boolean;
  enginePaused?: boolean;
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5704",
    title: "resume limbo",
    description: "test",
    column: "in-progress",
    branch: "fusion/fn-5704",
    worktree: "/tmp/test/.worktrees/fn-5704",
    paused: false,
    userPaused: false,
    checkedOutBy: undefined,
    dependencies: [],
    steps: [{ id: "s1", title: "step", status: "in-progress" } as any],
    currentStep: 1,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    executionStartedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    ...overrides,
  } as Task;
}

function makeStore(task: Task, settingsOverrides: Partial<MutableSettings> = {}): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const settings = {
    autoMerge: true,
    globalPause: false,
    enginePaused: false,
    baseBranch: "main",
    mergeStrategy: "direct",
    autoRecovery: { mode: "deterministic-only", maxRetries: 3 },
    ...settingsOverrides,
  } as unknown as Settings;

  return Object.assign(emitter, {
    getSettings: vi.fn(async () => settings),
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
    getRootDir: vi.fn(() => "/tmp/test"),
  }) as unknown as TaskStore & EventEmitter;
}

describe("FN-5704: reclaim self-owned resume limbo escalation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(worktreePoolModule, "isUsableTaskWorktree").mockResolvedValue(true);
  });

  it("escalates frozen in-progress reclaim/resume loops to todo with preserve flags and audit event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
    const task = makeTask();
    const store = makeStore(task);
    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({
      kind: "reclaimable",
      taskAttributedCommitCount: 1,
      strandedCommits: [{ sha: "c1", authorName: "a", subject: "s", timestamp: Date.now() }],
      livePath: task.worktree,
      tipSha: "abc123abc123abc123abc123abc123abc123abcd",
    } as any);

    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    await manager.reclaimSelfOwnedBranchConflicts();
    expect(task.resumeLimboCount).toBe(0);
    expect((store.moveTask as any).mock.calls.length).toBe(0);

    await manager.reclaimSelfOwnedBranchConflicts();
    expect(task.resumeLimboCount).toBe(1);
    await manager.reclaimSelfOwnedBranchConflicts();

    expect(store.moveTask).toHaveBeenCalledWith(task.id, "todo", expect.objectContaining({
      moveSource: "engine",
      preserveWorktree: true,
      preserveProgress: true,
      preserveResumeState: true,
    }));
    expect(task.resumeLimboCount).toBe(0);
    const limboEvent = (store.recordRunAuditEvent as any).mock.calls.find((call: any[]) => call[0].mutationType === "task:resume-limbo-escalated")?.[0];
    expect(limboEvent).toBeTruthy();
    expect(limboEvent.target).toBe(task.id);
    expect(limboEvent.metadata).toEqual(expect.objectContaining({
      taskId: task.id,
      frozenTipSha: "abc123abc123abc123abc123abc123abc123abcd",
      resumeAttemptCount: 2,
      currentStep: 1,
    }));
    const auditMetadata = limboEvent.metadata;
    expect(auditMetadata.idleMs).toBeGreaterThan(0);

    vi.useRealTimers();
    manager.stop();
  });

  it("resets limbo counter on progress and avoids escalation", async () => {
    const task = makeTask();
    const store = makeStore(task);
    const inspect = vi.spyOn(branchConflictModule, "inspectBranchConflict");
    inspect.mockResolvedValueOnce({ kind: "reclaimable", taskAttributedCommitCount: 1, strandedCommits: [{ sha: "c1", authorName: "a", subject: "s", timestamp: Date.now() }], livePath: task.worktree, tipSha: "sha-1" } as any);
    inspect.mockResolvedValueOnce({ kind: "reclaimable", taskAttributedCommitCount: 1, strandedCommits: [{ sha: "c1", authorName: "a", subject: "s", timestamp: Date.now() }], livePath: task.worktree, tipSha: "sha-1" } as any);
    inspect.mockResolvedValueOnce({ kind: "reclaimable", taskAttributedCommitCount: 1, strandedCommits: [{ sha: "c2", authorName: "a", subject: "s", timestamp: Date.now() }], livePath: task.worktree, tipSha: "sha-2" } as any);
    inspect.mockResolvedValueOnce({ kind: "reclaimable", taskAttributedCommitCount: 1, strandedCommits: [{ sha: "c2", authorName: "a", subject: "s", timestamp: Date.now() }], livePath: task.worktree, tipSha: "sha-2" } as any);

    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    await manager.reclaimSelfOwnedBranchConflicts();
    await manager.reclaimSelfOwnedBranchConflicts();
    expect(task.resumeLimboCount).toBe(1);
    await manager.reclaimSelfOwnedBranchConflicts();
    expect(task.resumeLimboCount).toBe(0);
    await manager.reclaimSelfOwnedBranchConflicts();
    expect(task.resumeLimboCount).toBe(1);
    expect(store.moveTask).not.toHaveBeenCalled();

    manager.stop();
  });

  it("never escalates user-paused tasks", async () => {
    const task = makeTask({ userPaused: true });
    const store = makeStore(task);
    const inspectSpy = vi.spyOn(branchConflictModule, "inspectBranchConflict");

    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    await manager.reclaimSelfOwnedBranchConflicts();

    expect(inspectSpy).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    manager.stop();
  });

  it("short-circuits reclaim when autoMerge is false", async () => {
    const task = makeTask();
    const store = makeStore(task, { autoMerge: false });
    const inspectSpy = vi.spyOn(branchConflictModule, "inspectBranchConflict");

    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    manager.stop();
  });
});

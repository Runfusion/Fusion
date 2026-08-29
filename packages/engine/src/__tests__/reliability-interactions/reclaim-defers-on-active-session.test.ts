/**
 * FN-4811 follow-up (FN-4819): the `reclaimSelfOwnedBranchConflicts` sweep must NOT
 * try to remove a worktree that is currently bound to a live executor/merger/step
 * session. Production failure shape on FN-4819:
 *
 *   1. Self-healing sweep runs, sees task.branch tip is already on main.
 *   2. Sweep calls `removeWorktree({ reason: SelfHealingBranchConflict })`.
 *   3. Active-session gate refuses (FN-4811): worktree is bound to FN-4819/executor.
 *   4. The thrown `ActiveSessionWorktreeRemovalError` is caught by the outer
 *      reclaim catch and escalated to `AutoRecoveryDispatcher` with class
 *      `branch-conflict-unrecoverable`.
 *   5. The dispatcher's decision.action === "pause" marks the task `failed + paused +
 *      pausedReason="branch-conflict-unrecoverable"`, even though the executor was
 *      actively making real progress.
 *
 * Fix: at the top of the per-task loop, skip tasks whose worktree is currently in
 * the activeSessionRegistry. The reclaim will retry on the next sweep when the
 * session is no longer holding the worktree.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import * as branchConflictModule from "../../execution/branch-conflicts.js";
import * as worktreePoolModule from "../../worktree/worktree-pool.js";

function makeStore(task: Task): TaskStore & EventEmitter {
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
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) =>
      column === "in-progress" ? [task] : [],
    ),
    updateTask: vi.fn(async (_id: string, updates: Partial<Task>) => Object.assign(task, updates)),
    moveTask: vi.fn(async (_id: string, column: Task["column"]) => {
      task.column = column;
      return task;
    }),
    logEntry: vi.fn(async () => undefined),
    appendAgentLog: vi.fn(async () => undefined),
    updateSettings: vi.fn(async () => settings),
    clearStaleExecutionStartBranchReferences: vi.fn(() => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    walCheckpoint: vi.fn(() => ({ busy: 0, log: 0, checkpointed: 0 })),
    archiveTaskAndCleanup: vi.fn(async () => ({})),
    mergeTask: vi.fn(async () => undefined),
    getRootDir: vi.fn(() => "/tmp/test"),
  }) as unknown as TaskStore & EventEmitter;
}

function makeActiveTask(): Task {
  return {
    id: "FN-4819",
    title: "test",
    description: "test",
    column: "in-progress",
    branch: "fusion/fn-4819",
    worktree: "/tmp/test/.worktrees/lemon-panda",
    paused: false,
    userPaused: false,
    checkedOutBy: undefined,
    pausedReason: undefined,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as Task;
}

describe("FN-4811 follow-up (FN-4819): reclaim defers when worktree has active session", () => {
  beforeEach(() => {
    activeSessionRegistry.clear();
    vi.restoreAllMocks();
  });

  it("skips the reclaim attempt entirely for a task whose worktree is in activeSessionRegistry", async () => {
    const task = makeActiveTask();
    const store = makeStore(task);
    // Register the worktree as belonging to a live executor session — exactly the
    // FN-4819 production shape.
    activeSessionRegistry.registerPath(task.worktree!, {
      taskId: task.id,
      kind: "executor",
      ownerKey: task.id,
    });

    // The inspection mock would normally classify the conflict and trigger removal —
    // it must NOT be invoked, because the gate at the top of the loop skips this task.
    const inspectSpy = vi.spyOn(branchConflictModule, "inspectBranchConflict");
    const removeSpy = vi.spyOn(worktreePoolModule, "removeWorktree");
    // isUsableTaskWorktree is also called after the active-session gate; spying lets us
    // confirm we never even reach it.
    const usableSpy = vi.spyOn(worktreePoolModule, "isUsableTaskWorktree");

    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    const recovered = await manager.reclaimSelfOwnedBranchConflicts();

    expect(recovered).toBe(0);
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(usableSpy).not.toHaveBeenCalled();

    // Task must NOT have been marked failed + paused by the (skipped) auto-recovery
    // dispatcher. This is the user-visible regression on FN-4819.
    expect(task.column).toBe("in-progress");
    expect((task as any).paused).toBe(false);
    expect((task as any).pausedReason).toBeUndefined();
    expect((task as any).status).not.toBe("failed");

    // The skip should be logged for observability.
    // (We don't assert the exact log shape — the production logger isn't mocked here —
    // but the absence of any `moveTask` to in-review / `updateTask` with status=failed
    // is the user-visible contract.)
    const updateCalls = (store.updateTask as any).mock.calls;
    expect(
      updateCalls.some((c: any[]) => c[1] && (c[1].status === "failed" || c[1].paused === true)),
    ).toBe(false);
    const moveCalls = (store.moveTask as any).mock.calls;
    expect(moveCalls.some((c: any[]) => c[1] === "in-review")).toBe(false);

    manager.stop();
    activeSessionRegistry.clear();
  });

  it("DOES proceed with reclaim when no session is registered for the worktree (control)", async () => {
    const task = makeActiveTask();
    const store = makeStore(task);
    // Note: NOT registering the path \u2014 reclaim should proceed and reach inspectBranchConflict.

    vi.spyOn(branchConflictModule, "inspectBranchConflict").mockResolvedValue({
      kind: "stale",
    } as any);
    // Force usable so the gate that follows doesn't also skip us.
    vi.spyOn(worktreePoolModule, "isUsableTaskWorktree").mockResolvedValue(true);

    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/test" } as any);
    await manager.reclaimSelfOwnedBranchConflicts();

    // With "stale" inspection, the sweep `continue`s without modification, but inspection IS reached.
    expect(branchConflictModule.inspectBranchConflict).toHaveBeenCalled();

    manager.stop();
  });
});

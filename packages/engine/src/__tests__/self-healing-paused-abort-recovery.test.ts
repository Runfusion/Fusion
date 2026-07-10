import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const { logger } = vi.hoisted(() => ({ logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => logger),
  schedulerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../worktree-pool.js", () => ({
  WorktreePool: vi.fn(),
  RemovalReason: {},
  scanIdleWorktrees: vi.fn().mockResolvedValue([]),
  cleanupOrphanedWorktrees: vi.fn().mockResolvedValue(0),
  isUsableTaskWorktree: vi.fn().mockResolvedValue(true),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  resolveWorktreeBackend: vi.fn(),
}));

vi.mock("../merger.js", () => ({ classifyOwnedLandedEvidence: vi.fn() }));

import { SelfHealingManager } from "../self-healing.js";
import type { Settings, Task, TaskStore } from "@fusion/core";

const PARK_ERROR =
  "Workflow graph failure surfaced after paused engine abort during pause/resume in 'todo' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task";
const IN_REVIEW_PARK_ERROR =
  "Workflow graph failure surfaced after paused engine abort during pause/resume in 'in-review' at node 'execute' — operator action required; retry or explicitly unpause/resume after inspecting the task";
const MANUAL_HOLD_PARK_ERROR =
  "Workflow graph failure surfaced after paused engine abort during pause/resume in 'in-review' at node 'merge-manual-hold' — operator action required; retry or explicitly unpause/resume after inspecting the task";
const DONE_STEPS = [{ status: "done" }, { status: "done" }];

function createMockStore(tasks: Task[]): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return Object.assign(emitter, {
    getSettings: vi.fn().mockResolvedValue({
      autoMerge: true,
      globalPause: false,
      enginePaused: false,
      maintenanceIntervalMs: 0,
    } as unknown as Settings),
    listTasks: vi.fn().mockResolvedValue(tasks),
    getTask: vi.fn(async (id: string) => byId.get(id) ?? null),
    updateTask: vi.fn().mockResolvedValue({} as Task),
    logEntry: vi.fn().mockResolvedValue(undefined),
    moveTask: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue("/tmp/test-project"),
  }) as unknown as TaskStore & EventEmitter;
}

function parkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-7000",
    column: "todo",
    paused: false,
    userPaused: false,
    status: "failed",
    error: PARK_ERROR,
    steps: [{ status: "pending" }],
    title: "parked task",
    ...overrides,
  } as unknown as Task;
}

describe("recoverPausedAbortFailures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T02:30:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("clears a todo-column pause-abort park to schedulable (status:null) without moving it", async () => {
    const store = createMockStore([parkTask({ id: "FN-7000", column: "todo" })]);
    const clearBinding = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
      clearPhantomExecutorBinding: clearBinding as (taskId: string) => boolean | void,
    });

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-7000", {
      status: null,
      error: null,
      workflowTransitionNotification: {
        kind: "recovery-requeue",
        column: "todo",
        transitionId: "recovery-requeue:FN-7000:pause-abort-active-work",
        nodeId: "pause-abort-recovery-router",
        reason: "pause-abort-active-work",
        createdAt: "2026-06-20T02:30:00.000Z",
      },
    });
    // Already in todo — must NOT be moved.
    expect(store.moveTask).not.toHaveBeenCalled();
    // FNXC:WorkflowLifecycle A1 releases via the wired clearPhantomExecutorBinding,
    // not the dead releaseExecutorWorktreeOwnership option (PR #1687 review).
    expect(clearBinding).toHaveBeenCalledWith("FN-7000");
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationType: "task:auto-recover-paused-abort-park",
        target: "FN-7000",
        metadata: expect.objectContaining({
          recoveryRoute: "node-requeue",
          recoveryReason: "pause-abort-active-work",
        }),
      }),
    );
  });

  it("rehomes an in-progress pause-abort park back to todo", async () => {
    const store = createMockStore([parkTask({ id: "FN-7001", column: "in-progress" })]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenNthCalledWith(1, "FN-7001", { status: null, error: null });
    expect(store.moveTask).toHaveBeenCalledWith(
      "FN-7001",
      "todo",
      { preserveProgress: true, moveSource: "engine", recoveryRehome: true },
    );
    expect(store.updateTask).toHaveBeenNthCalledWith(2, "FN-7001", {
      workflowTransitionNotification: {
        kind: "recovery-requeue",
        column: "todo",
        transitionId: "recovery-requeue:FN-7001:pause-abort-active-work",
        nodeId: "pause-abort-recovery-router",
        reason: "pause-abort-active-work",
        createdAt: "2026-06-20T02:30:00.000Z",
      },
    });
    expect((store.updateTask as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((store.moveTask as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    expect((store.moveTask as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((store.updateTask as ReturnType<typeof vi.fn>).mock.invocationCallOrder[1]);
  });

  it("clears a completed in-review pause-abort park without moving it backward", async () => {
    const store = createMockStore([parkTask({
      id: "FN-7002",
      column: "in-review",
      error: IN_REVIEW_PARK_ERROR,
      steps: DONE_STEPS,
      autoMerge: true,
    })]);
    const clearBinding = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
      clearPhantomExecutorBinding: clearBinding as (taskId: string) => boolean | void,
    });

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-7002", { status: null, error: null });
    expect(store.updateTask).not.toHaveBeenCalledWith(
      "FN-7002",
      expect.objectContaining({ workflowTransitionNotification: expect.anything() }),
    );
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(clearBinding).toHaveBeenCalledWith("FN-7002");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7002",
      "Auto-recovered: in-review pause-abort park cleared — preserved for normal review progression",
    );
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationType: "task:auto-recover-paused-abort-park",
        target: "FN-7002",
        metadata: {
          fromColumn: "in-review",
          preservedInReview: true,
          recoveryRoute: "work-item-resume",
          recoveryReason: "pause-abort-review-progress",
        },
      }),
    );
  });

  it("clears an autoMerge:false manual-hold pause-abort park in place without moving backward", async () => {
    const store = createMockStore([parkTask({
      id: "FN-7749",
      column: "in-review",
      error: MANUAL_HOLD_PARK_ERROR,
      steps: DONE_STEPS,
      autoMerge: undefined,
    })]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      maintenanceIntervalMs: 0,
    } as unknown as Settings);
    const clearBinding = vi.fn().mockReturnValue(true);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
      clearPhantomExecutorBinding: clearBinding as (taskId: string) => boolean | void,
    });

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered).toBe(1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-7749", { status: null, error: null });
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(clearBinding).toHaveBeenCalledWith("FN-7749");
    expect(store.logEntry).toHaveBeenCalledWith(
      "FN-7749",
      "Auto-recovered: in-review pause-abort park cleared — preserved for normal review progression",
    );
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        mutationType: "task:auto-recover-paused-abort-park",
        target: "FN-7749",
        metadata: expect.objectContaining({
          fromColumn: "in-review",
          preservedInReview: true,
          recoveryRoute: "work-item-resume",
          recoveryReason: "pause-abort-manual-merge-hold",
        }),
      }),
    );
  });

  it("skips paused, executing, incomplete in-review, and non-pause-abort failures", async () => {
    const store = createMockStore([
      parkTask({ id: "FN-A", paused: true }),
      parkTask({ id: "FN-B", column: "in-progress" }), // executing (below)
      parkTask({ id: "FN-C", column: "in-review", error: IN_REVIEW_PARK_ERROR }), // incomplete in-review park left for operator
      parkTask({ id: "FN-D", error: "some other failure", status: "failed" }),
    ]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(["FN-B"]),
    });

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  // FN-7736: explicit regression for the approval-hold shape (paused, canonical
  // awaiting-approval reason) -- classifyPausedAbortWorkflowRecovery's existing
  // generic `task.paused` skip already covers this, but the invariant
  // ("approval-blocked tasks are never advanced") must be asserted directly
  // rather than relying on incidental generic-pause coverage.
  it("skips an approval-held pause-abort park (canonical awaiting-approval reason)", async () => {
    const store = createMockStore([
      parkTask({ id: "FN-APPROVAL", paused: true, pausedReason: "awaiting-approval" }),
    ]);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("leaves guarded in-review pause-abort parks untouched", async () => {
    const candidates = [
      parkTask({ id: "FN-U", column: "in-review", error: IN_REVIEW_PARK_ERROR, steps: DONE_STEPS, userPaused: true, autoMerge: true }),
      parkTask({ id: "FN-X", column: "in-review", error: IN_REVIEW_PARK_ERROR, steps: DONE_STEPS, autoMerge: true }),
      parkTask({ id: "FN-M", column: "in-review", error: IN_REVIEW_PARK_ERROR, steps: DONE_STEPS, autoMerge: true, mergeDetails: { mergeConfirmed: true } as any }),
      parkTask({ id: "FN-T", column: "in-review", error: `${IN_REVIEW_PARK_ERROR} merge-conflict`, steps: DONE_STEPS, autoMerge: true }),
      parkTask({ id: "FN-A", column: "in-review", error: MANUAL_HOLD_PARK_ERROR, steps: DONE_STEPS, autoMerge: undefined, branchContext: { groupId: "BG-1", source: "mission", assignmentMode: "shared" } as any }),
    ];
    const store = createMockStore(candidates);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      autoMerge: false,
      globalPause: false,
      enginePaused: false,
      maintenanceIntervalMs: 0,
    } as unknown as Settings);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(["FN-X"]),
    });

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  it("revalidates in-review recovery against fresh state before clearing the park", async () => {
    const initial = parkTask({
      id: "FN-STALE",
      column: "in-review",
      error: IN_REVIEW_PARK_ERROR,
      steps: DONE_STEPS,
      autoMerge: true,
    });
    const store = createMockStore([initial]);
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue({ ...initial, paused: true });
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });

  // FNXC:WorkflowLifecycle greptile P1 (PR #1687): the method self-guards on
  // global/engine pause at its own entry, so calling it directly (test/API path)
  // while the operator has frozen the board must be a no-op.
  it("self-guards: does nothing while globalPause is set", async () => {
    const store = createMockStore([parkTask({ id: "FN-7000", column: "todo" })]);
    (store.getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      autoMerge: true,
      globalPause: true,
      enginePaused: false,
      maintenanceIntervalMs: 0,
    } as unknown as Settings);
    const manager = new SelfHealingManager(store, {
      rootDir: "/tmp/test-project",
      getExecutingTaskIds: () => new Set<string>(),
    });

    const recovered = await manager.recoverPausedAbortFailures();

    expect(recovered).toBe(0);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
  });
});

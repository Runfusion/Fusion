/*
 * Surface enumeration: this suite covers engine and separate-process CLI liveness fences; no
 * desktop or mobile UI applies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { executingTaskLock } from "../agents/active-session-registry.js";
import { SelfHealingManager } from "../self-healing.js";
import { RUN_AUDIT_EMIT_TIMEOUT_MS } from "../util/emit-bounded-run-audit.js";

const taskId = "FN-9304-FENCE";
const baseSettings = {
  globalPause: false,
  enginePaused: false,
  autoMerge: true,
  taskStuckTimeoutMs: 60_000,
} as Settings;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: taskId, title: "Fence", description: "Fence", column: "in-review",
    branch: "fusion/fn-9304-fence", dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

type TestStore = TaskStore & {
  updateTask: ReturnType<typeof vi.fn>;
  updateTaskAtomic: ReturnType<typeof vi.fn>;
  recordRunAuditEvent?: ReturnType<typeof vi.fn>;
  row: Task;
};

function storeFor(
  initial: Task,
  options: { audit?: ReturnType<typeof vi.fn> | null; beforeAtomic?: (row: Task) => void } = {},
): TestStore {
  const store = {
    row: initial,
    getTask: vi.fn(async () => store.row),
    getSettings: vi.fn(async () => baseSettings),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => !column || store.row.column === column ? [store.row] : []),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => {
      store.row = { ...store.row, ...patch } as Task;
      return store.row;
    }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: Task) => Partial<Task> | null) => {
      options.beforeAtomic?.(store.row);
      const patch = updater(store.row);
      if (!patch) return null;
      store.row = { ...store.row, ...patch } as Task;
      return store.row;
    }),
    ...(options.audit === null ? {} : { recordRunAuditEvent: options.audit ?? vi.fn(async () => undefined) }),
    logEntry: vi.fn(async () => undefined),
  } as unknown as TestStore;
  return store;
}

function makeManager(store: TestStore, options: ConstructorParameters<typeof SelfHealingManager>[1] = {}) {
  const manager = new SelfHealingManager(store, { rootDir: process.cwd(), ...options });
  const internal = manager as any;
  internal.resolveSelfHealingMergeTarget = vi.fn(async () => ({ branch: "main", source: "task" }));
  internal.isBranchTipMisboundToTask = vi.fn(async () => ({
    misbound: false,
    branchMissing: true,
    branchTip: "",
    landed: { sha: "abc123456789", strategy: "trailer" },
  }));
  internal.recordSelfHealingBranchGroupMemberLanding = vi.fn(async () => undefined);
  internal.moveToCompleteLaneAfterLandedCleanup = vi.fn(async (_row: Task, _lane: string, _source: string, mergeDetails: unknown) => ({ ...store.row, column: "done", mergeDetails }));
  internal.emitTaskMerged = vi.fn();
  internal.reconcileCompletedTask = vi.fn(async () => undefined);
  return manager;
}

async function reconcile(manager: SelfHealingManager) {
  return manager.reconcileLandedReviewTask(taskId, { source: "manual", requireAutoMergeEligible: false });
}

afterEach(() => {
  vi.useRealTimers();
  const lease = executingTaskLock.claim(taskId);
  if (lease) void executingTaskLock.invalidate(lease);
  for (const path of activeSessionRegistry.pathsForTask(taskId)) activeSessionRegistry.unregisterPath(path);
});

describe("reconcileLandedReviewTask liveness and CAS fences", () => {
  it.each([
    ["paused", { paused: true }, "paused"],
    ["user paused", { userPaused: true }, "user-paused"],
    ["active execution", { status: "in-progress" }, "executing"],
    ["active merger reviewing", { status: "reviewing" }, "executing"],
    ["active merger landing", { status: "landing" }, "executing"],
  ] as const)("refuses %s without mutation", async (_name, overrides, reason) => {
    const store = storeFor(task(overrides));
    const manager = makeManager(store);
    await expect(reconcile(manager)).resolves.toEqual({ outcome: "ineligible", reason });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("refuses an active registered session and executing lock", async () => {
    const path = "/tmp/fn-9304-active";
    activeSessionRegistry.registerPath(path, { taskId, kind: "executor", ownerKey: "test" });
    const sessionStore = storeFor(task());
    await expect(reconcile(makeManager(sessionStore))).resolves.toEqual({ outcome: "ineligible", reason: "live-session" });
    expect(sessionStore.updateTaskAtomic).not.toHaveBeenCalled();
    activeSessionRegistry.unregisterPath(path);

    const lease = executingTaskLock.claim(taskId)!;
    const lockStore = storeFor(task());
    await expect(reconcile(makeManager(lockStore))).resolves.toEqual({ outcome: "ineligible", reason: "executing" });
    expect(lockStore.updateTaskAtomic).not.toHaveBeenCalled();
    await executingTaskLock.invalidate(lease);
  });

  it("uses durable checkout leases for the structurally-empty manual process and accepts stale leases", async () => {
    const fresh = storeFor(task({ checkoutRunId: "remote-run", checkoutLeaseRenewedAt: new Date().toISOString() }));
    await expect(reconcile(makeManager(fresh))).resolves.toEqual({ outcome: "ineligible", reason: "checkout-leased" });
    expect(fresh.updateTaskAtomic).not.toHaveBeenCalled();

    const stale = storeFor(task({ checkoutRunId: "old-run", checkoutLeaseRenewedAt: new Date(Date.now() - 180_000).toISOString() }));
    await expect(reconcile(makeManager(stale))).resolves.toMatchObject({ outcome: "reconciled" });
    expect(stale.updateTaskAtomic).toHaveBeenCalledTimes(1);
  });

  it("refuses the engine activity callback before evidence lookup", async () => {
    const store = storeFor(task());
    const manager = makeManager(store, { isTaskActive: () => true });
    await expect(manager.reconcileLandedReviewTask(taskId, { source: "self-healing" })).resolves.toEqual({ outcome: "ineligible", reason: "executing" });
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
  });

  it.each([
    ["column", (row: Task) => { row.column = "todo"; }],
    ["merge confirmation", (row: Task) => { row.mergeDetails = { mergeConfirmed: true } as Task["mergeDetails"]; }],
    ["pause", (row: Task) => { row.paused = true; }],
    ["checkout lease", (row: Task) => { row.checkoutRunId = "raced-run"; row.checkoutLeaseRenewedAt = new Date().toISOString(); }],
    ["branch", (row: Task) => { row.branch = "fusion/replaced"; }],
  ] as const)("returns raced without a mutation when %s drifts inside the atomic fence", async (_name, beforeAtomic) => {
    const store = storeFor(task(), { beforeAtomic });
    const manager = makeManager(store);
    await expect(reconcile(manager)).resolves.toEqual({ outcome: "raced", reason: "task-state-changed" });
    expect(store.updateTask).not.toHaveBeenCalled();
    expect((manager as any).moveToCompleteLaneAfterLandedCleanup).not.toHaveBeenCalled();
  });

  it("allows one of two concurrent reconciliation attempts to finalize", async () => {
    const store = storeFor(task());
    const manager = makeManager(store);
    const outcomes = await Promise.all([reconcile(manager), reconcile(manager)]);
    expect(outcomes.filter((outcome) => outcome.outcome === "reconciled")).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome.outcome !== "reconciled")).toBe(true);
    expect(store.recordRunAuditEvent).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileLandedReviewTask bounded audit", () => {
  it.each([
    ["is absent", null],
    ["throws synchronously", vi.fn(() => { throw new Error("sink failure"); })],
    ["rejects", vi.fn(async () => { throw new Error("sink rejection"); })],
  ] as const)("finalizes when the landed audit sink %s", async (_name, audit) => {
    const store = storeFor(task(), { audit });
    await expect(reconcile(makeManager(store))).resolves.toMatchObject({ outcome: "reconciled" });
    expect(store.row.mergeDetails?.mergeConfirmed).toBe(true);
    if (audit === null) expect(store.recordRunAuditEvent).toBeUndefined();
  });

  it.each([
    ["is absent", null],
    ["throws synchronously", vi.fn(() => { throw new Error("sink failure"); })],
    ["rejects", vi.fn(async () => { throw new Error("sink rejection"); })],
  ] as const)("leaves the unproven card untouched when its audit sink %s", async (_name, audit) => {
    const store = storeFor(task(), { audit });
    const manager = makeManager(store);
    (manager as any).isBranchTipMisboundToTask = vi.fn(async () => ({ misbound: false, branchMissing: true, branchTip: "", landed: null }));

    await expect(manager.recoverBranchMisboundInReviewTasks()).resolves.toBe(0);
    expect(store.row.column).toBe("in-review");
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    if (audit === null) expect(store.recordRunAuditEvent).toBeUndefined();
  });

  it("finalizes within the audit bound when a sink never settles", async () => {
    vi.useFakeTimers();
    const store = storeFor(task(), { audit: vi.fn(() => new Promise(() => undefined)) });
    const result = reconcile(makeManager(store));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
    await expect(result).resolves.toMatchObject({ outcome: "reconciled" });
    expect(store.row.mergeDetails?.mergeConfirmed).toBe(true);
  });

  it("swallows a late audit rejection after reconciliation has returned", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const store = storeFor(task(), { audit: vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; })) });
    const result = reconcile(makeManager(store));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
    await expect(result).resolves.toMatchObject({ outcome: "reconciled" });
    reject(new Error("late sink rejection"));
    await Promise.resolve();
    expect(store.row.mergeDetails?.mergeConfirmed).toBe(true);
  });

  it("retries the unproven no-action audit until its write lands, then deduplicates", async () => {
    const audit = vi.fn()
      .mockRejectedValueOnce(new Error("first audit fails"))
      .mockResolvedValue(undefined);
    const store = storeFor(task(), { audit });
    const manager = makeManager(store);
    (manager as any).isBranchTipMisboundToTask = vi.fn(async () => ({ misbound: false, branchMissing: true, branchTip: "", landed: null }));

    await manager.recoverBranchMisboundInReviewTasks();
    await manager.recoverBranchMisboundInReviewTasks();
    await manager.recoverBranchMisboundInReviewTasks();

    expect(store.row.column).toBe("in-review");
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ mutationType: "task:reconcile-absent-branch-unproven" }));
  });

  it("does not wedge an unproven sweep when its audit sink never settles", async () => {
    vi.useFakeTimers();
    const store = storeFor(task(), { audit: vi.fn(() => new Promise(() => undefined)) });
    const manager = makeManager(store);
    (manager as any).isBranchTipMisboundToTask = vi.fn(async () => ({ misbound: false, branchMissing: true, branchTip: "", landed: null }));

    const sweep = manager.recoverBranchMisboundInReviewTasks();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
    await expect(sweep).resolves.toBe(0);
    expect(store.row.column).toBe("in-review");
  });

  it("swallows a late unproven audit rejection after the sweep has returned", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const audit = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const store = storeFor(task(), { audit });
    const manager = makeManager(store);
    (manager as any).isBranchTipMisboundToTask = vi.fn(async () => ({ misbound: false, branchMissing: true, branchTip: "", landed: null }));

    const sweep = manager.recoverBranchMisboundInReviewTasks();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RUN_AUDIT_EMIT_TIMEOUT_MS + 1);
    await expect(sweep).resolves.toBe(0);
    reject(new Error("late unproven audit rejection"));
    await Promise.resolve();
    expect(store.row.column).toBe("in-review");
  });
});

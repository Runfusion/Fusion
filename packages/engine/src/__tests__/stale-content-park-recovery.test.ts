import { describe, expect, it, vi, beforeEach } from "vitest";

const recovery = vi.hoisted(() => ({
  capture: vi.fn(),
  reroute: vi.fn(),
  resolveColumns: vi.fn(),
  resolveWorkflow: vi.fn(),
  resolveGate: vi.fn(),
  blocker: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fusion/core")>()),
  resolveProjectColumnsForRoles: recovery.resolveColumns,
  resolveWorkflowIrForTaskWithProvenance: recovery.resolveWorkflow,
  resolvePreMergeGateForTask: recovery.resolveGate,
  getTaskMergeBlocker: recovery.blocker,
}));
vi.mock("../merge/merge-content-capture.js", () => ({ captureMergeContentDescriptor: recovery.capture }));
vi.mock("../merge/stale-content-review-reroute.js", () => ({ rerouteSingularStaleContentToReview: recovery.reroute }));

import { STALE_CONTENT_APPROVAL_BLOCKER, type Task } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { AUTO_MERGE_RETRY_REJECTED_PREFIX, classifyStaleContentPark } from "../merge/stale-content-park.js";

const blocker = `Cannot merge FN-1: ${STALE_CONTENT_APPROVAL_BLOCKER}`;

beforeEach(() => {
  recovery.resolveColumns.mockResolvedValue(new Set(["in-review"]));
  recovery.resolveWorkflow.mockResolvedValue({
    source: "task",
    ir: { nodes: [{ id: "security-review", kind: "step-review", column: "in-review", config: { reviewKind: "code" } }] },
  });
  recovery.resolveGate.mockResolvedValue({ provenance: "task", selectionAbsent: false, requiredPreMergeStepIds: new Set(["security-review"]) });
  recovery.blocker.mockReturnValue(STALE_CONTENT_APPROVAL_BLOCKER);
  recovery.capture.mockResolvedValue({ kind: "singular", diff: { state: "fingerprint", fingerprint: "current" } });
  recovery.reroute.mockResolvedValue({ rerouted: true, reason: "seeded", nodeId: "security-review", workflowStepId: "security-review" });
});

function createRecoveryStore(task: Task, raceRefusesClear = false) {
  const store = {
    getSettings: vi.fn().mockResolvedValue({ autoMerge: true, globalPause: false, enginePaused: false }),
    listTasks: vi.fn().mockResolvedValue([task]),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (live: Task) => Partial<Task> | null) => {
      const live = raceRefusesClear ? { ...task, paused: true } : task;
      const patch = updater(live);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
  };
  return store as any;
}

function hiddenTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1", column: "in-review", status: "failed", error: blocker, autoMerge: true,
    worktree: "/tmp/fn-1", workflowStepResults: [], ...overrides,
  } as Task;
}

describe("classifyStaleContentPark", () => {
  it("recognizes every stale-content terminal shape", () => {
    expect(classifyStaleContentPark({ status: "failed", error: `${AUTO_MERGE_RETRY_REJECTED_PREFIX} ${blocker}` })).toBe("retry-rejected");
    expect(classifyStaleContentPark({ status: "failed", error: blocker })).toBe("raw-blocker");
    expect(classifyStaleContentPark({ status: null, error: blocker })).toBe("retry-exhausted");
  });

  it("excludes unrelated, active, and operator-held cards", () => {
    expect(classifyStaleContentPark({ status: "failed", error: "AUTO_MERGE_RETRY_FAILED: nope" })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: "AUTO_MERGE_RETRY_REJECTED: Cannot merge FN-1: task is marked 'needs-replan'" })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "merging", error: blocker })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: blocker, paused: true })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: blocker, userPaused: true })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: blocker, deletedAt: "2026-01-01" })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: undefined })).toBeUndefined();
    expect(classifyStaleContentPark({ status: "failed", error: 42 })).toBeUndefined();
  });
});

describe("hidden stale-content park recovery", () => {
  it.each([
    ["retry-rejected", { error: `${AUTO_MERGE_RETRY_REJECTED_PREFIX} ${blocker}`, status: "failed" }],
    ["raw-blocker", { error: blocker, status: "failed" }],
  ] as const)("seeds and truthfully audits the %s park", async (parkShape, patch) => {
    const task = hiddenTask(patch);
    const store = createRecoveryStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await expect(manager.recoverMergeableReviewTasks()).resolves.toBe(0);

    expect(recovery.reroute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: task.id }), expect.anything());
    expect(store.updateTaskAtomic).toHaveBeenCalledOnce();
    expect(task).toMatchObject({ status: null, error: null, mergeRetries: 0 });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:merge-stale-content-review-rerouted",
      metadata: expect.objectContaining({ source: "self-healing", parkShape, parkCleared: true, mergeRetriesReset: true }),
    }));
    manager.stop();
  });

  it("audits a refused atomic clear without un-parking the card", async () => {
    const task = hiddenTask();
    const store = createRecoveryStore(task, true);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });

    await manager.recoverMergeableReviewTasks();

    expect(task).toMatchObject({ status: "failed", error: blocker });
    expect(store.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ parkShape: "raw-blocker", parkCleared: false, mergeRetriesReset: false }),
    }));
    manager.stop();
  });

  it("re-arms the bounded recovery budget after the hidden park disappears", async () => {
    const task = hiddenTask();
    const store = createRecoveryStore(task);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/test-project" });
    const attempts = (manager as any).staleContentParkRecoveryAttempts as Map<string, number>;
    const warned = (manager as any).staleContentParkRecoveryBudgetLogged as Set<string>;
    attempts.set(task.id, 3);
    warned.add(task.id);

    store.listTasks.mockResolvedValueOnce([]);
    await manager.recoverMergeableReviewTasks();
    expect(attempts.has(task.id)).toBe(false);
    expect(warned.has(task.id)).toBe(false);

    await manager.recoverMergeableReviewTasks();
    expect(recovery.reroute).toHaveBeenCalled();
    manager.stop();
  });
});

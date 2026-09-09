import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAST_MODE_BYPASS_ACTOR,
  getTaskMergeBlocker,
  type Task,
  type WorkflowIr,
  type WorkflowStepResult,
} from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";

const now = "2026-09-01T00:00:00.000Z";
const managers: SelfHealingManager[] = [];

function approval(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    status: "passed",
    verdict: "APPROVE",
    reviewKind: "code",
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: "Proofless review approval",
    description: "Recover invalid approval evidence",
    column: "in-review",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    createdAt: now,
    updatedAt: now,
    worktree: process.cwd(),
    workflowStepResults: [approval()],
    ...overrides,
  } as Task;
}

function workflow(reviewColumn = "in-review"): WorkflowIr {
  return {
    version: "v2",
    name: "review lanes",
    columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "Work", traits: [{ trait: "wip" }] },
      { id: reviewColumn, name: "Review", traits: [{ trait: "merge-blocker" }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      { id: "end", kind: "end", column: "done" },
    ],
    edges: [{ from: "start", to: "end" }],
  };
}

function harness(rows: Task[], options: {
  settings?: Record<string, unknown>;
  reviewColumn?: string;
  isTaskActive?: (taskId: string) => boolean;
  recordRunAuditEvent?: (event: Record<string, unknown>) => Promise<void>;
  recoverFailedPreMergeStep?: (task: Task) => Promise<boolean>;
  beforeAtomicUpdate?: (task: Task) => void;
} = {}) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const auditEvents: Record<string, unknown>[] = [];
  const store = {
    listWorkflowDefinitions: vi.fn(async () => [{ ir: workflow(options.reviewColumn) }]),
    listTasks: vi.fn(async (query: { column?: string }) => [...byId.values()].filter((row) => !query.column || row.column === query.column)),
    getTask: vi.fn(async (id: string) => byId.get(id)),
    getSettings: vi.fn(async () => ({ autoMerge: true, ...options.settings })),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const row = byId.get(id);
      if (!row) throw new Error(`missing ${id}`);
      Object.assign(row, patch);
      return row;
    }),
    updateTaskAtomic: vi.fn(async (
      id: string,
      updater: (current: Task) => Partial<Task> | null | undefined | Promise<Partial<Task> | null | undefined>,
    ) => {
      const row = byId.get(id);
      if (!row) throw new Error(`missing ${id}`);
      options.beforeAtomicUpdate?.(row);
      const patch = await updater(row);
      if (patch) Object.assign(row, patch);
      return row;
    }),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: options.recordRunAuditEvent ?? vi.fn(async (event: Record<string, unknown>) => {
      auditEvents.push(event);
    }),
  };
  const manager = new SelfHealingManager(store as never, {
    rootDir: process.cwd(),
    isTaskActive: options.isTaskActive,
    recoverFailedPreMergeStep: options.recoverFailedPreMergeStep,
  });
  managers.push(manager);
  return { manager, store, byId, auditEvents };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
});

describe("reconcileUnprovenReviewApprovals", () => {
  it("repairs the exact singular wedge and exposes both recovery blocker shapes", async () => {
    const sibling = approval({ workflowStepId: "documentation-delivery", workflowStepName: "Documentation", reviewKind: undefined, verdict: undefined });
    const row = task("FN-279", { workflowStepResults: [approval(), sibling] });
    const { manager, store, auditEvents } = harness([row]);

    await expect(manager.reconcileUnprovenReviewApprovals()).resolves.toBe(1);

    const repaired = row.workflowStepResults?.find((entry) => entry.workflowStepId === "code-review");
    expect(repaired).toMatchObject({ status: "failed" });
    expect(repaired).not.toHaveProperty("verdict");
    expect(row.workflowStepResults?.find((entry) => entry.workflowStepId === "documentation-delivery")).toEqual(sibling);
    const mergeContent = { kind: "singular" as const, diff: { state: "fingerprint" as const, fingerprint: "current" } };
    expect(getTaskMergeBlocker(row, { requiredPreMergeStepIds: new Set(["code-review"]), mergeContent }))
      .toBe("task has enabled pre-merge workflow steps without a current approval (gate 'code-review')");
    expect(getTaskMergeBlocker(row)).toBe("task has failed pre-merge workflow steps");
    expect(store.logEntry).toHaveBeenCalledWith(row.id, expect.stringContaining("code-review"));
    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0] as { mutationType: string; metadata: Record<string, unknown> };
    expect(event.mutationType).toBe("task:reconcile-unproven-review-approval");
    expect(event.metadata).toEqual({
      taskId: row.id,
      column: "in-review",
      workflowStepId: "code-review",
      repairedCount: 1,
      resultCount: 2,
      needsOperatorBypass: false,
    });
    await expect(manager.reconcileUnprovenReviewApprovals()).resolves.toBe(0);
    expect(auditEvents).toHaveLength(1);
  });

  it("preserves a concurrently published proof-bound approval and sibling gate", async () => {
    const row = task("FN-CONCURRENT");
    const proofBound = approval({ reviewInputFingerprint: "new-proof" });
    const sibling = approval({
      workflowStepId: "deterministic-verification",
      workflowStepName: "Deterministic Verification",
      reviewKind: undefined,
      verdict: undefined,
    });
    const beforeAtomicUpdate = vi.fn((live: Task) => {
      live.workflowStepResults = [proofBound, sibling];
    });
    const { manager, store, auditEvents } = harness([row], { beforeAtomicUpdate });

    await expect(manager.reconcileUnprovenReviewApprovals()).resolves.toBe(0);

    expect(beforeAtomicUpdate).toHaveBeenCalledOnce();
    expect(store.getTask.mock.invocationCallOrder[0]).toBeLessThan(store.updateTaskAtomic.mock.invocationCallOrder[0]);
    expect(row.workflowStepResults).toEqual([proofBound, sibling]);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(store.logEntry).not.toHaveBeenCalled();
    expect(auditEvents).toEqual([]);
  });

  it("repairs an identity-only approval on a renamed review lane", async () => {
    const row = task("FN-IDENTITY", {
      column: "checking",
      workflowStepResults: [approval({ reviewKind: undefined })],
    });
    const { manager } = harness([row], { reviewColumn: "checking" });
    await expect(manager.reconcileUnprovenReviewApprovals()).resolves.toBe(1);
    expect(row.workflowStepResults?.[0]).toMatchObject({ status: "failed", reviewKind: undefined });
  });

  it("repairs autoMerge:false in place and labels the required operator exit", async () => {
    const row = task("FN-HUMAN", { status: "reviewing", error: "unchanged", paused: true });
    const before = { column: row.column, status: row.status, error: row.error, paused: row.paused };
    const { manager, auditEvents } = harness([row], { settings: { autoMerge: false } });
    await expect(manager.reconcileUnprovenReviewApprovals()).resolves.toBe(1);
    expect({ column: row.column, status: row.status, error: row.error, paused: row.paused }).toEqual(before);
    expect((auditEvents[0] as { metadata: Record<string, unknown> }).metadata.needsOperatorBypass).toBe(true);
  });

  it("leaves every non-candidate and live task untouched", async () => {
    const audited = {
      status: "skipped" as const,
      verdict: undefined,
      bypassedBy: "operator-1",
      bypassedAt: now,
      bypassReason: "Reviewer unavailable",
    };
    const rows = [
      task("user-paused", { userPaused: true }),
      task("live"),
      task("workspace", { workspaceWorktrees: {} }),
      task("fingerprinted", { workflowStepResults: [approval({ reviewInputFingerprint: "proof" })] }),
      task("fast", { workflowStepResults: [approval({ ...audited, bypassedBy: FAST_MODE_BYPASS_ACTOR })] }),
      task("operator", { workflowStepResults: [approval(audited)] }),
      task("non-review", { workflowStepResults: [approval({ workflowStepId: "documentation-delivery", reviewKind: undefined })] }),
      task("wip", { column: "in-progress" }),
    ];
    const snapshots = new Map(rows.map((row) => [row.id, structuredClone(row.workflowStepResults)]));
    const { manager, store } = harness(rows, { isTaskActive: (id) => id === "live" });
    await expect(manager.reconcileUnprovenReviewApprovals()).resolves.toBe(0);
    expect(store.updateTaskAtomic).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    for (const row of rows) expect(row.workflowStepResults).toEqual(snapshots.get(row.id));
  });

  it("feeds an auto-merge-eligible repaired row into failed-step recovery in the same lifecycle", async () => {
    const row = task("FN-AUTO-RECOVER");
    const recover = vi.fn(async () => true);
    const { manager } = harness([row], { recoverFailedPreMergeStep: recover });

    await expect(manager.reconcileUnprovenReviewApprovals()).resolves.toBe(1);
    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(1);
    expect(recover).toHaveBeenCalledOnce();
    expect(recover).toHaveBeenCalledWith(row);
  });

  it("gives an autoMerge:false card an effective audited operator exit", async () => {
    const row = task("FN-OPERATOR-EXIT");
    const recover = vi.fn(async () => true);
    const { manager } = harness([row], {
      settings: { autoMerge: false },
      recoverFailedPreMergeStep: recover,
    });
    await expect(manager.reconcileUnprovenReviewApprovals()).resolves.toBe(1);
    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
    expect(recover).not.toHaveBeenCalled();

    const failed = row.workflowStepResults![0]!;
    row.workflowStepResults = [{
      ...failed,
      status: "skipped",
      bypassedBy: "operator-1",
      bypassedAt: now,
      bypassReason: "Reviewer approval lacked content proof",
      bypassedFromStatus: "failed",
    }];
    const mergeContent = { kind: "singular" as const, diff: { state: "fingerprint" as const, fingerprint: "current" } };
    for (const manual of [false, true]) {
      expect(getTaskMergeBlocker(row, {
        manual,
        requiredPreMergeStepIds: new Set(["code-review"]),
        mergeContent,
      })).toBeUndefined();
    }
  });

  it("cannot route a machine-written fast waiver through either recovery exit", async () => {
    const row = task("FN-FAST-REFUSED", {
      workflowStepResults: [approval({
        status: "skipped",
        verdict: undefined,
        bypassedBy: FAST_MODE_BYPASS_ACTOR,
        bypassedAt: now,
        bypassReason: "Fast mode bypasses pre-merge workflow gates",
        bypassedFromStatus: "absent",
      })],
    });
    const recover = vi.fn(async () => true);
    const { manager } = harness([row], { recoverFailedPreMergeStep: recover });
    await expect(manager.reconcileUnprovenReviewApprovals()).resolves.toBe(0);
    await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
    const mergeContent = { kind: "singular" as const, diff: { state: "fingerprint" as const, fingerprint: "current" } };
    for (const manual of [false, true]) {
      expect(getTaskMergeBlocker(row, {
        manual,
        requiredPreMergeStepIds: new Set(["code-review"]),
        mergeContent,
      })).toBe("task has no provable approval for the content being merged");
    }
  });
});

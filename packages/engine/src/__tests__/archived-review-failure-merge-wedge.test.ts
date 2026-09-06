import { describe, expect, it, vi } from "vitest";
import { archiveTerminalWorkflowStepFailures, getBuiltinWorkflow, type Task, type WorkflowStepResult } from "@fusion/core";

import { formatMergeableReviewRecoverySummary, SelfHealingManager } from "../self-healing.js";

const codingIr = getBuiltinWorkflow("builtin:coding")!.ir;

function archivedPlanReview(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    ...archiveTerminalWorkflowStepFailures([{
      workflowStepId: "plan-review",
      phase: "pre-merge",
      status: "failed",
      reviewKind: "plan",
      completedAt: "2026-09-01T00:00:00.000Z",
    }], "2026-09-02T00:00:00.000Z")![0]!,
    ...overrides,
  };
}

function reviewTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-9266-wedge",
    title: "Archived review failure",
    description: "",
    column: "in-review",
    status: null,
    autoMerge: true,
    worktree: "/tmp/fn-9266-wedge",
    dependencies: [],
    steps: [{ name: "Implement", status: "done" }],
    currentStep: 0,
    log: [],
    enabledWorkflowSteps: ["plan-review"],
    workflowStepResults: [archivedPlanReview()],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function recoveryStore(task: Task) {
  return {
    getSettings: vi.fn(async () => ({ autoMerge: true })),
    getTaskWorkflowSelection: vi.fn(() => ({ workflowId: "builtin:coding", stepIds: ["plan-review"] })),
    getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: ["plan-review"] })),
    getWorkflowDefinition: vi.fn(async () => ({ ir: codingIr })),
    listWorkflowDefinitions: vi.fn(async () => [{ ir: codingIr }]),
    listWorkflowWorkItemsForTask: vi.fn(async () => []),
    listTasks: vi.fn(async (options?: { column?: string }) => options?.column === "in-review" ? [task] : []),
    logEntry: vi.fn(async () => undefined),
    recordRunAuditEvent: vi.fn(async () => undefined),
    getCompletionHandoffAcceptedMarker: vi.fn(async () => null),
    getAgentLogs: vi.fn(async () => []),
  } as any;
}

/*
FNXC:ReviewLaneBypass 2026-09-06-00:59:
The shipped archival helper constructs this fixture so the regression covers the same skipped carrier
self-healing produces after a crashed review session, rather than an easy-to-misstate hand-written row.
*/
describe("archived review failure merge wedge regression", () => {
  it("declines an unwaived archived carrier once across sweeps, then enqueues its audited waiver", async () => {
    const live = reviewTask();
    const store = recoveryStore(live);
    const enqueueMerge = vi.fn(() => true);
    const manager = new SelfHealingManager(store, { rootDir: "/tmp/fn-9266-wedge", enqueueMerge } as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await manager.recoverMergeableReviewTasks();
      await manager.recoverMergeableReviewTasks();
      expect(enqueueMerge).not.toHaveBeenCalled();
      expect(warn.mock.calls.filter(([message]) => String(message).includes("mergeable-review recovery declined FN-9266-wedge"))).toHaveLength(1);

      live.workflowStepResults = [archivedPlanReview({
        bypassedBy: "operator",
        bypassedAt: "2026-09-03T00:00:00.000Z",
        bypassReason: "Engine crash archived the pending review.",
        bypassedFromStatus: "failed",
      })];
      await manager.recoverMergeableReviewTasks();
      expect(enqueueMerge).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("continues to enqueue a fully approved review fixture", async () => {
    const live = reviewTask({ workflowStepResults: [{
      workflowStepId: "plan-review", phase: "pre-merge", status: "passed", reviewKind: "plan", verdict: "APPROVE",
    }] });
    const enqueueMerge = vi.fn(() => true);

    await new SelfHealingManager(recoveryStore(live), { rootDir: "/tmp/fn-9266-wedge", enqueueMerge } as any)
      .recoverMergeableReviewTasks();

    expect(enqueueMerge).toHaveBeenCalledWith(live.id);
  });

  it("formats merge recovery summaries according to the branch that ran", () => {
    expect(formatMergeableReviewRecoverySummary({ enqueued: 1, merged: 0, parked: 0 })).toBe("Mergeable review recovery: 1 re-enqueued for merge");
    expect(formatMergeableReviewRecoverySummary({ enqueued: 0, merged: 1, parked: 0 })).toBe("Mergeable review recovery: 1 merged → done");
    expect(formatMergeableReviewRecoverySummary({ enqueued: 0, merged: 0, parked: 1 })).toBe("Mergeable review recovery: 1 parked after enqueue starvation");
    expect(formatMergeableReviewRecoverySummary({ enqueued: 1, merged: 1, parked: 1 })).toBe("Mergeable review recovery: 1 re-enqueued for merge, 1 merged → done, 1 parked after enqueue starvation");
  });
});

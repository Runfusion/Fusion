import { describe, expect, it } from "vitest";
import { collectDeterministicSignals } from "../eval/eval-signal-collector.js";
import { evaluatePreMergeApprovals } from "../merge/pre-merge-approval.js";
import {
  getTaskMergeBlocker,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
} from "../merge/task-merge.js";
import { isPlanReviewSatisfied } from "../planner/plan-approval.js";
import { archiveTerminalWorkflowStepFailures } from "../workflows/workflow-step-results.js";
import type { Task, TaskDetail, WorkflowStepResult } from "../types.js";

function result(
  workflowStepId: string,
  overrides: Partial<WorkflowStepResult> = {},
): WorkflowStepResult {
  return {
    workflowStepId,
    workflowStepName: workflowStepId,
    phase: "pre-merge",
    status: "skipped",
    notRunReason: "not-configured",
    ...overrides,
  };
}

function approvals(results: WorkflowStepResult[], required: string[]) {
  return evaluatePreMergeApprovals(
    { workflowStepResults: results },
    { requiredPreMergeStepIds: new Set(required) },
  );
}

function reviewTask(workflowStepResults: WorkflowStepResult[]): Task {
  return {
    id: "FN-226",
    title: "Not-run checks",
    description: "",
    column: "in-review",
    priority: "normal",
    steps: [],
    dependencies: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    workflowStepResults,
  } as Task;
}

describe("pre-merge approval for not-run workflow gates", () => {
  it("approves not-run non-review verification and browser gates", () => {
    expect(approvals([result("verification")], ["verification"])[0]?.state).toBe("approved");
    expect(approvals([
      result("browser-verification", { notRunReason: "tooling-unavailable" }),
    ], ["browser-verification"])[0]?.state).toBe("approved");
  });

  it("never substitutes a not-run row for Code Review", () => {
    expect(approvals([result("code-review")], ["code-review"])[0]?.state).toBe("not-approved");
    expect(approvals([
      result("custom-code-review", { reviewKind: "code" }),
    ], ["custom-code-review"])[0]?.state).toBe("not-approved");
  });

  it("never substitutes a not-run row for Plan Review", () => {
    expect(approvals([result("plan-review")], ["plan-review"])[0]?.state).toBe("not-approved");
    expect(approvals([
      result("custom-plan-review", { reviewKind: "plan" }),
    ], ["custom-plan-review"])[0]?.state).toBe("not-approved");
    // FN-286 removed status-only approval authority from legacy review-kind rows.
    expect(approvals([
      result("custom-plan-review", {
        status: "passed",
        notRunReason: undefined,
        reviewKind: "plan",
      }),
    ], ["custom-plan-review"])[0]?.state).toBe("not-approved");
  });

  it("keeps an honestly not-run non-content gate mergeable", () => {
    const task = reviewTask([
      result("code-review", {
        status: "passed",
        notRunReason: undefined,
        reviewKind: "code",
        verdict: "APPROVE",
      }),
      result("verification"),
    ]);
    const required = new Set(["code-review", "verification"]);
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required })).toBeUndefined();

    expect(getTaskMergeBlocker(
      { ...task, workflowStepResults: task.workflowStepResults?.filter((entry) => entry.workflowStepId !== "verification") },
      { requiredPreMergeStepIds: required },
    )).toBe(PRE_MERGE_STEPS_NOT_RUN_BLOCKER);
  });

  it("keeps Plan Review satisfaction fail-closed", () => {
    expect(isPlanReviewSatisfied(result("plan-review", {
      notRunReason: "execution-mode-skip",
    }))).toBe(false);
  });

  it("preserves archive history while allowing only an audited operator bypass to satisfy its gate", () => {
    const archived = archiveTerminalWorkflowStepFailures([result("verification", {
      status: "failed",
      notRunReason: undefined,
    })], "2026-08-28T00:00:00.000Z")![0]!;
    const required = new Set(["verification"]);
    expect(approvals([archived], ["verification"])[0]?.state).toBe("not-approved");
    expect(getTaskMergeBlocker(reviewTask([archived]), { requiredPreMergeStepIds: required }))
      .toBe("task has enabled pre-merge workflow steps without a current approval (gate 'verification')");

    const bypassed = {
      ...archived,
      bypassedBy: "operator",
      bypassedAt: "2026-08-28T00:01:00.000Z",
      bypassReason: "Reviewed manually",
      bypassedFromStatus: "failed" as const,
    };
    expect(approvals([bypassed], ["verification"])[0]?.state).toBe("approved");
    expect(getTaskMergeBlocker(reviewTask([bypassed]), { requiredPreMergeStepIds: required })).toBeUndefined();
  });

  it("answers from the latest duplicate result", () => {
    const first = result("verification");
    expect(approvals([
      first,
      result("verification", { status: "failed", notRunReason: undefined }),
    ], ["verification"])[0]?.state).toBe("not-approved");
    expect(approvals([
      first,
      result("verification", { status: "passed", notRunReason: undefined }),
    ], ["verification"])[0]?.state).toBe("approved");
  });

  it("counts not-run evaluation evidence as neither passed nor failed", () => {
    const task = {
      ...reviewTask([result("verification")]),
      log: [],
    } as unknown as TaskDetail;
    expect(collectDeterministicSignals(task, {
      runId: "ER-FN-226",
      startedAt: "2026-08-28T00:00:00.000Z",
    }).workflowSummary).toEqual({ total: 1, passed: 0, failed: 0, pending: 0 });
  });
});

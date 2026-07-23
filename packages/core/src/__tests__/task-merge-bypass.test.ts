import { describe, it, expect } from "vitest";
import type { StepStatus, WorkflowStepResult } from "../types.js";
import { getLatestFailedPreMergeReviewStep, getTaskMergeBlocker } from "../merge/task-merge.js";

/*
 * FNXC:ReviewLaneBypass 2026-07-09-00:00:
 * Regression coverage for FN-7720's bypass invariant: bypassing a failed
 * pre-merge review step clears ONLY the failed-pre-merge-step merge blocker;
 * every other blocker condition still applies. Mirrors task-merge.test.ts's
 * baseTask fixture shape.
 */

const baseTask = {
  column: "in-review" as const,
  paused: false,
  status: undefined as string | undefined,
  error: undefined as string | undefined,
  steps: [] as Array<{ name: string; status: StepStatus }>,
  workflowStepResults: undefined as WorkflowStepResult[] | undefined,
};

function stepResult(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId: "WS-001",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    status: "failed",
    ...overrides,
  };
}

describe("getLatestFailedPreMergeReviewStep", () => {
  it("returns undefined when there are no workflow step results", () => {
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: undefined })).toBeUndefined();
  });

  it("returns undefined when no pre-merge step has failed", () => {
    const results = [
      stepResult({ workflowStepId: "WS-001", status: "passed" }),
      stepResult({ workflowStepId: "WS-002", phase: "post-merge", status: "failed" }),
    ];
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: results })).toBeUndefined();
  });

  it("ignores post-merge failures — they do not block merge and are out of scope", () => {
    const results = [stepResult({ workflowStepId: "WS-post", phase: "post-merge", status: "failed" })];
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: results })).toBeUndefined();
  });

  it("selects the most-recently-completed failed pre-merge step across code-review/plan-review/browser-verification lanes", () => {
    const results = [
      stepResult({
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        completedAt: "2026-07-01T00:00:00.000Z",
      }),
      stepResult({
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
        completedAt: "2026-07-03T00:00:00.000Z",
      }),
      stepResult({
        workflowStepId: "browser-verification",
        workflowStepName: "Browser Verification",
        completedAt: "2026-07-02T00:00:00.000Z",
      }),
    ];
    const selected = getLatestFailedPreMergeReviewStep({ workflowStepResults: results });
    expect(selected?.workflowStepId).toBe("plan-review");
  });

  it("falls back to startedAt when completedAt is absent", () => {
    const results = [
      stepResult({ workflowStepId: "WS-earlier", startedAt: "2026-07-01T00:00:00.000Z" }),
      stepResult({ workflowStepId: "WS-later", startedAt: "2026-07-05T00:00:00.000Z" }),
    ];
    const selected = getLatestFailedPreMergeReviewStep({ workflowStepResults: results });
    expect(selected?.workflowStepId).toBe("WS-later");
  });
});

describe("bypass invariant on getTaskMergeBlocker", () => {
  it("clears the failed-pre-merge-step blocker once the step is rewritten to skipped with bypass metadata", () => {
    const failing = {
      ...baseTask,
      workflowStepResults: [stepResult()],
    };
    expect(getTaskMergeBlocker(failing)).toBe("task has failed pre-merge workflow steps");

    const target = getLatestFailedPreMergeReviewStep(failing);
    expect(target).toBeDefined();

    const bypassed = {
      ...baseTask,
      workflowStepResults: [
        {
          ...target!,
          status: "skipped" as const,
          verdict: undefined,
          bypassedBy: "operator-1",
          bypassedAt: "2026-07-09T00:00:00.000Z",
          bypassReason: "Runfusion/Fusion#1946 no-verdict dispatch defect",
          bypassedFromStatus: "failed" as const,
        },
      ],
    };
    expect(getTaskMergeBlocker(bypassed)).toBeUndefined();
  });

  it("still blocks on a pending pre-merge step after an unrelated step is bypassed", () => {
    const task = {
      ...baseTask,
      workflowStepResults: [
        stepResult({
          workflowStepId: "code-review",
          status: "skipped",
          bypassedBy: "operator-1",
          bypassedAt: "2026-07-09T00:00:00.000Z",
          bypassReason: "infra failure",
          bypassedFromStatus: "failed",
        }),
        stepResult({ workflowStepId: "browser-verification", status: "pending" }),
      ],
    };
    expect(getTaskMergeBlocker(task)).toBe("task has incomplete or failed pre-merge workflow steps");
  });

  it("still blocks on incomplete steps after bypass", () => {
    const task = {
      ...baseTask,
      steps: [{ name: "Step 1", status: "in-progress" as StepStatus }],
      workflowStepResults: [
        stepResult({
          status: "skipped",
          bypassedBy: "operator-1",
          bypassedAt: "2026-07-09T00:00:00.000Z",
          bypassReason: "infra failure",
          bypassedFromStatus: "failed",
        }),
      ],
    };
    expect(getTaskMergeBlocker(task)).toBe("task has incomplete steps");
  });

  it("still blocks on paused tasks after bypass", () => {
    const task = {
      ...baseTask,
      paused: true,
      workflowStepResults: [
        stepResult({
          status: "skipped",
          bypassedBy: "operator-1",
          bypassedAt: "2026-07-09T00:00:00.000Z",
          bypassReason: "infra failure",
          bypassedFromStatus: "failed",
        }),
      ],
    };
    expect(getTaskMergeBlocker(task)).toBe("task is paused");
  });

  it("still blocks on a blocking task status after bypass", () => {
    const task = {
      ...baseTask,
      status: "stuck-killed",
      workflowStepResults: [
        stepResult({
          status: "skipped",
          bypassedBy: "operator-1",
          bypassedAt: "2026-07-09T00:00:00.000Z",
          bypassReason: "infra failure",
          bypassedFromStatus: "failed",
        }),
      ],
    };
    expect(getTaskMergeBlocker(task)).toMatch(/marked 'stuck-killed'/);
  });
});

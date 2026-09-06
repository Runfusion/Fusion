import { describe, it, expect } from "vitest";
import type { StepStatus, WorkflowStepResult } from "../types.js";
import { findPendingPreMergeStep, getLatestFailedPreMergeReviewStep, getTaskMergeBlocker } from "../merge/task-merge.js";
import { FAST_MODE_BYPASS_ACTOR } from "../workflows/workflow-fast-lane.js";
import { archiveTerminalWorkflowStepFailures } from "../workflows/workflow-step-results.js";

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

  it("selects eligible archived failure carriers while preserving live-failure precedence and recency", () => {
    const archived = (overrides: Partial<WorkflowStepResult> = {}) => ({
      ...archiveTerminalWorkflowStepFailures([
        stepResult({ workflowStepId: "archived", completedAt: "2026-09-01T00:00:00.000Z" }),
      ], "2026-09-02T00:00:00.000Z")![0]!,
      ...overrides,
    });

    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [] })).toBeUndefined();
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [
      archived({ workflowStepId: "older-archived" }),
      stepResult({ workflowStepId: "live-failed", completedAt: "2026-08-01T00:00:00.000Z" }),
    ] })?.workflowStepId).toBe("live-failed");
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [archived()] })?.workflowStepId).toBe("archived");
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [archived({ remediationArchivedFromStatus: "advisory_failure" })] })?.workflowStepId).toBe("archived");
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [archived({ remediationArchivedFromStatus: "passed" })] })).toBeUndefined();
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [archived({ bypassedBy: "operator" })] })).toBeUndefined();
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [archived({ supersededAt: "2026-09-03T00:00:00.000Z" })] })).toBeUndefined();
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [archived({ phase: "post-merge" })] })).toBeUndefined();
    expect(getLatestFailedPreMergeReviewStep({ workflowStepResults: [
      archived({ workflowStepId: "older", completedAt: "2026-09-01T00:00:00.000Z" }),
      archived({ workflowStepId: "newer", completedAt: "2026-09-04T00:00:00.000Z" }),
    ] })?.workflowStepId).toBe("newer");
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

describe("content-binding bypass actors", () => {
  const requiredPreMergeStepIds = new Set(["code-review"]);
  const mergeContent = { kind: "singular" as const, diff: { state: "fingerprint" as const, fingerprint: "current" } };
  const audit = {
    status: "skipped" as const,
    bypassedAt: "2026-09-01T00:00:00.000Z",
    bypassReason: "Reviewer transport failed",
    bypassedFromStatus: "absent" as const,
  };

  function blocker(result: WorkflowStepResult, manual: boolean) {
    return getTaskMergeBlocker({ ...baseTask, workflowStepResults: [result] }, {
      manual,
      requiredPreMergeStepIds,
      mergeContent,
    });
  }

  it.each([false, true])("releases audited human carriers but not the field-identical fast carrier when manual=%s", (manual) => {
    const humanAbsent = stepResult({ workflowStepId: "code-review", ...audit, bypassedBy: "operator-1" });
    const humanFailed = stepResult({ ...humanAbsent, bypassedFromStatus: "failed" });
    const automated = stepResult({ ...humanAbsent, bypassedBy: FAST_MODE_BYPASS_ACTOR });
    const incompleteHuman = stepResult({ ...humanAbsent, bypassedAt: undefined, bypassReason: undefined });

    expect(blocker(humanFailed, manual)).toBeUndefined();
    expect(blocker(humanAbsent, manual)).toBeUndefined();
    expect(blocker(automated, manual)).toBe("task has no provable approval for the content being merged");
    expect(blocker(incompleteHuman, manual)).toBe("task has no provable approval for the content being merged");
  });

  it("keeps fast-mode behavior unchanged for empty and absent descriptors", () => {
    const automated = stepResult({ workflowStepId: "code-review", ...audit, bypassedBy: FAST_MODE_BYPASS_ACTOR });
    expect(getTaskMergeBlocker({ ...baseTask, workflowStepResults: [automated] }, {
      requiredPreMergeStepIds,
      mergeContent: { kind: "singular", diff: { state: "empty" } },
    })).toBeUndefined();
    expect(getTaskMergeBlocker({ ...baseTask, workflowStepResults: [automated] }, {
      requiredPreMergeStepIds,
    })).toBeUndefined();
  });

  it("lets an audited waiver release stale content while an unbypassed approval stays stale", () => {
    const stale = stepResult({
      workflowStepId: "code-review",
      status: "passed",
      reviewKind: "code",
      verdict: "APPROVE",
      reviewInputFingerprint: "stale",
    });
    expect(blocker(stale, false)).toBe("task has a pre-merge approval recorded against different content");
    expect(blocker({ ...stale, ...audit, bypassedBy: "operator-1" }, false)).toBeUndefined();
  });
});

describe("findPendingPreMergeStep", () => {
  it("returns undefined when workflowStepResults is undefined", () => {
    expect(findPendingPreMergeStep({ workflowStepResults: undefined })).toBeUndefined();
  });

  it("returns undefined when no pre-merge step is pending", () => {
    const results = [
      stepResult({ status: "passed" }),
      stepResult({ status: "failed" }),
      stepResult({ workflowStepId: "WS-post", phase: "post-merge", status: "pending" }),
    ];
    expect(findPendingPreMergeStep({ workflowStepResults: results })).toBeUndefined();
  });

  it("returns the pending result when one exists", () => {
    const results = [stepResult({ status: "pending" })];
    const found = findPendingPreMergeStep({ workflowStepResults: results });
    expect(found?.workflowStepId).toBe("WS-001");
    expect(found?.status).toBe("pending");
  });

  it("returns the latest pending result when multiple exist", () => {
    const results = [
      stepResult({ workflowStepId: "WS-older", startedAt: "2026-07-17T10:00:00.000Z", status: "pending" }),
      stepResult({ workflowStepId: "WS-newer", startedAt: "2026-07-17T16:10:10.052Z", status: "pending" }),
    ];
    const found = findPendingPreMergeStep({ workflowStepResults: results });
    expect(found?.workflowStepId).toBe("WS-newer");
  });

  it("does NOT return failed or passed results (only pending)", () => {
    const results = [
      stepResult({ workflowStepId: "WS-passed", status: "passed" }),
      stepResult({ workflowStepId: "WS-failed", status: "failed" }),
      stepResult({ workflowStepId: "WS-pending", status: "pending" }),
    ];
    const found = findPendingPreMergeStep({ workflowStepResults: results });
    expect(found?.workflowStepId).toBe("WS-pending");
  });
});

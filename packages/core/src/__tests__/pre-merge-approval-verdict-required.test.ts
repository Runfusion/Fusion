import { describe, expect, it } from "vitest";
import {
  evaluatePreMergeApprovals,
  requiresAuthoredReviewVerdict,
} from "../merge/pre-merge-approval.js";
import { getTaskMergeBlocker } from "../merge/task-merge.js";
import type { Task, WorkflowStepResult } from "../types.js";

const CONTENT_FINGERPRINT = "sha256:current-content";

function result(workflowStepId: string, overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    workflowStepId,
    workflowStepName: workflowStepId,
    phase: "pre-merge",
    status: "passed",
    ...overrides,
  };
}

function approvals(rows: WorkflowStepResult[], required = rows.map((row) => row.workflowStepId)) {
  return evaluatePreMergeApprovals(
    { workflowStepResults: rows },
    { requiredPreMergeStepIds: new Set(required) },
  );
}

function mergeTask(workflowStepResults: WorkflowStepResult[]): Pick<Task, "column" | "paused" | "status" | "error" | "steps" | "workflowStepResults" | "repositoryScope"> {
  return {
    column: "in-review",
    paused: false,
    steps: [],
    workflowStepResults,
  };
}

describe("mandatory authored pre-merge review verdicts", () => {
  it("refuses a passed verdict-required result without a verdict at evaluation and merge admission", () => {
    const row = result("custom-review", { verdictRequired: true });
    expect(approvals([row])).toEqual([{ workflowStepId: "custom-review", state: "not-approved" }]);
    expect(getTaskMergeBlocker(mergeTask([row]), {
      requiredPreMergeStepIds: new Set(["custom-review"]),
    })).toBe("task has enabled pre-merge workflow steps without a current approval (gate 'custom-review')");
  });

  it("refuses a legacy review-kind result without a verdict", () => {
    const row = result("custom-plan-review", { reviewKind: "plan" });
    expect(requiresAuthoredReviewVerdict(row.workflowStepId, row)).toBe(true);
    expect(approvals([row])[0]?.state).toBe("not-approved");
  });

  it("accepts an authored approval for a verdict-required result", () => {
    expect(approvals([result("custom-review", {
      verdictRequired: true,
      verdict: "APPROVE",
    })])[0]?.state).toBe("approved");
  });

  it("preserves status-only semantics for legacy non-review verification", () => {
    expect(approvals([result("verification")])[0]?.state).toBe("approved");
  });

  it("does not let a fixed not-run reason approve a verdict-required review", () => {
    expect(approvals([result("custom-review", {
      status: "skipped",
      verdictRequired: true,
      notRunReason: "not-configured",
    })])[0]?.state).toBe("not-approved");
  });

  it("preserves an audited operator bypass for a verdict-required review", () => {
    expect(approvals([result("custom-review", {
      status: "skipped",
      verdictRequired: true,
      bypassedBy: "operator",
      bypassedAt: "2026-09-02T00:00:00.000Z",
      bypassReason: "Reviewed manually",
    })])[0]?.state).toBe("approved");
  });

  it("does not make plan-domain or non-content approvals require a source fingerprint", () => {
    const rows = [
      result("plan-review", { reviewKind: "plan", verdict: "APPROVE" }),
      result("verification", { verdictRequired: true, verdict: "APPROVE" }),
      result("documentation-delivery"),
      result("code-review", {
        reviewKind: "code",
        verdict: "APPROVE",
        reviewInputFingerprint: CONTENT_FINGERPRINT,
      }),
    ];
    const evaluated = evaluatePreMergeApprovals(
      { workflowStepResults: rows },
      {
        requiredPreMergeStepIds: new Set(rows.map((row) => row.workflowStepId)),
        mergeContent: {
          kind: "singular",
          diff: { state: "fingerprint", fingerprint: CONTENT_FINGERPRINT },
        },
      },
    );

    expect(evaluated).toEqual(rows.map((row) => ({ workflowStepId: row.workflowStepId, state: "approved" })));
    expect(evaluated).not.toContainEqual(expect.objectContaining({ state: "unprovable-content" }));
  });
});

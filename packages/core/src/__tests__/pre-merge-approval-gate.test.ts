import { describe, expect, it } from "vitest";
import { getTaskMergeBlocker } from "../merge/task-merge.js";
import { evaluatePreMergeApprovals } from "../merge/pre-merge-approval.js";

const base = {
  column: "in-review", paused: false, steps: [], repositoryScope: undefined,
};
const required = new Set(["code-review"]);

describe("positive pre-merge approval gate", () => {
  it("blocks the FN-175 result-wipe shape", () => {
    expect(getTaskMergeBlocker({ ...base, workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan", status: "passed" }] }, { requiredPreMergeStepIds: required }))
      .toBe("task has enabled pre-merge workflow steps that never ran");
  });

  it("rejects a passed Code Review that has no reviewer verdict", () => {
    const task = { ...base, workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const, reviewKind: "code" as const, reviewInputFingerprint: "a" }] };
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "a" } } }))
      .toBe("task has enabled pre-merge workflow steps without a current approval");
  });

  it("requires an approving current diff fingerprint", () => {
    const task = { ...base, workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const, verdict: "APPROVE" as const, reviewKind: "code" as const, reviewInputFingerprint: "a" }] };
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "a" } } })).toBeUndefined();
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "b" } } }))
      .toBe("task has a pre-merge approval recorded against different content");
  });

  it("fails closed when source content cannot be proven", () => {
    const task = { ...base, workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const, verdict: "APPROVE" as const, reviewKind: "code" as const }] };
    expect(getTaskMergeBlocker(task, { requiredPreMergeStepIds: required, mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "git" } } }))
      .toBe("task has no provable approval for the content being merged");
  });

  it("binds an empty-input approval only to a still-empty singular diff", () => {
    const task = {
      ...base,
      workflowStepResults: [{
        workflowStepId: "code-review", workflowStepName: "Code", status: "passed" as const,
        verdict: "APPROVE" as const, reviewKind: "code" as const,
        reviewInputFingerprint: "empty-review-input:v1",
      }],
    };
    const empty = evaluatePreMergeApprovals(task, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "empty" } },
    });
    const populated = evaluatePreMergeApprovals(task, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "fingerprint", fingerprint: "a".repeat(64) } },
    });
    const unavailable = evaluatePreMergeApprovals(task, {
      requiredPreMergeStepIds: required,
      mergeContent: { kind: "singular", diff: { state: "unavailable", reason: "git" } },
    });

    expect(empty[0]?.state).toBe("approved");
    expect(populated[0]?.state).toBe("stale-content");
    expect(unavailable[0]?.state).toBe("unprovable-content");
  });
});

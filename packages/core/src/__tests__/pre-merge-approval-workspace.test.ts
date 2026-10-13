import { describe, expect, it } from "vitest";
import { evaluatePreMergeAdmissionDecision, evaluatePreMergeApprovals } from "../merge/pre-merge-approval.js";

const descriptor = {
  kind: "workspace" as const,
  repositories: { state: "captured" as const, fingerprints: { api: "api-a", web: "web-a" }, inScopeModified: ["api", "web"] },
};
const task = {
  workflowStepResults: [{ workflowStepId: "plan-review", workflowStepName: "Plan", status: "passed" as const, reviewKind: "plan" as const }],
  repositoryScope: {
    state: "confirmed" as const,
    revision: 3,
    repositories: ["api", "web"],
    reviewEvidence: { api: { fingerprint: "api-a", approvedAt: "2026-08-23" }, web: { fingerprint: "web-a", approvedAt: "2026-08-23" } },
  },
};

describe("workspace pre-merge approval evidence", () => {
  it("uses durable per-repository evidence after the code-review result wipe", () => {
    const results = evaluatePreMergeApprovals(task, { requiredPreMergeStepIds: new Set(["code-review"]), mergeContent: descriptor });
    expect(results).toEqual([{ workflowStepId: "code-review", state: "approved" }]);
  });

  it("names a repository when its required evidence is absent or stale", () => {
    const missing = evaluatePreMergeApprovals({ ...task, repositoryScope: { ...task.repositoryScope, reviewEvidence: { api: task.repositoryScope.reviewEvidence.api } } }, { requiredPreMergeStepIds: new Set(["code-review"]), mergeContent: descriptor });
    expect(missing[0]).toMatchObject({ state: "missing", repositories: ["web"] });
    const stale = evaluatePreMergeApprovals({ ...task, repositoryScope: { ...task.repositoryScope, reviewEvidence: { ...task.repositoryScope.reviewEvidence, web: { fingerprint: "old", approvedAt: "2026-08-23" } } } }, { requiredPreMergeStepIds: new Set(["code-review"]), mergeContent: descriptor });
    expect(stale[0]).toMatchObject({ state: "stale-content", repositories: ["web"] });
  });

  it("accepts workspace Code Review proof from repository evidence without a singular fingerprint", () => {
    const subject = {
      ...task,
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "passed" as const,
        reviewKind: "code" as const,
        verdict: "APPROVE" as const,
        repositoryScopeRevision: 3,
      }],
    };
    const options = { requiredPreMergeStepIds: new Set(["code-review"]), mergeContent: descriptor };
    const results = evaluatePreMergeApprovals(subject, options);
    expect(results).toEqual([{ workflowStepId: "code-review", state: "approved" }]);
    expect(evaluatePreMergeAdmissionDecision(subject, options).gates[0]).toMatchObject({
      workflowStepId: "code-review",
      state: "approved",
      selectedResult: { workflowStepId: "code-review", status: "passed", verdict: "APPROVE" },
    });
  });

  it("does not let an audited bypass waive missing workspace repository evidence", () => {
    const subject = {
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "skipped" as const,
        reviewKind: "code" as const,
        bypassedBy: "operator-1",
        bypassedAt: "2026-09-01T00:00:00.000Z",
        bypassReason: "Reviewer unavailable",
      }],
      repositoryScope: { ...task.repositoryScope, reviewEvidence: undefined },
    };
    const options = { requiredPreMergeStepIds: new Set(["code-review"]), mergeContent: descriptor };
    const results = evaluatePreMergeApprovals(subject, options);
    expect(results).toEqual([{ workflowStepId: "code-review", state: "missing", repositories: ["api", "web"] }]);
    expect(evaluatePreMergeAdmissionDecision(subject, options).gates[0]).toMatchObject({
      workflowStepId: "code-review",
      state: "missing",
      repositories: ["api", "web"],
      selectedResult: { workflowStepId: "code-review", status: "skipped" },
    });
  });

  it("keeps singular Code Review approval bound to its workflow-step fingerprint", () => {
    const subject = {
      workflowStepResults: [{
        workflowStepId: "code-review",
        workflowStepName: "Code Review",
        status: "passed" as const,
        reviewKind: "code" as const,
        verdict: "APPROVE" as const,
        reviewInputFingerprint: "singular-fingerprint",
      }],
    };
    const options = {
      requiredPreMergeStepIds: new Set(["code-review"]),
      mergeContent: { kind: "singular" as const, diff: { state: "captured" as const, fingerprint: "singular-fingerprint" } },
    };
    const results = evaluatePreMergeApprovals(subject, options);

    expect(results).toEqual([{ workflowStepId: "code-review", state: "approved" }]);
    expect(evaluatePreMergeAdmissionDecision(subject, options).gates[0]).toMatchObject({
      workflowStepId: "code-review",
      state: "approved",
      selectedResult: { workflowStepId: "code-review", status: "passed", reviewInputFingerprint: "singular-fingerprint" },
    });
  });
});

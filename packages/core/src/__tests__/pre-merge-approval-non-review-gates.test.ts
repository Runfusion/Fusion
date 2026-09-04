import { describe, expect, it } from "vitest";
import { evaluatePreMergeApprovals } from "../merge/pre-merge-approval.js";
import type { Task, WorkflowStepResult } from "../types.js";

/*
FNXC:PreMergeApproval 2026-08-24-07:10:
Measured failure this guards: on builtin:coding-ideas-v2 every card reached the merge and was
refused with "task has no provable approval for the content being merged", then looped. The required
pre-merge set for a review-column workflow is
`plan-review, verification, documentation-delivery, code-review`, but only a CONTENT REVIEW records
a `reviewInputFingerprint`. The deterministic verification gate (exit codes) and the
documentation/delivery gate have no diff to bind, so they fell through to the fingerprint comparison
and were classified `unprovable-content` — an unsatisfiable merge gate.
builtin:review-gated-coding carries the identical requirement set and the identical latent defect.
*/

const CONTENT_FINGERPRINT = "sha-current-content";

function taskWith(results: WorkflowStepResult[]): Pick<Task, "workflowStepResults" | "repositoryScope"> {
  return { workflowStepResults: results } as Pick<Task, "workflowStepResults" | "repositoryScope">;
}

function gate(workflowStepId: string, extra: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return { workflowStepId, phase: "pre-merge", status: "passed", ...extra } as WorkflowStepResult;
}

const singularContent = {
  kind: "singular" as const,
  diff: { state: "fingerprint" as const, fingerprint: CONTENT_FINGERPRINT },
};

describe("pre-merge approvals for non-review gates", () => {
  const required = new Set(["plan-review", "verification", "documentation-delivery", "code-review"]);

  it("approves a review-column workflow whose gates carry no diff fingerprint", () => {
    const approvals = evaluatePreMergeApprovals(
      taskWith([
        gate("plan-review", { reviewKind: "plan", verdict: "APPROVE" }),
        gate("verification"),
        gate("documentation-delivery", { verdict: "APPROVE" }),
        gate("code-review", { reviewKind: "code", verdict: "APPROVE", reviewInputFingerprint: CONTENT_FINGERPRINT }),
      ]),
      { requiredPreMergeStepIds: required, mergeContent: singularContent },
    );

    expect(approvals.filter((approval) => approval.state !== "approved")).toEqual([]);
  });

  /* The FN-180 guarantee must survive the carve-out: a code review is still diff-bound. */
  it("still refuses a code review recorded against different content", () => {
    const approvals = evaluatePreMergeApprovals(
      taskWith([
        gate("verification"),
        gate("code-review", { reviewKind: "code", verdict: "APPROVE", reviewInputFingerprint: "sha-stale" }),
      ]),
      { requiredPreMergeStepIds: new Set(["verification", "code-review"]), mergeContent: singularContent },
    );

    expect(approvals.find((approval) => approval.workflowStepId === "code-review")?.state).toBe("stale-content");
    expect(approvals.find((approval) => approval.workflowStepId === "verification")?.state).toBe("approved");
  });

  it("still refuses a code review that never bound any content", () => {
    const approvals = evaluatePreMergeApprovals(
      taskWith([gate("code-review", { reviewKind: "code", verdict: "APPROVE" })]),
      { requiredPreMergeStepIds: new Set(["code-review"]), mergeContent: singularContent },
    );

    expect(approvals[0]?.state).toBe("unprovable-content");
  });

  /* A non-review gate that DID bind content keeps being compared — the carve-out is not a blanket pass. */
  it("still compares a non-review gate that recorded its own fingerprint", () => {
    const approvals = evaluatePreMergeApprovals(
      taskWith([gate("verification", { reviewInputFingerprint: "sha-stale" })]),
      { requiredPreMergeStepIds: new Set(["verification"]), mergeContent: singularContent },
    );

    expect(approvals[0]?.state).toBe("stale-content");
  });

  it("still refuses a failed gate regardless of fingerprints", () => {
    const approvals = evaluatePreMergeApprovals(
      taskWith([gate("verification", { status: "failed" })]),
      { requiredPreMergeStepIds: new Set(["verification"]), mergeContent: singularContent },
    );

    expect(approvals[0]?.state).toBe("not-approved");
  });

  it("keeps a non-code gate content-independent for an empty singular diff", () => {
    const approvals = evaluatePreMergeApprovals(
      taskWith([gate("verification")]),
      {
        requiredPreMergeStepIds: new Set(["verification"]),
        mergeContent: { kind: "singular", diff: { state: "empty" } },
      },
    );

    expect(approvals[0]).toEqual({ workflowStepId: "verification", state: "approved" });
  });
});

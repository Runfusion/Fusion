import { describe, expect, it } from "vitest";
import type { WorkflowStepResult } from "@fusion/core";
import { reviewInputSignature } from "../executor/request-pre-merge-optional-step-fix.js";
import { deriveWorkspaceReviewRemediation } from "../executor/workspace-review-remediation.js";

/*
FNXC:ReviewRemediation 2026-08-31-08:24:
A signature that gets WRITTEN TO THE DATABASE may not contain NUL. PostgreSQL rejects `\u0000` in
text and jsonb with SQLSTATE 22P05, so a NUL separator turns every persisting write into a throw.

This is not hypothetical and it is not cheap. `reviewInputSignature` was in-memory-only when its
`\u0000` separator was chosen -- a sound choice then. FN-267 persisted it as
`remediationAttemptSignature`, and from that moment NO remediation claim could ever be written
against a real database: FN-270 and FN-273 held a real REVISE with critical findings and sat
blocked overnight with no fix steps and an empty timeline, through several fixes aimed at the wrong
layers. Every mock-store test stayed green throughout, because a JS string carries NUL happily.

The companion `review-remediation-claim.pg.test.ts` proves the real fenced write succeeds, but it
AUTO-SKIPS without PostgreSQL and therefore cannot guard the merge gate. This suite is the guard
that runs everywhere: it needs no database, because "contains no NUL" is checkable directly.
*/

function reviseResult(overrides: Partial<WorkflowStepResult> = {}): WorkflowStepResult {
  return {
    phase: "pre-merge",
    status: "failed",
    verdict: "REVISE",
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    reviewInputFingerprint: "0f597d26bb93f95ada977678e96d054973422b1347c241fdbb68dd51a4af2871",
    findings: [
      { id: "a", title: "t", body: "Add real-git cases.", filePath: "packages/engine/src/x.test.ts", line: 52, severity: "critical", resolution: "open" },
      { id: "b", title: "u", body: "Drive the owning entry points.", filePath: "packages/engine/src/y.test.ts", line: 29, severity: "critical", resolution: "open" },
    ],
    ...overrides,
  } as unknown as WorkflowStepResult;
}

function workspaceReviseResult(): WorkflowStepResult {
  return {
    phase: "pre-merge",
    status: "failed",
    verdict: "REVISE",
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    repositoryScopeRevision: 3,
    repositoryReviewOutcomes: [
      {
        repository: "api", status: "REVIEWED", verdict: "REVISE", fingerprint: "abc123",
        findings: [{ id: "w1", title: "t", body: "fix it", filePath: "api/src/a.ts", line: 4, severity: "critical", resolution: "open" }],
      },
      {
        repository: "web", status: "REVIEWED", verdict: "RETHINK", fingerprint: "def456",
        findings: [{ id: "w2", title: "t", body: "rethink it", filePath: "web/src/b.ts", line: 9, severity: "critical", resolution: "open" }],
      },
    ],
  } as unknown as WorkflowStepResult;
}

describe("a persisted review signature must be storable in PostgreSQL", () => {
  it.each([
    ["singular REVISE", () => reviewInputSignature(reviseResult())],
    ["workspace multi-repository REVISE", () => reviewInputSignature(workspaceReviseResult())],
    ["workspace remediation input signature", () => deriveWorkspaceReviewRemediation(workspaceReviseResult())?.inputSignature],
  ])("%s carries no NUL", (_case, build) => {
    const signature = build();
    expect(signature).toBeTruthy();
    expect(signature).not.toContain("\u0000");
  });

  /*
  The separator still has to SEPARATE. Guarding only "no NUL" would be satisfied by concatenating
  the fields, which silently collapses distinct review rounds onto one signature and would defeat
  both the claim and the repeat-unchanged hold.
  */
  it("still distinguishes rounds that differ only at a field boundary", () => {
    const left = reviewInputSignature(reviseResult({ workflowStepId: "code", reviewInputFingerprint: "review-x" } as never));
    const right = reviewInputSignature(reviseResult({ workflowStepId: "code-review", reviewInputFingerprint: "x" } as never));
    expect(left).not.toEqual(right);
  });

  it("still returns the same signature for the same review input", () => {
    expect(reviewInputSignature(reviseResult())).toEqual(reviewInputSignature(reviseResult()));
  });
});

import { describe, expect, it } from "vitest";
import { deriveWorkspaceReviewRemediation } from "../executor/workspace-review-remediation.js";

function result(findings: any[], repositoryScopeRevision: number | undefined = 1) {
  return {
    workflowStepId: "code-review",
    repositoryScopeRevision,
    repositoryReviewOutcomes: [{
      repository: "Merge",
      status: "REVIEWED" as const,
      verdict: "REVISE",
      fingerprint: "tree-1",
      findings,
    }],
  };
}

describe("deriveWorkspaceReviewRemediation", () => {
  it("does not target a repository for a finding-less REVISE", () => {
    expect(deriveWorkspaceReviewRemediation(result([]))).toBeUndefined();
  });

  it("does not target a repository whose findings are all resolved", () => {
    expect(deriveWorkspaceReviewRemediation(result([{
      id: "resolved",
      title: "resolved",
      body: "already fixed",
      severity: "critical",
      resolution: "resolved-in-review",
    }]))).toBeUndefined();
  });

  it("targets the first repository with an open finding", () => {
    expect(deriveWorkspaceReviewRemediation(result([{
      id: "open",
      title: "open",
      body: "fix the guard",
      severity: "critical",
      filePath: "src/a.ts",
    }]))).toMatchObject({
      scopeRevision: 1,
      repository: "Merge",
      inputSignature: expect.stringContaining("tree-1"),
    });
  });
});

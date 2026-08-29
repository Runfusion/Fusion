import { describe, expect, it } from "vitest";
import { archiveArbitratedWorkflowStepFailure, getTaskMergeBlocker } from "@fusion/core";

function failed(workflowStepId: string, startedAt: string) {
  return {
    workflowStepId, workflowStepName: workflowStepId, phase: "pre-merge" as const,
    status: "failed" as const, verdict: "REVISE" as const, startedAt, completedAt: `${startedAt}-done`,
    findings: [{ id: `${workflowStepId}-finding`, title: "Must fix", body: "Blocking issue" }],
  };
}

/*
FNXC:ReviewConvergenceEvidence 2026-08-22-06:41:
FN-149 arbitration authority is intentionally narrower than an operator bypass. These tests pin the
single-gate CAS fence: a ruling cannot release a sibling review gate or an attempt the arbiter did
not inspect, and a partial ruling remains blocking.
*/
describe("FN-149 fenced arbitration release", () => {
  it("releases only the adjudicated code-review gate while a sibling failed gate still blocks", () => {
    const code = failed("code-review", "code-start");
    const browser = failed("browser-verification", "browser-start");
    const released = archiveArbitratedWorkflowStepFailure([code, browser], {
      workflowStepId: "code-review", expectedStartedAt: code.startedAt, expectedCompletedAt: code.completedAt,
      expectedVerdict: "REVISE", decision: "UPHOLD_IMPLEMENTER", bindingFindingCount: 0,
      arbitratedAt: "2026-08-22T06:41:00.000Z", arbitrationNotes: "Implementer position upheld.",
    });
    expect(released).toMatchObject({ applied: true });
    expect(released.results?.[0]).toMatchObject({ status: "skipped", arbitrationDecision: "UPHOLD_IMPLEMENTER" });
    expect(released.results?.[1]).toEqual(browser);
    expect(getTaskMergeBlocker({ column: "in-review", steps: [], workflowStepResults: released.results } as any, { skipColumnIdentityCheck: true }))
      .toBe("task has failed pre-merge workflow steps");
  });

  it.each([
    ["attempt-changed", { expectedStartedAt: "different" }],
    ["binding-findings-survive", { bindingFindingCount: 1 }],
  ] as const)("refuses %s without mutating the failed gate", (reason, patch) => {
    const code = failed("code-review", "code-start");
    const result = archiveArbitratedWorkflowStepFailure([code], {
      workflowStepId: "code-review", expectedStartedAt: code.startedAt, expectedCompletedAt: code.completedAt,
      expectedVerdict: "REVISE", decision: "SPLIT", bindingFindingCount: 0,
      arbitratedAt: "2026-08-22T06:41:00.000Z", arbitrationNotes: "Partial ruling.", ...patch,
    });
    expect(result).toMatchObject({ applied: false, reason, results: [code] });
  });
});

import { describe, expect, it } from "vitest";
import type { WorkflowStepResult } from "@fusion/core";
import { clearTerminalWorkflowStepFailures } from "../executor.js";

/*
FNXC:ReviewLeniency 2026-07-02-01:00:
Retrying a task must clear prior FAILURE states — including optional gate nodes
like code-review — while keeping passed/skipped/pending evidence so a
previously-passed Plan Review is not re-run. These pin the pure helper wired into
sendTaskBackForFix and routeGraphFailureToExecutionResume.
*/

function result(overrides: Partial<WorkflowStepResult> & Pick<WorkflowStepResult, "workflowStepId" | "status">): WorkflowStepResult {
  return {
    workflowStepName: overrides.workflowStepId,
    phase: "pre-merge",
    ...overrides,
  } as WorkflowStepResult;
}

describe("clearTerminalWorkflowStepFailures", () => {
  it("drops failed and advisory_failure results (incl. optional gate nodes)", () => {
    const input = [
      result({ workflowStepId: "plan-review", status: "passed" }),
      result({ workflowStepId: "code-review", status: "failed" }),
      result({ workflowStepId: "browser-verification", status: "advisory_failure" }),
    ];
    expect(clearTerminalWorkflowStepFailures(input)).toEqual([
      result({ workflowStepId: "plan-review", status: "passed" }),
    ]);
  });

  it("keeps passed / skipped / pending evidence untouched", () => {
    const input = [
      result({ workflowStepId: "plan-review", status: "passed" }),
      result({ workflowStepId: "code-review", status: "skipped" }),
      result({ workflowStepId: "browser-verification", status: "pending" }),
    ];
    expect(clearTerminalWorkflowStepFailures(input)).toEqual(input);
  });

  it("returns the SAME array reference when nothing was terminal (no-op write guard)", () => {
    const input = [result({ workflowStepId: "plan-review", status: "passed" })];
    expect(clearTerminalWorkflowStepFailures(input)).toBe(input);
  });

  it("returns a new array when at least one failure is dropped", () => {
    const input = [
      result({ workflowStepId: "plan-review", status: "passed" }),
      result({ workflowStepId: "code-review", status: "failed" }),
    ];
    expect(clearTerminalWorkflowStepFailures(input)).not.toBe(input);
  });

  it("handles undefined/empty input", () => {
    expect(clearTerminalWorkflowStepFailures(undefined)).toEqual([]);
    expect(clearTerminalWorkflowStepFailures([])).toEqual([]);
  });

  /*
  FNXC:WorkflowStepResults 2026-07-09-00:50:
  FN-7727: explicit retry clean-slate decision — dropping a failed/advisory_failure
  entry that carries `priorAttempts` history must not throw, and the whole entry
  (including its history) is dropped, since retry is a deliberate clean slate
  distinct from the self-healing recovery re-run path (which goes through
  upsertWorkflowStepResult instead and preserves history).
  */
  it("does not throw on and fully drops a failed entry carrying priorAttempts history", () => {
    const withHistory = result({
      workflowStepId: "code-review",
      status: "failed",
      priorAttempts: [
        result({ workflowStepId: "code-review", status: "failed", startedAt: "T1" }),
        result({ workflowStepId: "code-review", status: "advisory_failure", startedAt: "T2" }),
      ],
    });
    const input = [
      result({ workflowStepId: "plan-review", status: "passed" }),
      withHistory,
    ];
    expect(() => clearTerminalWorkflowStepFailures(input)).not.toThrow();
    expect(clearTerminalWorkflowStepFailures(input)).toEqual([
      result({ workflowStepId: "plan-review", status: "passed" }),
    ]);
  });
});

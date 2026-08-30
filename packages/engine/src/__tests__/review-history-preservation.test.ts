import { describe, expect, it, vi } from "vitest";
import {
  MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS,
  archiveTerminalWorkflowStepFailures,
  classifyReviewLease,
  upsertWorkflowStepResult,
  type WorkflowStepResult,
} from "@fusion/core";
import { performWorkflowRerunBounce } from "../executor/workflow-rerun-bounce.js";
import { clearTerminalStepFailuresForRetry as clearTerminalStepFailuresForRetryStore } from "../executor/clear-terminal-step-failures-for-retry.js";
import { routeGraphFailureToExecutionResume } from "../executor/route-graph-failure-to-execution-resume.js";
import { moveTaskToReplanColumn } from "../execution/replan-target.js";

function revise(startedAt: string, output = "round-one feedback"): WorkflowStepResult {
  return {
    workflowStepId: "code-review",
    workflowStepName: "Code Review",
    phase: "pre-merge",
    status: "failed",
    startedAt,
    completedAt: `${startedAt}-complete`,
    verdict: "REVISE",
    output,
    findings: [
      { id: "reset-retry", title: "Reset must remain retryable", body: "Preserve the retry path.", severity: "high" },
      { id: "transaction", title: "Transaction boundary", body: "Explain atomic rollback.", severity: "medium" },
    ],
  };
}

/*
FNXC:ReviewConvergenceEvidence 2026-08-22-06:41:
FN-149 must prove the FN-123 regression through the automatic rerun bounce, not only at its shared
archival helper. A later pending dispatch retains the whole failed ledger after both WIP and review
lane production bounces; explicit retry remains covered by the destructive clear helper's FN-7727 tests.
*/
describe("FN-149 automatic remediation history preservation", () => {
  function expectRoundTwoHistory(results: WorkflowStepResult[] | undefined) {
    const roundTwo = upsertWorkflowStepResult(results, {
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge",
      status: "pending", startedAt: "round-two",
    });
    expect(roundTwo[0].priorAttempts?.[0]).toMatchObject({
      status: "failed", verdict: "REVISE", output: "round-one feedback",
      findings: revise("irrelevant").findings,
    });
  }

  it.each(["in-progress", "in-review"] as const)("drives the %s rerun bounce through its production archival call", async (column) => {
    const row = {
      id: "FN-149", column, dependencies: [], steps: [{ name: "Fix review finding", status: "pending", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "Fix review finding" } }], currentStep: 0, log: [],
      createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
      workflowStepResults: [revise("2026-08-22T01:00:00.000Z")],
    } as any;
    const moveTask = vi.fn(async (_id: string, destination: string) => { row.column = destination; });
    const store = { getTask: vi.fn(async () => row), moveTask, updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)) };
    const clearTerminalStepFailuresForRetry = vi.fn(async (_id: string, mode: "archive" | "clear") =>
      clearTerminalStepFailuresForRetryImpl(mode));
    const clearTerminalStepFailuresForRetryImpl = async (mode: "archive" | "clear") =>
      clearTerminalStepFailuresForRetryStore({ store, getRunContextFor: () => undefined } as any, row.id, mode);
    const outcome = await performWorkflowRerunBounce({
      store,
      workflowRerunPending: new Set(),
      getExecutionPauseLabel: vi.fn(async () => null),
      resolveResumeLanes: vi.fn(async () => ({ wip: "in-progress", review: "in-review" })),
      clearTerminalStepFailuresForRetry,
    } as any, row.id, "/worktree");

    expect(outcome).toBe("bounced");
    expect(clearTerminalStepFailuresForRetry).toHaveBeenCalledWith(row.id, "archive");
    if (column === "in-review") {
      expect(moveTask).toHaveBeenCalledWith(row.id, "in-progress", expect.objectContaining({
        workflowMoveSource: "workflow-remediation",
        lifecycleReason: "code-review-revise-remediation",
      }));
    } else {
      expect(moveTask).not.toHaveBeenCalled();
    }
    expectRoundTwoHistory(row.workflowStepResults);
  });

  it("archives through the graph-failure execution-resume production route", async () => {
    const row = {
      id: "FN-149-graph", column: "in-review", dependencies: [], steps: [], currentStep: 0, log: [],
      createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
      workflowStepResults: [revise("2026-08-22T01:00:00.000Z")],
    } as any;
    const store = {
      getTask: vi.fn(async () => row), getSettings: vi.fn(async () => ({})),
      logEntry: vi.fn(async () => {}), updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      moveTask: vi.fn(async (_id, column, options) => { row.column = column; row.moveOptions = options; }),
    };
    const routed = await routeGraphFailureToExecutionResume({
      store, getRunContextFor: () => undefined,
      resolveResumeLanes: vi.fn(async () => ({ review: "in-review", wip: "in-progress", wipDeclared: true })),
      clearTerminalStepFailuresForRetry: (id, mode) => clearTerminalStepFailuresForRetryStore({ store, getRunContextFor: () => undefined } as any, id, mode),
      persistTokenUsage: vi.fn(async () => {}), isRemediationGraphNode: vi.fn(async () => false),
    } as any, row, "code-review-remediation", "retry");
    expect(routed).toBe(false);
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(row.workflowStepResults?.[0]).toMatchObject({ status: "failed", verdict: "REVISE" });
  });

  it("contains a remediation-provenanced review-lane replan before archiving", async () => {
    const row = { id: "FN-149-replan", column: "in-review", workflowStepResults: [revise("2026-08-22T01:00:00.000Z")] } as any;
    const store = {
      getTask: vi.fn(async () => row),
      moveTask: vi.fn(async (_id, column, options) => { row.column = column; row.moveOptions = options; }),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
    };
    const target = await moveTaskToReplanColumn(
      store as any,
      row,
      "plan-review-revise-replan",
      "todo",
      { workflowMoveSource: "workflow-remediation" },
    );
    expect(target).toEqual({ moved: false, reason: "review-lane-source", column: "in-review" });
    expect(store.moveTask).not.toHaveBeenCalled();
    await clearTerminalStepFailuresForRetryStore({ store, getRunContextFor: () => undefined } as any, row.id, "archive");
    expectRoundTwoHistory(row.workflowStepResults);
  });

  it("contains an unprovenanced review-lane replan without erasing review evidence", async () => {
    const row = { id: "FN-149-unprovenanced", column: "in-review", workflowStepResults: [revise("2026-08-22T01:00:00.000Z")] } as any;
    const store = {
      getTask: vi.fn(async () => row),
      // Model the production reopen hook: only the remediation-owned move preserves review evidence.
      moveTask: vi.fn(async (_id, column, options) => {
        row.column = column;
        if (options?.workflowMoveSource !== "workflow-remediation") row.workflowStepResults = undefined;
      }),
      getTaskWorkflowSelection: vi.fn(async () => undefined), getWorkflowDefinition: vi.fn(async () => undefined),
    };
    const result = await moveTaskToReplanColumn(store as any, row, "plan-review-revise-replan", "todo");
    expect(result).toEqual({ moved: false, reason: "review-lane-source", column: "in-review" });
    expect(store.moveTask).not.toHaveBeenCalled();
    expectRoundTwoHistory(row.workflowStepResults);
  });

  it("fails closed when a pause arrives after the bounce move", async () => {
    const row = {
      id: "FN-149-deferred", column: "in-review", dependencies: [], steps: [{ name: "Fix review finding", status: "pending", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "Fix review finding" } }], currentStep: 0, log: [],
      createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
      workflowStepResults: [revise("2026-08-22T01:00:00.000Z")],
    } as any;
    const clearTerminalStepFailuresForRetry = vi.fn(async () => clearTerminalStepFailuresForRetryStore({
      store: { getTask: async () => row, updateTask: async (_id: string, patch: object) => Object.assign(row, patch) },
      getRunContextFor: () => undefined,
    } as any, row.id, "archive"));
    const pause = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("global pause");
    const outcome = await performWorkflowRerunBounce({
      store: { getTask: async () => row, moveTask: async (_id: string, column: string) => { row.column = column; }, updateTask: async (_id: string, patch: object) => Object.assign(row, patch), logEntry: async () => undefined },
      workflowRerunPending: new Set(), getExecutionPauseLabel: pause,
      resolveResumeLanes: async () => ({ wip: "in-progress", review: "in-review" }), clearTerminalStepFailuresForRetry,
    } as any, row.id, "/worktree");
    expect(outcome).toBe("deferred-paused");
    expect(clearTerminalStepFailuresForRetry).not.toHaveBeenCalled();
    expect(row.workflowStepResults[0]).toMatchObject({ status: "failed", verdict: "REVISE" });
  });

  it("retains plan-review episode boundaries when archiving a failed gate", () => {
    const failedPlan = { ...revise("2026-08-22T01:00:00.000Z"), workflowStepId: "plan-review", planReviewAttemptCount: 2, supersededAt: "episode-boundary" };
    const archived = archiveTerminalWorkflowStepFailures([failedPlan])[0];
    expect(archived).toMatchObject({ status: "skipped", planReviewAttemptCount: 2, supersededAt: "episode-boundary" });
    expect(archived.priorAttempts?.[0]).toMatchObject({ planReviewAttemptCount: 2, supersededAt: "episode-boundary" });
  });

  it("keeps explicit operator retry destructive while automatic archival preserves history", async () => {
    const row = { id: "FN-149-clear", workflowStepResults: [revise("2026-08-22T01:00:00.000Z")] } as any;
    const store = { getTask: vi.fn(async () => row), updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)) };
    // FN-7727/FN-7227: an operator explicitly requesting retry begins from a clean failure ledger.
    await clearTerminalStepFailuresForRetryStore({ store, getRunContextFor: () => undefined } as any, row.id, "clear");
    expect(row.workflowStepResults ?? []).toHaveLength(0);
  });

  it("keeps a carrier settled while a graph dispatch creates a fresh gate attempt", () => {
    const carrier = archiveTerminalWorkflowStepFailures([revise("2026-08-22T01:00:00.000Z")])!;
    expect(classifyReviewLease(carrier, "code-review", Date.now()).kind).toBe("settled");
    const dispatched = upsertWorkflowStepResult(carrier, {
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge",
      status: "pending", startedAt: "2026-08-22T01:02:00.000Z",
    });
    expect(dispatched[0].priorAttempts?.[0].verdict).toBe("REVISE");
  });

  it("keeps repeated archival newest-first, bounded, and single-level", () => {
    let results: WorkflowStepResult[] | undefined = [revise("T0", "attempt-0")];
    for (let index = 1; index <= MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS + 2; index += 1) {
      results = archiveTerminalWorkflowStepFailures(results, `A${index}`);
      results = upsertWorkflowStepResult(results, revise(`T${index}`, `attempt-${index}`));
    }
    const history = results?.[0].priorAttempts ?? [];
    expect(history).toHaveLength(MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS);
    expect(history[0].output).toBe(`attempt-${MAX_WORKFLOW_STEP_PRIOR_ATTEMPTS + 1}`);
    expect(history.every((attempt) => attempt.priorAttempts === undefined)).toBe(true);
  });
});

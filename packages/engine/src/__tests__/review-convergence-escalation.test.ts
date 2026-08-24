import { describe, expect, it, vi } from "vitest";
import { routeReviewConvergenceLadder } from "../executor/review-convergence-ladder.js";

function task() {
  return {
    id: "FN-149", column: "in-review", dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
    workflowStepResults: [{
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge",
      status: "failed", verdict: "REVISE", startedAt: "2026-08-22T01:00:00.000Z",
    }],
  } as any;
}

/*
FNXC:ReviewConvergenceEvidence 2026-08-22-06:41:
FN-149 replaces an unchanged-review human park with one lifecycle-effective escalation. The ladder
must return `escalated` only after exactly one remediation dispatch, so graph failure handling does
not terminalize an otherwise recoverable review cycle.
*/
describe("FN-149 unchanged review escalation", () => {
  it("claims stage one and dispatches one alternate-model remediation without an approval park", async () => {
    const row = task();
    const updateTask = vi.fn(async (_id, patch) => Object.assign(row, patch));
    const updateTaskAtomic = vi.fn(async (_id, callback) => {
      const patch = await callback(row);
      if (patch) Object.assign(row, patch);
      return row;
    });
    const sendTaskBackForFix = vi.fn(async () => {});
    const store = {
      getTask: vi.fn(async () => row), getSettings: vi.fn(async () => ({
        reviewConvergenceEscalationEnabled: true,
        reviewConvergenceEscalationProvider: "mock",
        reviewConvergenceEscalationModelId: "strong-reviewer",
      })), updateTask, updateTaskAtomic,
    };
    const outcome = await routeReviewConvergenceLadder({ store, sendTaskBackForFix, getRunContextFor: () => undefined } as any, row.id, {
      kind: "repeat-unchanged", workflowStepId: "code-review", stepName: "Code Review", feedback: "same result", attempt: 2,
    });
    expect(outcome).toBe("escalated");
    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(row.reviewConvergenceStage).toBe(1);
    expect(row).not.toHaveProperty("awaitingApprovalReason");
  });

  it("declines when the gate clears between the initial read and atomic stage claim", async () => {
    const row = task();
    const store = {
      getTask: vi.fn(async () => ({ ...row, workflowStepResults: [...row.workflowStepResults] })),
      getSettings: vi.fn(async () => ({ reviewConvergenceEscalationEnabled: true, reviewConvergenceEscalationProvider: "mock", reviewConvergenceEscalationModelId: "strong" })),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        // The reviewer has approved after the caller's preliminary live-failure read.
        row.workflowStepResults[0].status = "passed";
        const patch = await callback(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
    };
    await expect(routeReviewConvergenceLadder({ store, sendTaskBackForFix: vi.fn(async () => {}), getRunContextFor: () => undefined } as any, row.id, {
      kind: "repeat-unchanged", workflowStepId: "code-review", stepName: "Code Review", feedback: "stale", attempt: 2,
    })).resolves.toBe("declined");
    expect(row).not.toHaveProperty("reviewConvergenceStage");
  });

  it("releases its stage claim instead of reporting escalation when no replan target exists", async () => {
    const row = task();
    const store = {
      getTask: vi.fn(async () => row), getSettings: vi.fn(async () => ({})),
      getTaskWorkflowSelection: vi.fn(async () => undefined), getWorkflowDefinition: vi.fn(async () => undefined),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
    };
    const outcome = await routeReviewConvergenceLadder({ store, sendTaskBackForFix: vi.fn(async () => {}), getRunContextFor: () => undefined } as any, row.id, {
      kind: "repeat-unchanged", workflowStepId: "code-review", stepName: "Code Review", feedback: "same result", attempt: 2,
    });
    expect(outcome).toBe("declined");
    expect(row).toMatchObject({ reviewConvergenceStage: 0, reviewConvergenceEscalationCount: 0 });
  });

  it("writes the Level-4 dossier and bounded human-escalation audit only after automatic stages", async () => {
    const row = {
      ...task(),
      reviewConvergenceStage: 2,
      reviewConvergenceEscalationCount: 2,
      workflowStepResults: [{
        ...task().workflowStepResults[0],
        findings: [{
          id: "rollback", title: "Rollback proof", body: "Show why rollback is safe.",
          disputedAt: "2026-08-22T02:00:00.000Z", disputeRationale: "The transaction already guarantees it.",
        }],
      }],
    };
    const logEntry = vi.fn(async () => {});
    const recordRunAuditEvent = vi.fn(async () => {});
    const store = {
      getTask: vi.fn(async () => row), getSettings: vi.fn(async () => ({})),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
      logEntry, recordRunAuditEvent,
    };
    const outcome = await routeReviewConvergenceLadder({
      store,
      sendTaskBackForFix: vi.fn(async () => {}),
      getRunContextFor: () => ({ agentId: "agent-review", runId: "run-review" }),
    } as any, row.id, {
      kind: "repeat-unchanged", workflowStepId: "code-review", stepName: "Code Review", feedback: "same result", attempt: 4,
    });

    expect(outcome).toBe("human-escalated");
    expect(logEntry).toHaveBeenCalledWith(
      row.id,
      "Review convergence exhausted — awaiting operator arbitration",
      expect.stringContaining("Reviewer position\n- Reviewer: rollback — Rollback proof"),
      expect.anything(),
    );
    expect(logEntry.mock.calls[0][2]).toContain("Implementer on rollback: The transaction already guarantees it.");
    expect(logEntry.mock.calls[0][2]).toContain("No arbitration ruling was available.");
    expect(recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "task:review-convergence-human-escalation",
      metadata: expect.objectContaining({ workflowStepId: "code-review", stage: 3, outcome: "awaiting-approval" }),
    }));
    expect(JSON.stringify(recordRunAuditEvent.mock.calls[0][0])).not.toContain("transaction already guarantees");
  });

});

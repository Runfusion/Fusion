import { describe, expect, it, vi } from "vitest";
import { routeReviewConvergenceLadder, type ReviewConvergenceStop } from "../executor/review-convergence-ladder.js";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "FN-224", column: "in-review", dependencies: [], worktree: "/tmp/review-convergence",
    steps: [{ name: "Fix review finding", status: "pending", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "Fix review finding" } }],
    currentStep: 0, log: [], createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z",
    workflowStepResults: [{
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge",
      status: "failed", verdict: "REVISE", startedAt: "2026-08-28T01:00:00.000Z",
    }],
    ...overrides,
  } as any;
}

const repeatStop: ReviewConvergenceStop = {
  kind: "repeat-unchanged",
  workflowStepId: "code-review",
  stepName: "Code Review",
  feedback: "same result",
  attempt: 2,
};

function harness(settings: Record<string, unknown>, row = task()) {
  const atomicPatches: Record<string, unknown>[] = [];
  const logEntry = vi.fn(async () => {});
  const recordRunAuditEvent = vi.fn(async () => {});
  const sendTaskBackForFix = vi.fn(async () => {});
  const store = {
    getTask: vi.fn(async () => row),
    getSettings: vi.fn(async () => settings),
    getTaskWorkflowSelection: vi.fn(async () => undefined),
    getWorkflowDefinition: vi.fn(async () => undefined),
    getWorkflowSettingValues: vi.fn(async () => ({})),
    getWorkflowSettingsProjectId: vi.fn(() => undefined),
    updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
    updateTaskAtomic: vi.fn(async (_id, callback) => {
      const patch = await callback(row);
      if (patch) {
        atomicPatches.push({ ...patch });
        Object.assign(row, patch);
      }
      return row;
    }),
    logEntry,
    recordRunAuditEvent,
  };
  const run = (stop: ReviewConvergenceStop = repeatStop) => routeReviewConvergenceLadder({
    store,
    sendTaskBackForFix,
    getRunContextFor: () => ({ agentId: "reviewer", runId: "run-224" }),
  } as any, row.id, stop);
  return { row, store, atomicPatches, logEntry, recordRunAuditEvent, sendTaskBackForFix, run };
}

function escalationAudit(subject: ReturnType<typeof harness>) {
  return subject.recordRunAuditEvent.mock.calls
    .map((call) => call[0])
    .find((event) => event.mutationType === "task:review-convergence-escalation");
}

describe("FN-224 frozen review escalation candidate chain", () => {
  it("(a) uses a distinct dedicated target", async () => {
    const subject = harness({
      reviewConvergenceEscalationEnabled: true,
      reviewConvergenceEscalationProvider: "dedicated-provider",
      reviewConvergenceEscalationModelId: "dedicated-model",
    });

    await expect(subject.run()).resolves.toBe("escalated");

    expect(subject.row).toMatchObject({ reviewConvergenceStage: 1, modelProvider: "dedicated-provider", modelId: "dedicated-model" });
    expect(subject.sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(escalationAudit(subject)?.metadata).toMatchObject({ mode: "alternate-model", hasModelTarget: true, escalationSource: "dedicated" });
  });

  it("(b) uses a configured execution fallback when no dedicated target exists", async () => {
    const subject = harness({
      executionFallbackProvider: "fallback-provider",
      executionFallbackModelId: "fallback-model",
    }, task({ modelProvider: "current-provider", modelId: "current-model" }));

    await expect(subject.run()).resolves.toBe("escalated");

    expect(subject.row).toMatchObject({ reviewConvergenceStage: 1, modelProvider: "fallback-provider", modelId: "fallback-model" });
    expect(escalationAudit(subject)?.metadata).toMatchObject({ mode: "alternate-model", hasModelTarget: true, escalationSource: "execution-fallback" });
  });

  it("(c) discards an identical dedicated target and still uses the distinct execution fallback", async () => {
    const subject = harness({
      reviewConvergenceEscalationEnabled: true,
      reviewConvergenceEscalationProvider: "current-provider",
      reviewConvergenceEscalationModelId: "current-model",
      executionFallbackProvider: "fallback-provider",
      executionFallbackModelId: "fallback-model",
    }, task({ modelProvider: "current-provider", modelId: "current-model" }));

    await expect(subject.run()).resolves.toBe("escalated");

    expect(subject.row).toMatchObject({ reviewConvergenceStage: 1, modelProvider: "fallback-provider", modelId: "fallback-model" });
    expect(subject.sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(escalationAudit(subject)?.metadata).toMatchObject({ escalationSource: "execution-fallback", hasModelTarget: true });
  });

  it("(d) skips directly to arbitration when the dedicated target is identical and no fallback exists", async () => {
    const subject = harness({
      reviewConvergenceEscalationEnabled: true,
      reviewConvergenceEscalationProvider: "current-provider",
      reviewConvergenceEscalationModelId: "current-model",
    }, task({ modelProvider: "current-provider", modelId: "current-model" }));

    await expect(subject.run()).resolves.toBe("released");

    expect(subject.atomicPatches[0]).toMatchObject({ reviewConvergenceStage: 2 });
    expect(subject.sendTaskBackForFix).not.toHaveBeenCalled();
    expect(subject.logEntry).toHaveBeenCalledWith(subject.row.id, "Review convergence escalation source: none", expect.stringContaining("dedicated-target-not-distinct"), expect.anything());
    expect(escalationAudit(subject)?.metadata).toMatchObject({ stage: 2, mode: "arbitration", hasModelTarget: false, escalationSource: "none" });
  });

  it("(e) skips to arbitration when both dedicated and fallback targets are identical", async () => {
    const subject = harness({
      reviewConvergenceEscalationEnabled: true,
      reviewConvergenceEscalationProvider: "current-provider",
      reviewConvergenceEscalationModelId: "current-model",
      executionFallbackProvider: "current-provider",
      executionFallbackModelId: "current-model",
    }, task({ modelProvider: "current-provider", modelId: "current-model" }));

    await expect(subject.run()).resolves.toBe("released");

    expect(subject.atomicPatches[0]).toMatchObject({ reviewConvergenceStage: 2 });
    expect(subject.sendTaskBackForFix).not.toHaveBeenCalled();
  });

  it("(f) skips to arbitration under the shipped empty settings", async () => {
    const subject = harness({});

    await expect(subject.run()).resolves.toBe("released");

    expect(subject.atomicPatches[0]).toMatchObject({ reviewConvergenceStage: 2, reviewConvergenceEscalationCount: 1 });
    expect(subject.sendTaskBackForFix).not.toHaveBeenCalled();
  });

  it("(g) rejects a candidate equal to the effective execution model when the task has no persisted pair", async () => {
    const subject = harness({
      executionProvider: "effective-provider",
      executionModelId: "effective-model",
      reviewConvergenceEscalationEnabled: true,
      reviewConvergenceEscalationProvider: "effective-provider",
      reviewConvergenceEscalationModelId: "effective-model",
    });

    await expect(subject.run()).resolves.toBe("released");

    expect(subject.atomicPatches[0]).toMatchObject({ reviewConvergenceStage: 2 });
    expect(subject.sendTaskBackForFix).not.toHaveBeenCalled();
  });

  it("(h) keeps budget exhaustion on stage one with empty settings", async () => {
    const subject = harness({});

    await expect(subject.run({ ...repeatStop, kind: "budget-exhausted" })).resolves.toBe("escalated");

    expect(subject.atomicPatches[0]).toMatchObject({ reviewConvergenceStage: 1 });
    expect(subject.sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(escalationAudit(subject)?.metadata).toMatchObject({ mode: "executor-remediation", hasModelTarget: false, escalationSource: "none" });
  });

  it("(i) keeps budget exhaustion on stage one when the dedicated target is identical", async () => {
    const subject = harness({
      reviewConvergenceEscalationEnabled: true,
      reviewConvergenceEscalationProvider: "current-provider",
      reviewConvergenceEscalationModelId: "current-model",
    }, task({ modelProvider: "current-provider", modelId: "current-model" }));

    await expect(subject.run({ ...repeatStop, kind: "budget-exhausted" })).resolves.toBe("escalated");

    expect(subject.atomicPatches[0]).toMatchObject({ reviewConvergenceStage: 1 });
    expect(subject.sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(escalationAudit(subject)?.metadata).toMatchObject({ mode: "executor-remediation", hasModelTarget: false, escalationSource: "none" });
  });

  it("declines when the gate clears between the preliminary read and atomic claim", async () => {
    const row = task();
    const subject = harness({
      reviewConvergenceEscalationEnabled: true,
      reviewConvergenceEscalationProvider: "mock",
      reviewConvergenceEscalationModelId: "strong",
    }, row);
    subject.store.getTask.mockResolvedValueOnce({ ...row, workflowStepResults: [...row.workflowStepResults] });
    subject.store.updateTaskAtomic.mockImplementationOnce(async (_id, callback) => {
      row.workflowStepResults[0].status = "passed";
      const patch = await callback(row);
      if (patch) Object.assign(row, patch);
      return row;
    });

    await expect(subject.run()).resolves.toBe("declined");
    expect(row).not.toHaveProperty("reviewConvergenceStage");
  });

  it("records the convergence dossier and releases Code Review without a human park", async () => {
    const row = task({
      reviewConvergenceStage: 2,
      reviewConvergenceEscalationCount: 2,
      workflowStepResults: [{
        ...task().workflowStepResults[0],
        findings: [{
          id: "rollback", title: "Rollback proof", body: "Show why rollback is safe.",
          disputedAt: "2026-08-28T02:00:00.000Z", disputeRationale: "The transaction already guarantees it.",
        }],
      }],
    });
    const subject = harness({}, row);

    await expect(subject.run({ ...repeatStop, attempt: 4 })).resolves.toBe("released");

    const dossierCall = subject.logEntry.mock.calls.find((call) => call[1] === "Review convergence exhausted — released as non-blocking");
    expect(dossierCall?.[2]).toContain("Reviewer position\n- Reviewer: rollback — Rollback proof");
    expect(dossierCall?.[2]).toContain("Implementer on rollback: The transaction already guarantees it.");
    expect(row).not.toHaveProperty("awaitingApprovalReason");
  });

  it("preserves the operator-authored Plan Review replan-cap hold", async () => {
    const row = task({
      reviewConvergenceStage: 2,
      reviewConvergenceEscalationCount: 2,
      workflowStepResults: [{
        ...task().workflowStepResults[0],
        workflowStepId: "plan-review",
        workflowStepName: "Plan Review",
      }],
    });
    const subject = harness({}, row);

    await expect(subject.run({
      kind: "plan-review-cap",
      workflowStepId: "plan-review",
      stepName: "Plan Review",
      feedback: "Plan revision cap reached",
      attempt: 4,
    })).resolves.toBe("human-escalated");

    expect(row).toMatchObject({ status: "awaiting-approval", awaitingApprovalReason: "plan-review-replan-cap" });
  });
});

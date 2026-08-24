import { describe, expect, it, vi } from "vitest";
import { routeRetryableRemediationGraphFailureToPreMergeFix } from "../executor/route-retryable-remediation.js";
import { recoverFailedPreMergeWorkflowStep } from "../executor/recover-failed-pre-merge-step.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";
import { SelfHealingManager } from "../self-healing.js";

/*
FNXC:ReviewConvergenceEvidence 2026-08-22-16:29:
FN-149 requires a graph-remediation budget exhaustion to enter the shared recovery requester,
not park before the convergence ladder can select its next autonomous action. A zero budget remains
an operator policy refusal and must not be converted into an automatic escalation.
*/
describe("FN-149 remediation graph ladder entry", () => {
  const live = {
    id: "FN-149-entry", column: "in-review", worktree: "/worktree", dependencies: [], steps: [],
    currentStep: 0, createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
    workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", status: "failed", verdict: "REVISE", startedAt: "2026-08-22T01:00:00.000Z" }],
  };

  function deps(budget: { unbounded: boolean; max: number; attempts: number }, recovered = true) {
    const recoverFailedPreMergeWorkflowStep = vi.fn(async () => recovered);
    return {
      store: { getSettings: vi.fn(async () => ({})), updateTask: vi.fn(), logEntry: vi.fn() },
      getRunContextFor: () => undefined,
      isPreMergeRemediationGraphNode: vi.fn(async () => true),
      isLiveSharedBranchGroupMember: vi.fn(async () => false),
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({ ...budget, label: "2", key: "code-review" })),
      recoverFailedPreMergeWorkflowStep,
      persistTokenUsage: vi.fn(async () => {}),
    };
  }

  it("delegates an exhausted automatic budget to the recovery requester", async () => {
    const subject = deps({ unbounded: false, max: 2, attempts: 2 });
    await expect(routeRetryableRemediationGraphFailureToPreMergeFix(subject, live, "code-review-remediation", "retry")).resolves.toBe(true);
    expect(subject.recoverFailedPreMergeWorkflowStep).toHaveBeenCalledWith(live);
    expect(subject.store.updateTask).not.toHaveBeenCalled();
  });

  it("keeps a zero budget as an explicit policy refusal", async () => {
    const subject = deps({ unbounded: false, max: 0, attempts: 0 });
    await expect(routeRetryableRemediationGraphFailureToPreMergeFix(subject, live, "code-review-remediation", "retry")).resolves.toBe(false);
    expect(subject.recoverFailedPreMergeWorkflowStep).not.toHaveBeenCalled();
  });

  it("makes the inline Code Review requester lifecycle-effective after budget exhaustion", async () => {
    const row = structuredClone(live);
    row.workflowStepResults[0].priorAttempts = [{
      ...row.workflowStepResults[0],
      completedAt: "2026-08-22T01:05:00.000Z",
    }];
    row.log = [{
      action: "Pre-merge optional workflow step requested executor fixes (attempt 1/1)",
      outcome: "Workflow revision key: code-review",
    }];
    const sendTaskBackForFix = vi.fn(async () => {});
    const updateTaskAtomic = vi.fn(async (_id, callback) => {
      const patch = await callback(row);
      if (patch) Object.assign(row, patch);
      return row;
    });
    const store = {
      getSettings: vi.fn(async () => ({
        codeReviewMaxRevisions: 1,
        reviewConvergenceEscalationEnabled: true,
        reviewConvergenceEscalationProvider: "mock",
        reviewConvergenceEscalationModelId: "strong-reviewer",
      })),
      getTask: vi.fn(async () => row),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic,
      logEntry: vi.fn(async () => {}),
    };
    await expect(requestPreMergeOptionalStepFix({
      store,
      getRunContextFor: () => undefined,
      recoverMissingRequiredArtifacts: vi.fn(async () => {}),
      parkPlanReviewReplanCapExhausted: vi.fn(async () => {}),
      clearPausedAborted: vi.fn(),
      workflowLifecycleMovesInFlight: new Set(),
      sendTaskBackForFix,
    } as any, row.id, row, {
      phase: "pre-merge", status: "failed", verdict: "REVISE", nodeId: "code-review", stepName: "Code Review", feedback: "Fix it",
    })).resolves.toBe(true);
    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(row.reviewConvergenceStage).toBe(1);
  });

  it("routes the finite Plan Review cap through the ladder before its human park", async () => {
    const row = structuredClone(live);
    row.column = "todo";
    row.worktree = undefined;
    row.workflowStepResults = [{
      workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge",
      status: "failed", verdict: "REVISE", startedAt: "2026-08-22T01:00:00.000Z",
      priorAttempts: [{
        workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge",
        status: "failed", verdict: "REVISE", startedAt: "2026-08-22T00:30:00.000Z", completedAt: "2026-08-22T00:35:00.000Z",
      }],
    }];
    const sendTaskBackForFix = vi.fn(async () => {});
    const parkPlanReviewReplanCapExhausted = vi.fn(async () => {});
    const store = {
      getSettings: vi.fn(async () => ({
        planReviewMaxRevisions: 1,
        reviewConvergenceEscalationEnabled: true,
        reviewConvergenceEscalationProvider: "mock",
        reviewConvergenceEscalationModelId: "strong-reviewer",
      })),
      getTask: vi.fn(async () => row),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
      logEntry: vi.fn(async () => {}),
    };

    await expect(requestPreMergeOptionalStepFix({
      store, getRunContextFor: () => undefined, recoverMissingRequiredArtifacts: vi.fn(async () => {}),
      parkPlanReviewReplanCapExhausted, clearPausedAborted: vi.fn(), workflowLifecycleMovesInFlight: new Set(),
      sendTaskBackForFix,
    } as any, row.id, row, {
      phase: "pre-merge", status: "failed", verdict: "REVISE", nodeId: "plan-review", stepName: "Plan Review", feedback: "Revise plan",
    })).resolves.toBe(true);

    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(parkPlanReviewReplanCapExhausted).not.toHaveBeenCalled();
    expect(row.reviewConvergenceStage).toBe(1);
  });

  /*
  FNXC:ReviewConvergenceEvidence 2026-08-22-17:39:
  FN-149's inline requester has four independent stop points. Exercise the unchanged-review and
  unbounded Plan Review cap branches through the requester itself so a future bare `false` cannot
  reintroduce a silent human-only park while the already-covered finite caps still pass.
  */
  it("routes an unchanged inline Code Review through one lifecycle-effective escalation", async () => {
    const row = structuredClone(live);
    row.workflowStepResults[0] = {
      ...row.workflowStepResults[0],
      reviewInputFingerprint: "unchanged-diff",
      findings: [{ id: "same-finding", title: "Same defect", body: "Still present." }],
      priorAttempts: [{
        ...row.workflowStepResults[0],
        completedAt: "2026-08-22T00:50:00.000Z",
        reviewInputFingerprint: "unchanged-diff",
        findings: [{ id: "older-id", title: "Same defect", body: "Still present." }],
      }],
    };
    const sendTaskBackForFix = vi.fn(async () => {});
    const store = {
      getSettings: vi.fn(async () => ({
        reviewConvergenceEscalationEnabled: true,
        reviewConvergenceEscalationProvider: "mock",
        reviewConvergenceEscalationModelId: "strong-reviewer",
      })),
      getTask: vi.fn(async () => row),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => { const patch = await callback(row); if (patch) Object.assign(row, patch); return row; }),
      logEntry: vi.fn(async () => {}),
    };

    await expect(requestPreMergeOptionalStepFix({
      store, getRunContextFor: () => undefined, recoverMissingRequiredArtifacts: vi.fn(async () => {}),
      parkPlanReviewReplanCapExhausted: vi.fn(async () => {}), clearPausedAborted: vi.fn(), workflowLifecycleMovesInFlight: new Set(),
      sendTaskBackForFix,
    } as any, row.id, row, {
      phase: "pre-merge", status: "failed", verdict: "REVISE", nodeId: "code-review", stepName: "Code Review", feedback: "Same defect",
    })).resolves.toBe(true);

    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(row).not.toHaveProperty("awaitingApprovalReason");
  });

  it("routes the unbounded Plan Review safety cap through the ladder before parking", async () => {
    const row = structuredClone(live);
    row.column = "todo";
    row.worktree = undefined;
    row.workflowStepResults = [{
      workflowStepId: "plan-review", workflowStepName: "Plan Review", phase: "pre-merge",
      status: "failed", verdict: "REVISE", startedAt: "2026-08-22T01:00:00.000Z",
    }];
    const sendTaskBackForFix = vi.fn(async () => {});
    const parkPlanReviewReplanCapExhausted = vi.fn(async () => {});
    const store = {
      getSettings: vi.fn(async () => ({
        planReviewReplanCap: 0,
        reviewConvergenceEscalationEnabled: true,
        reviewConvergenceEscalationProvider: "mock",
        reviewConvergenceEscalationModelId: "strong-reviewer",
      })),
      getTask: vi.fn(async () => row),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => { const patch = await callback(row); if (patch) Object.assign(row, patch); return row; }),
      logEntry: vi.fn(async () => {}),
    };

    await expect(requestPreMergeOptionalStepFix({
      store, getRunContextFor: () => undefined, recoverMissingRequiredArtifacts: vi.fn(async () => {}),
      parkPlanReviewReplanCapExhausted, clearPausedAborted: vi.fn(), workflowLifecycleMovesInFlight: new Set(),
      sendTaskBackForFix,
    } as any, row.id, row, {
      phase: "pre-merge", status: "failed", verdict: "REVISE", nodeId: "plan-review", stepName: "Plan Review", feedback: "Revise plan",
    })).resolves.toBe(true);

    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(parkPlanReviewReplanCapExhausted).not.toHaveBeenCalled();
  });

  it("makes the restart-recovery requester lifecycle-effective after budget exhaustion", async () => {
    const row = structuredClone(live);
    const sendTaskBackForFix = vi.fn(async () => {});
    const updateTaskAtomic = vi.fn(async (_id, callback) => {
      const patch = await callback(row);
      if (patch) Object.assign(row, patch);
      return row;
    });
    const store = {
      getSettings: vi.fn(async () => ({
        reviewConvergenceEscalationEnabled: true,
        reviewConvergenceEscalationProvider: "mock",
        reviewConvergenceEscalationModelId: "strong-reviewer",
      })),
      getTask: vi.fn(async () => row),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic,
      logEntry: vi.fn(async () => {}),
    };

    await expect(recoverFailedPreMergeWorkflowStep({
      store,
      getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({ unbounded: false, max: 1, attempts: 1, label: "1", key: "code-review" })),
      sendTaskBackForFix,
    } as any, row)).resolves.toBe(true);

    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(row.reviewConvergenceStage).toBe(1);
    expect(row).not.toHaveProperty("awaitingApprovalReason");
  });

  it("routes an unchanged restart-recovery review through the ladder", async () => {
    const row = structuredClone(live);
    row.workflowStepResults[0] = {
      ...row.workflowStepResults[0],
      reviewInputFingerprint: "unchanged-diff",
      findings: [{ id: "current", title: "Same defect", body: "Still present." }],
      priorAttempts: [{
        ...row.workflowStepResults[0], completedAt: "2026-08-22T00:50:00.000Z",
        reviewInputFingerprint: "unchanged-diff",
        findings: [{ id: "prior", title: "Same defect", body: "Still present." }],
      }],
    };
    const sendTaskBackForFix = vi.fn(async () => {});
    const store = {
      getSettings: vi.fn(async () => ({ reviewConvergenceEscalationEnabled: true, reviewConvergenceEscalationProvider: "mock", reviewConvergenceEscalationModelId: "strong-reviewer" })),
      getTask: vi.fn(async () => row), updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => { const patch = await callback(row); if (patch) Object.assign(row, patch); return row; }), logEntry: vi.fn(async () => {}),
    };

    await expect(recoverFailedPreMergeWorkflowStep({
      store, getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({ unbounded: true, max: Infinity, attempts: 4, label: "unbounded", key: "code-review" })),
      sendTaskBackForFix,
    } as any, row)).resolves.toBe(true);

    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(row).not.toHaveProperty("awaitingApprovalReason");
  });

  it("admits an exhausted failed gate to the self-healing delegate until stage three", async () => {
    const row = {
      ...structuredClone(live),
      status: null,
      paused: false,
      autoMerge: true,
      reviewConvergenceStage: 0,
      log: [{
        action: "Auto-reviving in-review task with failed pre-merge workflow step (attempt 1/1)",
        outcome: "Step: Code Review\nWorkflow revision key: code-review",
      }],
    };
    const recoverFailedPreMergeStep = vi.fn(async () => true);
    const store = {
      getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false, maxPostReviewFixes: 1, codeReviewMaxRevisions: 1 })),
      listTasks: vi.fn(async () => [row]), getTask: vi.fn(async () => row),
      updateTask: vi.fn(async () => {}), logEntry: vi.fn(async () => {}),
      getTaskWorkflowSelection: vi.fn(() => undefined), getWorkflowDefinition: vi.fn(async () => undefined),
    };
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/fn-149", recoverFailedPreMergeStep });
    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(1);
      expect(recoverFailedPreMergeStep).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }));
      row.reviewConvergenceStage = 3;
      recoverFailedPreMergeStep.mockClear();
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
      expect(recoverFailedPreMergeStep).not.toHaveBeenCalled();
    } finally {
      manager.stop();
    }
  });
});

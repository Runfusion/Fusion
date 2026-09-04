import { describe, expect, it, vi } from "vitest";

const { resolveExternalExecutionCheckoutRouteMock } = vi.hoisted(() => ({
  resolveExternalExecutionCheckoutRouteMock: vi.fn(async () => ({ configured: false as const })),
}));

vi.mock("../executor/review-arbitration.js", () => ({
  runReviewArbitration: vi.fn(async () => "declined"),
}));
vi.mock("../execution/external-execution-checkout.js", () => ({
  resolveExternalExecutionCheckoutRoute: resolveExternalExecutionCheckoutRouteMock,
}));
import { routeRetryableRemediationGraphFailureToPreMergeFix } from "../executor/route-retryable-remediation.js";
import { recoverFailedPreMergeWorkflowStep } from "../executor/recover-failed-pre-merge-step.js";
import { requestPreMergeOptionalStepFix } from "../executor/request-pre-merge-optional-step-fix.js";
import { routeReviewConvergenceLadder } from "../executor/review-convergence-ladder.js";
import { runReviewArbitration } from "../executor/review-arbitration.js";
import { resolveRemediationCheckout } from "../executor/resolve-remediation-checkout.js";
import { sendTaskBackForFix } from "../executor/send-task-back-for-fix.js";
import { SelfHealingManager } from "../self-healing.js";
import { EMPTY_REVIEW_DIFF_FINGERPRINT } from "../worktree/review-diff-fingerprint.js";

/*
FNXC:ReviewConvergenceEvidence 2026-08-22-16:29:
FN-149 requires a graph-remediation budget exhaustion to enter the shared recovery requester,
not park before the convergence ladder can select its next autonomous action. A zero budget remains
an operator policy refusal and must not be converted into an automatic escalation.
*/
describe("FN-149 remediation graph ladder entry", () => {
  const live = {
    id: "FN-149-entry", column: "in-review", worktree: "/worktree", dependencies: [],
    steps: [{ name: "Fix Code Review", status: "pending", remediation: { wave: 1, gate: "Code Review", gateStepId: "code-review", detail: "Fix the finding" } }],
    currentStep: 0, createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z",
    workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", status: "failed", verdict: "REVISE", startedAt: "2026-08-22T01:00:00.000Z" }],
  };

  function workspaceLive() {
    const row = structuredClone(live) as any;
    delete row.worktree;
    row.repositoryScope = { state: "confirmed", revision: 1, repositories: ["repo1", "repo2"] };
    row.workspaceWorktrees = {
      repo1: { worktreePath: "/tmp/mult-029/repo1", baseCommitSha: "r1" },
      repo2: { worktreePath: "/tmp/mult-029/repo2", baseCommitSha: "r2" },
    };
    row.workflowStepResults[0] = {
      ...row.workflowStepResults[0],
      reviewKind: "code",
      repositoryScopeRevision: 1,
      repositoryReviewOutcomes: [{
        repository: "repo2", status: "REVIEWED", verdict: "REVISE",
        findings: [{ id: "repo2:finding", title: "Missing source guard", body: "Add the source-location check.", severity: "critical", resolution: "open", filePath: "repo2/tests/source.test.ts" }],
      }],
    };
    return row;
  }

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

  it("admits a retryable workspace remediation graph failure without a singular worktree", async () => {
    const row = workspaceLive();
    const subject = deps({ unbounded: true, max: Number.POSITIVE_INFINITY, attempts: 0 });

    await expect(routeRetryableRemediationGraphFailureToPreMergeFix(subject, row, "code-review-remediation", "retry")).resolves.toBe(true);

    expect(subject.recoverFailedPreMergeWorkflowStep).toHaveBeenCalledWith(row);
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
    row.worktree = "/tmp/plan-review";
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
  it("routes an unchanged inline Code Review directly to arbitration when no distinct model exists", async () => {
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
    const claimedStages: number[] = [];
    const store = {
      getSettings: vi.fn(async () => ({})),
      getTask: vi.fn(async () => row),
      getTaskWorkflowSelection: vi.fn(async () => undefined), getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})), getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => { const patch = await callback(row); if (patch) { if (typeof patch.reviewConvergenceStage === "number") claimedStages.push(patch.reviewConvergenceStage); Object.assign(row, patch); } return row; }),
      logEntry: vi.fn(async () => {}),
    };

    await expect(requestPreMergeOptionalStepFix({
      store, getRunContextFor: () => undefined, recoverMissingRequiredArtifacts: vi.fn(async () => {}),
      parkPlanReviewReplanCapExhausted: vi.fn(async () => {}), clearPausedAborted: vi.fn(), workflowLifecycleMovesInFlight: new Set(),
      sendTaskBackForFix,
    } as any, row.id, row, {
      phase: "pre-merge", status: "failed", verdict: "REVISE", nodeId: "code-review", stepName: "Code Review", feedback: "Same defect",
    })).resolves.toBe(false);

    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(claimedStages[0]).toBe(2);
    expect(row).not.toHaveProperty("awaitingApprovalReason");
  });

  it("routes an unchanged inline Code Review through a distinct fallback after discarding an identical dedicated target", async () => {
    const row = structuredClone(live);
    row.modelProvider = "current-provider";
    row.modelId = "current-model";
    row.workflowStepResults[0] = {
      ...row.workflowStepResults[0],
      reviewInputFingerprint: "unchanged-diff",
      findings: [{ id: "same-finding", title: "Same defect", body: "Still present." }],
      priorAttempts: [{ ...row.workflowStepResults[0], reviewInputFingerprint: "unchanged-diff", findings: [{ id: "older", title: "Same defect", body: "Still present." }] }],
    };
    const sendTaskBackForFix = vi.fn(async () => {});
    const store = {
      getSettings: vi.fn(async () => ({
        reviewConvergenceEscalationEnabled: true,
        reviewConvergenceEscalationProvider: "current-provider",
        reviewConvergenceEscalationModelId: "current-model",
        executionFallbackProvider: "fallback-provider",
        executionFallbackModelId: "fallback-model",
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
    expect(row).toMatchObject({ reviewConvergenceStage: 1, modelProvider: "fallback-provider", modelId: "fallback-model" });
  });

  it("routes the unbounded Plan Review safety cap through the ladder before parking", async () => {
    const row = structuredClone(live);
    row.column = "todo";
    row.worktree = "/tmp/plan-review";
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

  it("routes an unchanged restart-recovery review through the distinct fallback candidate", async () => {
    const row = structuredClone(live);
    row.modelProvider = "current-provider";
    row.modelId = "current-model";
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
      getSettings: vi.fn(async () => ({
        reviewConvergenceEscalationEnabled: true,
        reviewConvergenceEscalationProvider: "current-provider",
        reviewConvergenceEscalationModelId: "current-model",
        executionFallbackProvider: "fallback-provider",
        executionFallbackModelId: "fallback-model",
      })),
      getTask: vi.fn(async () => row), updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => { const patch = await callback(row); if (patch) Object.assign(row, patch); return row; }), logEntry: vi.fn(async () => {}),
    };

    await expect(recoverFailedPreMergeWorkflowStep({
      store, getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({ unbounded: true, max: Infinity, attempts: 4, label: "unbounded", key: "code-review" })),
      sendTaskBackForFix,
    } as any, row)).resolves.toBe(true);

    expect(sendTaskBackForFix).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ reviewConvergenceStage: 1, modelProvider: "fallback-provider", modelId: "fallback-model" });
    expect(row).not.toHaveProperty("awaitingApprovalReason");
  });

  it("routes an unchanged restart-recovery review directly to arbitration when no candidate exists", async () => {
    const row = structuredClone(live);
    row.workflowStepResults[0] = {
      ...row.workflowStepResults[0],
      reviewInputFingerprint: "unchanged-diff",
      findings: [{ id: "current", title: "Same defect", body: "Still present." }],
      priorAttempts: [{ ...row.workflowStepResults[0], reviewInputFingerprint: "unchanged-diff", findings: [{ id: "prior", title: "Same defect", body: "Still present." }] }],
    };
    const sendTaskBackForFix = vi.fn(async () => {});
    const claimedStages: number[] = [];
    const store = {
      getSettings: vi.fn(async () => ({})),
      getTask: vi.fn(async () => row),
      getTaskWorkflowSelection: vi.fn(async () => undefined), getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})), getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => { const patch = await callback(row); if (patch) { if (typeof patch.reviewConvergenceStage === "number") claimedStages.push(patch.reviewConvergenceStage); Object.assign(row, patch); } return row; }),
      logEntry: vi.fn(async () => {}),
    };

    await expect(recoverFailedPreMergeWorkflowStep({
      store, getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({ unbounded: true, max: Infinity, attempts: 4, label: "unbounded", key: "code-review" })),
      sendTaskBackForFix,
    } as any, row)).resolves.toBe(false);

    expect(sendTaskBackForFix).not.toHaveBeenCalled();
    expect(claimedStages[0]).toBe(2);
  });

  it("recovers a failed workspace review through the failing repository checkout", async () => {
    const row = workspaceLive();
    const sendTaskBackForFix = vi.fn(async () => undefined);
    const store = {
      getSettings: vi.fn(async () => ({ autoMerge: true })),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => row),
      logEntry: vi.fn(async () => undefined),
    };

    await expect(recoverFailedPreMergeWorkflowStep({
      store,
      getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({ unbounded: true, max: Infinity, attempts: 0, label: "unbounded", key: "code-review" })),
      sendTaskBackForFix,
    } as any, row)).resolves.toBe(true);

    expect(sendTaskBackForFix.mock.calls[0]?.[1]).toBe("/tmp/mult-029/repo2");
    expect(sendTaskBackForFix.mock.calls[0]?.[9]).toBe(false);
  });

  it("keeps an external execution route authoritative during workspace failed-step recovery", async () => {
    const row = workspaceLive();
    row.sourceMetadata = {
      externalExecutionCheckout: "/tmp/operator-runtime",
      externalExecutionBranch: "operator/runtime-fixes",
    };
    resolveExternalExecutionCheckoutRouteMock.mockResolvedValueOnce({
      configured: true,
      valid: true,
      checkoutPath: "/tmp/operator-runtime",
      branch: "operator/runtime-fixes",
    });
    const scheduleWorkflowRerun = vi.fn();
    const store = {
      getSettings: vi.fn(async () => ({ autoMerge: true })),
      getTask: vi.fn(async () => row),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      addTaskComment: vi.fn(async () => undefined),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
        Object.assign(row, patch);
        return row;
      }),
      logEntry: vi.fn(async () => undefined),
    };
    const sendBackDeps = {
      store,
      clearCompletedTaskWatchdog: vi.fn(),
      injectWorkflowStepFailureInstructions: vi.fn(async () => undefined),
      reopenLastStepForRevision: vi.fn(async () => undefined),
      scheduleWorkflowRerun,
      maxWorkflowStepRetries: 3,
    };

    await expect(recoverFailedPreMergeWorkflowStep({
      store,
      getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({ unbounded: true, max: Infinity, attempts: 0, label: "unbounded", key: "code-review" })),
      sendTaskBackForFix: (...args: Parameters<typeof sendTaskBackForFix> extends [unknown, ...infer Rest] ? Rest : never) =>
        sendTaskBackForFix(sendBackDeps as never, ...args),
    } as any, row)).resolves.toBe(true);

    expect(scheduleWorkflowRerun).toHaveBeenCalledWith(
      row.id,
      "/tmp/operator-runtime",
      expect.stringContaining("sent back to in-progress for remediation"),
      true,
      false,
    );
    expect(store.updateTask.mock.calls.every(([, patch]) => !("worktree" in patch))).toBe(true);
  });

  it("uses the failing workspace checkout for a stage-one convergence bounce", async () => {
    const row = workspaceLive();
    const sendTaskBackForFix = vi.fn(async () => undefined);
    const store = {
      getSettings: vi.fn(async () => ({
        autoMerge: true,
        reviewConvergenceEscalationEnabled: true,
        reviewConvergenceEscalationProvider: "mock",
        reviewConvergenceEscalationModelId: "strong-reviewer",
      })),
      getTask: vi.fn(async () => row),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
      logEntry: vi.fn(async () => undefined),
    };

    await expect(routeReviewConvergenceLadder({ store, getRunContextFor: () => undefined, sendTaskBackForFix } as any, row.id, {
      kind: "budget-exhausted", workflowStepId: "code-review", stepName: "Code Review", feedback: "Fix it", findings: row.workflowStepResults[0].findings, attempt: 1, max: 1,
    })).resolves.toBe("escalated");

    expect(sendTaskBackForFix.mock.calls[0]?.[1]).toBe("/tmp/mult-029/repo2");
    expect(sendTaskBackForFix.mock.calls[0]?.[9]).toBe(false);
  });

  it("reaches workspace arbitration through the stage-two convergence rung", async () => {
    const row = workspaceLive();
    row.reviewConvergenceStage = 1;
    vi.mocked(runReviewArbitration).mockResolvedValueOnce("arbitrated");
    const store = {
      getSettings: vi.fn(async () => ({ autoMerge: true })),
      getTask: vi.fn(async () => row),
      getTaskWorkflowSelection: vi.fn(async () => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      getWorkflowSettingValues: vi.fn(async () => ({})),
      getWorkflowSettingsProjectId: vi.fn(() => undefined),
      updateTask: vi.fn(async (_id, patch) => Object.assign(row, patch)),
      updateTaskAtomic: vi.fn(async (_id, callback) => {
        const patch = await callback(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
      logEntry: vi.fn(async () => undefined),
    };

    await expect(routeReviewConvergenceLadder({ store, getRunContextFor: () => undefined, sendTaskBackForFix: vi.fn() } as any, row.id, {
      kind: "repeat-unchanged", workflowStepId: "code-review", stepName: "Code Review", feedback: "Still broken", attempt: 2,
    })).resolves.toBe("arbitrated");

    expect(runReviewArbitration).toHaveBeenCalledWith(expect.anything(), row, "code-review", "Code Review", "Still broken", 2, undefined);
  });

  it("does not let a stale singular path mask the failing workspace repository", () => {
    const row = workspaceLive();
    row.worktree = "/tmp/stale-singular";

    expect(resolveRemediationCheckout(row, row.workflowStepResults[0])).toEqual({
      path: "/tmp/mult-029/repo2",
      repository: "repo2",
      persist: false,
    });
  });

  it("skips remediation when neither a singular nor workspace checkout exists", async () => {
    const row = structuredClone(live) as any;
    delete row.worktree;
    delete row.workspaceWorktrees;

    expect(resolveRemediationCheckout(row, row.workflowStepResults[0])).toBeUndefined();
    const subject = deps({ unbounded: true, max: Infinity, attempts: 0 });
    await expect(routeRetryableRemediationGraphFailureToPreMergeFix(subject, row, "code-review-remediation", "retry")).resolves.toBe(false);
    expect(subject.recoverFailedPreMergeWorkflowStep).not.toHaveBeenCalled();
  });

  it("admits a workspace failed gate to the self-healing delegate", async () => {
    const row = {
      ...workspaceLive(),
      steps: [],
      status: null,
      paused: false,
      autoMerge: true,
      reviewConvergenceStage: 0,
      log: [],
    };
    const recoverFailedPreMergeStep = vi.fn(async () => true);
    const store = {
      getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false, maxPostReviewFixes: 3 })),
      listTasks: vi.fn(async () => [row]),
      getTask: vi.fn(async () => row),
      updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => Object.assign(row, patch)),
      logEntry: vi.fn(async () => undefined),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
    };
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/fn-231", recoverFailedPreMergeStep });
    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(1);
      expect(recoverFailedPreMergeStep).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }));
    } finally {
      manager.stop();
    }
  });

  it("admits an exhausted failed gate to the self-healing delegate until stage three", async () => {
    const row = {
      ...structuredClone(live),
      steps: [],
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

function emptyReviewRow() {
  return {
    id: "FN-225-entry", column: "in-review", worktree: "/worktree", dependencies: [], steps: [], currentStep: 0,
    createdAt: "2026-08-28T00:00:00.000Z", updatedAt: "2026-08-28T00:00:00.000Z",
    workflowStepResults: [{
      workflowStepId: "code-review", workflowStepName: "Code Review", phase: "pre-merge", status: "failed",
      reviewKind: "code", verdict: "REVISE", reviewInputFingerprint: EMPTY_REVIEW_DIFF_FINGERPRINT,
      startedAt: "2026-08-28T01:00:00.000Z", completedAt: "2026-08-28T01:01:00.000Z",
    }],
  } as any;
}

function emptyReviewStore(row: any) {
  return {
    getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false })),
    getTask: vi.fn(async () => row),
    updateTask: vi.fn(async (_id: string, patch: Record<string, unknown>) => { Object.assign(row, patch); return row; }),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (current: any) => any) => {
      const patch = await updater(row);
      if (patch) Object.assign(row, patch);
      return row;
    }),
    logEntry: vi.fn(async () => undefined),
  } as any;
}

describe("FN-225 definite empty review entry points", () => {
  /*
  FNXC:ReviewEmptyContent 2026-08-30-13:36:
  FN-267 changed this contract deliberately. The empty-diff close used to run AHEAD of the
  remediation producer on the live requester, so an empty-diff REVISE parked terminally before the
  deterministic Fix step could be written — a card blocked purely because fix steps were absent,
  which the operator requirement forbids. The park is now the fallback for a review no producer can
  serve; the two cases below pin both halves of that ordering.
  */
  it("produces remediation from the live requester instead of parking when a producer can serve the empty review", async () => {
    const row = emptyReviewRow();
    row.column = "in-progress";
    const store = emptyReviewStore(row);
    const sendTaskBackForFix = vi.fn(async () => undefined);
    const appendReviewRemediationSteps = vi.fn(async () => "appended");

    await expect(requestPreMergeOptionalStepFix({
      store, getRunContextFor: () => undefined, recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
      parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined), clearPausedAborted: vi.fn(),
      appendReviewRemediationSteps, workflowLifecycleMovesInFlight: new Set(),
      sendTaskBackForFix,
    } as any, row.id, row, {
      phase: "pre-merge", status: "failed", verdict: "REVISE", nodeId: "code-review", stepName: "Code Review", feedback: "No diff",
    })).resolves.toBe(true);

    expect(appendReviewRemediationSteps).toHaveBeenCalledTimes(1);
    expect(row.status).not.toBe("failed");
    expect(row.error ?? "").not.toMatch(/^NO REVIEWABLE CONTENT:/);
  });

  it("still terminalizes from the live requester when the producer declines the empty review", async () => {
    const row = emptyReviewRow();
    row.column = "in-progress";
    const store = emptyReviewStore(row);
    const sendTaskBackForFix = vi.fn(async () => undefined);

    await expect(requestPreMergeOptionalStepFix({
      store, getRunContextFor: () => undefined, recoverMissingRequiredArtifacts: vi.fn(async () => undefined),
      parkPlanReviewReplanCapExhausted: vi.fn(async () => undefined), clearPausedAborted: vi.fn(),
      appendReviewRemediationSteps: vi.fn(async () => "released-no-actionable-findings"),
      workflowLifecycleMovesInFlight: new Set(), sendTaskBackForFix,
    } as any, row.id, row, {
      phase: "pre-merge", status: "failed", verdict: "REVISE", nodeId: "code-review", stepName: "Code Review", feedback: "No diff",
    })).resolves.toBe(false);

    expect(row).toMatchObject({ status: "failed", error: expect.stringMatching(/^NO REVIEWABLE CONTENT:/) });
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
  });

  it("produces remediation from recovery for an empty review with no usable findings", async () => {
    const row = emptyReviewRow();
    const store = emptyReviewStore(row);
    const appendReviewRemediationSteps = vi.fn(async () => "appended");
    const sendTaskBackForFix = vi.fn(async () => undefined);

    await expect(recoverFailedPreMergeWorkflowStep({
      store, getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({
        unbounded: true, max: Infinity, attempts: 0, label: "unbounded", key: "code-review",
      })),
      appendReviewRemediationSteps,
      sendTaskBackForFix,
    } as any, row)).resolves.toBe(true);

    expect(appendReviewRemediationSteps).toHaveBeenCalledTimes(1);
    expect(row.status).not.toBe("failed");
    expect(row.error ?? "").not.toMatch(/^NO REVIEWABLE CONTENT:/);
  });

  it("terminalizes from recovery when the producer declines the empty review", async () => {
    const row = emptyReviewRow();
    const store = emptyReviewStore(row);
    const sendTaskBackForFix = vi.fn(async () => undefined);

    await expect(recoverFailedPreMergeWorkflowStep({
      store, getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: vi.fn(async () => ({
        unbounded: true, max: Infinity, attempts: 0, label: "unbounded", key: "code-review",
      })),
      appendReviewRemediationSteps: vi.fn(async () => "released-no-actionable-findings"),
      sendTaskBackForFix,
    } as any, row)).resolves.toBe(false);

    expect(row).toMatchObject({ status: "failed", error: expect.stringMatching(/^NO REVIEWABLE CONTENT:/) });
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
  });

  it("terminalizes from recovery before a zero budget is resolved", async () => {
    const row = emptyReviewRow();
    const store = emptyReviewStore(row);
    const resolveBudget = vi.fn(async () => ({ unbounded: false, max: 0, attempts: 0, label: "0", key: "code-review" }));
    const sendTaskBackForFix = vi.fn(async () => undefined);

    await expect(recoverFailedPreMergeWorkflowStep({
      store, getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: resolveBudget,
      sendTaskBackForFix,
    }, row)).resolves.toBe(false);

    expect(row).toMatchObject({ status: "failed", error: expect.stringMatching(/^NO REVIEWABLE CONTENT:/) });
    expect(resolveBudget).not.toHaveBeenCalled();
    expect(sendTaskBackForFix).not.toHaveBeenCalled();
  });

  it("lets the manager terminalize a zero-budget empty review exactly once", async () => {
    const emptyRow = Object.assign(emptyReviewRow(), {
      id: "FN-225-empty-sweep",
      status: null,
      paused: false,
      autoMerge: true,
      log: [],
    });
    const digestRow = structuredClone(emptyRow);
    digestRow.id = "FN-225-digest-sweep";
    digestRow.workflowStepResults[0].reviewInputFingerprint = "a".repeat(64);
    const rows = [emptyRow, digestRow];
    const store = {
      getSettings: vi.fn(async () => ({
        autoMerge: true,
        globalPause: false,
        enginePaused: false,
        maxPostReviewFixes: 0,
        codeReviewMaxRevisions: 0,
      })),
      listTasks: vi.fn(async ({ column }: { column?: string } = {}) => rows.filter((row) => !column || row.column === column)),
      getTask: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
      updateTask: vi.fn(async (id: string, patch: Record<string, unknown>) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (row) Object.assign(row, patch);
        return row;
      }),
      updateTaskAtomic: vi.fn(async (id: string, updater: (current: any) => any) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (!row) return undefined;
        const patch = await updater(row);
        if (patch) Object.assign(row, patch);
        return row;
      }),
      logEntry: vi.fn(async (id: string, action: string, outcome?: string) => {
        const row = rows.find((candidate) => candidate.id === id);
        row?.log.push({ action, outcome });
      }),
      getTaskWorkflowSelection: vi.fn(() => undefined),
      getWorkflowDefinition: vi.fn(async () => undefined),
      listWorkflowDefinitions: vi.fn(async () => []),
    };
    const resolveBudget = vi.fn(async () => ({ unbounded: false, max: 0, attempts: 0, label: "0", key: "code-review" }));
    const sendTaskBackForFix = vi.fn(async () => undefined);
    const recoverFailedPreMergeStep = vi.fn(async (task: any) => recoverFailedPreMergeWorkflowStep({
      store: store as any,
      getRunContextFor: () => undefined,
      resolveFailedPreMergeWorkflowStepBudget: resolveBudget,
      sendTaskBackForFix,
    }, task));
    const manager = new SelfHealingManager(store as any, { rootDir: "/tmp/fn-225", recoverFailedPreMergeStep });

    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
      expect(recoverFailedPreMergeStep).toHaveBeenCalledTimes(1);
      expect(recoverFailedPreMergeStep).toHaveBeenCalledWith(expect.objectContaining({ id: emptyRow.id }));
      expect(emptyRow).toMatchObject({
        column: "in-review",
        status: "failed",
        error: expect.stringMatching(/^NO REVIEWABLE CONTENT:/),
      });
      expect(digestRow).toMatchObject({ column: "in-review", status: null });
      expect(digestRow.error).toBeUndefined();
      expect(resolveBudget).not.toHaveBeenCalled();
      expect(sendTaskBackForFix).not.toHaveBeenCalled();

      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
      expect(recoverFailedPreMergeStep).toHaveBeenCalledTimes(1);
      expect(digestRow).toMatchObject({ column: "in-review", status: null });
      expect(digestRow.error).toBeUndefined();
    } finally {
      manager.stop();
    }
  });
});

import type { Task, TaskStore, WorkflowReviewFinding, RunMutationContext } from "@fusion/core";
import {
  collectDisputedFindings,
  hasConfiguredFallbackLane,
  hasPendingReviewRemediationWork,
  hasPreMergeRemediationAutoMergeHold,
  isOpenWorkflowReviewFinding,
  resolveExecutorFallbackModel,
  resolveReviewConvergenceEscalationTarget,
  resolveStepReopenPolicy,
  resolveTaskExecutionModel,
  resolveWorkflowIrForTask } from "@fusion/core";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { moveTaskToReplanColumn } from "../execution/replan-target.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import { runReviewArbitration } from "./review-arbitration.js";
import { resolveRemediationCheckout } from "./resolve-remediation-checkout.js";
import {
  terminalizeEmptyReviewContent,
  type EmptyReviewContentGateFence } from "./review-empty-content-close.js";
/*
FNXC:ReviewConvergence 2026-08-22-05:54:
FN-149 requires an exhausted or unchanged review cycle to take one bounded AI remediation action before reaching its terminal rung. The atomic stage claim prevents concurrent graph and recovery paths from scheduling duplicate bounces.

FNXC:ReviewConvergence 2026-08-28-07:48:
An exhausted Code Review convergence cycle is advisory, not a human gate. Its terminal rung records and releases the feedback without mutating lifecycle state. A provably empty review input is a separate terminal carve-out: no content was reviewed, so there is no advisory position to release and no remediation or arbitration round can create one. The operator-authored Plan Review replan-cap hold remains the other lifecycle-mutating exception.
*/

export const REVIEW_CONVERGENCE_MAX_LADDER_CYCLES = 3;

export type ReviewConvergenceStop = {
  kind: "repeat-unchanged" | "budget-exhausted" | "plan-review-cap" | "empty-review-input";
  workflowStepId?: string;
  emptyInputFence?: EmptyReviewContentGateFence;
  stepName: string;
  feedback: string;
  findings?: WorkflowReviewFinding[];
  attempt: number;
  max?: number;
};

export type ReviewConvergenceLadderDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => RunMutationContext | undefined;
  sendTaskBackForFix: (
    task: Task, worktreePath: string, failureFeedback: string, stepName: string, reason: string,
    preserveResumeState: boolean, mergeVerificationFailure: boolean,
    retryPresentation?: { attempt: number; max?: number }, findings?: WorkflowReviewFinding[],
    persistWorktreePath?: boolean, stepReopenPolicy?: "reopen-trailing" | "none",
  ) => Promise<void>;
};

export type ReviewConvergenceLadderOutcome = "escalated" | "arbitrated" | "released" | "human-escalated" | "empty-content-terminalized" | "declined";

type EscalationDecision =
  | { source: "dedicated" | "execution-fallback"; provider: string; modelId: string }
  | { source: "none"; reason: "dedicated-target-not-distinct" | "no-distinct-target-configured" };

function resolveEscalationDecision(task: Task, settings: Awaited<ReturnType<typeof mergeEffectiveSettings>>): EscalationDecision {
  const persistedBaseline = task.modelProvider && task.modelId
    ? { provider: task.modelProvider, modelId: task.modelId }
    : undefined;
  const effective = persistedBaseline ?? resolveTaskExecutionModel(task, settings);
  const isDistinct = (provider: string, modelId: string) =>
    !effective.provider || !effective.modelId
      || provider !== effective.provider
      || modelId !== effective.modelId;

  const dedicated = resolveReviewConvergenceEscalationTarget(settings);
  const dedicatedNotDistinct = Boolean(
    dedicated.enabled && dedicated.provider && dedicated.modelId
      && !isDistinct(dedicated.provider, dedicated.modelId),
  );
  if (dedicated.enabled && dedicated.provider && dedicated.modelId
    && isDistinct(dedicated.provider, dedicated.modelId)) {
    return { source: "dedicated", provider: dedicated.provider, modelId: dedicated.modelId };
  }

  if (hasConfiguredFallbackLane(settings, "execution")) {
    const fallback = resolveExecutorFallbackModel(settings);
    if (fallback.provider && fallback.modelId && isDistinct(fallback.provider, fallback.modelId)) {
      return { source: "execution-fallback", provider: fallback.provider, modelId: fallback.modelId };
    }
  }

  return {
    source: "none",
    reason: dedicatedNotDistinct ? "dedicated-target-not-distinct" : "no-distinct-target-configured",
  };
}

/*
FNXC:ReviewConvergence 2026-08-28-07:48:
The task log may retain the compact convergence dossier after automatic routes are exhausted. It
preserves advisory context for a non-blocking release and supports the separately operator-authored
Plan Review cap without exposing reviewer prose in run-audit metadata.
*/
function buildConvergenceDossier(task: Task, stop: ReviewConvergenceStop): string {
  const gate = task.workflowStepResults?.find((result) => result.workflowStepId === stop.workflowStepId);
  const openFindings = [
    ...(gate?.findings ?? []),
    ...(gate?.priorAttempts ?? []).flatMap((attempt) => attempt.findings ?? []),
  ].filter(isOpenWorkflowReviewFinding);
  const archivedDisputes = collectDisputedFindings(task.workflowStepResults, { revisionKey: stop.workflowStepId ?? "" });
  const disputed = [...openFindings.filter((finding) => finding.disputedAt), ...archivedDisputes];
  const findings = openFindings.length > 0
    ? openFindings.map((finding) => `- Reviewer: ${finding.id} — ${finding.title}: ${finding.body}`).join("\n")
    : "- Reviewer: no open structured findings were retained.";
  const disputes = disputed.length > 0
    ? disputed.map((finding) => `- Implementer on ${finding.id}: ${finding.disputeRationale ?? "No rationale recorded."}`).join("\n")
    : "- Implementer: no recorded dispute rationale.";
  const ruling = gate?.arbitrationDecision
    ? `${gate.arbitrationDecision}${gate.arbitrationNotes ? ` — ${gate.arbitrationNotes}` : ""}`
    : "No arbitration ruling was available.";
  return `Round: ${stop.attempt}\nStop: ${stop.kind}\n\nReviewer position\n${findings}\n\nImplementer position\n${disputes}\n\nArbitration\n${ruling}`;
}

export async function routeReviewConvergenceLadder(
  deps: ReviewConvergenceLadderDeps,
  taskId: string,
  stop: ReviewConvergenceStop,
): Promise<ReviewConvergenceLadderOutcome> {
  const task = await deps.store.getTask(taskId);
  const settings = await deps.store.getSettings();
  if (task.deletedAt || task.paused || task.userPaused || settings.globalPause || settings.enginePaused
    || hasPreMergeRemediationAutoMergeHold(task, settings)) return "declined";
  /*
  FNXC:ReviewConvergence 2026-08-22-05:44:
  A caller can race terminal-result persistence. Do not claim a rung until the exact gate is a
  live failure; otherwise a stale caller could replan work that no reviewer actually blocked.
  */
  /*
  FNXC:ReviewConvergence 2026-08-22-05:56:
  Advisory REVISE remediation is non-blocking but can still loop. It receives the same bounded
  stage-one lifecycle action as a failed gate; arbitration release remains unavailable because
  only an exact failed gate may ever be gate-opened.
  */
  if (!stop.workflowStepId || !(task.workflowStepResults ?? []).some((result) =>
    result.workflowStepId === stop.workflowStepId
      && (result.status === "failed" || result.status === "advisory_failure"))) return "declined";
  /*
  FNXC:ReviewEmptyContent 2026-08-28-13:14:
  Empty Code Review input is terminal on first detection, independent of the configured revision budget.
  The checks above are only a pre-filter; the close owns its own exact-gate CAS because concurrent
  lifecycle writers can land after this read. Do not claim a ladder stage, increment convergence,
  dispatch escalation, or arbitrate content that does not exist.
  */
  if (stop.kind === "empty-review-input") {
    if (!stop.emptyInputFence) return "declined";
    const parked = await terminalizeEmptyReviewContent(deps, taskId, stop.emptyInputFence);
    return parked ? "empty-content-terminalized" : "declined";
  }
  let claimed = false;
  let claimedStage: 1 | 2 | 3 | undefined;
  let claimedCycle: number | undefined;
  let escalationDecision: EscalationDecision | undefined;
  let claimedTask: Task | undefined;
  const claim = async (current: Task) => {
    const currentSettings = await mergeEffectiveSettings(deps.store, current, settings);
    /*
    FNXC:ReviewConvergence 2026-08-22-17:20:
    FN-149 must not escalate a review gate that cleared after the initial read. Re-check the exact
    workflow step inside the atomic claim so an APPROVE, archive, or supersession wins the race.
    */
    const liveGate = current.workflowStepResults?.find((result) => result.workflowStepId === stop.workflowStepId);
    if (current.deletedAt || current.paused || current.userPaused
      || hasPreMergeRemediationAutoMergeHold(current, settings)
      || !liveGate || (liveGate.status !== "failed" && liveGate.status !== "advisory_failure")) return null;
    const cycles = current.reviewConvergenceEscalationCount ?? 0;
    const currentStage = current.reviewConvergenceStage ?? 0;
    escalationDecision = resolveEscalationDecision(current, currentSettings);
    const nextStage = cycles >= REVIEW_CONVERGENCE_MAX_LADDER_CYCLES || currentStage >= 2
      ? 3
      : currentStage === 1 ? 2 : 1;
    /*
    FNXC:ReviewConvergence 2026-08-28-11:04:
    Candidate ordering is gated by usability, not the dedicated target's enabled bit: an enabled but
    identical target must not strand a distinct execution fallback. Only repeat-unchanged may skip
    stage one when no distinct model exists; budget exhaustion and the Plan Review cap keep their
    existing stage-one lifecycle action, using the honest executor-remediation or replan label.
    */
    claimedStage = stop.kind === "repeat-unchanged" && nextStage === 1 && escalationDecision.source === "none"
      ? 2
      : nextStage;
    claimedCycle = cycles + 1;
    claimedTask = current;
    claimed = true;
    return {
      reviewConvergenceStage: claimedStage,
      reviewConvergenceEscalationCount: claimedCycle,
      ...(claimedStage === 1 && escalationDecision.source !== "none"
        ? { modelProvider: escalationDecision.provider, modelId: escalationDecision.modelId }
        : {}),
    };
  };
  const atomic = (deps.store as TaskStore & { updateTaskAtomic?: TaskStore["updateTaskAtomic"] }).updateTaskAtomic;
  if (atomic) {
    await atomic.call(deps.store, taskId, claim, deps.getRunContextFor(taskId));
  } else {
    const patch = await claim(task);
    if (patch) await deps.store.updateTask(taskId, patch, deps.getRunContextFor(taskId));
  }
  if (!claimed || !claimedTask || !claimedStage || !claimedCycle || !escalationDecision) return "declined";
  const decision = escalationDecision;

  if (claimedStage < 3) {
    const decisionLog = decision.source === "none"
      ? `No distinct model target was usable (${decision.reason}); ${claimedStage === 2 ? "advancing to arbitration" : "continuing the existing lifecycle action"}.`
      : `Selected the ${decision.source} escalation source for one distinct-model round.`;
    await (deps.store.logEntry as TaskStore["logEntry"] | undefined)?.call(
      deps.store,
      taskId,
      `Review convergence escalation source: ${decision.source}`,
      decisionLog,
      deps.getRunContextFor(taskId),
    );
  }

  const emitEscalationAudit = async (
    stage: 1 | 2,
    mode: "alternate-model" | "executor-remediation" | "replan" | "arbitration",
  ) => {
    const runContext = deps.getRunContextFor(taskId);
    if (!runContext) return;
    await emitBoundedRunAudit(deps.store, {
      taskId, agentId: runContext.agentId, runId: runContext.runId, domain: "database",
      mutationType: "task:review-convergence-escalation", target: taskId,
      metadata: {
        workflowStepId: stop.workflowStepId ?? stop.stepName,
        stop: stop.kind,
        stage,
        cycle: claimedCycle,
        mode,
        hasModelTarget: stage === 1 && decision.source !== "none",
        escalationSource: stage === 1 ? decision.source : "none",
      },
    });
  };

  if (claimedStage === 3) {
    const context = deps.getRunContextFor(taskId);
    if (stop.kind !== "plan-review-cap") {
      await deps.store.logEntry(
        taskId,
        "Review convergence exhausted — released as non-blocking",
        buildConvergenceDossier(claimedTask, stop),
        context,
      );
      return "released";
    }
    await deps.store.updateTask(taskId, {
      status: "awaiting-approval",
      awaitingApprovalReason: "plan-review-replan-cap",
      error: null,
      nextRecoveryAt: null,
    }, context);
    await deps.store.logEntry(
      taskId,
      "Plan Review replan cap exhausted — awaiting operator arbitration",
      buildConvergenceDossier(claimedTask, stop),
      context,
    );
    /*
    FNXC:ReviewConvergence 2026-08-22-06:51:
    The operator-authored Plan Review cap remains observable without exposing reviewer prose in
    telemetry. Emit only identifiers, counts, and fixed outcomes; the dossier remains task-log-only.
    */
    if (context) await emitBoundedRunAudit(deps.store, {
      taskId, agentId: context.agentId, runId: context.runId, domain: "database",
      mutationType: "task:review-convergence-human-escalation", target: taskId,
      metadata: {
        workflowStepId: stop.workflowStepId ?? stop.stepName,
        stop: stop.kind,
        stage: 3,
        cycle: claimedTask.reviewConvergenceEscalationCount ?? 0,
        awaitingApprovalReason: "plan-review-replan-cap",
        outcome: "awaiting-approval",
      },
    });
    return "human-escalated";
  }
  if (claimedStage === 2) {
    const outcome = await runReviewArbitration(
      deps,
      claimedTask,
      stop.workflowStepId,
      stop.stepName,
      stop.feedback,
      stop.attempt,
      stop.max,
    );
    await emitEscalationAudit(2, "arbitration");
    if (outcome === "arbitrated") return outcome;
    // A malformed or unavailable arbiter is the final automatic rung, never a silent park.
    await deps.store.updateTask(taskId, { reviewConvergenceStage: 2 }, deps.getRunContextFor(taskId));
    return routeReviewConvergenceLadder(deps, taskId, stop);
  }

  const workflowIr = await resolveWorkflowIrForTask(deps.store, taskId).catch(() => undefined);
  const stepReopenPolicy = resolveStepReopenPolicy(workflowIr);
  if (stop.kind !== "plan-review-cap"
    && stepReopenPolicy === "none"
    && !hasPendingReviewRemediationWork(claimedTask, { stepReopenPolicy })) {
    await deps.store.logEntry(
      taskId,
      "Review convergence released — no pending remediation work",
      "This workflow requires named remediation before returning to implementation.",
      deps.getRunContextFor(taskId),
    );
    return "released";
  }

  let mode: "alternate-model" | "executor-remediation" | "replan";
  const failedStep = claimedTask.workflowStepResults?.find((result) =>
    result.workflowStepId === stop.workflowStepId && result.status === "failed");
  const remediationCheckout = resolveRemediationCheckout(claimedTask, failedStep);
  try {
    if (decision.source !== "none") {
      if (!remediationCheckout) throw new Error("Review convergence remediation checkout is unavailable");
      mode = "alternate-model";
      await deps.sendTaskBackForFix(
        claimedTask,
        remediationCheckout.path,
        stop.feedback,
        stop.stepName,
        `Review convergence ${stop.kind}: scheduling one bounded escalation round`,
        true,
        false,
        { attempt: stop.attempt + 1, max: stop.max },
        stop.findings,
        remediationCheckout.persist,
        stepReopenPolicy,
      );
    } else if (stop.kind === "plan-review-cap") {
      mode = "replan";
      const replanColumn = await moveTaskToReplanColumn(
        deps.store,
        { id: taskId, column: claimedTask.column },
        "plan-review-revise-replan",
        undefined,
        { workflowMoveSource: "workflow-remediation" },
      );
      if (!replanColumn || typeof replanColumn === "object") throw new Error("Plan Review replan target is unavailable");
      await deps.store.updateTask(taskId, {
        status: "needs-replan",
        error: null,
        recoveryRetryCount: null,
        nextRecoveryAt: null,
        graphResumeRetryCount: 0,
      }, deps.getRunContextFor(taskId));
    } else {
      if (!remediationCheckout) throw new Error("Review convergence remediation checkout is unavailable");
      mode = "executor-remediation";
      await deps.sendTaskBackForFix(
        claimedTask,
        remediationCheckout.path,
        stop.feedback,
        stop.stepName,
        `Review convergence ${stop.kind}: resume named remediation in execution`,
        true,
        false,
        { attempt: stop.attempt + 1, max: stop.max },
        stop.findings,
        remediationCheckout.persist,
        stepReopenPolicy,
      );
    }
  } catch (_error) {
    if (atomic) {
      await atomic.call(deps.store, taskId, (current) => current.reviewConvergenceStage === 1
        ? { reviewConvergenceStage: 0, reviewConvergenceEscalationCount: Math.max(0, (current.reviewConvergenceEscalationCount ?? 1) - 1) }
        : null, deps.getRunContextFor(taskId));
    } else {
      await deps.store.updateTask(taskId, { reviewConvergenceStage: 0, reviewConvergenceEscalationCount: 0 }, deps.getRunContextFor(taskId));
    }
    return "declined";
  }
  await emitEscalationAudit(1, mode);
  return "escalated";
}

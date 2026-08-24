/*
FNXC:ReviewConvergence 2026-08-22-05:54:
FN-149 requires an exhausted or unchanged review cycle to take one bounded AI remediation action before it can park for a human. The atomic stage claim prevents concurrent graph and recovery paths from scheduling duplicate bounces.
*/
import type { Task, TaskStore, WorkflowReviewFinding } from "@fusion/core";
import {
  collectDisputedFindings,
  hasPreMergeRemediationAutoMergeHold,
  isOpenWorkflowReviewFinding,
  resolveReviewConvergenceEscalationTarget,
} from "@fusion/core";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { moveTaskToReplanColumn } from "../execution/replan-target.js";
import type { EngineRunContext } from "../util/run-audit.js";
import { emitBoundedRunAudit } from "./emit-bounded-run-audit.js";
import { runReviewArbitration } from "./review-arbitration.js";

export const REVIEW_CONVERGENCE_MAX_LADDER_CYCLES = 3;

export type ReviewConvergenceStop = {
  kind: "repeat-unchanged" | "budget-exhausted" | "plan-review-cap";
  workflowStepId?: string;
  stepName: string;
  feedback: string;
  findings?: WorkflowReviewFinding[];
  attempt: number;
  max?: number;
};

export type ReviewConvergenceLadderDeps = {
  /** FNXC:Identity 2026-08-23-06:40: total run carrier — main added this seam after U18 converted
   *  the store, so its writes arrived with no actor. Required so a call site cannot omit it. */
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  sendTaskBackForFix: (
    task: Task, worktreePath: string, failureFeedback: string, stepName: string, reason: string,
    preserveResumeState: boolean, mergeVerificationFailure: boolean,
    retryPresentation?: { attempt: number; max?: number }, findings?: WorkflowReviewFinding[],
  ) => Promise<void>;
};

export type ReviewConvergenceLadderOutcome = "escalated" | "arbitrated" | "human-escalated" | "declined";

/*
FNXC:ReviewConvergence 2026-08-22-06:51:
FN-149 makes human escalation loud only after automatic routes are exhausted. The task log, unlike
run-audit metadata, may retain the compact Level-4 dossier needed for an operator to decide without
reconstructing the reviewer and implementer positions from separate sessions.
*/
function buildHumanEscalationDossier(task: Task, stop: ReviewConvergenceStop): string {
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
  let claimed = false;
  let claimedStage: 1 | 2 | 3 | undefined;
  let escalationTarget: ReturnType<typeof resolveReviewConvergenceEscalationTarget> | undefined;
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
    claimedStage = cycles >= REVIEW_CONVERGENCE_MAX_LADDER_CYCLES || currentStage >= 2
      ? 3
      : currentStage === 1 ? 2 : 1;
    escalationTarget = resolveReviewConvergenceEscalationTarget(currentSettings);
    claimedTask = current;
    claimed = true;
    return {
      reviewConvergenceStage: claimedStage,
      reviewConvergenceEscalationCount: cycles + 1,
      ...(claimedStage === 1 && escalationTarget?.enabled && escalationTarget.provider && escalationTarget.modelId
        ? { modelProvider: escalationTarget.provider, modelId: escalationTarget.modelId }
        : {}),
    };
  };
  const atomic = (deps.store as TaskStore & { updateTaskAtomic?: TaskStore["updateTaskAtomic"] }).updateTaskAtomic;
  if (atomic) {
    await atomic.call(deps.store, taskId, claim, deps.runContextFor(taskId));
  } else {
    const patch = await claim(task);
    if (patch) await deps.store.updateTask(taskId, patch, deps.runContextFor(taskId));
  }
  if (!claimed || !claimedTask || !claimedStage) return "declined";

  if (claimedStage === 3) {
    const context = deps.runContextFor(taskId);
    await deps.store.updateTask(taskId, {
      status: "awaiting-approval",
      awaitingApprovalReason: stop.kind === "plan-review-cap" ? "plan-review-replan-cap" : "code-review-non-convergence",
      error: null,
      nextRecoveryAt: null,
    }, context);
    await deps.store.logEntry(
      taskId,
      "Review convergence exhausted — awaiting operator arbitration",
      buildHumanEscalationDossier(claimedTask, stop),
      context,
    );
    /*
    FNXC:ReviewConvergence 2026-08-22-06:51:
    FN-149 requires the final human-last park to be observable without exposing reviewer prose in
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
        awaitingApprovalReason: stop.kind === "plan-review-cap" ? "plan-review-replan-cap" : "code-review-non-convergence",
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
    if (outcome === "arbitrated") return outcome;
    // A malformed or unavailable arbiter is the final automatic rung, never a silent park.
    await deps.store.updateTask(taskId, { reviewConvergenceStage: 2 }, deps.runContextFor(taskId));
    return routeReviewConvergenceLadder(deps, taskId, stop);
  }

  let mode: "alternate-model" | "replan";
  try {
    if (escalationTarget?.enabled) {
      mode = "alternate-model";
      await deps.sendTaskBackForFix(
        claimedTask,
        claimedTask.worktree ?? "",
        stop.feedback,
        stop.stepName,
        `Review convergence ${stop.kind}: scheduling one bounded escalation round`,
        true,
        false,
        { attempt: stop.attempt + 1, max: stop.max },
        stop.findings,
      );
    } else {
      /*
      FNXC:ReviewConvergence 2026-08-22-05:44:
      FN-149 makes the no-model stage-one action a remediation-provenanced replan, not an
      execution bounce. Plan Review can have no worktree, and a reported escalation is valid
      only after the replan move actually occurred; an undeclared replan lane must fall through.
      */
      mode = "replan";
      const replanColumn = await moveTaskToReplanColumn(
        deps.store,
        { id: taskId, column: claimedTask.column },
        undefined,
        { workflowMoveSource: "workflow-remediation" },
      );
      if (!replanColumn) throw new Error("review convergence replan target is unavailable");
      await deps.store.updateTask(taskId, {
        status: "needs-replan",
        error: null,
        recoveryRetryCount: null,
        nextRecoveryAt: null,
        graphResumeRetryCount: 0,
      }, deps.runContextFor(taskId));
    }
  } catch (_error) {
    if (atomic) {
      await atomic.call(deps.store, taskId, (current) => current.reviewConvergenceStage === 1
        ? { reviewConvergenceStage: 0, reviewConvergenceEscalationCount: Math.max(0, (current.reviewConvergenceEscalationCount ?? 1) - 1) }
        : null, deps.runContextFor(taskId));
    } else {
      await deps.store.updateTask(taskId, { reviewConvergenceStage: 0, reviewConvergenceEscalationCount: 0 }, deps.runContextFor(taskId));
    }
    return "declined";
  }
  const runContext = deps.runContextFor(taskId);
  if (runContext) await emitBoundedRunAudit(deps.store, {
    taskId, agentId: runContext.agentId, runId: runContext.runId, domain: "database",
    mutationType: "task:review-convergence-escalation", target: taskId,
    metadata: { workflowStepId: stop.workflowStepId ?? stop.stepName, stop: stop.kind, stage: 1,
      cycle: (claimedTask.reviewConvergenceEscalationCount ?? 0) + 1,
      mode, hasModelTarget: escalationTarget?.enabled === true },
  });
  return "escalated";
}

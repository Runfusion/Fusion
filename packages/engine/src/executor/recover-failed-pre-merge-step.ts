/**
 * FNXC:CodeOrganization 2026-08-03-09:20:
 * recoverFailedPreMergeWorkflowStep peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowPostMerge 2026-06-26-14:00:
 * A failed pre-merge result is a blocking gate failure by construction. Recovery revives the task
 * from that failed gate while retaining the gate's structured findings for the implementer.
 */
import type { Task, TaskStore, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";
import { hasPreMergeRemediationAutoMergeHold, resolveStepReopenPolicy, resolveWorkflowIrForTask } from "@fusion/core";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import type {
  AppendReviewRemediationOptions,
  AppendReviewRemediationOutcome,
} from "./append-review-remediation-steps.js";
import { reassertRemediationAttempt } from "./claim-review-remediation-attempt.js";
import { ClaimSupersededError, fenceStoreForClaim } from "./fence-store-for-claim.js";
import { routeReviewConvergenceLadder } from "./review-convergence-ladder.js";
import { hasRepeatedUnchangedReview, reviewInputSignature, type RequestPreMergeOptionalStepFixInfo } from "./request-pre-merge-optional-step-fix.js";
import { resolveReviewRemediationGate } from "./review-remediation-gate.js";
import { resolveRemediationCheckout } from "./resolve-remediation-checkout.js";
import { isDefiniteEmptyCodeReviewRevise } from "./review-empty-content-close.js";

export type RemediationRefusalReason =
  | "no-actionable-findings"
  | "upstream-out-of-scope"
  | "unclassified-gate-no-reopen"
  | "appender-declined";

export type ReviewRemediationAttemptDescriptor = {
  workflowStepId: string;
  signature: string;
  owner: string;
};

/** The caller distinguishes a durable refusal from a transient skip or a stale claimed review. */
export type RecoverFailedPreMergeStepOutcome =
  | { kind: "scheduled" }
  | { kind: "refused"; reason: RemediationRefusalReason; gate: string }
  | { kind: "skipped" }
  | { kind: "superseded" };

export type RecoverFailedPreMergeStepDeps = {
  store: TaskStore;
  getRunContextFor?: (taskId: string) => EngineRunContext | undefined;
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
  resolveFailedPreMergeWorkflowStepBudget: (
    task: Task,
    target: CoreWorkflowStepResult,
  ) => Promise<{ unbounded: boolean; max: number; label: string; key: string; stepName?: string; attempts: number }>;
  appendReviewRemediationSteps?: (
    task: Task,
    info: RequestPreMergeOptionalStepFixInfo,
    options?: AppendReviewRemediationOptions,
  ) => Promise<AppendReviewRemediationOutcome>;
  sendTaskBackForFix: (
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
    reason: string,
    preserveResumeState?: boolean,
    mergeVerificationFailure?: boolean,
    retryPresentation?: { attempt: number; max?: number },
    findings?: CoreWorkflowStepResult["findings"],
    persistWorktreePath?: boolean,
    stepReopenPolicy?: "reopen-trailing" | "none",
  ) => Promise<void>;
};

function latestFailedPreMergeStep(task: Pick<Task, "workflowStepResults">): CoreWorkflowStepResult | undefined {
  return (task.workflowStepResults ?? [])
    .filter((result) => (result.phase || "pre-merge") === "pre-merge" && result.status === "failed")
    .sort((left, right) => {
      const leftTime = Date.parse(left.completedAt || left.startedAt || "");
      const rightTime = Date.parse(right.completedAt || right.startedAt || "");
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    })[0];
}

function refusalFromAppender(outcome: AppendReviewRemediationOutcome): RemediationRefusalReason {
  switch (outcome) {
    case "released-no-actionable-findings":
    case "released-no-pending-work":
      return "no-actionable-findings";
    case "released-upstream-out-of-scope":
      return "upstream-out-of-scope";
    default:
      return "appender-declined";
  }
}

/** True only for the successful hand-off outcome; callers must not treat every object as success. */
export function isRecoverFailedPreMergeStepScheduled(outcome: RecoverFailedPreMergeStepOutcome): boolean {
  return outcome.kind === "scheduled";
}

/**
 * FNXC:LifecycleContainment 2026-08-30-13:36:
 * A claimed recovery runs against the same fenced store the live requester uses. Its refusal
 * branches — operator hold, checkout unavailable, zero/exhausted budget, the convergence ladder —
 * each NARRATE on the task, and a log entry cannot be withdrawn by a later fenced refusal. Fencing
 * the store, rather than adding a check per branch, is what stops the next branch from reopening
 * the hole: supersession surfaces as a thrown sentinel and becomes a silent `superseded` outcome.
 */
export async function recoverFailedPreMergeWorkflowStepDetailed(
  rawDeps: RecoverFailedPreMergeStepDeps,
  task: Task,
  options: { claim?: ReviewRemediationAttemptDescriptor } = {},
): Promise<RecoverFailedPreMergeStepOutcome> {
  const deps: RecoverFailedPreMergeStepDeps = options.claim
    ? { ...rawDeps, store: fenceStoreForClaim(rawDeps.store, task.id, options.claim) }
    : rawDeps;
  try {
    /*
    FNXC:LifecycleContainment 2026-08-30-12:57:
    A claim-scoped recovery must resolve its exact failed result before emitting a comment, logging a
    refusal, appending work, or asking for a move. The step id is the durable address and the review
    signature identifies its round; a moved or absent target is superseded and remains completely
    silent so an older worker cannot narrate or remediate a newer review.
    */
    let liveTask = task;
    let target: CoreWorkflowStepResult | undefined;
    if (options.claim) {
      const current = await deps.store.getTask(task.id);
      target = current?.workflowStepResults?.find((result) => result.workflowStepId === options.claim!.workflowStepId);
      if (!current || !target || reviewInputSignature(target) !== options.claim.signature) return { kind: "superseded" };
      liveTask = current;
    } else {
      target = latestFailedPreMergeStep(task);
    }
    if (!target) {
      executorLog.warn(`${task.id}: no failed pre-merge workflow step to recover from`);
      return { kind: "skipped" };
    }

    if (hasPreMergeRemediationAutoMergeHold(liveTask, await deps.store.getSettings())) {
      const reason = "operator-authored task-level auto-merge Off holds failed-step recovery";
      executorLog.warn(`${liveTask.id}: failed pre-merge step recovery NOT scheduled — ${reason}. Card left parked.`);
      await deps.store.logEntry(
        liveTask.id,
        "Failed pre-merge step recovery not scheduled — operator task hold",
        `Reason: ${reason}`,
        deps.getRunContextFor?.(liveTask.id),
      );
      return { kind: "skipped" };
    }

    const feedback = target.output?.trim() || "(no feedback captured)";
    const stepName = target.workflowStepName || target.workflowStepId || "Unknown";
    const checkout = resolveRemediationCheckout(liveTask, target);
    if (!checkout) {
      executorLog.warn(`${liveTask.id}: failed pre-merge step recovery NOT scheduled for "${stepName}" — no remediation checkout is available. Card left parked.`);
      await deps.store.logEntry(
        liveTask.id,
        "Failed pre-merge step recovery not scheduled — checkout unavailable",
        `Step: ${stepName}\nNo singular worktree or acquired workspace repository worktree is available. Retry after restoring the task checkout, or use the privileged review bypass when the failed review is known to be non-blocking.`,
        deps.getRunContextFor?.(liveTask.id),
      );
      return { kind: "skipped" };
    }

    const info: RequestPreMergeOptionalStepFixInfo = {
      nodeId: target.workflowStepId,
      stepName,
      feedback,
      phase: target.phase ?? "pre-merge",
      status: target.status,
      verdict: target.verdict,
      findings: target.findings,
      reviewKind: target.reviewKind,
    };
    const gate = resolveReviewRemediationGate(info);
    const producesRemediation = Boolean(
      gate && deps.appendReviewRemediationSteps && (gate !== "Code Review" || target.verdict === "REVISE"),
    );

    /*
    FNXC:ReviewEmptyContent 2026-08-30-13:36:
    FN-267: the empty-diff close must never PRE-EMPT the deterministic Fix-step producer. A Code
    Review REVISE carrying the empty-diff fingerprint but no usable findings used to park terminally
    right here, which is the one outcome the operator requirement forbids — a REVISE may not block a
    card merely because fix steps were absent. The close is now the FALLBACK for a review no producer
    can serve: it keeps its original position (ahead of every budget branch) for gates with no
    producer, and otherwise runs only after the producer has actually declined.
    */
    const closeEmptyReviewContent = async (): Promise<boolean> => {
      const emptyTarget = target;
      if (!isDefiniteEmptyCodeReviewRevise(emptyTarget)) return false;
      const outcome = await routeReviewConvergenceLadder({
        ...deps,
        getRunContextFor: deps.getRunContextFor ?? (() => undefined),
      }, liveTask.id, {
        kind: "empty-review-input",
        workflowStepId: emptyTarget.workflowStepId,
        stepName,
        feedback,
        findings: emptyTarget.findings,
        attempt: 1,
        emptyInputFence: {
          workflowStepId: emptyTarget.workflowStepId,
          stepName,
          expectedStartedAt: emptyTarget.startedAt,
          expectedCompletedAt: emptyTarget.completedAt,
          expectedVerdict: emptyTarget.verdict,
          expectedReviewInputFingerprint: emptyTarget.reviewInputFingerprint!,
        },
      });
      return outcome === "empty-content-terminalized";
    };
    if (!producesRemediation && await closeEmptyReviewContent()) return { kind: "skipped" };

    const budget = await deps.resolveFailedPreMergeWorkflowStepBudget(liveTask, target);
    if (!budget.unbounded && (!Number.isFinite(budget.max) || budget.max <= 0)) {
      executorLog.warn(`${liveTask.id}: failed pre-merge step recovery NOT scheduled for "${stepName}" — revision budget is zero/invalid (attempts=${budget.attempts}, max=${String(budget.max)}). Card left parked.`);
      await deps.store.logEntry(
        liveTask.id,
        "Failed pre-merge step recovery not scheduled — revision budget zero/invalid",
        `Step: ${stepName}\nAttempts: ${budget.attempts}\nMax: ${String(budget.max)}`,
        deps.runContextFor?.(liveTask.id),
      );
      return { kind: "skipped" };
    }

    if (hasRepeatedUnchangedReview(liveTask, {
      nodeId: target.workflowStepId,
      stepName,
      feedback,
      phase: target.phase ?? "pre-merge",
      status: target.status,
      verdict: target.verdict,
      findings: target.findings,
    })) {
      const outcome = await routeReviewConvergenceLadder({
        ...deps,
        getRunContextFor: deps.getRunContextFor ?? (() => undefined),
      }, liveTask.id, {
        kind: "repeat-unchanged", workflowStepId: target.workflowStepId, stepName,
        feedback, findings: target.findings, attempt: budget.attempts,
        max: budget.unbounded ? undefined : budget.max,
      });
      return outcome === "escalated" || outcome === "arbitrated"
        ? { kind: "scheduled" }
        : { kind: "skipped" };
    }
    if (!budget.unbounded && budget.attempts >= budget.max) {
      const outcome = await routeReviewConvergenceLadder({
        ...deps,
        getRunContextFor: deps.getRunContextFor ?? (() => undefined),
      }, liveTask.id, {
        kind: "budget-exhausted", workflowStepId: target.workflowStepId, stepName,
        feedback, findings: target.findings, attempt: budget.attempts, max: budget.max,
      });
      if (outcome === "escalated" || outcome === "arbitrated") return { kind: "scheduled" };
      executorLog.warn(`${liveTask.id}: failed pre-merge step recovery NOT scheduled for "${stepName}" — revision budget exhausted (attempts=${budget.attempts}, max=${String(budget.max)}). Card left parked.`);
      await deps.store.logEntry(liveTask.id, "Failed pre-merge step recovery not scheduled — revision budget exhausted", `Step: ${stepName}\nAttempts: ${budget.attempts}\nMax: ${String(budget.max)}`, deps.runContextFor?.(liveTask.id));
      return { kind: "skipped" };
    }

    const workflowIr = await resolveWorkflowIrForTask(deps.store, liveTask.id).catch(() => undefined);
    const stepReopenPolicy = resolveStepReopenPolicy(workflowIr);

    /*
    FNXC:LifecycleContainment 2026-08-30-12:57:
    FN-267 reverses the deadlocking order for recovery. A classified Code Review or Verification
    first runs the shared named-remediation producer, which performs its own guarded hand-off only
    after the Fix work is durable. The direct send-back route is reserved for an unclassified
    trailing-reopen workflow, whose producer is its ordinary replay occurrence.
    */
    /*
    FNXC:LifecycleContainment 2026-08-30-13:36:
    The re-assert wraps the CALL to each hand-off, never its body: sendTaskBackForFix writes its
    comment and "moved back" entry as its first durable acts, and the appender updates the task
    before returning, so an inner check is already too late to keep the boundary. A refused
    re-assert means a newer review round replaced the claimed one; the overtaken runner then goes
    completely silent rather than narrating or remediating a round it never examined.
    */
    const holdsClaim = async (): Promise<boolean> => {
      if (!options.claim) return true;
      const reasserted = await reassertRemediationAttempt(deps.store, liveTask.id, options.claim);
      return reasserted.applied;
    };

    if (producesRemediation && deps.appendReviewRemediationSteps) {
      if (!await holdsClaim()) return { kind: "superseded" };
      const appenderOutcome = await deps.appendReviewRemediationSteps(liveTask, info);
      if (appenderOutcome === "appended") return { kind: "scheduled" };
      /* The producer genuinely declined; only now may a provably empty round close terminally. */
      if (await closeEmptyReviewContent()) return { kind: "skipped" };
      return { kind: "refused", reason: refusalFromAppender(appenderOutcome), gate: gate ?? stepName };
    }
    if (stepReopenPolicy !== "reopen-trailing") {
      return { kind: "refused", reason: "unclassified-gate-no-reopen", gate: stepName };
    }
    if (!await holdsClaim()) return { kind: "superseded" };
    await deps.sendTaskBackForFix(
      liveTask,
      checkout.path,
      feedback,
      stepName,
      `Auto-revived from in-review: pre-merge workflow step "${stepName}" had failed`,
      true,
      false,
      { attempt: budget.attempts + 1, max: budget.unbounded ? undefined : budget.max },
      target.findings,
      checkout.persist,
      stepReopenPolicy,
    );
    return { kind: "scheduled" };
  } catch (err: unknown) {
    if (err instanceof ClaimSupersededError) return { kind: "superseded" };
    const errorMessage = err instanceof Error ? err.message : String(err);
    executorLog.error(`Failed to recover failed pre-merge workflow step for ${task.id}: ${errorMessage}`);
    return { kind: "skipped" };
  }
}

/**
 * Compatibility entry point for existing non-claim callers. New owner-scoped recovery uses the
 * detailed outcome so a durable refusal, transient skip, and supersession remain distinguishable.
 */
export async function recoverFailedPreMergeWorkflowStep(
  deps: RecoverFailedPreMergeStepDeps,
  task: Task,
): Promise<boolean> {
  return isRecoverFailedPreMergeStepScheduled(await recoverFailedPreMergeWorkflowStepDetailed(deps, task));
}

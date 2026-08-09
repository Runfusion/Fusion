/**
 * FNXC:CodeOrganization 2026-08-03-12:20:
 * requestPreMergeOptionalStepFix peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowOptionalStepFix 2026-06-26-16:35:
 * Inline graph optional-step remediation consumes `postReviewFixCount` BEFORE calling `sendTaskBackForFix`, matching self-healing's budget-first ordering. Persistent optional-step REVISE loops are bounded by the resolved optional-group budget; `"unbounded"` intentionally skips the ceiling check so the step cycles until it returns APPROVE/APPROVE_WITH_NOTES or a human intervenes.
 *
 * FNXC:WorkflowRevisionBudget 2026-06-30-20:48:
 * Live Plan Review/spec and Code Review remediation must honor explicit workflow setting values before node `maxRevisions`, and must treat unset values as unbounded for those two built-in review paths. Browser Verification keeps the existing `maxPostReviewFixes` fallback unless its node config explicitly changes it.
 *
 * FNXC:WorkflowRevisionBudget 2026-06-30-22:04:
 * Plan Review and Code Review caps are independent policy budgets, so attempts are counted by workflow step key instead of the legacy aggregate `postReviewFixCount`. The aggregate still increments for existing dashboard summaries, but it must not let a Plan Review replan consume a Code Review remediation slot.
 *
 * FNXC:WorkflowRemediation 2026-07-03-20:10:
 * Pre-merge optional-step / Plan Review failure handoff: missing required artifacts
 * recover in place; Plan Review REVISE drives triage replan with revision budget + hard cap;
 * other REVISE verdicts bounce via sendTaskBackForFix.
 *
 * FNXC:PlanReviewReplan 2026-07-05-17:32:
 * FN-7561: malformed advisory_failure without REVISE must never replan.
 *
 * FNXC:PlanReviewReplan 2026-07-15-12:00:
 * FN-7977: provider/model/transport failures without REVISE stay in place.
 *
 * FNXC:RemediationVisibility 2026-07-26-19:20:
 * Unscheduled remediation (zero budget, non-REVISE hard fail) must log loudly, never silently park.
 */
import type { Task, TaskStore, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";
import {
  DEFAULT_MAX_POST_REVIEW_FIXES,
  hasPreMergeRemediationAutoMergeHold,
  PLAN_REVIEW_GROUP_ID,
  resolveOptionalReviewRevisionBudget,
  resolveOptionalStepRevisionBudget,
} from "@fusion/core";
import { mergeEffectiveSettings } from "../project/effective-settings.js";
import { moveTaskToReplanColumn, resolveReplanTargetColumn } from "../execution/replan-target.js";
import { isNonPlanDefectPlanReviewFailure } from "../errors/transient-error-detector.js";
import { parseRequiredArtifactMissingValue } from "../execution/required-workflow-artifacts.js";
import {
  countOptionalStepRevisionAttempts,
  optionalStepRevisionKey,
  optionalStepRevisionLogOutcome,
} from "./optional-step-revision.js";
import {
  countPlanReviewRevisionAttempts,
  formatPlanReviewRevisionFeedback,
  PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT,
} from "../plan-review-feedback-history.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";

export type RequestPreMergeOptionalStepFixInfo = {
  stepName: string;
  feedback: string;
  phase: CoreWorkflowStepResult["phase"];
  status: CoreWorkflowStepResult["status"];
  verdict?: string;
  /** Raw graph node result when no reviewer verdict was produced. */
  failureValue?: string;
  nodeId?: string;
  maxRevisions?: unknown;
};

export type RequestPreMergeOptionalStepFixDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  recoverMissingRequiredArtifacts: (
    task: Task,
    artifactKeys: string[],
    source: { source: "graph-entry" | "workflow-step"; nodeId?: string },
  ) => Promise<void>;
  parkPlanReviewReplanCapExhausted: (
    taskId: string,
    capLabel: string,
    currentCount: number,
    feedback: string,
  ) => Promise<void>;
  clearPausedAborted: (taskId: string) => void;
  workflowLifecycleMovesInFlight: Set<string>;
  sendTaskBackForFix: (
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
    reason: string,
    preserveResumeState: boolean,
    mergeVerificationFailure: boolean,
    retryPresentation?: { attempt: number; max?: number },
  ) => Promise<void>;
};

export async function requestPreMergeOptionalStepFix(
  deps: RequestPreMergeOptionalStepFixDeps,
  taskId: string,
  fallbackTask: Task,
  info: RequestPreMergeOptionalStepFixInfo,
): Promise<boolean> {
  if (info.phase !== "pre-merge") return false;
  if (info.status !== "advisory_failure" && info.status !== "failed") return false;

  const liveTask = await deps.store.getTask(taskId).catch(() => fallbackTask);
  /*
   * FNXC:SharedBranchMemberHold 2026-08-06-00:12:
   * An operator-authored task Off is a durable manual checkpoint, not merely
   * an auto-merge admission preference. Pre-merge remediation must not reopen
   * implementation and thereby bypass that checkpoint before the operator
   * releases or revises the held member.
   *
   * FNXC:SharedBranchMemberHold 2026-08-09-21:41:
   * FN-8910: remediation reopens implementation rather than merging. The
   * merge boundary independently enforces project Off, so this seam fences
   * only an operator-authored task-level Off and records every refusal.
   */
  if (hasPreMergeRemediationAutoMergeHold(liveTask, await deps.store.getSettings())) {
    const reason = "operator-authored task-level auto-merge Off holds pre-merge remediation";
    executorLog.warn(`${taskId}: pre-merge remediation NOT scheduled for step "${info.stepName}" — ${reason}. Card left parked.`);
    await deps.store.logEntry(
      taskId,
      "Pre-merge remediation not scheduled — operator task hold",
      `Step/node: ${info.nodeId ?? info.stepName}\nReason: ${reason}`,
      deps.getRunContextFor(taskId),
    );
    return false;
  }
  const missingArtifactKeys = parseRequiredArtifactMissingValue(info.failureValue);
  if (missingArtifactKeys) {
    await deps.recoverMissingRequiredArtifacts(liveTask, missingArtifactKeys, {
      source: "workflow-step",
      nodeId: info.nodeId,
    });
    return true;
  }
  const isPlanReview = info.nodeId === "plan-review" || info.stepName === "Plan Review";
  if (isPlanReview) {
    /*
     * FNXC:PlanReviewReplan 2026-07-05-17:32:
     * FN-7561: a malformed reviewer response arrives as `advisory_failure` with NO parsed verdict. That is an infra/formatting failure (e.g. the reviewer could not locate the spec, or fumbled its trailing JSON), not a plan defect — it must NEVER bounce the task to a triage replan. The graph already excludes malformed advisories from the fix handoff (shouldRequestPreMergeFix); this guard defends the explicit remediation-node path and any future caller so a malformed advisory can never drive the replan loop. A genuine REVISE (verdict === "REVISE", also carried as advisory_failure) still replans below.
     */
    if (info.status === "advisory_failure" && info.verdict !== "REVISE") return false;
    if (info.verdict !== undefined && info.verdict !== "REVISE") return false;
    /*
     * FNXC:PlanReviewReplan 2026-07-15-12:00:
     * FN-7977 / issue #2124: graph traversal is the primary guard, but this
     * compatibility seam also receives explicit remediation edges and future
     * callers. A provider/model/transport failure without a genuine REVISE must
     * be logged and left in its current execution column, never sent to replan.
     */
    if (isNonPlanDefectPlanReviewFailure({
      verdict: info.verdict,
      errorMessage: info.feedback,
      failureValue: info.failureValue,
    })) {
      await deps.store.logEntry(
        taskId,
        "Plan Review provider failure — task kept in place",
        `Plan Review failed without a REVISE verdict due to a provider, model, transport, or abort condition. The task remains in ${liveTask.column}; no automatic replan was scheduled.\n\nDiagnostic:\n${info.feedback}`,
        deps.getRunContextFor(taskId),
      );
      return false;
    }
    /*
     * FNXC:PlanReviewReplan 2026-06-29-00:41:
     * Plan Review is pre-execution spec validation, so a failed/revision result
     * must repair PROMPT.md through triage instead of reopening implementation
     * steps. Triage already advances an approved `needs-replan` task to `todo`,
     * which lets the scheduler continue execution after the planner fixes it.
     */
    const feedback = info.feedback?.trim()
      || "Plan Review failed before execution. Revise the task plan, then continue execution.";
    const settings = await mergeEffectiveSettings(deps.store, liveTask, await deps.store.getSettings());
    const maxRevisions = resolveOptionalReviewRevisionBudget({
      optionalGroupId: info.nodeId ?? "plan-review",
      workflowSettings: settings as Record<string, unknown>,
      nodeMaxRevisions: info.maxRevisions,
      fallbackMaxRevisions: settings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES,
    });
    const budget = resolveOptionalStepRevisionBudget(maxRevisions, settings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES);
    if (!budget.unbounded && (!Number.isFinite(budget.max) || budget.max <= 0)) {
      // FNXC:RemediationVisibility 2026-07-26-19:20 (FN-8596 follow-up): returning false here
      // makes the graph's plan-replan node fail with `remediation-not-scheduled` and leaves the
      // card parked in place with nothing scheduled to fix it. Never let that be silent.
      executorLog.warn(
        `${taskId}: plan-review remediation NOT scheduled — revision budget is zero/invalid (max=${String(budget.max)}). Card left parked.`,
      );
      return false;
    }
    const revisionKey = optionalStepRevisionKey(info.nodeId ?? "plan-review", info.stepName);
    // FNXC:PlanReviewConvergence 2026-08-04-06:35 (FN-8768): The terminal
    // result is persisted before remediation. Budget from the durable raw
    // same-episode count, not the capped prompt history or cross-episode log.
    const currentEpisodeAttemptCount = countPlanReviewRevisionAttempts(
      liveTask.workflowStepResults,
      { revisionKey },
    );
    const matchingProjection = liveTask.workflowStepResults?.find((result) =>
      result.workflowStepId === revisionKey
      || (revisionKey === PLAN_REVIEW_GROUP_ID && result.workflowStepName === "Plan Review"),
    );
    const hasEpisodeBoundary = matchingProjection?.supersededAt != null
      || matchingProjection?.priorAttempts?.some((attempt) => attempt.supersededAt != null) === true;
    const nextCount = currentEpisodeAttemptCount > 0
      ? currentEpisodeAttemptCount
      : hasEpisodeBoundary
        ? 1
        : countOptionalStepRevisionAttempts(liveTask, revisionKey, info.stepName) + 1;
    const currentCount = nextCount - 1;
    if (!budget.unbounded && currentCount >= budget.max) {
      // U3: finite replan budget exhausted → park awaiting-approval (cap park
      // re-owned from the deleted triage gate), not a silent leave-in-place.
      const feedbackForPark = info.feedback?.trim()
        || "Plan Review requested another planning revision but the replan budget is exhausted.";
      await deps.parkPlanReviewReplanCapExhausted(taskId, String(budget.max), currentCount, feedbackForPark);
      return true;
    }
    /*
     * FNXC:PlanReviewReplanCap 2026-07-05-17:28:
     * FN-7561: an unset Plan Review revision budget resolves to "unbounded" (see FNXC:WorkflowRevisionBudget above), which by design skips the ceiling check — so a task whose planner and reviewer persistently disagree, or whose reviewer keeps hard-failing, replans triage↔plan-review forever, silently burning a triage + review LLM call every cycle (FN-7525 ran 13+ attempts overnight with zero operator visibility). Enforce a finite safety ceiling even when unbounded: once hit, emit a loud
     * halting log entry and STOP replanning so the gate falls through to a visible failed/parked state a human can act on. Explicit numeric operator budgets are still honored as-is above; this only backstops the unbounded DEFAULT.
     */
    if (budget.unbounded && currentCount >= PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT) {
      // U3: the unbounded-default safety ceiling now parks awaiting-approval with
      // the replan-cap reason (re-owned from the deleted triage gate) so the
      // non-convergence surfaces to a human instead of silently sitting in place.
      await deps.parkPlanReviewReplanCapExhausted(
        taskId,
        String(PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT),
        currentCount,
        feedback,
      );
      return true;
    }
    const totalFixCount = (liveTask.postReviewFixCount ?? 0) + 1;
    const budgetLabel = budget.unbounded ? "unbounded" : String(budget.max);
    await deps.store.updateTask(taskId, { postReviewFixCount: totalFixCount }, deps.getRunContextFor(taskId));
    deps.clearPausedAborted(taskId);
    await deps.store.logEntry(
      taskId,
      "AI spec revision requested",
      formatPlanReviewRevisionFeedback(revisionKey, info.status, feedback),
      deps.getRunContextFor(taskId),
    );
    /*
    FNXC:PlanReviewReplan 2026-07-12-23:20:
    The replan rebound is workflow-aware: workflows without a "triage" column (Coding
    (Ideas)) replan in place in their planner column ("todo") instead of being orphaned
    in an undeclared "triage" column, which the board rendered back in the intake lane.
    */
    const replanColumn = await resolveReplanTargetColumn(deps.store, taskId);
    await deps.store.logEntry(
      taskId,
      `Plan Review failed — moved to ${replanColumn} for automatic replan (attempt ${nextCount}/${budgetLabel})`,
      optionalStepRevisionLogOutcome(feedback, revisionKey),
      deps.getRunContextFor(taskId),
    );
    deps.workflowLifecycleMovesInFlight.add(taskId);
    try {
      await moveTaskToReplanColumn(deps.store, { id: taskId, column: liveTask.column }, replanColumn);
    } finally {
      deps.workflowLifecycleMovesInFlight.delete(taskId);
    }
    await deps.store.updateTask(taskId, {
      status: "needs-replan",
      error: null,
      recoveryRetryCount: null,
      nextRecoveryAt: null,
      graphResumeRetryCount: 0,
    }, deps.getRunContextFor(taskId));
    return true;
  }

  if (info.verdict !== "REVISE") {
    // FNXC:RemediationVisibility 2026-07-26-19:20: a hard-failed gate with no parsed REVISE
    // verdict schedules nothing, so the remediation node fails and the card parks. Say so.
    executorLog.warn(
      `${taskId}: pre-merge remediation NOT scheduled for step "${info.stepName}" — status=${info.status}, verdict=${info.verdict ?? "none"}. Card left parked.`,
    );
    return false;
  }
  const settings = await mergeEffectiveSettings(deps.store, liveTask, await deps.store.getSettings());
  const maxRevisions = resolveOptionalReviewRevisionBudget({
    optionalGroupId: info.nodeId ?? "",
    workflowSettings: settings as Record<string, unknown>,
    nodeMaxRevisions: info.maxRevisions,
    fallbackMaxRevisions: settings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES,
  });
  const budget = resolveOptionalStepRevisionBudget(maxRevisions, settings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES);
  if (!budget.unbounded && (!Number.isFinite(budget.max) || budget.max <= 0)) {
    executorLog.warn(
      `${taskId}: pre-merge remediation NOT scheduled for step "${info.stepName}" — revision budget is zero/invalid (max=${String(budget.max)}). Card left parked.`,
    );
    return false;
  }

  const revisionKey = optionalStepRevisionKey(info.nodeId, info.stepName);
  const currentCount = countOptionalStepRevisionAttempts(liveTask, revisionKey, info.stepName);
  if (!budget.unbounded && currentCount >= budget.max) {
    // Budget exhaustion is a legitimate terminal outcome, but it must be visible: the card stays
    // in place with a failed pre-merge step and only an operator bypass clears it.
    executorLog.warn(
      `${taskId}: pre-merge remediation budget EXHAUSTED for step "${info.stepName}" (${currentCount}/${String(budget.max)}). Card left parked for operator action.`,
    );
    return false;
  }

  const nextCount = currentCount + 1;
  const totalFixCount = (liveTask.postReviewFixCount ?? 0) + 1;
  const budgetLabel = budget.unbounded ? "unbounded" : String(budget.max);
  await deps.store.updateTask(taskId, { postReviewFixCount: totalFixCount }, deps.getRunContextFor(taskId));
  await deps.store.logEntry(
    taskId,
    `Pre-merge optional workflow step requested executor fixes (attempt ${nextCount}/${budgetLabel})`,
    optionalStepRevisionLogOutcome(`Step: ${info.stepName}\nStatus: ${info.status}\nFeedback:\n${info.feedback}`, revisionKey),
    deps.getRunContextFor(taskId),
  );
  await deps.sendTaskBackForFix(
    liveTask,
    liveTask.worktree ?? "",
    info.feedback,
    info.stepName,
    `Pre-merge optional workflow step "${info.stepName}" requested revision`,
    true,
    false,
    { attempt: nextCount, max: budget.unbounded ? undefined : budget.max },
  );
  return true;
}

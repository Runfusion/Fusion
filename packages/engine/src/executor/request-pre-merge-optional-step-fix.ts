/**
 * FNXC:CodeOrganization 2026-08-03-12:20:
 * requestPreMergeOptionalStepFix peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowOptionalStepFix 2026-06-26-16:35:
 * Inline graph optional-step remediation consumes `postReviewFixCount` BEFORE calling `sendTaskBackForFix`, matching self-healing's budget-first ordering. Persistent optional-step REVISE loops are bounded by the resolved optional-group budget; `"unbounded"` intentionally skips the ceiling check so the step cycles until it returns APPROVE/APPROVE_WITH_NOTES or a human intervenes.
 *
 * FNXC:PlanReviewReplan 2026-08-10-18:32:
 * PLAN REVIEW IS THE EXCEPTION to the note above: its `"unbounded"` budget is backstopped by
 * `planReviewReplanCap` (default `DEFAULT_PLAN_REVIEW_REPLAN_CAP`), so it parks at
 * `awaiting-approval` rather than cycling until a human notices. Every other optional group still
 * cycles freely when unbounded.
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
 *
 * FNXC:RemediationVisibility 2026-08-28-12:16:
 * A blocking result that cannot become remediation must also explain the refusal on the card, including the gate identity, concrete budget or scope state, and the operator's retry or privileged-bypass remedies. Engine-only warnings are not visible where operators diagnose a frozen review.
 */
import type { Task, TaskStore, WorkflowReviewFinding, WorkflowStepResult as CoreWorkflowStepResult } from "@fusion/core";
import {
  DEFAULT_MAX_POST_REVIEW_FIXES,
  DEFAULT_PLAN_REVIEW_REPLAN_CAP,
  hasPendingRemediationWork,
  hasPreMergeRemediationAutoMergeHold,
  PLAN_REVIEW_GROUP_ID,
  resolveOptionalReviewRevisionBudget,
  resolveOptionalStepRevisionBudget,
  resolveStepReopenPolicy,
  isReportingOnlyOptionalGroup,
  resolveWorkflowIrForTask,
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
} from "../plan-review-feedback-history.js";
import { executorLog } from "../logger.js";
import type { EngineRunContext } from "../util/run-audit.js";
import {
  deriveWorkspaceReviewRemediation,
  hasDurableRepeatedWorkspaceReview,
} from "./workspace-review-remediation.js";
import { routeReviewConvergenceLadder } from "./review-convergence-ladder.js";
import type {
  AppendReviewRemediationOptions,
  AppendReviewRemediationOutcome,
} from "./append-review-remediation-steps.js";
import { resolveReviewRemediationGate } from "./review-remediation-gate.js";
import { resolveRemediationCheckout } from "./resolve-remediation-checkout.js";
import { isDefiniteEmptyCodeReviewRevise } from "./review-empty-content-close.js";

function normalizeConvergenceText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/*
FNXC:RepositoryScope 2026-08-21-02:17:
R10 convergence is keyed by the actual review input: review node, repository, confirmed scope generation, exact diff fingerprint, blocking verdict, and normalized findings. Reviewer prose is presentation only; it may change without a new defect or remain unchanged after the underlying diff changes.
*/
export function reviewInputSignature(result: CoreWorkflowStepResult): string | undefined {
  const singularFindings = (result.findings ?? [])
    .map((finding) => `${normalizeConvergenceText(finding.filePath)}:${finding.line ?? ""}:${normalizeConvergenceText(finding.body)}`)
    .sort()
    .join("|");
  if (result.reviewInputFingerprint && result.verdict === "REVISE") {
    return `${result.workflowStepId}\u0000${result.reviewInputFingerprint}\u0000${result.verdict}\u0000${singularFindings}`;
  }
  const blocking = (result.repositoryReviewOutcomes ?? [])
    .filter((outcome) => outcome.status === "REVIEWED" && (outcome.verdict === "REVISE" || outcome.verdict === "RETHINK"))
    .map((outcome) => {
      /*
      FNXC:WorkspaceReviewConvergence 2026-08-27-12:05:
      FN-201 makes workspace findings non-empty. Identifier-based signatures would let a model-assigned
      ID change defeat the repeat-unchanged hold and turn bounded remediation into an unbounded loop.
      */
      const findings = (outcome.findings ?? [])
        .map((finding) => `${normalizeConvergenceText(finding.filePath)}:${finding.line ?? ""}:${normalizeConvergenceText(finding.body)}`)
        .sort()
        .join("|");
      return `${outcome.repository}\u0000${outcome.fingerprint ?? ""}\u0000${outcome.verdict}\u0000${findings}`;
    })
    .sort();
  if (blocking.length === 0) return undefined;
  const scopeRevision = result.repositoryScopeRevision === undefined
    ? ""
    : `\u0000${result.repositoryScopeRevision}`;
  return `${result.workflowStepId}${scopeRevision}\u0000${blocking.join("\u0001")}`;
}

export function hasRepeatedUnchangedReview(task: Task, info: RequestPreMergeOptionalStepFixInfo): boolean {
  const revisionKey = info.nodeId ?? info.stepName;
  if (!revisionKey) return false;
  const current = (task.workflowStepResults ?? []).find((result) =>
    (result.workflowStepId === info.nodeId || result.workflowStepName === info.stepName)
    && result.verdict === "REVISE",
  );
  if (!current) return false;
  const currentSignature = reviewInputSignature(current);
  if (!currentSignature) return false;
  const previous = current.priorAttempts?.[0];
  return previous?.verdict === "REVISE" && reviewInputSignature(previous) === currentSignature;
}

/** Backward-compatible code-review name retained for existing remediation callers. */
export const hasRepeatedUnchangedCodeReview = hasRepeatedUnchangedReview;

export type RequestPreMergeOptionalStepFixInfo = {
  stepName: string;
  feedback: string;
  phase: CoreWorkflowStepResult["phase"];
  status: CoreWorkflowStepResult["status"];
  verdict?: string;
  /** Raw graph node result when no reviewer verdict was produced. */
  failureValue?: string;
  nodeId?: string;
  reviewKind?: CoreWorkflowStepResult["reviewKind"];
  workflowAction?: string;
  maxRevisions?: unknown;
  /**
   * FNXC:ReviewSeverityGate 2026-08-10-17:33:
   * Structured findings from a review-kind gate, carried so remediation can present them grouped by
   * priority instead of as one undifferentiated prose blob. Absent for prose-only / non-review steps.
   */
  findings?: WorkflowReviewFinding[];
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
  readTaskArtifact: (taskId: string, key: string) => Promise<string | undefined>;
  appendReviewRemediationSteps: (
    task: Task,
    info: RequestPreMergeOptionalStepFixInfo,
    options?: AppendReviewRemediationOptions,
  ) => Promise<AppendReviewRemediationOutcome>;
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
    findings?: WorkflowReviewFinding[],
    persistWorktreePath?: boolean,
    stepReopenPolicy?: "reopen-trailing" | "none",
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
      await deps.store.logEntry(
        taskId,
        "Plan Review remediation not scheduled — revision budget zero/invalid",
        `Step/node: ${info.nodeId ?? info.stepName}\nMaximum revisions: ${String(budget.max)}\nIncrease the Plan Review revision budget and retry the task, or correct the plan manually before retrying.`,
        deps.getRunContextFor(taskId),
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
      const outcome = await routeReviewConvergenceLadder(deps, taskId, {
        kind: "plan-review-cap", workflowStepId: info.nodeId, stepName: info.stepName,
        feedback: feedbackForPark, findings: info.findings, attempt: currentCount, max: budget.max,
      });
      if (outcome === "escalated" || outcome === "arbitrated") return true;
      await deps.parkPlanReviewReplanCapExhausted(taskId, String(budget.max), currentCount, feedbackForPark);
      return true;
    }
    /*
     * FNXC:PlanReviewReplanCap 2026-07-05-17:28:
     * FN-7561: an unset Plan Review revision budget resolves to "unbounded" (see FNXC:WorkflowRevisionBudget above), which by design skips the ceiling check — so a task whose planner and reviewer persistently disagree, or whose reviewer keeps hard-failing, replans triage↔plan-review forever, silently burning a triage + review LLM call every cycle (FN-7525 ran 13+ attempts overnight with zero operator visibility). Enforce a finite safety ceiling even when unbounded: once hit, emit a loud
     * halting log entry and STOP replanning so the gate falls through to a visible failed/parked state a human can act on. Explicit numeric operator budgets are still honored as-is above; this only backstops the unbounded DEFAULT.
     */
    /*
     * FNXC:PlanReviewReplan 2026-08-10-18:32:
     * The unbounded-default backstop is now the `planReviewReplanCap` workflow setting, not
     * `PLAN_REVIEW_FEEDBACK_HISTORY_LIMIT`.
     *
     * Two bugs in one line. First, `planReviewReplanCap` is operator-facing — declared, validated,
     * documented in settings-reference.md and editable in the Workflow Editor — and NOTHING read it:
     * an operator lowering the cap changed nothing. Second, the ceiling it should have been was a
     * bound on how much reviewer PROSE is replayed into the next planning prompt, whose own comment
     * says it is "bounded independently of persistence and retry accounting" — so trimming the prompt
     * history would have silently tightened a safety ceiling, and two unrelated concerns shared one
     * number. `DEFAULT_PLAN_REVIEW_REPLAN_CAP` holds the previously-effective 15 so splitting them is
     * a pure re-wiring, not a silent behavior change.
     *
     * `0` is honored (park on the first REVISE), which is why the comparison is `>=` against a
     * possibly-zero cap rather than a truthiness check.
     */
    const unboundedReplanCap = typeof settings.planReviewReplanCap === "number"
      && Number.isInteger(settings.planReviewReplanCap)
      && settings.planReviewReplanCap >= 0
      ? settings.planReviewReplanCap
      : DEFAULT_PLAN_REVIEW_REPLAN_CAP;
    if (budget.unbounded && currentCount >= unboundedReplanCap) {
      // U3: the unbounded-default safety ceiling parks awaiting-approval with the replan-cap reason
      // (re-owned from the deleted triage gate) so non-convergence surfaces to a human instead of
      // silently sitting in place.
      const outcome = await routeReviewConvergenceLadder(deps, taskId, {
        kind: "plan-review-cap", workflowStepId: info.nodeId, stepName: info.stepName,
        feedback, findings: info.findings, attempt: currentCount, max: unboundedReplanCap,
      });
      if (outcome === "escalated" || outcome === "arbitrated") return true;
      await deps.parkPlanReviewReplanCapExhausted(taskId, String(unboundedReplanCap), currentCount, feedback);
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
      liveTask.column === replanColumn
        ? `Plan Review requested a plan revision — task stays in '${replanColumn}' (attempt ${nextCount}/${budgetLabel})`
        : `Plan Review requested a plan revision — moved to '${replanColumn}' (attempt ${nextCount}/${budgetLabel})`,
      optionalStepRevisionLogOutcome(feedback, revisionKey),
      deps.getRunContextFor(taskId),
    );
    deps.workflowLifecycleMovesInFlight.add(taskId);
    try {
      const replanResult = await moveTaskToReplanColumn(
        deps.store,
        { id: taskId, column: liveTask.column },
        "plan-review-revise-replan",
        replanColumn,
        { workflowMoveSource: "workflow-remediation" },
      );
      if (typeof replanResult === "object" && replanResult.reason === "review-lane-source") {
        return true;
      }
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

  /*
  FNXC:ReviewEmptyContent 2026-08-28-13:14:
  A definite empty Code Review rejection closes before the review-gated appender and every Code
  Review budget branch. The built-in budget is unbounded, and no revision count can create content;
  return false after the park because no remediation was scheduled. A declined CAS falls through to
  the existing path. The operator hold, artifact, and Plan Review routes intentionally remain first.
  */
  const emptyResult = liveTask.workflowStepResults?.find((result) =>
    result.workflowStepId === info.nodeId && isDefiniteEmptyCodeReviewRevise(result));
  if (emptyResult) {
    const outcome = await routeReviewConvergenceLadder(deps, taskId, {
      kind: "empty-review-input",
      workflowStepId: emptyResult.workflowStepId,
      stepName: emptyResult.workflowStepName || info.stepName,
      feedback: info.feedback,
      findings: emptyResult.findings,
      attempt: 1,
      emptyInputFence: {
        workflowStepId: emptyResult.workflowStepId,
        stepName: emptyResult.workflowStepName || info.stepName,
        expectedStartedAt: emptyResult.startedAt,
        expectedCompletedAt: emptyResult.completedAt,
        expectedVerdict: emptyResult.verdict,
        expectedReviewInputFingerprint: emptyResult.reviewInputFingerprint!,
      },
    });
    if (outcome === "empty-content-terminalized") return false;
  }

  const workflowIr = await resolveWorkflowIrForTask(deps.store, taskId).catch(() => undefined);
  /*
   * FNXC:ReviewGatedRemediation 2026-08-23-05:23:
   * Review-gated handoff runs only after the shared operator-hold, artifact, and provider-verdict
   * guards above. A deterministic Verification failure has no reviewer verdict; Code Review still
   * requires a genuine REVISE so transport failures cannot manufacture remediation work.
   */
  const remediationGate = resolveReviewRemediationGate(info);
  if (remediationGate === "Verification") {
    const remediationOutcome = await deps.appendReviewRemediationSteps(liveTask, info);
    if (remediationOutcome === "appended") return true;
    return false;
  }

  if (remediationGate === "Code Review" && info.verdict === "REVISE") {
    /*
    FNXC:ReviewGatedRemediation 2026-08-28-16:10:
    Unbounded waves still require changed evidence: singular review uses its review-input fingerprint,
    while workspace review compares the durable repository, scope revision, and input signature before
    the appender can overwrite that state. An optional group's authored `maxRevisions` is the only
    numeric bound, so every appended named-remediation wave writes the keyed attempt entry this route
    previously omitted; without that write its resolved budget remained permanently at zero attempts.
    */
    const codeReviewSettings = await mergeEffectiveSettings(deps.store, liveTask, await deps.store.getSettings());
    const maxRevisions = resolveOptionalReviewRevisionBudget({
      optionalGroupId: info.nodeId ?? info.stepName,
      workflowSettings: codeReviewSettings as Record<string, unknown>,
      nodeMaxRevisions: info.maxRevisions,
      fallbackMaxRevisions: codeReviewSettings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES,
    });
    const codeReviewBudget = resolveOptionalStepRevisionBudget(
      maxRevisions,
      codeReviewSettings.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES,
    );
    const revisionKey = optionalStepRevisionKey(info.nodeId, info.stepName);
    const currentCount = countOptionalStepRevisionAttempts(liveTask, revisionKey, info.stepName);
    const reviewResult = (liveTask.workflowStepResults ?? []).find((result) =>
      (result.workflowStepId === info.nodeId || result.workflowStepName === info.stepName)
      && result.verdict === "REVISE",
    );
    const workspaceRemediation = liveTask.workspaceWorktrees && reviewResult
      ? deriveWorkspaceReviewRemediation(reviewResult)
      : undefined;
    const updateWorkspaceReviewState = (deps.store as Partial<Pick<TaskStore, "updateWorkspaceReviewState">>)
      .updateWorkspaceReviewState;
    const repeatedUnchanged = liveTask.workspaceWorktrees
      ? workspaceRemediation && updateWorkspaceReviewState
        ? hasDurableRepeatedWorkspaceReview(liveTask, workspaceRemediation)
        : hasRepeatedUnchangedReview(liveTask, info)
      : hasRepeatedUnchangedReview(liveTask, info);
    const routeStop = async (stop: { kind: "repeat-unchanged" | "budget-exhausted"; attempt: number }): Promise<boolean> => {
      const outcome = await routeReviewConvergenceLadder(deps, taskId, {
        ...stop,
        workflowStepId: info.nodeId,
        stepName: info.stepName,
        feedback: info.feedback,
        findings: info.findings,
        max: codeReviewBudget.unbounded ? undefined : codeReviewBudget.max,
      });
      if (outcome === "escalated" || outcome === "arbitrated") return true;
      if (stop.kind === "repeat-unchanged") {
        await deps.store.logEntry(
          taskId,
          "Code Review did not converge — released as non-blocking",
          `The same Code Review revision was returned twice without a changed review input. Latest feedback:\n${info.feedback}`,
          deps.getRunContextFor(taskId),
        );
      } else {
        await deps.store.logEntry(
          taskId,
          "Pre-merge remediation not scheduled — revision budget exhausted",
          `Step/node: ${info.nodeId ?? info.stepName}\nAttempts: ${stop.attempt}\nMaximum revisions: ${String(codeReviewBudget.max)}\nIncrease the revision budget and retry, or use the privileged review bypass only when the failed gate is known to be non-blocking.`,
          deps.getRunContextFor(taskId),
        );
      }
      return false;
    };
    const stop = repeatedUnchanged
      ? { kind: "repeat-unchanged" as const, attempt: currentCount }
      : !codeReviewBudget.unbounded && currentCount >= codeReviewBudget.max
        ? { kind: "budget-exhausted" as const, attempt: currentCount }
        : undefined;
    if (stop) return routeStop(stop);

    const remediationOutcome = await deps.appendReviewRemediationSteps(liveTask, info, {
      attemptClaim: {
        revisionKey,
        stepName: info.stepName,
        status: info.status,
        maxRevisions: codeReviewBudget.unbounded ? "unbounded" : codeReviewBudget.max,
        runContext: deps.getRunContextFor(taskId),
      },
    });
    if (remediationOutcome === "budget-exhausted") {
      const current = await deps.store.getTask(taskId);
      return routeStop({
        kind: "budget-exhausted",
        attempt: countOptionalStepRevisionAttempts(current, revisionKey, info.stepName),
      });
    }
    return remediationOutcome === "appended";
  }

  /*
  FNXC:ReportingOnlyGroup 2026-08-26-06:56:
  A REPORTING group cannot reopen implementation. It observes accepted work and records what it
  found; it has no verdict to enforce, so a revision request from it is feedback, not a work order.

  Measured on a real card: the Documentation milestone returned an advisory REVISE asking for
  implementation work. This seam bounced the card to `in-progress` — where, under this workflow's
  named-remediation policy, `sendTaskBackForFix` reopens NOTHING. With no pending step the foreach
  answered `already-expanded`, the walk replayed Code Review over an UNCHANGED tree, and the card
  merged when the second Documentation pass happened to pass. The reviewer's demand was never
  implemented, and 2 model calls plus a worktree acquisition were spent proving nothing.

  Returning false routes traversal down the node's own failure edge, which for a reporter reaches
  the merge gate — the behaviour its contract always described. The feedback stays on the card.
  */
  if (workflowIr && isReportingOnlyOptionalGroup(workflowIr, info.nodeId)) {
    await deps.store.logEntry(
      taskId,
      `${info.stepName} recorded feedback but cannot reopen implementation`,
      `${info.stepName} reports on accepted work and carries no approval, so no executor remediation was scheduled. Feedback:\n${info.feedback}`,
      deps.getRunContextFor(taskId),
    );
    return false;
  }

  /*
  FNXC:EmptyBounceGuard 2026-08-26-06:56:
  Last line of defence for the named-remediation policy: under `none`, `sendTaskBackForFix` reopens
  no step, so every bounce that did not append named work is a card sent back with nothing to do.
  The two paths that CAN append have already returned above; anything still here would bounce empty.
  Refuse visibly instead — a parked card an operator can see beats a silent loop that re-reviews an
  unchanged tree until a non-deterministic verdict lets it through.
  */
  if (resolveStepReopenPolicy(workflowIr) === "none") {
    executorLog.warn(
      `${taskId}: pre-merge remediation NOT scheduled for step "${info.stepName}" — this workflow appends named remediation steps, and no gate owns that for node "${info.nodeId ?? "unknown"}". Card left parked.`,
    );
    await deps.store.logEntry(
      taskId,
      `${info.stepName} requested changes but no remediation owner exists for it`,
      `This workflow reopens implementation only through named remediation steps, which are produced by the Verification and Code Review gates. Node "${info.nodeId ?? "unknown"}" has no such owner, so the card was not bounced with an empty step list. Feedback:\n${info.feedback}`,
      deps.getRunContextFor(taskId),
    );
    return false;
  }

  if (info.verdict !== "REVISE") {
    // FNXC:RemediationVisibility 2026-07-26-19:20: a hard-failed gate with no parsed REVISE
    // verdict schedules nothing, so the remediation node fails and the card parks. Say so.
    executorLog.warn(
      `${taskId}: pre-merge remediation NOT scheduled for step "${info.stepName}" — status=${info.status}, verdict=${info.verdict ?? "none"}. Card left parked.`,
    );
    await deps.store.logEntry(
      taskId,
      "Pre-merge remediation not scheduled — no REVISE verdict",
      `Step/node: ${info.nodeId ?? info.stepName}\nStatus: ${info.status}\nVerdict: ${info.verdict ?? "none"}\nRetry the failed review to obtain a valid verdict, or use the privileged review bypass only when this failed gate is known to be non-blocking.`,
      deps.getRunContextFor(taskId),
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
    await deps.store.logEntry(
      taskId,
      "Pre-merge remediation not scheduled — revision budget zero/invalid",
      `Step/node: ${info.nodeId ?? info.stepName}\nMaximum revisions: ${String(budget.max)}\nIncrease this workflow step's revision budget and retry the task, or use the privileged review bypass only when the failed gate is known to be non-blocking.`,
      deps.getRunContextFor(taskId),
    );
    return false;
  }

  const revisionKey = optionalStepRevisionKey(info.nodeId, info.stepName);
  /*
  FNXC:RepositoryScope 2026-08-21-01:53:
  Two identical Code Review rejections with unchanged durable review input cannot be repaired by
  another executor bounce. Park the task for an operator before a third session; new review output,
  a changed diff, or a scope revision naturally produces a different durable result and reopens it.
  */
  const reviewResult = (liveTask.workflowStepResults ?? []).find((result) =>
    (result.workflowStepId === info.nodeId || result.workflowStepName === info.stepName)
    && result.verdict === "REVISE",
  );
  const derivedRemediation = reviewResult ? deriveWorkspaceReviewRemediation(reviewResult) : undefined;
  // FNXC:WorkspaceFinalization 2026-08-21-09:09: structured outcomes can exist on legacy
  // single-repository flows; only a durable workspace map activates scoped routing and persistence.
  const remediation = derivedRemediation && liveTask.workspaceWorktrees ? derivedRemediation : undefined;
  const repeatedWorkspaceReview = hasDurableRepeatedWorkspaceReview(liveTask, remediation);
  const updateWorkspaceReviewState = (deps.store as Partial<Pick<TaskStore, "updateWorkspaceReviewState">>)
    .updateWorkspaceReviewState;
  if (remediation && !repeatedWorkspaceReview && updateWorkspaceReviewState) {
    const persisted = await updateWorkspaceReviewState.call(deps.store, taskId, remediation.scopeRevision, remediation);
    if (!persisted.updated) {
      executorLog.warn(`${taskId}: workspace Code Review remediation was superseded by a repository scope change.`);
      await deps.store.logEntry(
        taskId,
        "Workspace Code Review remediation not scheduled — repository scope changed",
        `Step/node: ${info.nodeId ?? info.stepName}\nExpected repository scope revision: ${remediation.scopeRevision}\nThe review no longer matches the live repository scope. Retry Code Review against the current scope before scheduling fixes.`,
        deps.getRunContextFor(taskId),
      );
      return false;
    }
  }
  if (repeatedWorkspaceReview || ((!remediation || !updateWorkspaceReviewState) && hasRepeatedUnchangedCodeReview(liveTask, info))) {
    const outcome = await routeReviewConvergenceLadder(deps, taskId, {
      kind: "repeat-unchanged", workflowStepId: info.nodeId, stepName: info.stepName,
      feedback: info.feedback, findings: info.findings, attempt: countOptionalStepRevisionAttempts(liveTask, revisionKey, info.stepName),
      max: budget.unbounded ? undefined : budget.max,
    });
    if (outcome === "escalated" || outcome === "arbitrated") return true;
    await deps.store.logEntry(
      taskId,
      "Code Review did not converge — released as non-blocking",
      `The same Code Review revision was returned twice without a changed review input. Latest feedback:\n${info.feedback}`,
      deps.getRunContextFor(taskId),
    );
    return false;
  }
  const currentCount = countOptionalStepRevisionAttempts(liveTask, revisionKey, info.stepName);
  if (!budget.unbounded && currentCount >= budget.max) {
    const outcome = await routeReviewConvergenceLadder(deps, taskId, {
      kind: "budget-exhausted", workflowStepId: info.nodeId, stepName: info.stepName,
      feedback: info.feedback, findings: info.findings, attempt: currentCount, max: budget.max,
    });
    if (outcome === "escalated" || outcome === "arbitrated") return true;
    executorLog.warn(`${taskId}: pre-merge remediation budget EXHAUSTED for step "${info.stepName}" (${currentCount}/${String(budget.max)}). Card left parked for operator action.`);
    await deps.store.logEntry(
      taskId,
      "Pre-merge remediation not scheduled — revision budget exhausted",
      `Step/node: ${info.nodeId ?? info.stepName}\nAttempts: ${currentCount}\nMaximum revisions: ${String(budget.max)}\nIncrease the revision budget and retry, or use the privileged review bypass only when the failed gate is known to be non-blocking.`,
      deps.getRunContextFor(taskId),
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
  const remediationCheckout = resolveRemediationCheckout(liveTask, reviewResult);
  if (!remediationCheckout) {
    await deps.store.logEntry(
      taskId,
      remediation
        ? "Workspace Code Review remediation released as non-blocking"
        : "Pre-merge remediation not scheduled — checkout unavailable",
      remediation
        ? `Remediation target ${remediation.repository} has no acquired worktree.`
        : `Step/node: ${info.nodeId ?? info.stepName}\nNo singular worktree or acquired workspace repository worktree is available. Retry after restoring the task checkout, or use the privileged review bypass when the failed gate is known to be non-blocking.`,
      deps.getRunContextFor(taskId),
    );
    return false;
  }
  if (!hasPendingRemediationWork(liveTask)) {
    await deps.store.logEntry(
      taskId,
      "Review revision released — no pending remediation work",
      "A review-to-WIP transition requires a named pending remediation step.",
      deps.getRunContextFor(taskId),
    );
    return false;
  }
  const sendArgs = [
    liveTask,
    remediationCheckout.path,
    info.feedback,
    info.stepName,
    `Pre-merge optional workflow step "${info.stepName}" requested revision`,
    true,
    false,
    { attempt: nextCount, max: budget.unbounded ? undefined : budget.max },
    info.findings,
  ] as const;
  const stepReopenPolicy = resolveStepReopenPolicy(workflowIr);
  await deps.sendTaskBackForFix(...sendArgs, remediationCheckout.persist, stepReopenPolicy);
  return true;
}

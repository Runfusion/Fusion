/*
FNXC:PreMergeApproval 2026-09-02-10:36:
FN-9243 repairs resultless enabled pre-merge gates by seeding the earliest missing gate, never by
inventing a verdict or moving a review-lane card backward. The idle seed lets the real gate inspect
current content and produce its own genuine result.
*/
import {
  computeWorkflowIrPin,
  PRE_MERGE_STEPS_NOT_RUN_BLOCKER,
  PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC,
  IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON,
  evaluatePreMergeApprovals,
  resolveWorkflowIrForTask,
  type MergeContentDescriptor,
  type Task,
  type TaskStore,
  type WorkflowStepResult,
} from "@fusion/core";

export type UnrunPreMergeGateRerouteReason =
  | "seeded"
  | "active-continuation"
  | "no-unrun-gate"
  | "no-review-route"
  | "not-singular"
  | "operator-held"
  | "already-landed"
  | "workflow-selection-changed";

export type FailedNoVerdictPreMergeGateRerouteReason =
  | "seeded"
  | "active-continuation"
  | "no-failed-no-verdict-gate"
  | "no-review-route"
  | "not-singular"
  | "operator-held"
  | "already-landed"
  | "workflow-selection-changed";

/** Only the engine-owned unrun-gate park may be automatically released. */
export function isRecoverableUnrunGatePark(task: Task): boolean {
  return task.status === "failed"
    && !task.userPaused && !task.deletedAt && task.autoMerge !== false
    && (!task.paused || task.pausedReason === IN_REVIEW_STALL_DEADLOCK_PAUSE_REASON)
    && typeof task.error === "string"
    && (task.error.endsWith(PRE_MERGE_STEPS_NOT_RUN_BLOCKER)
      || (!task.workflowIrPin && task.error.startsWith("Workflow drift park:")
        && task.error.includes("Stale IR pin cleared")));
}

type ReseedOptions = {
  requiredPreMergeStepIds: ReadonlySet<string>;
  mergeContent: MergeContentDescriptor;
  expectedWorkflowSelection?: { workflowId: string; stepIds: string[] } | null;
};

type ReseedResult<Reason extends string> = {
  rerouted: boolean;
  reason: Reason;
  nodeId?: string;
  workflowStepId?: string;
};

async function seedPreMergeReviewIfIdle<Reason extends "no-unrun-gate" | "no-failed-no-verdict-gate">(
  store: TaskStore,
  task: Task,
  options: ReseedOptions,
  candidateStepIds: ReadonlySet<string>,
  noCandidateReason: Reason,
  runKind: "unrun-pre-merge-gate" | "failed-no-verdict-pre-merge-gate",
): Promise<ReseedResult<"seeded" | "active-continuation" | Reason | "no-review-route" | "not-singular" | "operator-held" | "already-landed" | "workflow-selection-changed">> {
  const { mergeContent, requiredPreMergeStepIds, expectedWorkflowSelection } = options;
  if (mergeContent.kind !== "singular" || task.workspaceWorktrees !== undefined) return { rerouted: false, reason: "not-singular" };
  if (task.paused || task.userPaused || task.deletedAt || task.autoMerge === false) return { rerouted: false, reason: "operator-held" };
  if (task.mergeDetails?.mergeConfirmed) return { rerouted: false, reason: "already-landed" };
  if (requiredPreMergeStepIds.size === 0 || candidateStepIds.size === 0) return { rerouted: false, reason: noCandidateReason };

  const ir = await resolveWorkflowIrForTask(store, task.id);
  const node = ir.nodes.find((candidate) => requiredPreMergeStepIds.has(candidate.id) && candidateStepIds.has(candidate.id));
  if (!node) return { rerouted: false, reason: "no-review-route" };

  const items = await store.listWorkflowWorkItemsForTask(task.id);
  const result = await store.seedWorkspaceCodeReviewContinuationIfIdle({
    taskId: task.id,
    nodeId: node.id,
    kind: "task",
    state: "runnable",
    runId: `${task.id}:${runKind}-reseed:${node.id}:${items.length}`,
    stableWorkflowRunId: `${task.id}:${ir.name}`,
    continuationSequence: items.length,
    sourceColumn: task.column,
    targetColumn: node.column ?? task.column,
    irHash: computeWorkflowIrPin(ir, node.id).irHash,
    expectedWorkflowSelection,
    expectedTaskUpdatedAt: task.updatedAt,
  });
  if (result.seeded) return { rerouted: true, reason: "seeded", nodeId: node.id, workflowStepId: node.id };
  return {
    rerouted: false,
    reason: result.reason === "workflow-selection-changed" ? "workflow-selection-changed" : "active-continuation",
    nodeId: node.id,
    workflowStepId: node.id,
  };
}

/**
 * FNXC:ReviewRetryRecovery 2026-10-01-04:29:
 * A deterministic input-proof refusal never dispatched a reviewer. Repeating it is not lost-session
 * recovery; retain the failed gate until its base/checkout is repaired and an operator retries.
 */
export function isUnprovableReviewInputResult(result: WorkflowStepResult): boolean {
  return result.status === "failed" && result.verdict === undefined
    && (result.output?.includes("review-input-unprovable") === true
      || result.output?.includes("review input is unprovable") === true);
}

export function isFailedNoVerdictPreMergeReviewResult(
  result: WorkflowStepResult,
  requiredPreMergeStepIds: ReadonlySet<string>,
): boolean {
  return (result.phase ?? "pre-merge") === "pre-merge"
    && result.status === "failed"
    && result.verdict === undefined
    && !isUnavailablePlanLockResult(result)
    && !hasExhaustedNoVerdictRecovery(result)
    && !isUnprovableReviewInputResult(result)
    && requiredPreMergeStepIds.has(result.workflowStepId);
}

/*
FNXC:ReviewRecovery 2026-10-04-02:24:
A deterministic spec-lock rejection is not a lost dispatch. Never spend another reviewer call on
unchanged parser input. Bound genuine lost-dispatch recovery to three retries per recorded review
input using durable history, so restarting the engine cannot reset the budget.
*/
export function isUnavailablePlanLockResult(result: Pick<WorkflowStepResult, "output" | "notes">): boolean {
  return [result.output, result.notes].some((text) => text?.startsWith(PLAN_LOCK_UNAVAILABLE_DIAGNOSTIC));
}

export function hasExhaustedNoVerdictRecovery(result: WorkflowStepResult): boolean {
  if (result.status !== "failed" || result.verdict !== undefined) return false;
  const previous = (result.priorAttempts ?? []).filter((entry) => !entry.supersededAt && !entry.remediationArchivedAt
    && entry.reviewInputFingerprint === result.reviewInputFingerprint
    && entry.reviewedCommitSha === result.reviewedCommitSha
    && entry.status === "failed" && entry.verdict === undefined);
  return previous.length >= 3;
}

export async function rerouteUnrunPreMergeGateToReview(
  store: TaskStore,
  task: Task,
  options: ReseedOptions,
): Promise<ReseedResult<UnrunPreMergeGateRerouteReason>> {
  const missing = new Set(evaluatePreMergeApprovals(task, options)
    .filter((approval) => approval.state === "missing")
    .map((approval) => approval.workflowStepId));
  return seedPreMergeReviewIfIdle(store, task, options, missing, "no-unrun-gate", "unrun-pre-merge-gate");
}

/**
 * FNXC:NoVerdictReviewRecovery 2026-09-23-19:50:
 * A terminal pre-merge review failure without a verdict is a lost dispatch, not a rejection.
 * Re-seed only its exact required review node through the idle continuation fence; the failed
 * evidence remains current until the real replacement review result is recorded.
 */
export async function rerouteFailedNoVerdictPreMergeGateToReview(
  store: TaskStore,
  task: Task,
  options: ReseedOptions,
): Promise<ReseedResult<FailedNoVerdictPreMergeGateRerouteReason>> {
  const candidates = new Set((task.workflowStepResults ?? [])
    .filter((result) => isFailedNoVerdictPreMergeReviewResult(result, options.requiredPreMergeStepIds))
    .map((result) => result.workflowStepId));
  return seedPreMergeReviewIfIdle(store, task, options, candidates, "no-failed-no-verdict-gate", "failed-no-verdict-pre-merge-gate");
}

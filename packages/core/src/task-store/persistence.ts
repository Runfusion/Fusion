/**
 * Task persistence row shape, column descriptors, and serialization SQL.
 *
 * FNXC:TaskStoreDecompose 2026-06-24-00:00:
 * Extracted from the monolithic packages/core/src/store.ts (U5 decomposition).
 * Pure behavior-invariant move: types and constants are byte-identical to their
 * pre-extraction form. store.ts re-imports these symbols. The descriptor order
 * stays in lockstep with the named-column INSERT/UPSERT clauses generated below.
 */
import type { Task } from "../types.js";
import { normalizeTaskPriority } from "../task-priority.js";
import { toJson, toJsonNullable } from "../db.js";

/** Database row shape for the tasks table (all columns). */
export interface TaskRow {
  id: string;
  lineageId: string | null;
  title: string | null;
  description: string;
  priority: string | null;
  column: string;
  status: string | null;
  size: string | null;
  reviewLevel: number | null;
  currentStep: number;
  worktree: string | null;
  blockedBy: string | null;
  overlapBlockedBy: string | null;
  paused: number | null;
  pausedReason: string | null;
  userPaused: number | null;
  baseBranch: string | null;
  executionStartBranch: string | null;
  branch: string | null;
  autoMerge: number | null;
  autoMergeProvenance: string | null;
  baseCommitSha: string | null;
  modelPresetId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  validatorModelProvider: string | null;
  validatorModelId: string | null;
  planningModelProvider: string | null;
  planningModelId: string | null;
  mergerModelProvider: string | null;
  mergerModelId: string | null;
  mergeRetries: number | null;
  workflowStepRetries: number | null;
  stuckKillCount: number | null;
  resumeLimboCount: number | null;
  graphResumeRetryCount: number | null;
  consecutiveToolFailureRetryCount: number | null;
  executorEscalationAttempted: number | null;
  toolFailureDetectorLogCursor: number | null;
  toolFailureRetryExhaustedAuditEmitted: number | null;
  resumeLimboTipSha: string | null;
  resumeLimboStepSignature: string | null;
  executeRequeueLoopCount: number | null;
  executeRequeueLoopSignature: string | null;
  postReviewFixCount: number | null;
  planReviewReplanCount: number | null;
  recoveryRetryCount: number | null;
  taskDoneRetryCount: number | null;
  // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 skip-bypass taint marker (ISO timestamp / null).
  bulkCompletionRefusalAt: string | null;
  // FNXC:WorkflowIrPin 2026-07-19-03:10: U9b/KTD-3 durable IR pin + the node entry it belongs to.
  workflowIrPin: string | null;
  workflowIrPinNodeId: string | null;
  workflowIrPinColumnId: string | null;
  // FNXC:LegacyAdoption 2026-07-19-03:10: U9b/KTD-8 one-time adoption stamp (ISO timestamp / null).
  legacyAdoptedAt: string | null;
  worktreeSessionRetryCount: number | null;
  completionHandoffLimboRecoveryCount: number | null;
  verificationFailureCount: number | null;
  mergeConflictBounceCount: number | null;
  mergeAuditBounceCount: number | null;
  mergeTransientRetryCount: number | null;
  branchConflictRecoveryCount: number | null;
  reviewerContextRetryCount: number | null;
  reviewerFallbackRetryCount: number | null;
  nextRecoveryAt: string | null;
  error: string | null;
  summary: string | null;
  thinkingLevel: string | null;
  validatorThinkingLevel: string | null;
  planningThinkingLevel: string | null;
  mergerThinkingLevel: string | null;
  executionMode: string | null;
  /** FNXC:PlannerOversight 2026-07-14-18:11: null = inherit project; 0 = off; 1 = on (autoMerge pattern). */
  sessionAdvisorEnabled: number | null;
  tokenUsageInputTokens: number | null;
  tokenUsageOutputTokens: number | null;
  tokenUsageCachedTokens: number | null;
  tokenUsageCacheWriteTokens: number | null;
  tokenUsageTotalTokens: number | null;
  tokenUsageFirstUsedAt: string | null;
  tokenUsageLastUsedAt: string | null;
  tokenUsageModelProvider: string | null;
  tokenUsageModelId: string | null;
  tokenUsagePerModel: string | null;
  tokenBudgetSoftAlertedAt: string | null;
  tokenBudgetHardAlertedAt: string | null;
  tokenBudgetOverride: string | null;
  createdAt: string;
  updatedAt: string;
  columnMovedAt: string | null;
  firstExecutionAt: string | null;
  cumulativeActiveMs: number | null;
  cumulativePlanningMs: number | null;
  planningStartedAt: string | null;
  columnDwellMs: string | null;
  workflowTransitionNotification: string | null;
  plannerOversightLevel: string | null;
  awaitingApprovalReason: string | null;
  approvedPlanFingerprint: string | null;
  executionStartedAt: string | null;
  executionCompletedAt: string | null;
  dependencies: string | null;
  steps: string | null;
  customFields: string | null;
  log: string | null;
  attachments: string | null;
  steeringComments: string | null;
  comments: string | null;
  review: string | null;
  reviewState: string | null;
  workflowStepResults: string | null;
  prInfo: string | null;
  prInfos: string | null;
  issueInfo: string | null;
  githubTracking: string | null;
  gitlabTracking: string | null;
  sourceIssueProvider: string | null;
  sourceIssueRepository: string | null;
  sourceIssueExternalIssueId: string | null;
  sourceIssueNumber: number | null;
  sourceIssueUrl: string | null;
  sourceIssueClosedAt: string | null;
  mergeDetails: string | null;
  workspaceWorktrees: string | null;
  breakIntoSubtasks: number | null;
  noCommitsExpected: number | null;
  enabledWorkflowSteps: string | null;
  modifiedFiles: string | null;
  declaredSymbols: string | null;
  missionId: string | null;
  sliceId: string | null;
  scopeOverride: number | null;
  scopeOverrideReason: string | null;
  scopeAutoWiden: string | null;
  assignedAgentId: string | null;
  pausedByAgentId: string | null;
  assigneeUserId: string | null;
  nodeId: string | null;
  effectiveNodeId: string | null;
  effectiveNodeSource: string | null;
  sourceType: string | null;
  sourceAgentId: string | null;
  sourceRunId: string | null;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  sourceParentTaskId: string | null;
  sourceMetadata: string | null;
  proposalClaimId: string | null;
  checkedOutBy: string | null;
  checkedOutAt: string | null;
  checkoutNodeId: string | null;
  checkoutRunId: string | null;
  checkoutLeaseRenewedAt: string | null;
  checkoutLeaseEpoch: number | null;
  deletedAt: string | null;
  allowResurrection: number | null;
}

export type TaskPersistSerializationContext = {
  lineageId: string;
};

export type TaskColumnDescriptor = {
  column: keyof TaskRow;
  sqlIdentifier: string;
  serialize: (task: Task, context: TaskPersistSerializationContext) => unknown;
};

/*
FNXC:TaskLifecyclePersistence 2026-07-14-13:27:
PostgreSQL task JSONB conversion must use one registry for both descriptor writes and SQLite-shaped row hydration. Separate read/write lists drifted when late lifecycle columns were added, allowing JSON strings or parsed objects to cross the wrong serialization boundary.
*/
export const TASK_JSONB_COLUMNS: ReadonlySet<string> = new Set([
  "dependencies", "steps", "customFields", "log", "attachments", "steeringComments",
  "comments", "review", "reviewState", "workflowStepResults", "prInfo", "prInfos",
  "issueInfo", "githubTracking", "gitlabTracking", "mergeDetails", "workspaceWorktrees", "enabledWorkflowSteps",
  "modifiedFiles", "declaredSymbols", "scopeAutoWiden", "sourceMetadata", "tokenUsagePerModel",
  "tokenBudgetOverride", "columnDwellMs", "workflowTransitionNotification",
]);

export function defineTaskColumn(
  column: keyof TaskRow,
  serialize: TaskColumnDescriptor["serialize"],
  sqlIdentifier: string = column,
): TaskColumnDescriptor {
  return { column, sqlIdentifier, serialize };
}

const serializeTaskAutoMerge: TaskColumnDescriptor["serialize"] = (task) => task.autoMerge === undefined ? null : (task.autoMerge ? 1 : 0);
const serializeTaskAutoMergeProvenance: TaskColumnDescriptor["serialize"] = (task) => task.autoMergeProvenance ?? null;
// FNXC:PlannerOversight 2026-07-14-18:11: three-state like autoMerge — null inherits project default.
const serializeTaskSessionAdvisorEnabled: TaskColumnDescriptor["serialize"] = (task) =>
  task.sessionAdvisorEnabled === undefined ? null : (task.sessionAdvisorEnabled ? 1 : 0);

// Keep this descriptor order in lockstep with the named-column INSERT/UPSERT
// clauses we generate below. SQLite binds by the explicit column list we emit,
// so this logical persist order does not need to match the table's physical
// column layout from CREATE TABLE + migrations.
export const TASK_COLUMN_DESCRIPTORS: TaskColumnDescriptor[] = [
  defineTaskColumn("id", (task) => task.id),
  defineTaskColumn("lineageId", (_task, context) => context.lineageId),
  defineTaskColumn("title", (task) => task.title ?? null),
  defineTaskColumn("description", (task) => task.description ?? ""),
  defineTaskColumn("priority", (task) => normalizeTaskPriority(task.priority)),
  defineTaskColumn("column", (task) => task.column, '"column"'),
  defineTaskColumn("status", (task) => task.status ?? null),
  defineTaskColumn("size", (task) => task.size ?? null),
  defineTaskColumn("reviewLevel", (task) => task.reviewLevel ?? null),
  defineTaskColumn("currentStep", (task) => task.currentStep || 0),
  defineTaskColumn("worktree", (task) => task.worktree ?? null),
  defineTaskColumn("blockedBy", (task) => task.blockedBy ?? null),
  defineTaskColumn("overlapBlockedBy", (task) => task.overlapBlockedBy ?? null),
  defineTaskColumn("paused", (task) => task.paused ? 1 : 0),
  defineTaskColumn("pausedReason", (task) => task.pausedReason ?? null),
  defineTaskColumn("userPaused", (task) => task.userPaused ? 1 : 0),
  defineTaskColumn("baseBranch", (task) => task.baseBranch ?? null),
  defineTaskColumn("branch", (task) => task.branch ?? null),
  defineTaskColumn("autoMerge", serializeTaskAutoMerge),
  defineTaskColumn("autoMergeProvenance", serializeTaskAutoMergeProvenance),
  defineTaskColumn("executionStartBranch", (task) => task.executionStartBranch ?? null),
  defineTaskColumn("baseCommitSha", (task) => task.baseCommitSha ?? null),
  defineTaskColumn("modelPresetId", (task) => task.modelPresetId ?? null),
  defineTaskColumn("modelProvider", (task) => task.modelProvider ?? null),
  defineTaskColumn("modelId", (task) => task.modelId ?? null),
  defineTaskColumn("validatorModelProvider", (task) => task.validatorModelProvider ?? null),
  defineTaskColumn("validatorModelId", (task) => task.validatorModelId ?? null),
  defineTaskColumn("planningModelProvider", (task) => task.planningModelProvider ?? null),
  defineTaskColumn("planningModelId", (task) => task.planningModelId ?? null),
  defineTaskColumn("mergerModelProvider", (task) => task.mergerModelProvider ?? null),
  defineTaskColumn("mergerModelId", (task) => task.mergerModelId ?? null),
  defineTaskColumn("mergeRetries", (task) => task.mergeRetries ?? null),
  defineTaskColumn("workflowStepRetries", (task) => task.workflowStepRetries ?? null),
  defineTaskColumn("stuckKillCount", (task) => task.stuckKillCount ?? 0),
  defineTaskColumn("resumeLimboCount", (task) => task.resumeLimboCount ?? 0),
  defineTaskColumn("graphResumeRetryCount", (task) => task.graphResumeRetryCount === undefined ? 0 : task.graphResumeRetryCount),
  defineTaskColumn("consecutiveToolFailureRetryCount", (task) => task.consecutiveToolFailureRetryCount ?? 0),
  defineTaskColumn("executorEscalationAttempted", (task) => task.executorEscalationAttempted ? 1 : 0),
  defineTaskColumn("toolFailureDetectorLogCursor", (task) => task.toolFailureDetectorLogCursor ?? null),
  // FNXC:ExecutorToolFailureRetry 2026-07-16-13:30: PostgreSQL stores this CAS marker as integer (0/1), matching its schema and legacy SQLite flag representation.
  defineTaskColumn("toolFailureRetryExhaustedAuditEmitted", (task) => task.toolFailureRetryExhaustedAuditEmitted ? 1 : 0),
  defineTaskColumn("resumeLimboTipSha", (task) => task.resumeLimboTipSha ?? null),
  defineTaskColumn("resumeLimboStepSignature", (task) => task.resumeLimboStepSignature ?? null),
  // FNXC:WorkflowLifecycle 2026-07-12 (merge port from main): FN-7863 progress-anchored execute self-requeue streak.
  defineTaskColumn("executeRequeueLoopCount", (task) => task.executeRequeueLoopCount ?? 0),
  defineTaskColumn("executeRequeueLoopSignature", (task) => task.executeRequeueLoopSignature ?? null),
  defineTaskColumn("postReviewFixCount", (task) => task.postReviewFixCount ?? 0),
  defineTaskColumn("planReviewReplanCount", (task) => task.planReviewReplanCount ?? 0),
  defineTaskColumn("recoveryRetryCount", (task) => task.recoveryRetryCount ?? null),
  defineTaskColumn("taskDoneRetryCount", (task) => task.taskDoneRetryCount ?? 0),
  // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 skip-bypass taint marker persisted as nullable ISO timestamp.
  defineTaskColumn("bulkCompletionRefusalAt", (task) => task.bulkCompletionRefusalAt ?? null),
  // FNXC:WorkflowIrPin 2026-07-19-03:10: U9b/KTD-3 — the pin must round-trip through persist so
  // it survives the crash it exists to defend against.
  defineTaskColumn("workflowIrPin", (task) => task.workflowIrPin ?? null),
  defineTaskColumn("workflowIrPinNodeId", (task) => task.workflowIrPinNodeId ?? null),
  defineTaskColumn("workflowIrPinColumnId", (task) => task.workflowIrPinColumnId ?? null),
  // FNXC:LegacyAdoption 2026-07-19-03:10: U9b/KTD-8 one-time adoption stamp.
  defineTaskColumn("legacyAdoptedAt", (task) => task.legacyAdoptedAt ?? null),
  defineTaskColumn("worktreeSessionRetryCount", (task) => task.worktreeSessionRetryCount ?? 0),
  defineTaskColumn("completionHandoffLimboRecoveryCount", (task) => task.completionHandoffLimboRecoveryCount ?? 0),
  defineTaskColumn("verificationFailureCount", (task) => task.verificationFailureCount ?? 0),
  defineTaskColumn("mergeConflictBounceCount", (task) => task.mergeConflictBounceCount ?? 0),
  defineTaskColumn("mergeAuditBounceCount", (task) => task.mergeAuditBounceCount ?? 0),
  defineTaskColumn("mergeTransientRetryCount", (task) => task.mergeTransientRetryCount ?? 0),
  defineTaskColumn("branchConflictRecoveryCount", (task) => task.branchConflictRecoveryCount ?? 0),
  defineTaskColumn("reviewerContextRetryCount", (task) => task.reviewerContextRetryCount ?? 0),
  defineTaskColumn("reviewerFallbackRetryCount", (task) => task.reviewerFallbackRetryCount ?? 0),
  defineTaskColumn("nextRecoveryAt", (task) => task.nextRecoveryAt ?? null),
  defineTaskColumn("error", (task) => task.error ?? null),
  defineTaskColumn("summary", (task) => task.summary ?? null),
  defineTaskColumn("thinkingLevel", (task) => task.thinkingLevel ?? null),
  // FNXC:Settings-ThinkingLevel 2026-07-13 (merge port): per-task validator/planning reasoning-effort overrides.
  defineTaskColumn("validatorThinkingLevel", (task) => task.validatorThinkingLevel ?? null),
  defineTaskColumn("planningThinkingLevel", (task) => task.planningThinkingLevel ?? null),
  defineTaskColumn("mergerThinkingLevel", (task) => task.mergerThinkingLevel ?? null),
  defineTaskColumn("executionMode", (task) => task.executionMode ?? null),
  defineTaskColumn("sessionAdvisorEnabled", serializeTaskSessionAdvisorEnabled),
  defineTaskColumn("tokenUsageInputTokens", (task) => task.tokenUsage?.inputTokens ?? null),
  defineTaskColumn("tokenUsageOutputTokens", (task) => task.tokenUsage?.outputTokens ?? null),
  defineTaskColumn("tokenUsageCachedTokens", (task) => task.tokenUsage?.cachedTokens ?? null),
  defineTaskColumn("tokenUsageCacheWriteTokens", (task) => task.tokenUsage?.cacheWriteTokens ?? null),
  defineTaskColumn("tokenUsageTotalTokens", (task) => task.tokenUsage?.totalTokens ?? null),
  defineTaskColumn("tokenUsageFirstUsedAt", (task) => task.tokenUsage?.firstUsedAt ?? null),
  defineTaskColumn("tokenUsageLastUsedAt", (task) => task.tokenUsage?.lastUsedAt ?? null),
  defineTaskColumn("tokenUsageModelProvider", (task) => task.tokenUsage?.modelProvider ?? null),
  defineTaskColumn("tokenUsageModelId", (task) => task.tokenUsage?.modelId ?? null),
  defineTaskColumn("tokenUsagePerModel", (task) => toJsonNullable(task.tokenUsage?.perModel)),
  defineTaskColumn("tokenBudgetSoftAlertedAt", (task) => task.tokenBudgetSoftAlertedAt ?? null),
  defineTaskColumn("tokenBudgetHardAlertedAt", (task) => task.tokenBudgetHardAlertedAt ?? null),
  defineTaskColumn("tokenBudgetOverride", (task) => toJsonNullable(task.tokenBudgetOverride)),
  defineTaskColumn("createdAt", (task) => task.createdAt),
  defineTaskColumn("updatedAt", (task) => task.updatedAt),
  defineTaskColumn("columnMovedAt", (task) => task.columnMovedAt ?? null),
  defineTaskColumn("firstExecutionAt", (task) => task.firstExecutionAt ?? null),
  defineTaskColumn("cumulativeActiveMs", (task) => task.cumulativeActiveMs ?? null),
  defineTaskColumn("cumulativePlanningMs", (task) => task.cumulativePlanningMs ?? null),
  defineTaskColumn("planningStartedAt", (task) => task.planningStartedAt ?? null),
  /*
  FNXC:TaskLifecyclePersistence 2026-07-14-13:17:
  Persist the late task lifecycle fields through the shared descriptor seam so both SQLite and PostgreSQL retain per-column timing, workflow transition dedupe, oversight overrides, and manual-plan approval state after migration.
  */
  defineTaskColumn("columnDwellMs", (task) => toJsonNullable(task.columnDwellMs)),
  defineTaskColumn("workflowTransitionNotification", (task) => toJsonNullable(task.workflowTransitionNotification)),
  defineTaskColumn("plannerOversightLevel", (task) => task.plannerOversightLevel ?? null),
  defineTaskColumn("awaitingApprovalReason", (task) => task.awaitingApprovalReason ?? null),
  defineTaskColumn("approvedPlanFingerprint", (task) => task.approvedPlanFingerprint ?? null),
  defineTaskColumn("executionStartedAt", (task) => task.executionStartedAt ?? null),
  defineTaskColumn("executionCompletedAt", (task) => task.executionCompletedAt ?? null),
  defineTaskColumn("dependencies", (task) => toJson(task.dependencies || [])),
  defineTaskColumn("steps", (task) => toJson(task.steps || [])),
  defineTaskColumn("customFields", (task) => toJson(task.customFields ?? {})),
  defineTaskColumn("log", (task) => toJson(task.log || [])),
  defineTaskColumn("attachments", (task) => toJson(task.attachments || [])),
  defineTaskColumn("steeringComments", (task) => toJson(task.steeringComments || [])),
  defineTaskColumn("comments", (task) => toJson(task.comments || [])),
  defineTaskColumn("review", (task) => toJsonNullable(task.review)),
  defineTaskColumn("reviewState", (task) => toJsonNullable(task.reviewState)),
  defineTaskColumn("workflowStepResults", (task) => toJson(task.workflowStepResults || [])),
  defineTaskColumn("prInfo", (task) => toJsonNullable(task.prInfo)),
  defineTaskColumn("prInfos", (task) => toJson(task.prInfos || [])),
  defineTaskColumn("issueInfo", (task) => toJsonNullable(task.issueInfo)),
  defineTaskColumn("githubTracking", (task) => toJsonNullable(task.githubTracking)),
  /*
  FNXC:GitLabTracking 2026-07-16-05:34:
  GitLab import provenance must use the shared task persistence registry like GitHub tracking.
  This closes the partial-feature gap so create and update writes retain metadata for live reads.
  */
  defineTaskColumn("gitlabTracking", (task) => toJsonNullable(task.gitlabTracking)),
  defineTaskColumn("sourceIssueProvider", (task) => task.sourceIssue?.provider ?? null),
  defineTaskColumn("sourceIssueRepository", (task) => task.sourceIssue?.repository ?? null),
  defineTaskColumn("sourceIssueExternalIssueId", (task) => task.sourceIssue?.externalIssueId ?? null),
  defineTaskColumn("sourceIssueNumber", (task) => task.sourceIssue?.issueNumber ?? null),
  defineTaskColumn("sourceIssueUrl", (task) => task.sourceIssue?.url ?? null),
  defineTaskColumn("sourceIssueClosedAt", (task) => task.sourceIssue?.closedAt ?? null),
  defineTaskColumn("mergeDetails", (task) => toJsonNullable(task.mergeDetails)),
  defineTaskColumn("workspaceWorktrees", (task) => toJsonNullable(task.workspaceWorktrees)),
  defineTaskColumn("breakIntoSubtasks", (task) => task.breakIntoSubtasks ? 1 : 0),
  defineTaskColumn("noCommitsExpected", (task) => task.noCommitsExpected ? 1 : 0),
  defineTaskColumn("enabledWorkflowSteps", (task) => toJson(task.enabledWorkflowSteps || [])),
  defineTaskColumn("modifiedFiles", (task) => toJson(task.modifiedFiles || [])),
  defineTaskColumn("declaredSymbols", (task) => toJson(task.declaredSymbols || []), "declared_symbols"),
  defineTaskColumn("missionId", (task) => task.missionId ?? null),
  defineTaskColumn("sliceId", (task) => task.sliceId ?? null),
  defineTaskColumn("scopeOverride", (task) => task.scopeOverride ? 1 : null),
  defineTaskColumn("scopeOverrideReason", (task) => task.scopeOverrideReason ?? null),
  defineTaskColumn("scopeAutoWiden", (task) => toJson(task.scopeAutoWiden || [])),
  defineTaskColumn("assignedAgentId", (task) => task.assignedAgentId ?? null),
  defineTaskColumn("pausedByAgentId", (task) => task.pausedByAgentId ?? null),
  defineTaskColumn("assigneeUserId", (task) => task.assigneeUserId ?? null),
  defineTaskColumn("nodeId", (task) => task.nodeId ?? null),
  defineTaskColumn("effectiveNodeId", (task) => task.effectiveNodeId ?? null),
  defineTaskColumn("effectiveNodeSource", (task) => task.effectiveNodeSource ?? null),
  defineTaskColumn("sourceType", (task) => task.sourceType ?? null),
  defineTaskColumn("sourceAgentId", (task) => task.sourceAgentId ?? null),
  defineTaskColumn("sourceRunId", (task) => task.sourceRunId ?? null),
  defineTaskColumn("sourceSessionId", (task) => task.sourceSessionId ?? null),
  defineTaskColumn("sourceMessageId", (task) => task.sourceMessageId ?? null),
  defineTaskColumn("sourceParentTaskId", (task) => task.sourceParentTaskId ?? null),
  defineTaskColumn("sourceMetadata", (task) => toJsonNullable(task.sourceMetadata)),
  defineTaskColumn("proposalClaimId", (task) => task.proposalClaimId ?? null),
  defineTaskColumn("checkedOutBy",  (task) => task.checkedOutBy ?? null),
  defineTaskColumn("checkedOutAt", (task) => task.checkedOutAt ?? null),
  defineTaskColumn("checkoutNodeId", (task) => task.checkoutNodeId ?? null),
  defineTaskColumn("checkoutRunId", (task) => task.checkoutRunId ?? null),
  defineTaskColumn("checkoutLeaseRenewedAt", (task) => task.checkoutLeaseRenewedAt ?? null),
  defineTaskColumn("checkoutLeaseEpoch", (task) => task.checkoutLeaseEpoch ?? 0),
  defineTaskColumn("deletedAt", (task) => task.deletedAt ?? null),
  defineTaskColumn("allowResurrection", (task) => task.allowResurrection ? 1 : 0),
];

export const TASK_COLUMN_DESCRIPTOR_BY_COLUMN = new Map(
  TASK_COLUMN_DESCRIPTORS.map((descriptor) => [descriptor.column, descriptor]),
);
export const TASK_PERSIST_SQL_COLUMNS = TASK_COLUMN_DESCRIPTORS.map((descriptor) => descriptor.sqlIdentifier).join(", ");
export const TASK_UPSERT_SQL_ASSIGNMENTS = TASK_COLUMN_DESCRIPTORS
  .filter((descriptor) => descriptor.column !== "id")
  .map((descriptor) => `        ${descriptor.sqlIdentifier} = excluded.${descriptor.sqlIdentifier}`)
  .join(",\n");

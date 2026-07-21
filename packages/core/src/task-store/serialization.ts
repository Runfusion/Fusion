/**
 * Row <-> domain-object serialization for TaskStore satellite tables.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. These functions are leaf-level converters
 * with no `this` dependencies; store.ts delegates to them verbatim.
 * Every signature and every JSON-parse/default rule is byte-identical to
 * the pre-extraction class-body implementation.
 */
import type {
  AgentLogEntry,
  ArchivedTaskEntry,
  ArchiveAgentLogMode,
  Artifact,
  Column,
  GoalCitation,
  PrInfo,
  SourceType,
  Task,
  TaskAttachment,
} from "../types.js";
import type {
  ArtifactRow,
  BranchGroupRow,
  GoalCitationRow,
  TaskDocumentRevisionRow,
  TaskDocumentRow,
} from "./row-types.js";
import type { TaskRow } from "./persistence.js";
import { fromJson } from "../db.js";
import { generateTaskLineageId } from "../task-lineage.js";
import { normalizeTaskPriority } from "../task-priority.js";
import { normalizeTaskReviewState } from "./review-state.js";
import {
  parseTaskBranchContextFromSourceMetadata,
  withTaskBranchContextInSourceMetadata,
} from "./branch-context.js";

const ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT = 25;
const ARCHIVE_AGENT_LOG_SNIPPET_LIMIT = 160;

/**
 * Re-serialize jsonb values to strings so the SQLite-oriented rowToTask()
 * deserializer (which calls fromJson()) works unchanged across both backends.
 *
 * PostgreSQL jsonb columns arrive already-parsed (VAL-SCHEMA-004); SQLite
 * stores them as TEXT requiring fromJson().
 */
export function pgRowToTaskRow<T extends TaskRow>(
  row: Record<string, unknown>,
  pgJsonbTaskColumns: ReadonlySet<string> | readonly string[],
): T {
  const result: Record<string, unknown> = { ...row };
  for (const column of pgJsonbTaskColumns) {
    if (result[column] !== undefined && result[column] !== null && typeof result[column] !== "string") {
      result[column] = JSON.stringify(result[column]);
    }
  }
  return result as unknown as T;
}

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    lineageId: row.lineageId || generateTaskLineageId(),
    title: row.title || undefined,
    description: row.description,
    priority: normalizeTaskPriority(row.priority),
    column: row.column as Column,
    status: row.status || undefined,
    size: (row.size || undefined) as Task["size"],
    reviewLevel: row.reviewLevel ?? undefined,
    currentStep: row.currentStep || 0,
    worktree: row.worktree || undefined,
    blockedBy: row.blockedBy || undefined,
    overlapBlockedBy: row.overlapBlockedBy || undefined,
    paused: row.paused ? true : undefined,
    pausedReason: row.pausedReason || undefined,
    userPaused: row.userPaused ? true : undefined,
    baseBranch: row.baseBranch || undefined,
    executionStartBranch: row.executionStartBranch || undefined,
    branch: row.branch || undefined,
    autoMerge: row.autoMerge === null ? undefined : row.autoMerge === 1,
    autoMergeProvenance: row.autoMergeProvenance === "user" || row.autoMergeProvenance === "legacy-stamp"
      ? row.autoMergeProvenance
      : undefined,
    baseCommitSha: row.baseCommitSha || undefined,
    scopeOverride: row.scopeOverride ? true : undefined,
    scopeOverrideReason: row.scopeOverrideReason || undefined,
    scopeAutoWiden: fromJson<string[]>(row.scopeAutoWiden) ?? [],
    modelPresetId: row.modelPresetId || undefined,
    modelProvider: row.modelProvider || undefined,
    modelId: row.modelId || undefined,
    validatorModelProvider: row.validatorModelProvider || undefined,
    validatorModelId: row.validatorModelId || undefined,
    planningModelProvider: row.planningModelProvider || undefined,
    planningModelId: row.planningModelId || undefined,
    mergerModelProvider: row.mergerModelProvider || undefined,
    mergerModelId: row.mergerModelId || undefined,
    mergeRetries: row.mergeRetries ?? undefined,
    workflowStepRetries: row.workflowStepRetries ?? undefined,
    stuckKillCount: row.stuckKillCount ?? undefined,
    resumeLimboCount: row.resumeLimboCount ?? undefined,
    graphResumeRetryCount: row.graphResumeRetryCount ?? undefined,
    consecutiveToolFailureRetryCount: row.consecutiveToolFailureRetryCount ?? undefined,
    executorEscalationAttempted: row.executorEscalationAttempted ? true : undefined,
    toolFailureDetectorLogCursor: row.toolFailureDetectorLogCursor ?? undefined,
    toolFailureRetryExhaustedAuditEmitted: row.toolFailureRetryExhaustedAuditEmitted ? true : undefined,
    resumeLimboTipSha: row.resumeLimboTipSha || undefined,
    resumeLimboStepSignature: row.resumeLimboStepSignature || undefined,
    executeRequeueLoopCount: row.executeRequeueLoopCount ?? undefined,
    executeRequeueLoopSignature: row.executeRequeueLoopSignature || undefined,
    postReviewFixCount: row.postReviewFixCount ?? undefined,
    planReviewReplanCount: row.planReviewReplanCount ?? undefined,
    recoveryRetryCount: row.recoveryRetryCount ?? undefined,
    taskDoneRetryCount: row.taskDoneRetryCount ?? undefined,
    // FNXC:Lifecycle 2026-07-16-21:40: FN-8141 skip-bypass taint marker; empty/null → undefined (no taint).
    bulkCompletionRefusalAt: row.bulkCompletionRefusalAt || undefined,
    // FNXC:WorkflowIrPin 2026-07-19-03:10: U9b/KTD-3 — hydrate the durable pin; empty/null → undefined (unpinned).
    workflowIrPin: row.workflowIrPin || undefined,
    workflowIrPinNodeId: row.workflowIrPinNodeId || undefined,
    workflowIrPinColumnId: row.workflowIrPinColumnId || undefined,
    // FNXC:LegacyAdoption 2026-07-19-03:10: U9b/KTD-8 — empty/null → undefined (never adopted).
    legacyAdoptedAt: row.legacyAdoptedAt || undefined,
    worktreeSessionRetryCount: row.worktreeSessionRetryCount ?? undefined,
    completionHandoffLimboRecoveryCount: row.completionHandoffLimboRecoveryCount ?? undefined,
    verificationFailureCount: row.verificationFailureCount ?? undefined,
    mergeConflictBounceCount: row.mergeConflictBounceCount ?? undefined,
    mergeAuditBounceCount: row.mergeAuditBounceCount ?? undefined,
    mergeTransientRetryCount: row.mergeTransientRetryCount ?? undefined,
    branchConflictRecoveryCount: row.branchConflictRecoveryCount ?? undefined,
    reviewerContextRetryCount: row.reviewerContextRetryCount ?? undefined,
    reviewerFallbackRetryCount: row.reviewerFallbackRetryCount ?? undefined,
    nextRecoveryAt: row.nextRecoveryAt || undefined,
    error: row.error || undefined,
    summary: row.summary || undefined,
    thinkingLevel: (row.thinkingLevel || undefined) as Task["thinkingLevel"],
    validatorThinkingLevel: (row.validatorThinkingLevel || undefined) as Task["validatorThinkingLevel"],
    planningThinkingLevel: (row.planningThinkingLevel || undefined) as Task["planningThinkingLevel"],
    mergerThinkingLevel: (row.mergerThinkingLevel || undefined) as Task["mergerThinkingLevel"],
    executionMode: (row.executionMode || undefined) as Task["executionMode"],
    // FNXC:PlannerOversight 2026-07-14-18:11: null → undefined (inherit); 0/1 → boolean.
    sessionAdvisorEnabled: row.sessionAdvisorEnabled === null || row.sessionAdvisorEnabled === undefined
      ? undefined
      : row.sessionAdvisorEnabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    columnMovedAt: row.columnMovedAt || undefined,
    firstExecutionAt: row.firstExecutionAt || undefined,
    cumulativeActiveMs: row.cumulativeActiveMs ?? undefined,
    cumulativePlanningMs: row.cumulativePlanningMs ?? undefined,
    planningStartedAt: row.planningStartedAt || undefined,
    columnDwellMs: fromJson<Record<string, number>>(row.columnDwellMs) ?? undefined,
    workflowTransitionNotification: fromJson<import("../types.js").WorkflowTransitionNotificationMarker>(row.workflowTransitionNotification) ?? undefined,
    plannerOversightLevel: (row.plannerOversightLevel || undefined) as Task["plannerOversightLevel"],
    awaitingApprovalReason: (row.awaitingApprovalReason || undefined) as Task["awaitingApprovalReason"],
    approvedPlanFingerprint: row.approvedPlanFingerprint || undefined,
    executionStartedAt: row.executionStartedAt || undefined,
    executionCompletedAt: row.executionCompletedAt || undefined,
    dependencies: fromJson<string[]>(row.dependencies) || [],
    steps: fromJson<import("../types.js").TaskStep[]>(row.steps) || [],
    customFields: fromJson<Record<string, unknown>>(row.customFields) ?? undefined,
    log: fromJson<import("../types.js").TaskLogEntry[]>(row.log) || [],
    tokenBudgetSoftAlertedAt: row.tokenBudgetSoftAlertedAt || undefined,
    tokenBudgetHardAlertedAt: row.tokenBudgetHardAlertedAt || undefined,
    tokenBudgetOverride: fromJson<import("../types.js").TaskTokenBudgetOverride>(row.tokenBudgetOverride) ?? undefined,
    tokenUsage: (() => {
      if (
        row.tokenUsageInputTokens === null
        || row.tokenUsageOutputTokens === null
        || row.tokenUsageCachedTokens === null
        || row.tokenUsageTotalTokens === null
        || row.tokenUsageFirstUsedAt === null
        || row.tokenUsageLastUsedAt === null
      ) {
        return undefined;
      }

      return {
        inputTokens: row.tokenUsageInputTokens,
        outputTokens: row.tokenUsageOutputTokens,
        cachedTokens: row.tokenUsageCachedTokens,
        cacheWriteTokens: row.tokenUsageCacheWriteTokens ?? 0,
        totalTokens: row.tokenUsageTotalTokens,
        firstUsedAt: row.tokenUsageFirstUsedAt,
        lastUsedAt: row.tokenUsageLastUsedAt,
        modelProvider: row.tokenUsageModelProvider ?? undefined,
        modelId: row.tokenUsageModelId ?? undefined,
        perModel: fromJson<import("../types.js").TaskTokenUsagePerModel[]>(row.tokenUsagePerModel) ?? undefined,
      };
    })(),
    attachments: (() => { const a = fromJson<TaskAttachment[]>(row.attachments); return a && a.length > 0 ? a : undefined; })(),
    steeringComments: (() => {
      const sc = fromJson<import("../types.js").SteeringComment[]>(row.steeringComments);
      return sc && sc.length > 0 ? sc : undefined;
    })(),
    comments: (() => {
      // Comments column already contains steering comments (addSteeringComment calls addComment).
      // Do NOT merge steeringComments here — that caused duplication on every read-write cycle.
      const c = fromJson<import("../types.js").TaskComment[]>(row.comments) || [];
      // Deduplicate by id to recover from prior corruption
      const seen = new Set<string>();
      const deduped = c.filter(entry => {
        if (seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      });
      return deduped.length > 0 ? deduped : undefined;
    })(),
    review: fromJson<import("../types.js").TaskReview>(row.review) ?? undefined,
    reviewState: normalizeTaskReviewState(fromJson<import("../types.js").TaskReviewState>(row.reviewState) ?? undefined),
    workflowStepResults: (() => { const w = fromJson<import("../types.js").WorkflowStepResult[]>(row.workflowStepResults); return w && w.length > 0 ? w : undefined; })(),
    prInfo: fromJson<import("../types.js").PrInfo>(row.prInfo),
    prInfos: (() => {
      const multi = fromJson<import("../types.js").PrInfo[]>(row.prInfos);
      if (multi && multi.length > 0) return multi;
      const single = fromJson<PrInfo>(row.prInfo);
      return single ? [single] : undefined;
    })(),
    issueInfo: fromJson<import("../types.js").IssueInfo>(row.issueInfo),
    githubTracking: fromJson<import("../types.js").TaskGithubTracking>(row.githubTracking) ?? undefined,
    gitlabTracking: fromJson<import("../types.js").TaskGitLabTracking>(row.gitlabTracking) ?? undefined,
    sourceIssue: (() => {
      if (
        row.sourceIssueProvider === null
        || row.sourceIssueRepository === null
        || row.sourceIssueExternalIssueId === null
        || row.sourceIssueNumber === null
      ) {
        return undefined;
      }

      return {
        provider: row.sourceIssueProvider,
        repository: row.sourceIssueRepository,
        externalIssueId: row.sourceIssueExternalIssueId,
        issueNumber: row.sourceIssueNumber,
        url: row.sourceIssueUrl ?? undefined,
        closedAt: row.sourceIssueClosedAt ?? undefined,
      };
    })(),
    mergeDetails: fromJson<import("../types.js").MergeDetails>(row.mergeDetails),
    // FNXC:Workspace 2026-06-24-15:30: deserialize the per-sub-repo worktree map. An empty/null map
    // normalizes to undefined so isWorkspaceTask() (keys-length>0) and the scope verifier behave the
    // same as a task that never acquired a sub-repo.
    workspaceWorktrees: (() => {
      const w = fromJson<import("../types.js").Task["workspaceWorktrees"]>(row.workspaceWorktrees);
      return w && Object.keys(w).length > 0 ? w : undefined;
    })(),
    breakIntoSubtasks: row.breakIntoSubtasks ? true : undefined,
    noCommitsExpected: row.noCommitsExpected ? true : undefined,
    // FNXC:WorkflowOptionalSteps 2026-06-29-02:55: an explicit empty optional-step
    // selection must hydrate back as [], not undefined — "all disabled" and "not
    // materialized" are different states (mirrors main's SQLite-path fix).
    enabledWorkflowSteps: (() => { const e = fromJson<string[]>(row.enabledWorkflowSteps); return Array.isArray(e) ? e : undefined; })(),
    modifiedFiles: (() => { const m = fromJson<string[]>(row.modifiedFiles); return m && m.length > 0 ? m : undefined; })(),
    declaredSymbols: (() => { const v = fromJson<string[]>(row.declaredSymbols); return v && v.length > 0 ? v : undefined; })(),
    missionId: row.missionId || undefined,
    sliceId: row.sliceId || undefined,
    assignedAgentId: row.assignedAgentId || undefined,
    pausedByAgentId: row.pausedByAgentId || undefined,
    assigneeUserId: row.assigneeUserId || undefined,
    nodeId: row.nodeId || undefined,
    effectiveNodeId: row.effectiveNodeId || undefined,
    effectiveNodeSource: (row.effectiveNodeSource as Task["effectiveNodeSource"]) || undefined,
    sourceType: (row.sourceType as SourceType) || undefined,
    sourceAgentId: row.sourceAgentId || undefined,
    sourceRunId: row.sourceRunId || undefined,
    sourceSessionId: row.sourceSessionId || undefined,
    sourceMessageId: row.sourceMessageId || undefined,
    sourceParentTaskId: row.sourceParentTaskId || undefined,
    proposalClaimId: row.proposalClaimId || undefined,
    sourceMetadata: (() => {
      const parsed = fromJson<Record<string, unknown>>(row.sourceMetadata) ?? undefined;
      return withTaskBranchContextInSourceMetadata(parsed, parseTaskBranchContextFromSourceMetadata(parsed));
    })(),
    branchContext: (() => {
      const parsed = fromJson<Record<string, unknown>>(row.sourceMetadata) ?? undefined;
      return parseTaskBranchContextFromSourceMetadata(parsed);
    })(),
    checkedOutBy: row.checkedOutBy || undefined,
    checkedOutAt: row.checkedOutAt || undefined,
    checkoutNodeId: row.checkoutNodeId || undefined,
    checkoutRunId: row.checkoutRunId || undefined,
    checkoutLeaseRenewedAt: row.checkoutLeaseRenewedAt || undefined,
    checkoutLeaseEpoch: row.checkoutLeaseEpoch ?? undefined,
    deletedAt: row.deletedAt ?? undefined,
    allowResurrection: row.allowResurrection ? true : undefined,
  };
}

export function rowToBranchGroup(row: BranchGroupRow): import("../types.js").BranchGroup {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    branchName: row.branchName,
    worktreePath: row.worktreePath ?? undefined,
    autoMerge: Boolean(row.autoMerge),
    prState: row.prState,
    prUrl: row.prUrl ?? undefined,
    prNumber: row.prNumber ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt ?? undefined,
  };
}

export function generateBranchGroupId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `BG-${timestamp}-${random}`;
}

export function computeTimedExecutionMs(log: import("../types.js").TaskLogEntry[] | undefined): number {
  if (!log || log.length === 0) return 0;
  let total = 0;
  for (const entry of log) {
    const action = typeof entry.action === "string" ? entry.action : "";
    const outcome = typeof entry.outcome === "string" ? entry.outcome : "";
    if (!action.includes("[timing]") && !outcome.includes("[timing]")) continue;
    const haystack = `${action}\n${outcome}`;
    const match = haystack.match(/(\d+(?:\.\d+)?)ms\b/i);
    if (!match) continue;
    const ms = Number(match[1]);
    if (Number.isFinite(ms)) total += ms;
  }
  return total;
}

export function archiveEntryToTask(
  entry: ArchivedTaskEntry,
  slim = false,
): Task {
  return {
    id: entry.id,
    lineageId: entry.lineageId || generateTaskLineageId(),
    title: entry.title,
    description: entry.description,
    priority: normalizeTaskPriority(entry.priority),
    column: "archived",
    preArchiveColumn: entry.preArchiveColumn,
    dependencies: entry.dependencies ?? [],
    steps: entry.steps ?? [],
    currentStep: entry.currentStep ?? 0,
    customFields: entry.customFields ?? undefined,
    size: entry.size,
    reviewLevel: entry.reviewLevel,
    prInfo: slim ? undefined : entry.prInfo,
    prInfos: slim ? undefined : entry.prInfos,
    issueInfo: slim ? undefined : entry.issueInfo,
    githubTracking: entry.githubTracking,
    gitlabTracking: entry.gitlabTracking,
    sourceIssue: slim ? undefined : entry.sourceIssue,
    attachments: slim ? undefined : entry.attachments,
    comments: entry.comments,
    review: slim ? undefined : entry.review,
    log: slim ? [] : entry.log ?? [],
    timedExecutionMs: slim ? computeTimedExecutionMs(entry.log) : undefined,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    columnMovedAt: entry.columnMovedAt,
    firstExecutionAt: entry.firstExecutionAt,
    cumulativeActiveMs: entry.cumulativeActiveMs,
    // FNXC:TaskTiming 2026-08-01-13:00: archive/restore must retain both
    // planning fields so archived tasks neither lose accumulated AI time nor
    // revive without the live segment anchor needed for exactly-once finalize.
    cumulativePlanningMs: entry.cumulativePlanningMs,
    planningStartedAt: entry.planningStartedAt,
    executionStartedAt: entry.executionStartedAt,
    executionCompletedAt: entry.executionCompletedAt,
    modelPresetId: entry.modelPresetId,
    modelProvider: entry.modelProvider,
    modelId: entry.modelId,
    validatorModelProvider: entry.validatorModelProvider,
    validatorModelId: entry.validatorModelId,
    planningModelProvider: entry.planningModelProvider,
    planningModelId: entry.planningModelId,
    mergerModelProvider: entry.mergerModelProvider,
    mergerModelId: entry.mergerModelId,
    mergerThinkingLevel: entry.mergerThinkingLevel,
    breakIntoSubtasks: entry.breakIntoSubtasks,
    noCommitsExpected: entry.noCommitsExpected,
    branchContext: entry.branchContext,
    autoMerge: entry.autoMerge,
    modifiedFiles: slim ? undefined : entry.modifiedFiles,
    declaredSymbols: entry.declaredSymbols,
    missionId: entry.missionId,
    sliceId: entry.sliceId,
    assigneeUserId: entry.assigneeUserId,
    mergeDetails: slim ? undefined : entry.mergeDetails,
  };
}

export function summarizeAgentLog(entries: AgentLogEntry[], totalCount: number): string | undefined {
  if (totalCount === 0) {
    return undefined;
  }

  const countsByType = new Map<string, number>();
  const countsByAgent = new Map<string, number>();
  for (const entry of entries) {
    countsByType.set(entry.type, (countsByType.get(entry.type) ?? 0) + 1);
    if (entry.agent) {
      countsByAgent.set(entry.agent, (countsByAgent.get(entry.agent) ?? 0) + 1);
    }
  }

  const typeSummary = Array.from(countsByType.entries())
    .map(([type, count]) => `${type}:${count}`)
    .join(", ");
  const agentSummary = Array.from(countsByAgent.entries())
    .map(([agent, count]) => `${agent}:${count}`)
    .join(", ");
  const recentText = entries
    .slice(-5)
    .map((entry) => {
      const source = entry.agent ? `${entry.agent}/${entry.type}` : entry.type;
      const text = (entry.detail || entry.text || "").replace(/\s+/g, " ").trim();
      const snippet = text.length > ARCHIVE_AGENT_LOG_SNIPPET_LIMIT
        ? `${text.slice(0, ARCHIVE_AGENT_LOG_SNIPPET_LIMIT)}...`
        : text;
      return snippet ? `${source}: ${snippet}` : source;
    })
    .filter(Boolean)
    .join("\n");

  return [
    `Agent log entries: ${totalCount}`,
    typeSummary ? `Types: ${typeSummary}` : undefined,
    agentSummary ? `Agents: ${agentSummary}` : undefined,
    recentText ? `Recent entries:\n${recentText}` : undefined,
  ].filter(Boolean).join("\n");
}

export { ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT, ARCHIVE_AGENT_LOG_SNIPPET_LIMIT };

export function rowToTaskDocument(row: TaskDocumentRow): import("../types.js").TaskDocument {
  return {
    id: row.id,
    taskId: row.taskId,
    key: row.key,
    content: row.content,
    revision: row.revision,
    author: row.author,
    metadata: fromJson<Record<string, unknown>>(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.mimeType !== null ? { mimeType: row.mimeType } : {}),
    ...(row.sizeBytes !== null ? { sizeBytes: row.sizeBytes } : {}),
    ...(row.uri !== null ? { uri: row.uri } : {}),
    ...(row.content !== null ? { content: row.content } : {}),
    authorId: row.authorId,
    authorType: row.authorType,
    ...(row.taskId !== null ? { taskId: row.taskId } : {}),
    metadata: fromJson<Record<string, unknown>>(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToTaskDocumentRevision(row: TaskDocumentRevisionRow): import("../types.js").TaskDocumentRevision {
  return {
    id: row.id,
    taskId: row.taskId,
    key: row.key,
    content: row.content,
    revision: row.revision,
    author: row.author,
    metadata: fromJson<Record<string, unknown>>(row.metadata),
    createdAt: row.createdAt,
  };
}

export function rowToGoalCitation(row: GoalCitationRow): GoalCitation {
  return {
    id: row.id,
    goalId: row.goalId,
    agentId: row.agentId,
    ...(row.taskId ? { taskId: row.taskId } : {}),
    surface: row.surface,
    sourceRef: row.sourceRef,
    snippet: row.snippet,
    timestamp: row.timestamp,
  };
}

// Re-export types that callers may need alongside these converters.
export type { ArchiveAgentLogMode };

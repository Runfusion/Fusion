import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, watch, type Dirent, type FSWatcher } from "node:fs";
import type { Task, TaskDetail, TaskCreateInput, TaskAttachment, AgentLogEntry, BoardConfig, Column, ColumnId, CheckoutClaimPrecondition, MergeResult, Settings, GlobalSettings, ProjectSettings, ActivityLogEntry, ActivityEventType, TaskDocument, TaskDocumentRevision, TaskDocumentCreateInput, TaskDocumentWithTask, Artifact, ArtifactCreateInput, ArtifactType, ArtifactWithTask, InboxTask, TaskLogEntry, RunMutationContext, RunAuditEvent, RunAuditEventInput, RunAuditEventFilter, ArchivedTaskEntry, ArchiveAgentLogMode, TaskPriority, SourceType, WorkflowStepTemplate, Agent, AutostashOrphanRecord, TaskCommitAssociation, TaskCommitAssociationMatchSource, TaskCommitAssociationConfidence, CommitAssociationDiffBackfillReport, GithubIssueAction, MergeQueueEntry, MergeQueueEnqueueOptions, MergeQueueAcquireOptions, MergeQueueReleaseOutcome, HandoffToReviewOptions, GoalCitation, GoalCitationFilter, GoalCitationInput, GoalCitationSurface, BranchGroup, BranchGroupCreateInput, BranchGroupUpdate, TaskBranchAssignmentMode, MergeRequestRecord, MergeRequestState, MergeRequestWorkflowProjectionOptions, CompletionHandoffMarker, WorkflowWorkItem, WorkflowWorkItemDueFilter, WorkflowWorkItemKind, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch, WorkflowWorkItemUpsertInput, PrEntity, PrEntityCreateInput, PrEntityUpdate, PrEntityState, PrThreadState, PrThreadOutcome, PrConflictState, PrChecksRollup, PrReviewDecision, PluginActivation, PluginActivationInput } from "./types.js";
import { createActivityLogSnapshot, createRunAuditSnapshot, createTaskMetadataSnapshot, toTaskMetadataRecord, validateSnapshotEnvelope, type ActivityLogSnapshot, type RunAuditSnapshot, type TaskMetadataSnapshot } from "./shared-mesh-state.js";
import { VALID_TRANSITIONS, COLUMNS, DEFAULT_SETTINGS, isColumn, isGlobalOnlySettingsKey, WORKFLOW_STEP_TEMPLATES, validateDocumentKey, assertNotWorkspaceTaskMerge } from "./types.js";
import { DEFAULT_PROJECT_SETTINGS } from "./settings-schema.js";
import {
  MOVED_SETTINGS_KEYS,
  SETTINGS_MIGRATION_VERSION,
  SETTINGS_MIGRATION_MARKER_KEY,
  stripMovedSettingsKeys,
  patchContainsMovedKey,
} from "./moved-settings.js";
import { parseWorkflowIr, serializeWorkflowIr, downgradeIrToV1IfPure } from "./workflow-ir.js";
import { stepsToWorkflowIr, stepToFragmentIr, layoutForIr } from "./workflow-steps-to-ir.js";
import { resolveAllowedColumns, workflowHasColumn } from "./workflow-transitions.js";

function isWorkflowColumnsCompatibilityFlagEnabled(settings: Pick<Settings, "experimentalFeatures"> | undefined): boolean {
  /*
  FNXC:WorkflowColumns 2026-06-22-00:00:
  TaskStore still needs the raw compatibility flag for legacy movement characterization, v1 workflow-IR rollback persistence, and ON→OFF custom-column evacuation tests. This is narrower than the public runtime helper, which treats stale false values as enabled after workflow-column cutover.
  */
  return settings?.experimentalFeatures?.workflowColumns === true;
}
import {
  type PluginGateVerdict,
  findWorkflowColumn,
  resolveColumnPluginGates,
} from "./plugin-gate-verdict.js";
import { getTraitRegistry, assertColumnTraitsValid } from "./trait-registry.js";
import { resolveColumnCapacity, DEFAULT_WORKFLOW_POOL_ID } from "./workflow-capacity.js";
import {
  OccupiedColumnsError,
  assertRehomeTargetValid,
  computeRemovedOccupiedColumns,
  computeIncompatibleFieldChanges,
  IncompatibleFieldChangeError,
  resolveEntryColumnId,
  resolveSwitchReconciliation,
  runReconciliationAbort,
} from "./workflow-reconciliation.js";
import {
  type DefaultWorkflowMoveContext,
  applyDefaultWorkflowMoveEffects,
  evaluateMergeBlockerGuard,
  registerDefaultWorkflowHooks,
} from "./default-workflow-hooks.js";
import {
  type TransitionRejection,
  makeTransitionRejection,
  makeTransitionPending,
} from "./transition-types.js";
import {
  writeTransitionPending,
  clearTransitionPending,
  readTransitionPending,
  reconcileHooksRemaining,
} from "./transition-pending.js";
import { BUILTIN_CODING_WORKFLOW_IR } from "./builtin-coding-workflow-ir.js";
import type { WorkflowIr, WorkflowIrColumn, WorkflowFieldDefinition, WorkflowSettingDefinition } from "./workflow-ir-types.js";
import { getWorkflowExtensionRegistry } from "./workflow-extension-registry.js";
import type { WorkflowMovePolicyInput } from "./workflow-extension-types.js";
import {
  validateCustomFieldPatch,
  applyFieldDefaults,
  reconcileFieldsOnWorkflowChange,
  CustomFieldRejectionError,
  type CustomFieldRejection,
} from "./task-fields.js";
import { validateSettingValuePatch, WorkflowSettingRejectionError } from "./workflow-settings.js";
import { applyPromptOverridesToIr } from "./workflow-prompt-overrides.js";
// Side-effect import: registers the 14 built-in trait DEFINITIONS into the
// shared trait registry on load (the flag-ON path resolves traits by id).
import "./builtin-traits.js";
// Step-inversion U12 (KTD-12): the legacy `parseStepsFromPrompt` path resolves
// the `step-headings` parser through the registry (proving the registry path),
// staying byte-identical with the direct extracted function.
import { getStepParser } from "./step-parsers.js";
import type {
  WorkflowDefinition,
  WorkflowDefinitionInput,
  WorkflowDefinitionUpdate,
  WorkflowNodeLayout,
} from "./workflow-definition-types.js";
import { compileWorkflowToSteps, isInterpreterDeferredWorkflowCompileError } from "./workflow-compiler.js";
import {
  BUILTIN_WORKFLOWS,
  getBuiltinWorkflow,
  getRequiredPluginIdForBuiltinWorkflow,
  isBuiltinWorkflowEnabled,
  isBuiltinWorkflowId,
  isBuiltinWorkflowPluginGated,
} from "./builtin-workflows.js";
import { resolveWorkflowIrById } from "./workflow-ir-resolver.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "./builtin-workflow-settings.js";
import {
  WORKFLOW_PARITY_OBSERVED_MUTATION,
  WORKFLOW_PARITY_DRIFT_MUTATION,
  DUAL_ACCEPT_PARITY_MUTATIONS,
  computeWorkflowColumnsGraduationReport,
  type WorkflowParityDiff,
  type WorkflowParitySummary,
  type WorkflowColumnsGraduationReport,
} from "./workflow-parity.js";

/** Tags WorkflowStep rows materialized by compiling a workflow so they can be
 *  filtered out of the user-facing step manager and cleaned up on re-selection. */
const WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX = "workflow:";
import { resolveWorktrunkSettings, validateWorktrunkSettings } from "./worktrunk-settings.js";
import { validateLocale } from "./settings-validation.js";
import { normalizeTaskPriority } from "./task-priority.js";
import { validateBranchGroupBranchName, filterTasksByBranchGroup } from "./branch-assignment.js";
import { allowsAutoMergeProcessing } from "./task-merge.js";
import { canAgentTakeImplementationTaskForExplicitRouting } from "./agent-role-policy.js";
import { GlobalSettingsStore } from "./global-settings.js";
import { Database, SCHEMA_VERSION, toJson, toJsonNullable, fromJson } from "./db.js";
import { ArchiveDatabase } from "./archive-db.js";
import { detectLegacyData, migrateFromLegacy } from "./db-migrate.js";
import { buildSnippet, extractGoalCitations } from "./goal-citation-extractor.js";
import { MissionStore } from "./mission-store.js";
import { PluginStore } from "./plugin-store.js";
import { InsightStore } from "./insight-store.js";
import { ResearchStore } from "./research-store.js";
import { ExperimentSessionStore } from "./experiment-session-store.js";
import { TodoStore } from "./todo-store.js";
import { GoalStore } from "./goal-store.js";
import { EvalStore } from "./eval-store.js";
import { BackwardCompat, ProjectRequiredError } from "./migration.js";
import { CentralCore } from "./central-core.js";
import { SecretsStore } from "./secrets-store.js";
import { MasterKeyManager } from "./master-key.js";
import { hasSyncPassphraseConfigured } from "./secrets-sync-passphrase.js";
import { getTaskMergeBlocker, resolveTaskMergeTarget } from "./task-merge.js";
import { getInReviewStallReason } from "./in-review-stall.js";
import { getInReviewStalledSignal } from "./in-review-stalled.js";
import { getStalePausedReviewSignal } from "./stale-paused-review.js";
import { getStalePausedTodoSignal } from "./stale-paused-todo.js";
import { getTaskAgeStalenessSignal, type TaskAgeStalenessThresholds } from "./task-age-staleness.js";
import { ensureMemoryFileWithBackend } from "./project-memory.js";
import { runCommandAsync } from "./run-command.js";
import { createLogger } from "./logger.js";
import {
  appendAgentLogEntriesSync,
  countAgentLogEntries,
  pruneAgentLogFiles as pruneAgentLogFileEntries,
  readAgentLogEntries,
  readAgentLogEntriesByTimeRange,
} from "./agent-log-file-store.js";
import { truncateAgentLogDetail } from "./agent-log-constants.js";
import { emitUsageEvent as emitUsageEventToDb, type UsageEventInput } from "./usage-events.js";
import { validateNodeOverrideChange } from "./node-override-guard.js";
import { sanitizeTitle, summarizeTitle } from "./ai-summarize.js";
import { extractTaskIdTokens, normalizeTitleForTaskId } from "./task-title-id-drift.js";
import { resolveTitleSummarizerSettingsModel } from "./model-resolution.js";
import { resolveEffectiveSettingsById } from "./workflow-settings-resolver.js";
import { getErrorMessage } from "./error-message.js";
import { getTaskCreatedHook } from "./task-creation-hooks.js";
import {
  assertNotLinkedWorktreeOfExistingProject,
  assertProjectRootDir,
} from "./project-root-guard.js";
import { generateTaskLineageId, normalizeTaskCommitAssociation } from "./task-lineage.js";
import { createDistributedTaskIdAllocator, reconcileTaskIdState, resolveLocalNodeId, type DistributedTaskIdAllocator } from "./distributed-task-id.js";
import { detectStalledReview } from "./stalled-review-detector.js";
import { computeRetrySummary } from "./retry-summary.js";
import { archiveAsSameAgentDuplicate, findSameAgentDuplicates } from "./duplicate-intake.js";
import { isNearDuplicateCanonicalInactive } from "./near-duplicate-canonical.js";
import {
  detectTaskIdIntegrityAnomalies,
  type TaskIdIntegrityReport,
} from "./task-id-integrity.js";
import {
  buildBootstrapPrompt,
  replicationCollisionError,
  taskMatchesReplicatedCreate,
} from "./mesh-task-replication.js";
import type { MeshReplicatedTaskApplyResult, MeshReplicatedTaskCreatePayload } from "./types.js";

/** Database row shape for the tasks table (all columns). */
interface TaskRow {
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
  mergeRetries: number | null;
  workflowStepRetries: number | null;
  stuckKillCount: number | null;
  resumeLimboCount: number | null;
  graphResumeRetryCount: number | null;
  resumeLimboTipSha: string | null;
  resumeLimboStepSignature: string | null;
  postReviewFixCount: number | null;
  recoveryRetryCount: number | null;
  taskDoneRetryCount: number | null;
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
  executionMode: string | null;
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
  sourceIssueProvider: string | null;
  sourceIssueRepository: string | null;
  sourceIssueExternalIssueId: string | null;
  sourceIssueNumber: number | null;
  sourceIssueUrl: string | null;
  sourceIssueClosedAt: string | null;
  mergeDetails: string | null;
  breakIntoSubtasks: number | null;
  noCommitsExpected: number | null;
  enabledWorkflowSteps: string | null;
  modifiedFiles: string | null;
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
  checkedOutBy: string | null;
  checkedOutAt: string | null;
  checkoutNodeId: string | null;
  checkoutRunId: string | null;
  checkoutLeaseRenewedAt: string | null;
  checkoutLeaseEpoch: number | null;
  deletedAt: string | null;
  allowResurrection: number | null;
}

type TaskPersistSerializationContext = {
  lineageId: string;
};

type TaskColumnDescriptor = {
  column: keyof TaskRow;
  sqlIdentifier: string;
  serialize: (task: Task, context: TaskPersistSerializationContext) => unknown;
};

function defineTaskColumn(
  column: keyof TaskRow,
  serialize: TaskColumnDescriptor["serialize"],
  sqlIdentifier: string = column,
): TaskColumnDescriptor {
  return { column, sqlIdentifier, serialize };
}

const serializeTaskAutoMerge: TaskColumnDescriptor["serialize"] = (task) => task.autoMerge === undefined ? null : (task.autoMerge ? 1 : 0);
const serializeTaskAutoMergeProvenance: TaskColumnDescriptor["serialize"] = (task) => task.autoMergeProvenance ?? null;

// Keep this descriptor order in lockstep with the named-column INSERT/UPSERT
// clauses we generate below. SQLite binds by the explicit column list we emit,
// so this logical persist order does not need to match the table's physical
// column layout from CREATE TABLE + migrations.
const TASK_COLUMN_DESCRIPTORS: TaskColumnDescriptor[] = [
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
  defineTaskColumn("mergeRetries", (task) => task.mergeRetries ?? null),
  defineTaskColumn("workflowStepRetries", (task) => task.workflowStepRetries ?? null),
  defineTaskColumn("stuckKillCount", (task) => task.stuckKillCount ?? 0),
  defineTaskColumn("resumeLimboCount", (task) => task.resumeLimboCount ?? 0),
  defineTaskColumn("graphResumeRetryCount", (task) => task.graphResumeRetryCount === undefined ? 0 : task.graphResumeRetryCount),
  defineTaskColumn("resumeLimboTipSha", (task) => task.resumeLimboTipSha ?? null),
  defineTaskColumn("resumeLimboStepSignature", (task) => task.resumeLimboStepSignature ?? null),
  defineTaskColumn("postReviewFixCount", (task) => task.postReviewFixCount ?? 0),
  defineTaskColumn("recoveryRetryCount", (task) => task.recoveryRetryCount ?? null),
  defineTaskColumn("taskDoneRetryCount", (task) => task.taskDoneRetryCount ?? 0),
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
  defineTaskColumn("executionMode", (task) => task.executionMode ?? null),
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
  defineTaskColumn("sourceIssueProvider", (task) => task.sourceIssue?.provider ?? null),
  defineTaskColumn("sourceIssueRepository", (task) => task.sourceIssue?.repository ?? null),
  defineTaskColumn("sourceIssueExternalIssueId", (task) => task.sourceIssue?.externalIssueId ?? null),
  defineTaskColumn("sourceIssueNumber", (task) => task.sourceIssue?.issueNumber ?? null),
  defineTaskColumn("sourceIssueUrl", (task) => task.sourceIssue?.url ?? null),
  defineTaskColumn("sourceIssueClosedAt", (task) => task.sourceIssue?.closedAt ?? null),
  defineTaskColumn("mergeDetails", (task) => toJsonNullable(task.mergeDetails)),
  defineTaskColumn("breakIntoSubtasks", (task) => task.breakIntoSubtasks ? 1 : 0),
  defineTaskColumn("noCommitsExpected", (task) => task.noCommitsExpected ? 1 : 0),
  defineTaskColumn("enabledWorkflowSteps", (task) => toJson(task.enabledWorkflowSteps || [])),
  defineTaskColumn("modifiedFiles", (task) => toJson(task.modifiedFiles || [])),
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
  defineTaskColumn("checkedOutBy", (task) => task.checkedOutBy ?? null),
  defineTaskColumn("checkedOutAt", (task) => task.checkedOutAt ?? null),
  defineTaskColumn("checkoutNodeId", (task) => task.checkoutNodeId ?? null),
  defineTaskColumn("checkoutRunId", (task) => task.checkoutRunId ?? null),
  defineTaskColumn("checkoutLeaseRenewedAt", (task) => task.checkoutLeaseRenewedAt ?? null),
  defineTaskColumn("checkoutLeaseEpoch", (task) => task.checkoutLeaseEpoch ?? 0),
  defineTaskColumn("deletedAt", (task) => task.deletedAt ?? null),
  defineTaskColumn("allowResurrection", (task) => task.allowResurrection ? 1 : 0),
];

const TASK_COLUMN_DESCRIPTOR_BY_COLUMN = new Map(
  TASK_COLUMN_DESCRIPTORS.map((descriptor) => [descriptor.column, descriptor]),
);
const TASK_PERSIST_SQL_COLUMNS = TASK_COLUMN_DESCRIPTORS.map((descriptor) => descriptor.sqlIdentifier).join(", ");
const TASK_UPSERT_SQL_ASSIGNMENTS = TASK_COLUMN_DESCRIPTORS
  .filter((descriptor) => descriptor.column !== "id")
  .map((descriptor) => `        ${descriptor.sqlIdentifier} = excluded.${descriptor.sqlIdentifier}`)
  .join(",\n");

/** Database row shape for the task_documents table. */
const TASK_BRANCH_CONTEXT_METADATA_KEY = "fusionBranchContext";

function parseTaskBranchContextFromSourceMetadata(sourceMetadata: Record<string, unknown> | undefined): import("./types.js").TaskBranchContext | undefined {
  const raw = sourceMetadata?.[TASK_BRANCH_CONTEXT_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  // groupId is optional: only shared-mode members carry one. A non-shared
  // member persists source/assignmentMode without a groupId, so a missing or
  // empty groupId must NOT discard the whole context.
  const groupId = typeof candidate.groupId === "string"
    ? candidate.groupId.trim() || undefined
    : undefined;
  if (candidate.source !== "planning" && candidate.source !== "mission" && candidate.source !== "new-task") return undefined;
  if (candidate.assignmentMode !== "shared" && candidate.assignmentMode !== "per-task-derived") return undefined;
  const inheritedBaseBranch = typeof candidate.inheritedBaseBranch === "string" && candidate.inheritedBaseBranch.trim().length > 0
    ? candidate.inheritedBaseBranch.trim()
    : undefined;
  return {
    ...(groupId ? { groupId } : {}),
    source: candidate.source,
    assignmentMode: candidate.assignmentMode,
    inheritedBaseBranch,
  };
}

function withTaskBranchContextInSourceMetadata(
  sourceMetadata: Record<string, unknown> | undefined,
  branchContext: import("./types.js").TaskBranchContext | undefined,
): Record<string, unknown> | undefined {
  if (!branchContext) return sourceMetadata;
  return {
    ...(sourceMetadata ?? {}),
    [TASK_BRANCH_CONTEXT_METADATA_KEY]: {
      ...(branchContext.groupId?.trim()
        ? { groupId: branchContext.groupId.trim() }
        : {}),
      source: branchContext.source,
      assignmentMode: branchContext.assignmentMode,
      ...(branchContext.inheritedBaseBranch ? { inheritedBaseBranch: branchContext.inheritedBaseBranch } : {}),
    },
  };
}

interface BranchGroupRow {
  id: string;
  sourceType: "mission" | "planning" | "new-task";
  sourceId: string;
  branchName: string;
  worktreePath: string | null;
  autoMerge: number;
  prState: "none" | "open" | "merged" | "closed";
  prUrl: string | null;
  prNumber: number | null;
  status: "open" | "finalized" | "abandoned";
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

interface PrEntityRow {
  id: string;
  sourceType: "task" | "branch-group";
  sourceId: string;
  repo: string;
  headBranch: string;
  baseBranch: string | null;
  state: PrEntityState;
  prNumber: number | null;
  prUrl: string | null;
  headOid: string | null;
  mergeable: string | null;
  checksRollup: string | null;
  reviewDecision: string | null;
  autoMerge: number;
  unverified: number;
  failureReason: string | null;
  responseRounds: number;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

interface PrThreadStateRow {
  prEntityId: string;
  threadId: string;
  headOid: string;
  outcome: PrThreadOutcome;
  fixCommitSha: string | null;
  updatedAt: number;
}

interface TaskCommitAssociationRow {
  id: string;
  taskLineageId: string;
  taskIdSnapshot: string;
  commitSha: string;
  commitSubject: string;
  authoredAt: string;
  matchedBy: TaskCommitAssociationMatchSource;
  confidence: TaskCommitAssociationConfidence;
  note: string | null;
  additions: number | null;
  deletions: number | null;
  createdAt: string;
  updatedAt: string;
}

interface CommitAssociationDiffBackfillCandidateRow {
  commitSha: string;
  rowCount: number;
}

interface TaskDocumentRow {
  id: string;
  taskId: string;
  key: string;
  content: string;
  revision: number;
  author: string;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the artifacts table. */
interface ArtifactRow {
  id: string;
  type: ArtifactType;
  title: string;
  description: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  uri: string | null;
  content: string | null;
  authorId: string;
  authorType: "agent" | "user" | "system";
  taskId: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the task_document_revisions table. */
interface TaskDocumentRevisionRow {
  id: number;
  taskId: string;
  key: string;
  content: string;
  revision: number;
  author: string;
  metadata: string | null;
  createdAt: string;
}

interface GoalCitationRow {
  id: number;
  goalId: string;
  agentId: string;
  taskId: string | null;
  surface: GoalCitationSurface;
  sourceRef: string;
  snippet: string;
  timestamp: string;
}

/** Database row shape for the runAuditEvents table. */
interface RunAuditEventRow {
  id: string;
  timestamp: string;
  taskId: string | null;
  agentId: string;
  runId: string;
  domain: string;
  mutationType: string;
  target: string;
  metadata: string | null;
}

interface MergeQueueRow {
  taskId: string;
  enqueuedAt: string;
  priority: string;
  leasedBy: string | null;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  lastError: string | null;
}

interface MergeRequestRow {
  taskId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  lastError: string | null;
}

interface CompletionHandoffMarkerRow {
  taskId: string;
  acceptedAt: string;
  source: string;
}

interface WorkflowWorkItemRow {
  id: string;
  runId: string;
  taskId: string;
  nodeId: string;
  kind: string;
  state: string;
  attempt: number;
  retryAfter: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Database row shape for the config table. */
interface ConfigRow {
  nextId: number;
  settings: string | null;
  nextWorkflowStepId: number | null;
}

/** Database row shape for the activityLog table. */
interface ActivityLogRow {
  id: string;
  timestamp: string;
  type: string;
  taskId: string | null;
  taskTitle: string | null;
  details: string;
  metadata: string | null;
}

function normalizeTaskReviewState(reviewState: Task["reviewState"] | undefined): Task["reviewState"] | undefined {
  if (!reviewState) {
    return undefined;
  }

  const itemsById = new Map(reviewState.items.map((item) => [item.id, item]));
  const sourceMode = reviewState.source;
  const normalizedAddressing = reviewState.addressing.map((record) => {
    const item = itemsById.get(record.itemId);
    const source = item?.source === "reviewer-agent" ? "reviewer-agent" : "pr-review";
    const summary = item?.summary?.trim() || item?.body?.trim().slice(0, 160) || `Review item ${record.itemId}`;
    const body = item?.body ?? summary;
    return {
      ...record,
      snapshot: record.snapshot ?? {
        itemId: record.itemId,
        sourceMode,
        source,
        summary,
        body,
        authorLogin: item?.author?.login,
        filePath: item?.path,
        threadId: item?.threadId,
        url: item?.htmlUrl,
      },
    };
  });

  return {
    ...reviewState,
    addressing: normalizedAddressing,
  };
}

const DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT = 1_000;
const DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT = 4_000;
let taskActivityLogEntryLimit = DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT;
let taskActivityLogOutcomeLimit = DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT;
const ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT = 25;
const ARCHIVE_AGENT_LOG_SNIPPET_LIMIT = 160;
// reconcileOrphanedTaskDirs only recovers task dirs whose task.json was modified within
// this window. Bounds the sweep to genuinely-recent orphans (heartbeat races, rows lost
// to a recent DB corruption) and prevents silent resurrection of ancient deleted-task
// dirs that merely lingered on disk (legacy hard-deletes left no tombstone). 7 days is
// generous enough to cover an engine that was offline for a while.
const RECONCILE_ORPHAN_TASK_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const storeLog = createLogger("task-store");
const coreLog = createLogger("core");

/**
 * Reject branch names that would be unsafe to interpolate into a shell command.
 * The allowed set is a conservative subset of git's refname rules: alphanumerics,
 * `_`, `.`, `/`, `+`, and `-`, with the same leading/trailing/segment restrictions
 * git enforces. Any branch that fails this check is rejected before reaching the
 * shell, so no branch-name value can inject shell metacharacters.
 */
function assertSafeGitBranchName(name: string): void {
  if (
    !name ||
    name.length > 255 ||
    name.startsWith("-") ||
    name.startsWith(".") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock") ||
    name.includes("..") ||
    name.includes("@{") ||
    !/^[A-Za-z0-9._/+-]+$/.test(name)
  ) {
    throw new Error(`Unsafe git branch name: ${JSON.stringify(name)}`);
  }
}

/**
 * Reject filesystem paths that would be unsafe to interpolate into a shell
 * command. Worktree paths are generated by fusion itself and are expected to
 * be absolute, but `task.worktree` is writable via the authenticated API, so
 * validate at the shell boundary as defense-in-depth.
 */
function assertSafeAbsolutePath(path: string): void {
  const isAbsolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
  if (
    !path ||
    path.length > 4096 ||
    !isAbsolute ||
    path.startsWith("-") ||
    // Reject shell metacharacters, quotes, control chars, and NULs.
    /["'`$\n\r\t;&|<>()*?[\]{}\\\0]/.test(
      path.replace(/^[A-Za-z]:/, ""), // ignore the drive-letter colon on Windows
    )
  ) {
    throw new Error(`Unsafe path: ${JSON.stringify(path)}`);
  }
}

/**
 * Test-only seam for overriding task activity log retention/truncation limits.
 * Must not be used by production code. Tests overriding limits must restore
 * defaults in afterEach/afterAll by passing null.
 */
export function __setTaskActivityLogLimitsForTesting(
  overrides: { entryLimit?: number; outcomeLimit?: number } | null,
): void {
  if (overrides == null || (overrides.entryLimit == null && overrides.outcomeLimit == null)) {
    taskActivityLogEntryLimit = DEFAULT_TASK_ACTIVITY_LOG_ENTRY_LIMIT;
    taskActivityLogOutcomeLimit = DEFAULT_TASK_ACTIVITY_LOG_OUTCOME_LIMIT;
    return;
  }

  if (overrides.entryLimit != null) {
    if (!Number.isInteger(overrides.entryLimit) || overrides.entryLimit < 1) {
      throw new Error("Task activity log entryLimit must be an integer >= 1");
    }
    taskActivityLogEntryLimit = overrides.entryLimit;
  }

  if (overrides.outcomeLimit != null) {
    if (!Number.isInteger(overrides.outcomeLimit) || overrides.outcomeLimit < 1) {
      throw new Error("Task activity log outcomeLimit must be an integer >= 1");
    }
    taskActivityLogOutcomeLimit = overrides.outcomeLimit;
  }
}

function truncateTaskLogOutcome(outcome: string | undefined): string | undefined {
  if (!outcome || outcome.length <= taskActivityLogOutcomeLimit) {
    return outcome;
  }
  return `${outcome.slice(0, taskActivityLogOutcomeLimit)}\n... outcome truncated to ${taskActivityLogOutcomeLimit} characters ...`;
}

function compactTaskActivityLog(entries: TaskLogEntry[]): TaskLogEntry[] {
  const recentEntries = entries.slice(-taskActivityLogEntryLimit);
  return recentEntries.map((entry) => ({
    ...entry,
    outcome: truncateTaskLogOutcome(entry.outcome),
  }));
}

/**
 * Detect whether a PROMPT.md body is the auto-generated bootstrap stub
 * (`# heading\n\n<description>\n`) that `createTask` writes for triage tasks,
 * versus a real specification produced by triage or planning.
 *
 * Detection is wrapper-shape-exact: the on-disk content is compared against
 * the exact bytes `createTask` would have written for the *pre-update*
 * title/description. Earlier heuristic detectors (size caps, `##` header
 * presence, `**Created:**` / `**Size:**` markers) misfired on imported issue
 * bodies that contain `## Repro`, `**Created:** ...`, etc. — those are real
 * stubs but look like real specs to a content-inspecting check. By matching
 * against the wrapper produced from the previous title/description, we are
 * robust to anything the description itself contains.
 */
function isBootstrapPromptStub(
  content: string,
  taskId: string,
  preUpdateTitle: string | undefined,
  preUpdateDescription: string,
): boolean {
  return content === buildBootstrapPrompt(taskId, preUpdateTitle, preUpdateDescription);
}

/**
 * Replace just the leading `# ...` heading line of a PROMPT.md body, leaving
 * every other section untouched. Used when a metadata edit (title or
 * description change) needs to keep the displayed heading in sync without
 * disturbing the rest of a real specification.
 *
 * If the file does not start with a `#` heading, it is returned verbatim —
 * the caller has no clean place to splice the heading and the spec's content
 * is more important to preserve than the displayed title (task.json is the
 * canonical source for title/description anyway).
 */
function rewriteHeadingLine(content: string, newHeading: string): string {
  const match = content.match(/^#[^\n]*\n?/);
  if (!match) {
    return content;
  }
  const trailingNewline = match[0].endsWith("\n") ? "\n" : "";
  return `# ${newHeading}${trailingNewline}${content.slice(match[0].length)}`;
}

/**
 * Replace the body of the `## Mission` section with `newDescription`, leaving
 * every other section untouched. Used to propagate `task.description` edits
 * into a real spec without disturbing custom sections (Review Level, Frontend
 * UX Criteria, File Scope, Acceptance Criteria, etc.) that a section-whitelist
 * regen would silently drop.
 *
 * Returns the original content unchanged if there is no `## Mission` section.
 */
function rewriteMissionSection(content: string, newDescription: string): string {
  const missionMatch = content.match(/^##\s+Mission\s*$/m);
  if (!missionMatch || missionMatch.index === undefined) {
    return content;
  }
  const headerEnd = missionMatch.index + missionMatch[0].length;
  const rest = content.slice(headerEnd);
  // Find the next `## ` heading (start of next section). The match position is
  // relative to `rest`, so we re-anchor to the absolute offset.
  const nextHeading = rest.search(/\n##\s/);
  const sectionEndAbsolute = nextHeading === -1 ? content.length : headerEnd + nextHeading;
  const before = content.slice(0, headerEnd);
  const after = content.slice(sectionEndAbsolute);
  // Reconstruct: header line + blank line + new description + blank line +
  // trailing content (which begins with the newline before the next heading).
  return `${before}\n\n${newDescription}\n${after}`;
}

/**
 * Canonicalizes a settings object by stripping legacy fields that are no longer valid
 * and rewriting legacy path values left over from the kb → fn rename.
 */
function canonicalizeSettings(settings: Settings): Settings {
  // Strip legacy globalMaxConcurrent from project settings - this field was
  // deprecated in favor of the global-level maxConcurrent in concurrency settings.
  const { globalMaxConcurrent, ...rest } = settings as Settings & { globalMaxConcurrent?: number };
  const base = globalMaxConcurrent !== undefined ? (rest as Settings) : settings;

  const canonicalWorktrunk = (() => {
    try {
      return validateWorktrunkSettings(base.worktrunk);
    } catch {
      return undefined;
    }
  })();

  const withWorktrunk = {
    ...base,
    ...(canonicalWorktrunk !== undefined ? { worktrunk: canonicalWorktrunk } : {}),
  };

  // Rewrite legacy .kb/backups → .fusion/backups for projects upgraded from the
  // old brand so persisted settings keep working. Custom .kb/* paths are left alone.
  if (withWorktrunk.autoBackupDir === ".kb/backups") {
    return { ...withWorktrunk, autoBackupDir: ".fusion/backups" };
  }
  return withWorktrunk;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMergeWithNullDelete(
  existingValue: unknown,
  patchValue: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = isPlainObject(existingValue) ? { ...existingValue } : {};

  for (const [key, value] of Object.entries(patchValue)) {
    if (value === null) {
      delete merged[key];
      continue;
    }

    if (isPlainObject(value)) {
      const nested = deepMergeWithNullDelete(merged[key], value);
      if (nested === undefined) {
        delete merged[key];
      } else {
        merged[key] = nested;
      }
      continue;
    }

    merged[key] = value;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export interface TaskStoreEvents {
  "task:created": [task: Task];
  "task:moved": [data: { task: Task; from: ColumnId; to: ColumnId; source: "user" | "engine" | "scheduler" }];
  "task:updated": [task: Task];
  "task:deleted": [task: Task, meta?: { githubIssueAction?: GithubIssueAction }];
  "task:merged": [result: MergeResult];
  "settings:updated": [data: { settings: Settings; previous: Settings }];
  "agent:log": [entry: AgentLogEntry];
  "merger:autostashOrphans": [data: {
    rootDir: string;
    records: AutostashOrphanRecord[];
  }];
}

/**
 * Thrown by {@link TaskStore.deleteTask} when the target task is still
 * referenced by at least one other live task's `dependencies` array.
 *
 * Callers that intend to split a task into children (e.g. triage, the
 * dashboard subtask-breakdown endpoint) must rewrite or drop those
 * references *before* deleting the parent — otherwise the dependents
 * would be permanently blocked by a nonexistent id.
 */

export type TaskDependencyMutation =
  | { operation: "add"; dependency: string }
  | { operation: "remove"; dependency: string }
  | { operation: "replace"; from: string; to: string }
  | { operation: "set"; dependencies: string[] };

export class TaskHasDependentsError extends Error {
  readonly taskId: string;
  readonly dependentIds: string[];

  constructor(taskId: string, dependentIds: string[]) {
    super(
      `Cannot delete task ${taskId}: still referenced as a dependency by ${dependentIds.join(", ")}. ` +
        `Rewrite or remove these dependencies before deleting.`,
    );
    this.name = "TaskHasDependentsError";
    this.taskId = taskId;
    this.dependentIds = dependentIds;
  }
}

export class TaskDeletedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly deletedAt: string,
  ) {
    super(`Task ${taskId} is soft-deleted (deletedAt=${deletedAt}) and cannot be read or mutated`);
    this.name = "TaskDeletedError";
  }
}

export class TombstonedTaskResurrectionError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly deletedAt: string,
    public readonly allowResurrection: boolean,
  ) {
    super(
      `Task ${taskId} is soft-deleted (deletedAt=${deletedAt}) and cannot be recreated without forceResurrect: true. `
      + `Operator unlock: allowResurrection=${allowResurrection}`,
    );
    this.name = "TombstonedTaskResurrectionError";
  }
}

export class TaskHasLineageChildrenError extends Error {
  readonly taskId: string;
  readonly childIds: string[];

  constructor(taskId: string, childIds: string[]) {
    super(
      `Cannot delete task ${taskId}: still referenced as a lineage parent by ${childIds.join(", ")}. ` +
        `Pass { removeLineageReferences: true } to clear these references before deleting.`,
    );
    this.name = "TaskHasLineageChildrenError";
    this.taskId = taskId;
    this.childIds = childIds;
  }
}

export class InvalidFileScopeError extends Error {
  readonly taskId: string;
  readonly invalidEntries: string[];

  constructor(taskId: string, invalidEntries: string[]) {
    super(
      `Invalid File Scope entries in PROMPT.md for ${taskId}: ${invalidEntries.join(", ")}. ` +
        "File Scope must contain repo-relative file paths or globs (e.g. `packages/core/src/store.ts`, `packages/engine/src/**/*.ts`), not git refs or identifiers.",
    );
    this.name = "InvalidFileScopeError";
    this.taskId = taskId;
    this.invalidEntries = invalidEntries;
  }
}

const KNOWN_FILE_SCOPE_ROOT_FILES = new Set([
  "makefile",
  "dockerfile",
  "justfile",
  "license",
  "readme",
  "changelog",
  "agents.md",
]);

// `parseStepHeadings` (the `### Step N:` parser, step-inversion U1) was extracted
// into `step-parsers.ts` as the `step-headings` built-in parser (U12, KTD-12).
// It is re-exported here for back-compat with callers/tests that import it from
// `store.ts`. `parseStepsFromPrompt` below delegates through the registry.
export { parseStepHeadings } from "./step-parsers.js";

export function isValidFileScopeEntry(token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith("origin/")
    || lower.startsWith("upstream/")
    || lower.startsWith("refs/")
    || /^https?:\/\//i.test(trimmed)
    || /^git@/i.test(trimmed)
    || /^ssh:\/\//i.test(trimmed)
    || /^[a-z]+\/fn-\d+$/i.test(trimmed)
    || /^[a-f0-9]{7,}$/i.test(trimmed)
    || trimmed.includes("..")
    || trimmed.startsWith("/")
  ) {
    return false;
  }

  const segments = trimmed.split("/");
  const lastSegment = segments[segments.length - 1];
  const hasSlash = trimmed.includes("/");
  const hasDotInLastSegment = lastSegment.includes(".");

  if (KNOWN_FILE_SCOPE_ROOT_FILES.has(lastSegment.toLowerCase())) {
    return true;
  }

  if (trimmed.includes("**") || trimmed.endsWith("/*") || (lastSegment.includes("*") && hasDotInLastSegment)) {
    return true;
  }

  if (hasSlash && hasDotInLastSegment) {
    return true;
  }

  return false;
}

function extractFileScopeTokens(content: string): string[] {
  const headingMatch = content.match(/^##\s+File\s+Scope\s*$/m);
  if (!headingMatch) return [];

  const startIdx = headingMatch.index! + headingMatch[0].length;
  const rest = content.slice(startIdx);
  const nextHeading = rest.search(/\n##?\s/);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const tokens: string[] = [];
  const backtickRegex = /`([^`]+)`/g;
  let match;
  while ((match = backtickRegex.exec(section)) !== null) {
    tokens.push(match[1]);
  }

  return tokens;
}

function validateFileScopeInPromptContent(prompt: string): { valid: string[]; invalid: string[] } {
  const tokens = extractFileScopeTokens(prompt);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    if (isValidFileScopeEntry(token)) {
      valid.push(token);
    } else {
      invalid.push(token);
    }
  }
  return { valid, invalid };
}

function sanitizeFileScopeInPromptContent(prompt: string): { sanitized: string; dropped: string[]; kept: string[] } {
  const headingMatch = prompt.match(/^##\s+File\s+Scope\s*$/m);
  if (!headingMatch) {
    return { sanitized: prompt, dropped: [], kept: [] };
  }

  const startIdx = headingMatch.index! + headingMatch[0].length;
  const rest = prompt.slice(startIdx);
  const nextHeading = rest.search(/\n##?\s/);
  const endIdx = nextHeading === -1 ? prompt.length : startIdx + nextHeading;
  const section = prompt.slice(startIdx, endIdx);
  const { valid: kept, invalid: dropped } = validateFileScopeInPromptContent(prompt);
  if (dropped.length === 0) {
    return { sanitized: prompt, dropped, kept };
  }

  const sanitizedSection = section
    .split("\n")
    .filter((line) => {
      const tokens = Array.from(line.matchAll(/`([^`]+)`/g), (match) => match[1]);
      if (tokens.length === 0) return true;
      return tokens.every((token) => isValidFileScopeEntry(token));
    })
    .join("\n");

  return {
    sanitized: `${prompt.slice(0, startIdx)}${sanitizedSection}${prompt.slice(endIdx)}`,
    dropped,
    kept,
  };
}

export const SELF_DEFEATING_OPERATION_VERBS = [
  "finalize", // Terminalize target task state
  "diagnose", // Investigate/diagnose target task failure
  "dispose", // Dispose terminal artifacts/state for target task
  "unblock", // Remove blockers on target task
  "manual recovery", // Explicit manual recovery operation
  "recover", // Recover target task from failed/stuck state
  "recovery", // Recovery operation on target task
  "resolve", // Resolve target task conflict/failure
  "archive", // Archive target task
  "reclaim", // Reclaim target task ownership/artifacts
  "clean", // Clean target task residual state
  "cleanup", // Cleanup operation on target task
  "fix", // Fix target task issue
] as const satisfies ReadonlyArray<string>;

export class SelfDefeatingDependencyError extends Error {
  readonly code = "SELF_DEFEATING_DEPENDENCY" as const;

  constructor(
    readonly taskTitle: string,
    readonly matchedVerb: string,
    readonly operandTaskId: string,
  ) {
    super(`Task "${taskTitle}" operates on ${operandTaskId} (matched verb: "${matchedVerb}") and cannot also depend on it. A task whose job is to mutate another task into a terminal state must not be blocked by that task.`);
    this.name = "SelfDefeatingDependencyError";
  }
}

export function detectSelfDefeatingDependency(
  title: string | undefined,
  dependencies: readonly string[],
): { matchedVerb: string; operandTaskId: string } | null {
  const trimmedTitle = title?.trim();
  if (!trimmedTitle) return null;

  const normalizedDeps = new Set(
    dependencies
      .map((dep) => dep.trim().toUpperCase())
      .filter((dep) => /^FN-\d+$/i.test(dep)),
  );
  if (normalizedDeps.size === 0) return null;

  const titleFnIds = [...trimmedTitle.matchAll(/\bFN-(\d+)\b/gi)];
  if (titleFnIds.length !== 1) return null;
  const operandTaskId = `FN-${titleFnIds[0][1]}`;

  let matchedVerb: string | null = null;
  for (const verb of SELF_DEFEATING_OPERATION_VERBS) {
    if (verb === "manual recovery") {
      if (/\bmanual\s+recovery\b/i.test(trimmedTitle)) {
        matchedVerb = verb;
        break;
      }
      continue;
    }

    const escapedVerb = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escapedVerb}\\b`, "i").test(trimmedTitle)) {
      matchedVerb = verb;
      break;
    }
  }

  if (!matchedVerb) return null;
  if (!normalizedDeps.has(operandTaskId.toUpperCase())) return null;

  return {
    matchedVerb,
    operandTaskId,
  };
}

export class DependencyCycleError extends Error {
  readonly code = "DEPENDENCY_CYCLE" as const;

  constructor(
    readonly taskId: string,
    readonly cyclePath: readonly string[],
  ) {
    super(`Dependency cycle detected for ${taskId}: ${cyclePath.join(" → ")}`);
    this.name = "DependencyCycleError";
  }
}

export function detectDependencyCycle(
  candidateTaskId: string,
  candidateDependencies: readonly string[],
  lookupDependencies: (taskId: string) => readonly string[] | undefined,
): string[] | null {
  const visited = new Set<string>();

  for (const dep of candidateDependencies) {
    if (dep === candidateTaskId) {
      return [candidateTaskId, candidateTaskId];
    }

    const initialDeps = lookupDependencies(dep);
    if (!initialDeps) continue;

    const stack: Array<{ taskId: string; deps: readonly string[]; index: number }> = [
      { taskId: dep, deps: initialDeps, index: 0 },
    ];
    const path = [candidateTaskId, dep];

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.index >= top.deps.length) {
        stack.pop();
        path.pop();
        continue;
      }

      const next = top.deps[top.index++]!;
      if (next === candidateTaskId) {
        return [...path, candidateTaskId];
      }

      if (visited.has(next)) {
        continue;
      }

      const nextDeps = lookupDependencies(next);
      if (!nextDeps) {
        visited.add(next);
        continue;
      }

      visited.add(next);
      stack.push({ taskId: next, deps: nextDeps, index: 0 });
      path.push(next);
    }
  }

  return null;
}

export class MergeQueueTaskNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`Cannot enqueue merge queue entry for missing task ${taskId}`);
    this.name = "MergeQueueTaskNotFoundError";
  }
}

export class MergeQueueInvalidColumnError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly column: Column,
  ) {
    super(`Cannot enqueue merge queue entry for task ${taskId} in column ${column}; only in-review is allowed`);
    this.name = "MergeQueueInvalidColumnError";
  }
}

export class MergeQueueLeaseOwnershipError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly workerId: string,
    public readonly currentOwner: string | null,
  ) {
    super(
      currentOwner
        ? `Worker ${workerId} does not own merge queue lease for ${taskId}; current owner is ${currentOwner}`
        : `Worker ${workerId} cannot release merge queue lease for ${taskId}; the entry is not currently leased`,
    );
    this.name = "MergeQueueLeaseOwnershipError";
  }
}

export class InvalidMergeQueueLeaseDurationError extends Error {
  constructor(public readonly leaseDurationMs: number) {
    super(`merge queue leaseDurationMs must be > 0 (received ${leaseDurationMs})`);
    this.name = "InvalidMergeQueueLeaseDurationError";
  }
}

export class HandoffInvariantViolationError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly fromColumn: ColumnId,
    message: string,
  ) {
    super(message);
    this.name = "HandoffInvariantViolationError";
  }
}

/**
 * Thrown by the flag-ON (`workflowColumns`) `moveTaskInternal` path when a move
 * is rejected, carrying the typed {@link TransitionRejection} (KTD-3/R13). The
 * existing callers of `moveTask` catch thrown `Error`s (e.g. the dashboard move
 * route inspects `err.message`), so the rejection rides on an `Error` subclass
 * — `.message` reproduces the legacy human-readable string so flag-ON callers
 * that only read the message keep working, while `.rejection` exposes the
 * machine-stable code/messageKey/retryable for surfaces that want it.
 *
 * The FLAG-OFF path still throws the bare legacy `Error` strings unchanged
 * (zero behavior change while the flag is off — proven by the characterization
 * suite).
 */
export class TransitionRejectionError extends Error {
  readonly rejection: TransitionRejection;
  constructor(rejection: TransitionRejection, message: string) {
    super(message);
    this.name = "TransitionRejectionError";
    this.rejection = rejection;
  }
}

interface MoveTaskOptions {
  preserveResumeState?: boolean;
  preserveProgress?: boolean;
  preserveWorktree?: boolean;
  preserveStatus?: boolean;
  allocateWorktree?: (reservedNames: Set<string>) => string | null;
  moveSource?: "user" | "engine" | "scheduler";
  workflowMoveActor?: WorkflowMovePolicyInput["actor"];
  workflowMoveSource?: string;
  workflowMoveMetadata?: Record<string, unknown>;
  skipMergeBlocker?: boolean;
  allowDirectInReviewMove?: boolean;
  /**
   * KTD-9: engine/recovery moves bypass trait guards and abort-on-exit effects
   * (the generalization of `skipMergeBlocker`). It NEVER bypasses capacity
   * (KTD-10). Engine-internal only: HTTP move endpoints hardcode it off and must
   * never forward a caller-supplied value (mirrors the hardcoded
   * `moveSource: "user"` posture). When unset, the flag-ON path derives it from
   * `moveSource === "engine"` plus `skipMergeBlocker`.
   */
  bypassGuards?: boolean;
  /**
   * U5 (R15/R20): a workflow-reconciliation re-home move (switch/edit/delete).
   * Unlike `bypassGuards` (which skips trait guards but still enforces the
   * column-graph adjacency, so the U4 parity matrix is unaffected), a recovery
   * re-home must reach the new workflow's entry column from ANY current column —
   * a card that would otherwise be stranded in a column its (new) workflow does
   * not define. So this additionally skips the adjacency check (step 2). The
   * structural unknown-column check (step 1) and the in-txn capacity check
   * (KTD-10) still apply. Engine-internal only: never forwarded from an HTTP
   * endpoint. When set, implies `bypassGuards`.
   */
  recoveryRehome?: boolean;
}

interface MoveTaskInternalOptions {
  fromHandoff: boolean;
  runContext?: Pick<RunMutationContext, "runId" | "agentId"> | { runId?: string; agentId?: string };
  ownerAgentId?: string | null;
  evidence?: HandoffToReviewOptions["evidence"];
  now?: string;
  movePolicyPreflight?: {
    fromColumn: string;
    toColumn: string;
    workflowSignature: string;
  };
}

const WORKFLOW_MOVE_POLICY_TIMEOUT_MS = 5000;

export interface LegacyAutoMergeStampReconcileResult {
  taskId: string;
  column: string;
  cleared: boolean;
}

const LEGACY_AUTO_MERGE_STAMP_MARKER_KEY = "legacyAutoMergeStampMarkedVersion";
const LEGACY_AUTO_MERGE_STAMP_MARKER_VERSION = "1";

export class TaskStore extends EventEmitter<TaskStoreEvents> {
  private static readonly ACTIVE_TASKS_WHERE = '"deletedAt" IS NULL';
  /** U6: sentinel effective-workflow id for default-workflow (null-selection)
   *  tasks, so they all share one per-column capacity pool (KTD-10). It is not a
   *  real workflow row id (no `builtin:`/custom collision possible). Re-exposed
   *  as a static member for internal call sites; the canonical const lives in
   *  `workflow-capacity.ts` (`DEFAULT_WORKFLOW_POOL_ID`). */
  private static readonly DEFAULT_WORKFLOW_POOL_ID = DEFAULT_WORKFLOW_POOL_ID;

  static async getOrCreateForProject(
    projectId?: string,
    centralCore?: CentralCore,
    globalSettingsDir?: string,
  ): Promise<TaskStore> {
    const central = centralCore ?? new CentralCore();
    let initializedHere = false;

    if (!centralCore) {
      await central.init();
      initializedHere = true;
    }

    try {
      const compat = new BackwardCompat(central);
      const context = await compat.resolveProjectContext(process.cwd(), projectId);
      const resolvedGlobalSettingsDir = globalSettingsDir
        ?? (process.env.VITEST === "true"
          ? join(context.workingDirectory, ".fusion-global-settings")
          : undefined);
      const store = new TaskStore(context.workingDirectory, resolvedGlobalSettingsDir);
      await store.init();
      return store;
    } catch (error) {
      if (error instanceof ProjectRequiredError) {
        if (projectId) {
          throw new Error(`Project "${projectId}" not found`);
        }
        throw new Error(error.message);
      }
      throw error;
    } finally {
      if (initializedHere) {
        await central.close();
      }
    }
  }

  /**
   * Hybrid storage note: task metadata lives in SQLite, while blob files remain on disk.
   * Any write to `.fusion/tasks/{id}` must recreate the directory on demand, and any read from
   * optional blob files must tolerate missing files/directories because cleanup, migration,
   * or manual filesystem changes can remove them independently of the database row.
   */
  private fusionDir: string;
  private tasksDir: string;
  private configPath: string;
  /** SQLite database for structured data storage */
  private _db: Database | null = null;
  private activityListenersWired = false;
  /**
   * When true, the activity-log listeners skip recording. Set by the polling
   * loop (`checkForChanges`) so that events re-emitted after observing another
   * TaskStore instance's DB write don't double- or triple-log to activityLog.
   * The in-process emit path (moveTask, updateTask, etc.) leaves this false
   * and remains the sole source of truth for activity rows.
   */
  private suppressActivityLogForPollingEmit = false;
  /** Separate SQLite database for compact archived task snapshots. */
  private _archiveDb: ArchiveDatabase | null = null;

  /** File-system watcher instance */
  private watcher: FSWatcher | null = null;
  /** In-memory cache of tasks for diffing watcher events */
  private taskCache: Map<string, Task> = new Map();
  /**
   * U8 (KTD-2): pre-evaluated plugin gate verdicts, keyed `taskId` → `toColumn`
   * → recorded verdicts (one per plugin gate trait). A plugin gate is evaluated
   * OUTSIDE the lock by the engine's trait adapter; the verdict is recorded here
   * and re-checked cheaply in-lock at move time so plugin code never blocks or
   * wedges the task lock. Kept in-memory (minimal/surgical per U8); the
   * `plugin-gate-verdict.ts` seam can later back this with SQLite.
   */
  private pluginGateVerdicts: Map<string, Map<string, PluginGateVerdict[]>> = new Map();
  /** Paths recently written by in-process mutations (suppresses duplicate events) */
  private recentlyWritten: Set<string> = new Set();
  /** Pending debounce timers keyed by task ID */
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Debounce interval in ms */
  private debounceMs = 150;
  /** Per-task promise chain for serializing writes */
  private taskLocks: Map<string, Promise<void>> = new Map();
  private closing = false;
  private deferredTaskCreatedWork = new Set<Promise<void>>();
  /**
   * FNXC:CoreTests 2026-06-20-05:17:
   * Core loaded-suite teardown may remove a per-test project root while createTask's deferred title summarization or task-created hook is still writing task.json. Track only the post-summarization write/hook phase so close() can quiesce active filesystem mutations without hanging on intentionally stalled summarizer prompts.
   */
  private trackDeferredTaskCreatedWork(work: () => Promise<void>): Promise<void> {
    if (this.closing) return Promise.resolve();
    const promise = (async () => {
      if (this.closing) return;
      await work();
    })();
    this.deferredTaskCreatedWork.add(promise);
    return promise.finally(() => {
      this.deferredTaskCreatedWork.delete(promise);
    });
  }
  /**
   * Cross-task lock for worktree path allocation. Serializes the
   * read-tasks → pick-name → write-task sequence so two concurrent
   * `moveTask` calls (or a moveTask vs. a scheduler dispatch) cannot
   * pick the same name from a stale snapshot.
   */
  private worktreeAllocationLock: Promise<void> = Promise.resolve();
  /** Promise chain for serializing config.json read-modify-write cycles */
  private configLock: Promise<void> = Promise.resolve();
  /** Startup/open guard for distributed_task_id_state reconciliation. */
  private taskIdStateReconciled = false;
  /** Set when startup auto-recovery rebuilt a corrupt fusion.db; lets the orphan reconcile bypass its recency window so rows dropped by `.recover` are recovered even with old task.json mtimes. */
  private dbWasCorruptionRecovered = false;
  /** Cached startup/refresh integrity report for allocator-related task ID anomalies. */
  private taskIdIntegrityReport: TaskIdIntegrityReport = {
    status: "ok",
    checkedAt: new Date().toISOString(),
    anomalies: [],
  };
  /** Prevent duplicate anomaly logs when the report content has not changed. */
  private lastTaskIdIntegrityLogSignature: string | null = null;
  /** Cached workflow steps — invalidated on create/update/delete */
  private workflowStepsCache: import("./types.js").WorkflowStep[] | null = null;
  private workflowDefinitionsCache: WorkflowDefinition[] | null = null;
  /** Plugin-contributed workflow step templates injected by engine runtime. */
  private _pluginWorkflowStepTemplates: Array<{ pluginId: string; template: WorkflowStepTemplate }> = [];
  /** Global settings store (`~/.fusion/settings.json`) */
  private globalSettingsStore: GlobalSettingsStore;
  /** Polling interval for change detection */
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  /** Guard flag to prevent overlapping poll cycles */
  private pollingInProgress = false;
  /** Last known modification timestamp for change detection */
  private lastKnownModified: number = 0;
  /** ISO timestamp of last poll — used to filter changed tasks */
  private lastPollTime: string | null = null;
  /** One-shot startup sweep flag for clearing stale pause fields on done tasks. */
  private donePauseBackfillDone = false;
  /** Short-lived startup memo for repeated slim listTasks reads before steady-state watch/polling. */
  private startupSlimListMemo = new Map<string, { expiresAt: number; promise: Promise<Task[]> }>();
  private static readonly STARTUP_SLIM_LIST_MEMO_TTL_MS = 2_500;

  /** Whether the store is actively watching for changes (watcher or polling). */
  private get isWatching(): boolean {
    return this.watcher !== null || this.pollInterval !== null;
  }
  /** Cached MissionStore instance */
  private missionStore: MissionStore | null = null;
  /** Cached PluginStore instance */
  private pluginStore: PluginStore | null = null;
  /** Cached InsightStore instance */
  private insightStore: InsightStore | null = null;
  /** Cached ResearchStore instance */
  private researchStore: ResearchStore | null = null;
  /** Cached ExperimentSessionStore instance */
  private experimentSessionStore: ExperimentSessionStore | null = null;
  /** Cached TodoStore instance */
  private todoStore: TodoStore | null = null;
  /** Cached GoalStore instance */
  private goalStore: GoalStore | null = null;
  /** Cached EvalStore instance */
  private evalStore: EvalStore | null = null;
  /** Cached SecretsStore instance */
  private secretsStore: SecretsStore | null = null;
  /** Cached central connection for SecretsStore global scope access */
  private secretsCentralCore: CentralCore | null = null;
  /** Cached distributed task-id allocator instance. */
  private distributedTaskIdAllocator: DistributedTaskIdAllocator | null = null;

  /** Buffer for batching agent log writes to reduce WAL pressure. */
  private agentLogBuffer: Array<{
    taskId: string;
    timestamp: string;
    text: string;
    type: AgentLogEntry["type"];
    detail: string | null;
    agent: AgentLogEntry["agent"] | null;
  }> = [];
  /** Timer for flushing the agent log buffer. */
  private agentLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Maximum buffer size before forced flush. */
  private static readonly AGENT_LOG_BUFFER_SIZE = 50;
  /** Flush interval in milliseconds. */
  private static readonly AGENT_LOG_FLUSH_MS = 2000;
  /** Absolute backlog cap — oldest entries are dropped when flushes keep failing. */
  private static readonly MAX_AGENT_LOG_BACKLOG = 5_000;

  // Test-only: when true, both fusion.db and archive.db open as `:memory:`
  // SQLite connections instead of disk-backed files. Production code never
  // sets this; it's gated through an opt-in TaskStoreOptions field below.
  // Tests that need cross-instance persistence (open store A, close,
  // open store B on the same dir, expect data) must leave this false.
  private readonly inMemoryDb: boolean;
  private readonly globalSettingsDir?: string;

  constructor(
    private rootDir: string,
    globalSettingsDir?: string,
    options?: { inMemoryDb?: boolean },
  ) {
    super();
    this.setMaxListeners(100);
    assertProjectRootDir(rootDir, "TaskStore");
    assertNotLinkedWorktreeOfExistingProject(rootDir, "TaskStore");
    this.fusionDir = join(rootDir, ".fusion");
    this.tasksDir = join(this.fusionDir, "tasks");
    this.configPath = join(this.fusionDir, "config.json");
    this.inMemoryDb = options?.inMemoryDb === true;
    const resolvedGlobalSettingsDir = globalSettingsDir
      ?? (process.env.VITEST === "true" ? join(rootDir, ".fusion-global-settings") : undefined);
    this.globalSettingsDir = resolvedGlobalSettingsDir;
    this.globalSettingsStore = new GlobalSettingsStore(resolvedGlobalSettingsDir);
  }

  private emitTaskLifecycleEventSafely(
    event: "task:created" | "task:updated",
    args: TaskStoreEvents["task:created"] | TaskStoreEvents["task:updated"],
  ): boolean {
    const listeners = super.listeners(event) as Array<(...listenerArgs: typeof args) => unknown>;
    if (listeners.length === 0) {
      return false;
    }

    const [task] = args;
    const taskId = task && typeof task === "object" && "id" in task ? String(task.id) : "unknown";

    for (const listener of listeners) {
      try {
        const result = listener(...args);
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(result).catch((error) => {
            storeLog.warn(`[${event}] listener failed for ${taskId}: ${getErrorMessage(error)}`);
          });
        }
      } catch (error) {
        storeLog.warn(`[${event}] listener failed for ${taskId}: ${getErrorMessage(error)}`);
      }
    }

    return true;
  }

  /**
   * Get the SQLite database, initializing it on first access.
   * Also performs auto-migration from legacy file-based storage if needed.
   */
  private get db(): Database {
    if (!this._db) {
      const db = new Database(this.fusionDir, { inMemory: this.inMemoryDb });
      try {
        db.init();
      } catch (error) {
        db.close();
        throw error;
      }
      this._db = db;
      this.reconcileDistributedTaskIdStateOnOpen();
      // Auto-migrate legacy data if needed
      if (detectLegacyData(this.fusionDir)) {
        // Note: migrateFromLegacy is async but we need sync access.
        // The init() method handles async migration. This getter
        // just ensures the DB is available for synchronous operations.
      }
    }
    return this._db;
  }

  private get archiveDb(): ArchiveDatabase {
    if (!this._archiveDb) {
      const db = new ArchiveDatabase(this.fusionDir, { inMemory: this.inMemoryDb });
      try {
        db.init();
      } catch (error) {
        db.close();
        throw error;
      }
      this._archiveDb = db;
      this.migrateLegacyArchiveEntriesToArchiveDb();
    }
    return this._archiveDb;
  }

  private buildTaskIdIntegrityFallbackReport(): TaskIdIntegrityReport {
    return {
      status: "ok",
      checkedAt: new Date().toISOString(),
      anomalies: [],
    };
  }

  private detectAndCacheTaskIdIntegrityReport(): TaskIdIntegrityReport {
    const report = detectTaskIdIntegrityAnomalies(this.db);
    this.taskIdIntegrityReport = report;
    const signature = report.status === "anomaly" ? JSON.stringify(report.anomalies) : null;
    if (report.status === "anomaly" && signature !== this.lastTaskIdIntegrityLogSignature) {
      coreLog.error("[task-id-integrity] anomaly detected", { anomalies: report.anomalies });
    }
    this.lastTaskIdIntegrityLogSignature = signature;
    return report;
  }

  private mergeTaskIdIntegrityReports(...reports: TaskIdIntegrityReport[]): TaskIdIntegrityReport {
    const checkedAt = reports[reports.length - 1]?.checkedAt ?? new Date().toISOString();
    const seen = new Set<string>();
    const anomalies = reports.flatMap((report) => report.anomalies).filter((anomaly) => {
      const key = JSON.stringify(anomaly);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    return {
      status: anomalies.length > 0 ? "anomaly" : "ok",
      checkedAt,
      anomalies,
    };
  }

  refreshTaskIdIntegrityReport(): TaskIdIntegrityReport {
    try {
      return this.detectAndCacheTaskIdIntegrityReport();
    } catch (error) {
      const fallback = this.buildTaskIdIntegrityFallbackReport();
      this.taskIdIntegrityReport = fallback;
      this.lastTaskIdIntegrityLogSignature = null;
      coreLog.warn("[task-id-integrity] detector failed; degrading to healthy report", {
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  getTaskIdIntegrityReport(): TaskIdIntegrityReport {
    return this.taskIdIntegrityReport;
  }

  private reconcileDistributedTaskIdStateOnOpen(): void {
    if (this.taskIdStateReconciled) {
      return;
    }
    const previousReport = this.taskIdIntegrityReport;
    const preReconcileReport = this.refreshTaskIdIntegrityReport();
    reconcileTaskIdState(this.db);
    const postReconcileReport = this.refreshTaskIdIntegrityReport();
    this.taskIdIntegrityReport = this.mergeTaskIdIntegrityReports(
      previousReport,
      preReconcileReport,
      postReconcileReport,
    );
    this.taskIdStateReconciled = true;
  }

  async init(): Promise<void> {
    this.closing = false;
    await mkdir(this.tasksDir, { recursive: true });

    // U4: register the default-workflow trait hook implementations into the
    // shared trait registry (the flag-ON moveTaskInternal path resolves the
    // legacy per-column effects through these). Idempotent; built-in trait
    // DEFINITIONS self-register on import of ./builtin-traits.js (pulled in
    // transitively via default-workflow-hooks / trait-registry).
    registerDefaultWorkflowHooks();

    // Initialize SQLite database
    if (!this._db) {
      // Startup corruption guard: before opening, detect a malformed fusion.db
      // (a node:sqlite SIGSEGV mid-write can leave the B-tree corrupt in a way
      // that still opens) and rebuild it via sqlite3 .recover, preserving the
      // corrupt original. Disk-backed only; opt out with FUSION_DISABLE_DB_AUTORECOVER.
      if (!this.inMemoryDb && process.env.FUSION_DISABLE_DB_AUTORECOVER !== "1") {
        try {
          const recovery = Database.recoverIfCorrupt(this.fusionDir);
          if (recovery.status === "recovered") {
            // A `.recover` rebuild can drop task rows whose task.json survived on disk. Let the
            // orphan reconcile below bypass its recency window so those rows are recovered even
            // when their (possibly old) task.json mtime would otherwise fail the gate.
            this.dbWasCorruptionRecovered = true;
            storeLog.warn("Recovered corrupt fusion.db on startup", {
              phase: "init:db-autorecover",
              corruptBackupPath: recovery.corruptBackupPath,
              errors: recovery.errors?.slice(0, 5),
            });
          } else if (recovery.status === "failed") {
            storeLog.error("fusion.db is corrupt and automatic recovery failed", {
              phase: "init:db-autorecover",
              errors: recovery.errors?.slice(0, 5),
            });
          }
        } catch (error) {
          storeLog.warn("Startup db corruption guard threw — continuing to open", {
            phase: "init:db-autorecover",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const db = new Database(this.fusionDir, { inMemory: this.inMemoryDb });
      try {
        db.init();
      } catch (error) {
        db.close();
        throw error;
      }
      this._db = db;
    }

    this.reconcileDistributedTaskIdStateOnOpen();
    
    // Auto-migrate from legacy file-based storage
    if (detectLegacyData(this.fusionDir)) {
      await migrateFromLegacy(this.fusionDir, this._db);
    }
    await this.migrateActiveArchivedTasksToArchiveDb();
    await this.migrateAgentLogEntriesToFilesOnce();
    await this.cleanupNoOpTaskMovedActivityRowsOnce();
    try {
      await this.markLegacyAutoMergeStampsOnce();
    } catch (err) {
      storeLog.warn("Legacy auto-merge stamp marker failed during init (non-fatal)", {
        phase: "init:legacy-auto-merge-stamp-marker",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // U4: one-time per-project hard-move of MOVED_SETTINGS_KEYS into workflow
    // setting values (marker-gated, idempotent, never blocks startup).
    try {
      await this.migrateMovedSettingsToWorkflowValuesOnce();
    } catch (err) {
      storeLog.warn("Settings hard-move migration failed during init (non-fatal)", {
        phase: "init:settings-hard-move",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Re-run init when migrations are pending, or when the deferred
    // agentLogEntries drop still needs to fire: migration 102 skips the
    // destructive drop until migrateAgentLogEntriesToFilesOnce() above writes
    // the __meta guard, but migrations 103+ bump the schema version past 102
    // on the first pass, so the version check alone no longer triggers the
    // second pass that performs the drop.
    const legacyAgentLogTableRemains =
      this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agentLogEntries' LIMIT 1")
        .get() !== undefined;
    if (this.db.getSchemaVersion() < SCHEMA_VERSION || legacyAgentLogTableRemains) {
      this.db.init();
    }
    await this.importLegacyAgentLogsOnce();
    this.taskIdStateReconciled = false;
    this.reconcileDistributedTaskIdStateOnOpen();
    try {
      await this.reconcileOrphanedTaskDirs({ ignoreRecencyWindow: this.dbWasCorruptionRecovered });
    } catch (err) {
      storeLog.warn("Orphaned task-dir reconcile failed during init (non-fatal)", {
        phase: "init:orphaned-task-dir-reconcile",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Write config.json for backward compatibility if it doesn't exist
    if (!existsSync(this.configPath)) {
      const config = await this.readConfig();
      try {
        await writeFile(this.configPath, this.serializeConfigForDisk(config));
      } catch (err) {
        storeLog.warn("Backward-compat config.json sync failed during init", {
          phase: "init:config-sync",
          configPath: this.configPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    
    this.setupActivityLogListeners();

    // Bootstrap project memory file if memory is enabled
    try {
      const config = await this.readConfig();
      const mergedSettings: Settings = { ...DEFAULT_SETTINGS, ...config.settings };
      if (mergedSettings.memoryEnabled !== false) {
        // Use backend-aware bootstrap to honor memoryBackendType setting
        await ensureMemoryFileWithBackend(this.rootDir, mergedSettings);
      }
    } catch (err) {
      // Non-fatal — memory bootstrap failure should not block startup
      storeLog.warn("Project-memory bootstrap failed during init", {
        phase: "init:memory-bootstrap",
        rootDir: this.rootDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // U12: workflow-columns integrity pass. When the flag is ON, audit + re-home
    // any task whose stored column is no longer valid in its resolved workflow
    // (KTD-1 guarantees zero rewrites for healthy legacy rows, so this is a
    // no-op for the common case). Idempotent; non-fatal — never blocks startup.
    try {
      const settings = await this.getSettingsFast();
      if (isWorkflowColumnsCompatibilityFlagEnabled(settings)) {
        await this.runWorkflowColumnsIntegrityPass();
        // #1401: recover any transitionPending markers stranded by a crash
        // between the in-txn write and the post-commit clear (they otherwise
        // permanently inflate capacity counts for their target column).
        await this.recoverStaleTransitionPending();
      } else {
        // #1409: flag-OFF init — evacuate any card stuck in a non-legacy column
        // (e.g. the flag was toggled OFF out-of-process while a card sat in a
        // custom column) so the board stays listable and moves work.
        await this.evacuateCustomColumnsToLegacy("flag-off-init");
      }
    } catch (err) {
      storeLog.warn("workflowColumns integrity pass failed during init", {
        phase: "init:workflow-columns-integrity",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Row <-> Task Conversion ────────────────────────────────────────

  /**
   * Convert a database row to a Task object, parsing JSON columns.
   */
  private rowToTask(row: TaskRow): Task {
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
      mergeRetries: row.mergeRetries ?? undefined,
      workflowStepRetries: row.workflowStepRetries ?? undefined,
      stuckKillCount: row.stuckKillCount ?? undefined,
      resumeLimboCount: row.resumeLimboCount ?? undefined,
      graphResumeRetryCount: row.graphResumeRetryCount ?? undefined,
      resumeLimboTipSha: row.resumeLimboTipSha || undefined,
      resumeLimboStepSignature: row.resumeLimboStepSignature || undefined,
      postReviewFixCount: row.postReviewFixCount ?? undefined,
      recoveryRetryCount: row.recoveryRetryCount ?? undefined,
      taskDoneRetryCount: row.taskDoneRetryCount ?? undefined,
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
      executionMode: (row.executionMode || undefined) as Task["executionMode"],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      columnMovedAt: row.columnMovedAt || undefined,
      firstExecutionAt: row.firstExecutionAt || undefined,
      cumulativeActiveMs: row.cumulativeActiveMs ?? undefined,
      executionStartedAt: row.executionStartedAt || undefined,
      executionCompletedAt: row.executionCompletedAt || undefined,
      dependencies: fromJson<string[]>(row.dependencies) || [],
      steps: fromJson<import("./types.js").TaskStep[]>(row.steps) || [],
      customFields: fromJson<Record<string, unknown>>(row.customFields) ?? undefined,
      log: fromJson<import("./types.js").TaskLogEntry[]>(row.log) || [],
      tokenBudgetSoftAlertedAt: row.tokenBudgetSoftAlertedAt || undefined,
      tokenBudgetHardAlertedAt: row.tokenBudgetHardAlertedAt || undefined,
      tokenBudgetOverride: fromJson<import("./types.js").TaskTokenBudgetOverride>(row.tokenBudgetOverride) ?? undefined,
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
          perModel: fromJson<import("./types.js").TaskTokenUsagePerModel[]>(row.tokenUsagePerModel) ?? undefined,
        };
      })(),
      attachments: (() => { const a = fromJson<TaskAttachment[]>(row.attachments); return a && a.length > 0 ? a : undefined; })(),
      steeringComments: (() => {
        const sc = fromJson<import("./types.js").SteeringComment[]>(row.steeringComments);
        return sc && sc.length > 0 ? sc : undefined;
      })(),
      comments: (() => {
        // Comments column already contains steering comments (addSteeringComment calls addComment).
        // Do NOT merge steeringComments here — that caused duplication on every read-write cycle.
        const c = fromJson<import("./types.js").TaskComment[]>(row.comments) || [];
        // Deduplicate by id to recover from prior corruption
        const seen = new Set<string>();
        const deduped = c.filter(entry => {
          if (seen.has(entry.id)) return false;
          seen.add(entry.id);
          return true;
        });
        return deduped.length > 0 ? deduped : undefined;
      })(),
      review: fromJson<import("./types.js").TaskReview>(row.review) ?? undefined,
      reviewState: normalizeTaskReviewState(fromJson<import("./types.js").TaskReviewState>(row.reviewState) ?? undefined),
      workflowStepResults: (() => { const w = fromJson<import("./types.js").WorkflowStepResult[]>(row.workflowStepResults); return w && w.length > 0 ? w : undefined; })(),
      prInfo: fromJson<import("./types.js").PrInfo>(row.prInfo),
      prInfos: (() => {
        const multi = fromJson<import("./types.js").PrInfo[]>(row.prInfos);
        if (multi && multi.length > 0) return multi;
        const single = fromJson<import("./types.js").PrInfo>(row.prInfo);
        return single ? [single] : undefined;
      })(),
      issueInfo: fromJson<import("./types.js").IssueInfo>(row.issueInfo),
      githubTracking: fromJson<import("./types.js").TaskGithubTracking>(row.githubTracking) ?? undefined,
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
      mergeDetails: fromJson<import("./types.js").MergeDetails>(row.mergeDetails),
      breakIntoSubtasks: row.breakIntoSubtasks ? true : undefined,
      noCommitsExpected: row.noCommitsExpected ? true : undefined,
      enabledWorkflowSteps: (() => { const e = fromJson<string[]>(row.enabledWorkflowSteps); return e && e.length > 0 ? e : undefined; })(),
      modifiedFiles: (() => { const m = fromJson<string[]>(row.modifiedFiles); return m && m.length > 0 ? m : undefined; })(),
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

  private rowToBranchGroup(row: BranchGroupRow): BranchGroup {
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

  private generateBranchGroupId(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `BG-${timestamp}-${random}`;
  }

  private archiveEntryToTask(entry: ArchivedTaskEntry, slim = false): Task {
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
      sourceIssue: slim ? undefined : entry.sourceIssue,
      attachments: slim ? undefined : entry.attachments,
      comments: entry.comments,
      review: slim ? undefined : entry.review,
      log: slim ? [] : entry.log ?? [],
      timedExecutionMs: slim ? this.computeTimedExecutionMs(entry.log) : undefined,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      columnMovedAt: entry.columnMovedAt,
      firstExecutionAt: entry.firstExecutionAt,
      cumulativeActiveMs: entry.cumulativeActiveMs,
      executionStartedAt: entry.executionStartedAt,
      executionCompletedAt: entry.executionCompletedAt,
      modelPresetId: entry.modelPresetId,
      modelProvider: entry.modelProvider,
      modelId: entry.modelId,
      validatorModelProvider: entry.validatorModelProvider,
      validatorModelId: entry.validatorModelId,
      planningModelProvider: entry.planningModelProvider,
      planningModelId: entry.planningModelId,
      breakIntoSubtasks: entry.breakIntoSubtasks,
      noCommitsExpected: entry.noCommitsExpected,
      branchContext: entry.branchContext,
      autoMerge: entry.autoMerge,
      modifiedFiles: slim ? undefined : entry.modifiedFiles,
      missionId: entry.missionId,
      sliceId: entry.sliceId,
      assigneeUserId: entry.assigneeUserId,
    };
  }

  private summarizeAgentLog(entries: AgentLogEntry[], totalCount: number): string | undefined {
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

  private async readPromptForArchive(taskId: string): Promise<string | undefined> {
    const promptPath = join(this.taskDir(taskId), "PROMPT.md");
    if (!existsSync(promptPath)) {
      return undefined;
    }
    return readFile(promptPath, "utf-8");
  }

  private async buildArchivedAgentLogFields(
    taskId: string,
    mode: ArchiveAgentLogMode,
  ): Promise<Pick<ArchivedTaskEntry, "agentLogMode" | "agentLogSummary" | "agentLogSnapshot" | "agentLogFull">> {
    if (mode === "none") {
      return { agentLogMode: mode };
    }

    if (mode === "full") {
      const entries = await this.getAgentLogs(taskId);
      return {
        agentLogMode: mode,
        agentLogSummary: this.summarizeAgentLog(entries, entries.length),
        agentLogFull: entries,
      };
    }

    const [totalCount, snapshot] = await Promise.all([
      this.getAgentLogCount(taskId),
      this.getAgentLogs(taskId, { limit: ARCHIVE_AGENT_LOG_SNAPSHOT_LIMIT }),
    ]);
    return {
      agentLogMode: mode,
      agentLogSummary: this.summarizeAgentLog(snapshot, totalCount),
      agentLogSnapshot: snapshot,
    };
  }

  private async taskToArchiveEntry(task: Task, archivedAt: string): Promise<ArchivedTaskEntry> {
    const settings = await this.getSettingsFast();
    const agentLogMode = settings.archiveAgentLogMode ?? "compact";
    const [prompt, agentLogFields] = await Promise.all([
      this.readPromptForArchive(task.id),
      this.buildArchivedAgentLogFields(task.id, agentLogMode),
    ]);

    return {
      id: task.id,
      lineageId: task.lineageId || generateTaskLineageId(),
      title: task.title,
      description: task.description,
      priority: normalizeTaskPriority(task.priority),
      column: "archived",
      preArchiveColumn: task.preArchiveColumn,
      dependencies: task.dependencies,
      steps: task.steps,
      currentStep: task.currentStep,
      customFields: task.customFields,
      size: task.size,
      reviewLevel: task.reviewLevel,
      prInfo: task.prInfo,
      prInfos: task.prInfos,
      issueInfo: task.issueInfo,
      githubTracking: task.githubTracking,
      sourceIssue: task.sourceIssue,
      attachments: task.attachments,
      comments: task.comments,
      review: task.review,
      reviewState: task.reviewState,
      prompt,
      ...agentLogFields,
      log: [{ timestamp: archivedAt, action: "Task archived" }],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      columnMovedAt: task.columnMovedAt,
      firstExecutionAt: task.firstExecutionAt,
      cumulativeActiveMs: task.cumulativeActiveMs,
      executionStartedAt: task.executionStartedAt,
      executionCompletedAt: task.executionCompletedAt,
      archivedAt,
      modelPresetId: task.modelPresetId,
      modelProvider: task.modelProvider,
      modelId: task.modelId,
      validatorModelProvider: task.validatorModelProvider,
      validatorModelId: task.validatorModelId,
      planningModelProvider: task.planningModelProvider,
      planningModelId: task.planningModelId,
      breakIntoSubtasks: task.breakIntoSubtasks,
      noCommitsExpected: task.noCommitsExpected,
      baseBranch: task.baseBranch,
      branch: task.branch,
      branchContext: task.branchContext,
      autoMerge: task.autoMerge,
      baseCommitSha: task.baseCommitSha,
      mergeRetries: task.mergeRetries,
      error: task.error,
      modifiedFiles: task.modifiedFiles,
      missionId: task.missionId,
      sliceId: task.sliceId,
      assigneeUserId: task.assigneeUserId,
    };
  }

  /**
   * Convert a task_documents row to a TaskDocument object.
   */
  private rowToTaskDocument(row: TaskDocumentRow): TaskDocument {
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

  /**
   * Convert an artifacts row to an Artifact object.
   */
  private rowToArtifact(row: ArtifactRow): Artifact {
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

  /**
   * Convert a task_document_revisions row to a TaskDocumentRevision object.
   */
  private rowToTaskDocumentRevision(row: TaskDocumentRevisionRow): TaskDocumentRevision {
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

  private rowToGoalCitation(row: GoalCitationRow): GoalCitation {
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

  recordGoalCitations(inputs: GoalCitationInput[]): GoalCitation[] {
    if (inputs.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO goal_citations (goalId, agentId, taskId, surface, sourceRef, snippet, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);

    const inserted: GoalCitation[] = [];
    this.db.transaction(() => {
      for (const input of inputs) {
        const row = stmt.get(
          input.goalId,
          input.agentId,
          input.taskId ?? null,
          input.surface,
          input.sourceRef,
          input.snippet,
          input.timestamp ?? now,
        ) as GoalCitationRow | undefined;
        if (row) {
          inserted.push(this.rowToGoalCitation(row));
        }
      }
      if (inserted.length > 0) {
        this.db.bumpLastModified();
      }
    });

    return inserted;
  }

  listGoalCitations(filter: GoalCitationFilter = {}): GoalCitation[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.goalId) {
      clauses.push("goalId = ?");
      params.push(filter.goalId);
    }
    if (filter.agentId) {
      clauses.push("agentId = ?");
      params.push(filter.agentId);
    }
    if (filter.taskId) {
      clauses.push("taskId = ?");
      params.push(filter.taskId);
    }
    if (filter.surface) {
      clauses.push("surface = ?");
      params.push(filter.surface);
    }
    if (filter.startTime) {
      clauses.push("timestamp >= ?");
      params.push(filter.startTime);
    }
    if (filter.endTime) {
      clauses.push("timestamp <= ?");
      params.push(filter.endTime);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));

    const rows = this.db
      .prepare(
        `SELECT * FROM goal_citations ${where} ORDER BY timestamp DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as GoalCitationRow[];

    return rows.map((row) => this.rowToGoalCitation(row));
  }

  private scanAndRecordCitations(
    text: string,
    surface: GoalCitationSurface,
    sourceRef: string,
    agentId: string,
    taskId?: string,
    timestamp?: string,
  ): GoalCitationInput[] {
    const matches = extractGoalCitations(text);
    if (matches.length === 0) {
      return [];
    }

    return matches.map((match) => ({
      goalId: match.goalId,
      agentId,
      ...(taskId ? { taskId } : {}),
      surface,
      sourceRef,
      snippet: buildSnippet(text, match.index),
      ...(timestamp ? { timestamp } : {}),
    }));
  }

  private getTaskSelectClause(slim: boolean, tableAlias?: string): string {
    if (!slim) {
      return tableAlias ? `${tableAlias}.*` : "*";
    }

    const prefix = tableAlias ? `${tableAlias}.` : "";
    return [
      "id", "lineageId", "title", "description", "priority", "\"column\"", "status", "size", "reviewLevel", "currentStep",
      "worktree", "blockedBy", "overlapBlockedBy", "paused", "pausedReason", "userPaused", "baseBranch", "branch", "autoMerge", "autoMergeProvenance", "executionStartBranch", "baseCommitSha",
      "modelPresetId", "modelProvider", "modelId",
      "validatorModelProvider", "validatorModelId",
      "planningModelProvider", "planningModelId",
      "mergeRetries", "workflowStepRetries", "stuckKillCount", "resumeLimboCount", "graphResumeRetryCount", "resumeLimboTipSha", "resumeLimboStepSignature", "postReviewFixCount", "recoveryRetryCount", "taskDoneRetryCount", "worktreeSessionRetryCount", "completionHandoffLimboRecoveryCount", "verificationFailureCount", "mergeConflictBounceCount", "mergeAuditBounceCount", "mergeTransientRetryCount", "branchConflictRecoveryCount", "reviewerContextRetryCount", "reviewerFallbackRetryCount", "nextRecoveryAt",
      "error", "summary", "thinkingLevel", "executionMode",
      "tokenUsageInputTokens", "tokenUsageOutputTokens", "tokenUsageCachedTokens", "tokenUsageCacheWriteTokens", "tokenUsageTotalTokens", "tokenUsageFirstUsedAt", "tokenUsageLastUsedAt", "tokenUsageModelProvider", "tokenUsageModelId", "tokenUsagePerModel", "tokenBudgetSoftAlertedAt", "tokenBudgetHardAlertedAt", "tokenBudgetOverride",
      "createdAt", "updatedAt", "columnMovedAt", "firstExecutionAt", "cumulativeActiveMs", "executionStartedAt", "executionCompletedAt",
      "dependencies", "steps", "customFields", "comments", "review", "reviewState", "workflowStepResults", "steeringComments",
      "attachments", "prInfo", "prInfos", "issueInfo", "githubTracking", "sourceIssueProvider", "sourceIssueRepository", "sourceIssueExternalIssueId", "sourceIssueNumber", "sourceIssueUrl", "sourceIssueClosedAt", "mergeDetails",
      "breakIntoSubtasks", "noCommitsExpected", "enabledWorkflowSteps", "modifiedFiles",
      "missionId", "sliceId", "scopeOverride", "scopeOverrideReason", "scopeAutoWiden", "assignedAgentId", "pausedByAgentId", "assigneeUserId", "nodeId", "effectiveNodeId", "effectiveNodeSource",
      "sourceType", "sourceAgentId", "sourceRunId", "sourceSessionId", "sourceMessageId", "sourceParentTaskId", "sourceMetadata",
      "checkedOutBy", "checkedOutAt", "checkoutNodeId", "checkoutRunId", "checkoutLeaseRenewedAt", "checkoutLeaseEpoch", "deletedAt", "allowResurrection",
      // `log` is fetched in slim mode so the server can aggregate
      // `timedExecutionMs` from `[timing] … in <N>ms` entries before
      // returning. The log itself is stripped from the response —
      // see `listTasks()` slim post-processing.
      "log",
    ].map((column) => `${prefix}${column}`).join(", ");
  }

  /**
   * Sum the durations of all `[timing] … in <N>ms` (or `… after <N>ms`) log
   * entries. Returns 0 when no timing entries are present.
   *
   * Mirrors the client-side `getTimedDurationMs` so slim board listings can
   * report the same total-execution figure that the task detail Stats panel
   * computes from the full log.
   */
  private computeTimedExecutionMs(log: import("./types.js").TaskLogEntry[] | undefined): number {
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

  private getTaskSelectClauseWithActivityLogLimit(limit: number): string {
    const columns = [
      "id", "lineageId", "title", "description", "priority", "\"column\"", "status", "size", "reviewLevel", "currentStep",
      "worktree", "blockedBy", "overlapBlockedBy", "paused", "pausedReason", "userPaused", "baseBranch", "branch", "autoMerge", "autoMergeProvenance", "executionStartBranch", "baseCommitSha",
      "modelPresetId", "modelProvider", "modelId",
      "validatorModelProvider", "validatorModelId",
      "planningModelProvider", "planningModelId",
      "mergeRetries", "workflowStepRetries", "stuckKillCount", "resumeLimboCount", "graphResumeRetryCount", "resumeLimboTipSha", "resumeLimboStepSignature", "postReviewFixCount", "recoveryRetryCount", "taskDoneRetryCount", "worktreeSessionRetryCount", "completionHandoffLimboRecoveryCount", "verificationFailureCount", "mergeConflictBounceCount", "mergeAuditBounceCount", "mergeTransientRetryCount", "branchConflictRecoveryCount", "reviewerContextRetryCount", "reviewerFallbackRetryCount", "nextRecoveryAt",
      "error", "summary", "thinkingLevel", "executionMode",
      "tokenUsageInputTokens", "tokenUsageOutputTokens", "tokenUsageCachedTokens", "tokenUsageCacheWriteTokens", "tokenUsageTotalTokens", "tokenUsageFirstUsedAt", "tokenUsageLastUsedAt", "tokenUsageModelProvider", "tokenUsageModelId", "tokenUsagePerModel", "tokenBudgetSoftAlertedAt", "tokenBudgetHardAlertedAt", "tokenBudgetOverride",
      "createdAt", "updatedAt", "columnMovedAt", "firstExecutionAt", "cumulativeActiveMs", "executionStartedAt", "executionCompletedAt",
      "dependencies", "steps", "customFields", "attachments", "steeringComments",
      "comments", "review", "reviewState", "workflowStepResults", "prInfo", "prInfos", "issueInfo", "githubTracking", "sourceIssueProvider", "sourceIssueRepository", "sourceIssueExternalIssueId", "sourceIssueNumber", "sourceIssueUrl", "sourceIssueClosedAt", "mergeDetails",
      "breakIntoSubtasks", "noCommitsExpected", "enabledWorkflowSteps", "modifiedFiles",
      "missionId", "sliceId", "scopeOverride", "scopeOverrideReason", "scopeAutoWiden", "assignedAgentId", "pausedByAgentId", "assigneeUserId", "nodeId", "effectiveNodeId", "effectiveNodeSource",
      "sourceType", "sourceAgentId", "sourceRunId", "sourceSessionId", "sourceMessageId", "sourceParentTaskId", "sourceMetadata",
      "checkedOutBy", "checkedOutAt", "checkoutNodeId", "checkoutRunId", "checkoutLeaseRenewedAt", "checkoutLeaseEpoch", "deletedAt", "allowResurrection",
    ];

    const limitedLog = `
      CASE
        WHEN json_valid(log) AND json_array_length(log) > ${limit} THEN (
          SELECT json_group_array(json(value))
          FROM (
            SELECT value
            FROM (
              SELECT key, value
              FROM json_each(tasks.log)
              ORDER BY key DESC
              LIMIT ${limit}
            )
            ORDER BY key ASC
          )
        )
        ELSE log
      END AS log
    `;

    return [...columns, limitedLog].join(", ");
  }

  private createTaskPersistSerializationContext(
    task: Task,
    existingRow?: Pick<TaskRow, "lineageId">,
  ): TaskPersistSerializationContext {
    return {
      lineageId: task.lineageId ?? existingRow?.lineageId ?? generateTaskLineageId(),
    };
  }

  private getTaskPersistValues(task: Task, existingRow?: Pick<TaskRow, "lineageId">): unknown[] {
    const context = this.createTaskPersistSerializationContext(task, existingRow);
    return TASK_COLUMN_DESCRIPTORS.map((descriptor) => descriptor.serialize(task, context));
  }

  private readTaskRowFromDb(id: string, options?: { includeDeleted?: boolean }): TaskRow | undefined {
    const whereClause = options?.includeDeleted ? "id = ?" : `id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`;
    return this.db.prepare(`SELECT * FROM tasks WHERE ${whereClause}`).get(id) as TaskRow | undefined;
  }

  /**
   * Insert a brand-new task row. Create paths must use this so SQLite raises on
   * duplicate IDs instead of silently rewriting the existing row.
   */
  private insertTask(task: Task): void {
    const values = this.getTaskPersistValues(task);
    const placeholders = values.map(() => "?").join(", ");
    this.db.prepare(`
      INSERT INTO tasks (${TASK_PERSIST_SQL_COLUMNS})
      VALUES (${placeholders})
    `).run(...values);
    this.db.bumpLastModified();
  }

  /**
   * Upsert a task to the database. Update paths intentionally retain ON CONFLICT
   * semantics; create paths must use insertTask() instead.
   * FN-4898: this low-level persistence path intentionally does not normalize
   * titles because replication/restore flows may carry authoritative bytes.
   */
  private upsertTask(task: Task): void {
    const values = this.getTaskPersistValues(task);
    const placeholders = values.map(() => "?").join(", ");
    this.db.prepare(`
      INSERT INTO tasks (${TASK_PERSIST_SQL_COLUMNS})
      VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET
${TASK_UPSERT_SQL_ASSIGNMENTS}
    `).run(...values);
    this.db.bumpLastModified();
  }

  private isTaskIdConflictError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /SQLITE_CONSTRAINT|UNIQUE constraint failed: tasks\.id|PRIMARY KEY constraint failed: tasks\.id/i.test(message);
  }

  private logTaskCreateConflict(task: Task, operation: string, error: unknown): void {
    storeLog.error("Refused colliding task create", {
      phase: "task-create:id-conflict",
      operation,
      taskId: task.id,
      column: task.column,
      sourceType: task.sourceType,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private insertTaskWithFtsRecovery(task: Task, operation: string): void {
    const normalizeConflict = (error: unknown): never => {
      this.logTaskCreateConflict(task, operation, error);
      throw new Error(`Task ID already exists: ${task.id}`);
    };

    try {
      this.insertTask(task);
      return;
    } catch (error) {
      if (this.isTaskIdConflictError(error)) {
        normalizeConflict(error);
      }
      if (!this.db.isFts5CorruptionError(error)) {
        throw error;
      }

      console.warn(`[fusion:store] FTS5 corruption detected during insert for task ${task.id}; rebuilding index and retrying once`);

      try {
        this.db.rebuildFts5Index();
      } catch (rebuildError) {
        console.warn("[fusion:store] FTS5 rebuild failed; propagating original insert error", rebuildError);
        throw error;
      }

      try {
        this.insertTask(task);
      } catch (retryError) {
        if (this.isTaskIdConflictError(retryError)) {
          normalizeConflict(retryError);
        }
        console.warn("[fusion:store] Insert retry after FTS5 rebuild failed; propagating original insert error", retryError);
        throw error;
      }
    }
  }

  private runTaskFtsWriteWithRecovery(taskId: string, operation: string, write: () => void): void {
    try {
      write();
      return;
    } catch (error) {
      if (!this.db.isFts5CorruptionError(error)) {
        throw error;
      }

      console.warn(`[fusion:store] FTS5 corruption detected during ${operation} for task ${taskId}; rebuilding index and retrying once`);

      try {
        this.db.rebuildFts5Index();
      } catch (rebuildError) {
        console.warn(`[fusion:store] FTS5 rebuild failed; propagating original ${operation} error`, rebuildError);
        throw error;
      }

      try {
        write();
      } catch (retryError) {
        console.warn(`[fusion:store] ${operation} retry after FTS5 rebuild failed; propagating original ${operation} error`, retryError);
        throw error;
      }
    }
  }

  private upsertTaskWithFtsRecovery(task: Task): void {
    this.runTaskFtsWriteWithRecovery(task.id, "upsert", () => {
      this.upsertTask(task);
    });
  }

  private getTaskPatchDescriptors(changedColumns: Iterable<keyof TaskRow>): TaskColumnDescriptor[] {
    const descriptors: TaskColumnDescriptor[] = [];
    for (const column of changedColumns) {
      const descriptor = TASK_COLUMN_DESCRIPTOR_BY_COLUMN.get(column);
      if (!descriptor) {
        throw new Error(`Unknown task column for partial patch: ${String(column)}`);
      }
      descriptors.push(descriptor);
    }
    return descriptors;
  }

  private getChangedTaskColumns(existingRow: TaskRow, task: Task): Set<keyof TaskRow> {
    const nextValues = this.getTaskPersistValues(task, existingRow);
    const changedColumns = new Set<keyof TaskRow>();
    for (const [index, descriptor] of TASK_COLUMN_DESCRIPTORS.entries()) {
      if (descriptor.column === "updatedAt") {
        continue;
      }
      if (!Object.is(existingRow[descriptor.column], nextValues[index])) {
        changedColumns.add(descriptor.column);
      }
    }
    return changedColumns;
  }

  private patchTaskRowInTransaction(
    id: string,
    task: Task,
    changedColumns: Iterable<keyof TaskRow>,
    existingRow?: TaskRow,
  ): { deletedAt?: string; current?: Task } {
    const currentRow = existingRow ?? this.readTaskRowFromDb(id, { includeDeleted: true });
    const deletedAt = this.getSoftDeletedWriteConflict(id, task, currentRow);
    if (deletedAt) {
      return { deletedAt };
    }
    if (!currentRow || currentRow.deletedAt != null) {
      this.upsertTaskWithFtsRecovery(task);
      return { current: this.readTaskFromDb(id) };
    }

    const patchDescriptors = this.getTaskPatchDescriptors(changedColumns);
    const context = this.createTaskPersistSerializationContext(task, currentRow);
    const assignments = patchDescriptors.map((descriptor) => `${descriptor.sqlIdentifier} = ?`);
    assignments.push("updatedAt = ?");
    const values = patchDescriptors.map((descriptor) => descriptor.serialize(task, context));
    values.push(task.updatedAt, id);

    this.runTaskFtsWriteWithRecovery(id, "partial update", () => {
      this.db.prepare(`
        UPDATE tasks
        SET ${assignments.join(", ")}
        WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}
      `).run(...values);
    });
    this.db.bumpLastModified();
    return { current: this.readTaskFromDb(id) };
  }

  private async applyTaskPatch(
    dir: string,
    id: string,
    task: Task,
    changedColumns: Iterable<keyof TaskRow>,
    options?: { existingRow?: TaskRow; auditInput?: { agentId?: string; runId?: string; timestamp?: string; operation?: string } },
  ): Promise<void> {
    let result: { deletedAt?: string; current?: Task } | undefined;
    this.db.transactionImmediate(() => {
      result = this.patchTaskRowInTransaction(id, task, changedColumns, options?.existingRow);
    });
    if (result?.deletedAt) {
      this.throwSoftDeletedWriteBlocked(id, result.deletedAt, options?.auditInput?.operation ?? "applyTaskPatch", {
        agentId: options?.auditInput?.agentId,
        runId: options?.auditInput?.runId,
        timestamp: options?.auditInput?.timestamp,
      });
    }
    await this.writeTaskJsonFile(dir, result?.current ?? task);
  }

  /**
   * Read a task from SQLite by ID.
   */
  private readTaskFromDb(id: string, options?: { activityLogLimit?: number; includeDeleted?: boolean }): Task | undefined {
    const selectClause = options?.activityLogLimit
      ? this.getTaskSelectClauseWithActivityLogLimit(options.activityLogLimit)
      : "*";
    const whereClause = options?.includeDeleted ? "id = ?" : `id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`;
    const row = this.db.prepare(`SELECT ${selectClause} FROM tasks WHERE ${whereClause}`).get(id) as TaskRow | undefined;
    if (!row) return undefined;
    return this.rowToTask(row);
  }

  private getMergeQueuedTaskIds(): Set<string> {
    const rows = this.db.prepare("SELECT taskId FROM mergeQueue").all() as Array<{ taskId: string }>;
    return new Set(rows.map((row) => row.taskId));
  }

  private isTaskIdPresentInArchivedTasksTable(id: string): boolean {
    try {
      const row = this.db.prepare("SELECT 1 as found FROM archivedTasks WHERE id = ? LIMIT 1").get(id) as { found?: number } | undefined;
      return row?.found === 1;
    } catch {
      return false;
    }
  }

  private taskIdExistsAnywhere(id: string): boolean {
    // FN-5105: include soft-deleted rows so IDs remain permanently reserved.
    if (this.readTaskFromDb(id, { includeDeleted: true })) {
      return true;
    }
    if (this.isTaskIdPresentInArchivedTasksTable(id)) {
      return true;
    }
    return this.archiveDb.get(id) !== undefined;
  }

  private assertTaskIdAvailable(id: string): void {
    if (this.taskIdExistsAnywhere(id)) {
      throw new Error(`Task ID already exists: ${id}`);
    }
  }

  private maybeResolveTombstonedTaskId(
    id: string,
    input: Pick<TaskCreateInput, "forceResurrect">,
    operation: "createTask" | "duplicateTask" | "refineTask",
  ): void {
    const existing = this.readTaskFromDb(id, { includeDeleted: true });
    if (!existing?.deletedAt) return;

    const allowResurrection = existing.allowResurrection === true;
    if (input.forceResurrect === true || allowResurrection) {
      this.purgeTaskWorkflowSelectionRows(id);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      this.db.bumpLastModified();
      return;
    }

    storeLog.warn(`[tombstone-resurrection-blocked] ${id} deletedAt=${existing.deletedAt}`);
    this.insertRunAuditEventRow({
      taskId: id,
      domain: "database",
      mutationType: "task:resurrection-blocked",
      target: id,
      metadata: {
        id,
        deletedAt: existing.deletedAt,
        allowResurrection,
        operation,
      },
    });

    throw new TombstonedTaskResurrectionError(id, existing.deletedAt, allowResurrection);
  }

  private isTaskArchived(id: string): boolean {
    const row = this.db.prepare(`SELECT "column" FROM tasks WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`).get(id) as { column: Column } | undefined;
    if (row) {
      return row.column === "archived";
    }

    return this.archiveDb.get(id) !== undefined;
  }

  /**
   * Return the ids of live tasks whose `dependencies` array contains `id`.
   *
   * Uses a SQL LIKE probe as a cheap pre-filter then parses the JSON column
   * to rule out false positives (substring matches on similar ids, matches
   * inside escaped strings, etc.).
   */
  private findLiveDependents(id: string): string[] {
    const rows = this.db
      .prepare(`SELECT id, dependencies FROM tasks WHERE dependencies LIKE ? AND id != ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`)
      .all(`%${id}%`, id) as Array<{ id: string; dependencies: string | null }>;

    const dependents: string[] = [];
    for (const row of rows) {
      if (!row.dependencies) continue;
      try {
        const deps = JSON.parse(row.dependencies) as unknown;
        if (Array.isArray(deps) && deps.includes(id)) {
          dependents.push(row.id);
        }
      } catch {
        // Malformed JSON — skip; nothing we can verify.
      }
    }
    return dependents;
  }

  private findLiveLineageChildren(id: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM tasks WHERE sourceParentTaskId = ? AND id != ? AND "column" != 'archived' AND ${TaskStore.ACTIVE_TASKS_WHERE}`,
      )
      .all(id, id) as Array<{ id: string }>;

    return rows.map((row) => row.id);
  }

  /**
   * Set up event listeners for activity logging.
   * Call after init() to record task lifecycle events.
   *
   * Idempotent — repeated calls are no-ops. Without this guard, each duplicate
   * call double-registers handlers, causing the activity log to record every
   * `task:created` / `task:moved` event N times where N = number of init() calls.
   */
  private setupActivityLogListeners(): void {
    if (this.activityListenersWired) return;
    this.activityListenersWired = true;

    // Task created
    this.on("task:created", (task) => {
      if (this.suppressActivityLogForPollingEmit) return;
      this.recordActivityFromListener(
        {
          type: "task:created",
          taskId: task.id,
          taskTitle: task.title,
          details: `Task ${task.id} created${task.title ? `: ${task.title}` : ""}`,
        },
        "task:created",
      );
    });

    // Task moved
    this.on("task:moved", (data) => {
      if (this.suppressActivityLogForPollingEmit) return;
      if (data.from === data.to) return;
      this.recordActivityFromListener(
        {
          type: "task:moved",
          taskId: data.task.id,
          taskTitle: data.task.title,
          details: `Task ${data.task.id} moved: ${data.from} → ${data.to}`,
          metadata: { from: data.from, to: data.to },
        },
        "task:moved",
      );
    });

    // Task merged
    this.on("task:merged", (result) => {
      const status = result.merged ? "successfully merged" : "merge attempted";
      this.recordActivityFromListener(
        {
          type: "task:merged",
          taskId: result.task.id,
          taskTitle: result.task.title,
          details: `Task ${result.task.id} ${status} to main`,
          metadata: { merged: result.merged, branch: result.branch },
        },
        "task:merged",
      );
    });

    // Task updated (check for failures)
    this.on("task:updated", (task) => {
      if (this.suppressActivityLogForPollingEmit) return;
      if (task.status === "failed") {
        this.recordActivityFromListener(
          {
            type: "task:failed",
            taskId: task.id,
            taskTitle: task.title,
            details: `Task ${task.id} failed${task.error ? `: ${task.error}` : ""}`,
            metadata: task.error ? { error: task.error } : undefined,
          },
          "task:updated",
        );
      }
    });

    // Settings updated (log important changes)
    this.on("settings:updated", (data) => {
      const importantChanges: string[] = [];
      if (data.settings.ntfyEnabled !== data.previous.ntfyEnabled) {
        importantChanges.push(`ntfy ${data.settings.ntfyEnabled ? "enabled" : "disabled"}`);
      }
      if (data.settings.ntfyTopic !== data.previous.ntfyTopic) {
        importantChanges.push(`ntfy topic changed to ${data.settings.ntfyTopic}`);
      }
      if (data.settings.globalPause !== data.previous.globalPause) {
        importantChanges.push(`global pause ${data.settings.globalPause ? "enabled" : "disabled"}`);
      }
      if (data.settings.enginePaused !== data.previous.enginePaused) {
        importantChanges.push(`engine pause ${data.settings.enginePaused ? "enabled" : "disabled"}`);
      }

      if (importantChanges.length > 0) {
        this.recordActivityFromListener(
          {
            type: "settings:updated",
            details: `Settings updated: ${importantChanges.join(", ")}`,
            metadata: { changes: importantChanges },
          },
          "settings:updated",
        );
      }
    });

    // Task deleted
    this.on("task:deleted", (task) => {
      if (this.suppressActivityLogForPollingEmit) return;
      this.recordActivityFromListener(
        {
          type: "task:deleted",
          taskId: task.id,
          taskTitle: task.title,
          details: `Task ${task.id} deleted${task.title ? `: ${task.title}` : ""}`,
        },
        "task:deleted",
      );
    });
  }

  private recordActivityFromListener(
    entry: Omit<ActivityLogEntry, "id" | "timestamp">,
    sourceEvent: string,
  ): void {
    this.recordActivity(entry).catch((err) => {
      storeLog.warn("Activity logging listener failed", {
        sourceEvent,
        type: entry.type,
        taskId: entry.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Serialize all mutations to config.json by chaining promises.
   * Concurrent callers will queue behind each other, preventing
   * lost-update races on the nextId counter.
   */
  private withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    const prev = this.configLock;
    this.configLock = next;

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolve!();
      }
    });
  }

  /**
   * Serialize all mutations to a given task's task.json by chaining promises
   * per task ID. Concurrent callers for the same ID will queue behind each other.
   */
  private withWorktreeAllocationLock<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    const prev = this.worktreeAllocationLock;
    this.worktreeAllocationLock = next;

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        resolve!();
      }
    });
  }

  private withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.taskLocks.get(id) ?? Promise.resolve();
    let resolve: () => void;
    const next = new Promise<void>((r) => { resolve = r; });
    this.taskLocks.set(id, next);

    return prev.then(async () => {
      try {
        return await fn();
      } finally {
        if (this.taskLocks.get(id) === next) {
          this.taskLocks.delete(id);
        }
        resolve!();
      }
    });
  }

  private getTaskIdFromDir(dir: string): string {
    const parts = dir.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1];
  }

  private insertRunAuditEventRow(input: Omit<RunAuditEventInput, "agentId" | "runId"> & { agentId?: string; runId?: string }): void {
    const eventId = randomUUID();
    const timestamp = input.timestamp ?? new Date().toISOString();
    const agentId = input.agentId ?? "store";
    const runId = input.runId ?? `store:${input.mutationType}:${input.taskId ?? input.target}:${eventId}`;
    this.db.prepare(`
      INSERT INTO runAuditEvents (
        id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      timestamp,
      input.taskId ?? null,
      agentId,
      runId,
      input.domain,
      input.mutationType,
      input.target,
      toJsonNullable(input.metadata),
    );
  }

  private getSoftDeletedWriteConflict(id: string, task: Task, existingRow?: TaskRow): string | undefined {
    const existing = existingRow ?? this.readTaskRowFromDb(id, { includeDeleted: true });
    if (!existing?.deletedAt || task.deletedAt !== undefined) {
      return undefined;
    }
    return existing.deletedAt;
  }

  private throwSoftDeletedWriteBlocked(
    id: string,
    deletedAt: string,
    operation: string,
    auditInput?: {
      agentId?: string;
      runId?: string;
      timestamp?: string;
    },
  ): never {
    storeLog.warn(`[soft-delete-resurrection-blocked] refusing ${operation} for ${id}`, {
      id,
      deletedAt,
      operation,
    });
    this.insertRunAuditEventRow({
      taskId: id,
      agentId: auditInput?.agentId,
      runId: auditInput?.runId,
      timestamp: auditInput?.timestamp,
      domain: "database",
      mutationType: "task:resurrection-blocked",
      target: id,
      metadata: {
        id,
        deletedAt,
        operation,
      },
    });
    throw new TaskDeletedError(id, deletedAt);
  }

  /**
   * Read a task from SQLite by ID (extracted from dir path for backward compat).
   * Falls back to file-based reading only when no DB row exists at all.
   */
  private normalizeTaskFromDisk(task: Task): Task {
    if (!Array.isArray(task.log)) task.log = [];
    if (!Array.isArray(task.dependencies)) task.dependencies = [];
    if (!Array.isArray(task.steps)) task.steps = [];
    task.priority = normalizeTaskPriority(task.priority);
    return task;
  }

  private getMalformedTaskMetadataReason(task: Partial<Task>, expectedId: string): string | undefined {
    if (task.id !== expectedId) {
      return `task.json id ${typeof task.id === "string" ? task.id : "<missing>"} does not match directory ${expectedId}`;
    }
    if (typeof task.description !== "string") {
      return "task.json description must be a string";
    }
    if (typeof task.column !== "string") {
      return "task.json column must be a string";
    }
    if (typeof task.createdAt !== "string" || Number.isNaN(Date.parse(task.createdAt))) {
      return "task.json createdAt must be a valid ISO timestamp string";
    }
    if (typeof task.updatedAt !== "string" || Number.isNaN(Date.parse(task.updatedAt))) {
      return "task.json updatedAt must be a valid ISO timestamp string";
    }
    return undefined;
  }

  /*
   * FNXC:TaskStoreConsistency 2026-06-20-00:00:
   * Heartbeat-created tasks persisted on disk but missing from the SQLite index were invisible to fn_task_list/fn_task_show (FN-6783/FN-6784). Reconcile re-imports orphaned task.json rows non-destructively and uses the same exists-anywhere guard as create-time ID allocation so soft-deleted, archived, and tombstoned IDs are never resurrected.
   */
  async reconcileOrphanedTaskDirs(
    opts: { ignoreRecencyWindow?: boolean } = {},
  ): Promise<{ recovered: string[]; skipped: Array<{ id: string; reason: string }> }> {
    const result: { recovered: string[]; skipped: Array<{ id: string; reason: string }> } = {
      recovered: [],
      skipped: [],
    };

    if (this.inMemoryDb || !existsSync(this.tasksDir)) {
      return result;
    }

    // The recency window stops legacy hard-deleted dirs (no tombstone) from being silently
    // resurrected onto a populated board. But the sweep's other job is recovering rows lost to
    // DB corruption or a restore-from-old-backup — where the surviving task.json files keep
    // their original (often >7-day-old) mtimes and the DB is empty. Detect that case: when the
    // live task table is empty, bypass the recency gate so corruption recovery isn't defeated by
    // the same guard added to stop resurrection. Callers may also force the bypass explicitly.
    let dbHasLiveTasks = true;
    try {
      const row = this.db
        .prepare('SELECT EXISTS(SELECT 1 FROM tasks WHERE deletedAt IS NULL LIMIT 1) AS present')
        .get() as { present?: number } | undefined;
      dbHasLiveTasks = (row?.present ?? 0) === 1;
    } catch {
      // If the count probe fails, keep the gate on (conservative — don't mass-resurrect).
      dbHasLiveTasks = true;
    }
    const applyRecencyWindow = !opts.ignoreRecencyWindow && dbHasLiveTasks;

    let entries: Dirent[];
    try {
      entries = await readdir(this.tasksDir, { withFileTypes: true });
    } catch (error) {
      storeLog.warn("Skipping orphaned task-dir reconcile because tasksDir is unreadable", {
        phase: "reconcileOrphanedTaskDirs:scan",
        tasksDir: this.tasksDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return result;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const taskDir = join(this.tasksDir, id);
      const taskJsonPath = join(taskDir, "task.json");
      if (!existsSync(taskJsonPath)) {
        result.skipped.push({ id, reason: "missing-task-json" });
        continue;
      }

      // FN: recency gate. This sweep exists to recover task dirs that "appear after
      // store init" — heartbeat-created dirs that race startup, or rows lost to a
      // recent DB corruption while their task.json survived on disk. It must NOT
      // resurrect *ancient* deleted-task dirs that merely lingered on disk: modern
      // deletes leave a soft-delete tombstone (taskIdExistsAnywhere catches those),
      // but legacy hard-deletes left no tombstone, so a months-old task.json with no
      // DB row would otherwise be silently re-imported onto the live board (the
      // "all task IDs reset / starting over" failure). Only reconcile dirs whose
      // task.json was modified within the recency window; older orphans are left for
      // explicit recovery (unarchive/restore) or directory cleanup. Skipped entirely when
      // the DB is empty / a caller forces recovery (corruption/restore path — see above).
      if (applyRecencyWindow) {
        try {
          const { mtimeMs } = await stat(taskJsonPath);
          const ageMs = Date.now() - mtimeMs;
          if (ageMs > RECONCILE_ORPHAN_TASK_DIR_MAX_AGE_MS) {
            result.skipped.push({ id, reason: "stale-orphan-dir-beyond-recency-window" });
            storeLog.warn("Skipping stale orphaned task-dir reconcile (beyond recency window)", {
              phase: "reconcileOrphanedTaskDirs:recency",
              taskId: id,
              taskJsonPath,
              ageMs,
              maxAgeMs: RECONCILE_ORPHAN_TASK_DIR_MAX_AGE_MS,
            });
            continue;
          }
        } catch (error) {
          result.skipped.push({ id, reason: `stat-failed: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
      }

      let task: Task;
      try {
        const raw = await readFile(taskJsonPath, "utf-8");
        task = this.normalizeTaskFromDisk(JSON.parse(raw) as Task);
      } catch (error) {
        const reason = `malformed-task-json: ${error instanceof Error ? error.message : String(error)}`;
        result.skipped.push({ id, reason });
        storeLog.warn("Skipping malformed task.json during orphaned task-dir reconcile", {
          phase: "reconcileOrphanedTaskDirs:parse",
          taskId: id,
          taskJsonPath,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const malformedReason = this.getMalformedTaskMetadataReason(task, id);
      if (malformedReason) {
        result.skipped.push({ id, reason: `malformed-task-metadata: ${malformedReason}` });
        storeLog.warn("Skipping malformed task metadata during orphaned task-dir reconcile", {
          phase: "reconcileOrphanedTaskDirs:validate",
          taskId: id,
          taskJsonPath,
          reason: malformedReason,
        });
        continue;
      }

      let recovered = false;
      let skipReason: string | undefined;
      try {
        this.db.transactionImmediate(() => {
          if (this.taskIdExistsAnywhere(id)) {
            skipReason = "id-exists-anywhere";
            return;
          }
          try {
            this.insertTaskWithFtsRecovery(task, "reconcileOrphanedTaskDirs");
            this.insertRunAuditEventRow({
              taskId: id,
              domain: "database",
              mutationType: "task:reconcile-orphaned-task-dir",
              target: id,
              metadata: {
                id,
                column: task.column,
                status: task.status ?? null,
                taskJsonPath,
              },
            });
            recovered = true;
          } catch (error) {
            if (this.isTaskIdConflictError(error) || /Task ID already exists/i.test(error instanceof Error ? error.message : String(error))) {
              skipReason = "id-conflict-during-insert";
              return;
            }
            throw error;
          }
        });
      } catch (error) {
        const reason = `insert-failed: ${error instanceof Error ? error.message : String(error)}`;
        result.skipped.push({ id, reason });
        storeLog.warn("Skipping orphaned task-dir reconcile insert after non-fatal error", {
          phase: "reconcileOrphanedTaskDirs:insert",
          taskId: id,
          taskJsonPath,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (recovered) {
        result.recovered.push(id);
        if (this.isWatching) this.taskCache.set(id, { ...task });
        storeLog.warn("Recovered orphaned task.json into SQLite task index", {
          phase: "reconcileOrphanedTaskDirs:recovered",
          taskId: id,
          column: task.column,
          status: task.status,
          taskJsonPath,
        });
        this.emitTaskLifecycleEventSafely("task:created", [task]);
      } else {
        result.skipped.push({ id, reason: skipReason ?? "not-recovered" });
      }
    }

    return result;
  }

  private async readTaskJson(dir: string): Promise<Task> {
    const id = this.getTaskIdFromDir(dir);

    const task = this.readTaskFromDb(id);
    if (task) return task;

    const deletedTask = this.readTaskFromDb(id, { includeDeleted: true });
    if (deletedTask?.deletedAt) {
      throw new TaskDeletedError(id, deletedTask.deletedAt);
    }

    // Fallback to file-based reading (for legacy compatibility when no DB row exists).
    const filePath = join(dir, "task.json");
    const raw = await readFile(filePath, "utf-8");
    try {
      return this.normalizeTaskFromDisk(JSON.parse(raw) as Task);
    } catch (err) {
      throw new Error(
        `Failed to parse task.json at ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  private async writeTaskJsonFile(dir: string, task: Task): Promise<void> {
    this.clearStartupSlimListMemo();
    const taskJsonPath = join(dir, "task.json");
    // Use a unique tmp filename per write so concurrent writers to the same task
    // don't race on a shared `task.json.tmp` (one rename consumes it, the other
    // ENOENTs). See FN-4122/FN-4123/FN-4148 for the reproducer.
    const tmpPath = join(dir, `task.json.${process.pid}.${randomUUID()}.tmp`);
    this.suppressWatcher(taskJsonPath);
    await mkdir(dir, { recursive: true });
    await writeFile(tmpPath, JSON.stringify(task));
    try {
      await rename(tmpPath, taskJsonPath);
    } catch (err) {
      // Best-effort cleanup of our tmp on rename failure so we don't leave
      // orphaned `task.json.*.tmp` files behind.
      try {
        await unlink(tmpPath);
      } catch {
        // ignore — tmp may already be gone
      }
      throw err;
    }
  }

  /**
   * Write a brand-new task to SQLite (primary store) and also write task.json to disk
   * for backward compatibility and debugging. Create paths must call this variant
   * so duplicate IDs fail safely instead of overwriting existing rows.
   */
  private async atomicCreateTaskJson(dir: string, task: Task, operation: string): Promise<void> {
    const id = this.getTaskIdFromDir(dir);
    let deletedAt: string | undefined;
    this.db.transactionImmediate(() => {
      deletedAt = this.getSoftDeletedWriteConflict(id, task);
      if (deletedAt) return;
      this.insertTaskWithFtsRecovery(task, operation);
    });
    if (deletedAt) {
      this.throwSoftDeletedWriteBlocked(id, deletedAt, operation);
    }
    await this.writeTaskJsonFile(dir, task);
  }

  /**
   * Write an existing task to SQLite (primary store) and also write task.json to disk
   * for backward compatibility and debugging.
   */
  private async atomicWriteTaskJson(dir: string, task: Task): Promise<void> {
    const id = this.getTaskIdFromDir(dir);
    let result: { deletedAt?: string; current?: Task } | undefined;
    this.db.transactionImmediate(() => {
      const existingRow = this.readTaskRowFromDb(id, { includeDeleted: true });
      const changedColumns = existingRow && existingRow.deletedAt == null
        ? this.getChangedTaskColumns(existingRow, task)
        : new Set<keyof TaskRow>();
      result = this.patchTaskRowInTransaction(id, task, changedColumns, existingRow);
    });
    if (result?.deletedAt) {
      this.throwSoftDeletedWriteBlocked(id, result.deletedAt, "atomicWriteTaskJson");
    }
    await this.writeTaskJsonFile(dir, result?.current ?? task);
  }

  /**
   * Write a task to SQLite and optionally record a run-audit event, all in a single
   * SQLite transaction. If the audit insert fails, the task mutation is rolled back.
   *
   * @param dir - Task directory path
   * @param task - Task to write
   * @param auditInput - Optional audit event input to record atomically with the task write
   */
  private async atomicWriteTaskJsonWithAudit(
    dir: string,
    task: Task,
    auditInput?: RunAuditEventInput,
  ): Promise<void> {
    const id = this.getTaskIdFromDir(dir);
    let result: { deletedAt?: string; current?: Task } | undefined;
    this.db.transactionImmediate(() => {
      const existingRow = this.readTaskRowFromDb(id, { includeDeleted: true });
      const changedColumns = existingRow && existingRow.deletedAt == null
        ? this.getChangedTaskColumns(existingRow, task)
        : new Set<keyof TaskRow>();
      result = this.patchTaskRowInTransaction(id, task, changedColumns, existingRow);
      if (result?.deletedAt) return;

      if (auditInput) {
        this.insertRunAuditEventRow(auditInput);
      }
    });
    if (result?.deletedAt) {
      this.throwSoftDeletedWriteBlocked(id, result.deletedAt, auditInput?.mutationType ?? "atomicWriteTaskJsonWithAudit", {
        agentId: auditInput?.agentId,
        runId: auditInput?.runId,
        timestamp: auditInput?.timestamp,
      });
    }

    await this.writeTaskJsonFile(dir, result?.current ?? task);
  }

  /**
   * Get merged settings: global defaults ← global user prefs ← project overrides.
   *
   * Returns the combined view that most consumers should use. Project-level
   * values in `.fusion/config.json` override global values from `~/.fusion/settings.json`.
   *
   *
   */
  async getSettings(): Promise<Settings> {
    const [globalSettings, config] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.readConfig(),
    ]);
    // Strip global-only keys from project-level settings so stale project-scoped
    // values don't override the correct global value during the spread merge.
    const projectSettings = Object.fromEntries(
      Object.entries(config.settings ?? {}).filter(([key]) => !isGlobalOnlySettingsKey(key)),
    );
    const merged = {
      ...DEFAULT_SETTINGS,
      ...globalSettings,
      ...projectSettings,
      worktrunk: resolveWorktrunkSettings(
        globalSettings.worktrunk,
        (projectSettings as Partial<Settings>).worktrunk,
      ),
    };
    try {
      merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await this.getSecretsStore());
    } catch {
      merged.secretsSyncPassphraseConfigured = false;
    }
    return canonicalizeSettings(merged);
  }

  /**
   * Fast-path settings read that skips the expensive workflow steps query.
   *
   * This method reads only the `settings` column from the SQLite config row
   * (avoiding `readConfig()` which always calls `listWorkflowSteps()`), and
   * uses the cached global settings from `GlobalSettingsStore`. Use this for
   * read-heavy paths like the settings page that don't need workflow steps.
   *
   * Note: Do NOT use this method when you need workflow steps — use `getSettings()` instead.
   *
   *
   */
  async getSettingsFast(): Promise<Settings> {
    const [globalSettings, row] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined,
    ]);

    const raw = row?.settings ? fromJson<Settings>(row.settings) : undefined;

    // Strip global-only keys from the project-level row so stale project-scoped
    // values (e.g. an empty experimentalFeatures={}) don't override the correct
    // global value during the spread merge below. getSettingsByScopeFast() has
    // always done this; getSettingsFast() was missing the filter.
    const projectSettings: Partial<Settings> | undefined = raw
      ? (Object.fromEntries(
          Object.entries(raw).filter(([key]) => !isGlobalOnlySettingsKey(key)),
        ) as Partial<Settings>)
      : undefined;

    const merged = {
      ...DEFAULT_SETTINGS,
      ...globalSettings,
      ...projectSettings,
      worktrunk: resolveWorktrunkSettings(globalSettings.worktrunk, projectSettings?.worktrunk),
    };
    try {
      merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await this.getSecretsStore());
    } catch {
      merged.secretsSyncPassphraseConfigured = false;
    }

    return canonicalizeSettings(merged);
  }

  /**
   * Get settings separated by scope. Returns both the global and
   * project-level settings independently (useful for the UI to show
   * which scope a value comes from).
   *
   *
   */
  async getSettingsByScope(): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    const [globalSettings, config] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.readConfig(),
    ]);
    try {
      globalSettings.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await this.getSecretsStore());
    } catch {
      globalSettings.secretsSyncPassphraseConfigured = false;
    }

    // Extract only project-level keys from config.settings
    const projectSettings: Partial<ProjectSettings> = {};
    if (config.settings) {
      for (const key of Object.keys(config.settings)) {
        if (!isGlobalOnlySettingsKey(key)) {
          (projectSettings as Record<string, unknown>)[key] = (config.settings as Record<string, unknown>)[key];
        }
      }
    }

    // Apply canonicalization to project settings and keep upgrade-safe
    // default fallback behavior for legacy rows that omit this key.
    const canonicalizedProject = canonicalizeSettings(projectSettings as Settings);
    if (canonicalizedProject.ephemeralAgentsEnabled === undefined) {
      canonicalizedProject.ephemeralAgentsEnabled = DEFAULT_PROJECT_SETTINGS.ephemeralAgentsEnabled;
    }

    return { global: globalSettings, project: canonicalizedProject };
  }

  /**
   * Fast-path version of `getSettingsByScope()` that skips the expensive
   * `listWorkflowSteps()` query.
   *
   * This method reads only the `settings` column from the SQLite config row
   * (avoiding `readConfig()` which always calls `listWorkflowSteps()`), and
   * uses the cached global settings from `GlobalSettingsStore`. Use this for
   * read-heavy paths like the settings page that don't need workflow steps.
   *
   *
   */
  async getSettingsByScopeFast(): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    const [globalSettings, row] = await Promise.all([
      this.globalSettingsStore.getSettings(),
      this.db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings?: string } | undefined,
    ]);
    try {
      globalSettings.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await this.getSecretsStore());
    } catch {
      globalSettings.secretsSyncPassphraseConfigured = false;
    }

    const projectSettings = row?.settings ? fromJson<Settings>(row.settings) : undefined;

    // Extract only project-level keys from config.settings
    const projectScoped: Partial<ProjectSettings> = {};
    if (projectSettings) {
      for (const key of Object.keys(projectSettings)) {
        if (!isGlobalOnlySettingsKey(key)) {
          (projectScoped as Record<string, unknown>)[key] = (projectSettings as Record<string, unknown>)[key];
        }
      }
    }

    // Apply canonicalization and keep upgrade-safe default fallback behavior
    // for legacy rows that omit this key.
    const canonicalizedProject = canonicalizeSettings(projectScoped as Settings);
    if (canonicalizedProject.ephemeralAgentsEnabled === undefined) {
      canonicalizedProject.ephemeralAgentsEnabled = DEFAULT_PROJECT_SETTINGS.ephemeralAgentsEnabled;
    }

    return { global: globalSettings, project: canonicalizedProject };
  }

  /**
   * Update project-level settings in `.fusion/config.json`.
   *
   * Accepts `Partial<Settings>` for backward compatibility. Any global-only
   * fields in the patch are silently filtered out — they will not be persisted
   * to the project config. Use `updateGlobalSettings()` for global fields.
   */
  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    // Stale-writer guard (U4, R8): moved keys no longer live in project settings —
    // they belong to workflow setting values. Drop any moved key arriving from a
    // stale writer/import so it is never persisted back into raw storage (where the
    // default re-injection trap would silently override the migrated value).
    const guardedPatch =
      patchContainsMovedKey(patch as Record<string, unknown>)
        ? (() => {
            storeLog.warn("Dropped moved settings keys from project updateSettings patch", {
              phase: "updateSettings:moved-key-guard",
              dropped: Object.keys(patch).filter((k) => (MOVED_SETTINGS_KEYS as readonly string[]).includes(k)),
            });
            return stripMovedSettingsKeys(patch as Record<string, unknown>) as Partial<Settings>;
          })()
        : patch;

    // Filter out global-only fields — they should go through updateGlobalSettings()
    const projectPatch: Partial<Settings> = {};
    for (const [key, value] of Object.entries(guardedPatch)) {
      if (!isGlobalOnlySettingsKey(key)) {
        (projectPatch as Record<string, unknown>)[key] = value;
      }
    }

    return this.withConfigLock(async () => {
      const config = this.readConfigFast();

      // Handle null values as "delete this key from settings"
      // This allows the frontend to explicitly clear a setting by sending null
      // (since JSON.stringify drops undefined keys, we use null as a sentinel)

      // Handle special null-as-delete semantics for promptOverrides
      const incomingPromptOverrides = (projectPatch as Record<string, unknown>)["promptOverrides"];
      if (incomingPromptOverrides === null) {
        // promptOverrides: null → clear the entire promptOverrides object
        delete (config.settings as unknown as Record<string, unknown>)["promptOverrides"];
        delete (projectPatch as Record<string, unknown>)["promptOverrides"];
      } else if (
        incomingPromptOverrides !== undefined &&
        typeof incomingPromptOverrides === "object" &&
        incomingPromptOverrides !== null
      ) {
        // promptOverrides: { key: value } → merge with existing, treating null values as delete
        const incomingMap = incomingPromptOverrides as Record<string, unknown>;
        const existingMap = ((config.settings as unknown as Record<string, unknown>)["promptOverrides"] as Record<string, string>) ?? {};
        const mergedMap: Record<string, string> = { ...existingMap };

        for (const [key, value] of Object.entries(incomingMap)) {
          if (value === null) {
            // null → delete this specific key
            delete mergedMap[key];
          } else if (typeof value === "string" && value !== "") {
            // non-empty string → set this key
            // Empty strings are treated as "clear" and not stored
            mergedMap[key] = value;
          }
          // Empty strings are silently ignored (treated as "clear")
        }

        // If merged map is empty, remove the entire promptOverrides
        if (Object.keys(mergedMap).length === 0) {
          delete (config.settings as unknown as Record<string, unknown>)["promptOverrides"];
          delete (projectPatch as Record<string, unknown>)["promptOverrides"];
        } else {
          (config.settings as unknown as Record<string, unknown>)["promptOverrides"] = mergedMap;
          (projectPatch as Record<string, unknown>)["promptOverrides"] = mergedMap;
        }
      }

      // Handle null values for other top-level keys (non-promptOverrides)
      for (const key of Object.keys(projectPatch)) {
        if ((projectPatch as Record<string, unknown>)[key] === null) {
          delete (config.settings as unknown as Record<string, unknown>)[key];
          delete (projectPatch as Record<string, unknown>)[key];
        }
      }

      const globalSettings = await this.globalSettingsStore.getSettings();
      const previousMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...config.settings } as Settings;
      const updatedProjectSettings = { ...config.settings, ...projectPatch };
      config.settings = updatedProjectSettings as Settings;
      await this.writeConfig(config);
      const updatedMerged: Settings = { ...DEFAULT_SETTINGS, ...globalSettings, ...updatedProjectSettings } as Settings;
      this.emit("settings:updated", { settings: updatedMerged, previous: previousMerged });

      // #1409: if this update flipped workflowColumns ON→OFF, evacuate any card
      // stranded in a custom (non-legacy) column back to a legacy column so the
      // board stays listable / movable on the legacy path.
      if (isWorkflowColumnsCompatibilityFlagEnabled(previousMerged) && !isWorkflowColumnsCompatibilityFlagEnabled(updatedMerged)) {
        try {
          await this.evacuateCustomColumnsToLegacy("flag-toggled-off");
        } catch (err) {
          storeLog.warn("workflowColumns ON→OFF evacuation failed", {
            phase: "evacuate-custom-columns",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Bootstrap project memory file when memory is toggled on
      if (updatedMerged.memoryEnabled !== false && previousMerged.memoryEnabled === false) {
        try {
          // Use backend-aware bootstrap to honor memoryBackendType setting
          await ensureMemoryFileWithBackend(this.rootDir, updatedMerged);
        } catch (err) {
          // Non-fatal — memory bootstrap failure should not block settings update
          storeLog.warn("Project-memory bootstrap failed after memory toggle-on", {
            phase: "updateSettings:memory-toggle-on",
            rootDir: this.rootDir,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return updatedMerged;
    });
  }

  /**
   * Update global (user-level) settings in `~/.fusion/settings.json`.
   *
   * These settings persist across all fn projects for the current user.
   * Only fields defined in `GlobalSettings` are accepted.
   */
  async updateGlobalSettings(patch: Partial<GlobalSettings>): Promise<Settings> {
    // Read previous state BEFORE writing so the diff is correct
    const previousGlobal = await this.globalSettingsStore.getSettings();
    const config = this.readConfigFast();
    const previous: Settings = { ...DEFAULT_SETTINGS, ...previousGlobal, ...config.settings } as Settings;

    // Stale-writer guard (U4, R8): moved keys are all project-scoped, but null
    // them defensively out of the global write path too so a stale writer cannot
    // resurrect them in the global store.
    const globalPatch: Partial<GlobalSettings> = patchContainsMovedKey(patch as Record<string, unknown>)
      ? (stripMovedSettingsKeys(patch as Record<string, unknown>) as Partial<GlobalSettings>)
      : { ...patch };
    delete globalPatch.secretsSyncPassphraseConfigured;

    // Handle deep merge + targeted null clear semantics for remoteAccess
    const incomingRemoteAccess = (globalPatch as Record<string, unknown>)["remoteAccess"];
    if (incomingRemoteAccess === null) {
      (globalPatch as Record<string, unknown>)["remoteAccess"] = null;
    } else if (isPlainObject(incomingRemoteAccess)) {
      const existingRemoteAccess = (previousGlobal as Record<string, unknown>)["remoteAccess"];
      const mergedRemoteAccess = deepMergeWithNullDelete(existingRemoteAccess, incomingRemoteAccess);

      if (mergedRemoteAccess === undefined) {
        (globalPatch as Record<string, unknown>)["remoteAccess"] = null;
      } else {
        (globalPatch as Record<string, unknown>)["remoteAccess"] = mergedRemoteAccess;
      }
    }

    // Handle experimentalFeatures merging (similar to promptOverrides)
    const incomingExperimentalFeatures = (globalPatch as Record<string, unknown>)["experimentalFeatures"];
    if (incomingExperimentalFeatures === null) {
      (globalPatch as Record<string, unknown>)["experimentalFeatures"] = null;
    } else if (
      incomingExperimentalFeatures !== undefined &&
      typeof incomingExperimentalFeatures === "object" &&
      !Array.isArray(incomingExperimentalFeatures)
    ) {
      const incomingMap = incomingExperimentalFeatures as Record<string, unknown>;
      const existingMap = ((previousGlobal as Record<string, unknown>)["experimentalFeatures"] as Record<string, boolean>) ?? {};
      const mergedMap: Record<string, boolean> = { ...existingMap };

      for (const [key, value] of Object.entries(incomingMap)) {
        if (value === null) {
          delete mergedMap[key];
        } else if (typeof value === "boolean") {
          mergedMap[key] = value;
        }
      }

      (globalPatch as Record<string, unknown>)["experimentalFeatures"] = mergedMap;
    }

    // Validate the optional UI locale at the write boundary: drop unrecognized
    // values rather than persisting junk into settings.json. Runtime consumers
    // also guard via isLocale, but the contract is `language?: Locale`.
    // `null` passes through intact — GlobalSettingsStore treats null as
    // "delete this key", which reverts the language to runtime auto-detect.
    if ("language" in globalPatch) {
      const rawLanguage = (globalPatch as Record<string, unknown>)["language"];
      if (rawLanguage !== null) {
        const validatedLanguage = validateLocale(rawLanguage);
        if (validatedLanguage === undefined) {
          delete (globalPatch as Record<string, unknown>)["language"];
        } else {
          globalPatch.language = validatedLanguage;
        }
      }
    }

    const updatedGlobal = await this.globalSettingsStore.updateSettings(globalPatch);
    const merged: Settings = { ...DEFAULT_SETTINGS, ...updatedGlobal, ...config.settings } as Settings;
    try {
      merged.secretsSyncPassphraseConfigured = await hasSyncPassphraseConfigured(await this.getSecretsStore());
    } catch {
      merged.secretsSyncPassphraseConfigured = false;
    }

    // Emit settings:updated so SSE listeners pick up the change
    this.emit("settings:updated", { settings: merged, previous });

    // #1409: workflowColumns lives in experimentalFeatures (a global key), so the
    // ON→OFF toggle flows through here. Evacuate any card stranded in a custom
    // column when the flag flips off.
    if (isWorkflowColumnsCompatibilityFlagEnabled(previous) && !isWorkflowColumnsCompatibilityFlagEnabled(merged)) {
      try {
        await this.evacuateCustomColumnsToLegacy("flag-toggled-off");
      } catch (err) {
        storeLog.warn("workflowColumns ON→OFF evacuation failed", {
          phase: "evacuate-custom-columns",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return merged;
  }

  /**
   * Get the GlobalSettingsStore instance (used by API routes).
   */
  getGlobalSettingsStore(): GlobalSettingsStore {
    return this.globalSettingsStore;
  }

  private async readConfig(): Promise<BoardConfig> {
    const row = this.db.prepare("SELECT * FROM config WHERE id = 1").get() as unknown as ConfigRow | undefined;
    if (!row) {
      return { nextId: 1 };
    }
    const config: BoardConfig = {
      nextId: row.nextId || 1,
      settings: fromJson<Settings>(row.settings),
    };

    // Backward-compatibility for internal callers/tests that still access these fields.
    // Keep them non-enumerable so config.json writes don't include workflow steps.
    const workflowSteps = this.listWorkflowSteps();
    Object.defineProperty(config, "workflowSteps", {
      value: await workflowSteps,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(config, "nextWorkflowStepId", {
      value: row.nextWorkflowStepId || 1,
      writable: true,
      configurable: true,
      enumerable: false,
    });

    return config;
  }

  /**
   * Fast-path config read that skips the expensive listWorkflowSteps() query.
   * Returns only the core config fields needed for config.json serialization.
   */
  private readConfigFast(): BoardConfig {
    const row = this.db.prepare("SELECT * FROM config WHERE id = 1").get() as ConfigRow | undefined;
    if (!row) {
      return { nextId: 1 };
    }
    return {
      nextId: row.nextId || 1,
      settings: fromJson<Settings>(row.settings),
    };
  }

  private serializeConfigForDisk(config: BoardConfig): string {
    const { nextId: _deprecatedNextId, ...configForDisk } = config as BoardConfig & { nextId?: number };
    return JSON.stringify(configForDisk, null, 2);
  }

  private async writeConfig(
    config: BoardConfig,
    options?: { nextWorkflowStepId?: number },
  ): Promise<void> {
    const now = new Date().toISOString();
    const row = this.db
      .prepare("SELECT nextWorkflowStepId FROM config WHERE id = 1")
      .get() as { nextWorkflowStepId?: number } | undefined;
    const nextWorkflowStepId = options?.nextWorkflowStepId ?? row?.nextWorkflowStepId ?? 1;

    const legacyWorkflowSteps = (config as { workflowSteps?: unknown }).workflowSteps;
    const workflowStepsJson = Array.isArray(legacyWorkflowSteps)
      ? JSON.stringify(legacyWorkflowSteps)
      : "[]";

    // `config.nextId` is deprecated legacy state. Preserve the existing column
    // value for one release, but stop writing new values so distributed_task_id_state
    // remains the sole active allocator counter.
    this.db.prepare(
      `INSERT INTO config (id, nextWorkflowStepId, settings, workflowSteps, updatedAt)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         nextWorkflowStepId = excluded.nextWorkflowStepId,
         settings = excluded.settings,
         workflowSteps = excluded.workflowSteps,
         updatedAt = excluded.updatedAt`,
    ).run(
      nextWorkflowStepId,
      JSON.stringify(config.settings || {}),
      workflowStepsJson,
      now,
    );
    this.db.bumpLastModified();
    // Also write config.json to disk for backward compatibility
    try {
      const tmpPath = this.configPath + ".tmp";
      await writeFile(tmpPath, this.serializeConfigForDisk(config));
      await rename(tmpPath, this.configPath);
    } catch (err) {
      // Best-effort: SQLite is the primary store
      storeLog.warn("Backward-compat config.json sync failed after config write", {
        phase: "writeConfig:disk-sync",
        configPath: this.configPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async resolveLocalNodeIdForTaskAllocation(): Promise<string> {
    if (process.env.VITEST === "true") {
      return "local";
    }
    const central = new CentralCore();
    await central.init();
    try {
      const nodes = await central.listNodes();
      return resolveLocalNodeId(nodes.map((node) => ({ id: node.id, type: node.type })));
    } catch {
      return "local";
    } finally {
      await central.close();
    }
  }

  private async createTaskWithDistributedReservation(
    input: TaskCreateInput,
    options?: {
      onSummarize?: (description: string) => Promise<string | null>;
      settings?: { autoSummarizeTitles?: boolean };
      createTaskWithId?: (taskId: string) => Promise<Task>;
    },
  ): Promise<Task> {
    const settings = await this.getSettingsFast();
    const prefix = (settings.taskPrefix || "KB").trim().toUpperCase();
    const allocator = this.getDistributedTaskIdAllocator();
    const nodeId = await this.resolveLocalNodeIdForTaskAllocation();
    const reservation = await allocator.reserveDistributedTaskId({
      prefix,
      nodeId,
    });

    let createdTask: Task | null = null;
    try {
      createdTask = options?.createTaskWithId
        ? await options.createTaskWithId(reservation.taskId)
        : await this.createTaskWithReservedId(input, { taskId: reservation.taskId });
      await allocator.commitDistributedTaskIdReservation({
        reservationId: reservation.reservationId,
        nodeId,
      });
      return createdTask;
    } catch (error) {
      await allocator.abortDistributedTaskIdReservation({
        reservationId: reservation.reservationId,
        nodeId,
        reason: "failed-create",
      }).catch(() => undefined);
      throw error;
    }
  }

  private taskDir(id: string): string {
    return join(this.tasksDir, id);
  }

  private artifactRegistryDir(): string {
    return join(this.fusionDir, "artifacts");
  }

  private static artifactStoredName(id: string, title: string): string {
    const sanitized = (title.trim() || "artifact").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "artifact";
    return `${Date.now()}-${id}-${sanitized}`;
  }

  private getBuiltInWorkflowTemplate(templateId: string): import("./types.js").WorkflowStepTemplate | undefined {
    return WORKFLOW_STEP_TEMPLATES.find((template) => template.id === templateId);
  }

  private toBuiltInWorkflowStep(template: import("./types.js").WorkflowStepTemplate): import("./types.js").WorkflowStep {
    const now = new Date().toISOString();
    return {
      id: template.id,
      templateId: template.id,
      name: template.name,
      description: template.description,
      mode: "prompt",
      phase: "pre-merge",
      gateMode: "advisory",
      prompt: template.prompt,
      toolMode: template.toolMode || "readonly",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  private toStoredWorkflowStep(row: {
    id: string;
    templateId: string | null;
    name: string;
    description: string;
    mode: string;
    phase: string | null;
    gateMode: string | null;
    prompt: string;
    toolMode: string | null;
    scriptName: string | null;
    enabled: number;
    defaultOn: number | null;
    modelProvider: string | null;
    modelId: string | null;
    migrated_fragment_id?: string | null;
    createdAt: string;
    updatedAt: string;
  }): import("./types.js").WorkflowStep {
    return {
      id: row.id,
      templateId: row.templateId ?? undefined,
      name: row.name,
      description: row.description,
      mode: row.mode === "script" ? "script" : "prompt",
      phase: row.phase === "post-merge" ? "post-merge" : "pre-merge",
      gateMode: row.gateMode === "advisory" || row.gateMode === "gate"
        ? row.gateMode
        : "advisory",
      prompt: row.prompt || "",
      toolMode: row.toolMode === "coding" || row.toolMode === "readonly" ? row.toolMode : undefined,
      scriptName: row.scriptName ?? undefined,
      enabled: Boolean(row.enabled),
      defaultOn: row.defaultOn === null || row.defaultOn === undefined ? undefined : Boolean(row.defaultOn),
      modelProvider: row.modelProvider ?? undefined,
      modelId: row.modelId ?? undefined,
      migratedFragmentId: row.migrated_fragment_id ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private getLegacyWorkflowStepSnapshot(id: string, templateId?: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare("SELECT workflowSteps FROM config WHERE id = 1")
      .get() as { workflowSteps?: string | null } | undefined;
    const legacySteps = fromJson<Array<Record<string, unknown>>>(row?.workflowSteps);
    if (!Array.isArray(legacySteps)) {
      return undefined;
    }

    return legacySteps.find((legacy) => {
      if (!legacy || typeof legacy !== "object") return false;
      if (legacy.id === id) return true;
      return Boolean(templateId && legacy.templateId === templateId);
    });
  }

  private applyLegacyWorkflowStepOverrides(step: import("./types.js").WorkflowStep): import("./types.js").WorkflowStep {
    const legacy = this.getLegacyWorkflowStepSnapshot(step.id, step.templateId);
    if (!legacy) {
      return step;
    }

    const normalized = { ...step };
    if (!Object.prototype.hasOwnProperty.call(legacy, "mode")) {
      normalized.mode = "prompt";
    }
    if (!Object.prototype.hasOwnProperty.call(legacy, "phase")) {
      normalized.phase = undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(legacy, "gateMode")) {
      normalized.gateMode = "advisory";
    }

    return normalized;
  }

  private async ensureWorkflowStepForTemplate(templateId: string): Promise<import("./types.js").WorkflowStep> {
    const template = this.getBuiltInWorkflowTemplate(templateId);
    if (!template) {
      throw new Error(`Workflow step template '${templateId}' not found`);
    }

    const existing = await this.getWorkflowStep(templateId);
    if (existing && existing.id !== templateId) {
      return existing;
    }

    const allSteps = await this.listWorkflowSteps();
    const byName = allSteps.find((step) => step.name.toLowerCase() === template.name.toLowerCase());
    if (byName) {
      return byName;
    }

    return this.createWorkflowStep({
      templateId: template.id,
      name: template.name,
      description: template.description,
      mode: "prompt",
      phase: "pre-merge",
      prompt: template.prompt,
      gateMode: "advisory",
      toolMode: template.toolMode || "readonly",
      enabled: true,
    });
  }

  private async resolveEnabledWorkflowSteps(stepIds?: string[]): Promise<string[] | undefined> {
    if (!stepIds?.length) return undefined;

    const resolved: string[] = [];
    const seen = new Set<string>();

    for (const rawId of stepIds) {
      const stepId = rawId.trim();
      if (!stepId) continue;

      if (stepId.startsWith("plugin:")) {
        if (!seen.has(stepId)) {
          seen.add(stepId);
          resolved.push(stepId);
        }
        continue;
      }

      const template = this.getBuiltInWorkflowTemplate(stepId);
      const resolvedId = template
        ? (await this.ensureWorkflowStepForTemplate(stepId)).id
        : stepId;

      if (!seen.has(resolvedId)) {
        seen.add(resolvedId);
        resolved.push(resolvedId);
      }
    }

    return resolved.length > 0 ? resolved : undefined;
  }

  private async buildActiveTaskDependencyLookup(overrides?: Map<string, readonly string[]>): Promise<Map<string, readonly string[]>> {
    const tasks = await this.listTasks({ includeArchived: false });
    const lookup = new Map<string, readonly string[]>();
    for (const task of tasks) {
      lookup.set(task.id, task.dependencies ?? []);
    }
    if (overrides) {
      for (const [taskId, deps] of overrides.entries()) {
        lookup.set(taskId, deps);
      }
    }
    return lookup;
  }

  private recordDependencyCycleRejectedAudit(
    taskId: string,
    cyclePath: readonly string[],
    source: "createTask" | "createTaskWithReservedId" | "updateTask" | "replication",
  ): void {
    this.insertRunAuditEventRow({
      taskId,
      domain: "database",
      mutationType: source === "replication" ? "task:dependency-cycle-rejected-replication" : "task:dependency-cycle-rejected",
      target: taskId,
      metadata: { taskId, cyclePath, source },
    });
  }

  private async assertNoDependencyCycle(
    taskId: string,
    dependencies: readonly string[],
    source: "createTask" | "createTaskWithReservedId" | "updateTask" | "replication",
    overrides?: Map<string, readonly string[]>,
  ): Promise<void> {
    if (dependencies.length === 0 && !overrides) return;
    const lookup = await this.buildActiveTaskDependencyLookup(overrides);
    const cyclePath = detectDependencyCycle(taskId, dependencies, (candidateId) => lookup.get(candidateId));
    if (!cyclePath) return;
    this.recordDependencyCycleRejectedAudit(taskId, cyclePath, source);
    if (source === "replication") {
      storeLog.warn("Skipping replicated task create due to dependency cycle", { taskId, cyclePath });
      return;
    }
    throw new DependencyCycleError(taskId, cyclePath);
  }
  async createTask(
    input: TaskCreateInput,
    options?: {
      onSummarize?: (description: string) => Promise<string | null>;
      settings?: { autoSummarizeTitles?: boolean };
      invokeTaskCreatedHook?: boolean;
    }
  ): Promise<Task> {
    if (!input.description?.trim()) {
      throw new Error("Description is required and cannot be empty");
    }

    const selfDefeatingDep = detectSelfDefeatingDependency(input.title, input.dependencies ?? []);
    if (selfDefeatingDep) {
      throw new SelfDefeatingDependencyError(
        input.title?.trim() ?? "",
        selfDefeatingDep.matchedVerb,
        selfDefeatingDep.operandTaskId,
      );
    }

    let resolvedSettings = options?.settings;
    if (!resolvedSettings) {
      try {
        resolvedSettings = await this.getSettings();
      } catch {
        resolvedSettings = {};
      }
    }

    let onSummarize = options?.onSummarize;
    if (!onSummarize && (resolvedSettings?.autoSummarizeTitles === true || input.summarize === true)) {
      // Resolve a store-managed summarizer whenever title summarization is explicitly
      // requested on this create call (agent tools set `summarize: true`) or globally
      // enabled via autoSummarizeTitles. The title-summarizer model lanes MOVED to
      // workflow settings (U4/KTD-7).
      // At task-creation time there is no task/workflow yet, so resolve the
      // project DEFAULT workflow's effective settings (unset default normalizes to
      // builtin:coding) and overlay them so the moved lane reads from its new home;
      // the global `titleSummarizerGlobal*` lane in `resolvedSettings` remains the
      // fallback below.
      let summarizerSettings: Partial<Settings> = resolvedSettings ?? {};
      try {
        const defaultWorkflowId = (await this.getDefaultWorkflowId()) ?? "builtin:coding";
        const effective = await resolveEffectiveSettingsById(
          this,
          defaultWorkflowId,
          this.getWorkflowSettingsProjectId(),
        );
        summarizerSettings = { ...summarizerSettings, ...(effective as Partial<Settings>) };
      } catch {
        // Never-throw: fall back to the base settings (global lane only).
      }
      const summarizerModel = resolveTitleSummarizerSettingsModel(summarizerSettings);
      if (summarizerModel.provider && summarizerModel.modelId) {
        onSummarize = async (description: string) => {
          try {
            return await summarizeTitle(
              description,
              this.getRootDir(),
              summarizerModel.provider,
              summarizerModel.modelId,
            );
          } catch {
            return null;
          }
        };
      }
    }

    // Determine if we should try to summarize the title
    const title = input.title?.trim() || undefined;
    const shouldSummarize =
      !title &&
      input.description.length > 200 &&
      (input.summarize === true || resolvedSettings?.autoSummarizeTitles === true);
    const hasPendingSummarization = shouldSummarize && typeof onSummarize === "function";
    const shouldInvokeTaskCreatedHook = options?.invokeTaskCreatedHook !== false;

    // Determine enabledWorkflowSteps: explicit input takes precedence, otherwise auto-apply default-on steps
    let resolvedWorkflowSteps: string[] | undefined = input.enabledWorkflowSteps?.length
      ? await this.resolveEnabledWorkflowSteps(input.enabledWorkflowSteps)
      : undefined;

    // When a project default workflow is configured, new tasks inherit it
    // (compiled to steps) ahead of the legacy default-on step behavior.
    let pendingWorkflowSelection: { workflowId: string; stepIds: string[] } | undefined;
    // U6/R3/KTD-4: an explicit create-time workflowId beats the project default.
    // `null` is an explicit opt-out (no workflow), `string` materializes that
    // workflow, `undefined` falls through to the default-workflow behavior below.
    // Explicit enabledWorkflowSteps still wins over workflowId for trusted callers.
    const explicitWorkflowId =
      input.enabledWorkflowSteps === undefined ? input.workflowId : undefined;
    if (explicitWorkflowId !== undefined) {
      if (explicitWorkflowId === null) {
        // Explicit "No workflow": skip default materialization entirely.
        resolvedWorkflowSteps = undefined;
      } else {
        // Compile + materialize up front so unknown/fragment ids throw BEFORE
        // the task row is created (no orphaned steps, no half-created task).
        const selected = await this.materializeExplicitWorkflowSteps(explicitWorkflowId);
        resolvedWorkflowSteps = selected.stepIds;
        pendingWorkflowSelection = selected;
      }
    } else if (input.enabledWorkflowSteps === undefined) {
      try {
        const inherited = await this.materializeDefaultWorkflowSteps();
        if (inherited) {
          resolvedWorkflowSteps = inherited.stepIds;
          pendingWorkflowSelection = inherited;
        }
      } catch (err) {
        storeLog.warn("Failed to apply default workflow during task creation; falling back to default-on steps", {
          phase: "createTask:default-workflow",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (resolvedWorkflowSteps === undefined) {
        try {
          const allSteps = await this.listWorkflowSteps();
          const defaultOnSteps = allSteps
            .filter((ws) => ws.enabled && ws.defaultOn)
            .map((ws) => ws.id);
          if (defaultOnSteps.length > 0) {
            resolvedWorkflowSteps = defaultOnSteps;
          }
        } catch (err) {
          storeLog.warn("Failed to auto-apply default workflow steps during task creation; auto-defaulting skipped", {
            phase: "createTask:workflow-auto-default",
            skippedAutoDefaulting: true,
            error: err instanceof Error ? err.message : String(err),
            descriptionLength: input.description.length,
          });
        }
      }
    } else if (input.enabledWorkflowSteps.length === 0) {
      resolvedWorkflowSteps = undefined;
    }

    let task: Task;
    try {
      task = await this.createTaskWithDistributedReservation(input, {
        createTaskWithId: async (taskId) => {
          await this.assertNoDependencyCycle(taskId, input.dependencies ?? [], "createTask");
          return this._createTaskInternal(
            input,
            title,
            resolvedWorkflowSteps,
            taskId,
            { invokeTaskCreatedHook: shouldInvokeTaskCreatedHook && !hasPendingSummarization },
          );
        },
      });
    } catch (err) {
      // The task row was never created, so any default-workflow steps we
      // materialized above would orphan with no task/selection pointing at them.
      this.cleanupOrphanedMaterializedSteps(pendingWorkflowSelection?.stepIds);
      throw err;
    }

    // Record the inherited workflow selection now that the task row exists.
    if (pendingWorkflowSelection) {
      try {
        this.writeTaskWorkflowSelection(task.id, pendingWorkflowSelection.workflowId, pendingWorkflowSelection.stepIds);
      } catch (err) {
        storeLog.warn("Failed to record inherited workflow selection", {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (hasPendingSummarization && shouldInvokeTaskCreatedHook) {
      const id = task.id;
      Promise.resolve().then(async () => {
        try {
          const generatedTitle = await onSummarize!(input.description);
          const sanitizedTitle = sanitizeTitle(generatedTitle);
          if (sanitizedTitle) {
            await this.trackDeferredTaskCreatedWork(async () => {
              if (this.closing) return;
              const currentTask = this.readTaskFromDb(id);
              if (currentTask && !currentTask.title) {
                // FN-5077: normalizeTitleForTaskId may return null for dangling fragments; only persist usable titles.
                const normalizedTitle = normalizeTitleForTaskId(sanitizedTitle, id);
                if (normalizedTitle.title && !this.closing) {
                  await this.updateTask(id, { title: normalizedTitle.title });
                }
              }
            });
          }
        } catch (err) {
          const autoEnabled = resolvedSettings?.autoSummarizeTitles === true;
          const errorMessage = err instanceof Error ? err.message : String(err);
          storeLog.warn(
            `Title summarization failed for task ${id}: ${errorMessage} (desc length: ${input.description.length}, auto-summarize: ${autoEnabled})`,
            {
              taskId: id,
              descriptionLength: input.description.length,
              autoSummarizeEnabled: autoEnabled,
              error: errorMessage,
            },
          );
        }

        await this.trackDeferredTaskCreatedWork(async () => {
          if (this.closing) return;
          let latestTask = task;
          try {
            const refreshed = this.readTaskFromDb(id);
            if (refreshed) latestTask = refreshed;
          } catch {
            // Best-effort refresh; fall back to original task snapshot.
          }

          if (this.closing) return;
          try {
            await this.invokeTaskCreatedHook(latestTask);
          } catch (err) {
            storeLog.warn("Deferred task-created hook failed", {
              taskId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }).catch((err) => {
        const autoEnabled = resolvedSettings?.autoSummarizeTitles === true;
        storeLog.error("Unexpected title summarization promise-chain failure", {
          taskId: id,
          descriptionLength: input.description.length,
          autoSummarizeEnabled: autoEnabled,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return task;
  }

  async createTaskWithReservedId(
    input: TaskCreateInput,
    options: {
      taskId: string;
      createdAt?: string;
      updatedAt?: string;
      prompt?: string;
      applyDefaultWorkflowSteps?: boolean;
      invokeTaskCreatedHook?: boolean;
    },
  ): Promise<Task> {
    if (!input.description?.trim()) {
      throw new Error("Description is required and cannot be empty");
    }

    const selfDefeatingDep = detectSelfDefeatingDependency(input.title, input.dependencies ?? []);
    if (selfDefeatingDep) {
      throw new SelfDefeatingDependencyError(
        input.title?.trim() ?? "",
        selfDefeatingDep.matchedVerb,
        selfDefeatingDep.operandTaskId,
      );
    }

    const id = options.taskId.trim();
    if (!id) {
      throw new Error("taskId is required");
    }

    await this.assertNoDependencyCycle(id, input.dependencies ?? [], "createTaskWithReservedId");

    this.maybeResolveTombstonedTaskId(id, input, "createTask");
    this.assertTaskIdAvailable(id);

    const title = input.title?.trim() || undefined;
    let resolvedWorkflowSteps: string[] | undefined = input.enabledWorkflowSteps?.length
      ? await this.resolveEnabledWorkflowSteps(input.enabledWorkflowSteps)
      : undefined;

    let pendingWorkflowSelection: { workflowId: string; stepIds: string[] } | undefined;
    // U6/R3/KTD-4: an explicit create-time workflowId beats the project default,
    // mirroring createTask(). `null` is an explicit opt-out, `string` materializes
    // that workflow, `undefined` falls through to the default-workflow behavior.
    // Explicit enabledWorkflowSteps still wins over workflowId for trusted callers.
    const explicitWorkflowId =
      input.enabledWorkflowSteps === undefined ? input.workflowId : undefined;
    if (explicitWorkflowId !== undefined) {
      if (explicitWorkflowId === null) {
        // Explicit "No workflow": skip default materialization entirely.
        resolvedWorkflowSteps = undefined;
      } else {
        // Compile + materialize up front so unknown/fragment ids throw BEFORE
        // the task row is created (no orphaned steps, no half-created task).
        const selected = await this.materializeExplicitWorkflowSteps(explicitWorkflowId);
        resolvedWorkflowSteps = selected.stepIds;
        pendingWorkflowSelection = selected;
      }
    } else if (input.enabledWorkflowSteps === undefined && options.applyDefaultWorkflowSteps !== false) {
      // Mirror createTask: a configured project default workflow takes
      // precedence over legacy default-on steps on this creation path too.
      try {
        const inherited = await this.materializeDefaultWorkflowSteps();
        if (inherited) {
          resolvedWorkflowSteps = inherited.stepIds;
          pendingWorkflowSelection = inherited;
        }
      } catch (err) {
        storeLog.warn("Failed to apply default workflow during reserved task creation; falling back to default-on steps", {
          phase: "createTaskWithReservedId:default-workflow",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (resolvedWorkflowSteps === undefined) {
        try {
          const allSteps = await this.listWorkflowSteps();
          const defaultOnSteps = allSteps
            .filter((ws) => ws.enabled && ws.defaultOn)
            .map((ws) => ws.id);
          if (defaultOnSteps.length > 0) {
            resolvedWorkflowSteps = defaultOnSteps;
          }
        } catch (err) {
          storeLog.warn("Failed to auto-apply default workflow steps during reserved task creation; auto-defaulting skipped", {
            phase: "createTaskWithReservedId:workflow-auto-default",
            skippedAutoDefaulting: true,
            error: err instanceof Error ? err.message : String(err),
            descriptionLength: input.description.length,
          });
        }
      }
    } else if (Array.isArray(input.enabledWorkflowSteps) && input.enabledWorkflowSteps.length === 0) {
      resolvedWorkflowSteps = undefined;
    }

    let createdTask: Task;
    try {
      createdTask = await this._createTaskInternal(input, title, resolvedWorkflowSteps, id, {
        createdAt: options.createdAt,
        updatedAt: options.updatedAt,
        promptOverride: options.prompt,
        invokeTaskCreatedHook: options.invokeTaskCreatedHook,
      });
    } catch (err) {
      // The task row was never created, so any default-workflow steps we
      // materialized above would orphan with no task/selection pointing at them.
      this.cleanupOrphanedMaterializedSteps(pendingWorkflowSelection?.stepIds);
      throw err;
    }

    // Record the inherited workflow selection now that the task row exists.
    if (pendingWorkflowSelection) {
      try {
        this.writeTaskWorkflowSelection(createdTask.id, pendingWorkflowSelection.workflowId, pendingWorkflowSelection.stepIds);
      } catch (err) {
        storeLog.warn("Failed to record inherited workflow selection", {
          taskId: createdTask.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return createdTask;
  }

  async applyReplicatedTaskCreate(payload: MeshReplicatedTaskCreatePayload): Promise<MeshReplicatedTaskApplyResult> {
    // Intentionally does not invoke the post-create hook. Replicated tasks mirror
    // state from an origin node; rerunning side effects here (e.g. GitHub issue
    // creation) would duplicate external artifacts.
    // FN-4898: replicated creates route via _createTaskInternal so drift normalization
    // is applied exactly once (same behavior as user-originated writes).
    const existing = this.readTaskFromDb(payload.taskId);
    if (existing) {
      const existingDetail = await this.getTask(payload.taskId);
      if (taskMatchesReplicatedCreate(existingDetail, payload)) {
        return { task: existingDetail, applied: false };
      }
      throw replicationCollisionError(payload.taskId);
    }

    if (payload.input.dependencies?.includes(payload.taskId)) {
      this.recordDependencyCycleRejectedAudit(payload.taskId, [payload.taskId, payload.taskId], "replication");
      storeLog.warn("Skipping replicated task create due to self dependency", { taskId: payload.taskId });
      return { task: payload.input as Task, applied: false };
    }

    const lookup = await this.buildActiveTaskDependencyLookup(new Map([[payload.taskId, payload.input.dependencies ?? []]]));
    const replicationCycle = detectDependencyCycle(payload.taskId, payload.input.dependencies ?? [], (candidateId) => lookup.get(candidateId));
    if (replicationCycle) {
      this.recordDependencyCycleRejectedAudit(payload.taskId, replicationCycle, "replication");
      storeLog.warn("Skipping replicated task create due to dependency cycle", { taskId: payload.taskId, cyclePath: replicationCycle });
      return { task: payload.input as Task, applied: false };
    }

    const task = await this.createTaskWithReservedId(payload.input, {
      taskId: payload.taskId,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      prompt: payload.prompt,
      applyDefaultWorkflowSteps: false,
      invokeTaskCreatedHook: false,
    });

    return { task, applied: true };
  }

  /**
   * Internal helper for task creation. Used by createTask() and potentially other
   * internal methods that need to create tasks without triggering summarization.
   */
  private async _createTaskInternal(
    input: TaskCreateInput,
    title: string | undefined,
    resolvedWorkflowSteps: string[] | undefined,
    id: string,
    options?: {
      createdAt?: string;
      updatedAt?: string;
      promptOverride?: string;
      invokeTaskCreatedHook?: boolean;
    },
  ): Promise<Task> {
    const now = options?.createdAt ?? new Date().toISOString();
    // FN-5077: null normalized titles are treated as "no title" and allow standard fallback/summarization behavior.
    const normalizedTitle = normalizeTitleForTaskId(title, id);
    const task: Task = {
      id,
      lineageId: input.lineageId ?? generateTaskLineageId(),
      title: normalizedTitle.title ?? undefined,
      description: input.description,
      priority: normalizeTaskPriority(input.priority),
      tokenUsage: input.tokenUsage,
      sourceIssue: input.sourceIssue,
      githubTracking: input.githubTracking,
      sourceType: input.source?.sourceType ?? "unknown",
      sourceAgentId: input.source?.sourceAgentId,
      sourceRunId: input.source?.sourceRunId,
      sourceSessionId: input.source?.sourceSessionId,
      sourceMessageId: input.source?.sourceMessageId,
      sourceParentTaskId: input.source?.sourceParentTaskId,
      sourceMetadata: withTaskBranchContextInSourceMetadata(input.source?.sourceMetadata, input.branchContext),
      branchContext: input.branchContext,
      autoMerge: input.autoMerge,
      autoMergeProvenance: input.autoMerge === undefined ? undefined : "user",
      column: input.column || "triage",
      dependencies: input.dependencies || [],
      breakIntoSubtasks: input.breakIntoSubtasks === true ? true : undefined,
      noCommitsExpected: input.noCommitsExpected === true ? true : undefined,
      enabledWorkflowSteps: resolvedWorkflowSteps,
      modelPresetId: input.modelPresetId,
      assignedAgentId: input.assignedAgentId,
      assigneeUserId: input.assigneeUserId,
      scopeOverride: input.scopeOverride === true ? true : undefined,
      scopeOverrideReason: input.scopeOverrideReason,
      nodeId: input.nodeId,
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      validatorModelProvider: input.validatorModelProvider,
      validatorModelId: input.validatorModelId,
      planningModelProvider: input.planningModelProvider,
      planningModelId: input.planningModelId,
      thinkingLevel: input.thinkingLevel,
      reviewLevel: input.reviewLevel,
      executionMode: input.executionMode,
      baseBranch: input.baseBranch,
      branch: input.branch,
      missionId: input.missionId,
      sliceId: input.sliceId,
      steps: [],
      currentStep: 0,
      log: [{ timestamp: now, action: "Task created" }],
      columnMovedAt: now,
      createdAt: now,
      updatedAt: options?.updatedAt ?? now,
    };

    if (normalizedTitle.changed) {
      task.log.push({
        timestamp: now,
        action: "Title normalized: stripped legacy task-id reference",
      });
      const removed = extractTaskIdTokens(title ?? "").filter((token) => token !== id.toUpperCase());
      storeLog.log(`[title-id-drift] normalized title for ${id}: removed=[${removed.join(",")}]`);
    }

    this.maybeResolveTombstonedTaskId(id, input, "createTask");
    this.assertTaskIdAvailable(id);

    const dir = this.taskDir(id);
    await this.atomicCreateTaskJson(dir, task, "createTask");

    // Update cache if watcher is active
    if (this.isWatching) this.taskCache.set(id, { ...task });

    const prompt = options?.promptOverride
      ?? (task.column === "triage"
        ? buildBootstrapPrompt(id, task.title, task.description)
        : this.generateSpecifiedPrompt(task));
    const validation = validateFileScopeInPromptContent(prompt);
    if (validation.invalid.length > 0) {
      if (this.isWatching) this.taskCache.delete(id);
      this.deleteTaskById(id);
      const { rm } = await import("node:fs/promises");
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
      }
      throw new InvalidFileScopeError(id, validation.invalid);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), prompt);

    await this._maybeAutoArchiveSameAgentDuplicate(task, input);

    this.emitTaskLifecycleEventSafely("task:created", [task]);
    if (options?.invokeTaskCreatedHook !== false) {
      await this.invokeTaskCreatedHook(task);
    }
    return task;
  }

  private async _maybeAutoArchiveSameAgentDuplicate(task: Task, input: TaskCreateInput): Promise<void> {
    const sourceAgentId = task.sourceAgentId ?? null;
    const sourceParentTaskId = task.sourceParentTaskId ?? null;
    // Need at least one provenance handle to scope the dedup check.
    if (!sourceAgentId && !sourceParentTaskId) return;

    try {
      const nowMs = Date.now();
      const recent = (await this.listTasks({ slim: true, includeArchived: false })).filter((candidate) => {
        if (candidate.id === task.id) return false;
        const createdMs = Date.parse(candidate.createdAt);
        if (Number.isNaN(createdMs)) return false;
        if (createdMs < nowMs - 24 * 60 * 60 * 1000) return false;
        const agentMatch = sourceAgentId != null && candidate.sourceAgentId === sourceAgentId;
        const parentMatch = sourceParentTaskId != null && candidate.sourceParentTaskId === sourceParentTaskId;
        return agentMatch || parentMatch;
      });

      const settings = await this.getSettings();
      const stickyWindowDays = Math.max(0, settings.tombstoneStickyWindowDays ?? 7);
      let tombstonedCandidates: Array<{
        id: string;
        title: string | null;
        description: string;
        column: Column;
        createdAt: string;
        sourceAgentId: string | null;
        deletedAt: string;
        allowResurrection: number | null;
      }> = [];

      if (stickyWindowDays > 0) {
        try {
          const cutoffIso = new Date(nowMs - stickyWindowDays * 24 * 60 * 60 * 1000).toISOString();
          tombstonedCandidates = this.db.prepare(`
            SELECT id, title, description, "column", createdAt, sourceAgentId, deletedAt, allowResurrection
              FROM tasks
             WHERE deletedAt IS NOT NULL
               AND deletedAt >= ?
               AND sourceAgentId = ?
               AND id != ?
          `).all(cutoffIso, sourceAgentId, task.id) as typeof tombstonedCandidates;
        } catch (error) {
          storeLog.warn(`FN-5233 tombstone candidate widening failed open for ${task.id}: ${getErrorMessage(error)}`);
        }
      }

      const matches = findSameAgentDuplicates(
        {
          title: input.title ?? task.title,
          description: input.description,
          sourceParentTaskId,
        },
        [
          ...recent.map((candidate) => ({
            id: candidate.id,
            title: candidate.title ?? "",
            description: candidate.description,
            column: candidate.column,
            createdAt: Date.parse(candidate.createdAt),
            sourceAgentId: candidate.sourceAgentId ?? null,
            sourceParentTaskId: candidate.sourceParentTaskId ?? null,
            tombstoned: false,
          })),
          ...tombstonedCandidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title ?? "",
            description: candidate.description,
            column: "todo",
            createdAt: Date.parse(candidate.createdAt),
            sourceAgentId: candidate.sourceAgentId,
            sourceParentTaskId: null,
            tombstoned: true,
            deletedAt: candidate.deletedAt,
            allowResurrection: candidate.allowResurrection === 1,
          })),
        ],
        { nowMs, sourceAgentId },
      );

      if (matches.length === 0) return;

      const tombstonedMatch = matches.find((match) => match.tombstoned && match.allowResurrection !== true);
      if (tombstonedMatch?.deletedAt) {
        this.insertRunAuditEventRow({
          taskId: task.id,
          domain: "database",
          mutationType: "intake:resurrection-blocked",
          target: task.id,
          metadata: {
            matchedTaskId: tombstonedMatch.id,
            score: tombstonedMatch.score,
            tombstoneDeletedAt: tombstonedMatch.deletedAt,
            stickyWindowDays,
          },
        });
        if (this.isWatching) this.taskCache.delete(task.id);
        this.deleteTaskById(task.id);
        const { rm } = await import("node:fs/promises");
        const taskDir = this.taskDir(task.id);
        if (existsSync(taskDir)) {
          await rm(taskDir, { recursive: true, force: true });
        }
        throw new TombstonedTaskResurrectionError(
          tombstonedMatch.id,
          tombstonedMatch.deletedAt,
          tombstonedMatch.allowResurrection === true,
        );
      }

      const siblingTaskIds = matches.filter((match) => !match.tombstoned).map((match) => match.id);
      if (siblingTaskIds.length === 0) return;
      const scores = Object.fromEntries(matches.filter((match) => !match.tombstoned).map((match) => [match.id, match.score]));
      await archiveAsSameAgentDuplicate(this, task.id, siblingTaskIds, scores);
      task.column = "archived";
    } catch (error) {
      if (error instanceof TombstonedTaskResurrectionError) {
        throw error;
      }
      storeLog.warn(`FN-4892 same-agent duplicate intake failed open for ${task.id}: ${getErrorMessage(error)}`);
    }
  }

  private async invokeTaskCreatedHook(task: Task): Promise<void> {
    const taskCreatedHook = getTaskCreatedHook();
    if (!taskCreatedHook) return;
    try {
      await taskCreatedHook(task, this);
    } catch (error) {
      storeLog.warn(`[task-created-hook] ${task.id}: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Duplicate an existing task, creating a fresh copy in triage.
   * Copies title and description with source reference, but resets all
   * execution state. The new task will be re-specified by the AI.
   */
  async duplicateTask(id: string): Promise<Task> {
    const sourceTask = await this.getTask(id);
    const now = new Date().toISOString();

    return this.createTaskWithDistributedReservation({ description: sourceTask.description }, {
      createTaskWithId: async (newId) => {
        // FN-5077: duplicated drift-stripped fragments may normalize to null and should remain unset.
        const normalizedTitle = normalizeTitleForTaskId(sourceTask.title, newId);
        if (normalizedTitle.changed) {
          const removed = extractTaskIdTokens(sourceTask.title ?? "").filter((token) => token !== newId.toUpperCase());
          storeLog.log(`[title-id-drift] normalized title for ${newId}: removed=[${removed.join(",")}]`);
        }
        const newTask: Task = {
          id: newId,
          lineageId: generateTaskLineageId(),
          title: normalizedTitle.title ?? undefined,
          description: `${sourceTask.description}\n\n(Duplicated from ${id})`,
          priority: normalizeTaskPriority(sourceTask.priority),
          column: "triage",
          modelPresetId: sourceTask.modelPresetId,
          sourceType: "task_duplicate",
          sourceParentTaskId: id,
          dependencies: [],
          steps: [],
          currentStep: 0,
          log: [{ timestamp: now, action: `Duplicated from ${id}` }],
          columnMovedAt: now,
          createdAt: now,
          updatedAt: now,
          baseBranch: sourceTask.baseBranch,
        };

        this.maybeResolveTombstonedTaskId(newId, {}, "duplicateTask");
        this.assertTaskIdAvailable(newId);

        const newDir = this.taskDir(newId);
        await this.atomicCreateTaskJson(newDir, newTask, "duplicateTask");
        const sanitizedPrompt = sanitizeFileScopeInPromptContent(sourceTask.prompt);
        if (sanitizedPrompt.dropped.length > 0) {
          storeLog.log(`[file-scope-sanitize] duplicate ${newId} from ${id}: dropped=[${sanitizedPrompt.dropped.join(",")}]`);
        }
        await mkdir(newDir, { recursive: true });
        await writeFile(join(newDir, "PROMPT.md"), sanitizedPrompt.sanitized);

        if (this.isWatching) this.taskCache.set(newId, { ...newTask });
        this.emit("task:created", newTask);
        await this.invokeTaskCreatedHook(newTask);
        return newTask;
      },
    });
  }

  /**
   * Create a refinement task from a completed or in-review task.
   * The new task is created in triage with a dependency on the original task.
   * Validates the original is in 'done' or 'in-review' column.
   */
  async refineTask(id: string, feedback: string): Promise<Task> {
    const sourceTask = await this.getTask(id);

    if (sourceTask.column !== "done" && sourceTask.column !== "in-review") {
      throw new Error(
        `Cannot refine ${id}: task is in '${sourceTask.column}', must be in 'done' or 'in-review'`,
      );
    }

    if (!feedback?.trim()) {
      throw new Error("Feedback is required and cannot be empty");
    }

    const now = new Date().toISOString();
    let sourceLabel: string;
    if (sourceTask.title?.trim()) {
      sourceLabel = sourceTask.title.trim();
    } else {
      const firstLine = sourceTask.description
        .split("\n")
        .map((line: string) => line.trim())
        .find((line: string) => line.length > 0);
      sourceLabel = firstLine ? firstLine.replace(/\s+/g, " ") : sourceTask.id;
    }

    return this.createTaskWithDistributedReservation({ description: feedback.trim() }, {
      createTaskWithId: async (newId) => {
        // FN-5077: keep deterministic "Refinement" fallback when normalized refinement label is unusable (null).
        const normalizedTitle = normalizeTitleForTaskId(`Refinement: ${sourceLabel}`, newId);
        if (normalizedTitle.changed) {
          const removed = extractTaskIdTokens(`Refinement: ${sourceLabel}`).filter((token) => token !== newId.toUpperCase());
          storeLog.log(`[title-id-drift] normalized title for ${newId}: removed=[${removed.join(",")}]`);
        }
        const sourceGithubLinked = sourceTask.githubTracking?.enabled === true || Boolean(sourceTask.githubTracking?.issue);
        // FN-5780: refinement should inherit source linking intent so unlinked tasks stay opted out from auto-create defaults.
        const refinementGithubTracking = sourceGithubLinked
          ? {
            enabled: true,
            ...(sourceTask.githubTracking?.repoOverride
              ? { repoOverride: sourceTask.githubTracking.repoOverride }
              : {}),
          }
          : { enabled: false };

        const newTask: Task = {
          id: newId,
          lineageId: generateTaskLineageId(),
          title: normalizedTitle.title ?? "Refinement",
          description: `${feedback.trim()}\n\nRefines: ${id}`,
          priority: normalizeTaskPriority(sourceTask.priority),
          column: "triage",
          dependencies: [id],
          sourceType: "task_refine",
          sourceParentTaskId: id,
          githubTracking: refinementGithubTracking,
          steps: [],
          currentStep: 0,
          log: [{ timestamp: now, action: `Created as refinement of ${id}` }],
          columnMovedAt: now,
          createdAt: now,
          updatedAt: now,
          attachments: sourceTask.attachments ? [...sourceTask.attachments] : undefined,
        };

        this.maybeResolveTombstonedTaskId(newId, {}, "refineTask");
        this.assertTaskIdAvailable(newId);

        const newDir = this.taskDir(newId);
        await this.atomicCreateTaskJson(newDir, newTask, "refineTask");
        const prompt = `# ${newTask.title}\n\n${newTask.description}\n`;
        const sanitizedPrompt = sanitizeFileScopeInPromptContent(prompt);
        await mkdir(newDir, { recursive: true });
        await writeFile(join(newDir, "PROMPT.md"), sanitizedPrompt.sanitized);

        if (sourceTask.attachments && sourceTask.attachments.length > 0) {
          const sourceAttachDir = join(this.taskDir(id), "attachments");
          const targetAttachDir = join(newDir, "attachments");
          await mkdir(targetAttachDir, { recursive: true });
          for (const attachment of sourceTask.attachments) {
            const sourcePath = join(sourceAttachDir, attachment.filename);
            const targetPath = join(targetAttachDir, attachment.filename);
            if (existsSync(sourcePath)) {
              const content = await readFile(sourcePath);
              await writeFile(targetPath, content);
            }
          }
        }

        if (this.isWatching) this.taskCache.set(newId, { ...newTask });
        this.emit("task:created", newTask);
        await this.invokeTaskCreatedHook(newTask);
        return newTask;
      },
    });
  }

  /**
   * Read a task and its prompt content.
   */
  async getTask(id: string, options?: { activityLogLimit?: number; includeDeleted?: boolean }): Promise<TaskDetail> {
    return this.withTaskLock(id, async () => {
      const task = this.readTaskFromDb(id, options);
      if (!task) {
        const archived = this.archiveDb.get(id);
        if (!archived) {
          throw new Error(`Task ${id} not found`);
        }
        const archivedTask = this.archiveEntryToTask(archived, false);
        return {
          ...archivedTask,
          prompt: archived.prompt ?? this.generatePromptFromArchiveEntry(archived),
        };
      }

      const now = Date.now();
      const settings = await this.getSettingsFast();
      const mergeQueuedTaskIds = this.getMergeQueuedTaskIds();
      task.inReviewStall = mergeQueuedTaskIds.has(task.id)
        ? undefined
        : getInReviewStallReason(task, {
          now,
          autoMerge: allowsAutoMergeProcessing(task, settings),
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
      task.inReviewStalled = mergeQueuedTaskIds.has(task.id)
        ? undefined
        : getInReviewStalledSignal(task, {
          now,
          thresholdMs: settings.inReviewStalledThresholdMs,
          autoMerge: allowsAutoMergeProcessing(task, settings),
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
      task.stalledReview = mergeQueuedTaskIds.has(task.id) ? undefined : detectStalledReview(task, { now });
      // Derived at read time only; retrySummary is never persisted to SQLite.
      task.retrySummary = computeRetrySummary(task);

      // Sync steps from PROMPT.md if task.steps is empty
      if (task.steps.length === 0) {
        task.steps = await this.parseStepsFromPrompt(id);
      }

      let prompt = "";
      const promptPath = join(this.taskDir(id), "PROMPT.md");
      if (existsSync(promptPath)) {
        prompt = await readFile(promptPath, "utf-8");
      }

      return { ...task, prompt };
    });
  }

  createBranchGroup(input: BranchGroupCreateInput): BranchGroup {
    // Fix #11: reject injection-shaped branch names at the persistence boundary
    // so they can never reach a downstream git/shell sink (coordinator, merger).
    validateBranchGroupBranchName(input.branchName);
    const now = Date.now();
    const id = this.generateBranchGroupId();
    this.db.prepare(`
      INSERT INTO branch_groups (id, sourceType, sourceId, branchName, worktreePath, autoMerge, prState, prUrl, prNumber, status, createdAt, updatedAt, closedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sourceType,
      input.sourceId,
      input.branchName,
      input.worktreePath ?? null,
      input.autoMerge ? 1 : 0,
      input.prState ?? "none",
      input.prUrl ?? null,
      input.prNumber ?? null,
      input.status ?? "open",
      now,
      now,
      input.closedAt ?? null,
    );
    this.db.bumpLastModified();
    return this.getBranchGroup(id)!;
  }

  getBranchGroup(id: string): BranchGroup | null {
    const row = this.db.prepare(`SELECT * FROM branch_groups WHERE id = ?`).get(id) as BranchGroupRow | undefined;
    return row ? this.rowToBranchGroup(row) : null;
  }

  getBranchGroupBySource(sourceType: BranchGroup["sourceType"], sourceId: string): BranchGroup | null {
    const row = this.db.prepare(`SELECT * FROM branch_groups WHERE sourceType = ? AND sourceId = ?`).get(sourceType, sourceId) as BranchGroupRow | undefined;
    return row ? this.rowToBranchGroup(row) : null;
  }

  getBranchGroupByBranchName(branchName: string): BranchGroup | null {
    const row = this.db.prepare(`SELECT * FROM branch_groups WHERE branchName = ? AND status = 'open' ORDER BY createdAt DESC LIMIT 1`).get(branchName) as BranchGroupRow | undefined;
    return row ? this.rowToBranchGroup(row) : null;
  }

  ensureBranchGroupForSource(
    sourceType: BranchGroup["sourceType"],
    sourceId: string,
    init: Omit<BranchGroupCreateInput, "sourceType" | "sourceId">,
  ): BranchGroup {
    const existing = this.getBranchGroupBySource(sourceType, sourceId);
    if (existing) {
      return existing;
    }

    // `branch_groups.branchName` is globally UNIQUE — a branch is represented by
    // exactly one open group. If another source already owns an open group for
    // this branch, reuse it rather than calling createBranchGroup and violating
    // the UNIQUE constraint. Without this, two missions whose shared base resolves
    // to the same branch (e.g. "main") collide: the throw escapes triageFeature
    // and is swallowed by its callers, silently stranding "defined" features.
    const existingByBranch = this.getBranchGroupByBranchName(init.branchName);
    if (existingByBranch) {
      return existingByBranch;
    }

    return this.createBranchGroup({
      sourceType,
      sourceId,
      ...init,
    });
  }

  listBranchGroups(options?: { status?: BranchGroup["status"] }): BranchGroup[] {
    const rows = options?.status
      ? this.db.prepare(`SELECT * FROM branch_groups WHERE status = ? ORDER BY createdAt ASC`).all(options.status)
      : this.db.prepare(`SELECT * FROM branch_groups ORDER BY createdAt ASC`).all();
    return (rows as BranchGroupRow[]).map((row) => this.rowToBranchGroup(row));
  }

  updateBranchGroup(id: string, patch: BranchGroupUpdate): BranchGroup {
    const current = this.getBranchGroup(id);
    if (!current) {
      throw new Error(`Branch group ${id} not found`);
    }
    // Fix #11: a rename must reject injection-shaped branch names at the same
    // persistence boundary as createBranchGroup, otherwise a crafted ref could
    // still reach the downstream git/PR flow via an update.
    if (patch.branchName !== undefined) {
      validateBranchGroupBranchName(patch.branchName);
    }
    const nextStatus = patch.status ?? current.status;
    const now = Date.now();
    const nextClosedAt = patch.closedAt === null
      ? null
      : patch.closedAt ?? (nextStatus !== "open" && current.status === "open" ? now : current.closedAt ?? null);

    this.db.prepare(`
      UPDATE branch_groups
      SET sourceId = ?, branchName = ?, worktreePath = ?, autoMerge = ?, prState = ?, prUrl = ?, prNumber = ?, status = ?, updatedAt = ?, closedAt = ?
      WHERE id = ?
    `).run(
      patch.sourceId ?? current.sourceId,
      patch.branchName ?? current.branchName,
      patch.worktreePath === null ? null : (patch.worktreePath ?? current.worktreePath ?? null),
      patch.autoMerge === undefined ? (current.autoMerge ? 1 : 0) : (patch.autoMerge ? 1 : 0),
      patch.prState ?? current.prState,
      patch.prUrl === null ? null : (patch.prUrl ?? current.prUrl ?? null),
      patch.prNumber === null ? null : (patch.prNumber ?? current.prNumber ?? null),
      nextStatus,
      now,
      nextClosedAt,
      id,
    );
    this.db.bumpLastModified();
    return this.getBranchGroup(id)!;
  }

  async setTaskBranchGroup(
    taskId: string,
    branchGroupId: string | null,
    options?: { assignmentMode?: TaskBranchAssignmentMode },
  ): Promise<void> {
    await this.withTaskLock(taskId, async () => {
      const dir = this.taskDir(taskId);
      const task = await this.readTaskJson(dir);
      let branchContext: Task["branchContext"];

      if (branchGroupId) {
        const group = this.getBranchGroup(branchGroupId);
        if (!group) {
          throw new Error(`Branch group ${branchGroupId} not found`);
        }
        // Carry the group's actual assignment intent. The BranchGroup row does not
        // persist an assignment mode, so prefer an explicit caller-provided mode,
        // then preserve any existing branchContext.assignmentMode, and only fall
        // back to "shared" when nothing else is known.
        branchContext = {
          groupId: group.id,
          source: group.sourceType,
          assignmentMode: options?.assignmentMode ?? task.branchContext?.assignmentMode ?? "shared",
        };
      }

      task.branchContext = branchContext;
      task.sourceMetadata = withTaskBranchContextInSourceMetadata(task.sourceMetadata, branchContext);
      if (!branchContext && task.sourceMetadata) {
        const nextSourceMetadata = { ...task.sourceMetadata };
        delete nextSourceMetadata[TASK_BRANCH_CONTEXT_METADATA_KEY];
        task.sourceMetadata = Object.keys(nextSourceMetadata).length > 0 ? nextSourceMetadata : undefined;
      }
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(taskId, { ...task });
      this.emit("task:updated", task);
    });
  }

  async listTasksByBranchGroup(groupId: string): Promise<Task[]> {
    const tasks = await this.listTasks({ includeArchived: false, slim: true });
    // Membership filter (incl. legacy synthetic-groupId fallback) is shared with
    // the dashboard list route via `filterTasksByBranchGroup` so semantics can't
    // drift between the two call sites (Fix #8/#9).
    const group = this.getBranchGroup(groupId);
    return filterTasksByBranchGroup(tasks, group, groupId).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  // --- Unified PR entity (PR-lifecycle-as-workflow-nodes, U1) ---

  private rowToPrEntity(row: PrEntityRow): PrEntity {
    return {
      id: row.id,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      repo: row.repo,
      headBranch: row.headBranch,
      baseBranch: row.baseBranch ?? undefined,
      state: row.state,
      prNumber: row.prNumber ?? undefined,
      prUrl: row.prUrl ?? undefined,
      headOid: row.headOid ?? undefined,
      mergeable: (row.mergeable as PrConflictState | null) ?? undefined,
      checksRollup: (row.checksRollup as PrChecksRollup | null) ?? undefined,
      reviewDecision: (row.reviewDecision as PrReviewDecision) ?? undefined,
      autoMerge: Boolean(row.autoMerge),
      unverified: Boolean(row.unverified),
      failureReason: row.failureReason ?? undefined,
      responseRounds: row.responseRounds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      closedAt: row.closedAt ?? undefined,
    };
  }

  private generatePrEntityId(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `PR-${timestamp}-${random}`;
  }

  getPrEntity(id: string): PrEntity | null {
    const row = this.db.prepare(`SELECT * FROM pull_requests WHERE id = ?`).get(id) as PrEntityRow | undefined;
    return row ? this.rowToPrEntity(row) : null;
  }

  /** The single non-terminal entity for a source, if any (matches the partial unique index). */
  getActivePrEntityBySource(sourceType: PrEntity["sourceType"], sourceId: string): PrEntity | null {
    const row = this.db
      .prepare(
        `SELECT * FROM pull_requests
         WHERE sourceType = ? AND sourceId = ? AND state NOT IN ('merged','closed','failed')
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(sourceType, sourceId) as PrEntityRow | undefined;
    return row ? this.rowToPrEntity(row) : null;
  }

  /** The entity owning a concrete GitHub PR number in a repo, if any. */
  getPrEntityByNumber(repo: string, prNumber: number): PrEntity | null {
    const row = this.db
      .prepare(`SELECT * FROM pull_requests WHERE repo = ? AND prNumber = ?`)
      .get(repo, prNumber) as PrEntityRow | undefined;
    return row ? this.rowToPrEntity(row) : null;
  }

  /**
   * Create-or-reuse the non-terminal entity for a source. Reuse is keyed on the
   * source identity (the open-source partial unique index), so re-entry from the
   * pr-create node never mints a second live entity (AE6 idempotency).
   */
  ensurePrEntityForSource(input: PrEntityCreateInput): PrEntity {
    const existing = this.getActivePrEntityBySource(input.sourceType, input.sourceId);
    if (existing) return existing;
    const id = this.generatePrEntityId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pull_requests
           (id, sourceType, sourceId, repo, headBranch, baseBranch, state,
            prNumber, prUrl, autoMerge, unverified, responseRounds, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.sourceType,
        input.sourceId,
        input.repo,
        input.headBranch,
        input.baseBranch ?? null,
        input.state ?? "creating",
        input.prNumber ?? null,
        input.prUrl ?? null,
        input.autoMerge ? 1 : 0,
        input.unverified ? 1 : 0,
        now,
        now,
      );
    this.db.bumpLastModified();
    return this.getPrEntity(id)!;
  }

  updatePrEntity(id: string, patch: PrEntityUpdate): PrEntity {
    const current = this.getPrEntity(id);
    if (!current) throw new Error(`PR entity ${id} not found`);
    const nextState = patch.state ?? current.state;
    const now = Date.now();
    const isTerminal = nextState === "merged" || nextState === "closed";
    const nextClosedAt =
      patch.closedAt === null
        ? null
        : patch.closedAt ?? (isTerminal && current.closedAt === undefined ? now : current.closedAt ?? null);
    const orCurrent = <T>(v: T | null | undefined, cur: T | undefined): T | null =>
      v === null ? null : v ?? cur ?? null;
    this.db
      .prepare(
        `UPDATE pull_requests SET
           state = ?, prNumber = ?, prUrl = ?, headOid = ?, mergeable = ?,
           checksRollup = ?, reviewDecision = ?, autoMerge = ?, unverified = ?,
           failureReason = ?, responseRounds = ?, updatedAt = ?, closedAt = ?
         WHERE id = ?`,
      )
      .run(
        nextState,
        orCurrent(patch.prNumber, current.prNumber),
        orCurrent(patch.prUrl, current.prUrl),
        orCurrent(patch.headOid, current.headOid),
        orCurrent(patch.mergeable, current.mergeable),
        orCurrent(patch.checksRollup, current.checksRollup),
        patch.reviewDecision === undefined ? current.reviewDecision ?? null : patch.reviewDecision,
        patch.autoMerge === undefined ? (current.autoMerge ? 1 : 0) : patch.autoMerge ? 1 : 0,
        patch.unverified === undefined ? (current.unverified ? 1 : 0) : patch.unverified ? 1 : 0,
        orCurrent(patch.failureReason, current.failureReason),
        patch.responseRounds ?? current.responseRounds,
        now,
        nextClosedAt,
        id,
      );
    this.db.bumpLastModified();
    return this.getPrEntity(id)!;
  }

  /** Non-terminal entities (for the reconcile poll set), oldest first. */
  listActivePrEntities(): PrEntity[] {
    const rows = this.db
      .prepare(`SELECT * FROM pull_requests WHERE state NOT IN ('merged','closed','failed') ORDER BY createdAt ASC`)
      .all() as PrEntityRow[];
    return rows.map((r) => this.rowToPrEntity(r));
  }

  // Per-thread response state (R15) — keyed by (entity, threadId, headOid).

  getPrThreadState(prEntityId: string, threadId: string, headOid: string): PrThreadState | null {
    const row = this.db
      .prepare(`SELECT * FROM pull_request_thread_state WHERE prEntityId = ? AND threadId = ? AND headOid = ?`)
      .get(prEntityId, threadId, headOid) as PrThreadStateRow | undefined;
    return row
      ? {
          prEntityId: row.prEntityId,
          threadId: row.threadId,
          headOid: row.headOid,
          outcome: row.outcome,
          fixCommitSha: row.fixCommitSha ?? undefined,
          updatedAt: row.updatedAt,
        }
      : null;
  }

  listPrThreadStates(prEntityId: string): PrThreadState[] {
    const rows = this.db
      .prepare(`SELECT * FROM pull_request_thread_state WHERE prEntityId = ?`)
      .all(prEntityId) as PrThreadStateRow[];
    return rows.map((row) => ({
      prEntityId: row.prEntityId,
      threadId: row.threadId,
      headOid: row.headOid,
      outcome: row.outcome,
      fixCommitSha: row.fixCommitSha ?? undefined,
      updatedAt: row.updatedAt,
    }));
  }

  /** Upsert a per-thread outcome. Persisted AFTER GitHub confirms (R15 commit-last). */
  recordPrThreadOutcome(
    prEntityId: string,
    threadId: string,
    headOid: string,
    outcome: PrThreadOutcome,
    fixCommitSha?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO pull_request_thread_state (prEntityId, threadId, headOid, outcome, fixCommitSha, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (prEntityId, threadId, headOid)
         DO UPDATE SET outcome = excluded.outcome, fixCommitSha = excluded.fixCommitSha, updatedAt = excluded.updatedAt`,
      )
      .run(prEntityId, threadId, headOid, outcome, fixCommitSha ?? null, Date.now());
    this.db.bumpLastModified();
  }

  recordBranchGroupMemberLanded(
    groupId: string,
    patch: { worktreePath?: string | null; status?: BranchGroup["status"] },
  ): BranchGroup {
    return this.updateBranchGroup(groupId, {
      ...(patch.worktreePath !== undefined ? { worktreePath: patch.worktreePath } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
  }

  async getTaskColumns(ids: string[]): Promise<Map<string, Column>> {
    if (ids.length === 0) {
      return new Map();
    }

    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id, "column" FROM tasks WHERE id IN (${placeholders}) AND ${TaskStore.ACTIVE_TASKS_WHERE}`)
      .all(...uniqueIds) as Array<{ id: string; column: Column }>;

    const activeById = new Map<string, Column>();
    for (const row of rows) {
      activeById.set(row.id, row.column);
    }

    const missingIds: string[] = [];
    for (const id of uniqueIds) {
      if (!activeById.has(id)) {
        missingIds.push(id);
      }
    }

    const archivedSet = missingIds.length > 0 ? this.archiveDb.filterArchived(missingIds) : new Set<string>();

    const result = new Map<string, Column>();
    for (const id of uniqueIds) {
      const activeColumn = activeById.get(id);
      if (activeColumn !== undefined) {
        result.set(id, activeColumn);
      } else if (archivedSet.has(id)) {
        result.set(id, "archived");
      }
    }

    return result;
  }

  async listTasks(options?: {
    limit?: number;
    offset?: number;
    /** When false, exclude tasks in the `archived` column. Default: true (backward compatible). */
    includeArchived?: boolean;
    /** When true, omit heavy fields (log, comments, steps, workflowStepResults, steeringComments)
     *  from each row to make list responses cheap for board-style consumers. Detail fields default
     *  to empty arrays in the returned Task objects; use `getTask(id)` to load full data. */
    slim?: boolean;
    /** Restrict to a single column (e.g. 'in-review' for the auto-merge sweep).
     *  Widened to {@link ColumnId} (#1403) so custom-column filters are accepted. */
    column?: ColumnId;
    /** Opt-in startup-only memo for repeated slim reads during boot choreography. */
    startupMemo?: boolean;
  }): Promise<Task[]> {
    const includeArchived = options?.includeArchived ?? true;
    const slim = options?.slim ?? false;
    const columnFilter = options?.column;
    const startupMemoEnabled = options?.startupMemo ?? (!this.isWatching && slim);

    if (startupMemoEnabled && slim && options?.limit === undefined && options?.offset === undefined) {
      const memoKey = `${includeArchived ? "all" : "active"}:${columnFilter ?? "*"}`;
      const now = Date.now();
      const cached = this.startupSlimListMemo.get(memoKey);
      if (cached && cached.expiresAt > now) {
        const memoTasks = await cached.promise;
        return JSON.parse(JSON.stringify(memoTasks)) as Task[];
      }

      const fetchPromise = this.listTasks({ ...options, startupMemo: false });
      this.startupSlimListMemo.set(memoKey, {
        expiresAt: now + TaskStore.STARTUP_SLIM_LIST_MEMO_TTL_MS,
        promise: fetchPromise,
      });
      try {
        const memoTasks = await fetchPromise;
        return JSON.parse(JSON.stringify(memoTasks)) as Task[];
      } catch (error) {
        this.startupSlimListMemo.delete(memoKey);
        throw error;
      }
    }

    // Slim mode drops ONLY the agent log column. On busy boards `log` accounts
    // for ~99% of the row payload (60+ MB across 1200 tasks); every other JSON
    // column combined is under 500 KB and is needed by the board UI:
    //   - `steps`            → step progress badge on TaskCard
    //   - `comments`         → comment count badge on TaskCard
    //   - `workflowStepResults` → workflow status indicators
    //   - `steeringComments` → steering badge
    // Use `getTask(id)` to load the full row (including `log`) for the
    // TaskDetailModal's Activity tab and Agent Log subview.
    const selectClause = this.getTaskSelectClause(slim);
    const whereParts: string[] = [];
    const params: string[] = [];
    whereParts.push(TaskStore.ACTIVE_TASKS_WHERE);
    if (columnFilter) {
      whereParts.push(`"column" = ?`);
      params.push(columnFilter);
    } else if (!includeArchived) {
      whereParts.push(`"column" != 'archived'`);
    }
    const whereClause = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const sql = `SELECT ${selectClause} FROM tasks${whereClause} ORDER BY createdAt ASC`;

    const rows = this.db.prepare(sql).all(...params);
    const now = Date.now();
    const settings = await this.getSettingsFast();
    const staleThresholds: TaskAgeStalenessThresholds = {
      inProgressWarningMs: settings.staleInProgressWarningMs,
      inProgressCriticalMs: settings.staleInProgressCriticalMs,
      inReviewWarningMs: settings.staleInReviewWarningMs,
      inReviewCriticalMs: settings.staleInReviewCriticalMs,
    };
    let disableAgeStalenessHydration = false;
    const mergeQueuedTaskIds = this.getMergeQueuedTaskIds();
    const activeTasks = await Promise.all((rows as unknown as TaskRow[]).map(async (row) => {
      const task = this.rowToTask(row);
      const isMergeQueued = mergeQueuedTaskIds.has(task.id);
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedReview = getStalePausedReviewSignal(task, {
        now,
        thresholdMs: settings.stalePausedReviewThresholdMs,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedTodo = getStalePausedTodoSignal(task, {
        now,
        thresholdMs: settings.stalePausedTodoThresholdMs,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      if (!disableAgeStalenessHydration) {
        try {
          task.ageStaleness = getTaskAgeStalenessSignal(task, {
            now,
            thresholds: staleThresholds,
            engineActiveSinceMs: settings.engineActiveSinceMs,
            engineActivationGraceMs: settings.engineActivationGraceMs,
          });
        } catch (error) {
          if (error instanceof RangeError) {
            disableAgeStalenessHydration = true;
            storeLog.warn("Invalid stale task thresholds; skipping age staleness hydration for this listTasks pass", {
              error: error.message,
            });
          } else {
            throw error;
          }
        }
      }
      task.stalledReview = isMergeQueued ? undefined : detectStalledReview(task, { now });
      // Derived at read time only; retrySummary is never persisted to SQLite.
      task.retrySummary = computeRetrySummary(task);

      // Slim path: aggregate the timed-execution total server-side, then
      // strip the heavy log payload from the wire response. Without this
      // the board card has no way to display the same total-execution
      // figure that the task detail panel shows.
      if (slim) {
        task.timedExecutionMs = this.computeTimedExecutionMs(task.log);
        task.log = [];
      }

      if (!slim || task.steps.length > 0) {
        return task;
      }

      const steps = await this.parseStepsFromPrompt(task.id);
      return steps.length > 0 ? { ...task, steps } : task;
    }));
    const archivedTasks = includeArchived && (!columnFilter || columnFilter === "archived") ? this.archiveDb.list().map((entry) => this.archiveEntryToTask(entry, slim)) : [];
    // FNXC:BoardConsistency 2026-06-21-08:34: FN-6851's cache-sync fix is primary; listTasks still collapses duplicate storage sources so one task ID cannot render in two columns. Active SQLite rows are authoritative over archive snapshots.
    const tasksById = new Map<string, Task>(activeTasks.map((task) => [task.id, task]));
    for (const task of archivedTasks) if (!tasksById.has(task.id)) tasksById.set(task.id, task);
    const tasks = [...tasksById.values()];
    // Sort by createdAt, then by numeric ID suffix for tie-breaking
    const sorted = tasks.sort((a, b) => {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return aNum - bNum;
    });

    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;

    if (limit === undefined) return sorted.slice(offset);
    return sorted.slice(offset, offset + Math.max(0, limit));
  }

  /**
   * Residual B (U13/U9): per-branch progress snapshots for the given tasks,
   * read from the `workflow_run_branches` table. Used to populate the optional
   * additive `branchProgress` field on the board task payload so U9's parallel-
   * window badge can render. Cheap and additive:
   *   - returns an empty map immediately when the table is empty (the common
   *     case — no fan-out runs in flight);
   *   - one query for the whole task batch (no per-card N+1);
   *   - returns only the LATEST run's branches per task (a card is in exactly
   *     one parallel window at a time — KTD-11 one-card-one-position).
   * Never throws on a missing/legacy table (additive guard).
   */
  getBranchProgressByTask(
    taskIds: readonly string[],
  ): Map<string, Array<{ branchId: string; nodeId: string; status: string }>> {
    const result = new Map<string, Array<{ branchId: string; nodeId: string; status: string }>>();
    if (taskIds.length === 0) return result;
    try {
      // Skip entirely when the table has no rows (cheap existence probe).
      const any = this.db
        .prepare("SELECT 1 FROM workflow_run_branches LIMIT 1")
        .get();
      if (!any) return result;

      const placeholders = taskIds.map(() => "?").join(", ");
      // Filter to the latest run per task entirely in SQL (#1413): the
      // correlated subquery resolves the winning (updatedAt, runId) pair per
      // task — MAX(updatedAt) with a deterministic MAX(runId) tie-break — and
      // the JOIN matches both columns so only the latest run's rows are read.
      // The runId tie-break makes ties on updatedAt deterministic instead of
      // letting an arbitrary historical run win.
      const rows = this.db
        .prepare(
          `SELECT b.taskId AS taskId, b.runId AS runId, b.branchId AS branchId,
                  b.currentNodeId AS nodeId, b.status AS status, b.updatedAt AS updatedAt
             FROM workflow_run_branches b
             JOIN (
               -- Resolve the winning run per task: the run owning the row with
               -- the greatest updatedAt, with runId as a deterministic
               -- tie-break when two runs share an updatedAt. Returns the whole
               -- run's rows (all its branches), not just the single max row.
               SELECT taskId, runId AS latestRunId
                 FROM (
                   SELECT taskId, runId,
                          ROW_NUMBER() OVER (
                            PARTITION BY taskId
                            ORDER BY MAX(updatedAt) DESC, runId DESC
                          ) AS rn
                     FROM workflow_run_branches
                    WHERE taskId IN (${placeholders})
                    GROUP BY taskId, runId
                 )
                WHERE rn = 1
             ) latest_run
               ON latest_run.taskId = b.taskId
              AND latest_run.latestRunId = b.runId
            WHERE b.taskId IN (${placeholders})`,
        )
        .all(...taskIds, ...taskIds) as Array<{
          taskId: string;
          runId: string;
          branchId: string;
          nodeId: string;
          status: string;
          updatedAt: string;
        }>;

      for (const row of rows) {
        const list = result.get(row.taskId) ?? [];
        list.push({ branchId: row.branchId, nodeId: row.nodeId, status: row.status });
        result.set(row.taskId, list);
      }
    } catch {
      // Legacy/missing table or query failure — degrade to no branch progress.
      return new Map();
    }
    return result;
  }

  /**
   * Persist (idempotent upsert) one branch's progress for a fan-out run (#1407).
   * Keyed by (taskId, runId, branchId) — the table PK — so re-running the same
   * branch overwrites its single row with the latest currentNodeId/status. The
   * executor's crash-resume reads only `status = 'completed'` rows and skips
   * those nodes, so resume granularity is keyed by the persisted currentNodeId.
   * Additive: silently no-ops on a legacy/missing table.
   */
  saveWorkflowRunBranch(state: {
    taskId: string;
    runId: string;
    branchId: string;
    currentNodeId: string;
    status: string;
  }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO workflow_run_branches
             (taskId, runId, branchId, currentNodeId, status, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(taskId, runId, branchId) DO UPDATE SET
             currentNodeId = excluded.currentNodeId,
             status = excluded.status,
             updatedAt = excluded.updatedAt`,
        )
        .run(
          state.taskId,
          state.runId,
          state.branchId,
          state.currentNodeId,
          state.status,
          new Date().toISOString(),
        );
    } catch {
      // Legacy/missing table — persistence is additive, so degrade silently.
    }
  }

  /** Load persisted branch states for a run (crash-resume; #1407). */
  loadWorkflowRunBranches(
    taskId: string,
    runId: string,
  ): Array<{
    taskId: string;
    runId: string;
    branchId: string;
    currentNodeId: string;
    status: "running" | "completed" | "failed" | "aborted";
  }> {
    try {
      const rows = this.db
        .prepare(
          `SELECT taskId, runId, branchId, currentNodeId, status
             FROM workflow_run_branches
            WHERE taskId = ? AND runId = ?`,
        )
        .all(taskId, runId) as Array<{
          taskId: string;
          runId: string;
          branchId: string;
          currentNodeId: string;
          status: "running" | "completed" | "failed" | "aborted";
        }>;
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * Prune stale branch rows for a task (#1412). Deletes every row for `taskId`
   * whose runId differs from the supplied `keepRunId`, bounding growth across a
   * long-lived task's repeated runs. Called on run start and run completion.
   * Additive: silently no-ops on a legacy/missing table.
   */
  clearWorkflowRunBranches(taskId: string, keepRunId: string): void {
    try {
      this.db
        .prepare(
          `DELETE FROM workflow_run_branches WHERE taskId = ? AND runId != ?`,
        )
        .run(taskId, keepRunId);
    } catch {
      // Legacy/missing table — pruning is additive, so degrade silently.
    }
  }

  /**
   * Persist (idempotent upsert) one step instance's run-state inside a foreach
   * region (step-inversion U4, KTD-6). Keyed by (taskId, runId, foreachNodeId,
   * stepIndex) — the table PK — so re-writing the same instance overwrites its
   * single row with the latest currentNodeId/status/anchors. `updatedAt` is
   * stamped server-side. Mirrors `saveWorkflowRunBranch`: additive, silently
   * no-ops on a legacy/missing table.
   */
  saveWorkflowRunStepInstance(
    state: import("./types.js").WorkflowRunStepInstance,
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO workflow_run_step_instances
             (taskId, runId, foreachNodeId, stepIndex, pinnedStepCount, currentNodeId, status, baselineSha, checkpointId, reworkCount, branchName, integratedAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(taskId, runId, foreachNodeId, stepIndex) DO UPDATE SET
             pinnedStepCount = excluded.pinnedStepCount,
             currentNodeId = excluded.currentNodeId,
             status = excluded.status,
             baselineSha = excluded.baselineSha,
             checkpointId = excluded.checkpointId,
             reworkCount = excluded.reworkCount,
             branchName = excluded.branchName,
             integratedAt = excluded.integratedAt,
             updatedAt = excluded.updatedAt`,
        )
        .run(
          state.taskId,
          state.runId,
          state.foreachNodeId,
          state.stepIndex,
          state.pinnedStepCount,
          state.currentNodeId ?? null,
          state.status,
          state.baselineSha ?? null,
          state.checkpointId ?? null,
          state.reworkCount ?? 0,
          state.branchName ?? null,
          state.integratedAt ?? null,
          new Date().toISOString(),
        );
    } catch {
      // Legacy/missing table — persistence is additive, so degrade silently.
    }
  }

  /**
   * Load persisted step-instance run-state for a run (crash-resume; KTD-6).
   * Ordered by stepIndex so the executor can reconstruct the instance set in
   * step order. Additive: returns [] on a legacy/missing table.
   */
  loadWorkflowRunStepInstances(
    taskId: string,
    runId: string,
  ): import("./types.js").WorkflowRunStepInstance[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT taskId, runId, foreachNodeId, stepIndex, pinnedStepCount, currentNodeId, status, baselineSha, checkpointId, reworkCount, branchName, integratedAt, updatedAt
             FROM workflow_run_step_instances
            WHERE taskId = ? AND runId = ?
            ORDER BY stepIndex ASC`,
        )
        .all(taskId, runId) as import("./types.js").WorkflowRunStepInstance[];
      return rows;
    } catch {
      return [];
    }
  }

  /**
   * Prune step-instance rows for a task (KTD-6, #1412 pattern). When `runId` is
   * provided, deletes every row for `taskId` whose runId differs (bounding growth
   * across a long-lived task's repeated runs — call on run start/completion).
   * When `runId` is omitted, deletes all rows for the task (e.g. on archive).
   * Additive: silently no-ops on a legacy/missing table.
   */
  clearWorkflowRunStepInstances(taskId: string, keepRunId?: string): void {
    try {
      if (keepRunId === undefined) {
        this.db
          .prepare(`DELETE FROM workflow_run_step_instances WHERE taskId = ?`)
          .run(taskId);
      } else {
        this.db
          .prepare(
            `DELETE FROM workflow_run_step_instances WHERE taskId = ? AND runId != ?`,
          )
          .run(taskId, keepRunId);
      }
    } catch {
      // Legacy/missing table — pruning is additive, so degrade silently.
    }
  }

  async listTasksForGithubTrackingReconcile(options?: { offset?: number; limit?: number }): Promise<{ tasks: Task[]; hasMore: boolean }> {
    const reconcileScanLimit = 200;
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = Math.max(0, options?.limit ?? reconcileScanLimit);
    const selectClause = this.getTaskSelectClause(true);

    // FN-5577: GitHub tracking reconciliation must inspect soft-deleted rows,
    // so this query intentionally bypasses ACTIVE_TASKS_WHERE.
    const deletedTotal = this.db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE \"deletedAt\" IS NOT NULL AND \"githubTracking\" IS NOT NULL",
    ).get() as { count: number } | undefined;
    const deletedCount = Number(deletedTotal?.count ?? 0);

    const deletedOffset = Math.min(offset, deletedCount);
    const deletedRows = this.db.prepare(
      `SELECT ${selectClause} FROM tasks WHERE "deletedAt" IS NOT NULL AND "githubTracking" IS NOT NULL ORDER BY updatedAt ASC LIMIT ? OFFSET ?`,
    ).all(limit, deletedOffset) as unknown as TaskRow[];

    const deletedTasks = deletedRows.map((row) => {
      const task = this.rowToTask(row);
      task.timedExecutionMs = this.computeTimedExecutionMs(task.log);
      task.log = [];
      return task;
    });

    let archivedTasks: Task[] = [];
    let archivedCount = 0;
    try {
      const archivedCandidates = this.archiveDb
        .list()
        .map((entry) => this.archiveEntryToTask(entry, true))
        .filter((task) => Boolean(task.githubTracking));

      archivedCount = archivedCandidates.length;
      const archivedOffset = Math.max(0, offset - deletedCount);
      const remainingLimit = Math.max(0, limit - deletedTasks.length);
      archivedTasks = remainingLimit > 0
        ? archivedCandidates.slice(archivedOffset, archivedOffset + remainingLimit)
        : [];
    } catch {
      archivedTasks = [];
      archivedCount = 0;
    }

    const totalCount = deletedCount + archivedCount;
    const hasMore = offset + limit < totalCount;
    return { tasks: [...deletedTasks, ...archivedTasks], hasMore };
  }

  async listStrandedRefinements(options?: {
    freshnessThresholdMs?: number;
  }): Promise<Array<{
    task: Task;
    reasons: Array<"untriaged-stale" | "awaiting-approval" | "failed" | "stuck-killed" | "recovery-backoff">;
    nextRecoveryAt?: string;
    ageMs: number;
  }>> {
    const defaultFreshnessThresholdMs = 10 * 60 * 1000;
    const requestedThresholdMs = options?.freshnessThresholdMs;
    const freshnessThresholdMs = Number.isFinite(requestedThresholdMs) && (requestedThresholdMs ?? 0) >= 0
      ? requestedThresholdMs as number
      : defaultFreshnessThresholdMs;

    const selectClause = this.getTaskSelectClause(false);
    const rows = this.db.prepare(
      `SELECT ${selectClause} FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND "sourceType" = 'task_refine' AND "column" = 'triage' ORDER BY createdAt ASC`,
    ).all() as unknown as TaskRow[];

    const now = Date.now();
    const stranded: Array<{
      task: Task;
      reasons: Array<"untriaged-stale" | "awaiting-approval" | "failed" | "stuck-killed" | "recovery-backoff">;
      nextRecoveryAt?: string;
      ageMs: number;
    }> = [];

    for (const row of rows) {
      const task = this.rowToTask(row);
      if (task.paused) {
        continue;
      }

      const reasons: Array<"untriaged-stale" | "awaiting-approval" | "failed" | "stuck-killed" | "recovery-backoff"> = [];
      const createdAtMs = Date.parse(task.createdAt);
      const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, now - createdAtMs) : 0;

      if (task.status === undefined && ageMs > freshnessThresholdMs) {
        reasons.push("untriaged-stale");
      }
      if (task.status === "awaiting-approval") {
        reasons.push("awaiting-approval");
      }
      if (task.status === "failed") {
        reasons.push("failed");
      }
      if (task.status === "stuck-killed") {
        reasons.push("stuck-killed");
      }
      if (task.nextRecoveryAt) {
        const nextRecoveryAtMs = Date.parse(task.nextRecoveryAt);
        if (Number.isFinite(nextRecoveryAtMs) && nextRecoveryAtMs > now) {
          reasons.push("recovery-backoff");
        }
      }

      if (reasons.length > 0) {
        stranded.push({
          task,
          reasons,
          nextRecoveryAt: task.nextRecoveryAt,
          ageMs,
        });
      }
    }

    return stranded;
  }

  private clearStartupSlimListMemo(): void {
    this.startupSlimListMemo.clear();
  }

  /**
   * List slim task rows with `updatedAt` strictly greater than the cursor.
   *
   * Uses strict `>` cursor semantics (rows where `updatedAt === since` are excluded),
   * returns rows ordered by `updatedAt ASC`, defaults limit to 50, and caps at 200.
   * Archived tasks are excluded by default unless `opts.includeArchived` is true.
   *
   * Callers should re-invoke this method with the last returned task's `updatedAt`
   * as the next `since` cursor.
   */
  async listTasksModifiedSince(
    since: string,
    limit?: number,
    opts?: { includeArchived?: boolean },
  ): Promise<{ tasks: Task[]; hasMore: boolean }> {
    if (Number.isNaN(Date.parse(since))) {
      throw new TypeError("listTasksModifiedSince: invalid since cursor");
    }

    const defaultLimit = 50;
    const resolvedLimit = typeof limit !== "number" || !Number.isFinite(limit)
      ? defaultLimit
      : Math.max(1, Math.min(200, Math.floor(limit)));
    const includeArchived = opts?.includeArchived ?? false;
    const selectClause = this.getTaskSelectClause(true);

    const rows = includeArchived
      ? (this.db.prepare(
        `SELECT ${selectClause} FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND updatedAt > ? ORDER BY updatedAt ASC LIMIT ?`,
      ).all(since, resolvedLimit + 1) as TaskRow[])
      : (this.db.prepare(
        `SELECT ${selectClause} FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND updatedAt > ? AND "column" != 'archived' ORDER BY updatedAt ASC LIMIT ?`,
      ).all(since, resolvedLimit + 1) as TaskRow[]);

    const hasMore = rows.length > resolvedLimit;
    const now = Date.now();
    const settings = await this.getSettingsFast();
    const staleThresholds: TaskAgeStalenessThresholds = {
      inProgressWarningMs: settings.staleInProgressWarningMs,
      inProgressCriticalMs: settings.staleInProgressCriticalMs,
      inReviewWarningMs: settings.staleInReviewWarningMs,
      inReviewCriticalMs: settings.staleInReviewCriticalMs,
    };
    let disableAgeStalenessHydration = false;
    const mergeQueuedTaskIds = this.getMergeQueuedTaskIds();
    const tasks = rows.slice(0, resolvedLimit).map((row) => {
      const task = this.rowToTask(row);
      const isMergeQueued = mergeQueuedTaskIds.has(task.id);
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedReview = getStalePausedReviewSignal(task, {
        now,
        thresholdMs: settings.stalePausedReviewThresholdMs,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedTodo = getStalePausedTodoSignal(task, {
        now,
        thresholdMs: settings.stalePausedTodoThresholdMs,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      if (!disableAgeStalenessHydration) {
        try {
          task.ageStaleness = getTaskAgeStalenessSignal(task, {
            now,
            thresholds: staleThresholds,
            engineActiveSinceMs: settings.engineActiveSinceMs,
            engineActivationGraceMs: settings.engineActivationGraceMs,
          });
        } catch (error) {
          if (error instanceof RangeError) {
            disableAgeStalenessHydration = true;
            storeLog.warn("Invalid stale task thresholds; skipping age staleness hydration for this modified-since pass", {
              error: error.message,
            });
          } else {
            throw error;
          }
        }
      }
      task.timedExecutionMs = this.computeTimedExecutionMs(task.log);
      task.stalledReview = isMergeQueued ? undefined : detectStalledReview(task, { now });
      // Derived at read time only; retrySummary is never persisted to SQLite.
      task.retrySummary = computeRetrySummary(task);
      task.log = [];
      return task;
    });

    return { tasks, hasMore };
  }

  /**
   * Returns the ID of a task currently in an active merge status ("merging" or
   * "merging-pr"), optionally excluding a specific task ID.
   *
   * This is a lightweight database-level check used as a cross-process guard:
   * multiple engine processes share the same SQLite database, but each has its
   * own in-memory merge queue. Without this check, two processes can start
   * merging different tasks simultaneously.
   */
  getActiveMergingTask(excludeTaskId?: string): string | undefined {
    const sql = excludeTaskId
      ? `SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND status IN ('merging', 'merging-pr') AND id != ? LIMIT 1`
      : `SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND status IN ('merging', 'merging-pr') LIMIT 1`;
    const params = excludeTaskId ? [excludeTaskId] : [];
    const row = this.db.prepare(sql).get(...params) as { id: string } | undefined;
    return row?.id;
  }

  /**
   * Search tasks by full-text query across title, ID, description, and comments.
   * Uses SQLite FTS5 for fast tokenized matching with relevance ranking.
   * Falls back to listTasks() for empty/whitespace-only queries.
   *
   * @param query - The search query string
   * @param options - Optional limit and offset for pagination
   */
  async searchTasks(query: string, options?: { limit?: number; offset?: number; slim?: boolean; includeArchived?: boolean }): Promise<Task[]> {
    // Fall back to listTasks for empty/whitespace-only queries
    const trimmedQuery = query?.trim();
    if (!trimmedQuery) {
      return this.listTasks(options);
    }

    // Sanitize query: strip FTS5 operators so both code paths see the same token set
    const sanitizedTokens = trimmedQuery
      .split(/\s+/)
      .filter((token) => token.length > 0)
      .map((token) => token.replace(/["{}:*^+()]/g, ""))
      .filter((token) => token.length > 0);

    if (sanitizedTokens.length === 0) {
      return this.listTasks(options);
    }

    const limit = options?.limit ?? -1;
    const offset = options?.offset ?? 0;
    const offsetClause = offset > 0 ? ` OFFSET ${offset}` : "";
    const includeArchived = options?.includeArchived ?? true;
    const slim = options?.slim ?? false;
    const selectClause = this.getTaskSelectClause(slim, "t");

    let rows: TaskRow[];
    if (this.db.fts5Available) {
      // For FTS5 MATCH, quote tokens that contain special characters like hyphens
      // to prevent them from being interpreted as operators
      // Append `*` to each token for FTS5 prefix matching so partial input
      // (e.g., "frob") matches indexed terms like "frobnicator".
      const ftsQuery = sanitizedTokens
        .map((token) => {
          if (/[":(){}*^+-]/.test(token)) {
            return `"${token.replace(/"/g, '\\"')}"*`;
          }
          return `${token}*`;
        })
        .join(" OR ");
      const whereClause = `${includeArchived ? "" : ` AND t."column" != 'archived'`} AND t."deletedAt" IS NULL`;
      rows = this.db.prepare(`
        SELECT ${selectClause} FROM tasks t
        JOIN tasks_fts fts ON t.rowid = fts.rowid
        WHERE tasks_fts MATCH ?
        ${whereClause}
        ORDER BY rank
        LIMIT ${limit >= 0 ? limit : -1}${offsetClause}
      `).all(ftsQuery) as unknown as TaskRow[];
    } else {
      // LIKE fallback: any token matching any searchable column counts as a hit.
      // Tokens are OR'd; per token we OR across id/title/description/comments.
      // ESCAPE '\\' lets us include user input containing % or _ literally.
      const searchColumns = ["id", "title", "description", "comments"];
      const perTokenClause = `(${searchColumns
        .map((c) => `t."${c}" LIKE ? ESCAPE '\\'`)
        .join(" OR ")})`;
      const whereTokens = sanitizedTokens.map(() => perTokenClause).join(" OR ");
      const params: string[] = [];
      for (const token of sanitizedTokens) {
        const pattern = `%${token.replace(/[\\%_]/g, "\\$&")}%`;
        for (let i = 0; i < searchColumns.length; i++) params.push(pattern);
      }
      const archivedClause = `${includeArchived ? "" : ` AND t."column" != 'archived'`} AND t."deletedAt" IS NULL`;
      rows = this.db.prepare(`
        SELECT ${selectClause} FROM tasks t
        WHERE (${whereTokens})${archivedClause}
        ORDER BY t.createdAt ASC
        LIMIT ${limit >= 0 ? limit : -1}${offsetClause}
      `).all(...params) as unknown as TaskRow[];
    }

    const now = Date.now();
    const settings = await this.getSettingsFast();
    const staleThresholds: TaskAgeStalenessThresholds = {
      inProgressWarningMs: settings.staleInProgressWarningMs,
      inProgressCriticalMs: settings.staleInProgressCriticalMs,
      inReviewWarningMs: settings.staleInReviewWarningMs,
      inReviewCriticalMs: settings.staleInReviewCriticalMs,
    };
    let disableAgeStalenessHydration = false;
    const mergeQueuedTaskIds = this.getMergeQueuedTaskIds();
    const activeMatches = await Promise.all(rows.map(async (row) => {
      const task = this.rowToTask(row);
      const isMergeQueued = mergeQueuedTaskIds.has(task.id);
      task.inReviewStall = isMergeQueued ? undefined : getInReviewStallReason(task, {
        now,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedReview = getStalePausedReviewSignal(task, {
        now,
        thresholdMs: settings.stalePausedReviewThresholdMs,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.inReviewStalled = isMergeQueued ? undefined : getInReviewStalledSignal(task, {
        now,
        thresholdMs: settings.inReviewStalledThresholdMs,
        autoMerge: allowsAutoMergeProcessing(task, settings),
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      task.stalePausedTodo = getStalePausedTodoSignal(task, {
        now,
        thresholdMs: settings.stalePausedTodoThresholdMs,
        engineActiveSinceMs: settings.engineActiveSinceMs,
        engineActivationGraceMs: settings.engineActivationGraceMs,
      });
      if (!disableAgeStalenessHydration) {
        try {
          task.ageStaleness = getTaskAgeStalenessSignal(task, {
            now,
            thresholds: staleThresholds,
            engineActiveSinceMs: settings.engineActiveSinceMs,
            engineActivationGraceMs: settings.engineActivationGraceMs,
          });
        } catch (error) {
          if (error instanceof RangeError) {
            disableAgeStalenessHydration = true;
            storeLog.warn("Invalid stale task thresholds; skipping age staleness hydration for this searchTasks pass", {
              error: error.message,
            });
          } else {
            throw error;
          }
        }
      }

      // Slim path mirrors `listTasks`: aggregate timed execution server-side
      // before stripping the heavy log payload from the wire response.
      if (slim) {
        task.timedExecutionMs = this.computeTimedExecutionMs(task.log);
        task.log = [];
      }

      if (task.steps.length > 0) {
        return task;
      }

      const steps = await this.parseStepsFromPrompt(task.id);
      return steps.length > 0 ? { ...task, steps } : task;
    }));
    const archiveMatches = includeArchived
      ? this.archiveDb.search(trimmedQuery, limit >= 0 ? limit : 100).map((entry) => this.archiveEntryToTask(entry, slim))
      : [];

    const matches = [...activeMatches, ...archiveMatches];
    return limit >= 0 ? matches.slice(0, limit) : matches;
  }

  async findRecentTasksByContentFingerprint(
    fingerprint: string,
    options?: { windowMs?: number; includeArchived?: boolean },
  ): Promise<Task[]> {
    const trimmedFingerprint = fingerprint.trim();
    if (trimmedFingerprint.length === 0) {
      return [];
    }

    const requestedWindowMs = options?.windowMs ?? 60_000;
    const windowMs = Math.max(1, Math.min(300_000, Math.trunc(requestedWindowMs)));
    const cutoffIso = new Date(Date.now() - windowMs).toISOString();
    const includeArchived = options?.includeArchived ?? false;
    const selectClause = this.getTaskSelectClause(false, "t");

    const rows = this.db.prepare(`
      SELECT ${selectClause}
      FROM tasks t
      WHERE t."deletedAt" IS NULL
        AND json_extract(t.sourceMetadata, '$.contentFingerprint') = ?
        AND t.createdAt >= ?
        ${includeArchived ? "" : "AND t.\"column\" != 'archived'"}
      ORDER BY t.createdAt ASC
    `).all(trimmedFingerprint, cutoffIso) as TaskRow[];

    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * FNXC:NearDuplicateDetection 2026-06-14-12:00:
   * FN-6439 requires the store to reconcile persisted duplicate flags after a canonical becomes inactive.
   * sourceMetadataPatch only merges, so this reverse lookup performs a bounded read-modify-write that strips stale near-duplicate keys without pausing or failing the referencing tasks.
   */
  private async clearNearDuplicateReferencesTo(
    canonicalId: string,
    inactiveState: { column?: ColumnId | null; deletedAt?: string | null; reason: string },
  ): Promise<Task[]> {
    if (!isNearDuplicateCanonicalInactive(inactiveState)) {
      return [];
    }

    const selectClause = this.getTaskSelectClause(false, "t");
    const rows = this.db.prepare(`
      SELECT ${selectClause}
      FROM tasks t
      WHERE t."deletedAt" IS NULL
        AND t."column" != 'archived'
        AND t."column" != 'done'
        AND json_extract(t.sourceMetadata, '$.nearDuplicateOf') = ?
      ORDER BY t.createdAt ASC
    `).all(canonicalId) as TaskRow[];

    const updatedTasks: Task[] = [];
    for (const row of rows) {
      const task = this.rowToTask(row);
      const nextSourceMetadata = { ...(task.sourceMetadata ?? {}) };
      delete nextSourceMetadata.nearDuplicateOf;
      delete nextSourceMetadata.nearDuplicateScore;
      delete nextSourceMetadata.nearDuplicateSharedTokens;
      delete nextSourceMetadata.nearDuplicateDismissed;

      task.sourceMetadata = Object.keys(nextSourceMetadata).length > 0 ? nextSourceMetadata : undefined;
      const updatedAt = new Date().toISOString();
      task.updatedAt = updatedAt;
      task.log = [
        ...(task.log ?? []),
        {
          timestamp: updatedAt,
          action: `Near-duplicate canonical ${canonicalId} is now inactive (${inactiveState.reason}); cleared duplicate flag (informational, no decision required)`,
        },
      ];

      this.db.transactionImmediate(() => {
        this.upsertTaskWithFtsRecovery(task);
        this.db.bumpLastModified();
      });
      await this.writeTaskJsonFile(this.taskDir(task.id), task);
      if (this.isWatching) this.taskCache.set(task.id, { ...task });
      this.emit("task:updated", task);
      updatedTasks.push(task);
    }

    return updatedTasks;
  }

  private async clearNearDuplicateReferencesToFailSoft(
    canonicalId: string,
    inactiveState: { column?: ColumnId | null; deletedAt?: string | null; reason: string },
  ): Promise<void> {
    try {
      await this.clearNearDuplicateReferencesTo(canonicalId, inactiveState);
    } catch (error) {
      storeLog.warn("Failed to clear stale near-duplicate references (degraded)", {
        taskId: canonicalId,
        reason: inactiveState.reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getTasksByAssignedAgent(
    agentId: string,
    options?: { pausedOnly?: boolean; excludeArchived?: boolean },
  ): Promise<Task[]> {
    const whereClauses = ["assignedAgentId = ?", TaskStore.ACTIVE_TASKS_WHERE];
    const params: Array<string | number> = [agentId];

    if (options?.pausedOnly) {
      whereClauses.push("paused = 1");
    }

    if (options?.excludeArchived) {
      whereClauses.push('"column" != \'archived\'');
    }

    const selectClause = this.getTaskSelectClause(false);
    const rows = this.db.prepare(`
      SELECT ${selectClause} FROM tasks
      WHERE ${whereClauses.join(" AND ")}
      ORDER BY createdAt ASC
    `).all(...params) as TaskRow[];

    return rows.map((row) => this.rowToTask(row));
  }

  async tryClaimCheckout(
    taskId: string,
    claim: {
      agentId: string;
      nodeId: string;
      runId: string | null;
      leaseEpoch: number;
      renewedAt: string;
    },
    precondition: CheckoutClaimPrecondition,
  ): Promise<{ ok: true; task: Task } | { ok: false; reason: "row_not_found" | "precondition_failed"; current: Task | null }> {
    const current = await this.getTask(taskId);
    if (!current) {
      return { ok: false, reason: "row_not_found", current: null };
    }

    const updateResult = this.db.prepare(`
      UPDATE tasks
      SET
        checkedOutBy = ?,
        checkedOutAt = COALESCE(checkedOutAt, ?),
        checkoutNodeId = ?,
        checkoutRunId = ?,
        checkoutLeaseRenewedAt = ?,
        checkoutLeaseEpoch = ?
      WHERE id = ?
        AND "deletedAt" IS NULL
        AND COALESCE(checkedOutBy, '') = COALESCE(?, '')
        AND COALESCE(checkoutNodeId, '') = COALESCE(?, '')
        AND COALESCE(checkoutLeaseEpoch, 0) = COALESCE(?, 0)
    `).run(
      claim.agentId,
      new Date().toISOString(),
      claim.nodeId,
      claim.runId,
      claim.renewedAt,
      claim.leaseEpoch,
      taskId,
      precondition.expectedCheckedOutBy ?? null,
      precondition.expectedNodeId ?? null,
      precondition.expectedLeaseEpoch ?? 0,
    ) as { changes: number };

    const post = await this.getTask(taskId);
    if (updateResult.changes === 0) {
      return { ok: false, reason: "precondition_failed", current: post };
    }

    if (!post) {
      return { ok: false, reason: "row_not_found", current: null };
    }

    return { ok: true, task: post };
  }

  async renewCheckoutLease(
    taskId: string,
    update: {
      checkoutRunId: string | null;
      checkoutLeaseRenewedAt: string;
    },
  ): Promise<Task> {
    const dir = this.taskDir(taskId);
    let deletedAt: string | undefined;
    let current: Task | undefined;
    this.db.transactionImmediate(() => {
      const row = this.readTaskRowFromDb(taskId, { includeDeleted: true });
      if (row?.deletedAt) {
        deletedAt = row.deletedAt;
        return;
      }

      const result = this.db.prepare(`
        UPDATE tasks
        SET checkoutRunId = ?, checkoutLeaseRenewedAt = ?, updatedAt = ?
        WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}
      `).run(update.checkoutRunId, update.checkoutLeaseRenewedAt, update.checkoutLeaseRenewedAt, taskId) as { changes: number };

      if (result.changes === 0) {
        return;
      }

      this.db.bumpLastModified();
      current = this.readTaskFromDb(taskId);
    });

    if (deletedAt) {
      this.throwSoftDeletedWriteBlocked(taskId, deletedAt, "renewCheckoutLease", {
        timestamp: update.checkoutLeaseRenewedAt,
      });
    }

    if (!current) {
      throw new Error(`Task ${taskId} not found`);
    }

    await this.writeTaskJsonFile(dir, current);
    if (this.isWatching) {
      this.taskCache.set(taskId, { ...current });
    }
    this.emitTaskLifecycleEventSafely("task:updated", [current]);
    return current;
  }

  async selectNextTaskForAgent(
    agentId: string,
    agent?: Pick<Agent, "id" | "role">,
  ): Promise<InboxTask | null> {
    const hasExecutorRoleOverride = (task: Task): boolean => task.sourceMetadata?.executorRoleOverride === true;
    const tasks = await this.listTasks({ slim: true });
    if (tasks.length === 0) {
      return null;
    }

    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const isCheckoutAware = "checkoutTask" in this && typeof (this as Record<string, unknown>).checkoutTask === "function";
    const isDoneLike = (task: Task | undefined) => task?.column === "done" || task?.column === "archived";
    const sortByOldestColumnMove = (a: Task, b: Task) => {
      const aSortAt = a.columnMovedAt ?? a.createdAt;
      const bSortAt = b.columnMovedAt ?? b.createdAt;
      return aSortAt.localeCompare(bSortAt);
    };

    const assignedTasks = tasks.filter((task) => task.assignedAgentId === agentId);

    const inProgress = assignedTasks.filter((task) => task.column === "in-progress").sort(sortByOldestColumnMove);
    if (inProgress.length > 0) {
      return {
        task: inProgress[0],
        priority: "in_progress",
        reason: "Resuming in-progress task assigned to this agent",
      };
    }

    const roleCompatibleAssignedTasks = agent
      ? assignedTasks.filter((task) => {
          if (task.column === "in-progress" || hasExecutorRoleOverride(task)) {
            return true;
          }
          return canAgentTakeImplementationTaskForExplicitRouting(agent, task);
        })
      : assignedTasks;

    const todoCandidates = roleCompatibleAssignedTasks.filter((task) => task.column === "todo" && task.paused !== true);

    const readyTodo = todoCandidates
      .filter((task) => {
        if (isCheckoutAware && task.checkedOutBy && task.checkedOutBy !== agentId) {
          return false;
        }
        return this.areAllDependenciesDone(task.dependencies, tasksById);
      })
      .sort(sortByOldestColumnMove);

    if (readyTodo.length > 0) {
      return {
        task: readyTodo[0],
        priority: "todo",
        reason: "Selecting oldest ready todo task assigned to this agent",
      };
    }

    const actionableBlocked = todoCandidates
      .filter((task) => {
        if (isCheckoutAware && task.checkedOutBy && task.checkedOutBy !== agentId) {
          return false;
        }

        if (this.areAllDependenciesDone(task.dependencies, tasksById)) {
          return false;
        }

        return task.dependencies.some((dependencyId) => isDoneLike(tasksById.get(dependencyId)));
      })
      .sort(sortByOldestColumnMove);

    if (actionableBlocked.length > 0) {
      return {
        task: actionableBlocked[0],
        priority: "blocked",
        reason: "Selecting partially actionable blocked task assigned to this agent",
      };
    }

    return null;
  }

  private areAllDependenciesDone(dependencies: string[], tasksById: Map<string, Task>): boolean {
    return dependencies.every((dependencyId) => {
      const dependency = tasksById.get(dependencyId);
      return dependency?.column === "done" || dependency?.column === "archived";
    });
  }

  private async readTaskForMove(id: string): Promise<Task> {
    const dir = this.taskDir(id);
    try {
      return await this.readTaskJson(dir);
    } catch (error) {
      const archived = this.archiveDb.get(id);
      if (!archived) {
        throw error;
      }
      return this.archiveEntryToTask(archived, false);
    }
  }

  async moveTask(
    id: string,
    toColumn: ColumnId,
    options?: MoveTaskOptions,
  ): Promise<Task> {
    // ColumnId admits workflow-defined custom column ids (KTD-1). Both paths
    // runtime-validate: flag-ON against the task's resolved workflow, flag-OFF
    // via the VALID_TRANSITIONS lookup (non-legacy ids reject as before).
    const movePolicyPreflight = await this.prepareWorkflowMovePolicyPreflight(id, toColumn, options, { fromHandoff: false });
    return this.withTaskLock(id, () => this.moveTaskInternal(id, toColumn, options, { fromHandoff: false, movePolicyPreflight }));
  }

  async handoffToReview(taskId: string, opts: HandoffToReviewOptions): Promise<Task> {
    return this.withTaskLock(taskId, async () => {
      let task: Task;
      try {
        task = await this.readTaskForMove(taskId);
      } catch (error) {
        if (error instanceof TaskDeletedError) {
          const deletedTask = this.readTaskFromDb(taskId, { includeDeleted: true });
          throw new HandoffInvariantViolationError(
            taskId,
            deletedTask?.column ?? "todo",
            `Cannot hand off ${taskId} to in-review because the task is deleted`,
          );
        }
        throw error;
      }

      if (task.column === "archived" || task.deletedAt != null) {
        throw new HandoffInvariantViolationError(
          taskId,
          task.column,
          `Cannot hand off ${taskId} to in-review from ${task.column}`,
        );
      }

      return this.moveTaskInternal(
        taskId,
        "in-review",
        {
          ...opts.moveOptions,
          skipMergeBlocker: true,
          // KTD-9: handoff is an engine/recovery-class move; its skipMergeBlocker
          // maps onto bypassGuards under the flag (identical behavior both paths).
          bypassGuards: true,
        },
        {
          fromHandoff: true,
          runContext: {
            runId: opts.evidence.runId,
            agentId: opts.evidence.agentId,
          },
          ownerAgentId: opts.ownerAgentId,
          evidence: opts.evidence,
          now: opts.now,
        },
        task,
      );
    });
  }

  private resolveWorkflowMoveActor(
    moveSource: NonNullable<MoveTaskOptions["moveSource"]>,
    internal: MoveTaskInternalOptions,
    options?: MoveTaskOptions,
  ): WorkflowMovePolicyInput["actor"] {
    if (options?.workflowMoveActor) return options.workflowMoveActor;
    if (moveSource === "user") return { kind: "human" };
    if (moveSource === "scheduler") return { kind: "system" };
    if (internal.runContext?.agentId) {
      return { kind: "agent", id: internal.runContext.agentId };
    }
    return { kind: "engine" };
  }

  private resolveWorkflowBypassGuards(
    moveSource: NonNullable<MoveTaskOptions["moveSource"]>,
    options?: MoveTaskOptions,
  ): boolean {
    void moveSource;
    return options?.recoveryRehome === true ||
      (options?.bypassGuards ??
        (options?.moveSource === "engine" || options?.moveSource === "scheduler" || options?.skipMergeBlocker === true));
  }

  private shouldSkipWorkflowMovePolicies(params: {
    fromColumn: string;
    toColumn: string;
    moveSource: NonNullable<MoveTaskOptions["moveSource"]>;
    bypassGuards: boolean;
    options?: MoveTaskOptions;
  }): boolean {
    if (params.bypassGuards) return true;
    if (params.options?.recoveryRehome === true) return true;
    return params.moveSource === "user" && params.fromColumn === "in-progress" && params.toColumn === "todo";
  }

  private async prepareWorkflowMovePolicyPreflight(
    id: string,
    toColumn: ColumnId,
    options: MoveTaskOptions | undefined,
    internal: MoveTaskInternalOptions,
  ): Promise<MoveTaskInternalOptions["movePolicyPreflight"]> {
    const task = await this.readTaskForMove(id);
    const moveSource = options?.moveSource ?? "engine";
    const mergedSettingsForMove = await this.getSettingsFast();
    if (!isWorkflowColumnsCompatibilityFlagEnabled(mergedSettingsForMove)) return undefined;
    if (task.column === toColumn) return undefined;

    const workflowIr = this.resolveTaskWorkflowIrSync(id);
    const workflowSignature = serializeWorkflowIr(workflowIr);
    const bypassGuards = this.resolveWorkflowBypassGuards(moveSource, options);
    const fromColumn = task.column;
    if (this.shouldSkipWorkflowMovePolicies({ fromColumn, toColumn, moveSource, bypassGuards, options })) {
      return undefined;
    }

    const recoveryToLegacy =
      options?.recoveryRehome === true && (COLUMNS as readonly string[]).includes(toColumn);
    if (!workflowHasColumn(workflowIr, toColumn) && !recoveryToLegacy) return undefined;

    const allowed = resolveAllowedColumns(workflowIr, fromColumn);
    if (options?.recoveryRehome !== true && !allowed.includes(toColumn)) return undefined;

    await this.evaluateWorkflowMovePolicies({
      task,
      workflow: workflowIr,
      fromColumn,
      toColumn,
      actor: this.resolveWorkflowMoveActor(moveSource, internal, options),
      source: options?.workflowMoveSource ?? moveSource,
      metadata: options?.workflowMoveMetadata,
    });
    return { fromColumn, toColumn, workflowSignature };
  }

  private async evaluateWorkflowMovePolicies(input: WorkflowMovePolicyInput): Promise<void> {
    const policies = getWorkflowExtensionRegistry().list("move-policy");
    for (const definition of policies) {
      const extension = definition.extension;
      if (definition.degraded || extension.kind !== "move-policy" || !extension.evaluate) continue;

      let decision: Awaited<ReturnType<NonNullable<typeof extension.evaluate>>>;
      try {
        decision = await new Promise<Awaited<ReturnType<NonNullable<typeof extension.evaluate>>>>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`timed out after ${WORKFLOW_MOVE_POLICY_TIMEOUT_MS}ms`));
          }, WORKFLOW_MOVE_POLICY_TIMEOUT_MS);
          Promise.resolve(extension.evaluate?.(input))
            .then((value) => {
              clearTimeout(timer);
              resolve(value as Awaited<ReturnType<NonNullable<typeof extension.evaluate>>>);
            })
            .catch((error) => {
              clearTimeout(timer);
              reject(error);
            });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        storeLog.warn("Workflow move-policy extension faulted", {
          phase: "moveTaskInternal:move-policy",
          taskId: input.task.id,
          extensionId: definition.id,
          fallback: extension.fallback,
          error: message,
        });
        if (extension.fallback === "degradeToDefault") {
          getWorkflowExtensionRegistry().degrade([definition.id], "runtime-fault", message);
          continue;
        }
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "guard-rejected",
            "transition.rejected.workflowMovePolicy",
            extension.fallback === "parkNeedsAttention",
            `Move policy '${definition.id}' failed: ${message}`,
          ),
          `Cannot move ${input.task.id} to '${input.toColumn}': move policy '${definition.id}' failed`,
        );
      }

      if (!decision.allowed) {
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "guard-rejected",
            "transition.rejected.workflowMovePolicy",
            true,
            decision.reason,
          ),
          decision.message,
        );
      }
    }
  }

  private async moveTaskInternal(
    id: string,
    toColumn: ColumnId,
    options: MoveTaskOptions | undefined,
    internal: MoveTaskInternalOptions,
    currentTask?: Task,
  ): Promise<Task> {
    const dir = this.taskDir(id);
    const task = currentTask ?? await this.readTaskForMove(id);
    /*
    FNXC:TaskMovement 2026-06-22-18:20:
    Public moveTask calls without an explicit source keep the legacy emitted source of "engine", but they do not inherit workflow guard bypass. Engine, scheduler, handoff, and recovery call sites opt into bypass semantics with an explicit moveSource or skipMergeBlocker.
    */
    const moveSource = options?.moveSource ?? "engine";

    // ── U4: flag-gated workflow-resolved transition path (KTD-8) ─────────────
    // Flag OFF (default): the legacy `VALID_TRANSITIONS` / inline-side-effect
    // path below runs byte-identical (proven by the characterization suite).
    // FNXC:WorkflowColumns 2026-06-22-18:22:
    // The flag-OFF path is still an active compatibility contract for changed-test recovery: it must throw bare Error for invalid legacy moves, persist v1 workflow IR, and support ON→OFF evacuation. Do not route flag-OFF callers through typed workflow-column rejections until the legacy path is intentionally removed.
    // Flag ON: validate against the task's resolved workflow column graph, run
    // sync trait guards (unless bypassed), and route the legacy per-column side
    // effects through the default-workflow trait hooks.
    // `experimentalFeatures` is a global-scoped setting, so the project-only
    // `getSettingsSync()` row would miss it — read merged settings (global +
    // project) via getSettingsFast(). This is an async read taken before the
    // lock-sensitive transaction; it does not touch the task lock.
    const mergedSettingsForMove = await this.getSettingsFast();
    const useWorkflow = isWorkflowColumnsCompatibilityFlagEnabled(mergedSettingsForMove);
    // bypassGuards (KTD-9): engine-sourced moves + the existing skipMergeBlocker
    // call sites map onto it. Capacity (KTD-10) is NEVER bypassed by this — the
    // capacity check is not a guard (U6 fills the enforcement; U4 leaves a
    // pass-through slot). An explicit option value wins; otherwise derive it.
    const bypassGuards = this.resolveWorkflowBypassGuards(moveSource, options);
    const workflowIr: WorkflowIr | undefined = useWorkflow
      ? this.resolveTaskWorkflowIrSync(id)
      : undefined;

    if (task.column === toColumn) {
      if (internal.fromHandoff && toColumn === "in-review") {
        this.db.transactionImmediate(() => {
          const liveRow = this.readTaskFromDb(id, { includeDeleted: true });
          if (liveRow?.deletedAt) {
            throw new HandoffInvariantViolationError(
              id,
              task.column,
              `Cannot hand off ${id} to in-review because the task is deleted`,
            );
          }
          const existing = this.db.prepare("SELECT 1 FROM mergeQueue WHERE taskId = ?").get(id) as { 1: number } | undefined;
          this.insertRunAuditEventRow({
            taskId: id,
            agentId: internal.runContext?.agentId,
            runId: internal.runContext?.runId,
            domain: "database",
            mutationType: "task:move",
            target: id,
            metadata: {
              from: task.column,
              to: toColumn,
              moveSource,
            },
          });
          this.enqueueMergeQueue(id, { priority: task.priority, now: internal.now });
          this.createCompletionHandoffWorkflowWork(task, {
            runId: internal.runContext?.runId,
            now: internal.now,
            source: internal.evidence?.reason,
          });
          this.insertRunAuditEventRow({
            taskId: id,
            agentId: internal.runContext?.agentId,
            runId: internal.runContext?.runId,
            domain: "database",
            mutationType: "task:handoff",
            target: id,
            metadata: {
              taskId: id,
              fromColumn: task.column,
              ownerAgentId: internal.ownerAgentId ?? null,
              reason: internal.evidence?.reason,
              runId: internal.runContext?.runId,
              agentId: internal.runContext?.agentId,
              alreadyEnqueued: Boolean(existing),
            },
          });
        });
        return task;
      }

      if (toColumn === "done" && this.clearDoneTransientFields(task)) {
        task.updatedAt = new Date().toISOString();
        await this.atomicWriteTaskJson(dir, task);
        if (this.isWatching) this.taskCache.set(id, { ...task });
        this.emit("task:updated", task);
      }
      if (toColumn === "done") {
        await this.clearNearDuplicateReferencesToFailSoft(id, {
          column: "done",
          reason: "done",
        });
      }
      return task;
    }

    const fromColumn = task.column;

    if (useWorkflow && workflowIr) {
      // ── Flag-ON validation + sync guards (typed rejections, KTD-3/R13) ─────
      // 1. Target column must exist in the task's workflow → unknown-column.
      //    #1411: a recoveryRehome move to a LEGACY column (todo/archived/…) is
      //    the engine's self-healing rescue path — those targets are guaranteed
      //    safe landing columns even when a custom workflow never defined them.
      //    recoveryRehome already skips adjacency (below); it must likewise skip
      //    the unknown-column rejection for legacy recovery targets, otherwise a
      //    custom-workflow card could never be rescued to todo/archived and would
      //    stay stuck — the exact bug #1411 describes. Non-legacy unknown targets
      //    still reject (a genuine programming error), and normal (non-recovery)
      //    moves are unaffected.
      const recoveryToLegacy =
        options?.recoveryRehome === true && (COLUMNS as readonly string[]).includes(toColumn);
      if (!workflowHasColumn(workflowIr, toColumn) && !recoveryToLegacy) {
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "unknown-column",
            "transition.rejected.unknownColumn",
            false,
            `Column '${toColumn}' is not defined in this task's workflow`,
          ),
          `Invalid transition: '${fromColumn}' → '${toColumn}'. Unknown column for this workflow.`,
        );
      }
      // 2. Column-graph adjacency. For the default workflow this reproduces
      //    VALID_TRANSITIONS verbatim (resolveAllowedColumns); the
      //    transition-parity suite machine-checks the equivalence. A U5 recovery
      //    re-home (recoveryRehome) skips this so a stranded card can reach its
      //    new workflow's entry column from any current column.
      const allowed = resolveAllowedColumns(workflowIr, fromColumn);
      if (options?.recoveryRehome !== true && !allowed.includes(toColumn)) {
        throw new TransitionRejectionError(
          makeTransitionRejection(
            "guard-rejected",
            "transition.rejected.invalidTransition",
            false,
            `Valid targets: ${allowed.join(", ") || "none"}`,
          ),
          `Invalid transition: '${fromColumn}' → '${toColumn}'. ` +
            `Valid targets: ${allowed.join(", ") || "none"}`,
        );
      }
      const skipWorkflowMovePolicies = this.shouldSkipWorkflowMovePolicies({
        fromColumn,
        toColumn,
        moveSource,
        bypassGuards,
        options,
      });
      if (!skipWorkflowMovePolicies) {
        if (
          internal.movePolicyPreflight?.fromColumn !== fromColumn ||
          internal.movePolicyPreflight?.toColumn !== toColumn ||
          internal.movePolicyPreflight?.workflowSignature !== serializeWorkflowIr(workflowIr)
        ) {
          throw new TransitionRejectionError(
            makeTransitionRejection(
              "guard-rejected",
              "transition.rejected.workflowMovePolicy",
              true,
              "Workflow move policy preflight is stale; retry the move",
            ),
            `Cannot move ${id} to '${toColumn}': workflow move policy preflight is stale`,
          );
        }
      }
      // 3. Sync trait guards (in-lock). Skipped entirely when bypassGuards
      //    (engine/recovery moves, KTD-9). The default workflow's merge-blocker
      //    trait reads the same getTaskMergeBlocker.
      if (!bypassGuards) {
        const guardReason = evaluateMergeBlockerGuard(task, fromColumn, toColumn);
        if (guardReason) {
          throw new TransitionRejectionError(
            makeTransitionRejection(
              "merge-blocked",
              "transition.rejected.mergeBlocked",
              true,
              guardReason,
            ),
            `Cannot move ${id} to done: ${guardReason}`,
          );
        }
        // 4. Plugin gate verdict re-check (U8, KTD-2). For each PLUGIN gate trait
        //    on the target column, consume the pre-evaluated verdict (recorded by
        //    the engine's trait adapter outside the lock). A blocking gate with
        //    no recorded `allow` verdict fails closed (typed rejection); advisory
        //    gates record-and-allow. Built-in gates are handled by their own
        //    path; this guard is the plugin gate surface only.
        const registry = getTraitRegistry();
        const pluginGates = resolveColumnPluginGates(
          findWorkflowColumn(workflowIr, toColumn),
          (tid) => registry.getTrait(tid),
        );
        if (pluginGates.length > 0) {
          const recorded = this.consumePluginGateVerdicts(id, toColumn);
          const byTrait = new Map(recorded.map((v) => [v.traitId, v]));
          for (const gate of pluginGates) {
            if (gate.gateMode === "advisory") continue; // record-and-allow
            // Degraded (force-disabled) plugin gate: its hook impl is gone, so
            // the registry resolves it to a no-op + audit warning (KTD-7). A
            // degraded gate is PASSIVE — the column never blocks the card; the
            // registry's warning is the audit signal. Cards remain movable.
            const resolved = registry.resolveTraitHook(gate.traitId, "gate");
            if (resolved.warning) continue;
            const verdict = byTrait.get(gate.traitId);
            // Fail closed: a blocking gate with no recorded allow verdict rejects.
            if (!verdict || !verdict.allow) {
              const reason =
                verdict?.detail ??
                (verdict
                  ? `Gate '${gate.traitId}' did not pass`
                  : `Gate '${gate.traitId}' has not been evaluated for this move`);
              throw new TransitionRejectionError(
                makeTransitionRejection(
                  "merge-blocked",
                  "transition.rejected.gateBlocked",
                  true,
                  reason,
                ),
                `Cannot move ${id} to '${toColumn}': ${reason}`,
              );
            }
          }
        }
      }
    } else {
      // ── Flag-OFF legacy path (unchanged) ───────────────────────────────────
      // A task can sit in a custom column when the flag was toggled ON→OFF;
      // `VALID_TRANSITIONS` only keys the legacy columns, so a missing entry
      // degrades to the legacy "Invalid transition" error instead of a TypeError.
      // #1409: flag-OFF evacuation. A recoveryRehome move OUT of a non-legacy
      // (custom) column into a legacy target is the ON→OFF evacuation path —
      // `VALID_TRANSITIONS` never keys a custom source column, so the legacy
      // check below would strand the card forever. Allow it through (bypassing
      // only the adjacency check; this is unreachable for normal flag-OFF moves,
      // which never set recoveryRehome and always start from a legacy column, so
      // characterization behavior is byte-identical).
      const sourceIsLegacy = (COLUMNS as readonly string[]).includes(task.column);
      const isEvacuation =
        options?.recoveryRehome === true &&
        !sourceIsLegacy &&
        (COLUMNS as readonly string[]).includes(toColumn);
      if (!isEvacuation) {
        // Legacy flag-OFF branch (useWorkflow === false): both columns are
        // guaranteed legacy ids here — a non-legacy `toColumn` returns `?? []`
        // and rejects below, and flag-OFF tasks never hold custom column ids.
        // The `as Column` is provably safe within this branch (#1403).
        const validTargets = VALID_TRANSITIONS[task.column as Column] ?? [];
        if (!validTargets.includes(toColumn as Column)) {
          throw new Error(
            `Invalid transition: '${task.column}' → '${toColumn}'. ` +
              `Valid targets: ${validTargets.join(", ") || "none"}`,
          );
        }
      }

      if (fromColumn === "in-review" && toColumn === "done" && !options?.skipMergeBlocker) {
        const mergeBlocker = getTaskMergeBlocker(task);
        if (mergeBlocker) {
          throw new Error(`Cannot move ${id} to done: ${mergeBlocker}`);
        }
      }
    }

    const movedAt = internal.now ?? new Date().toISOString();
    task.column = toColumn;
    task.columnMovedAt = movedAt;
    task.updatedAt = movedAt;

    if (useWorkflow) {
      // ── Flag-ON: route the legacy per-column side effects through the
      //    default-workflow trait hooks (timing, reset-on-entry, abort-on-exit,
      //    merge.onEnter). "Moved, not duplicated" applies to this path; the
      //    flag-off branch below keeps the legacy inline code verbatim. ───────
      const ctx: DefaultWorkflowMoveContext = {
        task,
        fromColumn,
        toColumn,
        moveSource,
        bypassGuards,
        movedAt,
        settings: undefined,
        options: {
          preserveStatus: options?.preserveStatus,
          preserveResumeState: options?.preserveResumeState,
          preserveProgress: options?.preserveProgress,
          preserveWorktree: options?.preserveWorktree,
        },
        resetSteps: () => this.resetAllStepsToPending(task),
      };
      const isReopenToTodoOrTriage =
        (fromColumn === "in-progress" || fromColumn === "done" || fromColumn === "in-review") &&
        (toColumn === "todo" || toColumn === "triage");
      const hasNonPendingStepProgress = task.steps.some((step) => step.status !== "pending");
      const preserveStepProgress =
        options?.preserveResumeState ||
        (options?.preserveProgress === true && hasNonPendingStepProgress);
      const { warnings } = applyDefaultWorkflowMoveEffects(ctx);
      for (const warning of warnings) {
        storeLog.warn("Default-workflow trait hook degraded to no-op", {
          phase: "moveTaskInternal:workflow-hooks",
          taskId: id,
          ...warning,
        });
      }
      // Store-owned effects the hooks intentionally do NOT perform (filesystem /
      // store-private): clearing done transient fields + prompt-checkbox reset.
      if (toColumn === "done") {
        this.clearDoneTransientFields(task);
      }
      if (isReopenToTodoOrTriage && !preserveStepProgress) {
        await this.resetPromptCheckboxes(dir);
      }
    } else {
      // ── Flag-OFF legacy inline side effects (UNCHANGED — the flag-off path) ──
      if (fromColumn === "in-progress" && toColumn !== "in-progress") {
        const segmentStartMs = Date.parse(task.executionStartedAt ?? task.columnMovedAt);
        const segmentEndMs = Date.parse(task.columnMovedAt);
        const segmentDeltaMs =
          Number.isFinite(segmentStartMs) && Number.isFinite(segmentEndMs)
            ? Math.max(0, segmentEndMs - segmentStartMs)
            : 0;
        task.cumulativeActiveMs = Math.max(0, task.cumulativeActiveMs ?? 0) + segmentDeltaMs;
      }

      if (toColumn === "in-progress") {
        task.cumulativeActiveMs ??= 0;
        if (!task.firstExecutionAt) {
          task.firstExecutionAt = task.columnMovedAt;
        }
        if (!task.executionStartedAt) {
          task.executionStartedAt = task.columnMovedAt;
        }
        task.userPaused = undefined;
      }
      if (toColumn === "done" && !task.executionCompletedAt) {
        task.executionCompletedAt = task.columnMovedAt;
      }

      if (toColumn === "done") {
        this.clearDoneTransientFields(task);
      }

      const isReopenToTodoOrTriage =
        (fromColumn === "in-progress" || fromColumn === "done" || fromColumn === "in-review")
        && (toColumn === "todo" || toColumn === "triage");

      if (isReopenToTodoOrTriage) {
        if (!options?.preserveStatus) {
          task.status = undefined;
          task.error = undefined;
          task.pausedReason = undefined;
        }
        task.blockedBy = undefined;
        task.overlapBlockedBy = undefined;
        task.paused = undefined;
        task.pausedByAgentId = undefined;
        if (moveSource === "user" && toColumn === "todo") {
          task.userPaused = true;
        } else {
          task.userPaused = undefined;
        }

        const hasNonPendingStepProgress = task.steps.some((step) => step.status !== "pending");
        const preserveStepProgress =
          options?.preserveResumeState || (options?.preserveProgress === true && hasNonPendingStepProgress);

        if (!options?.preserveWorktree) {
          task.worktree = undefined;
        }

        if (!options?.preserveResumeState) {
          task.executionStartedAt = undefined;
          task.executionCompletedAt = undefined;
        } else {
          task.executionCompletedAt = undefined;
        }

        if (!preserveStepProgress) {
          this.resetAllStepsToPending(task);
          await this.resetPromptCheckboxes(dir);
        }
      }

      if (toColumn === "in-review") {
        // Keep this flag-OFF inline path in sync with applyInReviewEnterEffects.
        // Do not snapshot global autoMerge: undefined follows the live setting,
        // while explicit per-task true/false overrides remain sticky.
        task.recoveryRetryCount = undefined;
        task.nextRecoveryAt = undefined;
        // Clear scheduler-side dispatch state: `queued`, `blockedBy`, and
        // `overlapBlockedBy` are stamped while the task waits in `todo`. If
        // they survive the transition into `in-review` they permanently block
        // the merge gate (see getTaskMergeBlocker's BLOCKING_TASK_STATUSES).
        if (task.status === "queued") {
          task.status = undefined;
        }
        task.blockedBy = undefined;
        task.overlapBlockedBy = undefined;
      }

      if (
        (fromColumn === "in-review" && (toColumn === "todo" || toColumn === "in-progress" || toColumn === "triage"))
        || (fromColumn === "done" && (toColumn === "todo" || toColumn === "triage"))
      ) {
        task.workflowStepResults = undefined;
      }

      if (fromColumn === "in-review" && (toColumn === "todo" || toColumn === "triage")) {
        task.branch = undefined;
        task.executionStartBranch = undefined;
        task.baseCommitSha = undefined;
        task.summary = undefined;
        task.recoveryRetryCount = undefined;
        task.nextRecoveryAt = undefined;
      }
    }

    if (toColumn === "in-progress" && !task.worktree && options?.allocateWorktree) {
      const allocator = options.allocateWorktree;
      const allocated = await this.withWorktreeAllocationLock(async () => {
        const others = await this.listTasks({ slim: true, includeArchived: false });
        const reservedNames = new Set<string>();
        for (const other of others) {
          if (other.id === id || !other.worktree) continue;
          const name = other.worktree.split("/").filter(Boolean).pop();
          if (name) reservedNames.add(name);
        }
        return allocator(reservedNames);
      });
      if (allocated) {
        task.worktree = allocated;
      }
    }

    let deletedAt: string | undefined;
    let alreadyEnqueued = false;
    this.db.transactionImmediate(() => {
      deletedAt = this.getSoftDeletedWriteConflict(id, task);
      if (deletedAt) {
        return;
      }

      // ── U6: in-txn capacity enforcement (KTD-10) ──────────────────────────
      // WIP limits are trait *config*; enforcement is a substrate capability
      // that runs HERE, inside the move transaction, so two holds releasing into
      // one slot serialize — exactly one commits, the other rejects and retries
      // next sweep. It is NOT a guard: it runs regardless of bypassGuards /
      // recoveryRehome / moveSource (engine/recovery/scheduler moves honor it
      // too). Only a real column change into a capacity-bearing column is gated;
      // same-column no-ops were returned earlier. The count is taken with the
      // moving task EXCLUDED and the prospective slot it is about to occupy
      // added back implicitly (it must fit alongside existing holders), so a
      // full column (occupants == limit) rejects.
      if (useWorkflow && workflowIr && fromColumn !== toColumn) {
        const capacity = resolveColumnCapacity(workflowIr, toColumn, mergedSettingsForMove);
        if (capacity.hasCapacity && Number.isFinite(capacity.limit)) {
          const workflowId = this.resolveEffectiveWorkflowIdSync(id);
          const occupants = this.countActiveInCapacitySlotSync({
            targetColumn: toColumn,
            workflowId,
            countPending: capacity.countPending,
            excludeTaskId: id,
          });
          if (occupants >= capacity.limit) {
            throw new TransitionRejectionError(
              makeTransitionRejection(
                "capacity-exhausted",
                "transition.rejected.capacityExhausted",
                true,
                `Column '${toColumn}' is at capacity (${occupants}/${capacity.limit})`,
              ),
              `Cannot move ${id} to '${toColumn}': column at capacity (${occupants}/${capacity.limit})`,
            );
          }
        }
      }

      this.upsertTaskWithFtsRecovery(task);
      this.insertRunAuditEventRow({
        taskId: id,
        agentId: internal.runContext?.agentId,
        runId: internal.runContext?.runId,
        domain: "database",
        mutationType: "task:move",
        target: id,
        metadata: {
          from: fromColumn,
          to: toColumn,
          moveSource,
        },
      });
      this.dequeueMergeQueueOnColumnExit(id, fromColumn, toColumn, movedAt);

      // U4 (flag-ON): write the crash-safe transitionPending marker in the SAME
      // transaction as the column change (KTD-2). It records the post-commit
      // hooks that still owe idempotent execution so a crash mid-transition is
      // recoverable from SQLite (the authoritative store, ADR-0001). The store
      // clears it immediately after the post-commit hook runner completes
      // (below). For the default workflow the field effects already applied
      // in-lock; the marker guards the post-commit completion so recovery never
      // double-runs (idempotent) and never strands the card.
      if (useWorkflow) {
        writeTransitionPending(
          this.db,
          id,
          makeTransitionPending(toColumn, ["default-workflow:postCommit"], Date.parse(movedAt) || Date.now()),
        );
      }

      if (toColumn === "in-review" && !internal.fromHandoff && options?.allowDirectInReviewMove !== true) {
        this.insertRunAuditEventRow({
          taskId: id,
          agentId: internal.runContext?.agentId,
          runId: internal.runContext?.runId,
          domain: "database",
          mutationType: "task:handoff-invariant-violation",
          target: id,
          metadata: {
            taskId: id,
            fromColumn,
            callerStack: new Error().stack?.split("\n").slice(0, 8).join("\n"),
          },
        });
      }

      if (internal.fromHandoff) {
        alreadyEnqueued = Boolean(this.db.prepare("SELECT 1 FROM mergeQueue WHERE taskId = ?").get(id));
        this.enqueueMergeQueue(id, { priority: task.priority, now: internal.now });
        this.createCompletionHandoffWorkflowWork(task, {
          runId: internal.runContext?.runId,
          now: internal.now,
          source: internal.evidence?.reason,
        });
        this.insertRunAuditEventRow({
          taskId: id,
          agentId: internal.runContext?.agentId,
          runId: internal.runContext?.runId,
          domain: "database",
          mutationType: "task:handoff",
          target: id,
          metadata: {
            taskId: id,
            fromColumn,
            ownerAgentId: internal.ownerAgentId ?? null,
            reason: internal.evidence?.reason,
            runId: internal.runContext?.runId,
            agentId: internal.runContext?.agentId,
            alreadyEnqueued,
          },
        });
      }
    });

    if (deletedAt) {
      if (internal.fromHandoff) {
        throw new HandoffInvariantViolationError(
          id,
          fromColumn,
          `Cannot hand off ${id} to in-review because the task is deleted`,
        );
      }
      this.throwSoftDeletedWriteBlocked(id, deletedAt, "moveTaskInternal", {
        agentId: internal.runContext?.agentId,
        runId: internal.runContext?.runId,
        timestamp: movedAt,
      });
    }

    await this.writeTaskJsonFile(dir, task);
    if (fromColumn === "in-review" && toColumn === "todo" && moveSource === "user") {
      const handoffAccepted = this.getCompletionHandoffAcceptedMarker(id);
      const mergeRequest = this.getMergeRequestRecord(id);
      if (handoffAccepted && mergeRequest && mergeRequest.state !== "succeeded" && mergeRequest.state !== "cancelled") {
        if (mergeRequest.state === "queued" || mergeRequest.state === "running" || mergeRequest.state === "retrying" || mergeRequest.state === "manual-required") {
          this.transitionMergeRequestState(id, "cancelled", {
            attemptCount: mergeRequest.attemptCount,
            lastError: mergeRequest.lastError ?? "cancelled-by-user-hard-cancel",
          });
        }
      }
      this.cancelActiveWorkflowWorkItemsForTask(id, {
        kinds: ["merge", "manual-hold"],
        now: movedAt,
        lastError: "cancelled-by-user-hard-cancel",
      });
      this.clearCompletionHandoffAcceptedMarker(id);
    }
    if (toColumn === "done") {
      this.clearLinkedAgentTaskIds(id, task.updatedAt);
    }

    if (this.isWatching) this.taskCache.set(id, { ...task });

    // U4 (flag-ON): post-commit hook completion. The default-workflow field
    // effects already ran in-lock and committed; the post-commit phase here is
    // the fire-and-forget hook runner per KTD-2. It is idempotent and clears the
    // transitionPending marker once done. A crash before this point leaves the
    // marker for the recovery sweep to re-run (re-running is a no-op for the
    // default workflow's already-committed field effects).
    //
    // Residual C (U8): AFTER the built-in effects, invoke registered PLUGIN
    // onExit (from column) / onEnter (to column) trait hook impls, recording
    // per-hook completion in the marker's hooksRemaining. A throwing plugin hook
    // DEGRADES (audit) and never wedges the lock or strands the marker — the
    // marker is always cleared at the end regardless of hook failures.
    if (useWorkflow) {
      // Plugin hooks are skipped on engine/recovery-sourced moves (KTD-9 — those
      // bypass trait effects) and on same-column no-ops.
      if (!bypassGuards && fromColumn !== toColumn && workflowIr) {
        try {
          await this.runPluginColumnTransitionHooks(id, workflowIr, fromColumn, toColumn);
        } catch (err) {
          // The runner itself swallows per-hook failures; this is a final guard
          // so a runner-level fault never strands the marker.
          storeLog.warn("Plugin column transition hook runner faulted (degraded)", {
            phase: "moveTaskInternal:plugin-hooks",
            taskId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        clearTransitionPending(this.db, id);
      } catch {
        // Clearing is best-effort; the marker recovery sweep is the backstop.
      }
    }

    if (fromColumn !== toColumn) {
      this.emit("task:moved", { task, from: fromColumn, to: toColumn, source: moveSource });
    }
    if (toColumn === "done") {
      await this.clearNearDuplicateReferencesToFailSoft(id, {
        column: "done",
        reason: "done",
      });
    }
    return task;
  }

  /**
   * Residual C (U8): run registered PLUGIN onExit (from column) / onEnter (to
   * column) trait hook impls AFTER the built-in default-workflow effects, on the
   * post-commit path. Plugin hooks are async-only (KTD-7) and route through the
   * registry's resolved impl (the engine wires `runCustomNode` in via the trait
   * adapter; an unregistered/degraded hook resolves to a no-op + audit warning).
   *
   * Per-hook completion is recorded in the `transitionPending` marker's
   * `hooksRemaining` so a crash mid-hook is recoverable. A hook that THROWS is
   * audited (`plugin:trait-hook-degraded`) and treated as completed (removed
   * from `hooksRemaining`) — a misbehaving plugin never wedges the task lock or
   * strands the card (KTD-2 degraded-not-stranded posture). The caller clears
   * the marker after this returns.
   */
  private async runPluginColumnTransitionHooks(
    taskId: string,
    workflowIr: WorkflowIr,
    fromColumn: string,
    toColumn: string,
  ): Promise<void> {
    const registry = getTraitRegistry();
    // Collect (traitId, hookKind) pairs: onExit for from-column plugin traits,
    // onEnter for to-column plugin traits. Only plugin-namespaced traits (KTD-7).
    const pending: Array<{ traitId: string; hookKind: "onEnter" | "onExit" }> = [];
    const fromCol = findWorkflowColumn(workflowIr, fromColumn);
    for (const ct of fromCol?.traits ?? []) {
      if (!ct.trait.startsWith("plugin:")) continue;
      const def = registry.getTrait(ct.trait);
      if (def?.hooks?.onExit) pending.push({ traitId: ct.trait, hookKind: "onExit" });
    }
    const toCol = findWorkflowColumn(workflowIr, toColumn);
    for (const ct of toCol?.traits ?? []) {
      if (!ct.trait.startsWith("plugin:")) continue;
      const def = registry.getTrait(ct.trait);
      if (def?.hooks?.onEnter) pending.push({ traitId: ct.trait, hookKind: "onEnter" });
    }
    if (pending.length === 0) return;

    // Record the plugin hooks in the marker's hooksRemaining (alongside the
    // default-workflow:postCommit marker already written in-txn) so a crash
    // mid-hook is recoverable.
    const hookIds = pending.map((p) => `${p.traitId}:${p.hookKind}`);
    const startedAt = Date.now();
    try {
      writeTransitionPending(
        this.db,
        taskId,
        makeTransitionPending(toColumn, ["default-workflow:postCommit", ...hookIds], startedAt),
      );
    } catch {
      // Marker bookkeeping is best-effort; proceed to run the hooks regardless.
    }

    // Read the task once for hook context. MUST be a non-locking read — this
    // runs inside `withTaskLock`, so `getTask` (which re-acquires the lock)
    // would deadlock. `readTaskFromDb` is the in-lock-safe read.
    const taskRow = this.readTaskFromDb(taskId, { includeDeleted: false });
    const taskDetail = taskRow as unknown as TaskDetail | undefined;

    const remaining = ["default-workflow:postCommit", ...hookIds];
    for (const { traitId, hookKind } of pending) {
      const resolved = registry.resolveTraitHook(traitId, hookKind);
      if (resolved.warning) {
        // Degraded (no impl / force-disabled) → passive no-op, audit the warning.
        this.recordRunAuditEvent({
          taskId,
          agentId: "system",
          runId: `plugin-trait-hook-${traitId}-${taskId}-${Date.now()}`,
          domain: "database",
          mutationType: "plugin:trait-hook-degraded",
          target: taskId,
          metadata: { traitId, hookKind, reason: "no-impl", message: resolved.warning.message },
        });
      } else if (resolved.impl) {
        try {
          await resolved.impl({ task: taskDetail, context: { fromColumn, toColumn, hookKind } });
        } catch (err) {
          // A throwing plugin hook DEGRADES — audited, never wedges the lock.
          this.recordRunAuditEvent({
            taskId,
            agentId: "system",
            runId: `plugin-trait-hook-${traitId}-${taskId}-${Date.now()}`,
            domain: "database",
            mutationType: "plugin:trait-hook-degraded",
            target: taskId,
            metadata: {
              traitId,
              hookKind,
              reason: "threw",
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
      // Mark this hook complete in the marker (whether it ran, degraded, or threw).
      const idx = remaining.indexOf(`${traitId}:${hookKind}`);
      if (idx >= 0) remaining.splice(idx, 1);
      try {
        writeTransitionPending(this.db, taskId, makeTransitionPending(toColumn, remaining, startedAt));
      } catch {
        // Best-effort progress bookkeeping; the final clear is the backstop.
      }
    }
  }

  private resetAllStepsToPending(task: Task): void {
    if (task.steps.length === 0) {
      return;
    }

    for (const step of task.steps) {
      step.status = "pending";
    }

    task.currentStep = 0;
  }

  private async resetPromptCheckboxes(dir: string): Promise<void> {
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) {
      return;
    }

    const content = await readFile(promptPath, "utf-8");
    const resetContent = content.replace(/^- \[x\]/gm, "- [ ]");

    if (resetContent !== content) {
      await writeFile(promptPath, resetContent, "utf-8");
    }
  }

  async updateTaskDependencies(
    id: string,
    mutation: TaskDependencyMutation,
    runContext?: RunMutationContext,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const previousDependencies = [...(task.dependencies ?? [])];
      const normalizedCurrent = previousDependencies.map((dependency) => dependency.trim()).filter(Boolean);
      let nextDependencies: string[];
      let action: string;

      const assertNotSelf = (dependencyId: string) => {
        if (dependencyId === id) {
          throw new Error(`Task ${id} cannot depend on itself`);
        }
      };
      const assertTaskExists = (dependencyId: string) => {
        if (!this.readTaskFromDb(dependencyId)) {
          throw new Error(`Dependency task ${dependencyId} not found`);
        }
      };
      const assertUnique = (dependencies: readonly string[]) => {
        const seen = new Set<string>();
        for (const dependencyId of dependencies) {
          if (seen.has(dependencyId)) {
            throw new Error(`Task ${id} already depends on ${dependencyId}`);
          }
          seen.add(dependencyId);
        }
      };
      const normalizeDependency = (dependencyId: string, label = "dependency") => {
        const normalized = dependencyId.trim();
        if (!normalized) {
          throw new Error(`${label} is required`);
        }
        assertNotSelf(normalized);
        assertTaskExists(normalized);
        return normalized;
      };

      switch (mutation.operation) {
        case "add": {
          const dependency = normalizeDependency(mutation.dependency);
          if (normalizedCurrent.includes(dependency)) {
            throw new Error(`Task ${id} already depends on ${dependency}`);
          }
          nextDependencies = [...normalizedCurrent, dependency];
          action = `Added dependency ${dependency}`;
          break;
        }
        case "remove": {
          const dependency = mutation.dependency.trim();
          if (!dependency) {
            throw new Error("dependency is required");
          }
          if (!normalizedCurrent.includes(dependency)) {
            throw new Error(`Task ${id} does not depend on ${dependency}`);
          }
          nextDependencies = normalizedCurrent.filter((candidate) => candidate !== dependency);
          action = `Removed dependency ${dependency}`;
          break;
        }
        case "replace": {
          const from = mutation.from.trim();
          if (!from) {
            throw new Error("from dependency is required");
          }
          const to = normalizeDependency(mutation.to, "replacement dependency");
          if (!normalizedCurrent.includes(from)) {
            throw new Error(`Task ${id} does not depend on ${from}`);
          }
          if (from !== to && normalizedCurrent.includes(to)) {
            throw new Error(`Task ${id} already depends on ${to}`);
          }
          nextDependencies = normalizedCurrent.map((dependency) => dependency === from ? to : dependency);
          action = `Replaced dependency ${from} with ${to}`;
          break;
        }
        case "set": {
          nextDependencies = mutation.dependencies.map((dependency) => normalizeDependency(dependency));
          assertUnique(nextDependencies);
          action = nextDependencies.length > 0
            ? `Set dependencies to ${nextDependencies.join(", ")}`
            : "Cleared dependencies";
          break;
        }
      }

      const selfDefeatingDep = detectSelfDefeatingDependency(task.title, nextDependencies);
      if (selfDefeatingDep) {
        throw new SelfDefeatingDependencyError(
          task.title?.trim() ?? "",
          selfDefeatingDep.matchedVerb,
          selfDefeatingDep.operandTaskId,
        );
      }

      await this.assertNoDependencyCycle(
        id,
        nextDependencies,
        "updateTask",
        new Map([[id, nextDependencies]]),
      );

      const previousDependencySet = new Set(normalizedCurrent);
      const hasNewDependencies = nextDependencies.some((dependencyId) => !previousDependencySet.has(dependencyId));

      task.dependencies = nextDependencies;
      const unresolvedDependency = nextDependencies.find((dependencyId) => {
        const dependency = this.readTaskFromDb(dependencyId);
        return dependency?.column !== "done" && dependency?.column !== "archived";
      });
      if (unresolvedDependency) {
        const currentBlocker = task.blockedBy ? this.readTaskFromDb(task.blockedBy) : undefined;
        const currentBlockerResolved = currentBlocker?.column === "done" || currentBlocker?.column === "archived";
        if (!task.blockedBy || !nextDependencies.includes(task.blockedBy) || !currentBlocker || currentBlockerResolved) {
          task.blockedBy = unresolvedDependency;
        }
      } else {
        task.blockedBy = undefined;
      }
      task.updatedAt = new Date().toISOString();
      task.log ??= [];
      let movedToTriage = false;
      if (hasNewDependencies && task.column === "todo") {
        task.column = "triage";
        movedToTriage = true;
        task.status = undefined;
        task.columnMovedAt = task.updatedAt;
        task.log.push({
          timestamp: task.updatedAt,
          action: "Moved to triage for re-specification — new dependency added",
          ...(runContext ? { runContext } : {}),
        });
      }
      task.log.push({
        timestamp: task.updatedAt,
        action,
        ...(runContext ? { runContext } : {}),
      });

      const auditEvent: RunAuditEventInput = {
        taskId: id,
        agentId: runContext?.agentId ?? "manual",
        runId: runContext?.runId ?? "manual",
        domain: "database",
        mutationType: "task:dependencies:update",
        target: id,
        metadata: {
          mutation,
          previousDependencies,
          dependencies: nextDependencies,
          blockedBy: task.blockedBy ?? null,
        },
      };
      await this.atomicWriteTaskJsonWithAudit(dir, task, auditEvent);
      // FNXC:BoardConsistency 2026-06-21-08:31: updateTaskDependencies' todo→triage re-spec move can also carry title/blocker changes, and leaving taskCache on the pre-move row made watch/SSE/board consumers surface one task ID in two columns (FN-6851/FN-6812). Sync the cache after the authoritative write like sibling mutation paths.
      if (this.isWatching) this.taskCache.set(id, { ...task });
      if (movedToTriage) {
        this.emit("task:moved", { task, from: "todo" as Column, to: "triage" as Column, source: "engine" });
      }
      this.emitTaskLifecycleEventSafely("task:updated", [task]);
      return task;
    });
  }

  async updateTask(
    id: string,
    updates: { title?: string; description?: string; priority?: TaskPriority | null; prompt?: string; worktree?: string | null; workspaceWorktrees?: import("./types.js").Task["workspaceWorktrees"]; status?: string | null; dependencies?: string[]; steps?: import("./types.js").TaskStep[]; customFields?: Record<string, unknown>; currentStep?: number; blockedBy?: string | null; overlapBlockedBy?: string | null; assignedAgentId?: string | null; pausedByAgentId?: string | null; pausedReason?: string | null; tokenBudgetSoftAlertedAt?: string | null; worktrunkFallbackAlertedAt?: string | null; worktrunkFailure?: import("./types.js").Task["worktrunkFailure"] | null; tokenBudgetHardAlertedAt?: string | null; tokenBudgetOverride?: import("./types.js").TaskTokenBudgetOverride | null; dispatchStormCount?: number | null; lastDispatchAt?: string | null; assigneeUserId?: string | null; scopeOverride?: boolean | null; scopeOverrideReason?: string | null; scopeAutoWiden?: string[] | null; nodeId?: string | null; effectiveNodeId?: string | null; effectiveNodeSource?: string | null; checkedOutBy?: string | null; checkedOutAt?: string | null; checkoutNodeId?: string | null; checkoutRunId?: string | null; checkoutLeaseRenewedAt?: string | null; checkoutLeaseEpoch?: number | null; paused?: boolean; baseBranch?: string | null; autoMerge?: boolean | null; branch?: string | null; executionStartBranch?: string | null; baseCommitSha?: string | null; size?: "S" | "M" | "L"; reviewLevel?: number; executionMode?: import("./types.js").ExecutionMode | null; mergeRetries?: number; workflowStepRetries?: number; stuckKillCount?: number | null; resumeLimboCount?: number | null; graphResumeRetryCount?: number | null; resumeLimboTipSha?: string | null; resumeLimboStepSignature?: string | null; postReviewFixCount?: number | null; recoveryRetryCount?: number | null; taskDoneRetryCount?: number | null; worktreeSessionRetryCount?: number | null; completionHandoffLimboRecoveryCount?: number | null; verificationFailureCount?: number | null; mergeConflictBounceCount?: number | null; mergeAuditBounceCount?: number | null; mergeTransientRetryCount?: number | null; branchConflictRecoveryCount?: number | null; reviewerContextRetryCount?: number | null; reviewerFallbackRetryCount?: number | null; nextRecoveryAt?: string | null; enabledWorkflowSteps?: string[]; noCommitsExpected?: boolean | null; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; planningModelProvider?: string | null; planningModelId?: string | null; thinkingLevel?: string | null; error?: string | null; summary?: string | null; sessionFile?: string | null; firstExecutionAt?: string | null; cumulativeActiveMs?: number | null; executionStartedAt?: string | null; executionCompletedAt?: string | null; review?: import("./types.js").TaskReview | null; reviewState?: import("./types.js").TaskReviewState | null; workflowStepResults?: import("./types.js").WorkflowStepResult[] | null; mergeDetails?: import("./types.js").MergeDetails | null; sourceIssue?: import("./types.js").TaskSourceIssue | null; sourceMetadataPatch?: Record<string, unknown> | null; githubTracking?: import("./types.js").TaskGithubTracking | null; tokenUsage?: import("./types.js").TaskTokenUsage | null; modifiedFiles?: string[] | null; missionId?: string | null; sliceId?: string | null },
    runContext?: RunMutationContext,
  ): Promise<Task> {
    return this.withTaskLock(id, () => this.updateTaskUnlocked(id, updates, runContext));
  }

  async updateTaskAtomic(
    id: string,
    updater: (
      current: Task,
    ) => Parameters<TaskStore["updateTask"]>[1] | null | undefined | Promise<Parameters<TaskStore["updateTask"]>[1] | null | undefined>,
    runContext?: RunMutationContext,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const current = await this.readTaskJson(this.taskDir(id));
      const updates = await updater(current);
      if (!updates || Object.values(updates).every((value) => value === undefined)) {
        return current;
      }
      return this.updateTaskUnlocked(id, updates, runContext);
    });
  }

  /**
   * Merge a validated/normalized custom-field patch into the existing values.
   * `null` in the patch deletes that field's value (the delete sentinel from
   * {@link validateCustomFieldPatch}); any other value overwrites. Returns a new
   * object (never mutates the input) so the caller assigns it onto the task.
   */
  private mergeCustomFieldPatch(
    current: Record<string, unknown> | undefined,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const next: Record<string, unknown> = { ...(current ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    return next;
  }

  /**
   * Single write authority for custom task fields (U11 / KTD-13).
   *
   * Resolves the task's workflow field definitions, validates `patch` against
   * them via {@link validateCustomFieldPatch}, merges the normalized result into
   * `Task.customFields` (delete-on-null), persists through the standard update
   * path, and emits `task:updated` like every other task mutation. A workflow
   * with no fields (e.g. the default) rejects any non-empty patch with
   * `no-fields-defined`. Returns a typed result rather than throwing so callers
   * (agent tools, HTTP routes) can surface the field path/code directly.
   */
  async updateTaskCustomFields(
    taskId: string,
    patch: Record<string, unknown>,
    runContext?: RunMutationContext,
  ): Promise<{ ok: true; task: Task } | { ok: false; rejection: CustomFieldRejection }> {
    return this.withTaskLock(taskId, async () => {
      const defs = this.resolveTaskCustomFieldDefsSync(taskId);
      const result = validateCustomFieldPatch(defs, patch);
      if (!result.ok) {
        return { ok: false as const, rejection: result.rejection };
      }
      // Pass the validated PATCH through (with null delete-sentinels) — the
      // merge-with-delete happens once, inside updateTaskUnlocked, against the
      // freshly-read task. Pre-merging here would lose the delete semantics on
      // the second merge.
      const task = await this.updateTaskUnlocked(taskId, { customFields: result.normalized }, runContext);
      return { ok: true as const, task };
    });
  }

  // ── Workflow setting values (U2, R2/R4, KTD-2/KTD-9) ───────────────────────
  //
  // Setting VALUES persist per `(workflowId, projectId)` in the `workflow_settings`
  // table; declarations live in the named workflow's IR (built-in or custom). This
  // is the single validating write authority: values are validated against the
  // NAMED workflow's declarations (not the project's current default workflow), and
  // invalid values are NEVER persisted. Built-in workflow ids are accepted for
  // value writes even though built-in DECLARATIONS are non-editable
  // (`updateWorkflowDefinition` still rejects built-in edits) — the two error paths
  // stay distinct (KTD-2).

  /** Resolve the setting DECLARATIONS for a workflow id (built-in or custom). The
   *  built-in path mirrors the IR resolver (`resolveWorkflowIrById`): built-in ids
   *  resolve through the same code path so value writes target the same schema the
   *  engine resolver sees. As of U3 every built-in workflow IR embeds
   *  `BUILTIN_WORKFLOW_SETTINGS` (attached in `builtin-workflows.ts` /
   *  `builtin-coding-workflow-ir.ts`), so the `declared` branch below now handles
   *  built-ins too. The built-in catalog fallback is kept as a cheap defensive belt
   *  in case a future built-in graph is constructed without the embed (R4/KTD-2).
   *  Returns `undefined` when the workflow is missing or declares no settings. */
  private async resolveWorkflowSettingDeclarations(
    workflowId: string,
  ): Promise<WorkflowSettingDefinition[] | undefined> {
    const ir = await resolveWorkflowIrById(this, workflowId);
    const declared = ir.version === "v2" ? ir.settings : undefined;
    if (declared && declared.length > 0) return declared;
    // Defensive belt: built-in ids always have a declaration catalog even if a
    // particular built-in graph somehow lacks the embed.
    if (isBuiltinWorkflowId(workflowId)) return BUILTIN_WORKFLOW_SETTINGS;
    return declared;
  }

  /** The stable project id this store scopes `workflow_settings` value rows by
   *  (U3). A single store instance is bound to one project (its `rootDir`); the
   *  durable project-identity id is that project's key. Falls back to the store's
   *  `rootDir` when no identity row exists yet (fresh project pre-identity), which
   *  is still stable per store instance. The engine's per-task effective-settings
   *  resolver uses this so reads/writes share one project key. */
  getWorkflowSettingsProjectId(): string {
    try {
      return this.db.getProjectIdentity()?.id ?? this.rootDir;
    } catch {
      return this.rootDir;
    }
  }

  /**
   * Enumerate every stored `workflow_settings` value row for THIS project
   * (`getWorkflowSettingsProjectId()`), returned as `workflowId → values map`.
   * Used by settings export v2 to carry the value table. Rows whose JSON is
   * corrupt or non-object are skipped; rows with an empty values map are
   * included as `{}` only if the row physically exists (callers that want to
   * drop empties filter on their side).
   */
  listWorkflowSettingValuesForProject(): Record<string, Record<string, unknown>> {
    const projectId = this.getWorkflowSettingsProjectId();
    const rows = this.db
      .prepare('SELECT workflowId, "values" FROM workflow_settings WHERE projectId = ?')
      .all(projectId) as Array<{ workflowId: string; values: string }>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.values) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out[row.workflowId] = parsed as Record<string, unknown>;
        }
      } catch {
        // Skip corrupt row.
      }
    }
    return out;
  }

  /**
   * Compute the write-target workflow ids for moved-setting values in THIS
   * project: every distinct `task_workflow_selection.workflowId` in use ∪ the
   * resolved project default, where an unset/empty/missing default normalizes to
   * `builtin:coding`. Shared by the U4 hard-move migration and the U5 settings
   * export v1→v2 upgrade so both write to exactly the same lanes.
   */
  async computeMovedSettingsTargetWorkflowIds(): Promise<Set<string>> {
    const targetWorkflowIds = new Set<string>();
    try {
      const rows = this.db
        .prepare("SELECT DISTINCT workflowId FROM task_workflow_selection WHERE workflowId IS NOT NULL AND workflowId != ''")
        .all() as Array<{ workflowId: string }>;
      for (const row of rows) {
        if (row.workflowId && row.workflowId.trim()) targetWorkflowIds.add(row.workflowId);
      }
    } catch {
      // No selections / table issue — fall through to the default below.
    }
    let defaultWorkflowId = "builtin:coding";
    try {
      const resolved = await this.getDefaultWorkflowId();
      if (resolved && resolved.trim()) {
        const exists = isBuiltinWorkflowId(resolved) || (await this.getWorkflowDefinition(resolved));
        defaultWorkflowId = exists ? resolved : "builtin:coding";
      }
    } catch {
      defaultWorkflowId = "builtin:coding";
    }
    targetWorkflowIds.add(defaultWorkflowId);
    return targetWorkflowIds;
  }

  /** Read the raw stored setting-value map for `(workflowId, projectId)`. Returns
   *  an empty object when no row exists. Raw (pre drop-on-orphan) — callers that
   *  need engine-effective values run {@link resolveEffectiveSettingValues}. */
  getWorkflowSettingValues(workflowId: string, projectId: string): Record<string, unknown> {
    const row = this.db
      .prepare('SELECT "values" FROM workflow_settings WHERE workflowId = ? AND projectId = ?')
      .get(workflowId, projectId) as { values: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.values) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }


  // ── Built-in workflow prompt overrides (FN-6893) ───────────────────────────
  //
  // FNXC:CustomWorkflows 2026-06-21-19:07:
  // Built-in workflow graphs remain read-only, but prompt-bearing prompt/gate nodes need project-scoped text overrides with reset-to-default. Keep this as a separate authority from updateWorkflowDefinition so structure edits remain blocked.

  private parseWorkflowPromptOverrideJson(raw: string | null | undefined): Record<string, string> {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (trimmed.length === 0) continue;
        out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  /** Enumerate every stored prompt override row for THIS project, returned as
   *  `workflowId → { nodeId: prompt }`. Corrupt rows and blank prompt entries are
   *  skipped so callers only see runnable override text. */
  listWorkflowPromptOverridesForProject(): Record<string, Record<string, string>> {
    const projectId = this.getWorkflowSettingsProjectId();
    const rows = this.db
      .prepare("SELECT workflowId, overrides FROM workflow_prompt_overrides WHERE projectId = ?")
      .all(projectId) as Array<{ workflowId: string; overrides: string }>;
    const out: Record<string, Record<string, string>> = {};
    for (const row of rows) {
      out[row.workflowId] = this.parseWorkflowPromptOverrideJson(row.overrides);
    }
    return out;
  }

  /** Read the raw stored prompt override map for `(workflowId, projectId)`.
   *  Returns `{}` when no row exists. Empty/whitespace prompts are treated as
   *  absent because a blank override would blank an agent run. */
  getWorkflowPromptOverrides(workflowId: string, projectId: string): Record<string, string> {
    const row = this.db
      .prepare("SELECT overrides FROM workflow_prompt_overrides WHERE workflowId = ? AND projectId = ?")
      .get(workflowId, projectId) as { overrides: string } | undefined;
    return this.parseWorkflowPromptOverrideJson(row?.overrides);
  }

  /** Merge prompt override updates into `(workflowId, projectId)`. A `null`,
   *  non-string, empty, or whitespace value deletes that nodeId override, which
   *  is the reset-to-default operation. */
  updateWorkflowPromptOverrides(
    workflowId: string,
    projectId: string,
    patch: Record<string, string | null | undefined>,
  ): Record<string, string> {
    return this.db.transactionImmediate(() => {
      const current = this.getWorkflowPromptOverrides(workflowId, projectId);
      const next: Record<string, string> = { ...current };
      for (const [nodeId, value] of Object.entries(patch)) {
        if (typeof value !== "string" || value.trim().length === 0) {
          delete next[nodeId];
        } else {
          next[nodeId] = value;
        }
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO workflow_prompt_overrides (workflowId, projectId, overrides, updatedAt)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workflowId, projectId)
           DO UPDATE SET overrides = excluded.overrides, updatedAt = excluded.updatedAt`,
        )
        .run(workflowId, projectId, JSON.stringify(next), now);
      this.db.bumpLastModified();
      return next;
    });
  }

  /**
   * Write setting VALUES for `(workflowId, projectId)`. The patch is validated
   * against the NAMED workflow's declarations via {@link validateSettingValuePatch};
   * on ANY rejection nothing is persisted (write-boundary contract) and a typed
   * {@link WorkflowSettingRejectionError} is thrown. Accepted keys merge into the
   * stored row; a `null` value deletes the key (null-as-delete). Built-in workflow
   * value writes succeed (R4).
   */
  async updateWorkflowSettingValues(
    workflowId: string,
    projectId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const declarations = await this.resolveWorkflowSettingDeclarations(workflowId);
    const result = validateSettingValuePatch(declarations, patch);
    if (result.rejections.length > 0) {
      // Invalid values are NEVER persisted — fail the whole write loudly.
      throw new WorkflowSettingRejectionError(result.rejections);
    }

    // Read-merge-upsert must be atomic: two concurrent calls for the same
    // (workflowId, projectId) could otherwise both merge from the same
    // pre-update snapshot, and the later upsert would erase the earlier
    // call's keys (lost update). Serialize the whole cycle under an immediate
    // write transaction. Validation/declaration resolution above stays outside
    // since it's async and doesn't read the row being mutated.
    return this.db.transactionImmediate(() => {
      const current = this.getWorkflowSettingValues(workflowId, projectId);
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(result.accepted)) {
        if (value === null) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }

      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO workflow_settings (workflowId, projectId, "values", updatedAt)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workflowId, projectId)
           DO UPDATE SET "values" = excluded."values", updatedAt = excluded.updatedAt`,
        )
        .run(workflowId, projectId, JSON.stringify(next), now);
      this.db.bumpLastModified();
      return next;
    });
  }

  /**
   * The body of {@link updateTask} WITHOUT acquiring the per-task lock. Callers
   * that already hold `withTaskLock(id)` — e.g. workflow-selection mutations
   * that bundle a `task_workflow_selection`/`workflow_steps` write with the
   * `enabledWorkflowSteps` update — invoke this directly so the whole sequence
   * runs under a single lock acquisition. The per-task lock is non-reentrant,
   * so calling the public `updateTask` from inside an outer `withTaskLock(id)`
   * would deadlock; this variant exists to avoid that.
   */
  private async updateTaskUnlocked(
    id: string,
    updates: Parameters<TaskStore["updateTask"]>[1],
    runContext?: RunMutationContext,
  ): Promise<Task> {
    {
      if (updates.dependencies !== undefined) {
        await this.assertNoDependencyCycle(
          id,
          updates.dependencies,
          "updateTask",
          new Map([[id, updates.dependencies]]),
        );
      }

      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Capture title/description before mutation so the PROMPT.md stub
      // detector below can compare against the exact wrapper bytes that the
      // pre-edit task would have produced. This is what makes detection
      // robust to descriptions that contain `##` headings or `**Created:**`
      // text (e.g. imported GitHub issue bodies) — we never inspect the
      // description content, only the wrapper shape.
      const preUpdateTitle = task.title;
      const preUpdateDescription = task.description;

      if (updates.nodeId !== undefined) {
        const validation = validateNodeOverrideChange(task, updates.nodeId ?? null);
        if (!validation.allowed) {
          throw new Error(validation.message);
        }
      }

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      let titleNormalized = false;
      if (updates.title !== undefined) {
        task.title = updates.title;
        // FN-5077: load-time repair tolerates null normalized titles (title cleared instead of fragment persisted).
        const normalizedTitle = normalizeTitleForTaskId(task.title, id);
        if (normalizedTitle.changed) {
          titleNormalized = true;
          const removed = extractTaskIdTokens(task.title ?? "").filter((token) => token !== id.toUpperCase());
          task.title = normalizedTitle.title ?? undefined;
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Title normalized: stripped legacy task-id reference",
            ...(runContext ? { runContext } : {}),
          });
          storeLog.log(`[title-id-drift] normalized title for ${id}: removed=[${removed.join(",")}]`);
        }
      }
      if (updates.description !== undefined) task.description = updates.description;
      if (updates.sourceMetadataPatch === null) {
        task.sourceMetadata = undefined;
      } else if (updates.sourceMetadataPatch !== undefined) {
        task.sourceMetadata = {
          ...(task.sourceMetadata ?? {}),
          ...updates.sourceMetadataPatch,
        };
      }
      if (updates.priority === null) {
        task.priority = normalizeTaskPriority(undefined);
      } else if (updates.priority !== undefined) {
        task.priority = normalizeTaskPriority(updates.priority);
      }
      if (updates.worktree === null) {
        task.worktree = undefined;
      } else if (updates.worktree !== undefined) {
        task.worktree = updates.worktree;
      }
      if (updates.workspaceWorktrees !== undefined) {
        task.workspaceWorktrees = updates.workspaceWorktrees;
      }
      // Detect new dependencies being added to a todo task → auto-move to triage
      let movedToTriage = false;
      if (updates.dependencies !== undefined) {
        const oldDeps = new Set((task.dependencies ?? []).map((dependency) => dependency.trim()).filter(Boolean));
        const normalizedDependencies = updates.dependencies.map((dependency) => dependency.trim()).filter(Boolean);
        const hasNewDeps = normalizedDependencies.some((d) => !oldDeps.has(d));
        task.dependencies = normalizedDependencies;

        if (hasNewDeps && task.column === "todo") {
          task.column = "triage";
          task.status = undefined;
          task.columnMovedAt = new Date().toISOString();
          const depLogEntry: TaskLogEntry = {
            timestamp: new Date().toISOString(),
            action: "Moved to triage for re-specification — new dependency added",
          };
          if (runContext) {
            depLogEntry.runContext = runContext;
          }
          task.log.push(depLogEntry);
          movedToTriage = true;
        }
      }
      if (updates.steps !== undefined) task.steps = updates.steps;
      // U11/KTD-13: customFields writes are validated against the task's workflow
      // field schema through the single authority (task-fields.ts). The patch is
      // merged into the existing values (delete-on-null), mirroring
      // updateTaskCustomFields. Backward-compat note: U4 round-tripped the object
      // opaquely; the field system now enforces type/enum/unknown-id rules, so a
      // write against a workflow with no fields (the default) is rejected with a
      // typed CustomFieldRejectionError rather than silently persisted.
      if (updates.customFields !== undefined) {
        const defs = this.resolveTaskCustomFieldDefsSync(id);
        const result = validateCustomFieldPatch(defs, updates.customFields);
        if (!result.ok) throw new CustomFieldRejectionError(result.rejection);
        task.customFields = this.mergeCustomFieldPatch(task.customFields, result.normalized);
      }
      if (updates.currentStep !== undefined) task.currentStep = updates.currentStep;
      if (updates.status === null) {
        task.status = undefined;
      } else if (updates.status !== undefined) {
        task.status = updates.status;
      }
      if (updates.blockedBy === null) {
        task.blockedBy = undefined;
      } else if (updates.blockedBy !== undefined) {
        task.blockedBy = updates.blockedBy;
      }
      if (updates.overlapBlockedBy === null) {
        task.overlapBlockedBy = undefined;
      } else if (updates.overlapBlockedBy !== undefined) {
        task.overlapBlockedBy = updates.overlapBlockedBy;
      }
      const previousAssignedAgentId = task.assignedAgentId;
      if (updates.assignedAgentId === null) {
        task.assignedAgentId = undefined;
      } else if (updates.assignedAgentId !== undefined) {
        task.assignedAgentId = updates.assignedAgentId;
      }
      // If the agent that paused this task is being unassigned (or replaced),
      // auto-unpause: the pause was tied to that agent's lifecycle, and now
      // there's no longer a relationship that justifies keeping the task paused.
      const assignmentChanged =
        updates.assignedAgentId !== undefined && task.assignedAgentId !== previousAssignedAgentId;
      if (
        assignmentChanged &&
        task.paused &&
        task.pausedByAgentId &&
        task.pausedByAgentId === previousAssignedAgentId
      ) {
        task.paused = undefined;
        task.pausedByAgentId = undefined;
        if (task.column === "in-progress" || task.column === "in-review") {
          if (task.status === "paused") {
            task.status = undefined;
          }
        }
        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Task unpaused (agent ${previousAssignedAgentId} unassigned)`,
          ...(runContext ? { runContext } : {}),
        });
      }
      if (assignmentChanged) {
        this.syncAgentTaskLinkOnReassignment(id, previousAssignedAgentId, task.assignedAgentId);

        if (task.checkedOutBy === previousAssignedAgentId) {
          task.checkedOutBy = undefined;
          task.checkedOutAt = undefined;
        }

        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Agent task link synced: ${previousAssignedAgentId ?? "none"} → ${task.assignedAgentId ?? "none"}`,
          ...(runContext ? { runContext } : {}),
        });
      }
      if (updates.pausedByAgentId === null) {
        task.pausedByAgentId = undefined;
      } else if (updates.pausedByAgentId !== undefined) {
        task.pausedByAgentId = updates.pausedByAgentId;
      }
      if (updates.pausedReason === null) {
        task.pausedReason = undefined;
      } else if (updates.pausedReason !== undefined) {
        task.pausedReason = updates.pausedReason;
      }
      if (updates.tokenBudgetSoftAlertedAt === null) {
        task.tokenBudgetSoftAlertedAt = undefined;
      } else if (updates.tokenBudgetSoftAlertedAt !== undefined) {
        task.tokenBudgetSoftAlertedAt = updates.tokenBudgetSoftAlertedAt;
      }
      if (updates.worktrunkFallbackAlertedAt === null) {
        task.worktrunkFallbackAlertedAt = undefined;
      } else if (updates.worktrunkFallbackAlertedAt !== undefined) {
        task.worktrunkFallbackAlertedAt = updates.worktrunkFallbackAlertedAt;
      }
      if (updates.worktrunkFailure === null) {
        task.worktrunkFailure = undefined;
      } else if (updates.worktrunkFailure !== undefined) {
        task.worktrunkFailure = updates.worktrunkFailure;
      }
      if (updates.tokenBudgetHardAlertedAt === null) {
        task.tokenBudgetHardAlertedAt = undefined;
      } else if (updates.tokenBudgetHardAlertedAt !== undefined) {
        task.tokenBudgetHardAlertedAt = updates.tokenBudgetHardAlertedAt;
      }
      if (updates.tokenBudgetOverride === null) {
        task.tokenBudgetOverride = undefined;
      } else if (updates.tokenBudgetOverride !== undefined) {
        task.tokenBudgetOverride = updates.tokenBudgetOverride;
      }
      if (updates.dispatchStormCount === null) {
        task.dispatchStormCount = undefined;
      } else if (updates.dispatchStormCount !== undefined) {
        task.dispatchStormCount = updates.dispatchStormCount;
      }
      if (updates.lastDispatchAt === null) {
        task.lastDispatchAt = undefined;
      } else if (updates.lastDispatchAt !== undefined) {
        task.lastDispatchAt = updates.lastDispatchAt;
      }
      if (updates.assigneeUserId === null) {
        task.assigneeUserId = undefined;
      } else if (updates.assigneeUserId !== undefined) {
        task.assigneeUserId = updates.assigneeUserId;
      }
      if (updates.scopeOverride === null) {
        task.scopeOverride = undefined;
      } else if (updates.scopeOverride !== undefined) {
        task.scopeOverride = updates.scopeOverride || undefined;
      }
      if (updates.scopeOverrideReason === null) {
        task.scopeOverrideReason = undefined;
      } else if (updates.scopeOverrideReason !== undefined) {
        task.scopeOverrideReason = updates.scopeOverrideReason;
      }
      if (updates.scopeAutoWiden === null) {
        task.scopeAutoWiden = undefined;
      } else if (updates.scopeAutoWiden !== undefined) {
        task.scopeAutoWiden = [...updates.scopeAutoWiden];
      }
      if (updates.nodeId === null) {
        task.nodeId = undefined;
      } else if (updates.nodeId !== undefined) {
        task.nodeId = updates.nodeId;
      }
      if (updates.effectiveNodeId === null) {
        task.effectiveNodeId = undefined;
      } else if (updates.effectiveNodeId !== undefined) {
        task.effectiveNodeId = updates.effectiveNodeId;
      }
      if (updates.effectiveNodeSource === null) {
        task.effectiveNodeSource = undefined;
      } else if (updates.effectiveNodeSource !== undefined) {
        task.effectiveNodeSource = updates.effectiveNodeSource as Task["effectiveNodeSource"];
      }
      if (updates.checkedOutBy === null) {
        task.checkedOutBy = undefined;
        task.checkedOutAt = undefined;
        task.checkoutNodeId = undefined;
        task.checkoutRunId = undefined;
        task.checkoutLeaseRenewedAt = undefined;
      } else if (updates.checkedOutBy !== undefined) {
        task.checkedOutBy = updates.checkedOutBy;
        task.checkedOutAt = updates.checkedOutAt ?? task.checkedOutAt ?? new Date().toISOString();
        task.checkoutNodeId = updates.checkoutNodeId ?? task.checkoutNodeId;
        task.checkoutRunId = updates.checkoutRunId ?? task.checkoutRunId;
        task.checkoutLeaseRenewedAt = updates.checkoutLeaseRenewedAt ?? task.checkoutLeaseRenewedAt ?? task.checkedOutAt;
      }
      if (updates.checkoutNodeId === null) {
        task.checkoutNodeId = undefined;
      } else if (updates.checkoutNodeId !== undefined && updates.checkedOutBy === undefined) {
        task.checkoutNodeId = updates.checkoutNodeId;
      }
      if (updates.checkoutRunId === null) {
        task.checkoutRunId = undefined;
      } else if (updates.checkoutRunId !== undefined && updates.checkedOutBy === undefined) {
        task.checkoutRunId = updates.checkoutRunId;
      }
      if (updates.checkoutLeaseRenewedAt === null) {
        task.checkoutLeaseRenewedAt = undefined;
      } else if (updates.checkoutLeaseRenewedAt !== undefined && updates.checkedOutBy === undefined) {
        task.checkoutLeaseRenewedAt = updates.checkoutLeaseRenewedAt;
      }
      if (updates.checkoutLeaseEpoch === null) {
        task.checkoutLeaseEpoch = undefined;
      } else if (updates.checkoutLeaseEpoch !== undefined) {
        task.checkoutLeaseEpoch = updates.checkoutLeaseEpoch;
      }
      if (updates.paused !== undefined) task.paused = updates.paused || undefined;
      if (updates.baseBranch === null) {
        task.baseBranch = undefined;
      } else if (updates.baseBranch !== undefined) {
        task.baseBranch = updates.baseBranch;
      }
      // Explicit task-level auto-merge overrides written through updateTask are
      // user provenance. Task creation mirrors this for create-time overrides.
      if (updates.autoMerge === null) {
        task.autoMerge = undefined;
        task.autoMergeProvenance = undefined;
      } else if (updates.autoMerge !== undefined) {
        task.autoMerge = updates.autoMerge;
        task.autoMergeProvenance = "user";
      }
      if (updates.branch === null) {
        task.branch = undefined;
      } else if (updates.branch !== undefined) {
        task.branch = updates.branch;
      }
      // Keep in sync with the first autoMerge block above; both legacy update
      // paths may run before persistence.
      if (updates.autoMerge === null) {
        task.autoMerge = undefined;
        task.autoMergeProvenance = undefined;
      } else if (updates.autoMerge !== undefined) {
        task.autoMerge = updates.autoMerge;
        task.autoMergeProvenance = "user";
      }
      if (updates.executionStartBranch === null) {
        task.executionStartBranch = undefined;
      } else if (updates.executionStartBranch !== undefined) {
        task.executionStartBranch = updates.executionStartBranch;
      }
      if (updates.baseCommitSha === null) {
        task.baseCommitSha = undefined;
      } else if (updates.baseCommitSha !== undefined) {
        task.baseCommitSha = updates.baseCommitSha;
      }
      if (updates.size !== undefined) task.size = updates.size;
      if (updates.reviewLevel !== undefined) task.reviewLevel = updates.reviewLevel;
      if (updates.mergeRetries !== undefined) task.mergeRetries = updates.mergeRetries;
      if (updates.workflowStepRetries !== undefined) task.workflowStepRetries = updates.workflowStepRetries;
      if (updates.stuckKillCount === null) {
        task.stuckKillCount = undefined;
      } else if (updates.stuckKillCount !== undefined) {
        task.stuckKillCount = updates.stuckKillCount;
      }
      if (updates.resumeLimboCount === null) {
        task.resumeLimboCount = undefined;
      } else if (updates.resumeLimboCount !== undefined) {
        task.resumeLimboCount = updates.resumeLimboCount;
      }
      if (updates.graphResumeRetryCount === null) {
        task.graphResumeRetryCount = null;
      } else if (updates.graphResumeRetryCount !== undefined) {
        task.graphResumeRetryCount = updates.graphResumeRetryCount;
      }
      if (updates.resumeLimboTipSha === null) {
        task.resumeLimboTipSha = undefined;
      } else if (updates.resumeLimboTipSha !== undefined) {
        task.resumeLimboTipSha = updates.resumeLimboTipSha;
      }
      if (updates.resumeLimboStepSignature === null) {
        task.resumeLimboStepSignature = undefined;
      } else if (updates.resumeLimboStepSignature !== undefined) {
        task.resumeLimboStepSignature = updates.resumeLimboStepSignature;
      }
      if (updates.postReviewFixCount === null) {
        task.postReviewFixCount = undefined;
      } else if (updates.postReviewFixCount !== undefined) {
        task.postReviewFixCount = updates.postReviewFixCount;
      }
      if (updates.recoveryRetryCount === null) {
        task.recoveryRetryCount = undefined;
      } else if (updates.recoveryRetryCount !== undefined) {
        task.recoveryRetryCount = updates.recoveryRetryCount;
      }
      if (updates.taskDoneRetryCount === null) {
        task.taskDoneRetryCount = undefined;
      } else if (updates.taskDoneRetryCount !== undefined) {
        task.taskDoneRetryCount = updates.taskDoneRetryCount;
      }
      if (updates.worktreeSessionRetryCount === null) {
        task.worktreeSessionRetryCount = undefined;
      } else if (updates.worktreeSessionRetryCount !== undefined) {
        task.worktreeSessionRetryCount = updates.worktreeSessionRetryCount;
      }
      if (updates.completionHandoffLimboRecoveryCount === null) {
        task.completionHandoffLimboRecoveryCount = undefined;
      } else if (updates.completionHandoffLimboRecoveryCount !== undefined) {
        task.completionHandoffLimboRecoveryCount = updates.completionHandoffLimboRecoveryCount;
      }
      if (updates.verificationFailureCount === null) {
        task.verificationFailureCount = undefined;
      } else if (updates.verificationFailureCount !== undefined) {
        task.verificationFailureCount = updates.verificationFailureCount;
      }
      if (updates.mergeConflictBounceCount === null) {
        task.mergeConflictBounceCount = undefined;
      } else if (updates.mergeConflictBounceCount !== undefined) {
        task.mergeConflictBounceCount = updates.mergeConflictBounceCount;
      }
      if (updates.mergeAuditBounceCount === null) {
        task.mergeAuditBounceCount = undefined;
      } else if (updates.mergeAuditBounceCount !== undefined) {
        task.mergeAuditBounceCount = updates.mergeAuditBounceCount;
      }
      if (updates.mergeTransientRetryCount === null) {
        task.mergeTransientRetryCount = undefined;
      } else if (updates.mergeTransientRetryCount !== undefined) {
        task.mergeTransientRetryCount = updates.mergeTransientRetryCount;
      }
      if (updates.branchConflictRecoveryCount === null) {
        task.branchConflictRecoveryCount = undefined;
      } else if (updates.branchConflictRecoveryCount !== undefined) {
        task.branchConflictRecoveryCount = updates.branchConflictRecoveryCount;
      }
      if (updates.reviewerContextRetryCount === null) {
        task.reviewerContextRetryCount = undefined;
      } else if (updates.reviewerContextRetryCount !== undefined) {
        task.reviewerContextRetryCount = updates.reviewerContextRetryCount;
      }
      if (updates.reviewerFallbackRetryCount === null) {
        task.reviewerFallbackRetryCount = undefined;
      } else if (updates.reviewerFallbackRetryCount !== undefined) {
        task.reviewerFallbackRetryCount = updates.reviewerFallbackRetryCount;
      }
      if (updates.nextRecoveryAt === null) {
        task.nextRecoveryAt = undefined;
      } else if (updates.nextRecoveryAt !== undefined) {
        task.nextRecoveryAt = updates.nextRecoveryAt;
      }
      if (updates.enabledWorkflowSteps !== undefined) {
        task.enabledWorkflowSteps = await this.resolveEnabledWorkflowSteps(updates.enabledWorkflowSteps);
      }
      if (updates.noCommitsExpected === null) {
        task.noCommitsExpected = undefined;
      } else if (updates.noCommitsExpected !== undefined) {
        task.noCommitsExpected = updates.noCommitsExpected || undefined;
      }
      if (updates.modelProvider === null) {
        task.modelProvider = undefined;
      } else if (updates.modelProvider !== undefined) {
        task.modelProvider = updates.modelProvider;
      }
      if (updates.modelId === null) {
        task.modelId = undefined;
      } else if (updates.modelId !== undefined) {
        task.modelId = updates.modelId;
      }
      if (updates.validatorModelProvider === null) {
        task.validatorModelProvider = undefined;
      } else if (updates.validatorModelProvider !== undefined) {
        task.validatorModelProvider = updates.validatorModelProvider;
      }
      if (updates.validatorModelId === null) {
        task.validatorModelId = undefined;
      } else if (updates.validatorModelId !== undefined) {
        task.validatorModelId = updates.validatorModelId;
      }
      if (updates.planningModelProvider === null) {
        task.planningModelProvider = undefined;
      } else if (updates.planningModelProvider !== undefined) {
        task.planningModelProvider = updates.planningModelProvider;
      }
      if (updates.planningModelId === null) {
        task.planningModelId = undefined;
      } else if (updates.planningModelId !== undefined) {
        task.planningModelId = updates.planningModelId;
      }
      if (updates.thinkingLevel === null) {
        task.thinkingLevel = undefined;
      } else if (updates.thinkingLevel !== undefined) {
        task.thinkingLevel = updates.thinkingLevel as import("./types.js").ThinkingLevel;
      }
      if (updates.executionMode === null) {
        task.executionMode = undefined;
      } else if (updates.executionMode !== undefined) {
        task.executionMode = updates.executionMode as import("./types.js").ExecutionMode;
      }
      if (updates.error === null) {
        task.error = undefined;
      } else if (updates.error !== undefined) {
        task.error = updates.error;
      }
      if (updates.summary === null) {
        task.summary = undefined;
      } else if (updates.summary !== undefined) {
        task.summary = updates.summary;
      }
      if (updates.sessionFile === null) {
        task.sessionFile = undefined;
      } else if (updates.sessionFile !== undefined) {
        task.sessionFile = updates.sessionFile;
      }
      if (updates.firstExecutionAt === null) {
        task.firstExecutionAt = undefined;
      } else if (updates.firstExecutionAt !== undefined) {
        task.firstExecutionAt = updates.firstExecutionAt;
      }
      if (updates.cumulativeActiveMs === null) {
        task.cumulativeActiveMs = undefined;
      } else if (updates.cumulativeActiveMs !== undefined) {
        task.cumulativeActiveMs = updates.cumulativeActiveMs;
      }
      if (updates.executionStartedAt === null) {
        task.executionStartedAt = undefined;
      } else if (updates.executionStartedAt !== undefined) {
        task.executionStartedAt = updates.executionStartedAt;
      }
      if (updates.executionCompletedAt === null) {
        task.executionCompletedAt = undefined;
      } else if (updates.executionCompletedAt !== undefined) {
        task.executionCompletedAt = updates.executionCompletedAt;
      }
      if (updates.review === null) {
        task.review = undefined;
      } else if (updates.review !== undefined) {
        task.review = updates.review;
      }
      if (updates.reviewState === null) {
        task.reviewState = undefined;
      } else if (updates.reviewState !== undefined) {
        task.reviewState = normalizeTaskReviewState(updates.reviewState);
      }
      if (updates.workflowStepResults === null) {
        task.workflowStepResults = undefined;
      } else if (updates.workflowStepResults !== undefined) {
        task.workflowStepResults = updates.workflowStepResults;
      }
      if (updates.mergeDetails === null) {
        task.mergeDetails = undefined;
      } else if (updates.mergeDetails !== undefined) {
        task.mergeDetails = updates.mergeDetails;
      }
      if (updates.sourceIssue === null) {
        task.sourceIssue = undefined;
      } else if (updates.sourceIssue !== undefined) {
        task.sourceIssue = updates.sourceIssue;
      }
      if (updates.githubTracking === null) {
        task.githubTracking = undefined;
      } else if (updates.githubTracking !== undefined) {
        const previousTracking = task.githubTracking;
        const previousIssue = previousTracking?.issue;
        const nextTracking: import("./types.js").TaskGithubTracking = {
          ...(previousTracking ?? {}),
          ...updates.githubTracking,
        };

        if (updates.githubTracking.repoOverride === null) {
          nextTracking.repoOverride = undefined;
        }

        if (updates.githubTracking.enabled === false) {
          nextTracking.enabled = false;
          if (previousIssue) {
            nextTracking.issue = undefined;
            nextTracking.unlinkedAt = new Date().toISOString();
            task.log.push({
              timestamp: new Date().toISOString(),
              action: "GitHub issue unlinked",
              outcome: `${previousIssue.owner}/${previousIssue.repo}#${previousIssue.number}`,
              ...(runContext ? { runContext } : {}),
            });
          }
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "GitHub tracking disabled",
            ...(runContext ? { runContext } : {}),
          });
        }

        if (updates.githubTracking.enabled === true) {
          nextTracking.enabled = true;
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "GitHub tracking enabled",
            ...(runContext ? { runContext } : {}),
          });
        }

        if (updates.githubTracking.issue === null) {
          if (previousIssue) {
            task.log.push({
              timestamp: new Date().toISOString(),
              action: "GitHub issue unlinked",
              outcome: `${previousIssue.owner}/${previousIssue.repo}#${previousIssue.number}`,
              ...(runContext ? { runContext } : {}),
            });
          }
          nextTracking.issue = undefined;
          nextTracking.unlinkedAt = new Date().toISOString();
        }

        task.githubTracking = nextTracking;
      }
      if (updates.tokenUsage === null) {
        task.tokenUsage = undefined;
      } else if (updates.tokenUsage !== undefined) {
        task.tokenUsage = updates.tokenUsage;
      }
      if (updates.modifiedFiles === null) {
        task.modifiedFiles = undefined;
      } else if (updates.modifiedFiles !== undefined) {
        task.modifiedFiles = updates.modifiedFiles;
      }
      if (updates.missionId === null) {
        task.missionId = undefined;
      } else if (updates.missionId !== undefined) {
        task.missionId = updates.missionId;
      }
      if (updates.sliceId === null) {
        task.sliceId = undefined;
      } else if (updates.sliceId !== undefined) {
        task.sliceId = updates.sliceId;
      }
      task.updatedAt = new Date().toISOString();

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await this.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:update",
          target: task.id,
          metadata: {
            updatedFields: Object.keys(updates).filter((k) => (updates as Record<string, unknown>)[k] !== undefined),
            ...(titleNormalized ? { titleNormalized: true } : {}),
          },
        });
      } else {
        await this.atomicWriteTaskJson(dir, task);
      }

      // Update cache if watcher is active
      if (this.isWatching) this.taskCache.set(id, { ...task });

      if (updates.prompt !== undefined) {
        const validation = validateFileScopeInPromptContent(updates.prompt);
        if (validation.invalid.length > 0) {
          throw new InvalidFileScopeError(id, validation.invalid);
        }
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "PROMPT.md"), updates.prompt);
      }

      // Sync PROMPT.md when title or description changes (but not when explicit
      // prompt update — that already wrote the new content above).
      //
      // Two distinct cases:
      //
      // (a) Bootstrap stub — the auto-generated `# heading\n\n<desc>\n` block
      //     `createTask` writes. Rewrite the whole file from the new title +
      //     description so the human-visible stub stays in sync.
      //
      // (b) Real specification (any `##` section header, or the `**Created:**`
      //     / `**Size:**` metadata the triage prompt format requires). Do NOT
      //     rebuild the file from a section whitelist — earlier regressions
      //     either clobbered the spec entirely (FN-3056 + the previous
      //     `regeneratePrompt` path while column='triage') or silently dropped
      //     `## Review Level` / `## Frontend UX Criteria` and other custom
      //     sections (the same regen call on column!='triage'), which left the
      //     executor with reset review levels and missing UX guidance. Instead
      //     just splice the leading `#` heading line so the displayed title
      //     stays in sync with task.json; the body is preserved verbatim.
      //
      // task.json remains the canonical source for title/description fields.
      // PROMPT.md is only ever fully rewritten via explicit `updates.prompt`.
      if (updates.prompt === undefined && (updates.title !== undefined || updates.description !== undefined)) {
        const promptPath = join(dir, "PROMPT.md");
        if (existsSync(promptPath)) {
          const existingPrompt = await readFile(promptPath, "utf-8");

          if (isBootstrapPromptStub(existingPrompt, task.id, preUpdateTitle, preUpdateDescription)) {
            const newPrompt = buildBootstrapPrompt(task.id, task.title, task.description);
            await writeFile(promptPath, newPrompt);
          } else {
            // Real spec — surgical edits only. Each section we propagate to is
            // edited in place; everything else (Review Level, Frontend UX
            // Criteria, custom sections from triage) is preserved verbatim.
            let next = existingPrompt;
            if (updates.title !== undefined) {
              // Match the existing heading style: triage emits
              // `# Task: {id} - {title}`; createTask uses `# {id}: {title}`.
              const triageStyle = /^#\s+Task:\s+[A-Z]+-\d+\s+-\s+/m.test(existingPrompt);
              const heading = triageStyle
                ? (task.title ? `Task: ${task.id} - ${task.title}` : `Task: ${task.id}`)
                : (task.title ? `${task.id}: ${task.title}` : task.id);
              next = rewriteHeadingLine(next, heading);
            }
            if (updates.description !== undefined) {
              next = rewriteMissionSection(next, task.description);
            }
            if (next !== existingPrompt) {
              await writeFile(promptPath, next);
            }
          }
        }
      }

      if (movedToTriage) {
        this.emit("task:moved", { task, from: "todo" as Column, to: "triage" as Column, source: "engine" });
      }
      this.emitTaskLifecycleEventSafely("task:updated", [task]);
      return task;
    }
  }

  /**
   * Pause or unpause a task. Paused tasks are excluded from all automated
   * agent and scheduler interaction. Logs the action and emits `task:updated`.
   */
  async pauseTask(
    id: string,
    paused: boolean,
    runContext?: RunMutationContext,
    agentOptions?: { pausedByAgentId?: string },
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      const previousPausedByAgentId = task.pausedByAgentId;
      task.paused = paused || undefined;
      if (paused && agentOptions?.pausedByAgentId) {
        task.pausedByAgentId = agentOptions.pausedByAgentId;
      }
      if (!paused) {
        task.pausedByAgentId = undefined;
        task.userPaused = undefined;
      }
      // When pausing an in-progress/in-review task, set status so the UI can show the state.
      // When unpausing, clear the "paused" status.
      if (task.column === "in-progress" || task.column === "in-review") {
        task.status = paused ? "paused" : undefined;
      }
      const now = new Date().toISOString();
      task.updatedAt = now;
      const logEntry: TaskLogEntry = {
        timestamp: now,
        action: paused
          ? (agentOptions?.pausedByAgentId
            ? `Task paused (agent ${agentOptions.pausedByAgentId} paused)`
            : "Task paused")
          : (previousPausedByAgentId
            ? `Task unpaused (agent ${previousPausedByAgentId} resumed)`
            : "Task unpaused"),
      };
      if (runContext) {
        logEntry.runContext = runContext;
      }
      task.log.push(logEntry);

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await this.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: paused ? "task:pause" : "task:unpause",
          target: task.id,
        });
      } else {
        await this.atomicWriteTaskJson(dir, task);
      }
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Update a step's status. Automatically advances currentStep.
   */
  async updateStep(
    id: string,
    stepIndex: number,
    status: import("./types.js").StepStatus,
    options?: { source?: "graph" },
  ): Promise<Task> {
    // Step-inversion projection discipline (U6/KTD-7). A `source: "graph"` write
    // is the workflow-graph executor projecting a foreach instance's lifecycle
    // (in-progress / done / pending) onto Task.steps[] with EXPLICIT indices. Three
    // behaviors diverge from the legacy (default) write:
    //   (a) the out-of-order-done guard relaxes from strict index order to
    //       DEPENDENCY order (a done write is legal when every dependsOn step —
    //       default: the immediately-preceding step — is done/skipped, KTD-11);
    //   (b) a guard that DOES suppress a graph write logs an audit warning loudly
    //       (legacy stays silent — a graph suppression is a projection bug);
    //   (c) the auto-reinit-from-PROMPT.md path is bypassed (the graph pinned the
    //       step count at foreach expansion; re-parsing here would desync, KTD-3).
    const graphSource = options?.source === "graph";
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Auto-initialize steps from PROMPT.md if empty. Bypassed for graph-source
      // writes (U6/KTD-3): the graph owns explicit indices pinned at expansion.
      if (task.steps.length === 0 && !graphSource) {
        task.steps = await this.parseStepsFromPrompt(id);
      }

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (stepIndex < 0 || stepIndex >= task.steps.length) {
        throw new Error(
          `Step ${stepIndex} out of range (task has ${task.steps.length} steps)`,
        );
      }

      // Guard against agents (or stale tool calls) regressing completed work
      // by re-marking a done/skipped step as "in-progress". Overwriting the
      // step status would silently undo progress, and the currentStep
      // rewind below would discard the task's place in the plan.
      const currentStatus = task.steps[stepIndex].status;
      if (
        status === "in-progress" &&
        (currentStatus === "done" || currentStatus === "skipped")
      ) {
        const ts = new Date().toISOString();
        task.updatedAt = ts;
        task.log.push({
          timestamp: ts,
          action: `Ignored ${currentStatus}→in-progress regression for step ${stepIndex} (${task.steps[stepIndex].name})`,
        });
        await this.atomicWriteTaskJson(dir, task);
        if (this.isWatching) this.taskCache.set(id, { ...task });
        this.emit("task:updated", task);
        return task;
      }

      if (status === "done") {
        // The set of predecessor steps that must be done/skipped before this step
        // may go done. Legacy: strict index order (every earlier step). Graph: the
        // step's dependsOn list (default = the immediately-preceding step when the
        // annotation is absent — preserving sequential behavior, KTD-11).
        let blockingIndex = -1;
        let blockingStatus: import("./types.js").StepStatus | undefined;
        if (graphSource) {
          const deps = task.steps[stepIndex]?.dependsOn;
          const depIndices =
            Array.isArray(deps) && deps.length > 0
              ? deps
              : stepIndex > 0
              ? [stepIndex - 1]
              : [];
          for (const i of depIndices) {
            const priorStatus = task.steps[i]?.status;
            if (priorStatus === "pending" || priorStatus === "in-progress") {
              blockingIndex = i;
              blockingStatus = priorStatus;
              break;
            }
          }
        } else {
          for (let i = 0; i < stepIndex; i++) {
            const priorStatus = task.steps[i].status;
            if (priorStatus === "pending" || priorStatus === "in-progress") {
              blockingIndex = i;
              blockingStatus = priorStatus;
              break;
            }
          }
        }
        if (blockingIndex !== -1) {
          const ts = new Date().toISOString();
          task.updatedAt = ts;
          const kind = graphSource ? "dependency-order" : "out-of-order";
          task.log.push({
            timestamp: ts,
            action:
              `Ignored ${kind} ${status} for step ${stepIndex} (${task.steps[stepIndex].name}) — ` +
              `${graphSource ? "dependency" : "earlier"} step ${blockingIndex} (${task.steps[blockingIndex].name}) is still ${blockingStatus}`,
          });
          // Graph-source suppression is a projection bug — surface it loudly in
          // the activity log (U6) rather than the legacy silent ignore.
          if (graphSource) {
            task.log.push({
              timestamp: ts,
              action:
                `[integrity-warning] graph-source updateStep suppressed: step ${stepIndex} ` +
                `(${task.steps[stepIndex].name}) → done blocked by unmet dependency ` +
                `step ${blockingIndex} (${blockingStatus})`,
            });
          }
          await this.atomicWriteTaskJson(dir, task);
          if (this.isWatching) this.taskCache.set(id, { ...task });
          this.emit("task:updated", task);
          return task;
        }
      }

      task.steps[stepIndex].status = status;
      task.updatedAt = new Date().toISOString();

      // Advance currentStep to first non-done/non-skipped step
      if (status === "done") {
        while (
          task.currentStep < task.steps.length &&
          (task.steps[task.currentStep].status === "done" || task.steps[task.currentStep].status === "skipped")
        ) {
          task.currentStep++;
        }
      } else if (status === "in-progress") {
        task.currentStep = stepIndex;
      }

      /*
      FNXC:SelfHealing 2026-06-21-12:45:
      Forward progress clears the stuck-kill streak. stuckKillCount is otherwise a lifetime
      counter — incremented by self-healing on each stuck-kill (checkStuckBudget) and reset
      ONLY by a manual retry (manual-retry-reset) — so a long task that genuinely advances
      between intermittent stalls could still be terminalized by accumulation toward
      maxStuckKills (default 6). Resetting when a step reaches a terminal forward status
      (done/skipped) makes only CONSECUTIVE stalls count toward the budget. This does NOT
      rescue a task wedged re-running the same failing step (no step completes between those
      kills, so the streak keeps climbing and the task still terminalizes as designed); it
      bounds the budget to consecutive no-progress stalls. Complements the FN-5048
      verification-fan-out cap that keeps verification from being slow in the first place.
      */
      if ((status === "done" || status === "skipped") && (task.stuckKillCount ?? 0) > 0) {
        task.stuckKillCount = undefined;
        task.log.push({
          timestamp: task.updatedAt,
          action: `Reset stuck-kill streak (forward progress: step ${stepIndex} (${task.steps[stepIndex].name}) → ${status})`,
        });
      }

      // Log it
      task.log.push({
        timestamp: task.updatedAt,
        action: `Step ${stepIndex} (${task.steps[stepIndex].name}) → ${status}`,
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Add a log entry to a task.
   */
  async logEntry(id: string, action: string, outcome?: string, runContext?: RunMutationContext): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const entry: TaskLogEntry = {
        timestamp: new Date().toISOString(),
        action,
        outcome: truncateTaskLogOutcome(outcome),
      };
      if (runContext) {
        if (this.isTaskArchived(id)) {
          throw new Error(`Task ${id} is archived — logging is read-only`);
        }

        const dir = this.taskDir(id);
        const task = await this.readTaskJson(dir);

        // Initialize log array if missing (for legacy tasks)
        if (!task.log) {
          task.log = [];
        }

        entry.runContext = runContext;
        task.log.push(entry);
        if (task.log.length > taskActivityLogEntryLimit) {
          task.log.splice(0, task.log.length - taskActivityLogEntryLimit);
        }
        task.updatedAt = new Date().toISOString();

        // When runContext is provided, record audit event atomically with task mutation.
        await this.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:log",
          target: task.id,
          metadata: { action, outcome },
        });

        if (this.isWatching) this.taskCache.set(id, { ...task });
        this.emit("task:updated", task);
        return task;
      }

      // Fast path for high-volume log entries: update only the log + updatedAt fields
      // instead of reading/writing the entire task payload on every append.
      const row = this.db.prepare(`SELECT log, "column" FROM tasks WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`).get(id) as
        | { log: string | null; column: Column }
        | undefined;
      if (!row) {
        if (this.isTaskArchived(id)) {
          throw new Error(`Task ${id} is archived — logging is read-only`);
        }
        throw new Error(`Task ${id} not found`);
      }

      if (row.column === "archived") {
        throw new Error(`Task ${id} is archived — logging is read-only`);
      }

      const log = fromJson<TaskLogEntry[]>(row.log) || [];
      log.push(entry);
      if (log.length > taskActivityLogEntryLimit) {
        log.splice(0, log.length - taskActivityLogEntryLimit);
      }
      const updatedAt = new Date().toISOString();

      this.db.prepare("UPDATE tasks SET log = ?, updatedAt = ? WHERE id = ?").run(toJson(log), updatedAt, id);
      this.db.bumpLastModified();

      const current = this.readTaskFromDb(id);
      if (current) {
        await this.writeTaskJsonFile(this.taskDir(id), current);
        if (this.isWatching) {
          this.taskCache.set(id, { ...current });
        }
        this.emitTaskLifecycleEventSafely("task:updated", [current]);
        return current;
      }

      const emittedTask = ({ id, log, updatedAt } as unknown) as Task;
      this.emitTaskLifecycleEventSafely("task:updated", [emittedTask]);
      return emittedTask;
    });
  }

  /**
   * Get all task log entries correlated with a specific run ID.
   * Scans all tasks' logs for entries whose runContext.runId matches.
   */
  async getMutationsForRun(runId: string): Promise<TaskLogEntry[]> {
    const rows = this.db.prepare(`SELECT log FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE}`).all() as Array<{ log: string | null }>;
    const mutations: TaskLogEntry[] = [];
    for (const row of rows) {
      const logEntries = fromJson<TaskLogEntry[]>(row.log) || [];
      for (const entry of logEntries) {
        if (entry.runContext?.runId === runId) {
          mutations.push(entry);
        }
      }
    }
    // Sort by timestamp ascending
    return mutations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // ── Run Audit APIs ───────────────────────────────────────────────────

  private rowToMergeQueueEntry(row: MergeQueueRow): MergeQueueEntry {
    return {
      taskId: row.taskId,
      enqueuedAt: row.enqueuedAt,
      priority: normalizeTaskPriority(row.priority),
      leasedBy: row.leasedBy,
      leasedAt: row.leasedAt,
      leaseExpiresAt: row.leaseExpiresAt,
      attemptCount: row.attemptCount,
      lastError: row.lastError,
    };
  }

  private normalizeMergeRequestState(value: string): MergeRequestState {
    switch (value) {
      case "queued":
      case "running":
      case "retrying":
      case "succeeded":
      case "exhausted":
      case "cancelled":
      case "manual-required":
        return value;
      default:
        return "queued";
    }
  }

  private rowToMergeRequestRecord(row: MergeRequestRow): MergeRequestRecord {
    return {
      taskId: row.taskId,
      state: this.normalizeMergeRequestState(row.state),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      attemptCount: row.attemptCount,
      lastError: row.lastError,
    };
  }

  private rowToCompletionHandoffMarker(row: CompletionHandoffMarkerRow): CompletionHandoffMarker {
    return {
      taskId: row.taskId,
      acceptedAt: row.acceptedAt,
      source: row.source,
    };
  }

  private normalizeWorkflowWorkItemKind(value: string): WorkflowWorkItemKind {
    switch (value) {
      case "task":
      case "merge":
      case "retry":
      case "manual-hold":
      case "recovery":
        return value;
      default:
        return "task";
    }
  }

  private normalizeWorkflowWorkItemState(value: string): WorkflowWorkItemState {
    switch (value) {
      case "runnable":
      case "running":
      case "held":
      case "retrying":
      case "manual-required":
      case "succeeded":
      case "failed":
      case "cancelled":
      case "exhausted":
        return value;
      default:
        return "runnable";
    }
  }

  private isTerminalWorkflowWorkItemState(state: WorkflowWorkItemState): boolean {
    return state === "succeeded" || state === "failed" || state === "cancelled" || state === "exhausted";
  }

  private isActiveWorkflowWorkItemState(state: WorkflowWorkItemState): boolean {
    return state === "runnable" || state === "running" || state === "held" || state === "retrying" || state === "manual-required";
  }

  private workflowStateForMergeRequestState(state: MergeRequestState): WorkflowWorkItemState {
    const states: Record<MergeRequestState, WorkflowWorkItemState> = {
      queued: "runnable",
      running: "running",
      retrying: "retrying",
      succeeded: "succeeded",
      exhausted: "exhausted",
      cancelled: "cancelled",
      "manual-required": "manual-required",
    };
    return states[state];
  }

  private rowToWorkflowWorkItem(row: WorkflowWorkItemRow): WorkflowWorkItem {
    return {
      id: row.id,
      runId: row.runId,
      taskId: row.taskId,
      nodeId: row.nodeId,
      kind: this.normalizeWorkflowWorkItemKind(row.kind),
      state: this.normalizeWorkflowWorkItemState(row.state),
      attempt: row.attempt,
      retryAfter: row.retryAfter,
      leaseOwner: row.leaseOwner,
      leaseExpiresAt: row.leaseExpiresAt,
      lastError: row.lastError,
      blockedReason: row.blockedReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private isValidMergeRequestTransition(from: MergeRequestState, to: MergeRequestState): boolean {
    if (from === to) return true;
    const allowed: Record<MergeRequestState, ReadonlySet<MergeRequestState>> = {
      queued: new Set(["running", "cancelled"]),
      running: new Set(["retrying", "succeeded", "exhausted", "cancelled"]),
      retrying: new Set(["queued", "cancelled", "exhausted"]),
      succeeded: new Set([]),
      exhausted: new Set([]),
      cancelled: new Set([]),
      "manual-required": new Set(["succeeded", "cancelled"]),
    };
    return allowed[from].has(to);
  }

  upsertMergeRequestRecord(
    taskId: string,
    input: { state: MergeRequestState; now?: string; attemptCount?: number; lastError?: string | null },
  ): MergeRequestRecord {
    return this.db.transactionImmediate(() => {
      const now = input.now ?? new Date().toISOString();
      this.db.prepare(`
        INSERT INTO merge_requests (taskId, state, createdAt, updatedAt, attemptCount, lastError)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(taskId) DO UPDATE SET
          state = excluded.state,
          updatedAt = excluded.updatedAt,
          attemptCount = excluded.attemptCount,
          lastError = excluded.lastError
      `).run(taskId, input.state, now, now, input.attemptCount ?? 0, input.lastError ?? null);

      const row = this.db.prepare("SELECT * FROM merge_requests WHERE taskId = ?").get(taskId) as MergeRequestRow | undefined;
      if (!row) throw new Error(`Failed to upsert merge request for ${taskId}`);

      this.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeRequest:upsert",
        target: taskId,
        metadata: { taskId, state: row.state, attemptCount: row.attemptCount, lastError: row.lastError },
      });

      return this.rowToMergeRequestRecord(row);
    });
  }

  transitionMergeRequestState(
    taskId: string,
    toState: MergeRequestState,
    opts: { now?: string; attemptCount?: number; lastError?: string | null } = {},
  ): MergeRequestRecord {
    return this.db.transactionImmediate(() => {
      const now = opts.now ?? new Date().toISOString();
      const existing = this.db.prepare("SELECT * FROM merge_requests WHERE taskId = ?").get(taskId) as MergeRequestRow | undefined;
      if (!existing) {
        throw new Error(`Merge request record not found for ${taskId}`);
      }
      const fromState = this.normalizeMergeRequestState(existing.state);
      if (!this.isValidMergeRequestTransition(fromState, toState)) {
        throw new Error(`Invalid merge request state transition for ${taskId}: ${fromState} -> ${toState}`);
      }

      this.db.prepare(`
        UPDATE merge_requests
           SET state = ?,
               updatedAt = ?,
               attemptCount = ?,
               lastError = ?
         WHERE taskId = ?
      `).run(toState, now, opts.attemptCount ?? existing.attemptCount, opts.lastError ?? existing.lastError, taskId);

      const updated = this.db.prepare("SELECT * FROM merge_requests WHERE taskId = ?").get(taskId) as MergeRequestRow | undefined;
      if (!updated) throw new Error(`Merge request record disappeared for ${taskId}`);

      this.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeRequest:transition",
        target: taskId,
        metadata: { taskId, fromState, toState, attemptCount: updated.attemptCount, lastError: updated.lastError },
      });
      return this.rowToMergeRequestRecord(updated);
    });
  }

  getMergeRequestRecord(taskId: string): MergeRequestRecord | null {
    const row = this.db.prepare("SELECT * FROM merge_requests WHERE taskId = ?").get(taskId) as MergeRequestRow | undefined;
    return row ? this.rowToMergeRequestRecord(row) : null;
  }

  projectMergeRequestToWorkflowWorkItem(
    taskId: string,
    opts: MergeRequestWorkflowProjectionOptions = {},
  ): WorkflowWorkItem | null {
    return this.db.transactionImmediate(() => {
      const record = this.getMergeRequestRecord(taskId);
      if (!record) return null;
      const state = this.workflowStateForMergeRequestState(record.state);
      const kind = record.state === "manual-required" ? "manual-hold" : "merge";
      const item = this.upsertWorkflowWorkItem({
        runId: opts.runId ?? `merge-request:${taskId}`,
        taskId,
        nodeId: opts.nodeId ?? "builtin.merge.request",
        kind,
        state,
        attempt: record.attemptCount,
        lastError: record.lastError,
        blockedReason: record.state === "manual-required" ? record.lastError ?? "manual merge required" : null,
        now: opts.now ?? record.updatedAt,
      });
      this.cancelActiveWorkflowWorkItemsForTask(taskId, {
        kinds: [kind === "manual-hold" ? "merge" : "manual-hold"],
        now: opts.now ?? record.updatedAt,
        lastError: "superseded-by-merge-request-projection",
      });
      this.insertRunAuditEventRow({
        taskId,
        runId: item.runId,
        domain: "database",
        mutationType: "mergeRequest:workflow-projection",
        target: item.id,
        metadata: { taskId, mergeRequestState: record.state, workflowState: item.state, workItemKind: item.kind },
      });
      return item;
    });
  }

  createCompletionHandoffWorkflowWork(
    task: Pick<Task, "id" | "autoMerge" | "priority">,
    opts: { runId?: string; now?: string; source?: string } = {},
  ): WorkflowWorkItem {
    const autoMerge = task.autoMerge !== false;
    const runId = opts.runId ?? `completion-handoff:${task.id}:${randomUUID()}`;
    const nodeId = autoMerge ? "merge-gate" : "merge-manual-hold";
    const kind: WorkflowWorkItemKind = autoMerge ? "merge" : "manual-hold";
    const existing = this.getWorkflowWorkItemByIdentity(runId, task.id, nodeId, kind);
    if (existing && this.isActiveWorkflowWorkItemState(existing.state)) {
      this.cancelActiveWorkflowWorkItemsForTask(task.id, {
        kinds: ["merge", "manual-hold"],
        excludeIds: [existing.id],
        now: opts.now,
        lastError: "superseded-by-completion-handoff",
      });
      this.insertCompletionHandoffWorkflowWorkAudit(task, existing, autoMerge, opts.source);
      return existing;
    }

    this.cancelActiveWorkflowWorkItemsForTask(task.id, {
      kinds: ["merge", "manual-hold"],
      now: opts.now,
      lastError: "superseded-by-completion-handoff",
    });
    const item = this.upsertWorkflowWorkItem({
      runId,
      taskId: task.id,
      nodeId,
      kind,
      state: autoMerge ? "runnable" : "manual-required",
      blockedReason: autoMerge ? null : "autoMerge:false",
      now: opts.now,
    });
    this.insertCompletionHandoffWorkflowWorkAudit(task, item, autoMerge, opts.source);
    return item;
  }

  private getWorkflowWorkItemByIdentity(
    runId: string,
    taskId: string,
    nodeId: string,
    kind: WorkflowWorkItemKind,
  ): WorkflowWorkItem | null {
    const row = this.db
      .prepare("SELECT * FROM workflow_work_items WHERE runId = ? AND taskId = ? AND nodeId = ? AND kind = ?")
      .get(runId, taskId, nodeId, kind) as WorkflowWorkItemRow | undefined;
    return row ? this.rowToWorkflowWorkItem(row) : null;
  }

  private insertCompletionHandoffWorkflowWorkAudit(
    task: Pick<Task, "id">,
    item: WorkflowWorkItem,
    autoMerge: boolean,
    source?: string,
  ): void {
    this.insertRunAuditEventRow({
      taskId: task.id,
      runId: item.runId,
      domain: "database",
      mutationType: "workflowWorkItem:completion-handoff",
      target: item.id,
      metadata: {
        taskId: task.id,
        autoMerge,
        source: source ?? "completion-handoff",
        workItemId: item.id,
        nodeId: item.nodeId,
        state: item.state,
      },
    });
  }

  upsertWorkflowWorkItem(input: WorkflowWorkItemUpsertInput): WorkflowWorkItem {
    return this.db.transactionImmediate(() => {
      const existing = this.db
        .prepare("SELECT * FROM workflow_work_items WHERE runId = ? AND taskId = ? AND nodeId = ? AND kind = ?")
        .get(input.runId, input.taskId, input.nodeId, input.kind) as WorkflowWorkItemRow | undefined;
      const now = input.now ?? new Date().toISOString();
      const existingState = existing ? this.normalizeWorkflowWorkItemState(existing.state) : null;
      const state = input.state ?? existingState ?? "runnable";
      if (existingState && this.isTerminalWorkflowWorkItemState(existingState) && existingState !== state) {
        throw new Error(
          `Workflow work item ${existing?.id ?? input.id ?? input.nodeId} is terminal (${existingState}) and cannot be requeued as ${state}`,
        );
      }

      const id = existing?.id ?? input.id ?? randomUUID();
      this.db
        .prepare(
          `INSERT INTO workflow_work_items (
             id, runId, taskId, nodeId, kind, state, attempt, retryAfter,
             leaseOwner, leaseExpiresAt, lastError, blockedReason, createdAt, updatedAt
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(runId, taskId, nodeId, kind) DO UPDATE SET
             state = excluded.state,
             attempt = excluded.attempt,
             retryAfter = excluded.retryAfter,
             leaseOwner = excluded.leaseOwner,
             leaseExpiresAt = excluded.leaseExpiresAt,
             lastError = excluded.lastError,
             blockedReason = excluded.blockedReason,
             updatedAt = excluded.updatedAt`,
        )
        .run(
          id,
          input.runId,
          input.taskId,
          input.nodeId,
          input.kind,
          state,
          input.attempt ?? existing?.attempt ?? 0,
          input.retryAfter === undefined ? existing?.retryAfter ?? null : input.retryAfter,
          input.leaseOwner === undefined ? existing?.leaseOwner ?? null : input.leaseOwner,
          input.leaseExpiresAt === undefined ? existing?.leaseExpiresAt ?? null : input.leaseExpiresAt,
          input.lastError === undefined ? existing?.lastError ?? null : input.lastError,
          input.blockedReason === undefined ? existing?.blockedReason ?? null : input.blockedReason,
          existing?.createdAt ?? now,
          now,
        );

      const row = this.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!row) throw new Error(`Failed to upsert workflow work item ${id}`);
      this.insertRunAuditEventRow({
        taskId: row.taskId,
        runId: row.runId,
        domain: "database",
        mutationType: "workflowWorkItem:upsert",
        target: row.id,
        metadata: { id: row.id, nodeId: row.nodeId, kind: row.kind, state: row.state, attempt: row.attempt },
      });
      return this.rowToWorkflowWorkItem(row);
    });
  }

  transitionWorkflowWorkItem(
    id: string,
    state: WorkflowWorkItemState,
    patch: WorkflowWorkItemTransitionPatch = {},
  ): WorkflowWorkItem {
    return this.db.transactionImmediate(() => {
      const now = patch.now ?? new Date().toISOString();
      const existing = this.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!existing) throw new Error(`Workflow work item ${id} not found`);
      const fromState = this.normalizeWorkflowWorkItemState(existing.state);
      if (this.isTerminalWorkflowWorkItemState(fromState) && fromState !== state) {
        throw new Error(`Workflow work item ${id} is terminal (${fromState}) and cannot transition to ${state}`);
      }

      this.db
        .prepare(
          `UPDATE workflow_work_items
              SET state = ?,
                  attempt = ?,
                  retryAfter = ?,
                  leaseOwner = ?,
                  leaseExpiresAt = ?,
                  lastError = ?,
                  blockedReason = ?,
                  updatedAt = ?
            WHERE id = ?`,
        )
        .run(
          state,
          patch.attempt ?? existing.attempt,
          patch.retryAfter === undefined ? existing.retryAfter : patch.retryAfter,
          patch.leaseOwner === undefined ? existing.leaseOwner : patch.leaseOwner,
          patch.leaseExpiresAt === undefined ? existing.leaseExpiresAt : patch.leaseExpiresAt,
          patch.lastError === undefined ? existing.lastError : patch.lastError,
          patch.blockedReason === undefined ? existing.blockedReason : patch.blockedReason,
          now,
          id,
        );

      const updated = this.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!updated) throw new Error(`Workflow work item ${id} disappeared`);
      this.insertRunAuditEventRow({
        taskId: updated.taskId,
        runId: updated.runId,
        domain: "database",
        mutationType: "workflowWorkItem:transition",
        target: updated.id,
        metadata: { id: updated.id, fromState, toState: state, attempt: updated.attempt },
      });
      return this.rowToWorkflowWorkItem(updated);
    });
  }

  getWorkflowWorkItem(id: string): WorkflowWorkItem | null {
    const row = this.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
    return row ? this.rowToWorkflowWorkItem(row) : null;
  }

  listWorkflowWorkItemsForTask(taskId: string, opts: { kinds?: WorkflowWorkItemKind[] } = {}): WorkflowWorkItem[] {
    const conditions = ["taskId = ?"];
    const params: unknown[] = [taskId];
    if (opts.kinds?.length) {
      conditions.push(`kind IN (${opts.kinds.map(() => "?").join(", ")})`);
      params.push(...opts.kinds);
    }
    const rows = this.db
      .prepare(
        `SELECT *
           FROM workflow_work_items
          WHERE ${conditions.join(" AND ")}
          ORDER BY createdAt ASC, id ASC`,
      )
      .all(...params) as WorkflowWorkItemRow[];
    return rows.map((row) => this.rowToWorkflowWorkItem(row));
  }

  cancelActiveWorkflowWorkItemsForTask(
    taskId: string,
    opts: { kinds?: WorkflowWorkItemKind[]; now?: string; lastError?: string | null; excludeIds?: string[] } = {},
  ): WorkflowWorkItem[] {
    return this.db.transactionImmediate(() => {
      const excludeIds = new Set(opts.excludeIds ?? []);
      const items = this.listWorkflowWorkItemsForTask(taskId, opts).filter((item) =>
        this.isActiveWorkflowWorkItemState(item.state) && !excludeIds.has(item.id)
      );
      return items.map((item) =>
        this.transitionWorkflowWorkItem(item.id, "cancelled", {
          now: opts.now,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: opts.lastError ?? item.lastError ?? "cancelled-by-user-hard-cancel",
        }),
      );
    });
  }

  listDueWorkflowWorkItems(filter: WorkflowWorkItemDueFilter = {}): WorkflowWorkItem[] {
    const now = filter.now ?? new Date().toISOString();
    const includeExpiredRunning = !filter.states || filter.states.includes("running");
    const states = filter.states?.length ? filter.states : ["runnable", "retrying"];
    const stateConditions = [`(state IN (${states.map(() => "?").join(", ")}) AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?))`];
    const params: unknown[] = [...states, now];
    if (includeExpiredRunning) {
      stateConditions.push("(state = 'running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ?)");
      params.push(now);
    }
    const conditions = [
      `(${stateConditions.join(" OR ")})`,
      "(retryAfter IS NULL OR retryAfter <= ?)",
    ];
    params.push(now);
    if (filter.kinds?.length) {
      conditions.push(`kind IN (${filter.kinds.map(() => "?").join(", ")})`);
      params.push(...filter.kinds);
    }
    params.push(filter.limit ?? 100);

    const rows = this.db
      .prepare(
        `SELECT *
           FROM workflow_work_items
          WHERE ${conditions.join(" AND ")}
          ORDER BY retryAfter IS NOT NULL, retryAfter ASC, createdAt ASC
          LIMIT ?`,
      )
      .all(...params) as WorkflowWorkItemRow[];
    return rows.map((row) => this.rowToWorkflowWorkItem(row));
  }

  acquireWorkflowWorkItemLease(
    id: string,
    leaseOwner: string,
    opts: { leaseDurationMs: number; now?: string },
  ): WorkflowWorkItem | null {
    if (opts.leaseDurationMs <= 0) {
      throw new Error(`workflow work item leaseDurationMs must be > 0 (received ${opts.leaseDurationMs})`);
    }

    return this.db.transactionImmediate(() => {
      const now = opts.now ?? new Date().toISOString();
      const leaseExpiresAt = new Date(new Date(now).getTime() + opts.leaseDurationMs).toISOString();
      const result = this.db
        .prepare(
          `UPDATE workflow_work_items
              SET state = 'running',
                  leaseOwner = ?,
                  leaseExpiresAt = ?,
                  updatedAt = ?
            WHERE id = ?
              AND state IN ('runnable', 'retrying', 'running')
              AND (retryAfter IS NULL OR retryAfter <= ?)
              AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= ?)`,
        )
        .run(leaseOwner, leaseExpiresAt, now, id, now, now);
      if (result.changes === 0) return null;

      const row = this.db.prepare("SELECT * FROM workflow_work_items WHERE id = ?").get(id) as WorkflowWorkItemRow | undefined;
      if (!row) throw new Error(`Workflow work item ${id} disappeared`);
      this.insertRunAuditEventRow({
        taskId: row.taskId,
        runId: row.runId,
        domain: "database",
        mutationType: "workflowWorkItem:lease-acquired",
        target: row.id,
        metadata: { id: row.id, leaseOwner: row.leaseOwner, leaseExpiresAt: row.leaseExpiresAt },
      });
      return this.rowToWorkflowWorkItem(row);
    });
  }

  setCompletionHandoffAcceptedMarker(
    taskId: string,
    opts: { source: string; acceptedAt?: string },
  ): CompletionHandoffMarker {
    return this.db.transactionImmediate(() => {
      const acceptedAt = opts.acceptedAt ?? new Date().toISOString();
      this.db.prepare(`
        INSERT INTO completion_handoff_markers (taskId, acceptedAt, source)
        VALUES (?, ?, ?)
        ON CONFLICT(taskId) DO UPDATE SET
          acceptedAt = excluded.acceptedAt,
          source = excluded.source
      `).run(taskId, acceptedAt, opts.source);

      const row = this.db.prepare("SELECT * FROM completion_handoff_markers WHERE taskId = ?").get(taskId) as CompletionHandoffMarkerRow | undefined;
      if (!row) throw new Error(`Failed to set completion handoff marker for ${taskId}`);

      this.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "task:completion-handoff-accepted",
        target: taskId,
        metadata: { taskId, acceptedAt: row.acceptedAt, source: row.source },
      });

      return this.rowToCompletionHandoffMarker(row);
    });
  }

  clearCompletionHandoffAcceptedMarker(taskId: string): void {
    this.db.transactionImmediate(() => {
      const existing = this.db.prepare("SELECT * FROM completion_handoff_markers WHERE taskId = ?").get(taskId) as CompletionHandoffMarkerRow | undefined;
      if (!existing) return;
      this.db.prepare("DELETE FROM completion_handoff_markers WHERE taskId = ?").run(taskId);
      this.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "task:completion-handoff-cleared",
        target: taskId,
        metadata: { taskId, acceptedAt: existing.acceptedAt, source: existing.source },
      });
    });
  }

  getCompletionHandoffAcceptedMarker(taskId: string): CompletionHandoffMarker | null {
    const row = this.db.prepare("SELECT * FROM completion_handoff_markers WHERE taskId = ?").get(taskId) as CompletionHandoffMarkerRow | undefined;
    return row ? this.rowToCompletionHandoffMarker(row) : null;
  }

  /**
   * Persist a project-scoped plugin/extension activation event for Command Center analytics.
   *
   * FNXC:CommandCenterEcosystem 2026-06-19-00:00:
   * Plugin activations must be recorded as real project DB events before the Ecosystem card can show a count; null pluginVersion preserves unknown version as missing data rather than an empty-string metric.
   */
  recordPluginActivation(input: PluginActivationInput): PluginActivation {
    const activatedAt = input.activatedAt ?? new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO plugin_activations (pluginId, source, pluginVersion, activatedAt)
      VALUES (?, ?, ?, ?)
    `).run(input.pluginId, input.source, input.pluginVersion ?? null, activatedAt);

    return {
      id: Number(result.lastInsertRowid),
      pluginId: input.pluginId,
      source: input.source,
      pluginVersion: input.pluginVersion ?? null,
      activatedAt,
    };
  }

  /**
   * Convert a database row to a RunAuditEvent object.
   */
  private rowToRunAuditEvent(row: RunAuditEventRow): RunAuditEvent {
    return {
      id: row.id,
      timestamp: row.timestamp,
      taskId: row.taskId || undefined,
      agentId: row.agentId,
      runId: row.runId,
      domain: row.domain as RunAuditEvent["domain"],
      mutationType: row.mutationType,
      target: row.target,
      metadata: fromJson<Record<string, unknown>>(row.metadata),
    };
  }

  /**
   * Record a run-audit event.
   *
   * Persists a structured audit trail entry correlating a mutation to the
   * heartbeat run that caused it. Use this to track database mutations,
   * git operations, and filesystem changes initiated by agent runs.
   *
   * @param input - The audit event input (runId, agentId, domain, mutationType, target, optional metadata)
   * @returns The persisted RunAuditEvent with generated id and timestamp
   */
  recordRunAuditEvent(input: RunAuditEventInput): RunAuditEvent {
    const id = randomUUID();
    const timestamp = input.timestamp ?? new Date().toISOString();

    const event: RunAuditEvent = {
      id,
      timestamp,
      taskId: input.taskId,
      agentId: input.agentId,
      runId: input.runId,
      domain: input.domain,
      mutationType: input.mutationType,
      target: input.target,
      metadata: input.metadata,
    };

    this.db.transactionImmediate(() => {
      this.db.prepare(`
        INSERT INTO runAuditEvents (
          id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.timestamp,
        event.taskId ?? null,
        event.agentId,
        event.runId,
        event.domain,
        event.mutationType,
        event.target,
        toJsonNullable(event.metadata),
      );
    });

    return event;
  }

  private isLegacyAutoMergeStampCandidate(task: Pick<Task, "column" | "autoMerge" | "autoMergeProvenance">): boolean {
    return task.column === "in-review" && task.autoMerge === true && task.autoMergeProvenance !== "user";
  }

  private async listLegacyAutoMergeStampCandidates(): Promise<Task[]> {
    const inReview = await this.listTasks({ column: "in-review" });
    return inReview.filter((task) => this.isLegacyAutoMergeStampCandidate(task));
  }

  /**
   * Dry-run or apply the operator-driven cleanup for legacy review-entry
   * auto-merge stamps. Dry-run is the default and only reports candidates.
   * With apply=true, ambiguous legacy stamps are cleared so the task follows the
   * live global autoMerge setting again. Explicit user overrides are never
   * candidates and are preserved.
   */
  async reconcileLegacyAutoMergeStamps(options?: { apply?: boolean }): Promise<LegacyAutoMergeStampReconcileResult[]> {
    const candidates = await this.listLegacyAutoMergeStampCandidates();
    const results: LegacyAutoMergeStampReconcileResult[] = [];

    if (options?.apply !== true) {
      return candidates.map((task) => ({ taskId: task.id, column: task.column, cleared: false }));
    }

    for (const candidate of candidates) {
      const current = await this.getTask(candidate.id);
      if (!current || !this.isLegacyAutoMergeStampCandidate(current)) {
        continue;
      }

      const priorAutoMerge = current.autoMerge;
      const priorProvenance = current.autoMergeProvenance;
      current.autoMerge = undefined;
      current.autoMergeProvenance = undefined;
      current.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(this.taskDir(current.id), current);
      if (this.isWatching) this.taskCache.set(current.id, { ...current });
      this.emitTaskLifecycleEventSafely("task:updated", [current]);

      this.recordRunAuditEvent({
        taskId: current.id,
        agentId: "system",
        runId: `legacy-auto-merge-stamp-clear-${current.id}-${Date.now()}`,
        domain: "database",
        mutationType: "task:auto-merge-legacy-stamp-cleared",
        target: current.id,
        metadata: {
          taskId: current.id,
          priorAutoMerge,
          priorAutoMergeProvenance: priorProvenance ?? null,
          action: "cleared-to-follow-global-autoMerge",
        },
      });
      results.push({ taskId: current.id, column: current.column, cleared: true });
    }

    return results;
  }

  private async markLegacyAutoMergeStampsOnce(): Promise<void> {
    const markerRow = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(LEGACY_AUTO_MERGE_STAMP_MARKER_KEY) as
      | { value: string }
      | undefined;
    if (markerRow?.value === LEGACY_AUTO_MERGE_STAMP_MARKER_VERSION) {
      return;
    }

    const candidates = await this.listLegacyAutoMergeStampCandidates();
    const markedTaskIds: string[] = [];
    for (const candidate of candidates) {
      const current = await this.getTask(candidate.id);
      if (!current || !this.isLegacyAutoMergeStampCandidate(current)) {
        continue;
      }
      current.autoMergeProvenance = "legacy-stamp";
      current.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(this.taskDir(current.id), current);
      if (this.isWatching) this.taskCache.set(current.id, { ...current });
      this.emitTaskLifecycleEventSafely("task:updated", [current]);
      markedTaskIds.push(current.id);

      this.recordRunAuditEvent({
        taskId: current.id,
        agentId: "system",
        runId: `legacy-auto-merge-stamp-mark-${current.id}-${Date.now()}`,
        domain: "database",
        mutationType: "task:auto-merge-legacy-stamp-marked",
        target: current.id,
        metadata: {
          taskId: current.id,
          autoMerge: true,
          autoMergeProvenance: "legacy-stamp",
          action: "marked-only-no-behavior-change",
        },
      });
    }

    this.db.prepare(`
      INSERT INTO __meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(LEGACY_AUTO_MERGE_STAMP_MARKER_KEY, LEGACY_AUTO_MERGE_STAMP_MARKER_VERSION);
    this.db.bumpLastModified();

    storeLog.log("legacy auto-merge stamp marker completed", {
      phase: "legacy-auto-merge-stamp-marker",
      markedCount: markedTaskIds.length,
      markedTaskIds: markedTaskIds.slice(0, 50),
      truncated: markedTaskIds.length > 50,
    });
  }

  /**
   * Query run-audit events with optional filters.
   *
   * @param options - Filter options (runId, taskId, startTime, endTime, domain, mutationType, limit)
   * @returns Array of matching RunAuditEvent records, ordered by timestamp DESC, rowid DESC
   *
   * @remarks
   * Time-range filtering uses **inclusive bounds**: `timestamp >= startTime` and `timestamp <= endTime`.
   * When no time range is specified, all matching records are returned.
   *
   * Query results are ordered by timestamp descending with a stable rowid tiebreaker:
   * `ORDER BY timestamp DESC, rowid DESC`. This ensures deterministic ordering
   * when multiple events share the same millisecond timestamp.
   */
  getRunAuditEvents(options: RunAuditEventFilter = {}): RunAuditEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.runId) {
      conditions.push("runId = ?");
      params.push(options.runId);
    }

    if (options.taskId) {
      conditions.push("taskId = ?");
      params.push(options.taskId);
    }

    if (options.agentId) {
      conditions.push("agentId = ?");
      params.push(options.agentId);
    }

    if (options.domain) {
      conditions.push("domain = ?");
      params.push(options.domain);
    }

    if (options.mutationType) {
      conditions.push("mutationType = ?");
      params.push(options.mutationType);
    }

    // Inclusive time range: timestamp >= startTime AND timestamp <= endTime
    if (options.startTime) {
      conditions.push("timestamp >= ?");
      params.push(options.startTime);
    }

    if (options.endTime) {
      conditions.push("timestamp <= ?");
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = options.limit ? `LIMIT ${Math.max(1, options.limit)}` : "";
    const orderClause = "ORDER BY timestamp DESC, rowid DESC";

    // Cast params to the expected SQLite input type
    const sqlParams = params as (string | number | null)[];

    const rows = this.db.prepare(`
      SELECT * FROM runAuditEvents
      ${whereClause}
      ${orderClause}
      ${limitClause}
    `).all(...sqlParams) as unknown as RunAuditEventRow[];

    return rows.map((row) => this.rowToRunAuditEvent(row));
  }

  /**
   * Aggregate the dual-observe parity audit events (CU-U5) into the graduation
   * signal: how often the interpreter's shadow observation agreed with the
   * legacy authoritative run, and which fields drift when it doesn't.
   */
  getWorkflowParitySummary(options: { since?: string; limit?: number } = {}): WorkflowParitySummary {
    const limit = options.limit ?? 1000;
    const observed = this.getRunAuditEvents({
      domain: "database",
      mutationType: WORKFLOW_PARITY_OBSERVED_MUTATION as unknown as RunAuditEvent["mutationType"],
      startTime: options.since,
      limit,
    });
    const driftEvents = this.getRunAuditEvents({
      domain: "database",
      mutationType: WORKFLOW_PARITY_DRIFT_MUTATION as unknown as RunAuditEvent["mutationType"],
      startTime: options.since,
      limit,
    });

    let agreed = 0;
    for (const event of observed) {
      if (event.metadata?.agree === true) agreed += 1;
    }

    const driftFieldCounts: Record<string, number> = {};
    const recentDrift: WorkflowParitySummary["recentDrift"] = [];
    for (const event of driftEvents) {
      const diffs = Array.isArray(event.metadata?.diffs)
        ? (event.metadata.diffs as WorkflowParityDiff[])
        : [];
      for (const diff of diffs) {
        driftFieldCounts[diff.field] = (driftFieldCounts[diff.field] ?? 0) + 1;
      }
      if (recentDrift.length < 20) {
        recentDrift.push({ taskId: event.taskId ?? event.target, timestamp: event.timestamp, diffs });
      }
    }

    return {
      observed: observed.length,
      agreed,
      drift: driftEvents.length,
      agreeRate: observed.length > 0 ? agreed / observed.length : 0,
      driftFieldCounts,
      recentDrift,
    };
  }

  /**
   * Aggregate the `workflowColumns` flag default-flip criteria (U12, KTD-8) into
   * a single graduation report: five-invariant dual-observe parity, the default
   * workflow's transition parity vs VALID_TRANSITIONS, and the dual-accept
   * marker/column disagreement count (U6, FN-5719). The flip is a FIELD decision
   * — this report is the GATE. Does NOT flip the flag; callers inspect `ready`
   * and `blockers`.
   */
  computeWorkflowColumnsGraduationReport(
    options: { since?: string; limit?: number } = {},
  ): WorkflowColumnsGraduationReport {
    const limit = options.limit ?? 1000;
    const parity = this.getWorkflowParitySummary(options);
    const dualAcceptEvents: RunAuditEvent[] = [];
    for (const mutationType of DUAL_ACCEPT_PARITY_MUTATIONS) {
      dualAcceptEvents.push(
        ...this.getRunAuditEvents({
          domain: "database",
          mutationType: mutationType as unknown as RunAuditEvent["mutationType"],
          startTime: options.since,
          limit,
        }),
      );
    }
    return computeWorkflowColumnsGraduationReport({
      parity,
      defaultWorkflowIr: BUILTIN_CODING_WORKFLOW_IR,
      dualAcceptEvents,
    });
  }

  enqueueMergeQueue(taskId: string, opts: MergeQueueEnqueueOptions = {}): MergeQueueEntry {
    let invalidColumn: Column | null = null;
    const entry = this.db.transactionImmediate(() => {
      const existing = this.db.prepare("SELECT * FROM mergeQueue WHERE taskId = ?").get(taskId) as MergeQueueRow | undefined;
      const taskRow = this.db.prepare("SELECT priority, column FROM tasks WHERE id = ?").get(taskId) as { priority: string | null; column: Column } | undefined;
      if (!taskRow) {
        throw new MergeQueueTaskNotFoundError(taskId);
      }
      if (taskRow.column !== "in-review") {
        invalidColumn = taskRow.column;
        return null;
      }

      const now = opts.now ?? new Date().toISOString();
      const priority = opts.priority ?? normalizeTaskPriority(taskRow.priority);

      let nextEntry: MergeQueueEntry;
      let alreadyEnqueued = true;
      if (existing) {
        nextEntry = this.rowToMergeQueueEntry(existing);
      } else {
        this.db.prepare(`
          INSERT INTO mergeQueue (taskId, enqueuedAt, priority, attemptCount)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(taskId) DO NOTHING
        `).run(taskId, now, priority);
        const inserted = this.db.prepare("SELECT * FROM mergeQueue WHERE taskId = ?").get(taskId) as MergeQueueRow | undefined;
        if (!inserted) {
          throw new Error(`Failed to read merge queue entry for ${taskId} after enqueue`);
        }
        nextEntry = this.rowToMergeQueueEntry(inserted);
        alreadyEnqueued = false;
      }

      this.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeQueue:enqueue",
        target: taskId,
        metadata: {
          taskId,
          priority: nextEntry.priority,
          enqueuedAt: nextEntry.enqueuedAt,
          alreadyEnqueued,
        },
      });

      return nextEntry;
    });

    if (invalidColumn) {
      this.db.transactionImmediate(() => {
        this.insertRunAuditEventRow({
          taskId,
          domain: "database",
          mutationType: "mergeQueue:enqueue-rejected",
          target: taskId,
          metadata: {
            taskId,
            column: invalidColumn,
            reason: "not-in-review",
          },
        });
      });
      throw new MergeQueueInvalidColumnError(taskId, invalidColumn);
    }

    if (!entry) {
      throw new Error(`Failed to enqueue merge queue entry for ${taskId}`);
    }
    return entry;
  }

  private cleanupStaleMergeQueueRows(now: string): void {
    const staleRows = this.db.prepare(`
      SELECT mq.taskId, mq.leasedBy, mq.leaseExpiresAt, t.column
        FROM mergeQueue mq
        LEFT JOIN tasks t ON t.id = mq.taskId
       WHERE t.id IS NULL OR t.column != 'in-review'
    `).all() as Array<{ taskId: string; leasedBy: string | null; leaseExpiresAt: string | null; column: Column | null }>;

    for (const staleRow of staleRows) {
      this.db.prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(staleRow.taskId);
      this.insertRunAuditEventRow({
        taskId: staleRow.taskId,
        domain: "database",
        mutationType: "mergeQueue:auto-cleanup-stale-row",
        target: staleRow.taskId,
        metadata: {
          taskId: staleRow.taskId,
          column: staleRow.column,
          leasedBy: staleRow.leasedBy,
          leaseExpiresAt: staleRow.leaseExpiresAt,
          cleanedAt: now,
          reason: "not-in-review",
        },
      });
    }
  }

  private dequeueMergeQueueOnColumnExit(taskId: string, previousColumn: ColumnId, nextColumn: ColumnId, now: string): void {
    if (previousColumn !== "in-review" || nextColumn === "in-review") {
      return;
    }

    const queueRow = this.db.prepare("SELECT leasedBy, leaseExpiresAt FROM mergeQueue WHERE taskId = ?").get(taskId) as {
      leasedBy: string | null;
      leaseExpiresAt: string | null;
    } | undefined;
    if (!queueRow) {
      return;
    }

    const leaseIsExpired = queueRow.leaseExpiresAt != null && queueRow.leaseExpiresAt <= now;
    if (!queueRow.leasedBy || leaseIsExpired) {
      this.db.prepare("DELETE FROM mergeQueue WHERE taskId = ?").run(taskId);
      this.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeQueue:auto-cleanup-stale-row",
        target: taskId,
        metadata: {
          taskId,
          previousColumn,
          nextColumn,
          leasedBy: queueRow.leasedBy,
          leaseExpiresAt: queueRow.leaseExpiresAt,
          cleanedAt: now,
          reason: "column-exit",
        },
      });
      return;
    }

    this.insertRunAuditEventRow({
      taskId,
      domain: "database",
      mutationType: "mergeQueue:stale-lease-on-column-exit",
      target: taskId,
      metadata: {
        taskId,
        previousColumn,
        nextColumn,
        leasedBy: queueRow.leasedBy,
        leaseExpiresAt: queueRow.leaseExpiresAt,
      },
    });
  }

  acquireMergeQueueLease(workerId: string, opts: MergeQueueAcquireOptions): MergeQueueEntry | null {
    if (opts.leaseDurationMs <= 0) {
      throw new InvalidMergeQueueLeaseDurationError(opts.leaseDurationMs);
    }

    return this.db.transactionImmediate(() => {
      const now = opts.now ?? new Date().toISOString();
      const leaseExpiresAt = new Date(Date.parse(now) + opts.leaseDurationMs).toISOString();
      this.cleanupStaleMergeQueueRows(now);

      let leased: MergeQueueRow | undefined;
      if (opts.targetTaskId) {
        leased = this.db.prepare(`
          UPDATE mergeQueue
             SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ?
           WHERE taskId = ?
             AND EXISTS (
               SELECT 1
                 FROM tasks t
                WHERE t.id = mergeQueue.taskId
                  AND t.column = 'in-review'
             )
             AND (leasedBy IS NULL OR leaseExpiresAt <= ?)
           RETURNING *
        `).get(workerId, now, leaseExpiresAt, opts.targetTaskId, now) as MergeQueueRow | undefined;

        if (!leased) {
          const queueHead = this.db.prepare(`
            SELECT mq.taskId, mq.leasedBy, t.column
              FROM mergeQueue mq
              LEFT JOIN tasks t ON t.id = mq.taskId
             ORDER BY CASE mq.priority
                        WHEN 'urgent' THEN 0
                        WHEN 'high'   THEN 1
                        WHEN 'normal' THEN 2
                        WHEN 'low'    THEN 3
                        ELSE 4
                      END ASC,
                      mq.enqueuedAt ASC
             LIMIT 1
          `).get() as { taskId: string; leasedBy: string | null; column: string | null } | undefined;

          this.insertRunAuditEventRow({
            taskId: opts.targetTaskId,
            domain: "database",
            mutationType: "mergeQueue:lease-target-unavailable",
            target: opts.targetTaskId,
            metadata: {
              targetTaskId: opts.targetTaskId,
              workerId,
              queueHeadTaskId: queueHead?.taskId ?? null,
              queueHeadLeasedBy: queueHead?.leasedBy ?? null,
              queueHeadColumn: queueHead?.column ?? null,
            },
          });
          return null;
        }
      } else {
        leased = this.db.prepare(`
          UPDATE mergeQueue
             SET leasedBy = ?, leasedAt = ?, leaseExpiresAt = ?
           WHERE taskId = (
             SELECT mq.taskId
               FROM mergeQueue mq
               JOIN tasks t ON t.id = mq.taskId
              WHERE t.column = 'in-review'
                AND (mq.leasedBy IS NULL OR mq.leaseExpiresAt <= ?)
              ORDER BY CASE mq.priority
                         WHEN 'urgent' THEN 0
                         WHEN 'high'   THEN 1
                         WHEN 'normal' THEN 2
                         WHEN 'low'    THEN 3
                         ELSE 4
                       END ASC,
                       mq.enqueuedAt ASC
              LIMIT 1
           )
           RETURNING *
        `).get(workerId, now, leaseExpiresAt, now) as MergeQueueRow | undefined;

        if (!leased) {
          return null;
        }
      }

      const entry = this.rowToMergeQueueEntry(leased);
      this.insertRunAuditEventRow({
        taskId: entry.taskId,
        domain: "database",
        mutationType: "mergeQueue:lease-acquired",
        target: entry.taskId,
        metadata: {
          taskId: entry.taskId,
          workerId,
          leaseExpiresAt: entry.leaseExpiresAt,
          priority: entry.priority,
        },
      });
      return entry;
    });
  }

  releaseMergeQueueLease(taskId: string, workerId: string, outcome: MergeQueueReleaseOutcome): void {
    this.db.transactionImmediate(() => {
      const current = this.db.prepare("SELECT leasedBy FROM mergeQueue WHERE taskId = ?").get(taskId) as { leasedBy: string | null } | undefined;
      if (!current || current.leasedBy !== workerId) {
        throw new MergeQueueLeaseOwnershipError(taskId, workerId, current?.leasedBy ?? null);
      }

      if (outcome.kind === "success") {
        this.db.prepare("DELETE FROM mergeQueue WHERE taskId = ? AND leasedBy = ?").run(taskId, workerId);
        this.insertRunAuditEventRow({
          taskId,
          domain: "database",
          mutationType: "mergeQueue:lease-released",
          target: taskId,
          metadata: {
            taskId,
            workerId,
            outcome: "success",
          },
        });
        return;
      }

      const released = this.db.prepare(`
        UPDATE mergeQueue
           SET leasedBy = NULL,
               leasedAt = NULL,
               leaseExpiresAt = NULL,
               attemptCount = attemptCount + 1,
               lastError = ?
         WHERE taskId = ? AND leasedBy = ?
         RETURNING *
      `).get(outcome.error, taskId, workerId) as MergeQueueRow | undefined;
      if (!released) {
        throw new MergeQueueLeaseOwnershipError(taskId, workerId, null);
      }

      const entry = this.rowToMergeQueueEntry(released);
      this.insertRunAuditEventRow({
        taskId,
        domain: "database",
        mutationType: "mergeQueue:lease-released",
        target: taskId,
        metadata: {
          taskId,
          workerId,
          outcome: "failure",
          attemptCount: entry.attemptCount,
          error: outcome.error,
        },
      });
    });
  }

  recoverExpiredMergeQueueLeases(now: string = new Date().toISOString()): MergeQueueEntry[] {
    return this.db.transactionImmediate(() => {
      const expired = this.db.prepare(`
        SELECT * FROM mergeQueue
         WHERE leasedBy IS NOT NULL AND leaseExpiresAt <= ?
         ORDER BY leaseExpiresAt ASC, enqueuedAt ASC
      `).all(now) as MergeQueueRow[];
      if (expired.length === 0) {
        return [];
      }

      const recoveredRows = this.db.prepare(`
        UPDATE mergeQueue
           SET leasedBy = NULL,
               leasedAt = NULL,
               leaseExpiresAt = NULL
         WHERE leasedBy IS NOT NULL AND leaseExpiresAt <= ?
         RETURNING *
      `).all(now) as MergeQueueRow[];

      const previousByTaskId = new Map(expired.map((row) => [row.taskId, row]));
      for (const row of recoveredRows) {
        const previous = previousByTaskId.get(row.taskId);
        this.insertRunAuditEventRow({
          taskId: row.taskId,
          domain: "database",
          mutationType: "mergeQueue:lease-expired",
          target: row.taskId,
          metadata: {
            taskId: row.taskId,
            previousLeasedBy: previous?.leasedBy ?? null,
            previousLeaseExpiresAt: previous?.leaseExpiresAt ?? null,
            recoveredAt: now,
          },
        });
      }

      return recoveredRows.map((row) => this.rowToMergeQueueEntry(row));
    });
  }

  peekMergeQueue(): MergeQueueEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM mergeQueue
      ORDER BY CASE priority
                 WHEN 'urgent' THEN 0
                 WHEN 'high'   THEN 1
                 WHEN 'normal' THEN 2
                 WHEN 'low'    THEN 3
                 ELSE 4
               END ASC,
               enqueuedAt ASC
    `).all() as MergeQueueRow[];
    return rows.map((row) => this.rowToMergeQueueEntry(row));
  }

  peekMergeQueueHead(): { taskId: string; leasedBy: string | null; column: Column | null } | null {
    const row = this.db.prepare(`
      SELECT mq.taskId, mq.leasedBy, t.column
        FROM mergeQueue mq
        LEFT JOIN tasks t ON t.id = mq.taskId
       ORDER BY CASE mq.priority
                  WHEN 'urgent' THEN 0
                  WHEN 'high'   THEN 1
                  WHEN 'normal' THEN 2
                  WHEN 'low'    THEN 3
                  ELSE 4
                END ASC,
                mq.enqueuedAt ASC
       LIMIT 1
    `).get() as { taskId: string; leasedBy: string | null; column: Column | null } | undefined;
    return row ?? null;
  }

  // ── End Run Audit APIs ───────────────────────────────────────────────

  /**
   * Sync steps from PROMPT.md into task.json (called when steps are empty).
   */
  async parseStepsFromPrompt(id: string): Promise<import("./types.js").TaskStep[]> {
    const dir = this.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");
    // Step-inversion U12 (KTD-12): delegate to the registry's `step-headings`
    // parser (resolved by id, not a direct import) so the registry path is
    // proven and stays byte-identical to the extracted function. The parser
    // yields `{ name, dependsOn? }`; re-apply the `pending` status here.
    const parser = getStepParser("step-headings");
    if (!parser) {
      throw new Error("Step parser 'step-headings' is not registered");
    }
    return parser.parse(content).steps.map((s) =>
      s.dependsOn
        ? { name: s.name, status: "pending" as const, dependsOn: s.dependsOn }
        : { name: s.name, status: "pending" as const },
    );
  }

  /**
   * Parse the `## Dependencies` section from a task's PROMPT.md and extract
   * task IDs from lines matching `- **Task:** {ID}` (where ID is `[A-Z]+-\d+`).
   *
   * Returns an empty array if the section says `- **None**`, has no task
   * references, or if the section/file doesn't exist.
   *
   * @param id - The task ID whose PROMPT.md to parse
   * @returns Array of dependency task IDs (e.g. `["KB-001", "KB-002"]`)
   */
  async parseDependenciesFromPrompt(id: string): Promise<string[]> {
    const dir = this.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    // Find the ## Dependencies section.
    // We locate the heading then slice to the next heading (or end of file)
    // to avoid multiline `$` anchor issues with lazy quantifiers.
    const headingMatch = content.match(/^##\s+Dependencies\s*$/m);
    if (!headingMatch) return [];

    const startIdx = headingMatch.index! + headingMatch[0].length;
    const rest = content.slice(startIdx);
    const nextHeading = rest.search(/\n##?\s/);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

    const ids: string[] = [];
    const taskIdRegex = /^-\s+\*\*Task:\*\*\s+([A-Z]+-\d+)/gm;
    let match;
    while ((match = taskIdRegex.exec(section)) !== null) {
      ids.push(match[1]);
    }

    return ids;
  }

  /**
   * Parse the `## File Scope` section from a task's PROMPT.md and extract
   * backtick-quoted file paths. Glob patterns ending in `/*` are stored
   * as directory prefixes for overlap comparison.
   */
  async parseFileScopeFromPrompt(id: string): Promise<string[]> {
    const dir = this.taskDir(id);
    const promptPath = join(dir, "PROMPT.md");
    if (!existsSync(promptPath)) return [];

    const content = await readFile(promptPath, "utf-8");

    const paths = extractFileScopeTokens(content);
    return paths.filter((path) => isValidFileScopeEntry(path));
  }

  private makeSyntheticDeleteRunId(taskId: string): string {
    return `synthetic-task-delete-${taskId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Soft-delete a live task by setting tasks.deletedAt/updatedAt while leaving
   * the row and on-disk task artifacts in place for potential recovery.
   *
   * Idempotent (FN-5127): calling deleteTask on an already-soft-deleted task is
   * a no-op and does not re-emit task:deleted.
   */
  async deleteTask(
    id: string,
    options?: {
      removeDependencyReferences?: boolean;
      removeLineageReferences?: boolean;
      allowResurrection?: boolean;
      githubIssueAction?: GithubIssueAction;
      auditContext?: { agentId: string; runId: string; sessionId?: string };
    },
  ): Promise<Task> {
    const deletedTask = await this.withTaskLock(id, async () => {
      // Flush buffered agent logs inside the lock so no new appends for this
      // task can sneak in between flush and soft-delete mutation.
      this.flushAgentLogBuffer();
      const task = this.readTaskFromDb(id, { includeDeleted: true });
      if (!task) {
        throw new Error(`Task ${id} not found`);
      }

      if (task.deletedAt) {
        return task;
      }

      // Refuse to delete a task that is still referenced as a dependency
      // by another live task unless the caller explicitly opts into
      // removing those incoming references as part of this delete.
      const dependentIds = this.findLiveDependents(id);
      if (dependentIds.length > 0 && !options?.removeDependencyReferences) {
        throw new TaskHasDependentsError(id, dependentIds);
      }

      // FN-5127: lineage gate must execute after idempotent short-circuit.
      const lineageChildIds = this.findLiveLineageChildren(id);
      if (lineageChildIds.length > 0 && !options?.removeLineageReferences) {
        throw new TaskHasLineageChildrenError(id, lineageChildIds);
      }

      // Clean up the task's branch before deleting from DB
      const cleanedBranches = await this.cleanupBranchForTask(task);
      if (cleanedBranches.length > 0) {
        if (!task.log) task.log = [];
        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Cleaned up branch: ${cleanedBranches.join(", ")}`,
        });
      }

      let rewrittenDependents: Task[] = [];
      let rewrittenBlockedByResidueDependents: Task[] = [];
      let rewrittenLineageChildren: Task[] = [];
      this.db.transaction(() => {
        rewrittenDependents = this.rewriteDependentsForRemoval(id, dependentIds);
        rewrittenBlockedByResidueDependents = this.rewriteBlockedByResidueDependentsForRemoval(id, new Set(dependentIds));
        rewrittenLineageChildren = this.rewriteLineageChildrenForRemoval(id, lineageChildIds);
        const deletedAt = new Date().toISOString();
        const allowResurrection = options?.allowResurrection === true ? 1 : 0;
        this.db.prepare("UPDATE tasks SET \"column\" = 'archived', deletedAt = ?, allowResurrection = ?, updatedAt = ? WHERE id = ?").run(deletedAt, allowResurrection, deletedAt, id);
        this.recordRunAuditEvent({
          domain: "database",
          mutationType: "task:deleted",
          target: task.id,
          taskId: task.id,
          agentId: options?.auditContext?.agentId ?? "system",
          runId: options?.auditContext?.runId ?? this.makeSyntheticDeleteRunId(task.id),
          metadata: {
            previousColumn: task.column,
            previousStatus: task.status ?? null,
            githubIssueAction: options?.githubIssueAction ?? "auto",
            removeDependencyReferences: !!options?.removeDependencyReferences,
            removeLineageReferences: !!options?.removeLineageReferences,
            allowResurrection: options?.allowResurrection === true,
            sessionId: options?.auditContext?.sessionId,
          },
        });
        this.clearLinkedAgentTaskIds(id, deletedAt);
        // FN-5143: agent log reads are gated on deletedAt (see getAgentLogs /
        // getAgentLogCount / getAgentLogsByTimeRange), so downstream readers
        // observe zero logs immediately after deletedAt is set. The JSONL file
        // remains on disk for forensic analysis; only the read API hides it.
        this.db.bumpLastModified();
      });

      // FN-5143 defense-in-depth: drop any in-memory buffer entries for this
      // task. flushAgentLogBuffer() above already ran inside the lock, but a
      // concurrent appendAgentLog from another async path could re-buffer
      // before this lock releases; the next flush would still drop them via
      // ACTIVE_TASKS_WHERE, but filtering here avoids the warn log and keeps
      // memory bounded.
      if (this.agentLogBuffer.length > 0) {
        this.agentLogBuffer = this.agentLogBuffer.filter((entry) => entry.taskId !== id);
      }

      // Remove from cache if watcher is active
      if (this.isWatching) this.taskCache.delete(id);

      for (const dependentTask of rewrittenDependents) {
        this.emit("task:updated", dependentTask);
      }
      for (const dependentTask of rewrittenBlockedByResidueDependents) {
        this.emit("task:updated", dependentTask);
      }
      for (const lineageChild of rewrittenLineageChildren) {
        this.emit("task:updated", lineageChild);
      }

      const linkedFeature = this.missionStore?.getFeatureByTaskId(id);
      if (linkedFeature) {
        this.missionStore?.unlinkFeatureFromTask(linkedFeature.id);
      }

      this.emit("task:deleted", task, { githubIssueAction: options?.githubIssueAction ?? "auto" });
      return task;
    });

    await this.clearNearDuplicateReferencesToFailSoft(id, {
      column: "archived",
      deletedAt: deletedTask.deletedAt ?? new Date().toISOString(),
      reason: "deleted",
    });
    return deletedTask;
  }

  private deleteTaskById(taskId: string): void {
    this.clearLinkedAgentTaskIds(taskId);
    this.purgeTaskWorkflowSelectionRows(taskId);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    this.db.bumpLastModified();
  }

  private rewriteDependentsForRemoval(taskId: string, dependentIds: string[]): Task[] {
    const rewrittenDependents: Task[] = [];

    for (const dependentId of dependentIds) {
      const dependentTask = this.readTaskFromDb(dependentId);
      if (!dependentTask) continue;

      const nextDependencies = dependentTask.dependencies.filter((dependencyId) => dependencyId !== taskId);
      const clearsBlockedBy = dependentTask.blockedBy === taskId;
      if (nextDependencies.length === dependentTask.dependencies.length && !clearsBlockedBy) {
        continue;
      }

      const updatedLog = clearsBlockedBy
        ? [
          ...(dependentTask.log ?? []),
          {
            timestamp: new Date().toISOString(),
            action: `Auto-unblocked: blocker ${taskId} was soft-deleted`,
          },
        ]
        : dependentTask.log;
      const updatedDependent: Task = {
        ...dependentTask,
        dependencies: nextDependencies,
        blockedBy: clearsBlockedBy ? undefined : dependentTask.blockedBy,
        status: clearsBlockedBy ? undefined : dependentTask.status,
        log: updatedLog,
        updatedAt: new Date().toISOString(),
      };

      this.db.prepare("UPDATE tasks SET dependencies = ?, blockedBy = ?, status = ?, log = ?, updatedAt = ? WHERE id = ?").run(
        toJson(updatedDependent.dependencies),
        updatedDependent.blockedBy ?? null,
        updatedDependent.status ?? null,
        toJson(updatedDependent.log ?? []),
        updatedDependent.updatedAt,
        updatedDependent.id,
      );
      if (this.isWatching) {
        this.taskCache.set(updatedDependent.id, updatedDependent);
      }
      rewrittenDependents.push(updatedDependent);
    }

    return rewrittenDependents;
  }

  private rewriteBlockedByResidueDependentsForRemoval(taskId: string, excludedDependentIds: Set<string>): Task[] {
    const rewrittenDependents: Task[] = [];
    const candidates = this.db
      .prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND blockedBy = ?`)
      .all(taskId) as Array<{ id: string }>;

    for (const candidate of candidates) {
      if (excludedDependentIds.has(candidate.id)) continue;
      const dependentTask = this.readTaskFromDb(candidate.id);
      if (!dependentTask || dependentTask.blockedBy !== taskId) continue;

      const updatedDependent: Task = {
        ...dependentTask,
        blockedBy: undefined,
        status: undefined,
        log: [
          ...(dependentTask.log ?? []),
          {
            timestamp: new Date().toISOString(),
            action: `Auto-unblocked: blocker ${taskId} was soft-deleted`,
          },
        ],
        updatedAt: new Date().toISOString(),
      };

      this.db.prepare("UPDATE tasks SET blockedBy = NULL, status = NULL, log = ?, updatedAt = ? WHERE id = ?").run(
        toJson(updatedDependent.log ?? []),
        updatedDependent.updatedAt,
        updatedDependent.id,
      );

      if (this.isWatching) {
        this.taskCache.set(updatedDependent.id, updatedDependent);
      }
      rewrittenDependents.push(updatedDependent);
    }

    return rewrittenDependents;
  }

  private rewriteLineageChildrenForRemoval(parentId: string, childIds: string[]): Task[] {
    const rewrittenChildren: Task[] = [];

    for (const childId of childIds) {
      const childTask = this.readTaskFromDb(childId);
      if (!childTask || childTask.sourceParentTaskId !== parentId) continue;

      const updatedChild: Task = {
        ...childTask,
        sourceParentTaskId: undefined,
        updatedAt: new Date().toISOString(),
      };

      this.db.prepare("UPDATE tasks SET sourceParentTaskId = NULL, updatedAt = ? WHERE id = ?").run(updatedChild.updatedAt, updatedChild.id);
      if (this.isWatching) {
        this.taskCache.set(updatedChild.id, updatedChild);
      }
      rewrittenChildren.push(updatedChild);
    }

    return rewrittenChildren;
  }

  /**
   * Clear `agent.taskId` links that point at a task which has transitioned out
   * of active work. This keeps heartbeat scheduling aligned with live task
   * storage and prevents stale task-scoped heartbeat runs.
   */
  private clearLinkedAgentTaskIds(taskId: string, updatedAt: string = new Date().toISOString()): void {
    const linkedAgents = this.db
      .prepare("SELECT id FROM agents WHERE taskId = ?")
      .all(taskId) as Array<{ id: string }>;

    if (linkedAgents.length === 0) {
      return;
    }

    this.db.prepare(`
      UPDATE agents
      SET
        taskId = NULL,
        updatedAt = ?,
        data = CASE
          WHEN json_valid(data) THEN json_set(json_remove(data, '$.taskId'), '$.updatedAt', ?)
          ELSE data
        END
      WHERE taskId = ?
    `).run(updatedAt, updatedAt, taskId);
  }

  /**
   * Sync `agents.taskId` when {@link updateTask} reassigns a task.
   *
   * Uses direct SQL against the shared `agents` table instead of AgentStore to
   * avoid a circular dependency while keeping the column and JSON data blob in
   * lockstep. Clearing the previous agent is race-guarded with `WHERE id = ?
   * AND taskId = ?` so we do not clobber an agent that already moved on to a
   * different task.
   */
  private syncAgentTaskLinkOnReassignment(
    taskId: string,
    previousAgentId: string | undefined,
    newAgentId: string | undefined,
  ): void {
    const updatedAt = new Date().toISOString();

    if (previousAgentId) {
      this.db.prepare(`
        UPDATE agents
        SET
          taskId = NULL,
          updatedAt = ?,
          data = CASE
            WHEN json_valid(data) THEN json_set(json_remove(data, '$.taskId'), '$.updatedAt', ?)
            ELSE data
          END
        WHERE id = ? AND taskId = ?
      `).run(updatedAt, updatedAt, previousAgentId, taskId);
    }

    if (newAgentId) {
      this.db.prepare(`
        UPDATE agents
        SET
          taskId = ?,
          updatedAt = ?,
          data = CASE
            WHEN json_valid(data) THEN json_set(data, '$.taskId', ?, '$.updatedAt', ?)
            ELSE data
          END
        WHERE id = ?
      `).run(taskId, updatedAt, taskId, updatedAt, newAgentId);
    }
  }

  /**
   * Clean up the git branch associated with a task.
   *
   * Branch name resolution:
   * 1. Use `task.branch` if set
   * 2. Fall back to `fusion/${taskId.toLowerCase()}`
   *
   * Uses force delete (`git branch -D`) since the task is being removed or archived.
   * Silently skips if neither branch exists (idempotent).
   *
   * @returns Array of branch names that were successfully deleted
   */
  private async runGitCommand(command: string, timeoutMs = 10_000) {
    return runCommandAsync(command, {
      cwd: this.rootDir,
      timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  private async cleanupBranchForTask(task: Task): Promise<string[]> {
    const branches = new Set<string>();
    if (task.branch) {
      branches.add(task.branch);
    }
    branches.add(`fusion/${task.id.toLowerCase()}`);

    const deleted: string[] = [];
    for (const branch of branches) {
      try {
        assertSafeGitBranchName(branch);
      } catch {
        // Skip branches whose names would be unsafe to pass through a shell.
        // A malformed stored value should not become a command-injection vector.
        continue;
      }
      const verify = await this.runGitCommand(`git rev-parse --verify "${branch}"`);
      if (verify.exitCode !== 0) {
        continue;
      }

      const remove = await this.runGitCommand(`git branch -D "${branch}"`);
      if (remove.exitCode === 0) {
        deleted.push(branch);
      }
    }
    if (deleted.length > 0) {
      this.clearStaleExecutionStartBranchReferences(deleted, task.id);
    }
    return deleted;
  }

  /**
   * Clear `baseBranch` on any live task whose stored value matches one of the
   * provided (now-deleted) branch names. Prevents the scenario where a
   * dependent task was dispatched with baseBranch set to an upstream dep's
   * conflict-suffixed branch, the upstream dep was later merged and its
   * branch deleted, and the dependent task then failed permanently trying
   * to create a worktree from the vanished ref (FN-2165).
   *
   * Excludes the owner task (when provided) so a task's own archival doesn't
   * null its own baseBranch.
   *
   * @returns IDs of tasks whose baseBranch was cleared
   */
  clearStaleExecutionStartBranchReferences(deletedBranches: string[], ownerTaskId?: string): string[] {
    if (deletedBranches.length === 0) return [];
    const placeholders = deletedBranches.map(() => "?").join(",");
    const params: string[] = [...deletedBranches];
    let whereClause = `executionStartBranch IN (${placeholders})`;
    if (ownerTaskId) {
      whereClause += ` AND id != ?`;
      params.push(ownerTaskId);
    }
    const rows = this.db
      .prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE} AND ${whereClause}`)
      .all(...params) as Array<{ id: string }>;

    if (rows.length === 0) return [];
    const update = this.db.prepare(
      `UPDATE tasks SET executionStartBranch = NULL, updatedAt = ? WHERE id = ?`,
    );
    const now = new Date().toISOString();
    const clearedIds: string[] = [];
    for (const row of rows) {
      update.run(now, row.id);
      clearedIds.push(row.id);
      if (this.isWatching) {
        const cached = this.taskCache.get(row.id);
        if (cached) {
          cached.executionStartBranch = undefined;
          cached.updatedAt = now;
        }
      }
    }
    this.db.bumpLastModified();
    return clearedIds;
  }

  private async collectMergeDetails(
    _id: string,
    _branch: string,
    task: Task,
    commitMessage: string,
    mergeTarget?: {
      branch: string;
      source: "task-base-branch" | "task-branch-context" | "branch-group-integration" | "project-default" | "legacy-main";
    },
  ): Promise<import("./types.js").MergeDetails> {
    const mergedAt = new Date().toISOString();
    let commitSha: string | undefined;
    let filesChanged: number | undefined;
    let insertions: number | undefined;
    let deletions: number | undefined;
    let landedFiles: string[] | undefined;

    const headResult = await this.runGitCommand("git rev-parse HEAD");
    if (headResult.exitCode === 0) {
      commitSha = headResult.stdout.trim() || undefined;
    } else {
      commitSha = undefined;
    }

    const statsResult = await this.runGitCommand("git show --shortstat --format= HEAD");
    if (statsResult.exitCode === 0) {
      const statsOutput = statsResult.stdout.trim();
      const normalized = statsOutput.replace(/\n/g, " ");
      const filesMatch = normalized.match(/(\d+) files? changed/);
      const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
      const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
      filesChanged = filesMatch ? Number.parseInt(filesMatch[1], 10) : 0;
      insertions = insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0;
      deletions = deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0;
    } else {
      filesChanged = undefined;
      insertions = undefined;
      deletions = undefined;
    }

    if (commitSha) {
      const landedFilesResult = await this.runGitCommand(`git show --name-only --format= "${commitSha}"`);
      if (landedFilesResult.exitCode === 0) {
        const parsedLandedFiles = landedFilesResult.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (parsedLandedFiles.length > 0) {
          landedFiles = Array.from(new Set(parsedLandedFiles));
        }
      }
    }

    return {
      commitSha,
      landedFiles,
      filesChanged,
      insertions,
      deletions,
      mergeCommitMessage: commitMessage,
      mergedAt,
      mergeConfirmed: true,
      prNumber: task.prInfo?.number,
      mergeTargetBranch: mergeTarget?.branch,
      mergeTargetSource: mergeTarget?.source,
      resolutionStrategy: task.mergeDetails?.resolutionStrategy,
      resolutionMethod: task.mergeDetails?.resolutionMethod,
      attemptsMade: task.mergeDetails?.attemptsMade,
      autoResolvedCount: task.mergeDetails?.autoResolvedCount,
    };
  }

  /**
   * Merge an in-review task's branch into the current branch,
   * clean up the worktree, and move the task to done.
   */
  async mergeTask(id: string): Promise<MergeResult> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      // FNXC:Workspace 2026-06-21-19:05:
      // R7 merge-boundary guard (master-plan U0). Reject workspace-mode tasks
      // BEFORE any git checkout/squash — they need the per-repo merge loop that
      // lands in master-plan U6, which removes this guard. See the predicate's
      // FNXC:Workspace note in @fusion/core types.
      assertNotWorkspaceTaskMerge(task);
      const branch = task.branch || `fusion/${id.toLowerCase()}`;
      // Branch is derived from the task id (already validated at create time),
      // but assert as defense-in-depth against future id-format changes.
      assertSafeGitBranchName(branch);

      if (task.column === "done") {
        const result: MergeResult = {
          task,
          branch,
          merged: false,
          worktreeRemoved: false,
          branchDeleted: false,
        };

        const worktreePath = task.worktree;
        const changed = this.clearDoneTransientFields(task);

        if (worktreePath && existsSync(worktreePath)) {
          assertSafeAbsolutePath(worktreePath);
          const removeWorktree = await this.runGitCommand(`git worktree remove "${worktreePath}" --force`, 120_000);
          if (removeWorktree.exitCode === 0) {
            result.worktreeRemoved = true;
          }
        }

        const deleteBranch = await this.runGitCommand(`git branch -d "${branch}"`);
        if (deleteBranch.exitCode === 0) {
          result.branchDeleted = true;
        } else {
          const forceDeleteBranch = await this.runGitCommand(`git branch -D "${branch}"`);
          if (forceDeleteBranch.exitCode === 0) {
            result.branchDeleted = true;
          }
        }

        if (changed) {
          task.updatedAt = new Date().toISOString();
          await this.atomicWriteTaskJson(dir, task);
          if (this.isWatching) this.taskCache.set(id, { ...task });
          this.emit("task:updated", task);
        }

        result.task = task;
        return result;
      }

      const mergeBlocker = getTaskMergeBlocker(task);
      if (mergeBlocker) {
        throw new Error(`Cannot merge ${id}: ${mergeBlocker}`);
      }

      const worktreePath = task.worktree;
      const result: MergeResult = {
        task,
        branch,
        merged: false,
        worktreeRemoved: false,
        branchDeleted: false,
      };

      const settings = await this.getSettings();
      const normalizedIntegrationBranch =
        typeof settings.integrationBranch === "string" ? settings.integrationBranch.trim() : "";
      const normalizedBaseBranch = typeof settings.baseBranch === "string" ? settings.baseBranch.trim() : "";
      let projectDefaultBranch =
        normalizedIntegrationBranch.length > 0
          ? normalizedIntegrationBranch
          : normalizedBaseBranch.length > 0
            ? normalizedBaseBranch
            : "";
      if (!projectDefaultBranch) {
        const originHead = await this.runGitCommand("git symbolic-ref --short refs/remotes/origin/HEAD", 5_000);
        if (originHead.exitCode === 0) {
          projectDefaultBranch = originHead.stdout
            .trim()
            .replace(/^refs\/heads\//, "")
            .replace(/^refs\/remotes\/origin\//, "")
            .replace(/^origin\//, "");
        }
      }
      const mergeTarget = resolveTaskMergeTarget(task, {
        projectDefaultBranch: projectDefaultBranch || undefined,
      });

      // 1. Check the branch exists
      const verifyBranch = await this.runGitCommand(`git rev-parse --verify "${branch}"`);
      if (verifyBranch.exitCode !== 0) {
        // No branch — might have been manually merged. Just move to done.
        result.error = `Branch '${branch}' not found — moving to done without merge`;
        task.mergeDetails = {
          mergedAt: new Date().toISOString(),
          mergeConfirmed: false,
          prNumber: task.prInfo?.number,
          mergeTargetBranch: mergeTarget.branch,
          mergeTargetSource: mergeTarget.source,
        };
        await this.moveToDone(task, dir);
        result.task = { ...task, column: "done" };
        this.emit("task:merged", result);
        return result;
      }

      const checkoutTarget = await this.runGitCommand(`git checkout "${mergeTarget.branch}"`, 120_000);
      if (checkoutTarget.exitCode !== 0) {
        throw new Error(`Unable to checkout merge target branch '${mergeTarget.branch}' for ${id}`);
      }

      // 2. Merge the branch
      const mergeCommitMessage = `feat(${id}): merge ${branch}`;
      const merge = await this.runGitCommand(`git merge --squash "${branch}"`, 120_000);
      const commit = merge.exitCode === 0
        ? await this.runGitCommand(`git commit --no-edit -m "${mergeCommitMessage}"`, 120_000)
        : merge;

      if (merge.exitCode === 0 && commit.exitCode === 0) {
        result.merged = true;
        const mergeDetails = await this.collectMergeDetails(id, branch, task, mergeCommitMessage, mergeTarget);
        task.mergeDetails = mergeDetails;
        if (mergeDetails.landedFiles && mergeDetails.landedFiles.length > 0) {
          task.modifiedFiles = mergeDetails.landedFiles;
        }
        Object.assign(result, mergeDetails);
      } else {
        // Squash conflict — reset and report
        await this.runGitCommand("git reset --merge");
        throw new Error(
          `Merge conflict merging '${branch}'. Resolve manually:\n` +
            `  cd ${this.rootDir}\n` +
            `  git merge --squash ${branch}\n` +
            `  # resolve conflicts, then: fn task move ${id} done`,
        );
      }

      // 3. Remove worktree
      if (worktreePath && existsSync(worktreePath)) {
        assertSafeAbsolutePath(worktreePath);
        const removeWorktree = await this.runGitCommand(`git worktree remove "${worktreePath}" --force`, 120_000);
        if (removeWorktree.exitCode === 0) {
          result.worktreeRemoved = true;
        }
      }

      // 4. Delete the branch
      const deleteBranch = await this.runGitCommand(`git branch -d "${branch}"`);
      if (deleteBranch.exitCode === 0) {
        result.branchDeleted = true;
      } else {
        // Branch might not be fully merged in some edge cases; try force
        const forceDeleteBranch = await this.runGitCommand(`git branch -D "${branch}"`);
        if (forceDeleteBranch.exitCode === 0) {
          result.branchDeleted = true;
        }
      }

      // 5. Move task to done
      await this.moveToDone(task, dir);
      result.task = { ...task, column: "done" };

      this.emit("task:merged", result);
      return result;
    });
  }

  /**
   * Archive all tasks currently in the "done" column.
   * Returns an array of archived tasks.
   */
  async archiveAllDone(options?: { removeLineageReferences?: boolean }): Promise<Task[]> {
    const doneTasks = await this.listTasks({ slim: true, column: "done" });

    if (doneTasks.length === 0) {
      return [];
    }

    // Archive all done tasks concurrently
    const archivedTasks = await Promise.all(
      doneTasks.map((task) =>
        this.archiveTask(task.id, {
          cleanup: true,
          removeLineageReferences: options?.removeLineageReferences,
        })
      )
    );

    return archivedTasks;
  }

  /**
   * Archive a live task (move from any non-archived column → archived).
   * Logs the action and emits `task:moved` event.
   * @param optionsOrCleanup - Boolean cleanup flag for backward compatibility,
   * or an options object that also allows removeLineageReferences.
   */
  async archiveTask(
    id: string,
    optionsOrCleanup: boolean | { cleanup?: boolean; removeLineageReferences?: boolean } = true,
  ): Promise<Task> {
    const archivedTask = await this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (task.column === "archived") {
        throw new Error(
          `Cannot archive ${id}: task is already archived`,
        );
      }

      const fromColumn = task.column as Column;
      task.preArchiveColumn = fromColumn;

      const cleanup = typeof optionsOrCleanup === "boolean" ? optionsOrCleanup : optionsOrCleanup.cleanup !== false;
      const removeLineageReferences = typeof optionsOrCleanup === "object" && optionsOrCleanup.removeLineageReferences === true;
      const lineageChildIds = this.findLiveLineageChildren(id);
      if (lineageChildIds.length > 0 && !removeLineageReferences) {
        throw new TaskHasLineageChildrenError(id, lineageChildIds);
      }

      task.column = "archived";
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;
      task.log.push({
        timestamp: task.columnMovedAt,
        action: "Task archived",
      });

      let rewrittenLineageChildren: Task[] = [];

      if (!cleanup) {
        this.db.transaction(() => {
          rewrittenLineageChildren = this.rewriteLineageChildrenForRemoval(id, lineageChildIds);
          this.clearLinkedAgentTaskIds(id, task.updatedAt);
          if (rewrittenLineageChildren.length > 0) {
            this.db.bumpLastModified();
          }
        });

        await this.atomicWriteTaskJson(dir, task);
        await this.writeTaskJsonFile(dir, task);
        if (this.isWatching) this.taskCache.set(id, { ...task });
        for (const lineageChild of rewrittenLineageChildren) {
          this.emit("task:updated", lineageChild);
        }
        this.emit("task:moved", { task, from: fromColumn, to: "archived" as Column, source: "engine" });
        return task;
      }

      const cleanedBranches = await this.cleanupBranchForTask(task);
      if (cleanedBranches.length > 0) {
        task.log.push({
          timestamp: new Date().toISOString(),
          action: `Cleaned up branch: ${cleanedBranches.join(", ")}`,
        });
      }

      const entry = await this.taskToArchiveEntry(task, task.columnMovedAt);
      this.archiveDb.upsert(entry);

      this.db.transaction(() => {
        rewrittenLineageChildren = this.rewriteLineageChildrenForRemoval(id, lineageChildIds);
        this.clearLinkedAgentTaskIds(id, task.updatedAt);
        this.purgeTaskWorkflowSelectionRows(id);
        this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        this.db.bumpLastModified();
      });

      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });

      if (this.isWatching) {
        this.taskCache.delete(id);
      }

      for (const lineageChild of rewrittenLineageChildren) {
        this.emit("task:updated", lineageChild);
      }
      this.emit("task:moved", { task, from: fromColumn, to: "archived" as Column, source: "engine" });
      return this.archiveEntryToTask(entry, false);
    });

    await this.clearNearDuplicateReferencesToFailSoft(id, {
      column: "archived",
      reason: "archived",
    });
    return archivedTask;
  }

  /**
   * Archive a task and immediately clean up its directory.
   * Convenience method equivalent to `archiveTask(id, true)`.
   */
  async archiveTaskAndCleanup(id: string): Promise<Task> {
    return this.archiveTask(id, true);
  }

  private resolveUnarchiveTargetColumn(preArchiveColumn: unknown): Column {
    if (!isColumn(preArchiveColumn) || preArchiveColumn === "archived") {
      return "done";
    }
    if (preArchiveColumn === "in-progress" || preArchiveColumn === "in-review") {
      return "todo";
    }
    return preArchiveColumn;
  }

  private async readPreArchiveColumnFromTaskFile(dir: string): Promise<Column | undefined> {
    try {
      const raw = await readFile(join(dir, "task.json"), "utf-8");
      const parsed = JSON.parse(raw) as { preArchiveColumn?: unknown };
      return isColumn(parsed.preArchiveColumn) ? parsed.preArchiveColumn : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Unarchive an archived task (move from archived → its recorded source column).
   * If the active task row was cleaned up, restores from archive.db first.
   * Logs the action and emits `task:moved` event.
   */
  async unarchiveTask(id: string): Promise<Task> {
    const dir = this.taskDir(id);

    // If the active row is gone, restore from cold archive storage before
    // taking the task lock. A stale directory may still exist after manual
    // filesystem edits, so database presence is the source of truth.
    if (!this.readTaskFromDb(id)) {
      const entry = await this.findInArchive(id);
      if (!entry) {
        throw new Error(
          `Cannot unarchive ${id}: task is missing from active storage and not found in archive`,
        );
      }
      await this.restoreFromArchive(entry);
    }

    return this.withTaskLock(id, async () => {
      // Re-read task.json (either existing or freshly restored)
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (task.column !== "archived") {
        throw new Error(
          `Cannot unarchive ${id}: task is in '${task.column}', must be in 'archived'`,
        );
      }

      // NOTE: No getTaskMergeBlocker check here — intentionally.
      // The merge blocker validates in-review → done transitions (ensuring code
      // has been properly reviewed before merging). An unarchived task was already
      // archived in its previous lifecycle; this is just a restoration. The transient
      // field clearing below ensures no stale blocker state leaks through.
      const preArchiveColumn = task.preArchiveColumn ?? await this.readPreArchiveColumnFromTaskFile(dir);
      const toColumn = this.resolveUnarchiveTargetColumn(preArchiveColumn);
      task.column = toColumn;
      task.preArchiveColumn = undefined;
      task.columnMovedAt = new Date().toISOString();
      task.updatedAt = task.columnMovedAt;

      // Clear transient fields regardless of the restored column. Archived tasks
      // may have been archived with stale execution state that should not reappear
      // after unarchiving, especially when active columns are downgraded to todo.
      this.clearDoneTransientFields(task);

      task.log.push({
        timestamp: task.columnMovedAt,
        action: "Task unarchived",
      });

      await this.atomicWriteTaskJson(dir, task);
      this.archiveDb.delete(id);

      // Update cache if watcher is active
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:moved", { task, from: "archived" as Column, to: toColumn, source: "engine" });
      return task;
    });
  }

  private async moveToDone(task: Task, dir: string): Promise<void> {
    if (task.column === "done") {
      return;
    }

    const fromColumn = task.column;
    const mergeBlocker = getTaskMergeBlocker(task);
    if (mergeBlocker) {
      throw new Error(`Cannot move ${task.id} to done: ${mergeBlocker}`);
    }

    task.column = "done";
    this.clearDoneTransientFields(task);
    task.columnMovedAt = new Date().toISOString();
    task.updatedAt = task.columnMovedAt;
    if (!task.executionCompletedAt) {
      task.executionCompletedAt = task.columnMovedAt;
    }

    await this.atomicWriteTaskJson(dir, task);

    // Update cache if watcher is active
    if (this.isWatching) this.taskCache.set(task.id, { ...task });

    this.emit("task:moved", { task, from: fromColumn, to: "done" as Column, source: "engine" });
  }

  private clearDoneTransientFields(task: Task): boolean {
    const changed = task.status !== undefined
      || task.error !== undefined
      || task.worktree !== undefined
      || task.blockedBy !== undefined
      || task.overlapBlockedBy !== undefined
      || task.recoveryRetryCount !== undefined
      || task.nextRecoveryAt !== undefined
      || task.paused !== undefined
      || task.userPaused !== undefined
      || task.pausedByAgentId !== undefined
      || task.pausedReason !== undefined;

    task.status = undefined;
    task.error = undefined;
    task.worktree = undefined;
    task.blockedBy = undefined;
    task.overlapBlockedBy = undefined;
    task.recoveryRetryCount = undefined;
    task.nextRecoveryAt = undefined;
    task.paused = undefined;
    task.userPaused = undefined;
    task.pausedByAgentId = undefined;
    task.pausedReason = undefined;

    return changed;
  }

  // ── File-system watcher ───────────────────────────────────────────

  /**
   * Start watching for changes via SQLite polling.
   * Populates the in-memory cache and begins emitting events for
   * any task mutations.
   */
  async watch(): Promise<void> {
    if (this.watcher || this.pollInterval) return; // already watching
    this.clearStartupSlimListMemo();

    // Populate cache with current state. The watcher only needs metadata to
    // detect created/updated/moved/deleted events; full task logs stay on the
    // detail path.
    const tasks = await this.listTasks({ slim: true, startupMemo: false });
    this.taskCache.clear();
    for (const task of tasks) {
      this.taskCache.set(task.id, { ...task });
    }

    try {
      await this.markLegacyAutoMergeStampsOnce();
    } catch (err) {
      storeLog.warn("Legacy auto-merge stamp marker failed during watch startup (non-fatal)", {
        phase: "watch:legacy-auto-merge-stamp-marker",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!this.donePauseBackfillDone) {
      const repairedTaskIds: string[] = [];
      for (const [taskId, cachedTask] of this.taskCache.entries()) {
        if (cachedTask.column !== "done") continue;

        const taskDir = this.taskDir(taskId);
        let raw: string;
        try {
          raw = await readFile(join(taskDir, "task.json"), "utf-8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            /*
             * FNXC:StartupRecovery 2026-06-23-05:02:
             * A recovered or corrupt SQLite index can retain done-task rows whose legacy task.json mirror was already removed. Startup watch must not crash while running the one-time done-pause backfill; skip the missing mirror and keep the dashboard available so operators can inspect or repair the project.
             */
            storeLog.warn("Skipping done-task pause metadata backfill for missing task.json", {
              phase: "watch:done-pause-backfill",
              taskId,
              taskJsonPath: join(taskDir, "task.json"),
            });
            continue;
          }
          throw error;
        }
        const diskTask = JSON.parse(raw) as Task;
        if (!this.clearDoneTransientFields(diskTask)) continue;

        await this.atomicWriteTaskJson(taskDir, diskTask);
        this.taskCache.set(taskId, { ...diskTask });
        repairedTaskIds.push(taskId);
      }
      this.donePauseBackfillDone = true;

      storeLog.log("done-task pause metadata backfill completed", {
        phase: "watch:done-pause-backfill",
        repairedCount: repairedTaskIds.length,
        repairedTaskIds: repairedTaskIds.slice(0, 20),
      });
    }

    // Store current lastModified
    this.lastKnownModified = this.db.getLastModified();
    // Initialize lastPollTime so the first checkForChanges() cycle filters by
    // "modified since now" instead of doing a full SELECT * + emitting an
    // update event for every cached task. Without this, dashboard startup
    // re-loaded the entire tasks table 1s after watch() began.
    this.lastPollTime = new Date().toISOString();

    // Use a sentinel watcher object so existing code that checks `this.watcher` still works
    try {
      this.watcher = watch(this.tasksDir, { recursive: true }, (_event, _filename) => {
        // No-op - we use polling now, but keep watcher for API compat
      });
      this.watcher.on("error", (err) => {
        storeLog.warn("fs.watch emitted an error; polling will continue", {
          phase: "watch:fs-watch-error",
          error: err instanceof Error ? err.message : String(err),
          tasksDir: this.tasksDir,
        });
      });
    } catch (err) {
      // fs.watch may not be available - that's fine
      storeLog.warn("fs.watch unavailable; falling back to polling-only updates", {
        phase: "watch:fs-watch-setup",
        error: err instanceof Error ? err.message : String(err),
        tasksDir: this.tasksDir,
      });
    }

    // Poll for changes every second
    this.pollInterval = setInterval(() => {
      void this.checkForChanges();
    }, 1000);
    this.clearStartupSlimListMemo();
  }

  /**
   * Check for changes by comparing lastModified timestamps.
   * Optimized: only loads tasks modified since the last poll instead of
   * doing a full table scan + JSON.stringify comparison every cycle.
   *
   * This method yields to the event loop between expensive SQLite operations
   * to prevent blocking HTTP request handlers. Uses a pollingInProgress guard
   * to skip overlapping poll cycles.
   */
  private async checkForChanges(): Promise<void> {
    const startTime = Date.now();

    // Guard against overlapping poll cycles
    if (this.pollingInProgress) return;
    this.pollingInProgress = true;

    try {
      const currentModified = this.db.getLastModified();
      if (currentModified <= this.lastKnownModified) return;
      this.lastKnownModified = currentModified;

      // Detect deletions cheaply: compare ID sets without loading full rows.
      // A row missing from `tasks` can mean two things: the task was actually
      // deleted, OR it was archived (archiveTask removes it from `tasks` after
      // copying into `archived_tasks`). Other TaskStore instances polling the
      // same DB can't tell the difference from this view alone — without the
      // archive check below they emit spurious task:deleted events for every
      // archived task, which the activity log records as a deletion.
      // FN-5105: intentionally include soft-deleted rows here so a deletedAt
      // transition can be observed and emit task:deleted exactly once.
      const idRows = this.db.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>;
      const currentIds = new Set(idRows.map((r) => r.id));
      const missingIds: string[] = [];
      for (const id of this.taskCache.keys()) {
        if (!currentIds.has(id)) missingIds.push(id);
      }
      if (missingIds.length > 0) {
        const archivedSet = this.archiveDb.filterArchived(missingIds);
        for (const id of missingIds) {
          const cached = this.taskCache.get(id);
          if (!cached) continue;
          this.taskCache.delete(id);
          this.suppressActivityLogForPollingEmit = true;
          try {
            if (archivedSet.has(id)) {
              // Task moved to archive — emit task:moved (matching what
              // archiveTask emits in-process) so other subscribers can react.
              // Skip already-archived cache entries to avoid no-op emits.
              // Activity-log listeners skip polling emits; the originating
              // TaskStore instance wrote the row in-process.
              if (cached.column !== "archived") {
                this.emit("task:moved", { task: cached, from: cached.column, to: "archived" as Column, source: "engine" });
              }
            } else {
              // Polling replicas only mirror the originating delete signal.
              // Do not record run-audit here; the writer already owns that row.
              this.emit("task:deleted", cached);
            }
          } finally {
            this.suppressActivityLogForPollingEmit = false;
          }
        }
      }

      // Yield to event loop before the expensive SELECT query
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Only load tasks modified since our last known timestamp.
      // Use lastKnownPollTime (ISO string) to filter — much cheaper than full scan.
      const selectClause = this.getTaskSelectClause(true);
      const changedRows = this.lastPollTime
        ? this.db.prepare(`SELECT ${selectClause} FROM tasks WHERE updatedAt > ? OR columnMovedAt > ?`).all(this.lastPollTime, this.lastPollTime) as unknown as TaskRow[]
        : this.db.prepare(`SELECT ${selectClause} FROM tasks`).all() as unknown as TaskRow[];
      this.lastPollTime = new Date().toISOString();

      for (let i = 0; i < changedRows.length; i++) {
        const row = changedRows[i];
        const task = this.rowToTask(row);
        const cached = this.taskCache.get(task.id);

        this.suppressActivityLogForPollingEmit = true;
        try {
          if (task.deletedAt) {
            if (cached) {
              this.taskCache.delete(task.id);
              // Polling replicas only re-emit task:deleted for subscribers.
              // They must not insert duplicate run-audit rows cross-instance.
              this.emit("task:deleted", cached);
            }
            continue;
          }

          if (!cached) {
            this.taskCache.set(task.id, { ...task });
            this.emit("task:created", task);
          } else if (cached.column !== task.column) {
            const from = cached.column;
            this.taskCache.set(task.id, { ...task });
            this.emit("task:moved", { task, from, to: task.column, source: "engine" });
          } else {
            this.taskCache.set(task.id, { ...task });
            this.emit("task:updated", task);
          }
        } finally {
          this.suppressActivityLogForPollingEmit = false;
        }

        // Yield every ~50 rows to prevent blocking the event loop during large updates
        if (i > 0 && i % 50 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      const elapsed = Date.now() - startTime;
      if (elapsed > 750) {
        storeLog.warn("checkForChanges took longer than expected", {
          elapsedMs: elapsed,
          thresholdMs: 750,
        });
      }
    } catch (err) {
      storeLog.warn("checkForChanges poll cycle failed", {
        lastKnownModified: this.lastKnownModified,
        lastPollTime: this.lastPollTime,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.pollingInProgress = false;
    }
  }

  /**
   * Stop watching and clean up.
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.taskCache.clear();
    this.recentlyWritten.clear();
    this.clearStartupSlimListMemo();
  }

  /**
   * Mark a file path as recently written by an in-process mutation
   * so the watcher will skip it.
   */
  private suppressWatcher(filePath: string): void {
    this.recentlyWritten.add(filePath);
    setTimeout(() => {
      this.recentlyWritten.delete(filePath);
    }, this.debounceMs + 100);
  }

  private static ALLOWED_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "text/plain",
    "text/markdown",
    "application/json",
    "text/yaml",
    "text/x-toml",
    "text/csv",
    "application/xml",
  ]);

  private static MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB

  async addAttachment(
    id: string,
    filename: string,
    content: Buffer,
    mimeType: string,
  ): Promise<TaskAttachment> {
    if (!TaskStore.ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(
        `Invalid mime type '${mimeType}'. Allowed: ${[...TaskStore.ALLOWED_MIME_TYPES].join(", ")}`,
      );
    }
    if (content.length > TaskStore.MAX_ATTACHMENT_SIZE) {
      throw new Error(
        `File too large (${content.length} bytes). Maximum: ${TaskStore.MAX_ATTACHMENT_SIZE} bytes (5MB)`,
      );
    }

    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const attachDir = join(dir, "attachments");
      await mkdir(attachDir, { recursive: true });

      // Sanitize filename: keep alphanumeric, dots, hyphens, underscores
      const sanitized = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const storedName = `${Date.now()}-${sanitized}`;
      await writeFile(join(attachDir, storedName), content);

      const attachment: TaskAttachment = {
        filename: storedName,
        originalName: filename,
        mimeType,
        size: content.length,
        createdAt: new Date().toISOString(),
      };

      const task = await this.readTaskJson(dir);
      if (!task.attachments) task.attachments = [];
      task.attachments.push(attachment);
      task.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(dir, task);

      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);

      return attachment;
    });
  }

  async getAttachment(
    id: string,
    filename: string,
  ): Promise<{ path: string; mimeType: string }> {
    const dir = this.taskDir(id);
    const task = await this.readTaskJson(dir);
    const attachment = task.attachments?.find((a) => a.filename === filename);
    if (!attachment) {
      const err: NodeJS.ErrnoException = new Error(
        `Attachment '${filename}' not found on task ${id}`,
      );
      err.code = "ENOENT";
      throw err;
    }
    return {
      path: join(dir, "attachments", filename),
      mimeType: attachment.mimeType,
    };
  }

  async deleteAttachment(id: string, filename: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const idx = task.attachments?.findIndex((a) => a.filename === filename) ?? -1;
      if (idx === -1) {
        const err: NodeJS.ErrnoException = new Error(
          `Attachment '${filename}' not found on task ${id}`,
        );
        err.code = "ENOENT";
        throw err;
      }

      // Remove file from disk
      const filePath = join(dir, "attachments", filename);
      try {
        await unlink(filePath);
      } catch {
        // File may already be gone
      }

      task.attachments!.splice(idx, 1);
      if (task.attachments!.length === 0) {
        task.attachments = undefined;
      }
      task.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(dir, task);

      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);

      return task;
    });
  }

  /**
   * Buffer an agent log entry for file-backed persistence.
   * Also emits an `agent:log` event for live streaming.
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @param text - The text content (delta for "text"/"thinking", tool name for "tool"/"tool_result"/"tool_error")
   * @param type - The entry type discriminator
   * @param detail - Optional human-readable summary (tool args, result summary, or error message)
   * @param agent - Optional agent role that produced this entry
   */
  async appendAgentLog(
    taskId: string,
    text: string,
    type: AgentLogEntry["type"],
    detail?: string,
    agent?: AgentLogEntry["agent"],
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const normalizedDetail = truncateAgentLogDetail(detail, type);
    const entry: AgentLogEntry = {
      timestamp,
      taskId,
      text,
      type,
      ...(normalizedDetail !== undefined && { detail: normalizedDetail }),
      ...(agent !== undefined && { agent }),
    };

    // Buffer the entry for batched insertion to reduce WAL pressure.
    // Drop oldest entries if backlog exceeds hard cap (prolonged outage).
    if (this.agentLogBuffer.length >= TaskStore.MAX_AGENT_LOG_BACKLOG) {
      const dropCount = this.agentLogBuffer.length - TaskStore.MAX_AGENT_LOG_BACKLOG + 1;
      this.agentLogBuffer.splice(0, dropCount);
      console.warn(
        `[fusion] Dropped ${dropCount} buffered agent log entries — backlog cap reached (${this.db.path})`,
      );
    }
    this.agentLogBuffer.push({
      taskId,
      timestamp,
      text,
      type,
      detail: normalizedDetail ?? null,
      agent: agent ?? null,
    });
    this.emit("agent:log", entry);

    if (this.agentLogBuffer.length >= TaskStore.AGENT_LOG_BUFFER_SIZE) {
      try {
        this.flushAgentLogBuffer();
      } catch (err) {
        // Size-triggered flush failed — log but don't crash the caller.
        console.error(`[fusion] Size-triggered agent log flush failed (${this.db.path}):`, err);
      }
    } else if (!this.agentLogFlushTimer) {
      this.agentLogFlushTimer = setTimeout(
        () => {
          try {
            this.flushAgentLogBuffer();
          } catch (err) {
            // Timer-triggered flush failed — log but don't crash the process.
            console.error(`[fusion] Timer-triggered agent log flush failed (${this.db.path}):`, err);
          }
        },
        TaskStore.AGENT_LOG_FLUSH_MS,
      );
      this.agentLogFlushTimer.unref();
    }
  }

  /**
   * Append a normalized telemetry row to `usage_events` (tool calls, messages,
   * session lifecycle) for the Command Center analytics layer. Callers in the
   * executor/session layer pass `model`/`provider`/`nodeId`/`category` from the
   * session context (see usage-events.ts / KTD3).
   *
   * **Fail-soft**: the underlying helper swallows malformed events and write
   * errors, so this never throws and never aborts the agent-log write or the
   * agent hot path.
   *
   * @returns `true` if a row was inserted, `false` if the event was skipped.
   */
  emitUsageEvent(event: UsageEventInput): boolean {
    return emitUsageEventToDb(this.db, event);
  }

  /**
   * Flush all buffered agent log entries to per-task JSONL files.
   * Called when the buffer is full or on a timer.
   */
  private flushAgentLogBuffer(): void {
    if (this.agentLogFlushTimer) {
      clearTimeout(this.agentLogFlushTimer);
      this.agentLogFlushTimer = null;
    }
    if (this.agentLogBuffer.length === 0) return;

    const batch = this.agentLogBuffer.slice();
    const flushCount = batch.length;

    let validEntries = batch;
    const flushedEntries = new Set<typeof batch[number]>();
    try {
      const liveTaskIds = new Set(
        (this.db.prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE}`).all() as Array<{ id: string }>).map((row) => row.id),
      );
      validEntries = batch.filter((entry) => liveTaskIds.has(entry.taskId));
      const dropped = batch.length - validEntries.length;
      if (dropped > 0) {
        console.warn(
          `[fusion] Dropped ${dropped} buffered agent log entries for deleted tasks (${this.db.path})`,
        );
      }

      if (validEntries.length > 0) {
        const citationInputs: GoalCitationInput[] = [];
        const entriesByTask = new Map<string, typeof validEntries>();
        for (const entry of validEntries) {
          const taskEntries = entriesByTask.get(entry.taskId);
          if (taskEntries) {
            taskEntries.push(entry);
          } else {
            entriesByTask.set(entry.taskId, [entry]);
          }
        }

        for (const [taskId, taskEntries] of entriesByTask) {
          const appended = appendAgentLogEntriesSync(this.taskDir(taskId), taskEntries);
          taskEntries.forEach((entry) => flushedEntries.add(entry));
          for (const entry of appended) {
            try {
              citationInputs.push(
                ...this.scanAndRecordCitations(
                  entry.text,
                  "agent_log",
                  entry.sourceRef,
                  entry.agent ?? "unknown",
                  entry.taskId,
                  entry.timestamp,
                ),
              );
            } catch (err) {
              console.warn("[fusion] Failed to scan goal citations from agent_log:", err);
            }
          }
        }

        if (citationInputs.length > 0) {
          try {
            this.recordGoalCitations(citationInputs);
          } catch (err) {
            console.warn("[fusion] Failed to record goal citations from agent_log batch:", err);
          }
        }
        this.db.bumpLastModified();
      }
    } finally {
      this.agentLogBuffer.splice(0, flushCount);
      const remainingValidEntries = validEntries.filter((entry) => !flushedEntries.has(entry));
      if (remainingValidEntries.length > 0) {
        this.agentLogBuffer.unshift(...remainingValidEntries);
        if (!this.agentLogFlushTimer) {
          this.agentLogFlushTimer = setTimeout(() => {
            try {
              this.flushAgentLogBuffer();
            } catch (err) {
              console.error(`[fusion] Retry agent log flush failed (${this.db.path}):`, err);
            }
          }, TaskStore.AGENT_LOG_FLUSH_MS);
          this.agentLogFlushTimer.unref();
        }
      }
    }
  }

  async appendAgentLogBatch(
    entries: Array<{
      taskId: string;
      text: string;
      type: AgentLogEntry["type"];
      detail?: string;
      agent?: AgentLogEntry["agent"];
    }>,
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    // Flush buffered single-entry appends so they land before batch entries,
    // preserving insertion order (same-timestamp entries are ordered by rowid).
    this.flushAgentLogBuffer();

    const timestamp = new Date().toISOString();
    const normalizedEntries = entries.map((entry) => ({
      ...entry,
      detail: truncateAgentLogDetail(entry.detail, entry.type),
    }));
    const liveTaskIds = new Set(
      (this.db.prepare(`SELECT id FROM tasks WHERE ${TaskStore.ACTIVE_TASKS_WHERE}`).all() as Array<{ id: string }>).map((row) => row.id),
    );
    const validEntries = normalizedEntries.filter((entry) => liveTaskIds.has(entry.taskId));
    const dropped = normalizedEntries.length - validEntries.length;
    if (dropped > 0) {
      console.warn(`[fusion] Dropped ${dropped} batch agent log entries for deleted tasks (${this.db.path})`);
    }

    const citationInputs: GoalCitationInput[] = [];
    const entriesByTask = new Map<string, typeof validEntries>();
    for (const entry of validEntries) {
      const taskEntries = entriesByTask.get(entry.taskId);
      if (taskEntries) {
        taskEntries.push(entry);
      } else {
        entriesByTask.set(entry.taskId, [entry]);
      }
    }

    for (const [taskId, taskEntries] of entriesByTask) {
      const appended = appendAgentLogEntriesSync(
        this.taskDir(taskId),
        taskEntries.map((entry) => ({
          timestamp,
          taskId: entry.taskId,
          text: entry.text,
          type: entry.type,
          detail: entry.detail ?? null,
          agent: entry.agent ?? null,
        })),
      );
      for (const entry of appended) {
        try {
          citationInputs.push(
            ...this.scanAndRecordCitations(
              entry.text,
              "agent_log",
              entry.sourceRef,
              entry.agent ?? "unknown",
              entry.taskId,
              entry.timestamp,
            ),
          );
        } catch (err) {
          console.warn("[fusion] Failed to scan goal citations from agent log batch:", err);
        }
      }
    }
    if (citationInputs.length > 0) {
      try {
        this.recordGoalCitations(citationInputs);
      } catch (err) {
        console.warn("[fusion] Failed to record goal citations from appendAgentLogBatch:", err);
      }
    }
    if (validEntries.length > 0) {
      this.db.bumpLastModified();
    }

    for (const entry of normalizedEntries) {
      this.emit("agent:log", {
        timestamp,
        taskId: entry.taskId,
        text: entry.text,
        type: entry.type,
        ...(entry.detail !== undefined && { detail: entry.detail }),
        ...(entry.agent !== undefined && { agent: entry.agent }),
      });
    }
  }

  async addTaskComment(id: string, text: string, author: string): Promise<Task> {
    // Delegate to unified addComment method
    return this.addComment(id, text, author);
  }

  /**
   * Add a steering comment to a task.
   * Steering comments are injected into the AI execution context.
   * They are stored in BOTH `comments` (for unified UI display) and
   * `steeringComments` (for executor real-time injection).
   * Unlike regular comments, steering comments never trigger auto-refinement.
   */
  async addSteeringComment(id: string, text: string, author: "user" | "agent" = "user", runContext?: RunMutationContext): Promise<Task> {
    // Write to unified comments (skip refinement — steering is for agent injection, not follow-up tasks)
    const task = await this.addComment(id, text, author, { skipRefinement: true }, runContext);

    // Also write to steeringComments so the executor's real-time injection listener can detect new entries
    const updated = await this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const currentTask = await this.readTaskJson(dir);

      const steeringComment: import("./types.js").SteeringComment = {
        id: task.comments![task.comments!.length - 1].id,
        text,
        createdAt: new Date().toISOString(),
        author,
      };

      if (!currentTask.steeringComments) {
        currentTask.steeringComments = [];
      }
      currentTask.steeringComments.push(steeringComment);
      currentTask.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, currentTask);
      if (this.isWatching) this.taskCache.set(id, { ...currentTask });

      this.emit("task:updated", currentTask);
      return currentTask;
    });

    return updated;
  }

  async updateTaskComment(id: string, commentId: string, text: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const comments = task.comments || [];
      const comment = comments.find((entry) => entry.id === commentId);

      if (!comment) {
        throw new Error(`Comment ${commentId} not found on task ${id}`);
      }

      comment.text = text;
      comment.updatedAt = new Date().toISOString();
      task.comments = comments;
      task.updatedAt = comment.updatedAt;
      task.log.push({
        timestamp: task.updatedAt,
        action: "Comment updated",
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  async deleteTaskComment(id: string, commentId: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const currentComments = task.comments || [];
      const nextComments = currentComments.filter((entry) => entry.id !== commentId);

      if (nextComments.length === currentComments.length) {
        throw new Error(`Comment ${commentId} not found on task ${id}`);
      }

      task.comments = nextComments.length > 0 ? nextComments : undefined;
      task.updatedAt = new Date().toISOString();
      task.log.push({
        timestamp: task.updatedAt,
        action: "Comment deleted",
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Add a comment to a task.
   * Comments are injected into the AI execution context.
   * When a comment is added to a task in the "done" column by a user,
   * automatically creates a refinement task with the comment text as feedback.
   * 
   * Note: Now uses the unified comments system (TaskComment).
   */
  async addComment(
    id: string,
    text: string,
    author: string = "user",
    options?: {
      skipRefinement?: boolean;
      source?: "user" | "agent" | "github-review" | "github-review-comment";
      externalId?: string;
      reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
    },
    runContext?: RunMutationContext,
  ): Promise<Task> {
    // Phase 1: Add comment under lock
    const task = await this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      // Initialize log array if missing (for legacy tasks)
      if (!task.log) {
        task.log = [];
      }

      if (!task.comments) {
        task.comments = [];
      }

      const externalSource = options?.source;
      const externalId = options?.externalId;
      if (externalSource && externalId) {
        const existing = task.comments.find((entry) => entry.source === externalSource && entry.externalId === externalId);
        if (existing) {
          return task;
        }
      }

      // Generate unique ID: timestamp + random suffix for collision resistance
      const commentId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      const comment: import("./types.js").TaskComment = {
        id: commentId,
        text,
        author,
        createdAt: now,
        updatedAt: now,
        source: options?.source,
        externalId: options?.externalId,
        reviewState: options?.reviewState,
      };

      task.comments.push(comment);
      task.updatedAt = now;
      const logEntry: TaskLogEntry = {
        timestamp: task.updatedAt,
        action: `Comment added by ${author}`,
      };
      if (runContext) {
        logEntry.runContext = runContext;
      }
      task.log.push(logEntry);

      // When runContext is provided, record audit event atomically with task mutation
      if (runContext) {
        await this.atomicWriteTaskJsonWithAudit(dir, task, {
          taskId: task.id,
          agentId: runContext.agentId,
          runId: runContext.runId,
          domain: "database",
          mutationType: "task:comment",
          target: task.id,
          metadata: { author, commentId, source: options?.source ?? null, externalId: options?.externalId ?? null },
        });
      } else {
        await this.atomicWriteTaskJson(dir, task);
      }
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });

    const commentContextBase: Record<string, unknown> = {
      taskId: id,
      author,
      commentLength: text.length,
      column: task.column,
      priorStatus: task.status ?? null,
    };
    if (runContext) {
      commentContextBase.runId = runContext.runId;
      commentContextBase.agentId = runContext.agentId;
      if (runContext.source) {
        commentContextBase.runSource = runContext.source;
      }
    }

    // Phase 2: Auto-refinement OUTSIDE the lock (to avoid lock contention)
    // Only create refinement for user comments on done tasks.
    // This remains best-effort: failures are logged for observability but never
    // fail the comment add operation itself.
    // Steering comments skip refinement — they are injected into the agent stream instead.
    if (task.column === "done" && author === "user" && !options?.skipRefinement) {
      try {
        await this.refineTask(id, text);
      } catch (err) {
        storeLog.warn("Best-effort post-comment auto-refinement failed", {
          ...commentContextBase,
          phase: "addComment:auto-refinement",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Phase 3: user comments on already-planned, non-executing work should
    // trigger triage re-specification. This includes awaiting-approval
    // invalidation and todo/triage tasks that have a real non-bootstrap spec.
    // This remains best-effort: failures are logged for observability but
    // never fail the comment add operation itself.
    // Note: The `task` returned above reflects the state BEFORE this
    // transition. Callers that need the post-transition status should
    // re-read the task (e.g., via getTask).
    if (author === "user" && (task.column === "todo" || task.column === "triage")) {
      let hasRealPrompt = false;
      try {
        const promptPath = join(this.taskDir(id), "PROMPT.md");
        if (existsSync(promptPath)) {
          const prompt = await readFile(promptPath, "utf-8");
          hasRealPrompt = !isBootstrapPromptStub(prompt, task.id, task.title, task.description);
        }
      } catch (err) {
        storeLog.warn("Best-effort post-comment re-triage prompt-read failed", {
          ...commentContextBase,
          phase: "addComment:retriage-prompt-read",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const shouldInvalidateAwaitingApproval =
        task.column === "triage" && task.status === "awaiting-approval";
      const shouldRetriagePlannedTask = hasRealPrompt
        && (
          task.column === "todo"
          || (task.column === "triage" && task.status !== "awaiting-approval")
        );

      if (shouldInvalidateAwaitingApproval || shouldRetriagePlannedTask) {
        const phase = shouldInvalidateAwaitingApproval
          ? "addComment:awaiting-approval-invalidation"
          : "addComment:planned-task-retriage";
        const action = shouldInvalidateAwaitingApproval
          ? "User comment invalidated spec approval — task needs re-specification"
          : "User comment requested re-specification of planned task";
        let transitioned = false;

        try {
          await this.updateTask(id, { status: "needs-replan" });
          transitioned = true;
        } catch (err) {
          storeLog.warn("Best-effort post-comment re-triage failed", {
            ...commentContextBase,
            phase,
            stage: "status-update",
            nextStatus: "needs-replan",
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (transitioned) {
          try {
            await this.logEntry(id, action, text, runContext);
          } catch (err) {
            storeLog.warn("Best-effort post-comment re-triage failed", {
              ...commentContextBase,
              phase,
              stage: "post-invalidation-log-entry",
              nextStatus: "needs-replan",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    return task;
  }

  private hasActiveTask(taskId: string): boolean {
    const row = this.db.prepare(`SELECT id FROM tasks WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`).get(taskId) as
      | { id: string }
      | undefined;
    return Boolean(row);
  }

  private async writeArtifactData(input: ArtifactCreateInput, id: string): Promise<{ uri?: string; sizeBytes?: number; absolutePath?: string }> {
    if (!input.data) {
      return {};
    }

    const storedName = TaskStore.artifactStoredName(id, input.title);
    if (input.taskId) {
      const artifactDir = join(this.taskDir(input.taskId), "artifacts");
      await mkdir(artifactDir, { recursive: true });
      const absolutePath = join(artifactDir, storedName);
      await writeFile(absolutePath, input.data);
      return { uri: `artifacts/${storedName}`, sizeBytes: input.data.length, absolutePath };
    }

    const artifactDir = this.artifactRegistryDir();
    await mkdir(artifactDir, { recursive: true });
    const absolutePath = join(artifactDir, storedName);
    await writeFile(absolutePath, input.data);
    return { uri: `artifacts/${storedName}`, sizeBytes: input.data.length, absolutePath };
  }

  private insertArtifactRow(input: ArtifactCreateInput, id: string, now: string, stored: { uri?: string; sizeBytes?: number }): Artifact {
    this.db.prepare(
      `INSERT INTO artifacts (
        id, type, title, description, mimeType, sizeBytes, uri, content, authorId, authorType, taskId, metadata, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.type,
      input.title,
      input.description ?? null,
      input.mimeType ?? null,
      stored.sizeBytes ?? input.sizeBytes ?? null,
      stored.uri ?? input.uri ?? null,
      input.data ? null : input.content ?? null,
      input.authorId,
      input.authorType,
      input.taskId ?? null,
      toJsonNullable(input.metadata),
      now,
      now,
    );

    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    if (!row) {
      throw new Error(`Failed to register artifact ${id}`);
    }
    return this.rowToArtifact(row);
  }

  /**
   * FNXC:ArtifactRegistry 2026-06-19-22:04:
   * Register multi-type agent/user/system artifacts in SQLite while writing binary payloads to disk. Task-scoped binaries use `.fusion/tasks/{taskId}/artifacts/`; task-less binaries use `.fusion/artifacts/`, and both store only a relative `artifacts/<file>` uri in the row.
   */
  async registerArtifact(input: ArtifactCreateInput): Promise<Artifact> {
    const id = randomUUID();
    const now = new Date().toISOString();

    if (input.taskId) {
      const taskExists = this.db.prepare(`SELECT id, "column" FROM tasks WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`).get(input.taskId) as
        | { id: string; column: Column }
        | undefined;
      if (taskExists?.column === "archived") {
        throw new Error(`Task ${input.taskId} is archived — artifacts are read-only`);
      }
      if (!taskExists) {
        if (this.isTaskArchived(input.taskId)) {
          throw new Error(`Task ${input.taskId} is archived — artifacts are read-only`);
        }
        throw new Error(`Task ${input.taskId} not found`);
      }
    }

    const register = async (): Promise<Artifact> => {
      const stored = await this.writeArtifactData(input, id);
      try {
        return this.insertArtifactRow(input, id, now, stored);
      } catch (error) {
        if (stored.absolutePath) {
          await unlink(stored.absolutePath).catch(() => undefined);
        }
        throw error;
      }
    };

    return input.taskId ? this.withTaskLock(input.taskId, register) : register();
  }

  /**
   * FNXC:ArtifactRegistry 2026-06-19-22:04:
   * Fetch a single artifact metadata row by id for downstream tools and UI without reading binary payload bytes from disk.
   */
  async getArtifact(id: string): Promise<Artifact | null> {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    return row ? this.rowToArtifact(row) : null;
  }

  /**
   * FNXC:ArtifactRegistry 2026-06-19-22:04:
   * List artifacts for an active task newest-first; soft-deleted tasks intentionally return an empty list to mirror task document visibility.
   */
  async getArtifacts(taskId: string): Promise<Artifact[]> {
    if (!this.hasActiveTask(taskId)) {
      return [];
    }

    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE taskId = ? ORDER BY createdAt DESC")
      .all(taskId) as unknown as ArtifactRow[];
    return rows.map((row) => this.rowToArtifact(row));
  }

  /**
   * FNXC:ArtifactRegistry 2026-06-19-22:04:
   * Cross-agent registry query path for filtering artifacts across tasks, authors, and media types. LEFT JOIN keeps task-less registry artifacts visible while excluding artifacts attached to soft-deleted tasks.
   *
   * FNXC:ArtifactRegistry 2026-06-23-12:48:
   * Agent execution can list artifacts frequently while large generated outputs are stored inline. The registry list is metadata-only, so avoid selecting artifact content here and require callers to use getArtifact for the full payload.
   */
  async listArtifacts(options?: {
    type?: ArtifactType;
    authorId?: string;
    taskId?: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<ArtifactWithTask[]> {
    const limit = Math.min(Math.max(1, options?.limit ?? 200), 1000);
    const offset = Math.max(0, options?.offset ?? 0);

    let sql = `
      SELECT
        a.id,
        a.type,
        a.title,
        a.description,
        a.mimeType,
        a.sizeBytes,
        a.uri,
        NULL as content,
        a.authorId,
        a.authorType,
        a.taskId,
        a.metadata,
        a.createdAt,
        a.updatedAt,
        t.title as taskTitle,
        t.description as taskDescription,
        t.column as taskColumn
      FROM artifacts a
      LEFT JOIN tasks t ON a.taskId = t.id
      WHERE (a.taskId IS NULL OR t.${TaskStore.ACTIVE_TASKS_WHERE})
    `;
    const params: (string | number)[] = [];

    if (options?.type) {
      sql += " AND a.type = ?";
      params.push(options.type);
    }
    if (options?.authorId) {
      sql += " AND a.authorId = ?";
      params.push(options.authorId);
    }
    if (options?.taskId) {
      sql += " AND a.taskId = ?";
      params.push(options.taskId);
    }
    if (options?.search && options.search.trim() !== "") {
      const query = `%${options.search.trim()}%`;
      sql += " AND (a.title LIKE ? OR a.description LIKE ?)";
      params.push(query, query);
    }

    sql += " ORDER BY a.createdAt DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as unknown as Array<ArtifactRow & {
      taskTitle: string | null;
      taskDescription: string | null;
      taskColumn: string | null;
    }>;
    return rows.map((row) => ({
      ...this.rowToArtifact(row),
      ...(row.taskTitle !== null ? { taskTitle: row.taskTitle } : {}),
      ...(row.taskDescription !== null ? { taskDescription: row.taskDescription } : {}),
      ...(row.taskColumn !== null ? { taskColumn: row.taskColumn } : {}),
    }));
  }

  /**
   * List all current task documents for a task, ordered by key.
   */
  async getTaskDocuments(taskId: string): Promise<TaskDocument[]> {
    if (!this.hasActiveTask(taskId)) {
      return [];
    }

    const rows = this.db
      .prepare("SELECT * FROM task_documents WHERE taskId = ? ORDER BY key")
      .all(taskId) as unknown as TaskDocumentRow[];
    return rows.map((row) => this.rowToTaskDocument(row));
  }

  /**
   * List all documents across all tasks, optionally filtered by search query.
   * Each document includes its parent task's title and column for display.
   */
  async getAllDocuments(options?: {
    searchQuery?: string;
    limit?: number;
    offset?: number;
  }): Promise<TaskDocumentWithTask[]> {
    const limit = Math.min(Math.max(1, options?.limit ?? 200), 1000);
    const offset = Math.max(0, options?.offset ?? 0);

    let sql = `
      SELECT td.*, t.title as taskTitle, t.description as taskDescription, t.column as taskColumn
      FROM task_documents td
      JOIN tasks t ON td.taskId = t.id
      WHERE t.${TaskStore.ACTIVE_TASKS_WHERE}
    `;
    const params: (string | number)[] = [];

    if (options?.searchQuery && options.searchQuery.trim() !== "") {
      const query = `%${options.searchQuery.trim()}%`;
      sql += ` AND (td.key LIKE ? OR td.content LIKE ? OR t.title LIKE ?)`;
      params.push(query, query, query);
    }

    sql += ` ORDER BY td.updatedAt DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as unknown as (TaskDocumentRow & { taskTitle: string; taskDescription: string; taskColumn: string })[];
    return rows.map((row) => {
      const doc = this.rowToTaskDocument(row);
      return {
        ...doc,
        taskTitle: row.taskTitle,
        taskDescription: row.taskDescription,
        taskColumn: row.taskColumn,
      };
    });
  }

  /**
   * Get the current revision of a specific task document.
   */
  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    if (!this.hasActiveTask(taskId)) {
      return null;
    }

    const row = this.db
      .prepare("SELECT * FROM task_documents WHERE taskId = ? AND key = ?")
      .get(taskId, key) as unknown as TaskDocumentRow | undefined;
    if (!row) return null;
    return this.rowToTaskDocument(row);
  }

  /**
   * Create or update a task document while archiving previous revisions.
   */
  async upsertTaskDocument(taskId: string, input: TaskDocumentCreateInput): Promise<TaskDocument> {
    try {
      validateDocumentKey(input.key);
    } catch {
      throw new Error(
        `Invalid document key: "${input.key}". Must be 1-64 alphanumeric characters, hyphens, or underscores.`,
      );
    }

    const taskExists = this.db.prepare(`SELECT id, "column" FROM tasks WHERE id = ? AND ${TaskStore.ACTIVE_TASKS_WHERE}`).get(taskId) as
      | { id: string; column: Column }
      | undefined;
    if (taskExists?.column === "archived") {
      throw new Error(`Task ${taskId} is archived — documents are read-only`);
    }
    if (!taskExists) {
      if (this.isTaskArchived(taskId)) {
        throw new Error(`Task ${taskId} is archived — documents are read-only`);
      }
      throw new Error(`Task ${taskId} not found`);
    }

    const now = new Date().toISOString();
    const author = input.author ?? "user";
    const metadata = toJsonNullable(input.metadata);

    const document = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM task_documents WHERE taskId = ? AND key = ?")
        .get(taskId, input.key) as TaskDocumentRow | undefined;

      if (existing) {
        this.db.prepare(
          `INSERT INTO task_document_revisions (taskId, key, content, revision, author, metadata, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          taskId,
          input.key,
          existing.content,
          existing.revision,
          existing.author,
          existing.metadata ?? null,
          now,
        );

        this.db.prepare(
          `UPDATE task_documents
           SET content = ?, revision = ?, author = ?, metadata = ?, updatedAt = ?
           WHERE taskId = ? AND key = ?`
        ).run(
          input.content,
          existing.revision + 1,
          author,
          metadata,
          now,
          taskId,
          input.key,
        );
      } else {
        this.db.prepare(
          `INSERT INTO task_documents (id, taskId, key, content, revision, author, metadata, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          taskId,
          input.key,
          input.content,
          1,
          author,
          metadata,
          now,
          now,
        );
      }

      const row = this.db
        .prepare("SELECT * FROM task_documents WHERE taskId = ? AND key = ?")
        .get(taskId, input.key) as TaskDocumentRow | undefined;

      if (!row) {
        throw new Error(`Failed to upsert document ${input.key} for task ${taskId}`);
      }

      return this.rowToTaskDocument(row);
    });

    this.db.bumpLastModified();
    const task = await this.getTask(taskId);
    this.emit("task:updated", task);

    try {
      const citationInputs = this.scanAndRecordCitations(
        input.content,
        "task_document",
        `document:${taskId}:${input.key}:rev${document.revision}`,
        input.author ?? "user",
        taskId,
        document.updatedAt,
      );
      if (citationInputs.length > 0) {
        this.recordGoalCitations(citationInputs);
      }
    } catch (err) {
      console.warn("[fusion] Failed to scan/record goal citations from task document:", err);
    }

    return document;
  }

  /**
   * List archived revisions for a task document, newest first.
   */
  async getTaskDocumentRevisions(
    taskId: string,
    key: string,
    options?: { limit?: number },
  ): Promise<TaskDocumentRevision[]> {
    if (!this.hasActiveTask(taskId)) {
      return [];
    }

    const hasLimit = options?.limit !== undefined;
    const rows = hasLimit
      ? (this.db
          .prepare(
            "SELECT * FROM task_document_revisions WHERE taskId = ? AND key = ? ORDER BY revision DESC LIMIT ?",
          )
          .all(taskId, key, Math.max(0, options.limit ?? 0)) as unknown as TaskDocumentRevisionRow[])
      : (this.db
          .prepare(
            "SELECT * FROM task_document_revisions WHERE taskId = ? AND key = ? ORDER BY revision DESC",
          )
          .all(taskId, key) as unknown as TaskDocumentRevisionRow[]);

    return rows.map((row) => this.rowToTaskDocumentRevision(row));
  }

  /**
   * Delete a task document and all archived revisions for its key.
   * Read paths gate on the parent task's active state, but deletes remain allowed
   * for forensic cleanup against soft-deleted parents.
   */
  async deleteTaskDocument(taskId: string, key: string): Promise<void> {
    const existing = this.db
      .prepare("SELECT id FROM task_documents WHERE taskId = ? AND key = ?")
      .get(taskId, key) as { id: string } | undefined;

    if (!existing) {
      throw new Error(`Document ${key} not found for task ${taskId}`);
    }

    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM task_document_revisions WHERE taskId = ? AND key = ?")
        .run(taskId, key);

      const result = this.db
        .prepare("DELETE FROM task_documents WHERE taskId = ? AND key = ?")
        .run(taskId, key) as { changes?: number };

      if ((result.changes ?? 0) === 0) {
        throw new Error(`Document ${key} not found for task ${taskId}`);
      }
    });

    this.db.bumpLastModified();
    const task = this.readTaskFromDb(taskId, { includeDeleted: true });
    if (task && task.deletedAt == null) {
      this.emit("task:updated", task);
    }
  }

  private getTaskPrInfos(task: Task): import("./types.js").PrInfo[] {
    return [...(task.prInfos ?? (task.prInfo ? [task.prInfo] : []))];
  }

  private resolvePrimaryPrInfo(prInfos: import("./types.js").PrInfo[]): import("./types.js").PrInfo | undefined {
    // Primary selection rule: prefer the most-recently-updated open PR; if none are open,
    // fall back to the first linked PR for stable back-compat rendering.
    const openPrs = prInfos.filter((entry) => entry.status === "open");
    if (openPrs.length === 0) return prInfos[0];
    const sorted = [...openPrs].sort((a, b) => {
      const aTs = Date.parse(a.lastCheckedAt ?? a.lastCommentAt ?? "");
      const bTs = Date.parse(b.lastCheckedAt ?? b.lastCommentAt ?? "");
      if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
      if (Number.isFinite(aTs)) return -1;
      if (Number.isFinite(bTs)) return 1;
      return 0;
    });
    return sorted[0] ?? prInfos[0];
  }

  private upsertPrInfoByNumber(prInfos: import("./types.js").PrInfo[], prInfo: import("./types.js").PrInfo): import("./types.js").PrInfo[] {
    const idx = prInfos.findIndex((entry) => entry.number === prInfo.number);
    if (idx >= 0) {
      const next = [...prInfos];
      next[idx] = { ...next[idx], ...prInfo };
      return next;
    }
    return [prInfo, ...prInfos];
  }

  /**
   * Update or clear PR information for a task.
   * Updates task.json atomically and emits `task:updated` event.
   */
  async updatePrInfo(
    id: string,
    prInfo: import("./types.js").PrInfo | null,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      const previous = task.prInfo;
      const badgeChanged =
        previous?.url !== prInfo?.url ||
        previous?.number !== prInfo?.number ||
        previous?.status !== prInfo?.status ||
        previous?.title !== prInfo?.title ||
        previous?.headBranch !== prInfo?.headBranch ||
        previous?.baseBranch !== prInfo?.baseBranch ||
        previous?.commentCount !== prInfo?.commentCount ||
        previous?.lastCommentAt !== prInfo?.lastCommentAt;
      const linkChanged = previous?.number !== prInfo?.number || previous?.url !== prInfo?.url;

      let prInfos = this.getTaskPrInfos(task);
      if (prInfo) {
        prInfos = this.upsertPrInfoByNumber(prInfos, prInfo);
        if (!previous || linkChanged) {
          task.log.push({ timestamp: new Date().toISOString(), action: "PR linked", outcome: `PR #${prInfo.number}: ${prInfo.url}` });
        } else if (badgeChanged) {
          task.log.push({ timestamp: new Date().toISOString(), action: "PR updated", outcome: `PR #${prInfo.number} badge metadata refreshed` });
        }
      } else {
        if (previous?.number !== undefined) {
          task.log.push({ timestamp: new Date().toISOString(), action: "PR unlinked", outcome: `PR #${previous.number} removed` });
        }
        prInfos = [];
      }

      task.prInfos = prInfos.length > 0 ? prInfos : undefined;
      task.prInfo = this.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });
      if (badgeChanged || linkChanged || !prInfo) this.emit("task:updated", task);
      return task;
    });
  }

  async addPrInfo(id: string, prInfo: import("./types.js").PrInfo): Promise<Task | undefined> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      let prInfos = this.getTaskPrInfos(task);
      const existingIndex = prInfos.findIndex((entry) => entry.number === prInfo.number);
      if (existingIndex >= 0) {
        prInfos[existingIndex] = { ...prInfos[existingIndex], ...prInfo };
      } else {
        prInfos = [prInfo, ...prInfos];
      }
      task.prInfos = prInfos;
      task.prInfo = this.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);
      return task;
    });
  }

  async updatePrInfoByNumber(id: string, number: number, patch: Partial<import("./types.js").PrInfo>): Promise<Task | undefined> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const prInfos = this.getTaskPrInfos(task);
      const index = prInfos.findIndex((entry) => entry.number === number);
      if (index < 0) {
        storeLog.warn(`[store] updatePrInfoByNumber: PR #${number} not found for ${id}`);
        return task;
      }
      prInfos[index] = { ...prInfos[index], ...patch };
      task.prInfos = prInfos;
      task.prInfo = this.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);
      return task;
    });
  }

  async removePrInfoByNumber(id: string, number: number): Promise<Task | undefined> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const prInfos = this.getTaskPrInfos(task).filter((entry) => entry.number !== number);
      if ((task.prInfos ?? []).length === prInfos.length && task.prInfo?.number !== number) {
        storeLog.warn(`[store] removePrInfoByNumber: PR #${number} not found for ${id}`);
        return task;
      }
      task.prInfos = prInfos.length > 0 ? prInfos : undefined;
      task.prInfo = this.resolvePrimaryPrInfo(prInfos);
      task.updatedAt = new Date().toISOString();
      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Update or clear Issue information for a task.
   * Updates task.json atomically and emits `task:updated` event.
   *
   * @param id - The task ID
   * @param issueInfo - The Issue info to set, or null to clear
   * @returns The updated task
   */
  /**
   * Move a PR-linked task to done when the external PR is observed as merged.
   *
   * Column policy: this auto-transition only applies to tasks currently in
   * `in-review`. Other columns remain owned by executor/scheduler flows.
   */
  async applyPrMergedTransition(
    taskId: string,
    ctx?: { agentId?: string; runId?: string },
  ): Promise<{ moved: boolean; skipped?: "already-done" | "not-merged" | "wrong-column" | "paused" }> {
    const task = await this.getTask(taskId);
    if (task.column === "done") {
      return { moved: false, skipped: "already-done" };
    }
    if (task.paused) {
      return { moved: false, skipped: "paused" };
    }
    if (task.prInfo?.status !== "merged") {
      return { moved: false, skipped: "not-merged" };
    }
    if (task.column !== "in-review") {
      storeLog.warn(`[store] applyPrMergedTransition skipped for ${taskId}: column=${task.column}`);
      return { moved: false, skipped: "wrong-column" };
    }

    const freshTask = await this.getTask(taskId);
    if (freshTask.column === "done") {
      return { moved: false, skipped: "already-done" };
    }
    if (freshTask.paused) {
      return { moved: false, skipped: "paused" };
    }
    if (freshTask.prInfo?.status !== "merged") {
      return { moved: false, skipped: "not-merged" };
    }
    if (freshTask.column !== "in-review") {
      storeLog.warn(`[store] applyPrMergedTransition skipped for ${taskId}: column=${freshTask.column}`);
      return { moved: false, skipped: "wrong-column" };
    }

    const movedTask = await this.moveTask(taskId, "done", {
      moveSource: "engine",
      preserveProgress: true,
      preserveWorktree: true,
      skipMergeBlocker: true,
    });

    this.emit("task:merged", {
      task: movedTask,
      branch: movedTask.branch ?? movedTask.prInfo?.headBranch ?? freshTask.branch ?? freshTask.prInfo?.headBranch ?? "",
      merged: true,
      worktreeRemoved: false,
      branchDeleted: false,
      mergeConfirmed: movedTask.mergeDetails?.mergeConfirmed ?? freshTask.mergeDetails?.mergeConfirmed,
      mergedAt: movedTask.mergeDetails?.mergedAt ?? freshTask.mergeDetails?.mergedAt,
      mergeTargetBranch: movedTask.mergeDetails?.mergeTargetBranch ?? freshTask.mergeDetails?.mergeTargetBranch,
      mergeTargetSource: movedTask.mergeDetails?.mergeTargetSource ?? freshTask.mergeDetails?.mergeTargetSource,
    } satisfies MergeResult);

    if (ctx?.agentId && ctx?.runId) {
      this.recordRunAuditEvent({
        taskId,
        agentId: ctx.agentId,
        runId: ctx.runId,
        domain: "database",
        mutationType: "pr:merged-auto-done",
        target: taskId,
        metadata: {
          taskId,
          prNumber: freshTask.prInfo?.number,
          mergeMethod: freshTask.prInfo?.autoMergeStrategy,
        },
      });
    }

    return { moved: true };
  }

  async updateIssueInfo(
    id: string,
    issueInfo: import("./types.js").IssueInfo | null,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      const previous = task.issueInfo;
      const badgeChanged =
        previous?.url !== issueInfo?.url ||
        previous?.number !== issueInfo?.number ||
        previous?.state !== issueInfo?.state ||
        previous?.title !== issueInfo?.title ||
        previous?.stateReason !== issueInfo?.stateReason;
      const linkChanged = previous?.number !== issueInfo?.number || previous?.url !== issueInfo?.url;

      if (issueInfo) {
        task.issueInfo = issueInfo;
        if (!previous || linkChanged) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Issue linked",
            outcome: `Issue #${issueInfo.number}: ${issueInfo.url}`,
          });
        } else if (badgeChanged) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Issue updated",
            outcome: `Issue #${issueInfo.number} badge metadata refreshed`,
          });
        }
      } else {
        task.issueInfo = undefined;
        if (previous?.number) {
          task.log.push({
            timestamp: new Date().toISOString(),
            action: "Issue unlinked",
            outcome: `Issue #${previous.number} removed`,
          });
        }
      }

      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      if (badgeChanged) {
        this.emit("task:updated", task);
      }

      return task;
    });
  }

  async updateGithubTracking(
    id: string,
    tracking: import("./types.js").TaskGithubTracking | null,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const nextTracking = tracking ?? undefined;
      const previousTracking = task.githubTracking;

      if (JSON.stringify(previousTracking ?? null) === JSON.stringify(nextTracking ?? null)) {
        return task;
      }

      task.githubTracking = nextTracking;
      task.log.push({
        timestamp: new Date().toISOString(),
        action: tracking?.enabled === false ? "GitHub tracking disabled" : "GitHub tracking enabled",
      });
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);
      return task;
    });
  }

  async linkGithubIssue(
    id: string,
    issue: import("./types.js").TaskGithubTrackedIssue,
  ): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const previous = task.githubTracking ?? {};

      const nextTracking: import("./types.js").TaskGithubTracking = {
        ...previous,
        issue,
        enabled: previous.enabled ?? true,
      };

      if (JSON.stringify(previous) === JSON.stringify(nextTracking)) {
        return task;
      }

      task.githubTracking = nextTracking;
      task.log.push({
        timestamp: new Date().toISOString(),
        action: "GitHub issue linked",
        outcome: `${issue.owner}/${issue.repo}#${issue.number}`,
      });
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);
      return task;
    });
  }

  async unlinkGithubIssue(id: string): Promise<Task> {
    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);
      const previous = task.githubTracking;
      const previousIssue = previous?.issue;

      if (!previousIssue || !previous) {
        return task;
      }

      task.githubTracking = {
        ...previous,
        issue: undefined,
        unlinkedAt: new Date().toISOString(),
      };
      task.log.push({
        timestamp: new Date().toISOString(),
        action: "GitHub issue unlinked",
        outcome: `${previousIssue.owner}/${previousIssue.repo}#${previousIssue.number}`,
      });
      task.updatedAt = new Date().toISOString();

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });
      this.emit("task:updated", task);
      return task;
    });
  }

  /**
   * Read historical agent log entries for a task from JSONL storage.
   * Returns entries in chronological order (oldest first).
   *
   * Tool-oriented detail payloads are clipped server-side to keep historical
   * log reads responsive even when agents emit very large command results.
   * The 500-entry cap (`MAX_LOG_ENTRIES`) in the dashboard hooks remains a
   * whole-list limit only.
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @param options - Optional pagination options
   * @param options.limit - Maximum number of entries to return (most recent)
   * @param options.offset - Number of most-recent entries to skip (for pagination)
   * @returns Array of agent log entries
   */
  async getAgentLogs(
    taskId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<AgentLogEntry[]> {
    // Ensure buffered entries are visible before reading.
    this.flushAgentLogBuffer();
    if (this.readTaskFromDb(taskId, { includeDeleted: true })?.deletedAt) {
      return [];
    }
    const limit = options?.limit !== undefined
      ? (Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 0)
      : undefined;
    const offset = options?.offset !== undefined
      ? (Number.isFinite(options.offset) ? Math.max(0, Math.floor(options.offset)) : 0)
      : 0;

    if (limit === 0) return [];

    return readAgentLogEntries(this.taskDir(taskId), { limit, offset }).map(
      ({ lineNo: _lineNo, sourceRef: _sourceRef, ...entry }) => entry,
    );
  }

  /**
   * Count total number of persisted agent log entries for a task in JSONL storage.
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @returns Total number of log entries
   */
  async getAgentLogCount(taskId: string): Promise<number> {
    this.flushAgentLogBuffer();
    if (this.readTaskFromDb(taskId, { includeDeleted: true })?.deletedAt) {
      return 0;
    }
    return countAgentLogEntries(this.taskDir(taskId));
  }

  /**
   * Get persisted agent log entries for a task filtered by an inclusive time range.
   *
   * @param taskId - The task ID (e.g. "KB-001")
   * @param startIso - ISO-8601 start timestamp (inclusive)
   * @param endIso - ISO-8601 end timestamp (inclusive), or null for "now"
   * @returns Filtered array of agent log entries
   */
  async getAgentLogsByTimeRange(
    taskId: string,
    startIso: string,
    endIso: string | null,
  ): Promise<AgentLogEntry[]> {
    // Ensure buffered entries are visible before reading.
    this.flushAgentLogBuffer();
    if (this.readTaskFromDb(taskId, { includeDeleted: true })?.deletedAt) {
      return [];
    }
    const end = endIso ?? new Date().toISOString();
    return readAgentLogEntriesByTimeRange(this.taskDir(taskId), startIso, end).map(
      ({ lineNo: _lineNo, sourceRef: _sourceRef, ...entry }) => entry,
    );
  }

  async importLegacyAgentLogs(): Promise<number> {
    if (!existsSync(this.tasksDir)) return 0;

    const entries = await readdir(this.tasksDir, { withFileTypes: true });
    let imported = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskDir = join(this.tasksDir, entry.name);
      const logPath = join(taskDir, "agent.log");
      if (!existsSync(logPath)) continue;

      try {
        const content = await readFile(logPath, "utf-8");
        const parsedEntries: Array<{
          timestamp: string;
          taskId: string;
          text: string;
          type: AgentLogEntry["type"];
          detail?: string | null;
          agent?: AgentLogEntry["agent"] | null;
        }> = [];
        for (const line of content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
            const parsedTaskId = typeof parsed.taskId === "string" ? parsed.taskId : null;
            const type = typeof parsed.type === "string" ? parsed.type : null;
            if (!timestamp || !parsedTaskId || !type) continue;

            parsedEntries.push({
              timestamp,
              taskId: parsedTaskId,
              text: typeof parsed.text === "string" ? parsed.text : "",
              type: type as AgentLogEntry["type"],
              detail: typeof parsed.detail === "string" ? parsed.detail : null,
              agent: typeof parsed.agent === "string" ? (parsed.agent as AgentLogEntry["agent"]) : null,
            });
          } catch {
            // Skip malformed JSONL lines.
          }
        }

        appendAgentLogEntriesSync(taskDir, parsedEntries);
        imported += parsedEntries.length;
      } catch (err) {
        storeLog.warn("Skipping unreadable legacy agent.log file during import", {
          phase: "importLegacyAgentLogs:read-file",
          taskId: entry.name,
          logPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (imported > 0) {
      this.db.bumpLastModified();
    }

    return imported;
  }

  private async importLegacyAgentLogsOnce(): Promise<void> {
    const migrationKey = "agentLogLegacyFileImportVersion";
    const migrationVersion = "1";
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;

    if (row?.value === migrationVersion) {
      return;
    }

    await this.importLegacyAgentLogs();
    this.db.prepare(`
      INSERT INTO __meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(migrationKey, migrationVersion);
    this.db.bumpLastModified();
  }

  /**
   * One-time migration: copy `agentLogEntries` rows from SQLite into per-task
   * JSONL files, then rewrite goal-citation source-refs from the old
   * `agentLog:<rowid>` format to the new `agentLog:{taskId}:{lineNo}` format.
   * Guarded by `__meta` so it runs exactly once.
   */
  private async migrateAgentLogEntriesToFilesOnce(): Promise<void> {
    const migrationKey = "agentLogEntriesToFileMigrationVersion";
    const migrationVersion = "1";
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;

    if (row?.value === migrationVersion) {
      return;
    }

    // Only run if the agentLogEntries table still exists
    const hasTable =
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agentLogEntries' LIMIT 1").get() !==
      undefined;
    if (!hasTable) {
      // Table already gone (fresh DB or already migrated) — mark done
      this.db.prepare(`
        INSERT INTO __meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(migrationKey, migrationVersion);
      return;
    }

    interface AgentLogRow {
      id: number;
      taskId: string;
      timestamp: string;
      text: string;
      type: string;
      detail: string | null;
      agent: string | null;
    }

    // Read all rows ordered by taskId, id so each task's entries are
    // written in their original insertion order
    const rows = this.db
      .prepare("SELECT id, taskId, timestamp, text, type, detail, agent FROM agentLogEntries ORDER BY taskId, id")
      .all() as AgentLogRow[];

    if (rows.length > 0) {
      // Group rows by task
      const entriesByTask = new Map<string, AgentLogRow[]>();
      for (const row of rows) {
        let taskRows = entriesByTask.get(row.taskId);
        if (!taskRows) {
          taskRows = [];
          entriesByTask.set(row.taskId, taskRows);
        }
        taskRows.push(row);
      }

      // Write per-task JSONL files
      const rowIdToNewRef = new Map<number, string>();
      for (const [taskId, taskRows] of entriesByTask) {
        const td = this.taskDir(taskId);
        const appended = appendAgentLogEntriesSync(
          td,
          taskRows.map((r) => ({
            timestamp: r.timestamp,
            taskId: r.taskId,
            text: r.text,
            type: r.type as AgentLogEntry["type"],
            detail: r.detail,
            agent: r.agent as AgentLogEntry["agent"] | null,
          })),
        );
        // Build mapping from old rowid to new sourceRef
        for (let i = 0; i < taskRows.length; i++) {
          rowIdToNewRef.set(taskRows[i]!.id, appended[i]!.sourceRef);
        }
      }

      // Rewrite goal-citation source-refs that use the old agentLog:<rowid> format
      const oldFormatRows = this.db
        .prepare("SELECT id, sourceRef FROM goal_citations WHERE surface = 'agent_log' AND sourceRef GLOB 'agentLog:[0-9]*'")
        .all() as Array<{ id: number; sourceRef: string }>;

      const updateStmt = this.db.prepare("UPDATE goal_citations SET sourceRef = ? WHERE id = ?");
      this.db.transaction(() => {
        for (const citation of oldFormatRows) {
          const oldRowId = parseInt(citation.sourceRef.replace("agentLog:", ""), 10);
          const newRef = rowIdToNewRef.get(oldRowId);
          if (newRef) {
            updateStmt.run(newRef, citation.id);
          }
        }
      });
    }

    // Mark migration as done
    this.db.prepare(`
      INSERT INTO __meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(migrationKey, migrationVersion);
    this.db.bumpLastModified();
  }

  private async cleanupNoOpTaskMovedActivityRowsOnce(): Promise<void> {
    const migrationKey = "noOpTaskMovedActivityCleanupVersion";
    const migrationVersion = "1";
    const row = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(migrationKey) as
      | { value: string }
      | undefined;

    if (row?.value === migrationVersion) {
      return;
    }

    const hasTable =
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activityLog' LIMIT 1").get() !==
      undefined;
    const markDone = () => {
      this.db.prepare(`
        INSERT INTO __meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(migrationKey, migrationVersion);
    };

    if (!hasTable) {
      markDone();
      this.db.bumpLastModified();
      return;
    }

    this.db.transactionImmediate(() => {
      this.db.prepare(`
        DELETE FROM activityLog
        WHERE type = 'task:moved'
          AND json_extract(metadata, '$.from') = json_extract(metadata, '$.to')
      `).run();
      markDone();
      this.db.bumpLastModified();
    });
  }

  /**
   * U4 (R6/R8, KTD-5): one-time, idempotent, per-project hard-move of the
   * `MOVED_SETTINGS_KEYS` catalog out of project/global settings and into
   * `workflow_settings` values, keyed per `(workflowId, projectId)`.
   *
   * Gated by the `settingsMigrationVersion` `__meta` marker so it runs exactly
   * once per project DB. The sequence (matching the plan's HTD diagram):
   *
   *   1. Read the RAW persisted project + global settings (the typed read can no
   *      longer see moved keys post-schema-removal, so read the JSON directly);
   *      snapshot ONLY the moved keys the user actually CUSTOMIZED (present in raw
   *      storage) — defaults are not snapshotted (they re-derive from declarations).
   *   2. Compute the write target = distinct `task_workflow_selection.workflowId`
   *      for this project ∪ the resolved project default, where an unset/empty
   *      `defaultWorkflowId` normalizes to `builtin:coding` (the id every
   *      selection-less task resolves to). A default pointing at a deleted/missing
   *      workflow also degrades to `builtin:coding`.
   *   3. Validate the snapshot against EACH target workflow's declarations (the
   *      values came from validated project settings, so this normally passes); a
   *      value that fails the new validation is DROPPED and logged — never aborts.
   *   4. In ONE SQLite transaction: upsert the accepted snapshot into each
   *      `(workflowId, projectId)` value row, null the moved keys out of the raw
   *      project `config.settings`, and set the marker. (The async validation /
   *      declaration resolution happens BEFORE the transaction — the transaction
   *      body is pure synchronous SQLite, so the persisted writes commit atomically.)
   *   5. Defensively null the moved keys out of the global store (outside the txn;
   *      all moved keys are project-scoped, so this is belt-and-suspenders).
   *
   * Idempotent / crash-safe: value upserts overwrite identically, the raw null-out
   * is re-runnable, and the marker is set LAST inside the transaction. A crash
   * between the value-write and the null-out re-runs the whole thing and converges.
   */
  private async migrateMovedSettingsToWorkflowValuesOnce(): Promise<void> {
    const markerKey = SETTINGS_MIGRATION_MARKER_KEY;
    const markerRow = this.db.prepare("SELECT value FROM __meta WHERE key = ?").get(markerKey) as
      | { value: string }
      | undefined;
    if (markerRow && Number(markerRow.value) >= SETTINGS_MIGRATION_VERSION) {
      return;
    }

    const movedKeys = MOVED_SETTINGS_KEYS as readonly string[];
    const projectId = this.getWorkflowSettingsProjectId();

    // (1) Snapshot CUSTOMIZED moved keys from RAW persisted project + global stores.
    const rawProjectSettings = this.readRawProjectSettings();
    let rawGlobalSettings: Record<string, unknown> = {};
    try {
      rawGlobalSettings = await this.globalSettingsStore.readRaw();
    } catch {
      rawGlobalSettings = {};
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of movedKeys) {
      // Project storage wins over global (moved keys are project-scoped); only
      // snapshot keys the user actually customized (present in raw storage).
      if (Object.prototype.hasOwnProperty.call(rawProjectSettings, key)) {
        snapshot[key] = rawProjectSettings[key];
      } else if (Object.prototype.hasOwnProperty.call(rawGlobalSettings, key)) {
        snapshot[key] = rawGlobalSettings[key];
      }
    }

    // (2) Compute the write-target workflow ids (shared with the U5 v1→v2
    //     import upgrade so both write to identical lanes).
    const targetWorkflowIds = await this.computeMovedSettingsTargetWorkflowIds();

    // (3) Validate the snapshot per target workflow (async declaration resolution
    //     done HERE, before the synchronous transaction). Drop-and-log invalid
    //     values; never abort. Empty accepted maps are fine (nothing to write).
    const acceptedByWorkflow = new Map<string, Record<string, unknown>>();
    if (Object.keys(snapshot).length > 0) {
      for (const workflowId of targetWorkflowIds) {
        let declarations: WorkflowSettingDefinition[] | undefined;
        try {
          declarations = await this.resolveWorkflowSettingDeclarations(workflowId);
        } catch {
          declarations = undefined;
        }
        const result = validateSettingValuePatch(declarations, snapshot);
        if (result.rejections.length > 0) {
          storeLog.warn("Dropped invalid moved-setting values during hard-move migration", {
            phase: "migrateMovedSettings:validate",
            workflowId,
            projectId,
            rejected: result.rejections.map((r) => `${r.settingId}:${r.code}`),
          });
        }
        acceptedByWorkflow.set(workflowId, result.accepted);
      }
    }

    // (4) ONE SQLite transaction: value upserts + raw project null-out + marker.
    const now = new Date().toISOString();
    this.db.transactionImmediate(() => {
      for (const [workflowId, accepted] of acceptedByWorkflow) {
        if (Object.keys(accepted).length === 0) continue;
        const current = this.getWorkflowSettingValues(workflowId, projectId);
        const next: Record<string, unknown> = { ...current };
        for (const [k, v] of Object.entries(accepted)) {
          if (v === null || v === undefined) {
            delete next[k];
          } else {
            next[k] = v;
          }
        }
        this.db
          .prepare(
            `INSERT INTO workflow_settings (workflowId, projectId, "values", updatedAt)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(workflowId, projectId)
             DO UPDATE SET "values" = excluded."values", updatedAt = excluded.updatedAt`,
          )
          .run(workflowId, projectId, JSON.stringify(next), now);
      }

      // Null the moved keys out of the raw project config.settings.
      const configRow = this.db.prepare("SELECT settings FROM config WHERE id = 1").get() as
        | { settings: string }
        | undefined;
      if (configRow) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = (JSON.parse(configRow.settings) as Record<string, unknown>) ?? {};
        } catch {
          parsed = {};
        }
        let changed = false;
        for (const key of movedKeys) {
          if (Object.prototype.hasOwnProperty.call(parsed, key)) {
            delete parsed[key];
            changed = true;
          }
        }
        if (changed) {
          this.db
            .prepare("UPDATE config SET settings = ?, updatedAt = ? WHERE id = 1")
            .run(JSON.stringify(parsed), now);
        }
      }

      this.db.prepare(`
        INSERT INTO __meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(markerKey, String(SETTINGS_MIGRATION_VERSION));
      this.db.bumpLastModified();
    });

    // (5) Defensive: null the moved keys out of the global store (outside the txn).
    const globalMovedPatch: Record<string, unknown> = {};
    for (const key of movedKeys) {
      if (Object.prototype.hasOwnProperty.call(rawGlobalSettings, key)) {
        globalMovedPatch[key] = null; // null-as-delete
      }
    }
    if (Object.keys(globalMovedPatch).length > 0) {
      try {
        await this.globalSettingsStore.updateSettings(globalMovedPatch as Partial<GlobalSettings>);
      } catch (err) {
        storeLog.warn("Global moved-key null-out failed during hard-move migration (non-fatal)", {
          phase: "migrateMovedSettings:global-nullout",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Invalidate cached config so subsequent reads reflect the removed keys.
    this.invalidateConfigCacheAfterMigration();
  }

  /** Read the RAW persisted project settings JSON (the `config.settings` row),
   *  WITHOUT applying `DEFAULT_SETTINGS`. The migration needs this because the
   *  typed read merges defaults (which no longer contain moved keys), so it could
   *  not distinguish a customized moved value from an absent one. Returns `{}` on
   *  any read/parse failure. */
  private readRawProjectSettings(): Record<string, unknown> {
    try {
      const row = this.db.prepare("SELECT settings FROM config WHERE id = 1").get() as
        | { settings: string }
        | undefined;
      if (!row) return {};
      const parsed = JSON.parse(row.settings) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Drop any in-memory config cache after the migration mutates the raw
   *  `config.settings` row directly (bypassing `writeConfig`). No-op if the store
   *  has no such cache field. */
  private invalidateConfigCacheAfterMigration(): void {
    // The project config is read fresh from SQLite each call (readConfigFast),
    // so there is no project-settings cache to invalidate. The global store does
    // cache; updateSettings() above already refreshed it. This hook exists as a
    // documented seam in case a config cache is added later.
  }

  // ── Archive Cleanup Methods ─────────────────────────────────────────

  /**
   * Read all archived task entries from SQLite.
   */
  async readArchiveLog(): Promise<import("./types.js").ArchivedTaskEntry[]> {
    return this.archiveDb.list();
  }

  /**
   * Find a specific task in the archive by ID.
   */
  async findInArchive(id: string): Promise<import("./types.js").ArchivedTaskEntry | undefined> {
    return this.archiveDb.get(id);
  }

  private migrateLegacyArchiveEntriesToArchiveDb(): void {
    const rows = this.db.prepare("SELECT id, data FROM archivedTasks").all() as Array<{ id: string; data: string }>;
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      const entry = JSON.parse(row.data) as ArchivedTaskEntry;
      this._archiveDb?.upsert({
        ...entry,
        log: compactTaskActivityLog(entry.log ?? []),
      });
    }

    this.db.prepare("DELETE FROM archivedTasks").run();
    this.db.bumpLastModified();
  }

  private async migrateActiveArchivedTasksToArchiveDb(): Promise<void> {
    const rows = this.db.prepare(`SELECT * FROM tasks WHERE "column" = 'archived'`).all() as unknown as TaskRow[];
    if (rows.length === 0) {
      return;
    }

    const { rm } = await import("node:fs/promises");
    for (const row of rows) {
      const task = this.rowToTask(row);
      const archivedAt = task.columnMovedAt ?? task.updatedAt ?? new Date().toISOString();
      const entry = await this.taskToArchiveEntry(task, archivedAt);
      this.archiveDb.upsert(entry);
      this.purgeTaskWorkflowSelectionRows(task.id);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
      await rm(this.taskDir(task.id), { recursive: true, force: true });
      if (this.isWatching) {
        this.taskCache.delete(task.id);
      }
    }

    this.db.bumpLastModified();
  }

  /**
   * Cleanup any legacy active archived tasks by writing compact entries to
   * archive.db and removing task directories.
   *
   * Note: lineage pointers to archived/deleted parents are tolerated here.
   * This cleanup runs on already-archived rows, and lineage integrity gates
   * are enforced earlier on deleteTask/archiveTask for live children only.
   */
  async cleanupArchivedTasks(): Promise<string[]> {
    const archivedTasks = await this.listTasks({ column: "archived" });

    const cleanedUpIds: string[] = [];

    for (const task of archivedTasks) {
      const dir = this.taskDir(task.id);

      // Skip if directory already cleaned up
      if (!existsSync(dir)) {
        continue;
      }

      const entry = await this.taskToArchiveEntry(task, new Date().toISOString());
      this.archiveDb.upsert(entry);

      // Remove task from tasks table
      this.purgeTaskWorkflowSelectionRows(task.id);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
      this.db.bumpLastModified();

      // Remove task directory recursively
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });

      // Remove from cache if watcher is active
      if (this.isWatching) {
        this.taskCache.delete(task.id);
      }

      cleanedUpIds.push(task.id);
    }

    return cleanedUpIds;
  }

  /**
   * Restore a task from an archive entry.
   * Recreates task directory with task.json and PROMPT.md.
   * Clears transient execution state (worktree, status, blockedBy, etc.).
   * Agent log entries are stored in SQLite and are deleted by FK cascade when
   * the task row is removed; archive snapshots (`agentLogFull`/`agentLogSnapshot`)
   * preserve point-in-time log data inside the archived task record.
   */
  private async restoreFromArchive(entry: import("./types.js").ArchivedTaskEntry): Promise<Task> {
    const dir = this.taskDir(entry.id);

    // Create task directory
    await mkdir(dir, { recursive: true });

    // Build restored task (clear transient fields)
    const restoredTask: Task = {
      id: entry.id,
      lineageId: entry.lineageId || generateTaskLineageId(),
      title: entry.title,
      description: entry.description,
      priority: normalizeTaskPriority(entry.priority),
      column: "archived", // Will be changed by unarchiveTask
      preArchiveColumn: entry.preArchiveColumn,
      dependencies: entry.dependencies,
      steps: entry.steps,
      currentStep: entry.currentStep,
      customFields: entry.customFields ?? undefined,
      size: entry.size,
      reviewLevel: entry.reviewLevel,
      prInfo: entry.prInfo,
      review: entry.review,
      issueInfo: entry.issueInfo,
      githubTracking: entry.githubTracking,
      sourceIssue: entry.sourceIssue,
      attachments: entry.attachments,
      log: [...entry.log, { timestamp: new Date().toISOString(), action: "Task restored from archive" }],
      comments: entry.comments,
      createdAt: entry.createdAt,
      updatedAt: new Date().toISOString(),
      columnMovedAt: entry.columnMovedAt,
      modelPresetId: entry.modelPresetId,
      modelProvider: entry.modelProvider,
      modelId: entry.modelId,
      validatorModelProvider: entry.validatorModelProvider,
      validatorModelId: entry.validatorModelId,
      planningModelProvider: entry.planningModelProvider,
      planningModelId: entry.planningModelId,
      breakIntoSubtasks: entry.breakIntoSubtasks,
      noCommitsExpected: entry.noCommitsExpected,
      modifiedFiles: entry.modifiedFiles,
      // Intentionally NOT restoring: worktree, status, blockedBy, paused, executionStartBranch, baseCommitSha, error
    };

    // Write task.json
    await this.atomicWriteTaskJson(dir, restoredTask);

    // Generate PROMPT.md with preserved steps
    const prompt = entry.prompt ?? this.generatePromptFromArchiveEntry(entry);
    const sanitizedPrompt = sanitizeFileScopeInPromptContent(prompt);
    if (sanitizedPrompt.dropped.length > 0) {
      storeLog.log(`[file-scope-sanitize] restore ${entry.id}: dropped=[${sanitizedPrompt.dropped.join(",")}]`);
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "PROMPT.md"), sanitizedPrompt.sanitized);

    // Create empty attachments directory if attachments existed
    if (entry.attachments && entry.attachments.length > 0) {
      await mkdir(join(dir, "attachments"), { recursive: true });
    }

    return restoredTask;
  }

  /**
   * Generate a PROMPT.md from an archive entry, preserving the original step structure.
   */
  private generatePromptFromArchiveEntry(entry: import("./types.js").ArchivedTaskEntry): string {
    const deps =
      entry.dependencies.length > 0
        ? entry.dependencies.map((d) => `- **Task:** ${d}`).join("\n")
        : "- **None**";

    const heading = entry.title ? `${entry.id}: ${entry.title}` : entry.id;

    // Build steps section from preserved steps
    let stepsSection = "## Steps\n\n";
    if (entry.steps && entry.steps.length > 0) {
      for (let i = 0; i < entry.steps.length; i++) {
        const step = entry.steps[i];
        const status = step.status === "done" ? "[x]" : "[ ]";
        stepsSection += `### Step ${i}: ${step.name}\n\n- ${status} ${step.name}\n\n`;
      }
    } else {
      stepsSection += "### Step 0: Preflight\n\n- [ ] Review and verify\n\n";
    }

    return `# ${heading}

**Created:** ${entry.createdAt.split("T")[0]}
${entry.size ? `**Size:** ${entry.size}` : "**Size:** M"}

## Mission

${entry.description}

## Dependencies

${deps}

${stepsSection}`;
  }

  // ── Workflow Step CRUD Methods ─────────────────────────────────────

  /**
   * Create a new workflow step definition.
   * Generates a unique ID (WS-001, WS-002, etc.) and stores in the workflow_steps table.
   */
  async createWorkflowStep(input: import("./types.js").WorkflowStepInput): Promise<import("./types.js").WorkflowStep> {
    return this.withConfigLock(async () => {
      const counterRow = this.db
        .prepare("SELECT nextWorkflowStepId FROM config WHERE id = 1")
        .get() as { nextWorkflowStepId?: number } | undefined;
      const nextWsId = counterRow?.nextWorkflowStepId || 1;
      const id = `WS-${String(nextWsId).padStart(3, "0")}`;

      const mode = input.mode || "prompt";
      const gateMode = input.gateMode || "advisory";

      // Validate: script mode requires scriptName
      if (mode === "script" && !input.scriptName?.trim()) {
        throw new Error("Script mode requires a scriptName");
      }

      const now = new Date().toISOString();
      const step: import("./types.js").WorkflowStep = {
        id,
        templateId: input.templateId,
        name: input.name,
        description: input.description,
        mode,
        phase: input.phase || "pre-merge",
        gateMode,
        prompt: mode === "prompt" ? (input.prompt || "") : "",
        toolMode: mode === "prompt" ? (input.toolMode || "readonly") : undefined,
        scriptName: mode === "script" ? input.scriptName : undefined,
        enabled: input.enabled !== undefined ? input.enabled : true,
        defaultOn: input.defaultOn !== undefined ? input.defaultOn : undefined,
        modelProvider: mode === "prompt" ? input.modelProvider : undefined,
        modelId: mode === "prompt" ? input.modelId : undefined,
        migratedFragmentId: input.migratedFragmentId,
        createdAt: now,
        updatedAt: now,
      };

      this.db.prepare(
        `INSERT INTO workflow_steps (
          id,
          templateId,
          name,
          description,
          mode,
          phase,
          gateMode,
          prompt,
          toolMode,
          scriptName,
          enabled,
          defaultOn,
          modelProvider,
          modelId,
          migrated_fragment_id,
          createdAt,
          updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        step.id,
        step.templateId ?? null,
        step.name,
        step.description,
        step.mode,
        step.phase || "pre-merge",
        step.gateMode,
        step.prompt,
        step.toolMode ?? null,
        step.scriptName ?? null,
        step.enabled ? 1 : 0,
        step.defaultOn === undefined ? null : step.defaultOn ? 1 : 0,
        step.modelProvider ?? null,
        step.modelId ?? null,
        step.migratedFragmentId ?? null,
        step.createdAt,
        step.updatedAt,
      );

      const config = await this.readConfig();
      await this.writeConfig(config, { nextWorkflowStepId: nextWsId + 1 });
      this.workflowStepsCache = null;

      return step;
    });
  }

  setPluginWorkflowStepTemplates(templates: Array<{ pluginId: string; template: WorkflowStepTemplate }>): void {
    this._pluginWorkflowStepTemplates = [...templates];
    this.workflowStepsCache = null;
  }

  private resolvePluginWorkflowStep(id: string): import("./types.js").WorkflowStep | undefined {
    const match = id.match(/^plugin:([^:]+):(.+)$/);
    if (!match) return undefined;

    const [, pluginId, stepId] = match;
    const entry = this._pluginWorkflowStepTemplates.find(
      ({ pluginId: candidatePluginId, template }) => candidatePluginId === pluginId && template.id === id,
    );
    if (!entry) return undefined;

    const now = new Date().toISOString();
    return {
      id,
      templateId: stepId,
      name: entry.template.name,
      description: entry.template.description,
      mode: entry.template.mode ?? "prompt",
      phase: entry.template.phase ?? "pre-merge",
      gateMode: entry.template.gateMode ?? "advisory",
      prompt: entry.template.prompt ?? "",
      scriptName: entry.template.scriptName,
      toolMode: entry.template.toolMode,
      enabled: entry.template.enabled ?? true,
      defaultOn: entry.template.defaultOn,
      modelProvider: entry.template.modelProvider,
      modelId: entry.template.modelId,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * List all workflow step definitions from workflow_steps.
   * Results are cached and invalidated on create/update/delete.
   */
  async listWorkflowSteps(): Promise<import("./types.js").WorkflowStep[]> {
    if (this.workflowStepsCache) return this.workflowStepsCache;
    const rows = this.db.prepare("SELECT * FROM workflow_steps ORDER BY createdAt ASC").all() as Array<{
      id: string;
      templateId: string | null;
      name: string;
      description: string;
      mode: string;
      phase: string | null;
      prompt: string;
      gateMode: string | null;
      toolMode: string | null;
      scriptName: string | null;
      enabled: number;
      defaultOn: number | null;
      modelProvider: string | null;
      modelId: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    const storedSteps = rows
      .map((row) => this.applyLegacyWorkflowStepOverrides(this.toStoredWorkflowStep(row)))
      // Steps materialized by compiling a workflow are an execution detail; keep
      // them out of the user-facing step manager listing. The executor resolves
      // them directly via getWorkflowStep, which is unaffected by this filter.
      .filter((step) => !step.templateId?.startsWith(WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX));
    const pluginSteps = this._pluginWorkflowStepTemplates
      .map(({ template }) => this.resolvePluginWorkflowStep(template.id))
      .filter((step): step is import("./types.js").WorkflowStep => Boolean(step));
    this.workflowStepsCache = [...storedSteps, ...pluginSteps];
    return this.workflowStepsCache;
  }

  /**
   * Get a single workflow step by ID.
   */
  async getWorkflowStep(id: string): Promise<import("./types.js").WorkflowStep | undefined> {
    if (id.startsWith("plugin:")) {
      const pluginStep = this.resolvePluginWorkflowStep(id);
      if (pluginStep) {
        return pluginStep;
      }
    }

    const byId = this.db.prepare("SELECT * FROM workflow_steps WHERE id = ?").get(id) as
      | {
          id: string;
          templateId: string | null;
          name: string;
          description: string;
          mode: string;
          phase: string | null;
          gateMode: string | null;
          prompt: string;
          toolMode: string | null;
          scriptName: string | null;
          enabled: number;
          defaultOn: number | null;
          modelProvider: string | null;
          modelId: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (byId) {
      return this.applyLegacyWorkflowStepOverrides(this.toStoredWorkflowStep(byId));
    }

    const byTemplate = this.db
      .prepare("SELECT * FROM workflow_steps WHERE templateId = ? ORDER BY createdAt ASC LIMIT 1")
      .get(id) as
      | {
          id: string;
          templateId: string | null;
          name: string;
          description: string;
          mode: string;
          phase: string | null;
          gateMode: string | null;
          prompt: string;
          toolMode: string | null;
          scriptName: string | null;
          enabled: number;
          defaultOn: number | null;
          modelProvider: string | null;
          modelId: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    if (byTemplate) {
      return this.applyLegacyWorkflowStepOverrides(this.toStoredWorkflowStep(byTemplate));
    }

    const template = this.getBuiltInWorkflowTemplate(id);
    return template ? this.toBuiltInWorkflowStep(template) : undefined;
  }

  /**
   * Update a workflow step definition.
   * @throws Error if the workflow step is not found
   */
  async updateWorkflowStep(id: string, updates: Partial<import("./types.js").WorkflowStepInput>): Promise<import("./types.js").WorkflowStep> {
    const row = this.db.prepare("SELECT * FROM workflow_steps WHERE id = ?").get(id) as
      | {
          id: string;
          templateId: string | null;
          name: string;
          description: string;
          mode: string;
          phase: string | null;
          gateMode: string | null;
          prompt: string;
          toolMode: string | null;
          scriptName: string | null;
          enabled: number;
          defaultOn: number | null;
          modelProvider: string | null;
          modelId: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) {
      throw new Error(`Workflow step '${id}' not found`);
    }

    const step = this.toStoredWorkflowStep(row);

    // Handle mode change
    if (updates.mode !== undefined) {
      const newMode = updates.mode;
      // Validate: script mode requires scriptName
      if (newMode === "script" && !updates.scriptName?.trim() && !step.scriptName?.trim()) {
        throw new Error("Script mode requires a scriptName");
      }
      step.mode = newMode;
      // When switching to script mode, clear prompt and model overrides
      if (newMode === "script") {
        step.prompt = "";
        step.gateMode = step.gateMode || "gate";
        step.toolMode = undefined;
        step.modelProvider = undefined;
        step.modelId = undefined;
      }
      // When switching to prompt mode, clear scriptName
      if (newMode === "prompt") {
        step.scriptName = undefined;
        step.gateMode = step.gateMode || "advisory";
        step.toolMode = step.toolMode || "readonly";
      }
    }

    if (updates.name !== undefined) step.name = updates.name;
    if (updates.description !== undefined) step.description = updates.description;
    if (updates.phase !== undefined) step.phase = updates.phase;
    if (updates.gateMode !== undefined) step.gateMode = updates.gateMode;
    if (updates.prompt !== undefined && step.mode === "prompt") step.prompt = updates.prompt;
    if (updates.toolMode !== undefined && step.mode === "prompt") step.toolMode = updates.toolMode;
    if (updates.scriptName !== undefined && step.mode === "script") step.scriptName = updates.scriptName;
    if (updates.enabled !== undefined) step.enabled = updates.enabled;
    if (updates.defaultOn !== undefined) step.defaultOn = updates.defaultOn;
    if (step.mode === "script" && !step.scriptName?.trim()) {
      throw new Error("Script mode requires a scriptName");
    }
    if (step.mode === "prompt") {
      if ("modelProvider" in updates) step.modelProvider = updates.modelProvider;
      if ("modelId" in updates) step.modelId = updates.modelId;
    }
    if ("migratedFragmentId" in updates) step.migratedFragmentId = updates.migratedFragmentId;
    step.updatedAt = new Date().toISOString();

    this.db.prepare(
      `UPDATE workflow_steps
       SET templateId = ?,
           name = ?,
           description = ?,
           mode = ?,
           phase = ?,
           gateMode = ?,
           prompt = ?,
           toolMode = ?,
           scriptName = ?,
           enabled = ?,
           defaultOn = ?,
           modelProvider = ?,
           modelId = ?,
           migrated_fragment_id = ?,
           updatedAt = ?
       WHERE id = ?`,
    ).run(
      step.templateId ?? null,
      step.name,
      step.description,
      step.mode,
      step.phase || "pre-merge",
      step.gateMode,
      step.prompt,
      step.toolMode ?? null,
      step.scriptName ?? null,
      step.enabled ? 1 : 0,
      step.defaultOn === undefined ? null : step.defaultOn ? 1 : 0,
      step.modelProvider ?? null,
      step.modelId ?? null,
      step.migratedFragmentId ?? null,
      step.updatedAt,
      step.id,
    );
    this.db.bumpLastModified();
    this.workflowStepsCache = null;

    return step;
  }

  /**
   * Delete a workflow step definition.
   * Also removes the ID from any tasks that reference it in enabledWorkflowSteps.
   * @throws Error if the workflow step is not found
   */
  async deleteWorkflowStep(id: string): Promise<void> {
    const deleted = this.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(id) as {
      changes?: number;
    };

    if ((deleted.changes || 0) === 0) {
      throw new Error(`Workflow step '${id}' not found`);
    }

    this.db.bumpLastModified();
    this.workflowStepsCache = null;

    // Clean up references from existing tasks (best-effort, outside config lock)
    try {
      const tasks = await this.listTasks({ slim: true });
      for (const task of tasks) {
        if (task.enabledWorkflowSteps?.includes(id)) {
          const updated = task.enabledWorkflowSteps.filter((wsId) => wsId !== id);
          // Direct task.json mutation for enabledWorkflowSteps cleanup
          await this.withTaskLock(task.id, async () => {
            const dir = this.taskDir(task.id);
            const t = await this.readTaskJson(dir);
            t.enabledWorkflowSteps = updated.length > 0 ? updated : undefined;
            t.updatedAt = new Date().toISOString();
            await this.atomicWriteTaskJson(dir, t);
          });
        }
      }
    } catch {
      // Best-effort: task cleanup is non-critical
    }
  }

  // ── Workflow definitions (named WorkflowIr graphs) ─────────────────────

  /** Allocate the next workflow-definition id (WF-001, WF-002, …) using a
   *  monotonic counter persisted in __meta. Never reuses ids across deletes. */
  private nextWorkflowDefinitionId(): string {
    // Serialize the read+increment in one write transaction so two TaskStore
    // instances cannot both observe the same counter and allocate the same
    // WF-id (which would collide on the workflows primary key).
    return this.db.transactionImmediate(() => {
      const row = this.db.prepare("SELECT value FROM __meta WHERE key = 'nextWorkflowDefinitionId'").get() as
        | { value: string }
        | undefined;
      const next = row ? parseInt(row.value, 10) || 1 : 1;
      this.db
        .prepare(
          "INSERT INTO __meta (key, value) VALUES ('nextWorkflowDefinitionId', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(next + 1));
      return `WF-${String(next).padStart(3, "0")}`;
    });
  }

  private toWorkflowDefinition(row: {
    id: string;
    name: string;
    description: string;
    ir: string;
    layout: string;
    kind?: string | null;
    createdAt: string;
    updatedAt: string;
  }): WorkflowDefinition {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      // Legacy rows (pre-migration-109) have no kind column; default to "workflow".
      kind: row.kind === "fragment" ? "fragment" : "workflow",
      ir: parseWorkflowIr(row.ir),
      layout: this.parseWorkflowLayout(row.layout),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private parseWorkflowLayout(
    raw: string,
  ): Record<string, WorkflowNodeLayout> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, WorkflowNodeLayout>;
      }
    } catch {
      // Corrupt layout JSON falls back to empty (auto-layout) rather than failing the read.
    }
    return {};
  }

  /** Server-side trait-composition validation (residual A). Throws a typed
   *  ColumnTraitValidationError when the IR's columns have save-blocking trait
   *  conflicts, so conflicts reject server-side and not only in the editor. A
   *  v1 IR (no columns) is a no-op. */
  private assertWorkflowIrTraitsValid(ir: WorkflowIr): void {
    const columns = (ir as { columns?: WorkflowIrColumn[] }).columns;
    if (Array.isArray(columns) && columns.length > 0) {
      assertColumnTraitsValid(columns);
    }
  }

  /** Create a named workflow definition. The IR is validated via parseWorkflowIr. */
  async createWorkflowDefinition(
    input: WorkflowDefinitionInput,
  ): Promise<WorkflowDefinition> {
    // Rollback compat (#1405): with the flag OFF, persist a pure-v1-equivalent
    // graph in the v1 shape so a binary downgrade can still load the row.
    const flagOnForCreate = await this.workflowColumnsFlagOn();
    return this.withConfigLock(async () => {
      const name = input.name?.trim();
      if (!name) throw new Error("Workflow name is required");
      // Validate the IR shape up front so we never persist a malformed graph.
      const ir = parseWorkflowIr(input.ir);
      // Residual A: also reject save-blocking trait composition conflicts here,
      // not only in the editor's client-side validation.
      this.assertWorkflowIrTraitsValid(ir);
      const layout = input.layout ?? {};
      const now = new Date().toISOString();
      const id = this.nextWorkflowDefinitionId();
      const definition: WorkflowDefinition = {
        id,
        name,
        description: input.description ?? "",
        // KTD-1: fragments are pure-v1 IRs and pass through downgradeIrToV1IfPure
        // unchanged; default to "workflow" when the caller omits the kind.
        kind: input.kind === "fragment" ? "fragment" : "workflow",
        ir,
        layout,
        createdAt: now,
        updatedAt: now,
      };

      this.db
        .prepare(
          `INSERT INTO workflows (id, name, description, ir, layout, kind, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          definition.id,
          definition.name,
          definition.description,
          serializeWorkflowIr(
            flagOnForCreate ? definition.ir : downgradeIrToV1IfPure(definition.ir),
          ),
          JSON.stringify(definition.layout),
          definition.kind,
          definition.createdAt,
          definition.updatedAt,
        );

      this.workflowDefinitionsCache = null;
      this.db.bumpLastModified();
      return definition;
    });
  }

  /** List workflow definitions, oldest first. The `kind` filter (KTD-1) selects
   *  only workflows or only fragments; omit it to get the full merged set.
   *
   *  Cache invariant: `workflowDefinitionsCache` ALWAYS holds the full merged set
   *  (built-ins + every row of every kind). The `kind` filter is applied to a
   *  slice taken AFTER the cache read — a filtered result is never cached, so a
   *  filtered call can never poison an unfiltered consumer (or vice versa).
   */
  async listWorkflowDefinitions(
    options?: { kind?: WorkflowDefinition["kind"]; includeDisabledBuiltins?: boolean },
  ): Promise<WorkflowDefinition[]> {
    const all = await this.readAllWorkflowDefinitions();
    let enabledBuiltinWorkflowIds: readonly string[] | undefined;
    if (!options?.includeDisabledBuiltins) {
      try {
        const settings = await this.getSettings();
        enabledBuiltinWorkflowIds = Array.isArray(settings.enabledBuiltinWorkflowIds)
          ? settings.enabledBuiltinWorkflowIds
          : undefined;
      } catch {
        enabledBuiltinWorkflowIds = undefined;
      }
    }
    const enabledVisible = options?.includeDisabledBuiltins
      ? all
      : all.filter((wf) => isBuiltinWorkflowEnabled(wf.id, enabledBuiltinWorkflowIds));
    const visible = await Promise.all(
      enabledVisible.map(async (wf) => {
        const requiredPluginId = getRequiredPluginIdForBuiltinWorkflow(wf.id);
        if (!requiredPluginId) return wf;
        return (await this.isPluginInstalled(requiredPluginId)) ? wf : undefined;
      }),
    );
    const pluginFiltered = visible.filter((wf): wf is WorkflowDefinition => Boolean(wf));
    if (options?.kind) return pluginFiltered.filter((wf) => wf.kind === options.kind);
    return pluginFiltered;
  }

  /** Read (and cache) the full merged workflow-definition set, oldest first.
   *  Built-in templates lead the list and cannot be edited/deleted; built-ins
   *  may be selectable workflows or reusable fragments. */
  private async readAllWorkflowDefinitions(): Promise<WorkflowDefinition[]> {
    if (this.workflowDefinitionsCache) return this.workflowDefinitionsCache;
    const rows = this.db.prepare("SELECT * FROM workflows ORDER BY createdAt ASC").all() as Array<{
      id: string;
      name: string;
      description: string;
      ir: string;
      layout: string;
      kind?: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
    this.workflowDefinitionsCache = [...BUILTIN_WORKFLOWS, ...rows.map((row) => this.toWorkflowDefinition(row))];
    return this.workflowDefinitionsCache;
  }

  private applyBuiltInPromptOverridesSync(workflowId: string, ir: WorkflowIr): WorkflowIr {
    if (!isBuiltinWorkflowId(workflowId)) return ir;
    const projectId = this.getWorkflowSettingsProjectId();
    const overrides = this.getWorkflowPromptOverrides(workflowId, projectId);
    return applyPromptOverridesToIr(ir, overrides);
  }

  /** Get a single workflow definition by id, or undefined when absent. */
  async getWorkflowDefinition(
    id: string,
  ): Promise<WorkflowDefinition | undefined> {
    const builtin = getBuiltinWorkflow(id);
    if (builtin) {
      if (isBuiltinWorkflowPluginGated(id)) {
        const requiredPluginId = getRequiredPluginIdForBuiltinWorkflow(id);
        if (!requiredPluginId || !(await this.isPluginInstalled(requiredPluginId))) return undefined;
      }
      return { ...builtin, ir: this.applyBuiltInPromptOverridesSync(id, builtin.ir) };
    }
    const row = this.db.prepare("SELECT * FROM workflows WHERE id = ?").get(id) as
      | {
          id: string;
          name: string;
          description: string;
          ir: string;
          layout: string;
          kind?: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
    return row ? this.toWorkflowDefinition(row) : undefined;
  }

  /** Update a workflow definition. The IR (when supplied) is re-validated. */
  async updateWorkflowDefinition(
    id: string,
    updates: WorkflowDefinitionUpdate,
  ): Promise<WorkflowDefinition> {
    if (isBuiltinWorkflowId(id)) throw new Error("Built-in workflows cannot be edited");
    // U5 (R20): flag-ON edits that remove an occupied column block with a typed
    // OccupiedColumnsError unless `rehomeTo` is supplied. Computed before taking
    // the config lock (pure DB reads) so the lock body stays focused.
    const flagOn = await this.workflowColumnsFlagOn();
    let pendingRehome: { rehomeTo: string; occupantTaskIds: string[] } | undefined;
    if (flagOn && updates.ir !== undefined) {
      const existingForCheck = await this.getWorkflowDefinition(id);
      if (!existingForCheck) throw new Error(`Workflow '${id}' not found`);
      const nextIrForCheck = parseWorkflowIr(updates.ir);
      const occupantsByColumn = this.occupantsByColumnForWorkflow(id, false);
      const removed = computeRemovedOccupiedColumns(
        existingForCheck.ir,
        nextIrForCheck,
        occupantsByColumn,
      );
      if (removed.length > 0) {
        if (updates.rehomeTo === undefined) {
          throw new OccupiedColumnsError(id, removed);
        }
        assertRehomeTargetValid(nextIrForCheck, updates.rehomeTo);
        // Collect the occupant task ids of the removed columns to re-home AFTER
        // the IR save commits, so the cards land in a column the new IR defines.
        const removedSet = new Set(removed.map((r) => r.columnId));
        const occupantTaskIds = this.listWorkflowOccupantTaskIds(id, false).filter((taskId) => {
          const row = this.db.prepare(`SELECT "column" AS column FROM tasks WHERE id = ?`).get(taskId) as
            | { column: string }
            | undefined;
          return row ? removedSet.has(row.column) : false;
        });
        pendingRehome = { rehomeTo: updates.rehomeTo, occupantTaskIds };
      }
    }

    // U11/KTD-13: when the IR changes custom field types incompatibly for tasks
    // that already hold values, block with a typed IncompatibleFieldChangeError
    // unless `coerce` is supplied. Removed/added fields never block (removal
    // orphans). Flag-independent: fields are orthogonal to the columns flag.
    // Reconciliation runs per occupant task AFTER the IR save commits.
    let pendingFieldReconcile:
      | { oldFields: WorkflowFieldDefinition[]; newFields: WorkflowFieldDefinition[]; occupantTaskIds: string[]; coerce?: "drop" | "keep-orphaned" }
      | undefined;
    if (updates.ir !== undefined) {
      const existingForFields = await this.getWorkflowDefinition(id);
      if (!existingForFields) throw new Error(`Workflow '${id}' not found`);
      const nextIrForFields = parseWorkflowIr(updates.ir);
      const oldFields: WorkflowFieldDefinition[] =
        existingForFields.ir.version === "v2" ? (existingForFields.ir.fields ?? []) : [];
      const newFields: WorkflowFieldDefinition[] =
        nextIrForFields.version === "v2" ? (nextIrForFields.fields ?? []) : [];
      const fieldsChanged =
        JSON.stringify(oldFields) !== JSON.stringify(newFields);
      if (fieldsChanged) {
        const occupantTaskIds = this.listWorkflowOccupantTaskIds(id, false);
        const occupantsByField = new Map<string, number>();
        for (const taskId of occupantTaskIds) {
          const row = this.db.prepare("SELECT customFields FROM tasks WHERE id = ?").get(taskId) as
            | { customFields: string | null }
            | undefined;
          const values = row?.customFields
            ? (fromJson<Record<string, unknown>>(row.customFields) ?? {})
            : {};
          // Incompatible-change detection only blocks on occupants that already
          // HOLD a value for a field, so count only those. Reconciliation itself
          // must still touch every occupant so new required+default fields get
          // backfilled onto tasks that currently have no custom field values.
          if (Object.keys(values).length === 0) continue;
          for (const key of Object.keys(values)) {
            occupantsByField.set(key, (occupantsByField.get(key) ?? 0) + 1);
          }
        }
        const incompatible = computeIncompatibleFieldChanges(
          existingForFields.ir,
          nextIrForFields,
          occupantsByField,
        );
        if (incompatible.length > 0 && updates.coerce === undefined) {
          throw new IncompatibleFieldChangeError(id, incompatible);
        }
        pendingFieldReconcile = {
          oldFields,
          newFields,
          occupantTaskIds,
          coerce: updates.coerce,
        };
      }
    }
    const saved = await this.withConfigLock(async () => {
      const existing = await this.getWorkflowDefinition(id);
      if (!existing) throw new Error(`Workflow '${id}' not found`);

      const name = updates.name !== undefined ? updates.name.trim() : existing.name;
      if (!name) throw new Error("Workflow name is required");
      const ir = updates.ir !== undefined ? parseWorkflowIr(updates.ir) : existing.ir;
      // Residual A: reject save-blocking trait composition conflicts server-side
      // when the IR is being changed.
      if (updates.ir !== undefined) this.assertWorkflowIrTraitsValid(ir);
      const next: WorkflowDefinition = {
        ...existing,
        name,
        description: updates.description !== undefined ? updates.description : existing.description,
        ir,
        layout: updates.layout !== undefined ? updates.layout : existing.layout,
        updatedAt: new Date().toISOString(),
      };

      this.db
        .prepare(
          `UPDATE workflows SET name = ?, description = ?, ir = ?, layout = ?, updatedAt = ? WHERE id = ?`,
        )
        .run(
          next.name,
          next.description,
          // Rollback compat (#1405): persist v1 shape when pure and flag OFF.
          serializeWorkflowIr(flagOn ? next.ir : downgradeIrToV1IfPure(next.ir)),
          JSON.stringify(next.layout),
          next.updatedAt,
          id,
        );

      this.workflowDefinitionsCache = null;
      this.db.bumpLastModified();
      return next;
    });

    // U5 (R20): now that the new IR is committed, re-home the occupants of the
    // removed columns into `rehomeTo` (one audit event per card). Done outside
    // the config lock; each rehome takes its own task lock via moveTask.
    if (pendingRehome) {
      for (const taskId of pendingRehome.occupantTaskIds) {
        await this.rehomeOccupant(taskId, pendingRehome.rehomeTo, "workflow-edit-rehome", {
          workflowId: id,
        });
      }
    }

    // U11/KTD-13: now that the new field schema is committed, reconcile each
    // occupant task's stored values against it (orphan-not-delete by default;
    // coerce:"drop" discards orphans). Each runs under its own task lock.
    if (pendingFieldReconcile) {
      const dropOrphans = pendingFieldReconcile.coerce === "drop";
      for (const taskId of pendingFieldReconcile.occupantTaskIds) {
        await this.withTaskLock(taskId, () =>
          this.reconcileTaskCustomFieldsForSchema(
            taskId,
            pendingFieldReconcile!.oldFields,
            pendingFieldReconcile!.newFields,
            dropOrphans,
          ),
        );
      }
    }
    return saved;
  }

  /** Delete a workflow definition, cascading to per-task selections, their
   *  materialized step rows, and the project default. Throws when the id does
   *  not exist. */
  async deleteWorkflowDefinition(id: string): Promise<void> {
    if (isBuiltinWorkflowId(id)) throw new Error("Built-in workflows cannot be deleted");
    // U5 (R20): flag-ON, capture the occupant task ids BEFORE the cascade clears
    // their selection rows, so we can re-home them to the DEFAULT workflow's
    // entry column once their selection resolves back to the default (KTD-1).
    const flagOn = await this.workflowColumnsFlagOn();
    const occupantTaskIds = flagOn ? this.listWorkflowOccupantTaskIds(id, false) : [];
    const deleted = this.db.prepare("DELETE FROM workflows WHERE id = ?").run(id) as { changes?: number };
    if ((deleted.changes || 0) === 0) {
      throw new Error(`Workflow '${id}' not found`);
    }
    this.workflowDefinitionsCache = null;

    // Cascade (KTD-9): delete this workflow's setting-value rows across all
    // projects. Tasks pinned to the deleted workflow degrade to `builtin:coding`
    // via the resolver and read built-in declarations + built-in values, so no
    // unreachable orphan value rows remain.
    this.db.prepare("DELETE FROM workflow_settings WHERE workflowId = ?").run(id);
    this.db.prepare("DELETE FROM workflow_prompt_overrides WHERE workflowId = ?").run(id);

    // Cascade: clear the project default when it pointed at this workflow.
    try {
      if ((await this.getDefaultWorkflowId()) === id) {
        await this.setDefaultWorkflowId(null);
      }
    } catch {
      // Best-effort: a dangling default falls back gracefully at task creation.
    }

    // Cascade: drop selections referencing this workflow, their materialized
    // step rows, and reset the affected tasks' enabled steps.
    const selections = this.db
      .prepare("SELECT taskId, stepIds FROM task_workflow_selection WHERE workflowId = ?")
      .all(id) as Array<{ taskId: string; stepIds: string }>;
    for (const row of selections) {
      try {
        const stepIds = JSON.parse(row.stepIds) as unknown;
        if (Array.isArray(stepIds)) {
          for (const stepId of stepIds) {
            if (typeof stepId === "string") {
              this.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
            }
          }
        }
      } catch {
        // Corrupt stepIds list — still remove the selection row below.
      }
      this.db.prepare("DELETE FROM task_workflow_selection WHERE taskId = ?").run(row.taskId);
      try {
        await this.updateTask(row.taskId, { enabledWorkflowSteps: [] });
      } catch {
        // Task may be deleted/archived; dangling step ids resolve to undefined
        // at execution time and are skipped.
      }
    }
    if (selections.length > 0) this.workflowStepsCache = null;
    this.db.bumpLastModified();

    // U5 (R20) delete reconciliation: re-home each occupant to the default
    // workflow's entry column. Their selection rows are already cleared above,
    // so they now resolve to the built-in default workflow (KTD-1); the re-home
    // move preserves task fields (preserveProgress) and emits one audit per card.
    if (flagOn && occupantTaskIds.length > 0) {
      const defaultEntry = resolveEntryColumnId(BUILTIN_CODING_WORKFLOW_IR);
      if (defaultEntry) {
        for (const taskId of occupantTaskIds) {
          await this.rehomeOccupant(taskId, defaultEntry, "workflow-delete", { workflowId: id });
        }
      }
    }
  }

  // ── U5: workflow lifecycle reconciliation (switch / edit / delete) ──────────
  //
  // These helpers are only consulted when the `workflowColumns` flag is ON; the
  // flag-OFF CRUD paths above keep their exact current behavior. Re-homing moves
  // always route through `moveTask` with `moveSource: "engine"` + `bypassGuards`
  // (a recovery-class move, KTD-9) — never a raw column write — so capacity
  // (KTD-10) and the single transition authority (KTD-3) are honored.

  /** True when the raw `workflowColumns` compatibility flag is ON (merged global + project). */
  private async workflowColumnsFlagOn(): Promise<boolean> {
    return isWorkflowColumnsCompatibilityFlagEnabled(await this.getSettingsFast());
  }

  /** The active (non-deleted) task ids currently selecting `workflowId`. A
   *  built-in/default workflow additionally owns every task with NO selection
   *  row (null selection resolves to the default workflow, KTD-1). */
  private listWorkflowOccupantTaskIds(workflowId: string, includeNullSelection: boolean): string[] {
    const ids: string[] = [];
    const selected = this.db
      .prepare(
        `SELECT s.taskId AS taskId FROM task_workflow_selection s
           JOIN tasks t ON t.id = s.taskId
          WHERE s.workflowId = ? AND t."deletedAt" IS NULL`,
      )
      .all(workflowId) as Array<{ taskId: string }>;
    for (const row of selected) ids.push(row.taskId);
    if (includeNullSelection) {
      const unselected = this.db
        .prepare(
          `SELECT t.id AS id FROM tasks t
            WHERE t."deletedAt" IS NULL
              AND NOT EXISTS (SELECT 1 FROM task_workflow_selection s WHERE s.taskId = t.id)`,
        )
        .all() as Array<{ id: string }>;
      for (const row of unselected) ids.push(row.id);
    }
    return ids;
  }

  /** Map column id → occupant count for the tasks selecting `workflowId`
   *  (plus null-selection tasks when `includeNullSelection`). */
  private occupantsByColumnForWorkflow(
    workflowId: string,
    includeNullSelection: boolean,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const taskId of this.listWorkflowOccupantTaskIds(workflowId, includeNullSelection)) {
      const row = this.db.prepare(`SELECT "column" AS column FROM tasks WHERE id = ?`).get(taskId) as
        | { column: string }
        | undefined;
      if (!row) continue;
      counts.set(row.column, (counts.get(row.column) ?? 0) + 1);
    }
    return counts;
  }

  /** Re-home a single occupant to `targetColumn` via an engine-sourced,
   *  guard-bypassing recovery move, aborting in-flight work first, and emit one
   *  audit event. Best-effort per card: a failure is audited and skipped so one
   *  stuck card never blocks the rest of the batch. */
  private async rehomeOccupant(
    taskId: string,
    targetColumn: string,
    reason: "workflow-switch" | "workflow-delete" | "workflow-edit-rehome",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const current = this.readTaskFromDb(taskId, { includeDeleted: false });
    if (!current) return;
    const fromColumn = current.column;
    if (fromColumn === targetColumn) {
      // Already in the target column — nothing to move, but still record the
      // reconciliation decision for audit traceability.
      this.recordRunAuditEvent({
        taskId,
        agentId: "system",
        runId: `workflow-reconcile-${reason}-${taskId}-${Date.now()}`,
        domain: "database",
        mutationType: "task:workflow-reconcile",
        target: taskId,
        metadata: { ...metadata, reason, fromColumn, toColumn: targetColumn, moved: false },
      });
      return;
    }
    const abortRan = await runReconciliationAbort({ taskId, fromColumn, reason });
    let moved = false;
    let error: string | undefined;
    try {
      // Recovery-class move: engine source + bypassGuards (KTD-9). preserveProgress
      // keeps the task's fields intact (R20 delete semantics). Capacity (KTD-10) is
      // NOT bypassed — a full target column rejects, which we audit and skip.
      await this.moveTask(taskId, targetColumn, {
        moveSource: "engine",
        bypassGuards: true,
        recoveryRehome: true,
        preserveProgress: true,
        preserveResumeState: true,
        preserveWorktree: true,
        allowDirectInReviewMove: true,
      });
      moved = true;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    this.recordRunAuditEvent({
      taskId,
      agentId: "system",
      runId: `workflow-reconcile-${reason}-${taskId}-${Date.now()}`,
      domain: "database",
      mutationType: "task:workflow-reconcile",
      target: taskId,
      metadata: { ...metadata, reason, fromColumn, toColumn: targetColumn, abortRan, moved, error },
    });
  }

  // ── U12: workflow-columns integrity pass ──────────────────────────────────
  //
  // Migration rewrites ZERO task rows (KTD-1): a null selection resolves to the
  // built-in default workflow at read time, and the default workflow's column
  // IDs are byte-identical to the legacy enum values, so every legacy row is
  // already valid. The only residual risk is a task whose stored column is not a
  // valid column in its RESOLVED workflow — e.g. a custom workflow was edited to
  // drop a column out-of-band, or a legacy row references a column the selected
  // custom workflow never defined. The integrity pass audits those and re-homes
  // them via the U5 reconciliation path (`recoveryRehome`, guard-bypassing,
  // capacity-honoring), one audit event per card.
  //
  // Idempotent: a second run finds nothing out-of-place (the re-home lands the
  // card in a valid column) and is a pure no-op. Tasks in complete- or
  // archived-flagged columns are left UNTOUCHED (done/archived cards are terminal
  // — re-homing them would corrupt the board) even if (defensively) their column
  // were somehow not in the resolved IR; we never disturb terminal cards.
  //
  // Runs only when the `workflowColumns` flag is ON (flag-OFF keeps the legacy
  // enum path, where every column is valid by construction).
  async runWorkflowColumnsIntegrityPass(): Promise<{ scanned: number; rehomed: number; skippedTerminal: number }> {
    let scanned = 0;
    let rehomed = 0;
    let skippedTerminal = 0;

    const rows = this.db
      .prepare(`SELECT id FROM tasks WHERE "deletedAt" IS NULL`)
      .all() as Array<{ id: string }>;

    const registry = getTraitRegistry();

    for (const { id } of rows) {
      scanned += 1;
      const task = this.readTaskFromDb(id, { includeDeleted: false });
      if (!task) continue;
      const ir = this.resolveTaskWorkflowIrSync(id);
      const currentColumn = task.column;

      // Already valid in its resolved workflow — nothing to do (the common case;
      // this is why the pass is idempotent and a no-op for healthy DBs).
      if (workflowHasColumn(ir, currentColumn)) continue;

      // The stored column is not in the resolved workflow. Before re-homing,
      // never disturb a terminal card: if the column the card sits in carries a
      // complete/archived flag in its workflow it is terminal — but since the
      // column is NOT in the IR we cannot read its flags there. Fall back to the
      // legacy terminal semantics (done/archived) so terminal cards are never
      // re-homed, matching the plan's "done/archived untouched" rule.
      const column = findWorkflowColumn(ir, currentColumn);
      const flags = column ? registry.resolveColumnFlags(column) : undefined;
      const isTerminal =
        flags?.complete === true ||
        flags?.archived === true ||
        currentColumn === "done" ||
        currentColumn === "archived";
      if (isTerminal) {
        skippedTerminal += 1;
        continue;
      }

      const targetColumn = resolveEntryColumnId(ir);
      if (!targetColumn) continue; // non-reconcilable IR — leave the card put.

      await this.rehomeOccupant(id, targetColumn, "workflow-edit-rehome", {
        integrityPass: true,
        invalidColumn: currentColumn,
      });
      rehomed += 1;
    }

    if (rehomed > 0 || skippedTerminal > 0) {
      storeLog.log("workflowColumns integrity pass completed", {
        phase: "init:workflow-columns-integrity",
        scanned,
        rehomed,
        skippedTerminal,
      });
    }
    return { scanned, rehomed, skippedTerminal };
  }

  // ── #1401: transitionPending recovery sweep ───────────────────────────────
  //
  // A crash between the in-txn `transitionPending` marker write and the
  // post-commit `clearTransitionPending` leaves the marker set forever. Because
  // `countActiveInCapacitySlotSync` counts a pending marker as occupying a
  // capacity slot for its `toColumn`, a stale marker permanently inflates that
  // (workflow, column) capacity count. This sweep is the backstop the comments
  // across store.ts / merge-trait.ts / transition-pending.ts reference: it scans
  // every task carrying a non-null marker, reconciles `hooksRemaining` against
  // the currently-known hook set, re-runs the surviving idempotent post-commit
  // hooks via the same runner the live path uses, audits the recovery, and
  // clears the marker so the reserved capacity slot is released.
  //
  // Idempotent: the default-workflow field effects already committed in-lock, so
  // re-running them is a no-op, and a second sweep finds no markers. Plugin hooks
  // are re-derived from the resolved IR (so an uninstalled-plugin hook simply
  // drops, surfaced as an audit warning) and are expected to be idempotent per
  // KTD-2. Runs at store init (alongside the integrity pass) and periodically
  // from the flag-ON sweep cadence.
  async recoverStaleTransitionPending(): Promise<{ scanned: number; recovered: number; degradedHooks: number }> {
    let scanned = 0;
    let recovered = 0;
    let degradedHooks = 0;

    const rows = this.db
      .prepare(
        `SELECT id FROM tasks WHERE transitionPending IS NOT NULL AND transitionPending != '' AND deletedAt IS NULL`,
      )
      .all() as Array<{ id: string }>;

    // The set of hook ids the current process can still honor: the always-present
    // default-workflow post-commit marker plus every registered plugin trait's
    // onEnter/onExit hook. A marker entry not in this set belongs to an
    // uninstalled plugin and is dropped (audited) rather than re-run.
    const registry = getTraitRegistry();
    const knownHookIds = new Set<string>(["default-workflow:postCommit"]);
    for (const def of registry.listTraits()) {
      if (def.hooks?.onEnter) knownHookIds.add(`${def.id}:onEnter`);
      if (def.hooks?.onExit) knownHookIds.add(`${def.id}:onExit`);
    }

    for (const { id } of rows) {
      scanned += 1;
      const marker = readTransitionPending(this.db, id);
      // null = nothing pending (corrupt/empty marker degrades to settled); we
      // still clear the stored column so the slot is released. undefined = row
      // vanished mid-sweep — skip.
      if (marker === undefined) continue;

      await this.withTaskLock(id, async () => {
        // Re-read inside the lock: another path may have cleared it already.
        const live = readTransitionPending(this.db, id);
        if (live == null) {
          // Corrupt/empty marker — clear the stored value defensively so it stops
          // counting against capacity, then move on.
          if (live === null) {
            try {
              clearTransitionPending(this.db, id);
            } catch {
              // best-effort
            }
          }
          return;
        }

        const { hooksRemaining, warnings } = reconcileHooksRemaining(live.hooksRemaining, knownHookIds);
        degradedHooks += warnings.length;

        // Re-run the surviving idempotent post-commit hooks. The default-workflow
        // field effects already committed in-lock pre-crash, so the only work that
        // can still be owed is the plugin trait hook runner, which re-derives its
        // pending set from the resolved IR and is idempotent (KTD-2). We invoke it
        // only when a plugin hook entry survived (a marker carrying just
        // `default-workflow:postCommit` needs no re-run — just a clear).
        const hasSurvivingPluginHook = hooksRemaining.some((h) => h !== "default-workflow:postCommit");
        if (hasSurvivingPluginHook) {
          const task = this.readTaskFromDb(id, { includeDeleted: false });
          if (task) {
            const ir = this.resolveTaskWorkflowIrSync(id);
            // fromColumn is unknown post-crash; the marker only records toColumn.
            // The hook runner keys onEnter off toColumn (and onExit off fromColumn);
            // re-running onEnter for the destination is the recoverable, idempotent
            // half. Use the task's current column as fromColumn (it committed to
            // toColumn at marker-write time, so current == toColumn and onExit is a
            // no-op, which is correct — we never re-fire an exit we may have run).
            try {
              await this.runPluginColumnTransitionHooks(id, ir, task.column, live.toColumn);
            } catch (err) {
              storeLog.warn("transitionPending recovery: hook re-run faulted (degraded)", {
                phase: "recover-stale-transition-pending",
                taskId: id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        for (const warning of warnings) {
          storeLog.warn(warning, {
            phase: "recover-stale-transition-pending",
            taskId: id,
          });
        }

        // Clear the marker — releases the reserved capacity slot.
        try {
          clearTransitionPending(this.db, id);
        } catch {
          // best-effort; a later sweep retries.
        }

        this.recordRunAuditEvent({
          taskId: id,
          agentId: "system",
          runId: `transition-pending-recovery-${id}-${Date.now()}`,
          domain: "database",
          mutationType: "task:transition-pending-recovered",
          target: id,
          metadata: {
            toColumn: live.toColumn,
            hooksReran: hooksRemaining,
            droppedHooks: warnings.length,
            startedAt: live.startedAt,
          },
        });
        recovered += 1;
      });
    }

    if (recovered > 0 || degradedHooks > 0) {
      storeLog.log("transitionPending recovery sweep completed", {
        phase: "recover-stale-transition-pending",
        scanned,
        recovered,
        degradedHooks,
      });
    }
    return { scanned, recovered, degradedHooks };
  }

  // ── #1409: flag ON→OFF evacuation ─────────────────────────────────────────
  //
  // When `workflowColumns` is disabled (or at flag-OFF store init), the board
  // reverts to the legacy enum/`VALID_TRANSITIONS` path, where only the legacy
  // {@link COLUMNS} are valid. Any card sitting in a CUSTOM (non-legacy) column
  // would be stuck: it can't be listed/moved through the legacy path. This pass
  // detects those cards and re-homes each to the nearest legacy column — the
  // default workflow's entry column (`todo`) — via the existing recovery-rehome
  // path (engine source + bypassGuards + recoveryRehome, capacity-honoring),
  // auditing one event per card. Terminal cards (done/archived) are left put.
  //
  // Idempotent: a second run finds every card in a legacy column and is a no-op.
  async evacuateCustomColumnsToLegacy(
    trigger: "flag-off-init" | "flag-toggled-off",
  ): Promise<{ scanned: number; evacuated: number }> {
    let scanned = 0;
    let evacuated = 0;

    const legacyColumns = new Set<string>(COLUMNS);
    // Nearest legacy landing column: the default workflow's entry column
    // (triage). Falls back to "triage" defensively if the IR can't be resolved.
    const targetColumn = resolveEntryColumnId(BUILTIN_CODING_WORKFLOW_IR) ?? "triage";

    const rows = this.db
      .prepare(`SELECT id, "column" AS col FROM tasks WHERE deletedAt IS NULL`)
      .all() as Array<{ id: string; col: string }>;

    for (const { id, col } of rows) {
      scanned += 1;
      // Already in a legacy column (the common case) — nothing to evacuate.
      if (legacyColumns.has(col)) continue;
      // Never disturb terminal cards (legacy terminal semantics — these column
      // ids are never legacy here, but guard defensively for parity with the
      // integrity pass).
      if (col === "done" || col === "archived") continue;

      await this.rehomeOccupant(id, targetColumn, "workflow-edit-rehome", {
        evacuation: true,
        trigger,
        invalidColumn: col,
      });
      evacuated += 1;
    }

    if (evacuated > 0) {
      storeLog.log("workflowColumns ON→OFF evacuation completed", {
        phase: "evacuate-custom-columns",
        trigger,
        scanned,
        evacuated,
      });
    }
    return { scanned, evacuated };
  }

  // ── Workflow selection (resolves a workflow to enabledWorkflowSteps) ────
  //
  // Selection never touches the engine's scheduler/executor/merger. It compiles
  // a workflow into WorkflowStep rows and writes their ids into the task's
  // existing `enabledWorkflowSteps`, which the executor already consumes.

  /** The configured project-default workflow id, or undefined when unset. */
  async getDefaultWorkflowId(): Promise<string | undefined> {
    const settings = await this.getSettingsFast();
    const id = (settings as { defaultWorkflowId?: string }).defaultWorkflowId;
    return id && id.trim() ? id : undefined;
  }

  /** Set (or clear, with null) the project-default workflow. */
  async setDefaultWorkflowId(workflowId: string | null): Promise<void> {
    if (workflowId) {
      const exists = await this.getWorkflowDefinition(workflowId);
      if (!exists) throw new Error(`Workflow '${workflowId}' not found`);
      // KTD-1/R6: a fragment is a reusable palette piece, not a selectable
      // workflow. Reject it at the write boundary so a fragment can never be
      // persisted as the project default (the read-side skip in
      // materializeDefaultWorkflowSteps remains as defense in depth).
      if (exists.kind === "fragment") {
        throw new Error(`Workflow '${workflowId}' is a fragment and cannot be set as the project default`);
      }
    }
    // null is updateSettings' explicit-delete sentinel for project keys.
    await this.updateSettings({ defaultWorkflowId: workflowId } as unknown as Partial<Settings>);
  }

  /**
   * Synchronous workflow-definition insert used by migration (U2/KTD-3). Mirrors
   * the persistence side of `createWorkflowDefinition` (validation + flag-aware
   * downgrade + INSERT + cache bust) but stays synchronous so it can run inside
   * `transactionImmediate`. The flag value is resolved by the async caller and
   * passed in, since reading it is async.
   */
  private insertWorkflowDefinitionSync(
    input: WorkflowDefinitionInput,
    flagOn: boolean,
  ): WorkflowDefinition {
    const name = input.name?.trim();
    if (!name) throw new Error("Workflow name is required");
    const ir = parseWorkflowIr(input.ir);
    this.assertWorkflowIrTraitsValid(ir);
    const layout = input.layout ?? {};
    const now = new Date().toISOString();
    const id = this.nextWorkflowDefinitionId();
    const definition: WorkflowDefinition = {
      id,
      name,
      description: input.description ?? "",
      kind: input.kind === "fragment" ? "fragment" : "workflow",
      ir,
      layout,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, description, ir, layout, kind, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        definition.id,
        definition.name,
        definition.description,
        serializeWorkflowIr(flagOn ? definition.ir : downgradeIrToV1IfPure(definition.ir)),
        JSON.stringify(definition.layout),
        definition.kind,
        definition.createdAt,
        definition.updatedAt,
      );
    this.workflowDefinitionsCache = null;
    return definition;
  }

  /**
   * Lazy, idempotent migration of legacy user-authored workflow steps into the
   * dual workflow-definition representation (U2 / R5 / KTD-3). Runs on first
   * editor open per project via `POST /api/workflows/migrate-legacy-steps`.
   *
   * Policy:
   *  - Every unmigrated user step (enabled or not, excluding compiled-materialized
   *    rows) becomes a `kind: "fragment"` definition — the reusable palette piece.
   *  - The `defaultOn` subset additionally becomes ONE combined `kind: "workflow"`
   *    definition named "Migrated steps" (these were the steps that ran
   *    automatically on new tasks); when non-empty and no project default is
   *    already set, it becomes the project default so new-task behavior is
   *    preserved. An explicit existing default is never clobbered.
   *  - Each source row is stamped with `migratedFragmentId` (idempotency marker).
   *    Source rows are never deleted.
   *
   * Idempotency: the unmigrated-rows SELECT and the marker stamping happen inside
   * a single `transactionImmediate` (write lock acquired BEFORE the SELECT,
   * matching `selectTaskWorkflow`'s ordering rationale), so concurrent opens /
   * re-runs converge to a single set of definitions. A second run sees zero
   * unmigrated rows and returns `{ migrated: 0, skipped: n }`.
   */
  async migrateLegacyWorkflowSteps(): Promise<{
    migrated: number;
    skipped: number;
    combinedWorkflowId?: string;
  }> {
    // Resolve async prerequisites BEFORE the synchronous transaction: the
    // workflow-columns flag (for flag-aware persistence). The project default is
    // re-read AFTER the transaction (compare-and-set) so a concurrently-set
    // default is never clobbered.
    const flagOn = await this.workflowColumnsFlagOn();

    const result = this.db.transactionImmediate(() => {
      // Write lock is now held. Read the raw step rows directly (the cached,
      // plugin-merged listWorkflowSteps() is not transaction-scoped). Mirror
      // listWorkflowSteps()'s compiled-materialized filter and toStoredWorkflowStep
      // mapping so policy decisions match the user-facing step listing.
      const rows = this.db
        .prepare("SELECT * FROM workflow_steps ORDER BY createdAt ASC")
        .all() as Array<Parameters<typeof this.toStoredWorkflowStep>[0]>;

      const userSteps = rows
        .map((row) => this.applyLegacyWorkflowStepOverrides(this.toStoredWorkflowStep(row)))
        // Compiled-materialized rows are an execution detail, not user-authored.
        .filter((step) => !step.templateId?.startsWith(WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX));

      const alreadyMigrated = userSteps.filter((s) => s.migratedFragmentId);
      const unmigrated = userSteps.filter((s) => !s.migratedFragmentId);

      if (unmigrated.length === 0) {
        return { migrated: 0, skipped: alreadyMigrated.length, combinedWorkflowId: undefined as string | undefined };
      }

      // Every unmigrated user step → a single-node fragment; stamp the source row.
      for (const step of unmigrated) {
        // parseWorkflowIr runs inside both insertWorkflowDefinitionSync and
        // layoutForIr, so compute the fragment IR once and reuse it.
        const fragmentIr = stepToFragmentIr(step);
        const fragment = this.insertWorkflowDefinitionSync(
          {
            name: step.name,
            description: step.description,
            kind: "fragment",
            ir: fragmentIr,
            layout: layoutForIr(fragmentIr),
          },
          flagOn,
        );
        this.db
          .prepare("UPDATE workflow_steps SET migrated_fragment_id = ?, updatedAt = ? WHERE id = ?")
          .run(fragment.id, new Date().toISOString(), step.id);
      }
      this.workflowStepsCache = null;
      this.db.bumpLastModified();

      // The defaultOn subset → one combined "Migrated steps" workflow.
      const defaultOnSteps = unmigrated.filter((s) => s.defaultOn === true);
      let combinedWorkflowId: string | undefined;
      if (defaultOnSteps.length > 0) {
        const ir = stepsToWorkflowIr(defaultOnSteps, "Migrated steps");
        const combined = this.insertWorkflowDefinitionSync(
          {
            name: "Migrated steps",
            description: "Converted from your legacy workflow steps",
            kind: "workflow",
            ir,
            layout: layoutForIr(ir),
          },
          flagOn,
        );
        combinedWorkflowId = combined.id;
      }

      return { migrated: unmigrated.length, skipped: alreadyMigrated.length, combinedWorkflowId };
    });

    // Set the combined workflow as the project default — only when one was
    // created AND no explicit default is already set (don't clobber a user
    // choice). Done outside the transaction via the async setter so the project
    // default-workflow hooks run. Compare-and-set against the CURRENT default
    // (re-read immediately before writing, not the pre-transaction snapshot) so
    // a default set concurrently by another writer is never overwritten. If the
    // set fails, swallow the error: a missing migrated default is recoverable
    // (the user can set one), but throwing here would surface the whole
    // migration as failed even though the definitions were written.
    if (result.combinedWorkflowId) {
      const currentDefaultId = await this.getDefaultWorkflowId();
      if (!currentDefaultId) {
        try {
          await this.setDefaultWorkflowId(result.combinedWorkflowId);
        } catch (err) {
          storeLog.warn("Failed to set migrated combined workflow as project default", {
            phase: "migrateLegacyWorkflowSteps:set-default",
            combinedWorkflowId: result.combinedWorkflowId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return result;
  }

  /** Whether a raw workflow CLI command has been approved (trust-on-first-use).
   *  Comparison is on the exact trimmed command string. */
  async isWorkflowCliCommandApproved(command: string): Promise<boolean> {
    const trimmed = command.trim();
    if (!trimmed) return false;
    const settings = await this.getSettings();
    const approved = (settings as { approvedWorkflowCliCommands?: string[] }).approvedWorkflowCliCommands;
    return Array.isArray(approved) && approved.includes(trimmed);
  }

  /** Record approval for a raw workflow CLI command. Idempotent. */
  async approveWorkflowCliCommand(command: string): Promise<void> {
    const trimmed = command.trim();
    if (!trimmed) throw new Error("CLI command is required");
    const settings = await this.getSettings();
    const approved = (settings as { approvedWorkflowCliCommands?: string[] }).approvedWorkflowCliCommands ?? [];
    if (approved.includes(trimmed)) return;
    await this.updateSettings({
      approvedWorkflowCliCommands: [...approved, trimmed],
    } as unknown as Partial<Settings>);
  }

  /** Whether a CLI-agent adapter has been approved for ELEVATED autonomy in this
   *  project (CLI Agent Executor, U15). Mirrors the raw-command approval
   *  precedent; approval is per-project + per-adapter and stored in project
   *  settings (`approvedCliAutonomyAdapters`). */
  async isCliAutonomyApproved(adapterId: string): Promise<boolean> {
    const trimmed = adapterId.trim();
    if (!trimmed) return false;
    const settings = await this.getSettings();
    const approved = (settings as { approvedCliAutonomyAdapters?: string[] }).approvedCliAutonomyAdapters;
    return Array.isArray(approved) && approved.includes(trimmed);
  }

  /** Record approval for elevated CLI-agent autonomy for an adapter. Idempotent.
   *  The approving principal in v1 is the daemon-token holder (route-level). */
  async approveCliAutonomy(adapterId: string): Promise<void> {
    const trimmed = adapterId.trim();
    if (!trimmed) throw new Error("Adapter id is required");
    const settings = await this.getSettings();
    const approved = (settings as { approvedCliAutonomyAdapters?: string[] }).approvedCliAutonomyAdapters ?? [];
    if (approved.includes(trimmed)) return;
    await this.updateSettings({
      approvedCliAutonomyAdapters: [...approved, trimmed],
    } as unknown as Partial<Settings>);
  }

  /** Revoke a previously-granted elevated-autonomy approval. Idempotent. */
  async revokeCliAutonomy(adapterId: string): Promise<void> {
    const trimmed = adapterId.trim();
    if (!trimmed) return;
    const settings = await this.getSettings();
    const approved = (settings as { approvedCliAutonomyAdapters?: string[] }).approvedCliAutonomyAdapters ?? [];
    if (!approved.includes(trimmed)) return;
    await this.updateSettings({
      approvedCliAutonomyAdapters: approved.filter((a) => a !== trimmed),
    } as unknown as Partial<Settings>);
  }

  /** List adapters approved for elevated autonomy in this project. */
  async listApprovedCliAutonomyAdapters(): Promise<string[]> {
    const settings = await this.getSettings();
    const approved = (settings as { approvedCliAutonomyAdapters?: string[] }).approvedCliAutonomyAdapters;
    return Array.isArray(approved) ? [...approved] : [];
  }

  /** Read the workflow currently selected for a task, if any. */
  /**
   * Synchronously resolve the parsed WorkflowIr that governs a task's columns
   * (U4, flag-ON path). Resolution order:
   *   1. the task's workflow selection (side table) → that workflow's IR;
   *   2. null/missing selection → the built-in default workflow IR (KTD-1).
   * Built-in workflow IRs are resolved from the parsed module constant; custom
   * workflows are read + parsed from the `workflows` row. Pure DB read, safe to
   * call inside `withTaskLock` (no further locks taken). A parse failure or
   * missing custom row falls back to the default workflow so a move is never
   * stranded by a corrupt definition (degraded, not crashed).
   */
  /**
   * U8 (KTD-2): record a pre-evaluated plugin gate verdict for a move into
   * `toColumn`. Called by the engine's plugin trait adapter AFTER it evaluated
   * the gate (prompt/script) outside the task lock. The flag-ON guard site in
   * `moveTaskInternal` re-checks the recorded verdict in-lock. Verdicts are
   * consumed (cleared) by `consumePluginGateVerdicts` once read so a stale
   * verdict can't silently re-authorize a later move.
   */
  recordPluginGateVerdict(
    taskId: string,
    toColumn: string,
    verdict: Omit<PluginGateVerdict, "recordedAt"> & { recordedAt?: number },
  ): void {
    let byColumn = this.pluginGateVerdicts.get(taskId);
    if (!byColumn) {
      byColumn = new Map();
      this.pluginGateVerdicts.set(taskId, byColumn);
    }
    const list = byColumn.get(toColumn) ?? [];
    // Replace any prior verdict for the same trait (latest evaluation wins).
    const filtered = list.filter((v) => v.traitId !== verdict.traitId);
    filtered.push({ ...verdict, recordedAt: verdict.recordedAt ?? Date.now() });
    byColumn.set(toColumn, filtered);
  }

  /**
   * U8: read AND clear the recorded plugin gate verdicts for a (task, column).
   * Returns the recorded verdicts (possibly empty). Consuming clears them so the
   * verdict authorizes exactly one move attempt.
   */
  consumePluginGateVerdicts(taskId: string, toColumn: string): PluginGateVerdict[] {
    const byColumn = this.pluginGateVerdicts.get(taskId);
    if (!byColumn) return [];
    const list = byColumn.get(toColumn) ?? [];
    byColumn.delete(toColumn);
    if (byColumn.size === 0) this.pluginGateVerdicts.delete(taskId);
    return list;
  }

  /**
   * Resolve the custom-field definitions (KTD-13) governing a task, via its
   * workflow selection. v1 IR and the default workflow declare none → `[]`.
   * Pure DB read, safe inside transactions.
   */
  private resolveTaskCustomFieldDefsSync(taskId: string): WorkflowFieldDefinition[] {
    const ir = this.resolveTaskWorkflowIrSync(taskId);
    return ir.version === "v2" ? (ir.fields ?? []) : [];
  }

  private resolveTaskWorkflowIrSync(taskId: string): WorkflowIr {
    const selection = this.getTaskWorkflowSelection(taskId);
    const workflowId = selection?.workflowId;
    if (!workflowId) return this.applyBuiltInPromptOverridesSync("builtin:coding", BUILTIN_CODING_WORKFLOW_IR);
    if (isBuiltinWorkflowId(workflowId)) {
      const builtin = getBuiltinWorkflow(workflowId);
      return this.applyBuiltInPromptOverridesSync(workflowId, builtin?.ir ?? BUILTIN_CODING_WORKFLOW_IR);
    }
    try {
      const row = this.db
        .prepare("SELECT ir FROM workflows WHERE id = ?")
        .get(workflowId) as { ir: string } | undefined;
      if (!row) return BUILTIN_CODING_WORKFLOW_IR;
      return parseWorkflowIr(row.ir);
    } catch {
      return BUILTIN_CODING_WORKFLOW_IR;
    }
  }

  /**
   * U6 (KTD-10): the *effective workflow id* used to scope the per-(workflow,
   * column) capacity count. A task with no selection (or a missing/empty
   * selection row) resolves to the built-in default workflow, represented by a
   * stable sentinel so all default-workflow tasks share one capacity pool. A
   * selected workflow id (builtin or custom) is its own pool. Pure DB read; safe
   * inside the move transaction.
   */
  private resolveEffectiveWorkflowIdSync(taskId: string): string {
    const selection = this.getTaskWorkflowSelection(taskId);
    return selection?.workflowId ?? TaskStore.DEFAULT_WORKFLOW_POOL_ID;
  }

  /**
   * U6 (KTD-10): count cards currently occupying a (workflow, column) capacity
   * slot, for the in-txn capacity check. Runs INSIDE `moveTaskInternal`'s
   * transaction. A slot is held by a card that:
   *   - has committed its column to `targetColumn` (the steady-state holders), OR
   *   - (when `countPending`) has a `transitionPending` marker targeting
   *     `targetColumn` — it reserved the slot at commit time even though its
   *     post-commit hooks haven't finished yet.
   * The moving task itself (`excludeTaskId`) is excluded so a same-column no-op
   * or re-entry never counts itself. Only the candidates in the SAME effective
   * workflow as the mover count (capacity is per-(workflow, column)). Soft-deleted
   * tasks never hold a slot.
   */
  private countActiveInCapacitySlotSync(params: {
    targetColumn: string;
    workflowId: string;
    countPending: boolean;
    excludeTaskId: string;
  }): number {
    const { targetColumn, workflowId, countPending, excludeTaskId } = params;
    // Candidate rows: in the column now, or (optionally) mid-transition into it.
    // LEFT JOIN the selection row so we can scope by effective workflow id in JS.
    const rows = this.db
      .prepare(
        `SELECT t.id AS id, t."column" AS col, t.transitionPending AS tp, s.workflowId AS wid
         FROM tasks t
         LEFT JOIN task_workflow_selection s ON s.taskId = t.id
         WHERE t.deletedAt IS NULL
           AND t.id != ?
           AND (t."column" = ? OR (t.transitionPending IS NOT NULL AND t.transitionPending != ''))`,
      )
      .all(excludeTaskId, targetColumn) as Array<{
        id: string;
        col: string;
        tp: string | null;
        wid: string | null;
      }>;

    let count = 0;
    for (const row of rows) {
      const effectiveWorkflowId = row.wid ?? TaskStore.DEFAULT_WORKFLOW_POOL_ID;
      if (effectiveWorkflowId !== workflowId) continue;

      if (row.col === targetColumn) {
        count += 1;
        continue;
      }
      // Not committed into the column — only counts if it has reserved the slot
      // via a transitionPending marker targeting this column AND countPending.
      if (!countPending || !row.tp) continue;
      let toColumn: string | undefined;
      try {
        const parsed = JSON.parse(row.tp) as { toColumn?: unknown };
        if (typeof parsed.toColumn === "string") toColumn = parsed.toColumn;
      } catch {
        // Corrupt marker — treat as not holding this slot.
      }
      if (toColumn === targetColumn) count += 1;
    }
    return count;
  }

  getTaskWorkflowSelection(taskId: string): { workflowId: string; stepIds: string[] } | undefined {
    const row = this.db
      .prepare("SELECT workflowId, stepIds FROM task_workflow_selection WHERE taskId = ?")
      .get(taskId) as { workflowId: string; stepIds: string } | undefined;
    if (!row) return undefined;
    let stepIds: string[] = [];
    try {
      const parsed = JSON.parse(row.stepIds) as unknown;
      if (Array.isArray(parsed)) stepIds = parsed.filter((s): s is string => typeof s === "string");
    } catch {
      // Corrupt list falls back to empty.
    }
    return { workflowId: row.workflowId, stepIds };
  }

  private writeTaskWorkflowSelection(taskId: string, workflowId: string, stepIds: string[]): void {
    this.db
      .prepare(
        `INSERT INTO task_workflow_selection (taskId, workflowId, stepIds, updatedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(taskId) DO UPDATE SET
           workflowId = excluded.workflowId,
           stepIds = excluded.stepIds,
           updatedAt = excluded.updatedAt`,
      )
      .run(taskId, workflowId, JSON.stringify(stepIds), new Date().toISOString());
  }

  /** Delete the WorkflowStep rows previously materialized for a task's selection
   *  and remove the selection record. Best-effort; safe to call when unset. */
  private removeMaterializedSelection(taskId: string): void {
    const existing = this.getTaskWorkflowSelection(taskId);
    if (existing) {
      for (const stepId of existing.stepIds) {
        this.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
      }
      this.workflowStepsCache = null;
    }
    this.db.prepare("DELETE FROM task_workflow_selection WHERE taskId = ?").run(taskId);
  }

  /** Purge a task's workflow selection and its materialized WorkflowStep rows
   *  when the task row itself is being physically removed. `task_workflow_selection`
   *  has no FK to `tasks(id)` (SQLite can't add one to an existing table without a
   *  rebuild), so deletion must be mirrored here to avoid orphaned selection rows
   *  and unreclaimable compiled steps. Best-effort and synchronous: unlike
   *  clearTaskWorkflowSelection it does not touch enabledWorkflowSteps, since the
   *  owning task row no longer exists. */
  private purgeTaskWorkflowSelectionRows(taskId: string): void {
    const row = this.db
      .prepare("SELECT stepIds FROM task_workflow_selection WHERE taskId = ?")
      .get(taskId) as { stepIds: string } | undefined;
    if (!row) return;
    try {
      const parsed = JSON.parse(row.stepIds) as unknown;
      if (Array.isArray(parsed)) {
        for (const stepId of parsed) {
          if (typeof stepId === "string") {
            this.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
          }
        }
      }
    } catch {
      // Corrupt stepIds list — still remove the selection row below.
    }
    this.db.prepare("DELETE FROM task_workflow_selection WHERE taskId = ?").run(taskId);
    this.workflowStepsCache = null;
  }

  /** Delete a set of freshly materialized WorkflowStep rows that were never
   *  successfully attached to a task/selection (e.g. the owning task create
   *  failed). Best-effort; tolerates already-removed ids. */
  private cleanupOrphanedMaterializedSteps(stepIds: string[] | undefined): void {
    if (!stepIds || stepIds.length === 0) return;
    for (const stepId of stepIds) {
      try {
        this.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
      } catch {
        // Best-effort cleanup.
      }
    }
    this.workflowStepsCache = null;
  }

  /** Persist pre-compiled workflow steps as fresh WorkflowStep rows and return
   *  their ids in execution order. Steps are tagged so they stay out of the
   *  step manager. Compile via compileWorkflowToSteps before calling. */
  private async materializeWorkflowSteps(
    workflowId: string,
    inputs: import("./types.js").WorkflowStepInput[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const input of inputs) {
      const step = await this.createWorkflowStep({
        ...input,
        templateId: `${WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX}${workflowId}`,
        enabled: true,
      });
      ids.push(step.id);
    }
    return ids;
  }

  /** Resolve the project-default workflow into materialized step ids, or null
   *  when no default is set / it is missing / it does not compile. */
  private async materializeDefaultWorkflowSteps(): Promise<{ workflowId: string; stepIds: string[] } | undefined> {
    const workflowId = await this.getDefaultWorkflowId();
    if (!workflowId) return undefined;
    const def = await this.getWorkflowDefinition(workflowId);
    if (!def) return undefined;
    // KTD-1/R6: a fragment must never act as a project default (it is not a
    // selectable workflow); fall back to no default rather than materializing it.
    if (def.kind === "fragment") return undefined;
    // Compile (and validate) before creating any rows so a non-compilable
    // default falls back cleanly with nothing written. Interpreter-deferred
    // built-ins are valid selectable workflows but not lowerable to legacy
    // WorkflowStep rows, so default materialization falls back to legacy defaults.
    // Built-ins that compile to zero steps still record a stepless selection,
    // mirroring explicit workflow materialization.
    let inputs: import("./types.js").WorkflowStepInput[];
    try {
      inputs = compileWorkflowToSteps(def.ir);
    } catch (err) {
      if (isBuiltinWorkflowId(workflowId) && isInterpreterDeferredWorkflowCompileError(err)) return undefined;
      throw err;
    }
    if (isBuiltinWorkflowId(workflowId) && inputs.length === 0) {
      return { workflowId, stepIds: [] };
    }
    const stepIds = await this.materializeWorkflowSteps(workflowId, inputs);
    return { workflowId, stepIds };
  }

  /** Resolve an EXPLICITLY requested workflow id (U6/R3/KTD-4) into materialized
   *  step ids for the create-time `workflowId` parameter. Unlike
   *  `materializeDefaultWorkflowSteps`, unknown ids and fragments are hard errors
   *  (thrown BEFORE any task row is created) rather than silent fallbacks, since
   *  the caller asked for a specific workflow. Compilation happens up front so a
   *  non-compilable workflow aborts before any rows are written. */
  private async materializeExplicitWorkflowSteps(
    workflowId: string,
  ): Promise<{ workflowId: string; stepIds: string[] }> {
    const def = await this.getWorkflowDefinition(workflowId);
    if (!def) throw new Error(`Workflow '${workflowId}' not found`);
    if (def.kind === "fragment") {
      throw new Error(`Workflow '${workflowId}' is a fragment and cannot be selected for a task`);
    }
    let inputs: import("./types.js").WorkflowStepInput[];
    try {
      inputs = compileWorkflowToSteps(def.ir);
    } catch (err) {
      if (isBuiltinWorkflowId(workflowId) && isInterpreterDeferredWorkflowCompileError(err)) return { workflowId, stepIds: [] };
      throw err;
    }
    const stepIds = await this.materializeWorkflowSteps(workflowId, inputs);
    return { workflowId, stepIds };
  }

  /**
   * Select a workflow for a task: compile it when possible, materialize its
   * steps, and write their ids into the task's enabledWorkflowSteps. Replaces
   * any prior selection (no orphaned steps). Interpreter-deferred workflow IRs
   * record the selection with zero materialized steps; genuinely invalid graphs
   * still throw before any state is written.
   */
  async selectTaskWorkflow(taskId: string, workflowId: string): Promise<string[]> {
    // Hold the task lock across the whole sequence (materialize → owner write →
    // prior-step cleanup) so it can't interleave with a concurrent select/clear
    // or executor updateTask on the same task. updateTaskUnlocked is used inside
    // because the per-task lock is non-reentrant.
    return this.withTaskLock(taskId, async () => {
      const def = await this.getWorkflowDefinition(workflowId);
      if (!def) throw new Error(`Workflow '${workflowId}' not found`);
      // KTD-1/R6: fragments are reusable single-node palette templates, not
      // selectable workflows. Reject them from task selection with a clear error
      // rather than materializing a degenerate single-step task.
      if (def.kind === "fragment") {
        throw new Error(`Workflow '${workflowId}' is a fragment and cannot be selected for a task`);
      }
      // Compile once up front: invalid graphs abort before any mutation, while
      // interpreter-deferred graphs keep the selection but materialize no legacy
      // WorkflowStep rows.
      let inputs: import("./types.js").WorkflowStepInput[];
      try {
        inputs = compileWorkflowToSteps(def.ir);
      } catch (err) {
        if (isBuiltinWorkflowId(workflowId) && isInterpreterDeferredWorkflowCompileError(err)) inputs = [];
        else throw err;
      }

      // Materialize the new steps and point the task at them BEFORE deleting the
      // prior selection's rows, so a mid-flight failure never leaves the task
      // referencing already-deleted step ids.
      const priorSelection = this.getTaskWorkflowSelection(taskId);
      // U11/KTD-13: capture the OLD field schema (from the prior selection's IR)
      // before the selection row flips, so we can reconcile existing field values
      // against the NEW workflow's schema below.
      const oldFieldDefs = this.resolveTaskCustomFieldDefsSync(taskId);
      const newFieldDefs: WorkflowFieldDefinition[] =
        def.ir.version === "v2" ? (def.ir.fields ?? []) : [];
      const ids = await this.materializeWorkflowSteps(workflowId, inputs);
      try {
        await this.updateTaskUnlocked(taskId, { enabledWorkflowSteps: ids });
        this.writeTaskWorkflowSelection(taskId, workflowId, ids);
      } catch (err) {
        // The owner write (updateTask / selection upsert) failed, so the steps we
        // just materialized would orphan with no selection row pointing at them.
        // Delete them before propagating; the prior selection is left untouched.
        for (const stepId of ids) {
          try {
            this.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
          } catch {
            // Best-effort cleanup; surface the original error below.
          }
        }
        this.workflowStepsCache = null;
        throw err;
      }

      if (priorSelection) {
        for (const stepId of priorSelection.stepIds) {
          this.db.prepare("DELETE FROM workflow_steps WHERE id = ?").run(stepId);
        }
        this.workflowStepsCache = null;
      }

      // U11/KTD-13: reconcile custom field values against the NEW workflow's
      // schema. Same-id, type-compatible values are kept; incompatible/removed
      // ids are orphaned — but RETAINED in storage (orphan-not-delete) so a later
      // switch back, or the orphaned-fields disclosure, can still surface them.
      // Then fill defaults for the new workflow's required+default fields that
      // are absent. The merged object is written DIRECTLY (bypassing the
      // validating patch path) because orphaned ids are by definition unknown to
      // the new schema and would otherwise be rejected.
      await this.reconcileTaskCustomFieldsForSchema(taskId, oldFieldDefs, newFieldDefs);

      return ids;
    });
  }

  /**
   * U11/KTD-13: reconcile a task's stored custom field values when its governing
   * field schema changes (workflow switch or definition edit). Values are
   * partitioned by {@link reconcileFieldsOnWorkflowChange}; orphans are retained
   * (never destroyed). Required+default fields absent from the result are filled.
   * Writes the merged values directly onto task.json — orphaned ids are unknown
   * to the new schema, so this deliberately bypasses the validating patch path.
   * Assumes the caller already holds the per-task lock.
   */
  private async reconcileTaskCustomFieldsForSchema(
    taskId: string,
    oldFieldDefs: WorkflowFieldDefinition[],
    newFieldDefs: WorkflowFieldDefinition[],
    dropOrphans = false,
  ): Promise<void> {
    const dir = this.taskDir(taskId);
    const task = await this.readTaskJson(dir);
    const current = task.customFields ?? {};
    const { kept, orphaned } = reconcileFieldsOnWorkflowChange(oldFieldDefs, newFieldDefs, current);
    // Default (keep-orphaned): storage keeps everything (kept ∪ orphaned).
    // coerce:"drop" discards the orphaned values entirely.
    const base = dropOrphans ? { ...kept } : { ...kept, ...orphaned };
    const reconciled = applyFieldDefaults(newFieldDefs, base);
    // Skip the write when nothing changed (no defaults added, same keys/values).
    const unchanged =
      Object.keys(reconciled).length === Object.keys(current).length &&
      Object.entries(reconciled).every(([k, v]) => current[k] === v);
    if (unchanged) return;
    task.customFields = reconciled;
    task.updatedAt = new Date().toISOString();
    await this.atomicWriteTaskJson(dir, task);
    if (this.isWatching) this.taskCache.set(taskId, { ...task });
    this.emitTaskLifecycleEventSafely("task:updated", [task]);
  }

  /**
   * U5 (R20) workflow switch: select a workflow for a task and, when the
   * `workflowColumns` flag is ON, reconcile the card's board column against the
   * NEW workflow. Same-id column preserves position; otherwise the card re-homes
   * to the new workflow's entry (intake-flagged, else first) column, aborting
   * in-flight processing first (KTD-9). Returns the materialized step ids plus
   * the switch outcome so the dashboard can surface the re-home.
   *
   * Reconciliation runs AFTER `selectTaskWorkflow` releases the per-task lock
   * (moveTask takes its own lock; the per-task lock is non-reentrant).
   */
  async selectTaskWorkflowAndReconcile(
    taskId: string,
    workflowId: string,
  ): Promise<{
    enabledWorkflowSteps: string[];
    reconciliation?: { preserved: boolean; fromColumn: string; toColumn: string };
  }> {
    const enabledWorkflowSteps = await this.selectTaskWorkflow(taskId, workflowId);
    if (!(await this.workflowColumnsFlagOn())) {
      return { enabledWorkflowSteps };
    }
    const newIr = this.resolveTaskWorkflowIrSync(taskId);
    const current = this.readTaskFromDb(taskId, { includeDeleted: false });
    if (!current) return { enabledWorkflowSteps };
    const fromColumn = current.column;
    const decision = resolveSwitchReconciliation(newIr, fromColumn);
    if (!decision.preserved && decision.targetColumn !== fromColumn) {
      await this.rehomeOccupant(taskId, decision.targetColumn, "workflow-switch", { workflowId });
    }
    return {
      enabledWorkflowSteps,
      reconciliation: {
        preserved: decision.preserved,
        fromColumn,
        toColumn: decision.targetColumn,
      },
    };
  }

  /** Clear a task's workflow selection and its enabled steps. */
  async clearTaskWorkflowSelection(taskId: string): Promise<void> {
    await this.withTaskLock(taskId, async () => {
      this.removeMaterializedSelection(taskId);
      await this.updateTaskUnlocked(taskId, { enabledWorkflowSteps: [] });
    });
  }

  /**
   * Close the database connection and clean up resources.
   * Call this when the store is no longer needed (e.g., short-lived per-request stores).
   */
  async close(): Promise<void> {
    this.closing = true;
    if (this.deferredTaskCreatedWork.size > 0) {
      await Promise.allSettled([...this.deferredTaskCreatedWork]);
    }
    this.stopWatching();
    // Flush any remaining buffered agent log entries before closing.
    // Wrap in try-catch because entries for already-deleted tasks will fail FK check.
    if (this.agentLogBuffer.length > 0) {
      try {
        this.flushAgentLogBuffer();
      } catch (err) {
        // Best-effort flush — entries for deleted tasks will fail FK check.
        // Log the error instead of silently swallowing it.
        console.warn(`[fusion] Could not flush remaining agent log entries on close:`, err);
      }
    }
    // Cancel any retry timer armed by a failed flush — the DB is about to close.
    if (this.agentLogFlushTimer) {
      clearTimeout(this.agentLogFlushTimer);
      this.agentLogFlushTimer = null;
    }
    this.agentLogBuffer.length = 0;
    if (this._db) {
      this._db.close();
      this._db = null;
      this.taskIdStateReconciled = false;
    }
    if (this._archiveDb) {
      this._archiveDb.close();
      this._archiveDb = null;
    }
    if (this.secretsCentralCore) {
      void this.secretsCentralCore.close();
      this.secretsCentralCore = null;
    }
    this.secretsStore = null;
  }

  get fts5Available(): boolean {
    return this.db.fts5Available;
  }

  get archiveFts5Available(): boolean {
    return this.archiveDb.fts5Available;
  }

  optimizeFts5(mode?: "optimize" | "merge"): boolean {
    return this.db.optimizeFts5(mode);
  }

  optimizeArchiveFts5(mode?: "optimize" | "merge"): boolean {
    return this.archiveDb.optimizeFts5(mode);
  }

  getFtsIndexBytes(): number | null {
    return this.db.getFtsIndexBytes();
  }

  getArchiveFtsIndexBytes(): number | null {
    return this.archiveDb.getFtsIndexBytes();
  }

  getTaskRowCount(): number {
    return this.db.getTaskRowCount();
  }

  getArchivedRowCount(): number {
    return this.archiveDb.getArchivedRowCount();
  }

  rebuildArchiveFts5Index(): boolean {
    return this.archiveDb.rebuildFts5Index();
  }

  /**
   * Run a WAL checkpoint and return checkpoint stats.
   *
   * The default preserves SQLite's aggressive TRUNCATE behavior for explicit
   * maintenance/compaction calls. Live engine maintenance should request
   * PASSIVE explicitly to avoid forcing a blocking truncate on the shared
   * event loop.
   */
  walCheckpoint(mode?: "PASSIVE" | "TRUNCATE"): { busy: number; log: number; checkpointed: number } {
    return this.db.walCheckpoint(mode);
  }

  /**
   * Delete append-only operational-log rows older than `retentionMs`. Returns
   * zeroed counts when retention is disabled (`<= 0`). This is the primary lever
   * against unbounded database growth — see `Database.pruneOperationalLogs`.
   */
  pruneOperationalLogs(retentionMs: number): { deletedByTable: Record<string, number>; deletedTotal: number } {
    return this.db.pruneOperationalLogs(retentionMs);
  }

  /**
   * Prune per-task JSONL agent log files by removing entries older than the
   * configured retention window. Only prunes files for soft-deleted or archived
   * tasks (avoids removing logs for still-active tasks). Returns zeroed counts
   * when retention is disabled (`<= 0`).
   */
  pruneAgentLogFiles(retentionDays: number): { prunedFiles: number; prunedEntries: number; freedBytes: number } {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      return { prunedFiles: 0, prunedEntries: 0, freedBytes: 0 };
    }
    // Only prune JSONL files for tasks that are no longer active (soft-deleted or archived)
    const inactiveTaskIds = new Set(
      (
        this.db
          .prepare(`SELECT id FROM tasks WHERE deletedAt IS NOT NULL OR "column" = 'archived'`)
          .all() as Array<{ id: string }>
      ).map((row) => row.id),
    );
    return pruneAgentLogFileEntries(this.tasksDir, retentionDays, inactiveTaskIds);
  }

  getRootDir(): string {
    return this.rootDir;
  }

  /** Return the `.fusion` directory path (e.g. `/project/.fusion`). */
  getFusionDir(): string {
    return this.fusionDir;
  }

  getTasksDir(): string {
    return this.tasksDir;
  }

  getTaskDir(id: string): string {
    return this.taskDir(id);
  }

  /** Expose the shared Database instance for co-located stores (e.g. AiSessionStore). */
  getDatabase(): Database {
    return this.db;
  }

  getBootstrappedAt(): number | null {
    return this.db.getBootstrappedAt();
  }

  async getSecretsStore(): Promise<SecretsStore> {
    if (this.secretsStore) {
      return this.secretsStore;
    }

    const central = new CentralCore(this.getFusionDir());
    await central.init();
    this.secretsCentralCore = central;
    const centralDb = (central as unknown as { db: import("./central-db.js").CentralDatabase | null }).db;
    if (!centralDb) {
      throw new Error("Central database unavailable for secrets store");
    }
    const masterKeyManager = new MasterKeyManager();
    const masterKeyProvider = () => masterKeyManager.getOrCreateKey();
    this.secretsStore = new SecretsStore(this.db, centralDb, masterKeyProvider);
    return this.secretsStore;
  }

  getDatabaseHealth(): {
    healthy: boolean;
    corruptionDetected: boolean;
    corruptionErrors: string[];
    lastCheckedAt: Date | null;
    isRunning: boolean;
  } {
    const corruptionDetected = this.db.corruptionDetected;
    return {
      healthy: !corruptionDetected,
      corruptionDetected,
      corruptionErrors: this.db.integrityCheckErrors.slice(0, 5),
      lastCheckedAt: this.db.integrityCheckLastRunAt ? new Date(this.db.integrityCheckLastRunAt) : null,
      isRunning: this.db.integrityCheckPending,
    };
  }

  /**
   * Force-run an integrity check synchronously and return the refreshed health
   * snapshot. Used by `POST /api/health/refresh` so users can clear a stale
   * corruption banner after they've repaired the database in place
   * (e.g. via `REINDEX` or `fn db --vacuum`) without having to restart the
   * engine to re-arm the once-at-boot background check.
   */
  refreshDatabaseHealth(): ReturnType<TaskStore["getDatabaseHealth"]> {
    this.db.refreshIntegrityCheck();
    return this.getDatabaseHealth();
  }

  getDistributedTaskIdAllocator(): DistributedTaskIdAllocator {
    if (!this.distributedTaskIdAllocator) {
      this.distributedTaskIdAllocator = createDistributedTaskIdAllocator(this.db);
    }
    return this.distributedTaskIdAllocator;
  }

  /**
   * Perform a simple database health check.
   * Returns true if the database responds correctly, false otherwise.
   * Used for periodic health diagnostics.
   */
  healthCheck(): boolean {
    try {
      // Simple query to verify database responsiveness
      this.db.prepare("SELECT 1").get();
      return this.db.checkFts5Integrity();
    } catch {
      return false;
    }
  }

  private generateSpecifiedPrompt(task: Task): string {
    const deps =
      task.dependencies.length > 0
        ? task.dependencies.map((d) => `- **Task:** ${d}`).join("\n")
        : "- **None**";

    // Get current settings to check for ntfy configuration
    const settings = this.getSettingsSync();
    const notificationsSection =
      settings.ntfyEnabled && settings.ntfyTopic
        ? `\n## Notifications\n\nntfy topic: \`${settings.ntfyTopic}\`\n`
        : "";

    const heading = task.title ? `${task.id}: ${task.title}` : task.id;
    return `# ${heading}

**Created:** ${task.createdAt.split("T")[0]}
**Size:** M

## Mission

${task.description}

## Dependencies

${deps}

## Steps

### Step 1: Implementation

- [ ] Implement the required changes
- [ ] Verify changes work correctly

### Step 2: Testing & Verification

- [ ] Lint passes
- [ ] All tests pass
- [ ] Typecheck passes
- [ ] No regressions introduced

### Step 3: Documentation & Delivery

- [ ] Update relevant documentation

## Acceptance Criteria

- [ ] All steps complete
- [ ] All tests passing
${notificationsSection}`;
  }

  /**
   * Synchronous version of getSettings for internal use.
   * Returns project-level settings merged with defaults.
   * Note: This does NOT merge global settings because it's synchronous
   * and global settings require async I/O.
   */
  private getSettingsSync(): Settings {
    try {
      const row = this.db.prepare("SELECT settings FROM config WHERE id = 1").get() as { settings: string | null } | undefined;
      if (!row) return DEFAULT_SETTINGS;
      const settings = fromJson<Settings>(row.settings);
      return { ...DEFAULT_SETTINGS, ...settings };
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  // ── Activity Log Methods ─────────────────────────────────────────

  /**
   * Record an activity log entry to the SQLite database.
   * Auto-generates ID and timestamp.
   */
  async recordActivity(entry: Omit<ActivityLogEntry, "id" | "timestamp">): Promise<ActivityLogEntry> {
    const fullEntry: ActivityLogEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };

    try {
      this.db.prepare(
        `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        fullEntry.id,
        fullEntry.timestamp,
        fullEntry.type,
        fullEntry.taskId ?? null,
        fullEntry.taskTitle ?? null,
        fullEntry.details,
        fullEntry.metadata ? JSON.stringify(fullEntry.metadata) : null,
      );
      this.db.bumpLastModified();
    } catch (err) {
      // Best-effort: log errors but don't break operations
      storeLog.error("Failed to record activity", {
        id: fullEntry.id,
        type: fullEntry.type,
        taskId: fullEntry.taskId,
        taskTitle: fullEntry.taskTitle,
        detailsLength: fullEntry.details.length,
        hasMetadata: fullEntry.metadata !== undefined,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return fullEntry;
  }

  /**
   * Get activity log entries from SQLite.
   * Returns entries sorted newest first.
   * Supports filtering by limit, since timestamp, and event type.
   */
  async getActivityLog(options?: { limit?: number; since?: string; type?: ActivityEventType }): Promise<ActivityLogEntry[]> {
    let sql = "SELECT * FROM activityLog WHERE 1=1";
    const params: (string | number)[] = [];

    if (options?.since) {
      sql += " AND timestamp > ?";
      params.push(options.since);
    }

    if (options?.type) {
      sql += " AND type = ?";
      params.push(options.type);
    }

    sql += " ORDER BY timestamp DESC";

    if (options?.limit && options.limit > 0) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as unknown as ActivityLogRow[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      type: row.type as ActivityEventType,
      taskId: row.taskId || undefined,
      taskTitle: row.taskTitle || undefined,
      details: row.details,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  async getTaskMovedCountsByDay(options: {
    since: string;
    until: string;
    fromColumn?: string;
    toColumn?: string;
  }): Promise<Record<string, number>> {
    let sql =
      "SELECT substr(timestamp, 1, 10) AS day, COUNT(*) AS count FROM activityLog WHERE type = 'task:moved' AND timestamp > ? AND timestamp <= ?";
    const params: (string | number)[] = [options.since, options.until];

    if (options.fromColumn) {
      sql += " AND json_extract(metadata, '$.from') = ?";
      params.push(options.fromColumn);
    }

    if (options.toColumn) {
      sql += " AND json_extract(metadata, '$.to') = ?";
      params.push(options.toColumn);
    }

    sql += " GROUP BY substr(timestamp, 1, 10)";

    const rows = this.db.prepare(sql).all(...params) as Array<{ day: string; count: number }>;
    const countsByDay: Record<string, number> = {};
    for (const row of rows) {
      countsByDay[row.day] = row.count;
    }
    return countsByDay;
  }

  async getInReviewDurationEvents(options: { since: string; until: string }): Promise<ActivityLogEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM activityLog
         WHERE type = 'task:moved'
           AND timestamp > ?
           AND timestamp <= ?
           AND (
             json_extract(metadata, '$.to') = 'in-review'
             OR (
               json_extract(metadata, '$.from') = 'in-review'
               AND json_extract(metadata, '$.to') = 'done'
             )
           )
         ORDER BY timestamp ASC
         LIMIT ?`,
      )
      .all(options.since, options.until, 200_000) as unknown as ActivityLogRow[];

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      type: row.type as ActivityEventType,
      taskId: row.taskId || undefined,
      taskTitle: row.taskTitle || undefined,
      details: row.details,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  async getTaskMergedTaskIds(options: { since: string; until: string }): Promise<Set<string>> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT taskId FROM activityLog
         WHERE type = 'task:merged'
           AND timestamp > ?
           AND timestamp <= ?
           AND taskId IS NOT NULL`,
      )
      .all(options.since, options.until) as Array<{ taskId: string }>;

    return new Set(rows.map((row) => row.taskId));
  }

  /**
   * Clear all activity log entries.
   * Use with caution - this permanently deletes activity history.
   */
  async clearActivityLog(): Promise<void> {
    this.db.prepare("DELETE FROM activityLog").run();
    this.db.bumpLastModified();
  }

  /**
   * Get the MissionStore instance for mission hierarchy operations.
   * Lazily initializes the MissionStore on first access.
   */
  getMissionStore(): MissionStore {
    if (!this.missionStore) {
      this.missionStore = new MissionStore(this.fusionDir, this.db, this);
    }
    return this.missionStore;
  }

  /**
   * Get the PluginStore instance for plugin registry operations.
   * Lazily initializes the PluginStore on first access.
   */
  getPluginStore(): PluginStore {
    if (!this.pluginStore) {
      // PluginStore persists install/state rows in central DB, so it must use
      // the same resolved global settings directory as TaskStore.
      this.pluginStore = new PluginStore(this.rootDir, { centralGlobalDir: this.globalSettingsDir });
      const clearWorkflowDefinitionCache = () => {
        this.workflowDefinitionsCache = null;
      };
      this.pluginStore.on("plugin:registered", clearWorkflowDefinitionCache);
      this.pluginStore.on("plugin:unregistered", clearWorkflowDefinitionCache);
    }
    return this.pluginStore;
  }

  private async isPluginInstalled(pluginId: string): Promise<boolean> {
    try {
      const plugins = await this.getPluginStore().listPlugins();
      return plugins.some((plugin) => plugin.id === pluginId);
    } catch {
      return false;
    }
  }

  /**
   * Get the InsightStore instance for project insights operations.
   * Lazily initializes the InsightStore on first access.
   */
  getInsightStore(): InsightStore {
    if (!this.insightStore) {
      this.insightStore = new InsightStore(this.db);
    }
    return this.insightStore;
  }

  /**
   * Get the ResearchStore instance for research run operations.
   * Lazily initializes the ResearchStore on first access.
   */
  getResearchStore(): ResearchStore {
    if (!this.researchStore) {
      this.researchStore = new ResearchStore(this.db);
    }
    return this.researchStore;
  }

  /**
   * Get the ExperimentSessionStore instance for upstream-style experiment
   * session operations (try-measure-keep-revert loop, finalize workflow).
   * Lazily initializes the ExperimentSessionStore on first access.
   */
  getExperimentSessionStore(): ExperimentSessionStore {
    if (!this.experimentSessionStore) {
      this.experimentSessionStore = new ExperimentSessionStore(this.db);
    }
    return this.experimentSessionStore;
  }

  /**
   * Get the TodoStore instance for project-scoped todo list operations.
   * Lazily initializes the TodoStore on first access.
   */
  getTodoStore(): TodoStore {
    if (!this.todoStore) {
      this.todoStore = new TodoStore(this.db);
    }
    return this.todoStore;
  }

  /**
   * Get the GoalStore instance for project-scoped goals operations.
   * Lazily initializes the GoalStore on first access.
   */
  getGoalStore(): GoalStore {
    if (!this.goalStore) {
      this.goalStore = new GoalStore(this.fusionDir, this.db);
    }
    return this.goalStore;
  }

  /**
   * Get the EvalStore instance for eval run and task result operations.
   * Lazily initializes the EvalStore on first access.
   */
  getEvalStore(): EvalStore {
    if (!this.evalStore) {
      this.evalStore = new EvalStore(this.db);
    }
    return this.evalStore;
  }

  // ── Verification Cache ────────────────────────────────────────────────────

  /**
   * Look up a previously recorded verification cache pass for a given tree sha
   * and command pair. Returns null when no cached pass exists.
   *
   * @param treeSha - The git tree SHA of the merged commit.
   * @param testCommand - The test command string (normalized to empty string when absent).
   * @param buildCommand - The build command string (normalized to empty string when absent).
   */
  getVerificationCacheHit(
    treeSha: string,
    testCommand: string,
    buildCommand: string,
  ): { recordedAt: string; taskId: string | null } | null {
    const normalizedTest = testCommand ?? "";
    const normalizedBuild = buildCommand ?? "";
    const row = this.db
      .prepare(
        `SELECT recordedAt, taskId FROM verification_cache
         WHERE treeSha = ? AND testCommand = ? AND buildCommand = ?`,
      )
      .get(treeSha, normalizedTest, normalizedBuild) as
      | { recordedAt: string; taskId: string | null }
      | undefined;
    return row ?? null;
  }

  /**
   * Record a successful verification pass for the given tree sha and commands.
   * Uses INSERT OR REPLACE so a re-run of the same tree updates the timestamp.
   *
   * @param treeSha - The git tree SHA of the merged commit.
   * @param testCommand - The test command string (normalized to empty string when absent).
   * @param buildCommand - The build command string (normalized to empty string when absent).
   * @param taskId - The task ID that triggered the pass (for telemetry).
   */
  recordVerificationCachePass(
    treeSha: string,
    testCommand: string,
    buildCommand: string,
    taskId: string,
  ): void {
    const normalizedTest = testCommand ?? "";
    const normalizedBuild = buildCommand ?? "";
    const recordedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO verification_cache (treeSha, testCommand, buildCommand, recordedAt, taskId)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(treeSha, normalizedTest, normalizedBuild, recordedAt, taskId);
  }

  // ── Shared mesh state export/apply helpers ───────────────────────────────

  async getTaskMetadataSnapshot(): Promise<TaskMetadataSnapshot> {
    const tasks = await this.listTasks({ slim: false, includeArchived: true });
    return createTaskMetadataSnapshot(tasks as unknown as TaskMetadataSnapshot["payload"]["tasks"]);
  }

  async applyTaskMetadataSnapshot(snapshot: TaskMetadataSnapshot): Promise<{ applied: number; skipped: number }> {
    validateSnapshotEnvelope(snapshot);
    const existingTasks = new Map((await this.listTasks({ slim: false, includeArchived: true })).map((task) => [task.id, task]));
    let applied = 0;
    let skipped = 0;

    for (const incoming of snapshot.payload.tasks) {
      const current = existingTasks.get(incoming.id);
      const currentMetadata = current ? toTaskMetadataRecord(current) : undefined;
      if (currentMetadata && JSON.stringify(currentMetadata) === JSON.stringify(incoming)) {
        skipped++;
        continue;
      }
      const toUpsert: Task = {
        ...(incoming as unknown as Task),
        worktree: current?.worktree,
        executionStartBranch: current?.executionStartBranch,
        sessionFile: current?.sessionFile,
      };
      this.upsertTaskWithFtsRecovery(toUpsert);
      applied++;
    }

    return { applied, skipped };
  }

  async getActivityLogSnapshot(limit = 10_000): Promise<ActivityLogSnapshot> {
    const entries = await this.getActivityLog({ limit });
    return createActivityLogSnapshot([...entries].reverse());
  }

  applyActivityLogSnapshot(snapshot: ActivityLogSnapshot): { applied: number; skipped: number } {
    validateSnapshotEnvelope(snapshot);
    let applied = 0;
    let skipped = 0;

    for (const entry of snapshot.payload.entries) {
      const exists = this.db.prepare("SELECT 1 FROM activityLog WHERE id = ?").get(entry.id);
      if (exists) {
        skipped++;
        continue;
      }
      this.db.prepare(
        `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.id,
        entry.timestamp,
        entry.type,
        entry.taskId ?? null,
        entry.taskTitle ?? null,
        entry.details,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      );
      applied++;
    }

    return { applied, skipped };
  }

  getRunAuditSnapshot(filter: RunAuditEventFilter = {}): RunAuditSnapshot {
    return createRunAuditSnapshot(this.getRunAuditEvents({ ...filter, limit: filter.limit ?? 10_000 }).reverse());
  }

  applyRunAuditSnapshot(snapshot: RunAuditSnapshot): { applied: number; skipped: number } {
    validateSnapshotEnvelope(snapshot);
    let applied = 0;
    let skipped = 0;

    for (const entry of snapshot.payload.entries) {
      const exists = this.db.prepare("SELECT 1 FROM runAuditEvents WHERE id = ?").get(entry.id);
      if (exists) {
        skipped++;
        continue;
      }
      this.db.prepare(`
        INSERT INTO runAuditEvents (id, timestamp, taskId, agentId, runId, domain, mutationType, target, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id,
        entry.timestamp,
        entry.taskId ?? null,
        entry.agentId,
        entry.runId,
        entry.domain,
        entry.mutationType,
        entry.target,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      );
      applied++;
    }

    return { applied, skipped };
  }

  async upsertTaskCommitAssociation(
    input: Omit<TaskCommitAssociation, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<TaskCommitAssociation> {
    const now = new Date().toISOString();
    const association: TaskCommitAssociation = normalizeTaskCommitAssociation({
      id: input.id ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...input,
    });
    this.db.prepare(
      `INSERT INTO task_commit_associations
       (id, taskLineageId, taskIdSnapshot, commitSha, commitSubject, authoredAt, matchedBy, confidence, note, additions, deletions, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(taskLineageId, commitSha, matchedBy) DO UPDATE SET
         taskIdSnapshot = excluded.taskIdSnapshot,
         commitSubject = excluded.commitSubject,
         authoredAt = excluded.authoredAt,
         confidence = excluded.confidence,
         note = excluded.note,
         additions = excluded.additions,
         deletions = excluded.deletions,
         updatedAt = excluded.updatedAt`,
    ).run(
      association.id,
      association.taskLineageId,
      association.taskIdSnapshot,
      association.commitSha,
      association.commitSubject,
      association.authoredAt,
      association.matchedBy,
      association.confidence,
      association.note ?? null,
      association.additions ?? null,
      association.deletions ?? null,
      association.createdAt,
      association.updatedAt,
    );
    return association;
  }

  async getTaskCommitAssociationsByLineageId(lineageId: string): Promise<TaskCommitAssociation[]> {
    const rows = this.db.prepare(
      `SELECT * FROM task_commit_associations WHERE taskLineageId = ? ORDER BY authoredAt DESC, createdAt DESC`,
    ).all(lineageId) as TaskCommitAssociationRow[];
    return rows.map((row) => normalizeTaskCommitAssociation({
      ...row,
      note: row.note ?? undefined,
      additions: row.additions ?? undefined,
      deletions: row.deletions ?? undefined,
    }));
  }

  /**
   * FNXC:CommandCenterLocBackfill 2026-06-19-12:30:
   * Historical LOC backfill is an explicit operator action that fills only rows where both diff-stat columns are NULL. FN-6704 writes additions/deletions atomically, so candidate selection and updates guard on both columns to stay idempotent and avoid overwriting already-captured stats. Stored SHAs are untrusted; validate them before git interpolation. Unavailable commit objects remain NULL because NULL means "stats unknown" while 0 is a real zero-line stat. Dry-run reports the rows that would be updated without writing them.
   */
  async backfillCommitAssociationDiffStats(
    options: { dryRun?: boolean } = {},
  ): Promise<CommitAssociationDiffBackfillReport> {
    const dryRun = options.dryRun === true;
    const candidates = this.db.prepare(
      `SELECT commitSha, COUNT(*) AS rowCount
       FROM task_commit_associations
       WHERE additions IS NULL AND deletions IS NULL
       GROUP BY commitSha
       ORDER BY commitSha`,
    ).all() as CommitAssociationDiffBackfillCandidateRow[];

    const report: CommitAssociationDiffBackfillReport = {
      scannedRows: candidates.reduce((sum, row) => sum + row.rowCount, 0),
      distinctCommits: candidates.length,
      updatedRows: 0,
      skippedUnavailableCommits: 0,
      skippedInvalidShas: 0,
      dryRun,
    };

    const validShaPattern = /^[0-9a-fA-F]{7,64}$/;
    const updateStats = this.db.prepare(
      `UPDATE task_commit_associations
       SET additions = ?, deletions = ?, updatedAt = ?
       WHERE commitSha = ? AND additions IS NULL AND deletions IS NULL`,
    );

    for (const candidate of candidates) {
      const commitSha = candidate.commitSha;
      if (!validShaPattern.test(commitSha)) {
        report.skippedInvalidShas += 1;
        continue;
      }

      const verify = await this.runGitCommand(`git cat-file -e ${commitSha}^{commit}`);
      if (verify.exitCode !== 0) {
        report.skippedUnavailableCommits += 1;
        continue;
      }

      const statsResult = await this.runGitCommand(`git show --shortstat --format= ${commitSha}`);
      if (statsResult.exitCode !== 0) {
        report.skippedUnavailableCommits += 1;
        continue;
      }

      const normalized = statsResult.stdout.trim().replace(/\n/g, " ");
      const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
      const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);
      const additions = insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0;
      const deletions = deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0;

      if (dryRun) {
        report.updatedRows += candidate.rowCount;
        continue;
      }

      const result = updateStats.run(additions, deletions, new Date().toISOString(), commitSha);
      report.updatedRows += Number(result.changes);
    }

    return report;
  }

  async replaceLegacyTaskCommitAssociations(
    lineageId: string,
    associations: Array<Omit<TaskCommitAssociation, "id" | "createdAt" | "updatedAt" | "taskLineageId">>,
  ): Promise<void> {
    const deleteStmt = this.db.prepare(
      `DELETE FROM task_commit_associations WHERE taskLineageId = ? AND matchedBy IN ('legacy-task-id-trailer', 'legacy-subject', 'manual-reconciliation')`,
    );
    deleteStmt.run(lineageId);
    for (const association of associations) {
      await this.upsertTaskCommitAssociation({ ...association, taskLineageId: lineageId });
    }
  }

  // ── Backward Compatibility (Multi-Project Support) ────────────────────────

}

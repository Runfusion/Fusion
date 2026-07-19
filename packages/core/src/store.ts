import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import { type FSWatcher } from "node:fs";
import type { Task, TaskDetail, TaskCreateInput, TaskAttachment, AgentLogEntry, BoardConfig, Column, ColumnId, CheckoutClaimPrecondition, MergeResult, Settings, GlobalSettings, ProjectSettings, ActivityLogEntry, ActivityEventType, TaskDocument, TaskDocumentRevision, TaskDocumentCreateInput, TaskDocumentWithTask, Artifact, ArtifactCreateInput, ArtifactType, ArtifactWithTask, InboxTask, TaskLogEntry, RunMutationContext, RunAuditEvent, RunAuditEventInput, RunAuditEventFilter, ArchivedTaskEntry, ArchiveAgentLogMode, TaskPriority, WorkflowStepTemplate, Agent, AutostashOrphanRecord, TaskCommitAssociation, CommitAssociationDiffBackfillReport, GithubIssueAction, MergeQueueEntry, MergeQueueEnqueueOptions, MergeQueueAcquireOptions, MergeQueueReleaseOutcome, HandoffToReviewOptions, GoalCitation, GoalCitationFilter, GoalCitationInput, GoalCitationSurface, BranchGroup, BranchGroupCreateInput, BranchGroupUpdate, TaskBranchAssignmentMode, MergeRequestRecord, MergeRequestState, MergeRequestWorkflowProjectionOptions, CompletionHandoffMarker, WorkflowWorkItem, WorkflowWorkItemDueFilter, WorkflowWorkItemKind, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch, WorkflowWorkItemUpsertInput, PrEntity, PrEntityCreateInput, PrEntityUpdate, PrThreadState, PrThreadOutcome, PluginActivation, PluginActivationInput } from "./types.js";


export type OverlapBlockerRepairReason =
  | "task-not-found"
  | "no-overlap-blocker"
  | "not-repairable-state"
  | "blocker-missing"
  | "scopes-still-overlap"
  | "dependency-blocker-remains"
  | "overlap-blocker-changed"
  | "rerouted-to-current-overlap"
  | "repaired";

export interface RepairOverlapBlockerOptions {
  dryRun?: boolean;
  reason?: string;
}

export interface RepairOverlapBlockerResult {
  taskId: string;
  dryRun: boolean;
  repaired: boolean;
  statusCleared: boolean;
  previousOverlapBlockedBy?: string;
  currentOverlapBlockedBy?: string;
  reason: OverlapBlockerRepairReason;
  message: string;
  task?: Task;
}

/** @internal Extracted modules use this compatibility flag */
export function isWorkflowColumnsCompatibilityFlagEnabled(settings: Pick<Settings, "experimentalFeatures"> | undefined): boolean {
  /*
  FNXC:WorkflowColumns 2026-06-22-00:00:
  TaskStore still needs the raw compatibility flag for legacy movement characterization, v1 workflow-IR rollback persistence, and ON→OFF custom-column evacuation tests. This is narrower than the public runtime helper, which treats stale false values as enabled after workflow-column cutover.
  */
  return settings?.experimentalFeatures?.workflowColumns === true;
}
import { type PluginGateVerdict } from "./plugin-gate-verdict.js";
import type { PluginOnSchemaInit, PluginPostgresSchemaDefinition } from "./plugin-types.js";
import { assertLoadedPluginSchemaInitHooksSupported, type LoadedPluginSchemaContract } from "./postgres/plugin-schema-hook.js";
import { DEFAULT_WORKFLOW_POOL_ID } from "./workflow-capacity.js";
import type { WorkflowIr, WorkflowFieldDefinition, WorkflowSettingDefinition } from "./workflow-ir-types.js";
import type { WorkflowMovePolicyInput } from "./workflow-extension-types.js";
import { type CustomFieldRejection } from "./task-fields.js";
// Side-effect import: registers the 14 built-in trait DEFINITIONS into the
// shared trait registry on load (the flag-ON path resolves traits by id).
import "./builtin-traits.js";
// Step-inversion U12 (KTD-12): the legacy `parseStepsFromPrompt` path resolves
// the `step-headings` parser through the registry (proving the registry path),
// staying byte-identical with the direct extracted function.
import type { StoredWorkflowRow, WorkflowDefinition, WorkflowDefinitionInput, WorkflowDefinitionUpdate, WorkflowNodeLayout } from "./workflow-definition-types.js";
import { type WorkflowParitySummary, type WorkflowColumnsGraduationReport } from "./workflow-parity.js";

/** Tags WorkflowStep rows materialized by compiling a workflow so they can be
 *  filtered out of the user-facing step manager and cleaned up on re-selection. */
export const WORKFLOW_COMPILED_STEP_TEMPLATE_PREFIX = "workflow:";
import { GlobalSettingsStore } from "./global-settings.js";
import { Database } from "./db.js";
import { ArchiveDatabase } from "./archive-db.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import { MissionStore } from "./mission-store.js";
import { AsyncMissionStore } from "./async-mission-store.js";
import { AsyncIdeationStore } from "./async-ideation-store.js";
import { reconcileSoftDeletedColumnDriftAsync } from "./task-store/async-self-healing.js";
import { PluginStore } from "./plugin-store.js";
import { InsightStore } from "./insight-store.js";
import { ResearchStore } from "./research-store.js";
import { ExperimentSessionStore } from "./experiment-session-store.js";
import { TodoStore } from "./todo-store.js";
import { AsyncTodoStore } from "./async-todo-store.js";
import { AsyncInsightStore } from "./async-insight-store.js";
import { AsyncResearchStore } from "./async-research-store.js";
import { GoalStore } from "./goal-store.js";
import { AsyncGoalStore } from "./async-goal-store.js";
import { EvalStore } from "./eval-store.js";
import { AsyncEvalStore } from "./async-eval-store.js";
import { CentralCore } from "./central-core.js";
import { SecretsStore } from "./secrets-store.js";
import { getLatestFailedPreMergeReviewStep } from "./task-merge.js";
import { createLogger } from "./logger.js";
import { type UsageEventInput } from "./usage-events.js";
import { assertNotLinkedWorktreeOfExistingProject, assertProjectRootDir } from "./project-root-guard.js";
import { type DistributedTaskIdAllocator } from "./distributed-task-id.js";
import { type TaskIdIntegrityReport } from "./task-id-integrity.js";

// file. These are pure behavior-invariant moves — the extracted symbols are
// byte-identical to their pre-extraction form. store.ts remains the facade and
// the single import source for all consumers (re-exports preserved below).
import { TASK_JSONB_COLUMNS, type TaskRow, type TaskPersistSerializationContext, type TaskColumnDescriptor } from "./task-store/persistence.js";
import { pgRowToTaskRow as pgRowToTaskRowExternal, rowToTask as rowToTaskExternal, rowToBranchGroup as rowToBranchGroupExternal, generateBranchGroupId as generateBranchGroupIdExternal, computeTimedExecutionMs as computeTimedExecutionMsExternal, archiveEntryToTask as archiveEntryToTaskExternal, summarizeAgentLog as summarizeAgentLogExternal, rowToTaskDocument as rowToTaskDocumentExternal, rowToArtifact as rowToArtifactExternal, rowToTaskDocumentRevision as rowToTaskDocumentRevisionExternal, rowToGoalCitation as rowToGoalCitationExternal } from "./task-store/serialization.js";
import { moveTaskImpl, handoffToReviewImpl, moveTaskInternalImpl } from "./task-store/moves.js";
import { recordGoalCitationsImpl, insertTaskWithFtsRecoveryImpl2, assertTaskIdAvailableImpl, atomicWriteTaskJsonImpl2, createTaskWithDistributedReservationImpl, toStoredWorkflowStepImpl, ensureWorkflowStepForTemplateImpl, resolveEnabledWorkflowStepsImpl, setTaskBranchGroupImpl, getTaskColumnsImpl, prepareWorkflowMovePolicyPreflightImpl, updateTaskCustomFieldsImpl, listWorkflowPromptOverridesForProjectImpl, listWorkflowWorkItemsForTaskImpl, listDueWorkflowWorkItemsImpl, rewriteBlockedByResidueDependentsForRemovalImpl, getAllDocumentsImpl, deleteWorkflowStepImpl, toWorkflowDefinitionImpl, materializeDefaultWorkflowStepsImpl, reconcileTaskCustomFieldsForSchemaImpl, getTaskMovedCountsByDayImpl, getGoalStoreImpl, upsertTaskCommitAssociationImpl } from "./task-store/remaining-ops-4.js";
import { applyLegacyWorkflowStepOverridesImpl, archiveDbImpl, assertNoDependencyCycleImpl, atomicCreateTaskJsonImpl, buildActiveTaskDependencyLookupImpl, buildArchivedAgentLogFieldsImpl, buildTaskIdIntegrityFallbackReportImpl, createBranchGroupImpl, dbImpl, detectAndCacheTaskIdIntegrityReportImpl, findLiveDependentsImpl, findLiveLineageChildrenImpl, getLegacyWorkflowStepSnapshotImpl, getMalformedTaskMetadataReasonImpl, getMergeQueuedTaskIdsAsyncImpl, insertRunAuditEventRowImpl, insertTaskImpl, invokeTaskCreatedHookImpl, isTaskArchivedImpl, isTaskIdPresentInArchivedTasksTableImpl, logTaskCreateConflictImpl, maybeResolveTombstonedTaskIdImpl, mergeTaskIdIntegrityReportsImpl, optionalGroupIdSetImpl, patchTaskRowInTransactionImpl, readConfigFastImpl, readConfigImpl, readPromptForArchiveImpl, readTaskFromDbImpl, reconcileDistributedTaskIdStateOnOpenImpl, recordActivityFromListenerImpl, recordDependencyCycleRejectedAuditImpl, refreshTaskIdIntegrityReportImpl, resolveLocalNodeIdForTaskAllocationImpl, runTaskFtsWriteWithRecoveryImpl, scanAndRecordCitationsImpl, taskIdExistsAnywhereImpl, throwSoftDeletedWriteBlockedImpl, toBuiltInWorkflowStepImpl, trackDeferredTaskCreatedWorkImpl, upsertTaskImpl, withConfigLockImpl, withTaskLockImpl, withWorktreeAllocationLockImpl } from "./task-store/remaining-ops-5.js";
import { claimNextToolFailureRetryImpl, createTaskVerificationRequestImpl, claimTaskVerificationRequestImpl, finishTaskVerificationRequestImpl, clearNearDuplicateReferencesToFailSoftImpl, clearWorkflowRunStepInstancesAsyncImpl, clearWorkflowRunStepInstancesImpl, computeMovedSettingsTargetWorkflowIdsImpl, ensureBranchGroupForSourceImpl, ensurePrEntityForSourceImpl, findRecentTasksByContentFingerprintImpl, getActiveMergingTaskImpl, getActivePrEntityBySourceImpl, getBranchGroupByBranchNameImpl, getBranchGroupBySourceImpl, getBranchGroupImpl, getBranchProgressByTaskImpl, getMutationsForRunImpl, getPrEntityByNumberImpl, getPrEntityImpl, getPrThreadStateImpl, getTasksByAssignedAgentImpl, getWorkflowPromptOverridesAsyncImpl, getWorkflowSettingValuesAsyncImpl, getWorkflowSettingValuesImpl, getWorkflowSettingsProjectIdImpl, getWorkflowWorkItemImpl, insertCompletionHandoffWorkflowWorkAuditImpl, listActivePrEntitiesImpl, listBranchGroupsImpl, listPrThreadStatesImpl, listTasksByBranchGroupImpl, listWorkflowSettingValuesForProjectImpl, loadWorkflowRunBranchesImpl, loadWorkflowRunStepInstancesAsyncImpl, loadWorkflowRunStepInstancesImpl, markToolFailureRetryExhaustedAuditImpl, mergeCustomFieldPatchImpl, normalizeMergeRequestStateImpl, normalizeWorkflowWorkItemKindImpl, normalizeWorkflowWorkItemStateImpl, parseWorkflowPromptOverrideJsonImpl, recordPrThreadOutcomeImpl, resetAllStepsToPendingImpl, resetPromptCheckboxesImpl, resolveWorkflowMoveActorImpl, resolveWorkflowSettingDeclarationsImpl, saveWorkflowRunStepInstanceAsyncImpl, saveWorkflowRunStepInstanceImpl, transitionMergeRequestStateImpl, transitionWorkflowWorkItemSyncImpl, updateTaskImpl, updateWorkflowPromptOverridesImpl, upsertMergeRequestRecordImpl, workflowStateForMergeRequestStateImpl } from "./task-store/remaining-ops-6.js";
import { addPrInfoImpl, addSteeringCommentImpl, archiveAllDoneImpl, cleanupStaleMergeQueueRowsImpl, clearCompletionHandoffAcceptedMarkerImpl, clearDoneTransientFieldsImpl, clearStaleExecutionStartBranchReferencesImpl, computeWorkflowColumnsGraduationReportImpl, deleteTaskCommentImpl, deleteTaskDocumentImpl, emitUsageEventImpl, enqueueMergeQueueImpl, getAgentLogCountImpl, getAgentLogsImpl, getArtifactImpl, getArtifactsImpl, getAttachmentImpl, getCompletionHandoffAcceptedMarkerImpl, getTaskDocumentImpl, getTaskDocumentRevisionsImpl, getTaskDocumentsImpl, insertArtifactRowImpl, linkGithubIssueImpl, listWorkflowWorkItemsForTaskSyncImpl, moveToDoneImpl, parseDependenciesFromPromptImpl, parseFileScopeFromPromptImpl, parseStepsFromPromptImpl, peekMergeQueueHeadImpl, peekMergeQueueImpl, readPreArchiveColumnFromTaskFileImpl, recordPluginActivationImpl, recordRunAuditEventBackendImpl, removePrInfoByNumberImpl, resolvePrimaryPrInfoImpl, resolveUnarchiveTargetColumnImpl, rewriteLineageChildrenForRemovalImpl, runGitCommandImpl, stopWatchingImpl, syncAgentTaskLinkOnReassignmentImpl, updateArtifactImpl, updateGithubTrackingImpl, updatePrInfoByNumberImpl, updateTaskCommentImpl, upsertPrInfoByNumberImpl, writeArtifactDataImpl } from "./task-store/remaining-ops-7.js";
import { approveCliAutonomyImpl, approveWorkflowCliCommandImpl, cleanupOrphanedMaterializedStepsImpl, consumePluginGateVerdictsImpl, getAgentLogsByTimeRangeImpl, getDatabaseHealthImpl, getDistributedTaskIdAllocatorImpl, getExperimentSessionStoreImpl, getInReviewDurationEventsImpl, getMissionStoreImpl, getIdeationStoreImpl, getPluginStoreImpl, getSecretsStoreImpl, getSettingsSyncImpl, getTaskMergedTaskIdsImpl, getTaskWorkflowSelectionImpl, getImportTranslationImpl, recordImportTranslationImpl, pruneImportTranslationsImpl, type ImportTranslationCacheKey, type ImportTranslationCacheEntry, getVerificationCacheHitImpl, getWorkflowDefinitionImpl, healthCheckImpl, importLegacyAgentLogsOnceImpl, insertWorkflowDefinitionSyncImpl, isCliAutonomyApprovedImpl, isPluginInstalledImpl, isWorkflowCliCommandApprovedImpl, listWorkflowDefinitionsImpl, materializeExplicitWorkflowStepsImpl, materializeWorkflowStepsImpl, migrateActiveArchivedTasksToArchiveDbImpl, migrateLegacyArchiveEntriesToArchiveDbImpl, nextWorkflowDefinitionIdImpl, occupantsByColumnForWorkflowImpl, parseWorkflowLayoutImpl, pruneAgentLogFilesImpl, purgeTaskWorkflowSelectionRowsImpl, readAllWorkflowDefinitionsImpl, readRawProjectSettingsImpl, recordPluginGateVerdictImpl, recordVerificationCachePassImpl, removeMaterializedSelectionImpl, resolvePluginWorkflowStepImpl, resolveTaskWorkflowIrSyncImpl, revokeCliAutonomyImpl, selectTaskWorkflowAndReconcileImpl, writeTaskWorkflowSelectionImpl, getTaskWorkflowSelectionAsyncImpl,  } from "./task-store/workflow-definitions.js";
import { getTaskCommitAssociationsByLineageIdImpl, replaceLegacyTaskCommitAssociationsImpl } from "./task-store/task-commit-associations.js";
import { findRecentTasksBySourceParentTaskIdImpl } from "./task-store/remaining-ops-6.js";
import { addTaskCommentImpl, applyBuiltInPromptOverridesSyncImpl, areAllDependenciesDoneImpl, artifactStoredNameImpl, assertWorkflowIrTraitsValidImpl, clearActivityLogImpl, clearTaskWorkflowSelectionImpl, deleteTaskByIdImpl, getDefaultWorkflowIdImpl, getInsightStoreImpl, getMergeQueuedTaskIdsImpl, getMergeRequestRecordImpl, getMergeRequestRecordAsyncImpl, getResearchStoreImpl, getTaskIdFromDirImpl, getTodoStoreImpl, getWorkflowWorkItemByIdentityImpl, hasActiveTaskImpl, invalidateConfigCacheAfterMigrationImpl, isTaskIdConflictErrorImpl, listLegacyAutoMergeStampCandidatesImpl, readTaskRowFromDbImpl, recordBranchGroupMemberLandedImpl, refreshDatabaseHealthImpl, resolveEffectiveWorkflowIdSyncImpl, resolveTaskCustomFieldDefsSyncImpl, resolveWorkflowBypassGuardsImpl, serializeConfigForDiskImpl, setPluginWorkflowStepTemplatesImpl, shouldSkipWorkflowMovePoliciesImpl, suppressWatcherImpl, upsertTaskWithFtsRecoveryImpl } from "./task-store/task-store-helpers.js";
import { getTaskSelectClauseImpl2, createTaskPersistSerializationContextImpl, getTaskPersistValuesImpl, getTaskPatchDescriptorsImpl, normalizeTaskFromDiskImpl, writeTaskJsonFileImpl, rowToPrEntityImpl, generatePrEntityIdImpl, readTaskForMoveImpl, rowToMergeQueueEntryImpl, rowToMergeRequestRecordImpl, rowToCompletionHandoffMarkerImpl, rowToWorkflowWorkItemImpl, rowToRunAuditEventImpl } from "./task-store/task-row-mappers.js";
import { getTaskSelectClauseWithActivityLogLimitImpl, getChangedTaskColumnsImpl, getSoftDeletedWriteConflictImpl, readTaskJsonImpl, writeConfigImpl, _maybeAutoArchiveSameAgentDuplicateBackendImpl, updateBranchGroupImpl, updatePrEntityImpl, listTasksForGithubTrackingReconcileImpl, listTasksForGitlabTrackingReconcileImpl, renewCheckoutLeaseImpl, updateTaskAtomicImpl, getWorkflowPromptOverridesImpl, updateWorkflowSettingValuesImpl, rollbackConfigurationImpl, cancelActiveWorkflowWorkItemsForTaskImpl, setCompletionHandoffAcceptedMarkerImpl, reconcileLegacyAutoMergeStampsImpl, recoverExpiredMergeQueueLeasesImpl, rewriteDependentsForRemovalImpl, cleanupBranchForTaskImpl, addAttachmentImpl, deleteAttachmentImpl, registerArtifactImpl, updatePrInfoImpl, unlinkGithubIssueImpl, cleanupArchivedTasksImpl, generatePromptFromArchiveEntryImpl, listWorkflowOccupantTaskIdsImpl, evacuateCustomColumnsToLegacyImpl, listApprovedCliAutonomyAdaptersImpl, closeImpl, getActivityLogImpl } from "./task-store/remaining-ops-2.js";
import { getOrCreateForProjectImpl, listGoalCitationsImpl, atomicWriteTaskJsonWithAuditImpl, duplicateTaskImpl, listStrandedRefinementsImpl, tryClaimCheckoutImpl, evaluateWorkflowMovePoliciesImpl, recordRunAuditEventImpl, getRunAuditEventsImpl, getWorkflowParitySummaryImpl, dequeueMergeQueueOnColumnExitImpl, updateIssueInfoImpl, listWorkflowStepsImpl, getWorkflowStepImpl, createWorkflowDefinitionImpl, countActiveInCapacitySlotSyncImpl, countActiveInCapacitySlotAsyncImpl, generateSpecifiedPromptImpl, recordActivityImpl, getEvalStoreImpl } from "./task-store/remaining-ops-1.js";
import { markLegacyAutoMergeStampsOnceImpl, appendAgentLogImpl, importLegacyAgentLogsImpl, cleanupNoOpTaskMovedActivityRowsOnceImpl, runWorkflowColumnsIntegrityPassImpl, backfillCommitAssociationDiffStatsImpl } from "./task-store/workflow-integrity.js";
import { saveWorkflowRunBranchImpl, clearNearDuplicateReferencesToImpl, selectNextTaskForAgentImpl, pauseTaskImpl, clearLinkedAgentTaskIdsImpl, listArtifactsImpl, rehomeOccupantImpl } from "./task-store/branch-group-ops.js";
import { taskToArchiveEntryImpl, deleteTaskBackendImpl, archiveTaskBackendImpl, unarchiveTaskImpl, restoreFromArchiveImpl, listArchivedTasksImpl } from "./task-store/archive-lifecycle-2.js";
import { pruneOperationalLogsAsync, pruneAgentLogFilesAsync, type OperationalLogPruneResult } from "./task-store/async-maintenance.js";
import { reconcilePhantomCommittedReservationsAsync } from "./task-store/async-phantom-reservations.js";
import { acquireSymbolLocksAsync, inspectSymbolLockConflictsAsync, reconcileStaleSymbolLocksAsync, releaseSymbolLocksAsync, renewSymbolLocksAsync } from "./task-store/symbol-locks.js";
import type { AcquireSymbolLocksResult, ReconcileStaleSymbolLocksResult, ReleaseSymbolLocksResult, RenewSymbolLocksResult, SymbolLockConflict, SymbolLockOwner } from "./symbol-lock-types.js";
import { queryRunAuditEvents } from "./task-store/async-audit.js";
import { isValidMergeRequestTransitionImpl, enqueueMergeQueueSyncInternalImpl, releaseMergeQueueLeaseImpl, collectMergeDetailsImpl, applyPrMergedTransitionImpl } from "./task-store/merge-queue-ops-2.js";
import { upsertWorkflowWorkItemImpl, transitionWorkflowWorkItemImpl, acquireWorkflowWorkItemLeaseImpl } from "./task-store/workflow-workitems-ops-2.js";
import { getSettingsImpl, getSettingsFastImpl, getSettingsByScopeImpl, getSettingsByScopeFastImpl } from "./task-store/settings-ops-2.js";
import { runPluginColumnTransitionHooksImpl, logEntryImpl } from "./task-store/audit-ops.js";
import { clearWorkflowRunBranchesImpl, projectMergeRequestToWorkflowWorkItemImpl, createCompletionHandoffWorkflowWorkImpl } from "./task-store/workflow-workitems-ops.js";
import { flushAgentLogBufferImpl, appendAgentLogBatchImpl } from "./task-store/agent-logs.js";
import { refineTaskImpl, updateTaskDependenciesImpl } from "./task-store/update-task-deps.js";
import { createWorkflowStepImpl, updateWorkflowStepImpl, updateWorkflowDefinitionImpl, deleteWorkflowDefinitionImpl, setDefaultWorkflowIdImpl, selectTaskWorkflowImpl } from "./task-store/workflow-ops.js";
import { initImpl, setupActivityLogListenersImpl, reconcileOrphanedTaskDirsImpl, watchImpl, checkForChangesImpl, migrateAgentLogEntriesImpl, migrateMovedSettingsImpl, recoverStaleTransitionPendingImpl, migrateLegacyWorkflowStepsImpl, emitTaskLifecycleEventSafelyImpl } from "./task-store/lifecycle-ops.js";
import { updateStepImpl, acquireMergeQueueLeaseImpl, mergeTaskImpl } from "./task-store/merge-queue-ops.js";
import { addCommentImpl, upsertTaskDocumentImpl } from "./task-store/comments-ops.js";
import { deleteTaskImpl, archiveTaskImpl } from "./task-store/archive-lifecycle.js";
import { updateSettingsImpl, updateGlobalSettingsImpl } from "./task-store/settings-ops.js";
import { createTaskBackendImpl, _createTaskInternalBackendImpl, createTaskImpl, createTaskWithReservedIdImpl, _createTaskInternalImpl, _maybeAutoArchiveSameAgentDuplicateImpl } from "./task-store/task-creation.js";
import { getTaskImpl, listTasksImpl, searchTasksImpl, listTasksModifiedSinceImpl, getTaskVerificationRequestAsyncImpl } from "./task-store/reads.js";
import { updateTaskUnlockedImpl } from "./task-store/task-update.js";
import { __setTaskActivityLogLimitsForTesting } from "./task-store/comments.js";
// FNXC:RuntimeBackendAsync 2026-06-24-10:15:
// Async helper imports for backend-mode (AsyncDataLayer/PostgreSQL) delegation.
// persistence/allocator/settings/search/lifecycle/merge/archive helpers preserve
// the handoff-to-review invariant (VAL-DATA-013), merge-queue lease semantics
// (VAL-DATA-014), lineage-integrity gate (VAL-DATA-010/012), and archive
// snapshot atomicity (VAL-CROSS-014/015). Drizzle queries target the PG schema.
import type { BranchGroupRow, PrEntityRow, TaskDocumentRow, ArtifactRow, TaskDocumentRevisionRow, GoalCitationRow, RunAuditEventRow, MergeQueueRow, MergeRequestRow, CompletionHandoffMarkerRow, WorkflowWorkItemRow } from "./task-store/row-types.js";

/** Database row shape for the tasks table (all columns). */


export interface TaskStoreEvents {
  "task:created": [task: Task];
  "task:moved": [data: { task: Task; from: ColumnId; to: ColumnId; source: "user" | "engine" | "scheduler" }];
  "task:updated": [task: Task];
  "task:deleted": [task: Task, meta?: { githubIssueAction?: GithubIssueAction }];
  "task:merged": [result: MergeResult];
  "settings:updated": [data: { settings: Settings; previous: Settings }];
  "workflow:setting-values-updated": [data: {
    workflowId: string;
    projectId: string;
    settingIds: string[];
    mutationId: string;
  }];
  "artifact:registered": [artifact: Artifact];
  "artifact:updated": [artifact: Artifact];
  "agent:log": [entry: AgentLogEntry];
  "merger:autostashOrphans": [data: {
    rootDir: string;
    records: AutostashOrphanRecord[];
  }];
}

  /** Thrown by deleteTask when the target task is referenced by at least one other live task's dependencies array. Callers must rewrite/drop references before deleting. */

// Module-level constants retained by the facade. RECONCILE_ORPHAN_TASK_DIR_MAX_AGE_MS
// bounds the orphan sweep to 7 days (recent heartbeats/corruption, not ancient dirs).
export const RECONCILE_ORPHAN_TASK_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const storeLog = createLogger("task-store");
export const coreLog = createLogger("core");
export const TASK_BRANCH_CONTEXT_METADATA_KEY = "fusionBranchContext";

export type TaskDependencyMutation =
  | { operation: "add"; dependency: string }
  | { operation: "remove"; dependency: string }
  | { operation: "replace"; from: string; to: string }
  | { operation: "set"; dependencies: string[] };

// detectors, dependency-cycle detectors, and merge-queue/transition errors were
// extracted to ./task-store/errors.ts and ./task-store/file-scope.ts. They are
// re-imported at the top of this file and re-exported below for back-compat.

// `parseStepHeadings` re-exported here for back-compat; extracted to step-parsers.ts (KTD-12).
export { parseStepHeadings } from "./step-parsers.js";

// Re-export extracted symbols (VAL-DECOMPOSE-002: facade preserves every public method signature).
export {
  TaskHasDependentsError,
  TaskSelfDeleteError,
  TaskDeletedError,
  TombstonedTaskResurrectionError,
  TaskHasLineageChildrenError,
  InvalidFileScopeError,
  SELF_DEFEATING_OPERATION_VERBS,
  SelfDefeatingDependencyError,
  detectSelfDefeatingDependency,
  DependencyCycleError,
  detectDependencyCycle,
  MergeQueueTaskNotFoundError,
  MergeQueueInvalidColumnError,
  MergeQueueLeaseOwnershipError,
  InvalidMergeQueueLeaseDurationError,
  HandoffInvariantViolationError,
  TransitionRejectionError,
} from "./task-store/errors.js";
export { isValidFileScopeEntry } from "./task-store/file-scope.js";
export { __setTaskActivityLogLimitsForTesting } from "./task-store/comments.js";

/** @internal Extracted to task-store/moves.ts */
export interface MoveTaskOptions {
  preserveResumeState?: boolean;
  preserveProgress?: boolean;
  preserveWorktree?: boolean;
  preserveStatus?: boolean;
  /**
   * FNXC:WorkflowLifecycle 2026-07-12-09:05:
   * Keep `paused`/`pausedByAgentId`/`pausedReason` (and any existing
   * `userPaused`) across a reopen-to-todo/triage move. Used by the executor's
   * pause teardown so a user pause survives its own hard-cancel re-queue and
   * the row stays parked until an explicit unpause (FN-7851 pause-bounce loop).
   * Never SETS a pause — only prevents the reopen block from clearing one.
   */
  preservePause?: boolean;
  allocateWorktree?: (reservedNames: Set<string>) => string | null;
  moveSource?: "user" | "engine" | "scheduler";
  workflowMoveActor?: WorkflowMovePolicyInput["actor"];
  workflowMoveSource?: string;
  workflowMoveMetadata?: Record<string, unknown>;
  skipMergeBlocker?: boolean;
  allowDirectInReviewMove?: boolean;
  /** KTD-9: engine/recovery moves bypass trait guards and abort-on-exit effects (the generalization of skipMergeBlocker). NEVER bypasses capacity (KTD-10). Engine-internal only: HTTP endpoints hardcode it off. When unset, derived from moveSource === "engine" plus skipMergeBlocker. */
  bypassGuards?: boolean;
  /** U5 (R15/R20): workflow-reconciliation re-home move. Skips adjacency check (step 2) in addition to bypassGuards. Structural unknown-column check (step 1) and capacity check (KTD-10) still apply. Engine-internal only. When set, implies bypassGuards. */
  recoveryRehome?: boolean;
}

/** @internal Extracted to task-store/moves.ts */
export interface MoveTaskInternalOptions {
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

export const WORKFLOW_MOVE_POLICY_TIMEOUT_MS = 5000;

export interface LegacyAutoMergeStampReconcileResult {
  taskId: string;
  column: string;
  cleared: boolean;
}

export const LEGACY_AUTO_MERGE_STAMP_MARKER_KEY = "legacyAutoMergeStampMarkedVersion";
export const LEGACY_AUTO_MERGE_STAMP_MARKER_VERSION = "1";

function normalizeRepairOverlapPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function repairOverlapPathPrefix(path: string): string | null {
  /*
  FNXC:OverlapRepair 2026-06-25-11:50:
  Store-side repair must mirror the scheduler's current file-scope overlap contract. Treat `/*` and trailing-slash entries as directory prefixes, but do not independently expand `/**`; otherwise repair can refuse or reroute blockers the next scheduler tick would immediately clear.
  */
  const normalized = normalizeRepairOverlapPath(path);
  if (normalized.endsWith("/*")) return normalized.slice(0, -1);
  if (normalized.endsWith("/")) return normalized;
  return null;
}

function repairScopesOverlap(a: string[], b: string[]): boolean {
  for (const rawA of a) {
    const pa = normalizeRepairOverlapPath(rawA);
    const prefixA = repairOverlapPathPrefix(pa);
    const cleanA = prefixA ? prefixA.replace(/\/$/, "") : pa;
    for (const rawB of b) {
      const pb = normalizeRepairOverlapPath(rawB);
      const prefixB = repairOverlapPathPrefix(pb);
      const cleanB = prefixB ? prefixB.replace(/\/$/, "") : pb;
      if (cleanA === cleanB || pa === pb) return true;
      if (prefixA && (pb === cleanA || pb.startsWith(prefixA))) return true;
      if (prefixB && (pa === cleanB || pa.startsWith(prefixB))) return true;
      if (prefixA && prefixB && (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA))) return true;
    }
  }
  return false;
}

function repairIgnoredOverlapPath(path: string, ignorePath: string): boolean {
  const normalizedPath = normalizeRepairOverlapPath(path);
  const normalizedIgnore = normalizeRepairOverlapPath(ignorePath);
  const prefix = repairOverlapPathPrefix(normalizedIgnore);
  if (prefix) {
    const clean = prefix.replace(/\/$/, "");
    return normalizedPath === clean || normalizedPath.startsWith(prefix);
  }
  return normalizedPath === normalizedIgnore || normalizedPath.startsWith(`${normalizedIgnore}/`);
}

function filterRepairOverlapIgnoredPaths(paths: string[], ignorePaths: string[]): string[] {
  if (ignorePaths.length === 0) return paths;
  return paths.filter((path) => !ignorePaths.some((ignorePath) => repairIgnoredOverlapPath(path, ignorePath)));
}

export class TaskStore extends EventEmitter<TaskStoreEvents> {
  public static readonly ACTIVE_TASKS_WHERE = '"deletedAt" IS NULL';
  /**
   * FNXC:RuntimePersistenceAsync 2026-06-24-10:42: Task-table columns stored as jsonb in PostgreSQL.
   * pgRowToTaskRow() re-serializes them to strings so rowToTask() works unchanged across both backends.
   * The shared persistence registry is the canonical read/write list for both PostgreSQL conversion paths.
   */
  public static readonly PG_JSONB_TASK_COLUMNS: ReadonlySet<string> = TASK_JSONB_COLUMNS;
  /** All tasks share one per-column capacity pool (KTD-10). */
  public static readonly DEFAULT_WORKFLOW_POOL_ID = DEFAULT_WORKFLOW_POOL_ID;

  /** FNXC:RuntimeBackendInjection 2026-06-24-14:20: Backend-mode factory. */
  static async getOrCreateForProject( projectId?: string, centralCore?: CentralCore, globalSettingsDir?: string, asyncLayer?: AsyncDataLayer, ): Promise<TaskStore> {
    return getOrCreateForProjectImpl(this, projectId, centralCore, globalSettingsDir, asyncLayer);
  }

  /** FNXC:PostgresRuntimeStorage 2026-07-14-18:47: Task metadata is authoritative in PostgreSQL; task document/blob files remain on disk. */
  public fusionDir: string;
  public tasksDir: string;
  public configPath: string;
  public _db: Database | null = null;
  public activityListenersWired = false;
  /** When true, activity-log listeners skip recording (set by checkForChanges polling so re-emitted events don't double-log). In-process emit path remains sole source of truth. */
  public suppressActivityLogForPollingEmit = false;
  public _archiveDb: ArchiveDatabase | null = null;

  /**
   * FNXC:PostgresRuntimeStorage 2026-07-14-18:47: Production TaskStores receive an AsyncDataLayer and delegate all persistence to PostgreSQL. A missing layer is a construction error; retained sync members exist only until compatibility tests and types are removed.
   */
  public readonly asyncLayer: AsyncDataLayer | null = null;
  private pluginPostgresSchemaExecutor: ((contracts: readonly LoadedPluginSchemaContract[]) => Promise<void>) | null = null;

  /*
  FNXC:HandoffFailureInjection 2026-07-15-12:00:
  PostgreSQL handoffs call enqueueMergeQueueInTransaction directly, bypassing the
  legacy enqueueMergeQueueSyncInternal spy. Keep this test-only hook dormant in
  production so VAL-DATA-013 can inject a late transaction failure and prove every
  handoff sub-write rolls back without adding queries or runtime behavior.
  */
  private handoffMergeQueueFailureInjectorForTesting: ((taskId: string) => void | Promise<void>) | null = null;

  /** True when the mandatory production AsyncDataLayer was injected. */
  /** @internal TaskStore decomposition: accessible to extracted modules */
  public get backendMode(): boolean {
    return this.asyncLayer !== null;
  }

  public watcher: FSWatcher | null = null;
  public taskCache: Map<string, Task> = new Map();
/** U8 (KTD-2): pre-evaluated plugin gate verdicts, keyed `taskId` → `toColumn` */
  public pluginGateVerdicts: Map<string, Map<string, PluginGateVerdict[]>> = new Map();
  public recentlyWritten: Set<string> = new Set();
  public debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  public debounceMs = 150;
  public taskLocks: Map<string, Promise<void>> = new Map();
  public closing = false;
  public deferredTaskCreatedWork = new Set<Promise<void>>();
  /**
   * FNXC:CoreTests 2026-06-20-05:17:
   */
  public trackDeferredTaskCreatedWork(work: () => Promise<void>): Promise<void> {
    return trackDeferredTaskCreatedWorkImpl(this, work);
  }
  public worktreeAllocationLock: Promise<void> = Promise.resolve();
  public configLock: Promise<void> = Promise.resolve();
  public taskIdStateReconciled = false;
  /** Set when startup auto-recovery rebuilt a corrupt fusion.db; lets the orphan reconcile bypass its recency window so rows dropped by `.recover` are recovered even with old task.json mtimes. */
  public dbWasCorruptionRecovered = false;
  public taskIdIntegrityReport: TaskIdIntegrityReport = { status: "ok", checkedAt: new Date().toISOString(), anomalies: [] };
  public lastTaskIdIntegrityLogSignature: string | null = null;
  public workflowStepsCache: import("./types.js").WorkflowStep[] | null = null;
  public workflowDefinitionsCache: WorkflowDefinition[] | null = null;
  public _pluginWorkflowStepTemplates: Array<{ pluginId: string; template: WorkflowStepTemplate }> = [];
  public globalSettingsStore: GlobalSettingsStore;
  public pollInterval: ReturnType<typeof setInterval> | null = null;
  public pollingInProgress = false;
  public lastKnownModified: number = 0;
  public lastPollTime: string | null = null;
  public donePauseBackfillDone = false;
  public startupSlimListMemo = new Map<string, { expiresAt: number; promise: Promise<Task[]> }>();
  public static readonly STARTUP_SLIM_LIST_MEMO_TTL_MS = 2_500;

  public get isWatching(): boolean {
    return this.watcher !== null || this.pollInterval !== null;
  }
  public missionStore: MissionStore | AsyncMissionStore | null = null;
  public ideationStore: AsyncIdeationStore | null = null;
  public pluginStore: PluginStore | null = null;
  public insightStore: InsightStore | AsyncInsightStore | null = null;
  public researchStore: ResearchStore | AsyncResearchStore | null = null;
  public experimentSessionStore: ExperimentSessionStore | null = null;
  public todoStore: TodoStore | AsyncTodoStore | null = null;
  public goalStore: GoalStore | AsyncGoalStore | null = null;
  public evalStore: EvalStore | AsyncEvalStore | null = null;
  public secretsStore: SecretsStore | null = null;
  public secretsCentralCore: CentralCore | null = null;
  public distributedTaskIdAllocator: DistributedTaskIdAllocator | null = null;

  /**
   * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-12:50: Async DistributedTaskIdAllocator for backend mode. Lazily constructed from the AsyncDataLayer.
   * This is the PostgreSQL-backed allocator that handles task ID reservation/commit/abort against the distributed_task_id tables.
   */
  public asyncDistributedTaskIdAllocator: DistributedTaskIdAllocator | null = null;

  public agentLogBuffer: Array<{
    taskId: string;
    timestamp: string;
    text: string;
    type: AgentLogEntry["type"];
    detail: string | null;
    agent: AgentLogEntry["agent"] | null;
    durationMs: number | null;
    timeToFirstTokenMs: number | null;
  }> = [];
  public agentLogFlushTimer: ReturnType<typeof setTimeout> | null = null;
  public static readonly AGENT_LOG_BUFFER_SIZE = 50;
  public static readonly AGENT_LOG_FLUSH_MS = 2000;
  public static readonly MAX_AGENT_LOG_BACKLOG = 5_000;

  /*
  FNXC:SqliteRemoval 2026-06-25-18:30:
  The inMemoryDb option has been removed. The SQLite runtime (Database class) is being
  deleted as the final step of the SQLite-to-PostgreSQL cutover. All tests that used
  inMemoryDb:true have been quarantined. Production code always uses disk-backed SQLite
  in non-backend mode (or PostgreSQL in backend mode via asyncLayer).
  */

  public readonly globalSettingsDir?: string;

  /*
  FNXC:GlobalDirGuard 2026-06-25-22:13:
  Upstream (origin/main) uses getGlobalSettingsDir() as a method. Our modularized
  store uses a property. This method bridges the two patterns.
  */
  getGlobalSettingsDir(): string | undefined {
    return this.globalSettingsDir;
  }

  /** FNXC:RuntimeBackendInjection 2026-06-24-14:05: asyncLayer → backend mode (PostgreSQL, no SQLite); absent → legacy SQLite. */
  constructor( public rootDir: string, globalSettingsDir?: string, options?: { asyncLayer?: AsyncDataLayer }, ) {
    super();
    this.setMaxListeners(100);
    assertProjectRootDir(rootDir, "TaskStore");
    assertNotLinkedWorktreeOfExistingProject(rootDir, "TaskStore");
    this.fusionDir = join(rootDir, ".fusion");
    this.tasksDir = join(this.fusionDir, "tasks");
    this.configPath = join(this.fusionDir, "config.json");
    this.asyncLayer = options?.asyncLayer ?? null;
    const resolvedGlobalSettingsDir = globalSettingsDir
      ?? (process.env.VITEST === "true" ? join(rootDir, ".fusion-global-settings") : undefined);
    this.globalSettingsDir = resolvedGlobalSettingsDir;
    this.globalSettingsStore = new GlobalSettingsStore(resolvedGlobalSettingsDir, this.asyncLayer ?? undefined);
  }
  public emitTaskLifecycleEventSafely( event: "task:created" | "task:updated", args: TaskStoreEvents["task:created"] | TaskStoreEvents["task:updated"], ): boolean {
    return emitTaskLifecycleEventSafelyImpl(this, event, args);
  }

  /**
   * FNXC:RuntimeBackendInjection 2026-06-24-14:10: In backend mode this getter must never be reached (all access via async layer).
   * Reaching it is a programming error — throws rather than constructing SQLite.
   */
  /** @internal TaskStore decomposition */
  public get db(): Database {
    return dbImpl(this);
  }

  /** @internal In backend mode, archive DB lives in PostgreSQL; reaching this throws. */
  /** @internal TaskStore decomposition */
  public get archiveDb(): ArchiveDatabase {
    return archiveDbImpl(this);
  }
  public buildTaskIdIntegrityFallbackReport(): TaskIdIntegrityReport {
    return buildTaskIdIntegrityFallbackReportImpl(this);
  }
  public detectAndCacheTaskIdIntegrityReport(): TaskIdIntegrityReport {
    return detectAndCacheTaskIdIntegrityReportImpl(this);
  }
  public mergeTaskIdIntegrityReports(...reports: TaskIdIntegrityReport[]): TaskIdIntegrityReport {
    return mergeTaskIdIntegrityReportsImpl(this, ...reports);
  }
  refreshTaskIdIntegrityReport(): TaskIdIntegrityReport {
    return refreshTaskIdIntegrityReportImpl(this);
  }
  getTaskIdIntegrityReport(): TaskIdIntegrityReport {
    return this.taskIdIntegrityReport;
  }
  public reconcileDistributedTaskIdStateOnOpen(): void {
    return reconcileDistributedTaskIdStateOnOpenImpl(this);
  }
  async init(): Promise<void> {
    return initImpl(this);
  }

  // ── Row <-> Task Conversion ────────────────────────────────────────

  /**
   * Convert a database row to a Task object, parsing JSON columns.
   */
  /**
   * FNXC:RuntimePersistenceAsync 2026-06-24-10:40: Convert a PostgreSQL Drizzle row to the TaskRow shape so rowToTask() can deserialize it.
   * PostgreSQL jsonb columns come back as already-parsed JS values (VAL-SCHEMA-004); SQLite stores them as TEXT requiring fromJson().
   * This helper re-serializes jsonb values to strings so the existing rowToTask() deserializer works unchanged across both backends.
   */
  public pgRowToTaskRow(row: Record<string, unknown>): TaskRow {
    return pgRowToTaskRowExternal<TaskRow>(row, TaskStore.PG_JSONB_TASK_COLUMNS);
  }
  public rowToTask(row: TaskRow): Task {
    return rowToTaskExternal(row);
  }
  public rowToBranchGroup(row: BranchGroupRow): BranchGroup {
    return rowToBranchGroupExternal(row);
  }
  public generateBranchGroupId(): string {
    return generateBranchGroupIdExternal();
  }
  public archiveEntryToTask(entry: ArchivedTaskEntry, slim = false): Task {
    return archiveEntryToTaskExternal(entry, slim);
  }
  public summarizeAgentLog(entries: AgentLogEntry[], totalCount: number): string | undefined {
    return summarizeAgentLogExternal(entries, totalCount);
  }
  public async readPromptForArchive(taskId: string): Promise<string | undefined> {
    return readPromptForArchiveImpl(this, taskId);
  }
  public async buildArchivedAgentLogFields( taskId: string, mode: ArchiveAgentLogMode, ): Promise<Pick<ArchivedTaskEntry, "agentLogMode" | "agentLogSummary" | "agentLogSnapshot" | "agentLogFull">> {    return buildArchivedAgentLogFieldsImpl(this, taskId, mode);
  }
  public async taskToArchiveEntry(task: Task, archivedAt: string): Promise<ArchivedTaskEntry> {
    return taskToArchiveEntryImpl(this, task, archivedAt);
  }

  /**
   * Convert a task_documents row to a TaskDocument object.
   */
  public rowToTaskDocument(row: TaskDocumentRow): TaskDocument {
    return rowToTaskDocumentExternal(row);
  }

  /**
   * Convert an artifacts row to an Artifact object.
   */
  public rowToArtifact(row: ArtifactRow): Artifact {
    return rowToArtifactExternal(row);
  }
  public rowToTaskDocumentRevision(row: TaskDocumentRevisionRow): TaskDocumentRevision {
    return rowToTaskDocumentRevisionExternal(row);
  }
  public rowToGoalCitation(row: GoalCitationRow): GoalCitation {
    return rowToGoalCitationExternal(row);
  }

  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-16:45:
   */
  async recordGoalCitations(inputs: GoalCitationInput[]): Promise<GoalCitation[]> {
    return recordGoalCitationsImpl(this, inputs);
  }
  async listGoalCitations(filter: GoalCitationFilter = {}): Promise<GoalCitation[]> {
    return listGoalCitationsImpl(this, filter);
  }
  public scanAndRecordCitations( text: string, surface: GoalCitationSurface, sourceRef: string, agentId: string, taskId?: string, timestamp?: string, ): GoalCitationInput[] {
    return scanAndRecordCitationsImpl(this, text, surface, sourceRef, agentId, taskId, timestamp);
  }
  public getTaskSelectClause(slim: boolean, tableAlias?: string): string {
    return getTaskSelectClauseImpl2(this, slim, tableAlias);
  }
  public computeTimedExecutionMs(log: import("./types.js").TaskLogEntry[] | undefined): number {
    return computeTimedExecutionMsExternal(log);
  }
  public getTaskSelectClauseWithActivityLogLimit(limit: number): string {
    return getTaskSelectClauseWithActivityLogLimitImpl(this, limit);
  }
  public createTaskPersistSerializationContext( task: Task, existingRow?: Pick<TaskRow, "lineageId">, ): TaskPersistSerializationContext {
    return createTaskPersistSerializationContextImpl(this, task, existingRow);
  }
  public getTaskPersistValues(task: Task, existingRow?: Pick<TaskRow, "lineageId">): unknown[] {
    return getTaskPersistValuesImpl(this, task, existingRow);
  }
  public readTaskRowFromDb(id: string, options?: { includeDeleted?: boolean }): TaskRow | undefined {
    return readTaskRowFromDbImpl(this, id, options);
  }
  public insertTask(task: Task): void {
    return insertTaskImpl(this, task);
  }
  public upsertTask(task: Task): void {
    return upsertTaskImpl(this, task);
  }
  public isTaskIdConflictError(error: unknown): boolean {
    return isTaskIdConflictErrorImpl(this, error);
  }
  public logTaskCreateConflict(task: Task, operation: string, error: unknown): void {
    return logTaskCreateConflictImpl(this, task, operation, error);
  }
  public insertTaskWithFtsRecovery(task: Task, operation: string): void {
    insertTaskWithFtsRecoveryImpl2(this, task, operation);
  }
  public runTaskFtsWriteWithRecovery(taskId: string, operation: string, write: () => void): void {
    return runTaskFtsWriteWithRecoveryImpl(this, taskId, operation, write);
  }
  public upsertTaskWithFtsRecovery(task: Task): void {
    return upsertTaskWithFtsRecoveryImpl(this, task);
  }
  public getTaskPatchDescriptors(changedColumns: Iterable<keyof TaskRow>): TaskColumnDescriptor[] {
    return getTaskPatchDescriptorsImpl(this, changedColumns);
  }
  public getChangedTaskColumns(existingRow: TaskRow, task: Task): Set<keyof TaskRow> {
    return getChangedTaskColumnsImpl(this, existingRow, task);
  }
  public patchTaskRowInTransaction( id: string, task: Task, changedColumns: Iterable<keyof TaskRow>, existingRow?: TaskRow, ): { deletedAt?: string; current?: Task } {
    return patchTaskRowInTransactionImpl(this, id, task, changedColumns, existingRow);
  }
  public readTaskFromDb(id: string, options?: { activityLogLimit?: number; includeDeleted?: boolean }): Task | undefined {
    return readTaskFromDbImpl(this, id, options);
  }
  public getMergeQueuedTaskIds(): Set<string> {
    return getMergeQueuedTaskIdsImpl(this);
  }

  /**
   * FNXC:RuntimePersistenceAsync 2026-06-24-10:45:
   */
  public async getMergeQueuedTaskIdsAsync(): Promise<Set<string>> {
    return getMergeQueuedTaskIdsAsyncImpl(this);
  }
  public isTaskIdPresentInArchivedTasksTable(id: string): boolean {
    return isTaskIdPresentInArchivedTasksTableImpl(this, id);
  }
  public async taskIdExistsAnywhere(id: string): Promise<boolean> {
    return taskIdExistsAnywhereImpl(this, id);
  }
  public async assertTaskIdAvailable(id: string): Promise<void> {
    await assertTaskIdAvailableImpl(this, id);
  }
  public async maybeResolveTombstonedTaskId( id: string, input: Pick<TaskCreateInput, "forceResurrect">, operation: "createTask" | "duplicateTask" | "refineTask", ): Promise<void> {
    return maybeResolveTombstonedTaskIdImpl(this, id, input, operation);
  }
  public isTaskArchived(id: string): boolean {
    return isTaskArchivedImpl(this, id);
  }
  public findLiveDependents(id: string): string[] {
    return findLiveDependentsImpl(this, id);
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-11:30:
   */
  public async findLiveLineageChildren(id: string): Promise<string[]> {
    return findLiveLineageChildrenImpl(this, id);
  }
  public setupActivityLogListeners(): void {
    setupActivityLogListenersImpl(this);
  }
  public recordActivityFromListener( entry: Omit<ActivityLogEntry, "id" | "timestamp">, sourceEvent: string, ): void {
    return recordActivityFromListenerImpl(this, entry, sourceEvent);
  }

  public withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    return withConfigLockImpl(this, fn);
  }

  public withWorktreeAllocationLock<T>(fn: () => Promise<T>): Promise<T> {
    return withWorktreeAllocationLockImpl(this, fn);
  }

  public withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return withTaskLockImpl(this, id, fn);
  }
  public getTaskIdFromDir(dir: string): string {
    return getTaskIdFromDirImpl(this, dir);
  }
  public insertRunAuditEventRow(input: Omit<RunAuditEventInput, "agentId" | "runId"> & { agentId?: string; runId?: string }): void {
    return insertRunAuditEventRowImpl(this, input);
  }
  public getSoftDeletedWriteConflict(id: string, task: Task, existingRow?: TaskRow): string | undefined {
    return getSoftDeletedWriteConflictImpl(this, id, task, existingRow);
  }
  public throwSoftDeletedWriteBlocked( id: string, deletedAt: string, operation: string, auditInput?: { agentId?: string; runId?: string; timestamp?: string; }, ): never {
    return throwSoftDeletedWriteBlockedImpl(this, id, deletedAt, operation, auditInput);
  }
  public normalizeTaskFromDisk(task: Task): Task {
    return normalizeTaskFromDiskImpl(this, task);
  }
  public getMalformedTaskMetadataReason(task: Partial<Task>, expectedId: string): string | undefined {
    return getMalformedTaskMetadataReasonImpl(this, task, expectedId);
  }

  /*
   * FNXC:TaskStoreConsistency 2026-06-20-00:00:
   * Heartbeat-created tasks persisted on disk but missing from the SQLite index were invisible to fn_task_list/fn_task_show (FN-6783/FN-6784). Reconcile re-imports orphaned task.json rows non-destructively and uses the same exists-anywhere guard as create-time ID allocation so soft-deleted, archived, and tombstoned IDs are never resurrected.
   */
  async reconcileOrphanedTaskDirs( opts: { ignoreRecencyWindow?: boolean } = {}, ): Promise<{ recovered: string[]; skipped: Array<{ id: string; reason: string }> }> {
    return reconcileOrphanedTaskDirsImpl(this, opts);
  }

  /**
   * FNXC:SymbolLock 2026-07-30-14:10:
   * The TaskStore owns project binding, so callers cannot accidentally inspect
   * or mutate an identically named symbol in another project's partition.
   */
  async acquireSymbolLocks(symbols: readonly string[], owner: SymbolLockOwner, leaseMs: number): Promise<AcquireSymbolLocksResult> {
    return acquireSymbolLocksAsync(this, symbols, owner, leaseMs);
  }
  async renewSymbolLocks(symbols: readonly string[], ownerTaskId: string, leaseMs: number): Promise<RenewSymbolLocksResult> {
    return renewSymbolLocksAsync(this, symbols, ownerTaskId, leaseMs);
  }
  async releaseSymbolLocks(symbols: readonly string[], ownerTaskId: string): Promise<ReleaseSymbolLocksResult> {
    return releaseSymbolLocksAsync(this, symbols, ownerTaskId);
  }
  async inspectSymbolLockConflicts(symbols: readonly string[]): Promise<SymbolLockConflict[]> {
    return inspectSymbolLockConflictsAsync(this, symbols);
  }
  async reconcileStaleSymbolLocks(): Promise<ReconcileStaleSymbolLocksResult> {
    return reconcileStaleSymbolLocksAsync(this);
  }

  /** Reconcile committed reservations whose task and archive representations are absent. */
  async reconcilePhantomCommittedReservations(): Promise<{
    reconciled: string[];
    skipped: Array<{ id: string; reason: string }>;
  }> {
    return reconcilePhantomCommittedReservationsAsync(this);
  }
  public async readTaskJson(dir: string): Promise<Task> {
    return readTaskJsonImpl(this, dir);
  }
  public async writeTaskJsonFile(dir: string, task: Task): Promise<void> {
    return writeTaskJsonFileImpl(this, dir, task);
  }
  public async atomicCreateTaskJson(dir: string, task: Task, operation: string): Promise<void> {
    return atomicCreateTaskJsonImpl(this, dir, task, operation);
  }
  public async atomicWriteTaskJson(dir: string, task: Task): Promise<void> {
    return atomicWriteTaskJsonImpl2(this, dir, task);
  }
  public async atomicWriteTaskJsonWithAudit( dir: string, task: Task, auditInput?: RunAuditEventInput, ): Promise<void> {
    return atomicWriteTaskJsonWithAuditImpl(this, dir, task, auditInput);
  }
  /*
  FNXC:TaskTiming 2026-07-15-00:00:
  Engine-process downtime is proven by a stale engineLastActiveAt heartbeat.
  Same-process unpause callers pass the transition-captured heartbeat so a
  racing scheduler write cannot erase the stopped-window proof. No opts keeps
  FN-7011 startup recovery's settings fallback; supplied but invalid opts are
  intentionally a no-action. Preserve the existing shift arithmetic: callers
  own exactly-once dispatch because this store method does not deduplicate
  repeated reconciles. Advance the current active segment anchor, preserving
  firstExecutionAt and cumulativeActiveMs so wall-clock history and
  already-accrued active work remain intact.
  */
  async reconcileActiveTimingForEngineDowntime(
    now: Date = new Date(),
    opts?: { engineLastActiveAtOverride?: string },
  ): Promise<{ shiftedTaskIds: string[]; downtimeMs: number }> {
    const settings = await this.getSettings();
    const heartbeatValue = opts === undefined ? settings.engineLastActiveAt : opts.engineLastActiveAtOverride;
    const heartbeatMs = Date.parse(heartbeatValue ?? "");
    const nowMs = now.getTime();
    const thresholdMs = Math.max((settings.pollIntervalMs ?? 15_000) * 2, 60_000);
    const downtimeMs = Number.isFinite(heartbeatMs) && Number.isFinite(nowMs) ? nowMs - heartbeatMs : 0;
    if (!heartbeatValue || !Number.isFinite(heartbeatMs) || downtimeMs <= thresholdMs) {
      return { shiftedTaskIds: [], downtimeMs: Math.max(0, downtimeMs) };
    }

    const shiftedTaskIds: string[] = [];
    const tasks = await this.listTasks({ column: "in-progress", includeArchived: false, slim: true });
    for (const task of tasks) {
      const startedMs = Date.parse(task.executionStartedAt ?? "");
      if (!Number.isFinite(startedMs) || startedMs > heartbeatMs) continue;
      const shiftedStartedMs = Math.min(nowMs, startedMs + downtimeMs);
      if (shiftedStartedMs <= startedMs) continue;
      await this.updateTask(task.id, { executionStartedAt: new Date(shiftedStartedMs).toISOString() });
      shiftedTaskIds.push(task.id);
    }

    return { shiftedTaskIds, downtimeMs };
  }

  async getSettings(): Promise<Settings> {
    return getSettingsImpl(this);
  }
  async getSettingsFast(): Promise<Settings> {
    return getSettingsFastImpl(this);
  }
  async getSettingsByScope(): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    return getSettingsByScopeImpl(this);
  }
  async getSettingsByScopeFast(): Promise<{ global: GlobalSettings; project: Partial<ProjectSettings> }> {
    return getSettingsByScopeFastImpl(this);
  }
  /* FNXC:ConfigVersioning 2026-07-18-14:10: callers without an established request/agent identity are system changes, never falsely attributed to a local human. */
  async updateSettings(patch: Partial<Settings>, changedBy?: import("./types.js").ConfigChangedBy): Promise<Settings> {
    return updateSettingsImpl(this, patch, changedBy);
  }
  async updateGlobalSettings(patch: Partial<GlobalSettings>, changedBy?: import("./types.js").ConfigChangedBy): Promise<Settings> {
    return updateGlobalSettingsImpl(this, patch, changedBy);
  }

/** Get the GlobalSettingsStore instance (used by API routes). */
  getGlobalSettingsStore(): GlobalSettingsStore {
    return this.globalSettingsStore;
  }
  public async readConfig(): Promise<BoardConfig> {
    return readConfigImpl(this);
  }
  public readConfigFast(): BoardConfig {
    return readConfigFastImpl(this);
  }
  public serializeConfigForDisk(config: BoardConfig): string {
    return serializeConfigForDiskImpl(this, config);
  }
  public async writeConfig( config: BoardConfig, options?: { nextWorkflowStepId?: number }, ): Promise<void> {
    return writeConfigImpl(this, config, options);
  }
  async resolveLocalNodeIdForTaskAllocation(): Promise<string> {
    return resolveLocalNodeIdForTaskAllocationImpl(this);
  }
  public async createTaskWithDistributedReservation( input: TaskCreateInput, options?: { onSummarize?: (description: string) => Promise<string | null>; settings?: { autoSummarizeTitles?: boolean }; createTaskWithId?: (taskId: string) => Promise<Task>; }, ): Promise<Task> {
    return createTaskWithDistributedReservationImpl(this, input, options);
  }
  public taskDir(id: string): string {
    return join(this.tasksDir, id);
  }
  public artifactRegistryDir(): string {
    return join(this.fusionDir, "artifacts");
  }
  public static artifactStoredName(id: string, title: string): string {
    return artifactStoredNameImpl(id, title);
  }
  public getBuiltInWorkflowTemplate(_templateId: string): import("./types.js").WorkflowStepTemplate | undefined {
    return undefined;
  }
  public toBuiltInWorkflowStep(template: import("./types.js").WorkflowStepTemplate): import("./types.js").WorkflowStep {
    return toBuiltInWorkflowStepImpl(this, template);
  }
  public toStoredWorkflowStep(row: { id: string; templateId: string | null; name: string; description: string; mode: string; phase: string | null; gateMode: string | null; prompt: string; toolMode: string | null; scriptName: string | null; enabled: number; defaultOn: number | null; modelProvider: string | null; modelId: string | null; migrated_fragment_id?: string | null; createdAt: string; updatedAt: string; }): import("./types.js").WorkflowStep {
    return toStoredWorkflowStepImpl(this, row);
  }
  public getLegacyWorkflowStepSnapshot(id: string, templateId?: string): Record<string, unknown> | undefined {
    return getLegacyWorkflowStepSnapshotImpl(this, id, templateId);
  }
  public applyLegacyWorkflowStepOverrides(step: import("./types.js").WorkflowStep): import("./types.js").WorkflowStep {
    return applyLegacyWorkflowStepOverridesImpl(this, step);
  }
  public async ensureWorkflowStepForTemplate(templateId: string): Promise<import("./types.js").WorkflowStep> {
    return ensureWorkflowStepForTemplateImpl(this, templateId);
  }

  /*
  FNXC:WorkflowOptionalGroup 2026-06-21-16:30:
  `optionalGroupIds` are the optional-group node ids of the task's workflow. They are executor toggle keys (matched by node id in `enabledWorkflowSteps`), NOT legacy `WorkflowStep` template ids. A built-in group id can deliberately collide with a `WORKFLOW_STEP_TEMPLATES` id (e.g. "browser-verification"); without this pass-through the colliding id is materialized into a step row whose id differs from the group node id, so the executor's `enabledWorkflowSteps.includes(node.id)` check fails and an enabled group is silently bypassed (P1 from code review). Editor-authored group ids never collide (they come from `newNodeId()`), so they already passed through; this guards the built-in collision.
  */
  public async optionalGroupIdSet(workflowId?: string | null): Promise<Set<string>> {
    return optionalGroupIdSetImpl(this, workflowId);
  }
  public async resolveEnabledWorkflowSteps( stepIds?: string[], optionalGroupIds?: Set<string>, ): Promise<string[] | undefined> {
    return resolveEnabledWorkflowStepsImpl(this, stepIds, optionalGroupIds);
  }
  public async buildActiveTaskDependencyLookup(overrides?: Map<string, readonly string[]>): Promise<Map<string, readonly string[]>> {
    return buildActiveTaskDependencyLookupImpl(this, overrides);
  }
  public recordDependencyCycleRejectedAudit( taskId: string, cyclePath: readonly string[], source: "createTask" | "createTaskWithReservedId" | "updateTask" | "replication", ): void {
    return recordDependencyCycleRejectedAuditImpl(this, taskId, cyclePath, source);
  }
  public async assertNoDependencyCycle( taskId: string, dependencies: readonly string[], source: "createTask" | "createTaskWithReservedId" | "updateTask" | "replication", overrides?: Map<string, readonly string[]>, ): Promise<void> {    return assertNoDependencyCycleImpl(this, taskId, dependencies, source, overrides);
  }

  /**
   * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-13:15:
   */
  public async createTaskBackend( input: TaskCreateInput, options?: { onSummarize?: (description: string) => Promise<string | null>; settings?: { autoSummarizeTitles?: boolean }; invokeTaskCreatedHook?: boolean; onProposalClaimConflict?: (task: Task) => void; }, ): Promise<Task> {
    return createTaskBackendImpl(this, input, options);
  }

  /**
   * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-13:25:
   */
  public async _createTaskInternalBackend( input: TaskCreateInput, title: string | undefined, resolvedWorkflowSteps: string[] | undefined, id: string, options?: { createdAt?: string; updatedAt?: string; promptOverride?: string; invokeTaskCreatedHook?: boolean; resolvedEntryColumn?: string; onProposalClaimConflict?: (task: Task) => void; }, ): Promise<Task> {
    return _createTaskInternalBackendImpl(this, input, title, resolvedWorkflowSteps, id, options);
  }

  /**
   * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-13:35:
   */
  public async _maybeAutoArchiveSameAgentDuplicateBackend( task: Task, input: TaskCreateInput, ): Promise<void> {
    return _maybeAutoArchiveSameAgentDuplicateBackendImpl(this, task, input);
  }
  async createTask( input: TaskCreateInput, options?: { onSummarize?: (description: string) => Promise<string | null>; settings?: { autoSummarizeTitles?: boolean }; invokeTaskCreatedHook?: boolean; onProposalClaimConflict?: (task: Task) => void; } ): Promise<Task> {
    return createTaskImpl(this, input, options);
  }
  async createTaskWithReservedId( input: TaskCreateInput, options: { taskId: string; createdAt?: string; updatedAt?: string; prompt?: string; applyDefaultWorkflowSteps?: boolean; invokeTaskCreatedHook?: boolean; }, ): Promise<Task> {
    return createTaskWithReservedIdImpl(this, input, options);
  }
  public async _createTaskInternal( input: TaskCreateInput, title: string | undefined, resolvedWorkflowSteps: string[] | undefined, id: string, options?: { createdAt?: string; updatedAt?: string; promptOverride?: string; invokeTaskCreatedHook?: boolean; resolvedEntryColumn?: string; onProposalClaimConflict?: (task: Task) => void; }, ): Promise<Task> {
    /*
    FNXC:SqliteFinalRemoval 2026-06-25-10:35:
    Route to the async backend variant when the store is in backend mode so
    callers like createTaskWithReservedId (which go through this internal
    create path with an explicit reserved id) work against PostgreSQL. The
    sync path uses atomicCreateTaskJson -> store.db.transactionImmediate(),
    which throws "SQLite Database is not available in backend mode". The
    backend variant uses layer.transactionImmediate + insertTaskRowInTransaction
    against PostgreSQL, preserving create-class non-destructive insert
    semantics (see docs/storage.md invariants).
    */
    if (this.backendMode) {
      return _createTaskInternalBackendImpl(this, input, title, resolvedWorkflowSteps, id, options);
    }
    return _createTaskInternalImpl(this, input, title, resolvedWorkflowSteps, id, options);
  }
  public async _maybeAutoArchiveSameAgentDuplicate(task: Task, input: TaskCreateInput): Promise<void> {
    return _maybeAutoArchiveSameAgentDuplicateImpl(this, task, input);
  }
  public async invokeTaskCreatedHook(task: Task): Promise<void> {
    return invokeTaskCreatedHookImpl(this, task);
  }
  async duplicateTask(id: string): Promise<Task> {
    return duplicateTaskImpl(this, id);
  }
  async refineTask(id: string, feedback: string): Promise<Task> {
    return refineTaskImpl(this, id, feedback);
  }
  async getTask(id: string, options?: { activityLogLimit?: number; includeDeleted?: boolean }): Promise<TaskDetail> {
    return getTaskImpl(this, id, options);
  }

  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-16:20:
   */
  async createBranchGroup(input: BranchGroupCreateInput): Promise<BranchGroup> {
    return createBranchGroupImpl(this, input);
  }
  async getBranchGroup(id: string): Promise<BranchGroup | null> {
    return getBranchGroupImpl(this, id);
  }
  async getBranchGroupBySource(sourceType: BranchGroup["sourceType"], sourceId: string): Promise<BranchGroup | null> {
    return getBranchGroupBySourceImpl(this, sourceType, sourceId);
  }
  async getBranchGroupByBranchName(branchName: string): Promise<BranchGroup | null> {
    return getBranchGroupByBranchNameImpl(this, branchName);
  }
  async ensureBranchGroupForSource( sourceType: BranchGroup["sourceType"], sourceId: string, init: Omit<BranchGroupCreateInput, "sourceType" | "sourceId">, ): Promise<BranchGroup> {
    return ensureBranchGroupForSourceImpl(this, sourceType, sourceId, init);
  }
  async listBranchGroups(options?: { status?: BranchGroup["status"] }): Promise<BranchGroup[]> {
    return listBranchGroupsImpl(this, options);
  }
  async updateBranchGroup(id: string, patch: BranchGroupUpdate): Promise<BranchGroup> {
    return updateBranchGroupImpl(this, id, patch);
  }
  async setTaskBranchGroup( taskId: string, branchGroupId: string | null, options?: { assignmentMode?: TaskBranchAssignmentMode }, ): Promise<void> {
    return setTaskBranchGroupImpl(this, taskId, branchGroupId, options);
  }
  async listTasksByBranchGroup(groupId: string): Promise<Task[]> {
    return listTasksByBranchGroupImpl(this, groupId);
  }

  // --- Unified PR entity (PR-lifecycle-as-workflow-nodes, U1) ---

  public rowToPrEntity(row: PrEntityRow): PrEntity {
    return rowToPrEntityImpl(this, row);
  }
  public generatePrEntityId(): string {
    return generatePrEntityIdImpl(this);
  }
  async getPrEntity(id: string): Promise<PrEntity | null> {
    return getPrEntityImpl(this, id);
  }
  async getActivePrEntityBySource(sourceType: PrEntity["sourceType"], sourceId: string): Promise<PrEntity | null> {
    return getActivePrEntityBySourceImpl(this, sourceType, sourceId);
  }
  async getPrEntityByNumber(repo: string, prNumber: number): Promise<PrEntity | null> {
    return getPrEntityByNumberImpl(this, repo, prNumber);
  }
  async ensurePrEntityForSource(input: PrEntityCreateInput): Promise<PrEntity> {
    return ensurePrEntityForSourceImpl(this, input);
  }
  async updatePrEntity(id: string, patch: PrEntityUpdate): Promise<PrEntity> {
    return updatePrEntityImpl(this, id, patch);
  }
  async listActivePrEntities(): Promise<PrEntity[]> {
    return listActivePrEntitiesImpl(this);
  }

  // Per-thread response state (R15) — keyed by (entity, threadId, headOid).

  async getPrThreadState(prEntityId: string, threadId: string, headOid: string): Promise<PrThreadState | null> {
    return getPrThreadStateImpl(this, prEntityId, threadId, headOid);
  }
  async listPrThreadStates(prEntityId: string): Promise<PrThreadState[]> {
    return listPrThreadStatesImpl(this, prEntityId);
  }

  /** Upsert a per-thread outcome. Persisted AFTER GitHub confirms (R15 commit-last). */
  async recordPrThreadOutcome( prEntityId: string, threadId: string, headOid: string, outcome: PrThreadOutcome, fixCommitSha?: string, ): Promise<void> {
    return recordPrThreadOutcomeImpl(this, prEntityId, threadId, headOid, outcome, fixCommitSha);
  }
  async recordBranchGroupMemberLanded( groupId: string, patch: { worktreePath?: string | null; status?: BranchGroup["status"] }, ): Promise<BranchGroup> {
    return recordBranchGroupMemberLandedImpl(this, groupId, patch);
  }
  async getTaskColumns(ids: string[]): Promise<Map<string, Column>> {
    return getTaskColumnsImpl(this, ids);
  }
  async listTasks(options?: { limit?: number; offset?: number; /** When false, exclude tasks in the `archived` column. Default: true (backward compatible). */ includeArchived?: boolean; /** When true, omit heavy fields (log, comments, steps, workflowStepResults, steeringComments) * from each row to make list responses cheap for board-style consumers. Detail fields default * to empty arrays in the returned Task objects; use `getTask(id)` to load full data. */ slim?: boolean; /** Restrict to a single column (e.g. 'in-review' for the auto-merge sweep). * Widened to {@link ColumnId} (#1403) so custom-column filters are accepted. */ column?: ColumnId; /** Opt-in startup-only memo for repeated slim reads during boot choreography. */ startupMemo?: boolean; /** Forensic read: surface soft-deleted tasks (deletedAt IS NOT NULL). * VAL-DATA-006 — only admin/forensic surfaces should set this. */ includeDeleted?: boolean; }): Promise<Task[]> {
    return listTasksImpl(this, options);
  }

/** Residual B (U13/U9): per-branch progress snapshots for the given tasks, */
  async getBranchProgressByTask( taskIds: readonly string[], ): Promise<Map<string, Array<{ branchId: string; nodeId: string; status: string }>>> {
    return getBranchProgressByTaskImpl(this, taskIds);
  }
  // FNXC:PostgresCutover 2026-07-04-00:00: facade delegates to async PG query in backend mode.
  async findOpenRevertTaskForSource(sourceTaskId: string): Promise<Task | null> {
    const trimmedId = sourceTaskId.trim();
    if (trimmedId.length === 0) return null;
    if (this.backendMode) {
      const layer = this.asyncLayer!;
      const rows = await layer.db.select()
        .from(schema.project.tasks)
        .where(and(
          isNull(schema.project.tasks.deletedAt),
          ne(schema.project.tasks.column, "archived"),
          ne(schema.project.tasks.column, "done"),
          eq(sql`json_extract(${schema.project.tasks.sourceMetadata}->>'revertOf')`, trimmedId),
        ))
        .orderBy(schema.project.tasks.createdAt)
        .limit(1);
      if (rows.length === 0) return null;
      return this.rowToTask(this.pgRowToTaskRow(rows[0] as Record<string, unknown>));
    }
    const selectClause = this.getTaskSelectClause(false, "t");
    const row = this.db.prepare(`
      SELECT ${selectClause}
      FROM tasks t
      WHERE t."deletedAt" IS NULL
        AND t."column" != 'archived'
        AND t."column" != 'done'
        AND json_extract(t.sourceMetadata, '$.revertOf') = ?
      ORDER BY t.createdAt DESC
      LIMIT 1
    `).get(trimmedId) as TaskRow | undefined;
    return row ? this.rowToTask(row) : null;
  }

/** Persist (idempotent upsert) one branch's progress for a fan-out run (#1407). */
   async saveWorkflowRunBranch(state: { taskId: string; runId: string; branchId: string; currentNodeId: string; status: string; }): Promise<void> {
    return saveWorkflowRunBranchImpl(this, state);
  }

  /** Load persisted branch states for a run (crash-resume; #1407). */
  async loadWorkflowRunBranches( taskId: string, runId: string, ): Promise<Array<{
    taskId: string;
    runId: string;
    branchId: string;
    currentNodeId: string;
    status: "running" | "completed" | "failed" | "aborted";
  }>> {
    return loadWorkflowRunBranchesImpl(this, taskId, runId);
  }

/** Prune stale branch rows for a task (#1412). */
   async clearWorkflowRunBranches(taskId: string, keepRunId: string): Promise<void> {
    return clearWorkflowRunBranchesImpl(this, taskId, keepRunId);
  }

/** Persist (idempotent upsert) one step instance's run-state inside a foreach */
  async saveWorkflowRunStepInstance( state: import("./types.js").WorkflowRunStepInstance, ): Promise<void> {
    return saveWorkflowRunStepInstanceImpl(this, state);
  }

/** Load persisted step-instance run-state for a run (crash-resume; KTD-6). */
  async loadWorkflowRunStepInstances( taskId: string, runId: string, ): Promise<import("./types.js").WorkflowRunStepInstance[]> {
    return loadWorkflowRunStepInstancesImpl(this, taskId, runId);
  }
  async clearWorkflowRunStepInstances(taskId: string, keepRunId?: string): Promise<void> {
    return clearWorkflowRunStepInstancesImpl(this, taskId, keepRunId);
  }

  async saveWorkflowRunStepInstanceAsync(state: import("./types.js").WorkflowRunStepInstance): Promise<void> {
    return saveWorkflowRunStepInstanceAsyncImpl(this, state);
  }

  async loadWorkflowRunStepInstancesAsync(taskId: string, runId: string): Promise<import("./types.js").WorkflowRunStepInstance[]> {
    return loadWorkflowRunStepInstancesAsyncImpl(this, taskId, runId);
  }

  async clearWorkflowRunStepInstancesAsync(taskId: string, keepRunId?: string): Promise<void> {
    return clearWorkflowRunStepInstancesAsyncImpl(this, taskId, keepRunId);
  }
  async listTasksForGithubTrackingReconcile(options?: { offset?: number; limit?: number }): Promise<{ tasks: Task[]; hasMore: boolean }> {
    return listTasksForGithubTrackingReconcileImpl(this, options);
  }
  async listTasksForGitlabTrackingReconcile(options?: { offset?: number; limit?: number }): Promise<{ tasks: Task[]; hasMore: boolean }> {
    return listTasksForGitlabTrackingReconcileImpl(this, options);
  }
  async listStrandedRefinements(options?: { freshnessThresholdMs?: number; }): Promise<Array<{ task: Task; reasons: Array<"untriaged-stale" | "awaiting-approval" | "failed" | "stuck-killed" | "recovery-backoff">; nextRecoveryAt?: string; ageMs: number; }>> {
    return listStrandedRefinementsImpl(this, options);
  }
  public clearStartupSlimListMemo(): void {
    this.startupSlimListMemo.clear();
  }
  async listTasksModifiedSince( since: string, limit?: number, opts?: { includeArchived?: boolean }, ): Promise<{ tasks: Task[]; hasMore: boolean }> {
    /*
    FNXC:SqliteFinalRemoval 2026-06-25-10:45:
    Route to the real implementation in reads.ts. The previous wiring called
    listTasksModifiedSinceImpl2 (a leftover modularization stub in
    remaining-ops-2.ts) which delegated straight back to this facade method,
    causing infinite recursion in BOTH SQLite and backend modes. The real
    query logic lives in listTasksModifiedSinceImpl (reads.ts).
    */
    return listTasksModifiedSinceImpl(this, since, limit, opts);
  }
  async getActiveMergingTask(excludeTaskId?: string): Promise<string | undefined> {
    return getActiveMergingTaskImpl(this, excludeTaskId);
  }
  async searchTasks(query: string, options?: { limit?: number; offset?: number; slim?: boolean; includeArchived?: boolean }): Promise<Task[]> {
    return searchTasksImpl(this, query, options);
  }
  async findRecentTasksByContentFingerprint( fingerprint: string, options?: { windowMs?: number; includeArchived?: boolean }, ): Promise<Task[]> {
    return findRecentTasksByContentFingerprintImpl(this, fingerprint, options);
  }
  async findRecentTasksBySourceParentTaskId(sourceParentTaskId: string, options?: { windowMs?: number }): Promise<Task[]> {
    return findRecentTasksBySourceParentTaskIdImpl(this, sourceParentTaskId, options);
  }

  /** FNXC:NearDuplicateDetection 2026-06-14-12:00: FN-6439 requires the store to reconcile persisted duplicate flags after a canonical becomes inactive. */
  public async clearNearDuplicateReferencesTo( canonicalId: string, inactiveState: { column?: ColumnId | null; deletedAt?: string | null; reason: string }, ): Promise<Task[]> {
    return clearNearDuplicateReferencesToImpl(this, canonicalId, inactiveState);
  }
  public async clearNearDuplicateReferencesToFailSoft( canonicalId: string, inactiveState: { column?: ColumnId | null; deletedAt?: string | null; reason: string }, ): Promise<void> {
    return clearNearDuplicateReferencesToFailSoftImpl(this, canonicalId, inactiveState);
  }
  async getTasksByAssignedAgent( agentId: string, options?: { pausedOnly?: boolean; excludeArchived?: boolean }, ): Promise<Task[]> {
    return getTasksByAssignedAgentImpl(this, agentId, options);
  }
  async tryClaimCheckout( taskId: string, claim: { agentId: string; nodeId: string; runId: string | null; leaseEpoch: number; renewedAt: string; }, precondition: CheckoutClaimPrecondition, ): Promise<{ ok: true; task: Task } | { ok: false; reason: "row_not_found" | "precondition_failed"; current: Task | null }> {
    return tryClaimCheckoutImpl(this, taskId, claim, precondition);
  }
  async renewCheckoutLease( taskId: string, update: { checkoutRunId: string | null; checkoutLeaseRenewedAt: string; }, ): Promise<Task> {
    return renewCheckoutLeaseImpl(this, taskId, update);
  }
  async selectNextTaskForAgent( agentId: string, agent?: Pick<Agent, "id" | "role"> & Partial<Pick<Agent, "runtimeConfig">>, ): Promise<InboxTask | null> {
    return selectNextTaskForAgentImpl(this, agentId, agent);
  }
  public areAllDependenciesDone(dependencies: string[], tasksById: Map<string, Task>): boolean {
    return areAllDependenciesDoneImpl(this, dependencies, tasksById);
  }
  public async readTaskForMove(id: string): Promise<Task> {
    return readTaskForMoveImpl(this, id);
  }
  async moveTask( id: string, toColumn: ColumnId, options?: MoveTaskOptions, ): Promise<Task> {
    return moveTaskImpl(this, id, toColumn, options);
  }
  async handoffToReview(taskId: string, opts: HandoffToReviewOptions): Promise<Task> {
    return handoffToReviewImpl(this, taskId, opts);
  }
  /**
   * FNXC:HandoffFailureInjection 2026-07-15-12:00:
   * Test-only PostgreSQL handoff seam. Tests arm it after the transaction's
   * column, merge-queue, workflow-work, and audit writes so VAL-DATA-013 proves
   * they roll back together; null is the strict production no-op.
   */
  public __setHandoffMergeQueueFailureInjectorForTesting(
    injector: ((taskId: string) => void | Promise<void>) | null,
  ): void {
    this.handoffMergeQueueFailureInjectorForTesting = injector;
  }
  /** @internal Invoked only from the late backend handoff transaction seam. */
  public async __invokeHandoffMergeQueueFailureInjectorForTesting(taskId: string): Promise<void> {
    await this.handoffMergeQueueFailureInjectorForTesting?.(taskId);
  }
  public resolveWorkflowMoveActor( moveSource: NonNullable<MoveTaskOptions["moveSource"]>, internal: MoveTaskInternalOptions, options?: MoveTaskOptions, ): WorkflowMovePolicyInput["actor"] {    return resolveWorkflowMoveActorImpl(this, moveSource, internal, options);
  }
  public resolveWorkflowBypassGuards( moveSource: NonNullable<MoveTaskOptions["moveSource"]>, options?: MoveTaskOptions, ): boolean {
    return resolveWorkflowBypassGuardsImpl(this, moveSource, options);
  }
  public shouldSkipWorkflowMovePolicies(params: { fromColumn: string; toColumn: string; moveSource: NonNullable<MoveTaskOptions["moveSource"]>; bypassGuards: boolean; options?: MoveTaskOptions; }): boolean {    return shouldSkipWorkflowMovePoliciesImpl(this, params);
  }
  public async prepareWorkflowMovePolicyPreflight( id: string, toColumn: ColumnId, options: MoveTaskOptions | undefined, internal: MoveTaskInternalOptions, ): Promise<MoveTaskInternalOptions["movePolicyPreflight"]> {
    return prepareWorkflowMovePolicyPreflightImpl(this, id, toColumn, options, internal);
  }
  public async evaluateWorkflowMovePolicies(input: WorkflowMovePolicyInput): Promise<void> {
    return evaluateWorkflowMovePoliciesImpl(this, input);
  }
  public async moveTaskInternal( id: string, toColumn: ColumnId, options: MoveTaskOptions | undefined, internal: MoveTaskInternalOptions, currentTask?: Task, ): Promise<Task> {
    return moveTaskInternalImpl(this, id, toColumn, options, internal, currentTask);
  }
  public async runPluginColumnTransitionHooks( taskId: string, workflowIr: WorkflowIr, fromColumn: string, toColumn: string, ): Promise<void> {
    return runPluginColumnTransitionHooksImpl(this, taskId, workflowIr, fromColumn, toColumn);
  }
  public resetAllStepsToPending(task: Task): void {
    return resetAllStepsToPendingImpl(this, task);
  }
  public async resetPromptCheckboxes(dir: string): Promise<void> {
    return resetPromptCheckboxesImpl(this, dir);
  }
  async updateTaskDependencies( id: string, mutation: TaskDependencyMutation, runContext?: RunMutationContext, ): Promise<Task> {
    return updateTaskDependenciesImpl(this, id, mutation, runContext);
  }
  async updateTask(
    id: string,
    updates: { title?: string; description?: string; priority?: TaskPriority | null; prompt?: string; worktree?: string | null; workspaceWorktrees?: import("./types.js").Task["workspaceWorktrees"]; status?: string | null; dependencies?: string[]; steps?: import("./types.js").TaskStep[]; customFields?: Record<string, unknown>; currentStep?: number; blockedBy?: string | null; overlapBlockedBy?: string | null; assignedAgentId?: string | null; pausedByAgentId?: string | null; pausedReason?: string | null; tokenBudgetSoftAlertedAt?: string | null; worktrunkFallbackAlertedAt?: string | null; worktrunkFailure?: import("./types.js").Task["worktrunkFailure"] | null; tokenBudgetHardAlertedAt?: string | null; tokenBudgetOverride?: import("./types.js").TaskTokenBudgetOverride | null; dispatchStormCount?: number | null; lastDispatchAt?: string | null; assigneeUserId?: string | null; scopeOverride?: boolean | null; scopeOverrideReason?: string | null; scopeAutoWiden?: string[] | null; nodeId?: string | null; effectiveNodeId?: string | null; effectiveNodeSource?: string | null; checkedOutBy?: string | null; checkedOutAt?: string | null; checkoutNodeId?: string | null; checkoutRunId?: string | null; checkoutLeaseRenewedAt?: string | null; checkoutLeaseEpoch?: number | null; paused?: boolean; baseBranch?: string | null; autoMerge?: boolean | null; branch?: string | null; executionStartBranch?: string | null; baseCommitSha?: string | null; size?: "S" | "M" | "L"; reviewLevel?: number; executionMode?: import("./types.js").ExecutionMode | null; mergeRetries?: number; workflowStepRetries?: number; stuckKillCount?: number | null; resumeLimboCount?: number | null; executeRequeueLoopCount?: number | null; graphResumeRetryCount?: number | null; consecutiveToolFailureRetryCount?: number | null; executorEscalationAttempted?: boolean | null; toolFailureDetectorLogCursor?: number | null; toolFailureRetryExhaustedAuditEmitted?: boolean | null; resumeLimboTipSha?: string | null; resumeLimboStepSignature?: string | null; executeRequeueLoopSignature?: string | null; postReviewFixCount?: number | null; planReviewReplanCount?: number | null; recoveryRetryCount?: number | null; taskDoneRetryCount?: number | null; bulkCompletionRefusalAt?: string | null; workflowIrPin?: string | null; workflowIrPinNodeId?: string | null; workflowIrPinColumnId?: string | null; legacyAdoptedAt?: string | null; worktreeSessionRetryCount?: number | null; completionHandoffLimboRecoveryCount?: number | null; verificationFailureCount?: number | null; mergeConflictBounceCount?: number | null; mergeAuditBounceCount?: number | null; mergeTransientRetryCount?: number | null; branchConflictRecoveryCount?: number | null; reviewerContextRetryCount?: number | null; reviewerFallbackRetryCount?: number | null; nextRecoveryAt?: string | null; enabledWorkflowSteps?: string[]; noCommitsExpected?: boolean | null; modelProvider?: string | null; modelId?: string | null; validatorModelProvider?: string | null; validatorModelId?: string | null; planningModelProvider?: string | null; planningModelId?: string | null; mergerModelProvider?: string | null; mergerModelId?: string | null; thinkingLevel?: string | null; validatorThinkingLevel?: string | null; planningThinkingLevel?: string | null; mergerThinkingLevel?: string | null; error?: string | null; summary?: string | null; sessionFile?: string | null; firstExecutionAt?: string | null; cumulativeActiveMs?: number | null; executionStartedAt?: string | null; executionCompletedAt?: string | null; review?: import("./types.js").TaskReview | null; reviewState?: import("./types.js").TaskReviewState | null; workflowStepResults?: import("./types.js").WorkflowStepResult[] | null; mergeDetails?: import("./types.js").MergeDetails | null; sourceIssue?: import("./types.js").TaskSourceIssue | null; sourceMetadataPatch?: Record<string, unknown> | null; githubTracking?: import("./types.js").TaskGithubTracking | null; tokenUsage?: import("./types.js").TaskTokenUsage | null; modifiedFiles?: string[] | null; missionId?: string | null; sliceId?: string | null; workflowTransitionNotification?: import("./types.js").WorkflowTransitionNotificationMarker | undefined; plannerOversightLevel?: string | null; sessionAdvisorEnabled?: boolean | null; approvedPlanFingerprint?: string | null },    runContext?: RunMutationContext,
  ): Promise<Task> {
    return updateTaskImpl(this, id, updates, runContext);
  }
  async claimNextToolFailureRetry(taskId: string, expectedCursor: number, maxRetries: number): Promise<import("./task-store/remaining-ops-6.js").ToolFailureRetryClaim> {
    return claimNextToolFailureRetryImpl(this, taskId, expectedCursor, maxRetries);
  }
  async markToolFailureRetryExhaustedAudit(taskId: string): Promise<boolean> {
    return markToolFailureRetryExhaustedAuditImpl(this, taskId);
  }
  async updateTaskAtomic( id: string, updater: ( current: Task, ) => Parameters<TaskStore["updateTask"]>[1] | null | undefined | Promise<Parameters<TaskStore["updateTask"]>[1] | null | undefined>, runContext?: RunMutationContext, ): Promise<Task> {
    return updateTaskAtomicImpl(this, id, updater, runContext);
  }
  public mergeCustomFieldPatch( current: Record<string, unknown> | undefined, patch: Record<string, unknown>, ): Record<string, unknown> {
    return mergeCustomFieldPatchImpl(this, current, patch);
  }
  async updateTaskCustomFields( taskId: string, patch: Record<string, unknown>, runContext?: RunMutationContext, ): Promise<{ ok: true; task: Task } | { ok: false; rejection: CustomFieldRejection }> {
    return updateTaskCustomFieldsImpl(this, taskId, patch, runContext);
  }

  // ── Workflow setting values (U2, R2/R4, KTD-2/KTD-9) ───────────────────────
  // FNXC:WorkflowColumns 2026-06-20-00:00:
  // Setting VALUES persist per (workflowId, projectId) in workflow_settings.
  // Declarations live in the named workflow's IR. Single validating write authority:
  // values validated against the NAMED workflow's declarations, invalid values
  // never persisted. Built-in workflow ids accepted for value writes (distinct
  // from non-editable built-in DECLARATIONS, KTD-2).

  public async resolveWorkflowSettingDeclarations( workflowId: string, ): Promise<WorkflowSettingDefinition[] | undefined> {
    return resolveWorkflowSettingDeclarationsImpl(this, workflowId);
  }
  getWorkflowSettingsProjectId(): string {
    return getWorkflowSettingsProjectIdImpl(this);
  }
  async listWorkflowSettingValuesForProject(): Promise<Record<string, Record<string, unknown>>> {
    return listWorkflowSettingValuesForProjectImpl(this);
  }
  async computeMovedSettingsTargetWorkflowIds(): Promise<Set<string>> {
    return computeMovedSettingsTargetWorkflowIdsImpl(this);
  }
  getWorkflowSettingValues(workflowId: string, projectId: string): Record<string, unknown> {
    return getWorkflowSettingValuesImpl(this, workflowId, projectId);
  }
  async getWorkflowSettingValuesAsync(workflowId: string, projectId: string): Promise<Record<string, unknown>> {
    return getWorkflowSettingValuesAsyncImpl(this, workflowId, projectId);
  }

  // ── Built-in workflow prompt overrides (FN-6893) ───────────────────────────
  // FNXC:CustomWorkflows 2026-06-21-19:07:
  // Built-in workflow graphs remain read-only, but prompt-bearing nodes need
  // project-scoped text overrides with reset-to-default. Separate authority from
  // updateWorkflowDefinition so structure edits remain blocked.

  public parseWorkflowPromptOverrideJson(raw: string | null | undefined): Record<string, string> {
    return parseWorkflowPromptOverrideJsonImpl(this, raw);
  }
   async listWorkflowPromptOverridesForProject(): Promise<Record<string, Record<string, string>>> {
    return listWorkflowPromptOverridesForProjectImpl(this);
  }
   getWorkflowPromptOverrides(workflowId: string, projectId: string): Record<string, string> {
    return getWorkflowPromptOverridesImpl(this, workflowId, projectId);
  }
  async getWorkflowPromptOverridesAsync(workflowId: string, projectId: string): Promise<Record<string, string>> {
    return getWorkflowPromptOverridesAsyncImpl(this, workflowId, projectId);
  }

/** non-string, empty, or whitespace value deletes that nodeId override, which */
  async updateWorkflowPromptOverrides( workflowId: string, projectId: string, patch: Record<string, string | null | undefined>, ): Promise<Record<string, string>> {
    return updateWorkflowPromptOverridesImpl(this, workflowId, projectId, patch);
  }
  async updateWorkflowSettingValues( workflowId: string, projectId: string, patch: Record<string, unknown>, changedBy?: import("./types.js").ConfigChangedBy, ): Promise<Record<string, unknown>> {
    return updateWorkflowSettingValuesImpl(this, workflowId, projectId, patch, changedBy);
  }
  /** Roll back a project/global/workflow revision; routines and automations expose the same method on their own stores. */
  async rollbackConfiguration(revisionId: string, changedBy?: import("./types.js").ConfigChangedBy): Promise<import("./types.js").ConfigurationRevision> {
    return rollbackConfigurationImpl(this, revisionId, changedBy);
  }
  public async updateTaskUnlocked( id: string, updates: Parameters<TaskStore["updateTask"]>[1], runContext?: RunMutationContext, ): Promise<Task> {
    return updateTaskUnlockedImpl(this, id, updates, runContext);
  }
  async pauseTask( id: string, paused: boolean, runContext?: RunMutationContext, agentOptions?: { pausedByAgentId?: string; pausedReason?: string }, ): Promise<Task> {
    return pauseTaskImpl(this, id, paused, runContext, agentOptions);
  }

  /*
   * FNXC:ReviewLaneBypass 2026-07-09-00:00:
   * Operator/privileged-only escape hatch for a card stranded in `in-review`
   * solely by a failed pre-merge review lane (leading real-world cause: the
   * Runfusion/Fusion#1946 `(no feedback captured)` no-verdict dispatch
   * defect). Requires a mandatory `reason` and rewrites the latest failed
   * pre-merge `WorkflowStepResult` to a terminal `"skipped"` status with
   * explicit bypass audit metadata (who/when/why/prior status) — it never
   * synthesizes a reviewer `verdict`. This clears ONLY the
   * "task has failed pre-merge workflow steps" `getTaskMergeBlocker` reason;
   * paused/incomplete-step/blocking-status/still-pending conditions still
   * block, and an `autoMerge:false` task is not force-merged — it only
   * becomes eligible for the normal human-review merge path (FN-7720). NOT
   * exposed to executor/reviewer/triage agent tool surfaces — see
   * `fn_task_bypass_review` registration comments for the same rule.
   */
  async bypassFailedPreMergeReviewStep(
    id: string,
    options: { reason: string; actor: string },
  ): Promise<Task> {
    const reason = options.reason?.trim();
    if (!reason) {
      throw new Error("bypassFailedPreMergeReviewStep requires a non-empty reason");
    }
    const actor = options.actor?.trim() || "operator";

    return this.withTaskLock(id, async () => {
      const dir = this.taskDir(id);
      const task = await this.readTaskJson(dir);

      if (task.column !== "in-review") {
        throw new Error(`Cannot bypass review lane for ${id}: task is in '${task.column}', must be in 'in-review'`);
      }
      if (task.paused) {
        throw new Error(`Cannot bypass review lane for ${id}: task is paused`);
      }

      const target = getLatestFailedPreMergeReviewStep(task);
      if (!target) {
        throw new Error(`Cannot bypass review lane for ${id}: no failed pre-merge review step found`);
      }

      const results = task.workflowStepResults ?? [];
      const targetIndex = results.indexOf(target);
      if (targetIndex === -1) {
        throw new Error(`Cannot bypass review lane for ${id}: failed step result not found`);
      }

      const now = new Date().toISOString();
      const bypassed: import("./types.js").WorkflowStepResult = {
        ...target,
        status: "skipped",
        bypassedBy: actor,
        bypassedAt: now,
        bypassReason: reason,
        bypassedFromStatus: target.status,
        bypassedFromVerdict: target.verdict,
      };
      // A bypass never fabricates a reviewer verdict.
      delete bypassed.verdict;

      const nextResults = [...results];
      nextResults[targetIndex] = bypassed;
      task.workflowStepResults = nextResults;

      if (!task.log) {
        task.log = [];
      }
      task.updatedAt = now;
      task.log.push({
        timestamp: now,
        action: `Review lane bypassed: ${target.workflowStepName} (${target.workflowStepId}) by ${actor} — ${reason}`,
      });

      // FNXC:PostgresCutover 2026-07-10: recordRunAuditEvent is async on the PG
      // branch — await it so the audit row lands before the bypass returns.
      await this.recordRunAuditEvent({
        taskId: task.id,
        agentId: actor,
        runId: this.makeSyntheticDeleteRunId(task.id),
        domain: "database",
        mutationType: "task:bypass-review",
        target: task.id,
        metadata: {
          workflowStepId: target.workflowStepId,
          workflowStepName: target.workflowStepName,
          bypassedFromStatus: target.status,
          bypassedFromVerdict: target.verdict ?? null,
          reason,
        },
      });

      await this.atomicWriteTaskJson(dir, task);
      if (this.isWatching) this.taskCache.set(id, { ...task });

      this.emit("task:updated", task);
      return task;
    });
  }
  async updateStep( id: string, stepIndex: number, status: import("./types.js").StepStatus, options?: { source?: "graph" }, ): Promise<Task> {
    return updateStepImpl(this, id, stepIndex, status, options);
  }
  async logEntry(id: string, action: string, outcome?: string, runContext?: RunMutationContext): Promise<Task> {
    return logEntryImpl(this, id, action, outcome, runContext);
  }
  async getMutationsForRun(runId: string): Promise<TaskLogEntry[]> {
    return getMutationsForRunImpl(this, runId);
  }

  // ── Run Audit APIs ───────────────────────────────────────────────────

  public rowToMergeQueueEntry(row: MergeQueueRow): MergeQueueEntry {
    return rowToMergeQueueEntryImpl(this, row);
  }
  public normalizeMergeRequestState(value: string): MergeRequestState {
    return normalizeMergeRequestStateImpl(this, value);
  }
  public rowToMergeRequestRecord(row: MergeRequestRow): MergeRequestRecord {
    return rowToMergeRequestRecordImpl(this, row);
  }
  public rowToCompletionHandoffMarker(row: CompletionHandoffMarkerRow): CompletionHandoffMarker {
    return rowToCompletionHandoffMarkerImpl(this, row);
  }
  public normalizeWorkflowWorkItemKind(value: string): WorkflowWorkItemKind {
    return normalizeWorkflowWorkItemKindImpl(this, value);
  }
  public normalizeWorkflowWorkItemState(value: string): WorkflowWorkItemState {
    return normalizeWorkflowWorkItemStateImpl(this, value);
  }
  public isTerminalWorkflowWorkItemState(state: WorkflowWorkItemState): boolean {
    return state === "succeeded" || state === "failed" || state === "cancelled" || state === "exhausted";
  }
  public isActiveWorkflowWorkItemState(state: WorkflowWorkItemState): boolean {
    return state === "runnable" || state === "running" || state === "held" || state === "retrying" || state === "manual-required";
  }
  public workflowStateForMergeRequestState(state: MergeRequestState): WorkflowWorkItemState {
    return workflowStateForMergeRequestStateImpl(this, state);
  }
  public rowToWorkflowWorkItem(row: WorkflowWorkItemRow): WorkflowWorkItem {
    return rowToWorkflowWorkItemImpl(this, row);
  }
  public isValidMergeRequestTransition(from: MergeRequestState, to: MergeRequestState): boolean {
    return isValidMergeRequestTransitionImpl(this, from, to);
  }
  async createTaskVerificationRequest(input: Omit<import("./types.js").TaskVerificationRequest, "status" | "requestedAt"> & { requestedAt?: string }) {
    return createTaskVerificationRequestImpl(this, input);
  }
  async getTaskVerificationRequestAsync(taskId: string) {
    return getTaskVerificationRequestAsyncImpl(this, taskId);
  }
  async claimTaskVerificationRequest(taskId: string, requestId: string) {
    return claimTaskVerificationRequestImpl(this, taskId, requestId);
  }
  async finishTaskVerificationRequest(taskId: string, requestId: string, status: "passed" | "failed" | "rejected", result?: import("./types.js").TaskVerificationResultSummary, rejectionReason?: string) {
    return finishTaskVerificationRequestImpl(this, taskId, requestId, status, result, rejectionReason);
  }
  async upsertMergeRequestRecord( taskId: string, input: { state: MergeRequestState; now?: string; attemptCount?: number; lastError?: string | null }, ): Promise<MergeRequestRecord> {
    return upsertMergeRequestRecordImpl(this, taskId, input);
  }
  async transitionMergeRequestState( taskId: string, toState: MergeRequestState, opts: { now?: string; attemptCount?: number; lastError?: string | null } = {}, ): Promise<MergeRequestRecord> {
    return transitionMergeRequestStateImpl(this, taskId, toState, opts);
  }
  getMergeRequestRecord(taskId: string): MergeRequestRecord | null {
    return getMergeRequestRecordImpl(this, taskId);
  }
  async getMergeRequestRecordAsync(taskId: string): Promise<MergeRequestRecord | null> {
    return getMergeRequestRecordAsyncImpl(this, taskId);
  }
  async projectMergeRequestToWorkflowWorkItem( taskId: string, opts: MergeRequestWorkflowProjectionOptions = {}, ): Promise<WorkflowWorkItem | null> {
    return projectMergeRequestToWorkflowWorkItemImpl(this, taskId, opts);
  }
  async createCompletionHandoffWorkflowWork( task: Pick<Task, "id" | "autoMerge" | "priority">, opts: { runId?: string; now?: string; source?: string } = {}, tx?: import("./postgres/data-layer.js").DbTransaction, ): Promise<WorkflowWorkItem> {
    return createCompletionHandoffWorkflowWorkImpl(this, task, opts, tx);
  }
  public getWorkflowWorkItemByIdentity( runId: string, taskId: string, nodeId: string, kind: WorkflowWorkItemKind, ): WorkflowWorkItem | null {
    return getWorkflowWorkItemByIdentityImpl(this, runId, taskId, nodeId, kind);
  }
  public insertCompletionHandoffWorkflowWorkAudit( task: Pick<Task, "id">, item: WorkflowWorkItem, autoMerge: boolean, source?: string, ): void {
    return insertCompletionHandoffWorkflowWorkAuditImpl(this, task, item, autoMerge, source);
  }

  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-16:30:
   */
  async upsertWorkflowWorkItem(input: WorkflowWorkItemUpsertInput, tx?: import("./postgres/data-layer.js").DbTransaction): Promise<WorkflowWorkItem> {
    return upsertWorkflowWorkItemImpl(this, input, tx);
  }
  async transitionWorkflowWorkItem( id: string, state: WorkflowWorkItemState, patch: WorkflowWorkItemTransitionPatch = {}, tx?: import("./postgres/data-layer.js").DbTransaction, ): Promise<WorkflowWorkItem> {
    return transitionWorkflowWorkItemImpl(this, id, state, patch, tx);
  }

  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-17:10:
   */
  public transitionWorkflowWorkItemSync( id: string, state: WorkflowWorkItemState, patch: WorkflowWorkItemTransitionPatch = {}, ): WorkflowWorkItem {
    return transitionWorkflowWorkItemSyncImpl(this, id, state, patch);
  }
  async getWorkflowWorkItem(id: string): Promise<WorkflowWorkItem | null> {
    return getWorkflowWorkItemImpl(this, id);
  }
  async listWorkflowWorkItemsForTask(taskId: string, opts: { kinds?: WorkflowWorkItemKind[] } = {}): Promise<WorkflowWorkItem[]> {
    return listWorkflowWorkItemsForTaskImpl(this, taskId, opts);
  }

  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-17:12:
   */
  public listWorkflowWorkItemsForTaskSync(taskId: string, opts: { kinds?: WorkflowWorkItemKind[] } = {}): WorkflowWorkItem[] {
    return listWorkflowWorkItemsForTaskSyncImpl(this, taskId, opts);
  }
  async cancelActiveWorkflowWorkItemsForTask( taskId: string, opts: { kinds?: WorkflowWorkItemKind[]; now?: string; lastError?: string | null; excludeIds?: string[] } = {}, tx?: import("./postgres/data-layer.js").DbTransaction, ): Promise<WorkflowWorkItem[]> {
    return cancelActiveWorkflowWorkItemsForTaskImpl(this, taskId, opts, tx);
  }
  async listDueWorkflowWorkItems(filter: WorkflowWorkItemDueFilter = {}): Promise<WorkflowWorkItem[]> {
    return listDueWorkflowWorkItemsImpl(this, filter);
  }
  async acquireWorkflowWorkItemLease( id: string, leaseOwner: string, opts: { leaseDurationMs: number; now?: string }, ): Promise<WorkflowWorkItem | null> {
    return acquireWorkflowWorkItemLeaseImpl(this, id, leaseOwner, opts);
  }
  async setCompletionHandoffAcceptedMarker( taskId: string, opts: { source: string; acceptedAt?: string }, ): Promise<CompletionHandoffMarker> {
    return setCompletionHandoffAcceptedMarkerImpl(this, taskId, opts);
  }
  async clearCompletionHandoffAcceptedMarker(taskId: string): Promise<void> {
    return clearCompletionHandoffAcceptedMarkerImpl(this, taskId);
  }
  async getCompletionHandoffAcceptedMarker(taskId: string): Promise<CompletionHandoffMarker | null> {
    return getCompletionHandoffAcceptedMarkerImpl(this, taskId);
  }

  /** FNXC:CommandCenterEcosystem 2026-06-19-00:00: FNXC:RuntimeWorkflowAsync 2026-06-24-16:40: */
  async recordPluginActivation(input: PluginActivationInput): Promise<PluginActivation> {
    return recordPluginActivationImpl(this, input);
  }
  public rowToRunAuditEvent(row: RunAuditEventRow): RunAuditEvent {
    return rowToRunAuditEventImpl(this, row);
  }

  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-16:10: @param input - The audit event input (runId, agentId, domain, mutationType, target, optional metadata) @returns The persisted RunAuditEvent with generated id and timestamp
   */
  async recordRunAuditEvent(input: RunAuditEventInput): Promise<RunAuditEvent> {
    return recordRunAuditEventImpl(this, input);
  }
  public isLegacyAutoMergeStampCandidate(task: Pick<Task, "column" | "autoMerge" | "autoMergeProvenance">): boolean {
    return task.column === "in-review" && task.autoMerge === true && task.autoMergeProvenance !== "user";
  }
  public async listLegacyAutoMergeStampCandidates(): Promise<Task[]> {
    return listLegacyAutoMergeStampCandidatesImpl(this);
  }
  async reconcileLegacyAutoMergeStamps(options?: { apply?: boolean }): Promise<LegacyAutoMergeStampReconcileResult[]> {
    return reconcileLegacyAutoMergeStampsImpl(this, options);
  }
  public async markLegacyAutoMergeStampsOnce(): Promise<void> {
    return markLegacyAutoMergeStampsOnceImpl(this);
  }
   getRunAuditEvents(options: RunAuditEventFilter = {}): RunAuditEvent[] {
    return getRunAuditEventsImpl(this, options);
  }
  /** PostgreSQL-authoritative audit reader; sync fallback remains for test doubles. */
  async getRunAuditEventsAsync(options: RunAuditEventFilter = {}): Promise<RunAuditEvent[]> {
    if (this.asyncLayer) {
      const events = await queryRunAuditEvents(this.asyncLayer.db, options);
      return events.map((event) => ({
        ...event,
        taskId: event.taskId ?? undefined,
        metadata: event.metadata ?? undefined,
        domain: event.domain as RunAuditEvent["domain"],
        mutationType: event.mutationType as RunAuditEvent["mutationType"],
      }));
    }
    return getRunAuditEventsImpl(this, options);
  }
  /** PostgreSQL soft-delete invariant repair used by engine self-healing. */
  async reconcileSoftDeletedColumnDriftBackend(
    recordAudit: (candidate: { id: string; previousColumn: string }) => Promise<void>,
  ): Promise<{ reconciled: number }> {
    if (!this.asyncLayer) return { reconciled: 0 };
    return reconcileSoftDeletedColumnDriftAsync(this.asyncLayer, recordAudit);
  }
   async getWorkflowParitySummary(options: { since?: string; limit?: number } = {}): Promise<WorkflowParitySummary> {
    return getWorkflowParitySummaryImpl(this, options);
  }

/** Aggregate the `workflowColumns` flag default-flip criteria (U12, KTD-8) into */
  async computeWorkflowColumnsGraduationReport( options: { since?: string; limit?: number } = {}, ): Promise<WorkflowColumnsGraduationReport> {
    return computeWorkflowColumnsGraduationReportImpl(this, options);
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-11:10:
   */
  async enqueueMergeQueue(taskId: string, opts: MergeQueueEnqueueOptions = {}): Promise<MergeQueueEntry> {
    return enqueueMergeQueueImpl(this, taskId, opts);
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-11:15:
   */
  public enqueueMergeQueueSyncInternal(taskId: string, opts: MergeQueueEnqueueOptions): MergeQueueEntry {
    return enqueueMergeQueueSyncInternalImpl(this, taskId, opts);
  }
  public cleanupStaleMergeQueueRows(now: string): void {
    return cleanupStaleMergeQueueRowsImpl(this, now);
  }
  public dequeueMergeQueueOnColumnExit(taskId: string, previousColumn: ColumnId, nextColumn: ColumnId, now: string): void {
    dequeueMergeQueueOnColumnExitImpl(this, taskId, previousColumn, nextColumn, now);
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-11:20:
   */
  async acquireMergeQueueLease(workerId: string, opts: MergeQueueAcquireOptions): Promise<MergeQueueEntry | null> {
    return acquireMergeQueueLeaseImpl(this, workerId, opts);
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-11:22:
   */
  async releaseMergeQueueLease(taskId: string, workerId: string, outcome: MergeQueueReleaseOutcome): Promise<void> {
    return releaseMergeQueueLeaseImpl(this, taskId, workerId, outcome);
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-11:24:
   */
  async recoverExpiredMergeQueueLeases(now: string = new Date().toISOString()): Promise<MergeQueueEntry[]> {
    return recoverExpiredMergeQueueLeasesImpl(this, now);
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-11:26:
   */
  async peekMergeQueue(): Promise<MergeQueueEntry[]> {
    return peekMergeQueueImpl(this);
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-11:27:
   */
  async peekMergeQueueHead(): Promise<{ taskId: string; leasedBy: string | null; column: Column | null } | null> {
    return peekMergeQueueHeadImpl(this);
  }

  // ── End Run Audit APIs ───────────────────────────────────────────────

  async parseStepsFromPrompt(id: string): Promise<import("./types.js").TaskStep[]> {
    return parseStepsFromPromptImpl(this, id);
  }
  async parseDependenciesFromPrompt(id: string): Promise<string[]> {
    return parseDependenciesFromPromptImpl(this, id);
  }
  async parseFileScopeFromPrompt(id: string): Promise<string[]> {
    return parseFileScopeFromPromptImpl(this, id);
  }

  async repairOverlapBlocker(id: string, options: RepairOverlapBlockerOptions = {}): Promise<RepairOverlapBlockerResult> {
    /*
    FNXC:OverlapRepair 2026-06-25-04:34:
    Dashboard-initiated overlap repair is a narrow stale-blocker cleanup, not a general task mutation endpoint. Missing target tasks still return structured failures, but a missing blocker reference is itself stale and should be cleared or rerouted after the current scheduler-visible blockers are checked.
    */
    const dryRun = options.dryRun === true;
    let task: Task;
    try {
      task = await this.getTask(id);
    } catch {
      return { taskId: id, dryRun, repaired: false, statusCleared: false, reason: "task-not-found", message: `Task ${id} not found` };
    }

    const previousOverlapBlockedBy = task.overlapBlockedBy ?? undefined;
    if (!previousOverlapBlockedBy) {
      return { taskId: id, dryRun, repaired: false, statusCleared: false, reason: "no-overlap-blocker", message: `Task ${id} has no overlap blocker`, task };
    }

    if (task.column !== "todo") {
      return {
        taskId: id,
        dryRun,
        repaired: false,
        statusCleared: false,
        previousOverlapBlockedBy,
        reason: "not-repairable-state",
        message: `Task ${id} is in ${task.column}, not a repairable todo state`,
        task,
      };
    }

    const tasks = await this.listTasks({ includeArchived: true, slim: true });
    const taskById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    const blocker = taskById.get(previousOverlapBlockedBy);

    const settings = await this.getSettings();
    const ignorePaths = settings.overlapIgnorePaths ?? [];
    const scopeCache = new Map<string, string[]>();
    const getScope = async (taskId: string): Promise<string[]> => {
      const cached = scopeCache.get(taskId);
      if (cached !== undefined) return cached;
      const scope = filterRepairOverlapIgnoredPaths(await this.parseFileScopeFromPrompt(taskId), ignorePaths);
      scopeCache.set(taskId, scope);
      return scope;
    };

    const taskScope = await getScope(task.id);
    if (blocker) {
      const blockerHoldsActiveLease = !blocker.paused
        && !blocker.userPaused
        && blocker.status !== "failed"
        && (blocker.column === "in-progress" || (blocker.column === "in-review" && Boolean(blocker.worktree)));
      const blockerScope = await getScope(blocker.id);
      if (blockerHoldsActiveLease && repairScopesOverlap(taskScope, blockerScope)) {
        return {
          taskId: id,
          dryRun,
          repaired: false,
          statusCleared: false,
          previousOverlapBlockedBy,
          currentOverlapBlockedBy: previousOverlapBlockedBy,
          reason: "scopes-still-overlap",
          message: `Task ${id} still overlaps ${previousOverlapBlockedBy}`,
          task,
        };
      }
    }

    const unresolvedDeps = (task.dependencies ?? []).filter((depId) => {
      const dep = taskById.get(depId);
      return dep && !dep.deletedAt && dep.column !== "done" && dep.column !== "archived";
    });

    const currentOverlapBlocker = await this.findCurrentOverlapBlockerForRepair(task, taskScope, tasks, getScope, previousOverlapBlockedBy);
    const statusCleared = unresolvedDeps.length === 0 && !currentOverlapBlocker && task.status === "queued";

    /*
    FNXC:OverlapRepair 2026-06-25-10:58:
    Stale-blocker repair must not overwrite a fresh scheduler blocker that appears after the repair computation starts. Re-check overlapBlockedBy inside the task lock immediately before writing so operator repair can clear/reroute only the blocker it inspected.
    */
    const overlapBlockerChangedResult = (current: Task): RepairOverlapBlockerResult => ({
      taskId: id,
      dryRun,
      repaired: false,
      statusCleared: false,
      previousOverlapBlockedBy,
      currentOverlapBlockedBy: current.overlapBlockedBy,
      reason: "overlap-blocker-changed",
      message: `Task ${id} overlap blocker changed from ${previousOverlapBlockedBy} to ${current.overlapBlockedBy}; repair skipped`,
      task: current,
    });

    if (currentOverlapBlocker) {
      if (dryRun) {
        return {
          taskId: id,
          dryRun,
          repaired: false,
          statusCleared: false,
          previousOverlapBlockedBy,
          currentOverlapBlockedBy: currentOverlapBlocker,
          reason: "rerouted-to-current-overlap",
          message: `Stale overlap blocker ${previousOverlapBlockedBy} would reroute to ${currentOverlapBlocker}`,
          task,
        };
      }

      let skipped: RepairOverlapBlockerResult | undefined;
      const repairedTask = await this.updateTaskAtomic(id, (current) => {
        if ((current.overlapBlockedBy ?? undefined) !== previousOverlapBlockedBy) {
          skipped = overlapBlockerChangedResult(current);
          return null;
        }
        return { overlapBlockedBy: currentOverlapBlocker, status: "queued" };
      });
      if (skipped) return skipped;
      await this.logEntry(id, `Repaired stale overlap blocker: rerouted from ${previousOverlapBlockedBy} to ${currentOverlapBlocker}${options.reason ? ` — ${options.reason}` : ""}`);
      return {
        taskId: id,
        dryRun,
        repaired: true,
        statusCleared: false,
        previousOverlapBlockedBy,
        currentOverlapBlockedBy: currentOverlapBlocker,
        reason: "rerouted-to-current-overlap",
        message: `Stale overlap blocker ${previousOverlapBlockedBy} rerouted to ${currentOverlapBlocker}`,
        task: repairedTask,
      };
    }

    if (dryRun) {
      return {
        taskId: id,
        dryRun,
        repaired: false,
        statusCleared,
        previousOverlapBlockedBy,
        reason: unresolvedDeps.length > 0 ? "dependency-blocker-remains" : "repaired",
        message: unresolvedDeps.length > 0
          ? `Stale overlap blocker ${previousOverlapBlockedBy} would be cleared; dependency blocker remains ${unresolvedDeps[0]}`
          : `Stale overlap blocker ${previousOverlapBlockedBy} would be cleared`,
        task,
      };
    }

    let skipped: RepairOverlapBlockerResult | undefined;
    const repairedTask = await this.updateTaskAtomic(id, (current) => {
      if ((current.overlapBlockedBy ?? undefined) !== previousOverlapBlockedBy) {
        skipped = overlapBlockerChangedResult(current);
        return null;
      }
      const currentUnresolvedDeps = (current.dependencies ?? []).filter((depId) => {
        const dep = taskById.get(depId);
        return dep && !dep.deletedAt && dep.column !== "done" && dep.column !== "archived";
      });
      const currentStatusCleared = currentUnresolvedDeps.length === 0 && current.status === "queued";
      return {
        overlapBlockedBy: null,
        ...(currentStatusCleared ? { status: null } : {}),
        ...(currentUnresolvedDeps.length > 0 ? { blockedBy: currentUnresolvedDeps[0] } : {}),
      };
    });
    if (skipped) return skipped;
    await this.logEntry(
      id,
      `Repaired stale overlap blocker: cleared ${previousOverlapBlockedBy}; statusCleared=${statusCleared}${unresolvedDeps.length > 0 ? `; dependency blocker remains ${unresolvedDeps[0]}` : ""}${options.reason ? ` — ${options.reason}` : ""}`,
    );

    return {
      taskId: id,
      dryRun,
      repaired: true,
      statusCleared,
      previousOverlapBlockedBy,
      reason: unresolvedDeps.length > 0 ? "dependency-blocker-remains" : "repaired",
      message: unresolvedDeps.length > 0
        ? `Cleared stale overlap blocker ${previousOverlapBlockedBy}; dependency blocker remains ${unresolvedDeps[0]}`
        : `Cleared stale overlap blocker ${previousOverlapBlockedBy}`,
      task: repairedTask,
    };
  }

  private async findCurrentOverlapBlockerForRepair(
    task: Task,
    taskScope: string[],
    tasks: Task[],
    getScope: (taskId: string) => Promise<string[]>,
    previousOverlapBlockedBy: string,
  ): Promise<string | null> {
    /*
    FNXC:OverlapRepair 2026-06-25-05:49:
    Stale-overlap repair must reroute only to tasks that the scheduler would still treat as active file-scope lease holders. Operator-paused or failed active rows are parked work, not live blockers, so the repair should clear stale state instead of creating a fresh blocker edge to them.
    */
    const holdsRepairFileScopeLease = (candidate: Task) => {
      if (candidate.paused || candidate.userPaused || candidate.status === "failed") return false;
      if (candidate.column === "in-progress") return true;
      return candidate.column === "in-review" && Boolean(candidate.worktree);
    };
    const activeCandidates = tasks
      .filter((candidate) => candidate.id !== task.id && candidate.id !== previousOverlapBlockedBy)
      .filter(holdsRepairFileScopeLease)
      .sort((a, b) => a.id.localeCompare(b.id));

    for (const candidate of activeCandidates) {
      const candidateScope = await getScope(candidate.id);
      if (repairScopesOverlap(taskScope, candidateScope)) return candidate.id;
    }

    const priorityRank: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    const taskRank = priorityRank[task.priority ?? "normal"] ?? 2;
    const taskCreatedAt = Date.parse(task.createdAt);
    const queuedCandidates = tasks
      .filter((candidate) => candidate.id !== task.id && candidate.id !== previousOverlapBlockedBy && candidate.column === "todo")
      .filter((candidate) => {
        const candidateRank = priorityRank[candidate.priority ?? "normal"] ?? 2;
        if (candidateRank < taskRank) return true;
        if (candidateRank > taskRank) return false;
        const candidateCreatedAt = Date.parse(candidate.createdAt);
        if (Number.isFinite(candidateCreatedAt) && Number.isFinite(taskCreatedAt) && candidateCreatedAt !== taskCreatedAt) {
          return candidateCreatedAt < taskCreatedAt;
        }
        return candidate.id.localeCompare(task.id) < 0;
      })
      .sort((a, b) => {
        const priorityDiff = (priorityRank[a.priority ?? "normal"] ?? 2) - (priorityRank[b.priority ?? "normal"] ?? 2);
        if (priorityDiff !== 0) return priorityDiff;
        const ageDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
        if (Number.isFinite(ageDiff) && ageDiff !== 0) return ageDiff;
        return a.id.localeCompare(b.id);
      });

    for (const candidate of queuedCandidates) {
      const candidateScope = await getScope(candidate.id);
      if (repairScopesOverlap(taskScope, candidateScope)) return candidate.id;
    }

    return null;
  }

  public makeSyntheticDeleteRunId(taskId: string): string {
    return `synthetic-task-delete-${taskId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-12:05:
   */
  public async deleteTaskBackend( id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: { agentId: string; runId: string; sessionId?: string; taskId?: string }; }, ): Promise<Task> {
    return deleteTaskBackendImpl(this, id, options);
  }

  /**
   * FNXC:RuntimeLifecycleAsync 2026-06-24-12:10: Backend-mode run-audit event recording.
   * Delegates to recordRunAuditEventWithinTransaction from the async data layer.
   * Used by backend-mode lifecycle methods that need audit events committed atomically with their mutations.
   */
  public async recordRunAuditEventBackend( tx: DbTransaction, event: { domain: string; mutationType: string; target: string; taskId: string; agentId: string; runId: string; metadata: Record<string, unknown>; }, ): Promise<void> {    return recordRunAuditEventBackendImpl(this, tx, event);
  }
  async deleteTask( id: string, options?: { removeDependencyReferences?: boolean; removeLineageReferences?: boolean; allowResurrection?: boolean; githubIssueAction?: GithubIssueAction; auditContext?: { agentId: string; runId: string; sessionId?: string; taskId?: string }; }, ): Promise<Task> {
    return deleteTaskImpl(this, id, options);
  }
  public deleteTaskById(taskId: string): void {
    return deleteTaskByIdImpl(this, taskId);
  }
  public rewriteDependentsForRemoval(taskId: string, dependentIds: string[]): Task[] {
    return rewriteDependentsForRemovalImpl(this, taskId, dependentIds);
  }
  public rewriteBlockedByResidueDependentsForRemoval(taskId: string, excludedDependentIds: Set<string>): Task[] {
    return rewriteBlockedByResidueDependentsForRemovalImpl(this, taskId, excludedDependentIds);
  }
  public rewriteLineageChildrenForRemoval(parentId: string, childIds: string[]): Task[] {
    return rewriteLineageChildrenForRemovalImpl(this, parentId, childIds);
  }
  public clearLinkedAgentTaskIds(taskId: string, updatedAt: string = new Date().toISOString()): void {
    clearLinkedAgentTaskIdsImpl(this, taskId, updatedAt);
  }
  public async syncAgentTaskLinkOnReassignment( taskId: string, previousAgentId: string | undefined, newAgentId: string | undefined, ): Promise<void> {
    return syncAgentTaskLinkOnReassignmentImpl(this, taskId, previousAgentId, newAgentId);
  }
  public async runGitCommand(command: string, timeoutMs = 10_000) {
    return runGitCommandImpl(this, command, timeoutMs);
  }
  public async cleanupBranchForTask(task: Task): Promise<string[]> {
    return cleanupBranchForTaskImpl(this, task);
  }
  async clearStaleExecutionStartBranchReferences(deletedBranches: string[], ownerTaskId?: string): Promise<string[]> {
    return clearStaleExecutionStartBranchReferencesImpl(this, deletedBranches, ownerTaskId);
  }
  public async collectMergeDetails( _id: string, _branch: string, task: Task, commitMessage: string, mergeTarget?: { branch: string; source: "task-base-branch" | "task-branch-context" | "branch-group-integration" | "project-default" | "legacy-main"; }, ): Promise<import("./types.js").MergeDetails> {
    return collectMergeDetailsImpl(this, _id, _branch, task, commitMessage, mergeTarget);
  }
  async mergeTask(id: string): Promise<MergeResult> {
    return mergeTaskImpl(this, id);
  }
  async archiveAllDone(options?: { removeLineageReferences?: boolean }): Promise<Task[]> {
    return archiveAllDoneImpl(this, options);
  }
  async archiveTask( id: string, optionsOrCleanup: boolean | { cleanup?: boolean; removeLineageReferences?: boolean } = true, ): Promise<Task> {
    return archiveTaskImpl(this, id, optionsOrCleanup);
  }

  /**
   * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:55:
   */
  public async archiveTaskBackend( id: string, optionsOrCleanup: boolean | { cleanup?: boolean; removeLineageReferences?: boolean }, ): Promise<Task> {
    return archiveTaskBackendImpl(this, id, optionsOrCleanup);
  }

/** Archive a task and immediately clean up its directory. */
  async archiveTaskAndCleanup(id: string): Promise<Task> {
    return this.archiveTask(id, true);
  }
  public resolveUnarchiveTargetColumn(preArchiveColumn: unknown): Column {
    return resolveUnarchiveTargetColumnImpl(this, preArchiveColumn);
  }
  public async readPreArchiveColumnFromTaskFile(dir: string): Promise<Column | undefined> {
    return readPreArchiveColumnFromTaskFileImpl(this, dir);
  }
  async unarchiveTask(id: string): Promise<Task> {
    return unarchiveTaskImpl(this, id);
  }
  public async moveToDone(task: Task, dir: string): Promise<void> {
    return moveToDoneImpl(this, task, dir);
  }
  public clearDoneTransientFields(task: Task): boolean {
    return clearDoneTransientFieldsImpl(this, task);
  }

  // ── File-system watcher ───────────────────────────────────────────

  async watch(): Promise<void> {
    return watchImpl(this);
  }
  public async checkForChanges(): Promise<void> {
    return checkForChangesImpl(this);
  }
  stopWatching(): void {
    return stopWatchingImpl(this);
  }
  public suppressWatcher(filePath: string): void {
    return suppressWatcherImpl(this, filePath);
  }

  public static ALLOWED_MIME_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    // FNXC:ArtifactRegistry 2026-07-11-10:20: video attachments (screen recordings, demo reels) are first-class — they bridge into the artifact registry and stream through the range-aware media route.
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "text/plain",
    "text/markdown",
    "application/json",
    "text/yaml",
    "text/x-toml",
    "text/csv",
    "application/xml",
  ]);

  public static MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024; // 5MB
  // FNXC:ArtifactRegistry 2026-07-11-10:20: videos get a larger cap than other attachments — a 5MB ceiling cannot hold even a short screen recording.
  public static MAX_VIDEO_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100MB

  async addAttachment( id: string, filename: string, content: Buffer, mimeType: string, ): Promise<TaskAttachment> {
    return addAttachmentImpl(this, id, filename, content, mimeType);
  }
  async getAttachment( id: string, filename: string, ): Promise<{ path: string; mimeType: string }> {
    return getAttachmentImpl(this, id, filename);
  }
  async deleteAttachment(id: string, filename: string): Promise<Task> {
    return deleteAttachmentImpl(this, id, filename);
  }
  async appendAgentLog( taskId: string, text: string, type: AgentLogEntry["type"], detail?: string, agent?: AgentLogEntry["agent"], timing?: Pick<AgentLogEntry, "durationMs" | "timeToFirstTokenMs">, ): Promise<void> {
    return appendAgentLogImpl(this, taskId, text, type, detail, agent, timing);
  }

/** Append a normalized telemetry row to `usage_events` (tool calls, messages, */
  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-16:50:
   */
  async emitUsageEvent(event: UsageEventInput): Promise<boolean> {
    return emitUsageEventImpl(this, event);
  }
  public flushAgentLogBuffer(): void {
    flushAgentLogBufferImpl(this);
  }
  async appendAgentLogBatch( entries: Array<{ taskId: string; text: string; type: AgentLogEntry["type"]; detail?: string; agent?: AgentLogEntry["agent"]; }>, ): Promise<void> {
    return appendAgentLogBatchImpl(this, entries);
  }

  async addTaskComment(id: string, text: string, author: string): Promise<Task> {
    return addTaskCommentImpl(this, id, text, author);
  }
  async addSteeringComment(id: string, text: string, author: "user" | "agent" = "user", runContext?: RunMutationContext): Promise<Task> {
    return addSteeringCommentImpl(this, id, text, author, runContext);
  }
  async updateTaskComment(id: string, commentId: string, text: string): Promise<Task> {
    return updateTaskCommentImpl(this, id, commentId, text);
  }
  async deleteTaskComment(id: string, commentId: string): Promise<Task> {
    return deleteTaskCommentImpl(this, id, commentId);
  }
  async addComment( id: string, text: string, author: string = "user", options?: { skipRefinement?: boolean; source?: "user" | "agent" | "github-review" | "github-review-comment"; externalId?: string; reviewState?: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED"; }, runContext?: RunMutationContext, ): Promise<Task> {
    return addCommentImpl(this, id, text, author, options, runContext);
  }
  public hasActiveTask(taskId: string): boolean {
    return hasActiveTaskImpl(this, taskId);
  }
  public async writeArtifactData(input: ArtifactCreateInput, id: string): Promise<{ uri?: string; sizeBytes?: number; absolutePath?: string }> {
    return writeArtifactDataImpl(this, input, id);
  }
  public insertArtifactRow(input: ArtifactCreateInput, id: string, now: string, stored: { uri?: string; sizeBytes?: number }): Artifact {
    return insertArtifactRowImpl(this, input, id, now, stored);
  }

  /**
   * FNXC:ArtifactRegistry 2026-06-19-22:04:
   */
  async registerArtifact(input: ArtifactCreateInput): Promise<Artifact> {
    return registerArtifactImpl(this, input);
  }

  /**
   * FNXC:ArtifactRegistry 2026-07-10-15:20 (merge port from main):
   * In-place edit of an inline-content artifact from the dashboard Artifacts
   * view. See updateArtifactImpl for the editability/read-only rules.
   */
  async updateArtifact(id: string, updates: { title?: string; description?: string; content?: string }): Promise<Artifact> {
    return updateArtifactImpl(this, id, updates);
  }

  /**
   * FNXC:ArtifactRegistry 2026-06-19-22:04:
   */
  async getArtifact(id: string): Promise<Artifact | null> {
    return getArtifactImpl(this, id);
  }

  /**
   * FNXC:ArtifactRegistry 2026-06-19-22:04:
   */
  async getArtifacts(taskId: string): Promise<Artifact[]> {
    return getArtifactsImpl(this, taskId);
  }

  /** FNXC:ArtifactRegistry 2026-06-19-22:04: FNXC:ArtifactRegistry 2026-06-23-12:48: */
  async listArtifacts(options?: { type?: ArtifactType; authorId?: string; taskId?: string; limit?: number; offset?: number; search?: string; }): Promise<ArtifactWithTask[]> {
    return listArtifactsImpl(this, options);
  }
  async getTaskDocuments(taskId: string): Promise<TaskDocument[]> {
    return getTaskDocumentsImpl(this, taskId);
  }
  async getAllDocuments(options?: { searchQuery?: string; limit?: number; offset?: number; }): Promise<TaskDocumentWithTask[]> {
    return getAllDocumentsImpl(this, options);
  }
  async getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null> {
    return getTaskDocumentImpl(this, taskId, key);
  }
  async upsertTaskDocument(taskId: string, input: TaskDocumentCreateInput): Promise<TaskDocument> {
    return upsertTaskDocumentImpl(this, taskId, input);
  }

/** List archived revisions for a task document, newest first. */
  async getTaskDocumentRevisions( taskId: string, key: string, options?: { limit?: number }, ): Promise<TaskDocumentRevision[]> {
    return getTaskDocumentRevisionsImpl(this, taskId, key, options);
  }
  async deleteTaskDocument(taskId: string, key: string): Promise<void> {
    return deleteTaskDocumentImpl(this, taskId, key);
  }
  public getTaskPrInfos(task: Task): import("./types.js").PrInfo[] {
    return [...(task.prInfos ?? (task.prInfo ? [task.prInfo] : []))];
  }
  public resolvePrimaryPrInfo(prInfos: import("./types.js").PrInfo[]): import("./types.js").PrInfo | undefined {
    return resolvePrimaryPrInfoImpl(this, prInfos);
  }
  public upsertPrInfoByNumber(prInfos: import("./types.js").PrInfo[], prInfo: import("./types.js").PrInfo): import("./types.js").PrInfo[] {
    return upsertPrInfoByNumberImpl(this, prInfos, prInfo);
  }
  async updatePrInfo( id: string, prInfo: import("./types.js").PrInfo | null, ): Promise<Task> {
    return updatePrInfoImpl(this, id, prInfo);
  }
  async addPrInfo(id: string, prInfo: import("./types.js").PrInfo): Promise<Task | undefined> {
    return addPrInfoImpl(this, id, prInfo);
  }
  async updatePrInfoByNumber(id: string, number: number, patch: Partial<import("./types.js").PrInfo>): Promise<Task | undefined> {
    return updatePrInfoByNumberImpl(this, id, number, patch);
  }
  async removePrInfoByNumber(id: string, number: number): Promise<Task | undefined> {
    return removePrInfoByNumberImpl(this, id, number);
  }

/** Update or clear Issue information for a task. */
  async applyPrMergedTransition( taskId: string, ctx?: { agentId?: string; runId?: string }, ): Promise<{ moved: boolean; skipped?: "already-done" | "not-merged" | "wrong-column" | "paused" }> {
    return applyPrMergedTransitionImpl(this, taskId, ctx);
  }
  async updateIssueInfo( id: string, issueInfo: import("./types.js").IssueInfo | null, ): Promise<Task> {
    return updateIssueInfoImpl(this, id, issueInfo);
  }
  async updateGithubTracking( id: string, tracking: import("./types.js").TaskGithubTracking | null, ): Promise<Task> {
    return updateGithubTrackingImpl(this, id, tracking);
  }
  async linkGithubIssue( id: string, issue: import("./types.js").TaskGithubTrackedIssue, ): Promise<Task> {
    return linkGithubIssueImpl(this, id, issue);
  }
  async unlinkGithubIssue(id: string): Promise<Task> {
    return unlinkGithubIssueImpl(this, id);
  }

/*
FNXC:AgentLogRead 2026-07-16-00:00:
Issue #2149 requires read-only type filtering to occur in the file-store before pagination, so a task-chat agent receives a coherent page and a filtered total rather than post-pagination results.
*/
  async getAgentLogs( taskId: string, options?: { limit?: number; offset?: number; type?: AgentLogEntry["type"] }, ): Promise<AgentLogEntry[]> {
    return getAgentLogsImpl(this, taskId, options);
  }
  async getAgentLogCount(taskId: string, options?: { type?: AgentLogEntry["type"] }): Promise<number> {
    return getAgentLogCountImpl(this, taskId, options);
  }

/** Get persisted agent log entries for a task filtered by an inclusive time range. */
  async getAgentLogsByTimeRange( taskId: string, startIso: string, endIso: string | null, ): Promise<AgentLogEntry[]> {
    return getAgentLogsByTimeRangeImpl(this, taskId, startIso, endIso);
  }
  async importLegacyAgentLogs(): Promise<number> {
    return importLegacyAgentLogsImpl(this);
  }
  public async importLegacyAgentLogsOnce(): Promise<void> {
    return importLegacyAgentLogsOnceImpl(this);
  }
  public async migrateAgentLogEntriesToFilesOnce(): Promise<void> {
    return migrateAgentLogEntriesImpl(this);
  }
  public async cleanupNoOpTaskMovedActivityRowsOnce(): Promise<void> {
    return cleanupNoOpTaskMovedActivityRowsOnceImpl(this);
  }
  public async migrateMovedSettingsToWorkflowValuesOnce(): Promise<void> {
    return migrateMovedSettingsImpl(this);
  }
  public async readRawProjectSettings(): Promise<Record<string, unknown>> {
    return readRawProjectSettingsImpl(this);
  }
  public invalidateConfigCacheAfterMigration(): void {
    return invalidateConfigCacheAfterMigrationImpl(this);
  }

  // ── Archive Cleanup Methods ─────────────────────────────────────────

/** Read all archived task entries from SQLite. */
  async readArchiveLog(): Promise<import("./types.js").ArchivedTaskEntry[]> {
    return this.archiveDb.list();
  }

  /**
   * FNXC:ArchivePagination 2026-07-08-00:00:
   * Paged newest-first read for the Archived board column (FN-7659). See
   * listArchivedTasksImpl for the ordering/bounding contract.
   */
  async listArchivedTasks(options?: { limit?: number; offset?: number; slim?: boolean }): Promise<{ tasks: Task[]; total: number; hasMore: boolean }> {
    return listArchivedTasksImpl(this, options);
  }

/** Find a specific task in the archive by ID. */
  async findInArchive(id: string): Promise<import("./types.js").ArchivedTaskEntry | undefined> {
    return this.archiveDb.get(id);
  }
  public migrateLegacyArchiveEntriesToArchiveDb(): void {
    return migrateLegacyArchiveEntriesToArchiveDbImpl(this);
  }
  public async migrateActiveArchivedTasksToArchiveDb(): Promise<void> {
    return migrateActiveArchivedTasksToArchiveDbImpl(this);
  }
  async cleanupArchivedTasks(): Promise<string[]> {
    return cleanupArchivedTasksImpl(this);
  }
  public async restoreFromArchive(entry: import("./types.js").ArchivedTaskEntry): Promise<Task> {
    return restoreFromArchiveImpl(this, entry);
  }
  public generatePromptFromArchiveEntry(entry: import("./types.js").ArchivedTaskEntry): string {
    return generatePromptFromArchiveEntryImpl(this, entry);
  }

  // ── Workflow Step CRUD Methods ─────────────────────────────────────

  async createWorkflowStep(input: import("./types.js").WorkflowStepInput): Promise<import("./types.js").WorkflowStep> {
    return createWorkflowStepImpl(this, input);
  }
  setPluginWorkflowStepTemplates(templates: Array<{ pluginId: string; template: WorkflowStepTemplate }>): void {
    return setPluginWorkflowStepTemplatesImpl(this, templates);
  }
  public resolvePluginWorkflowStep(id: string): import("./types.js").WorkflowStep | undefined {
    return resolvePluginWorkflowStepImpl(this, id);
  }
  async listWorkflowSteps(): Promise<import("./types.js").WorkflowStep[]> {
    return listWorkflowStepsImpl(this);
  }
  async getWorkflowStep(id: string): Promise<import("./types.js").WorkflowStep | undefined> {
    return getWorkflowStepImpl(this, id);
  }
  async updateWorkflowStep(id: string, updates: Partial<import("./types.js").WorkflowStepInput>): Promise<import("./types.js").WorkflowStep> {
    return updateWorkflowStepImpl(this, id, updates);
  }
  async deleteWorkflowStep(id: string): Promise<void> {
    return deleteWorkflowStepImpl(this, id);
  }

  // ── Workflow definitions (named WorkflowIr graphs) ─────────────────────

  /** Allocate the next workflow-definition id (WF-001, WF-002, …) using a
   *  monotonic counter persisted in __meta. Never reuses ids across deletes. */
  public nextWorkflowDefinitionId(): string {
    return nextWorkflowDefinitionIdImpl(this);
  }
  public toWorkflowDefinition(row: StoredWorkflowRow): WorkflowDefinition {
    return toWorkflowDefinitionImpl(this, row);
  }
  public parseWorkflowLayout( raw: string, ): Record<string, WorkflowNodeLayout> {
    return parseWorkflowLayoutImpl(this, raw);
  }
  public assertWorkflowIrTraitsValid(ir: WorkflowIr): void {
    return assertWorkflowIrTraitsValidImpl(this, ir);
  }
  async createWorkflowDefinition( input: WorkflowDefinitionInput, ): Promise<WorkflowDefinition> {
    return createWorkflowDefinitionImpl(this, input);
  }

/** only workflows or only fragments; omit it to get the full merged set. */
  async listWorkflowDefinitions( options?: { kind?: WorkflowDefinition["kind"]; includeDisabledBuiltins?: boolean }, ): Promise<WorkflowDefinition[]> {
    return listWorkflowDefinitionsImpl(this, options);
  }
  public async readAllWorkflowDefinitions(): Promise<WorkflowDefinition[]> {
    return readAllWorkflowDefinitionsImpl(this);
  }
  public applyBuiltInPromptOverridesSync(workflowId: string, ir: WorkflowIr): WorkflowIr {
    return applyBuiltInPromptOverridesSyncImpl(this, workflowId, ir);
  }

  /** Get a single workflow definition by id, or undefined when absent. */
  async getWorkflowDefinition( id: string, ): Promise<WorkflowDefinition | undefined> {
    return getWorkflowDefinitionImpl(this, id);
  }
  async updateWorkflowDefinition( id: string, updates: WorkflowDefinitionUpdate, ): Promise<WorkflowDefinition> {
    return updateWorkflowDefinitionImpl(this, id, updates);
  }
  async deleteWorkflowDefinition(id: string): Promise<void> {
    return deleteWorkflowDefinitionImpl(this, id);
  }

  // ── U5: workflow lifecycle reconciliation (switch / edit / delete) ──────────
  // FNXC:WorkflowColumns 2026-06-20-00:00:
  // Re-homing moves always route through moveTask (engine + bypassGuards, KTD-9),
  // never a raw column write, so capacity (KTD-10) and single transition authority
  // (KTD-3) are honored. Only consulted when `workflowColumns` flag is ON.

  public async workflowColumnsFlagOn(): Promise<boolean> {
    return isWorkflowColumnsCompatibilityFlagEnabled(await this.getSettingsFast());
  }
  public async listWorkflowOccupantTaskIds(workflowId: string, includeNullSelection: boolean): Promise<string[]> {
    return listWorkflowOccupantTaskIdsImpl(this, workflowId, includeNullSelection);
  }

  /** Map column id → occupant count for the tasks selecting `workflowId`
   *  (plus null-selection tasks when `includeNullSelection`). */
  public async occupantsByColumnForWorkflow( workflowId: string, includeNullSelection: boolean, ): Promise<Map<string, number>> {
    return occupantsByColumnForWorkflowImpl(this, workflowId, includeNullSelection);
  }
  public async rehomeOccupant( taskId: string, targetColumn: string, reason: "workflow-switch" | "workflow-delete" | "workflow-edit-rehome", metadata: Record<string, unknown>, ): Promise<void> {
    return rehomeOccupantImpl(this, taskId, targetColumn, reason, metadata);
  }

  // ── U12: workflow-columns integrity pass ──────────────────────────────────
  // FNXC:WorkflowColumns 2026-06-20-00:00:
  // Migration rewrites ZERO task rows (KTD-1): null selection resolves to built-in
  // default workflow at read time with byte-identical column IDs. The integrity
  // pass audits tasks whose stored column is not valid in their RESOLVED workflow
  // and re-homes via recoveryRehome (guard-bypassing, capacity-honoring). Terminal
  // cards (done/archived) are never disturbed. Idempotent. Flag-ON only.
  async runWorkflowColumnsIntegrityPass(): Promise<{ scanned: number; rehomed: number; skippedTerminal: number }> {
    return runWorkflowColumnsIntegrityPassImpl(this);
  }

  // ── #1401: transitionPending recovery sweep ───────────────────────────────
  // FNXC:WorkflowColumns 2026-06-20-00:00:
  // A crash between the in-txn transitionPending marker write and the post-commit
  // clearTransitionPending leaves the marker set forever, permanently inflating
  // the (workflow, column) capacity count. This sweep reconciles hooksRemaining,
  // re-runs surviving idempotent post-commit hooks, audits recovery, and clears
  // the marker. Idempotent. Runs at store init and periodically (flag-ON cadence).
  async recoverStaleTransitionPending(): Promise<{ scanned: number; recovered: number; degradedHooks: number }> {
    return recoverStaleTransitionPendingImpl(this);
  }

  // ── #1409: flag ON→OFF evacuation ─────────────────────────────────────────
  // FNXC:WorkflowColumns 2026-06-20-00:00:
  // When `workflowColumns` is disabled, the board reverts to the legacy enum path
  // where only COLUMNS are valid. Cards in CUSTOM (non-legacy) columns would be
  // stuck. This pass re-homes each to the nearest legacy column (default workflow
  // entry column `todo`) via recoveryRehome. Terminal cards (done/archived) left
  // put. Idempotent.
  async evacuateCustomColumnsToLegacy( trigger: "flag-off-init" | "flag-toggled-off", ): Promise<{ scanned: number; evacuated: number }> {
    return evacuateCustomColumnsToLegacyImpl(this, trigger);
  }

  // ── Workflow selection (resolves a workflow to enabledWorkflowSteps) ────
  // Selection compiles a workflow into WorkflowStep rows and writes their ids into
  // the task's enabledWorkflowSteps. Never touches scheduler/executor/merger.

  async getDefaultWorkflowId(): Promise<string | undefined> {
    return getDefaultWorkflowIdImpl(this);
  }
  async setDefaultWorkflowId(workflowId: string | null): Promise<void> {
    return setDefaultWorkflowIdImpl(this, workflowId);
  }

/** Synchronous workflow-definition insert used by migration (U2/KTD-3). */
  public insertWorkflowDefinitionSync( input: WorkflowDefinitionInput, flagOn: boolean, ): WorkflowDefinition {
    return insertWorkflowDefinitionSyncImpl(this, input, flagOn);
  }
  async migrateLegacyWorkflowSteps(): Promise<{ migrated: number; skipped: number; combinedWorkflowId?: string; }> {
    return migrateLegacyWorkflowStepsImpl(this);
  }

  /** Whether a raw workflow CLI command has been approved (trust-on-first-use).
   *  Comparison is on the exact trimmed command string. */
  async isWorkflowCliCommandApproved(command: string): Promise<boolean> {
    return isWorkflowCliCommandApprovedImpl(this, command);
  }
  async approveWorkflowCliCommand(command: string): Promise<void> {
    return approveWorkflowCliCommandImpl(this, command);
  }
  async isCliAutonomyApproved(adapterId: string): Promise<boolean> {
    return isCliAutonomyApprovedImpl(this, adapterId);
  }

  /** Record approval for elevated CLI-agent autonomy for an adapter. Idempotent.
   *  The approving principal in v1 is the daemon-token holder (route-level). */
  async approveCliAutonomy(adapterId: string): Promise<void> {
    return approveCliAutonomyImpl(this, adapterId);
  }
  async revokeCliAutonomy(adapterId: string): Promise<void> {
    return revokeCliAutonomyImpl(this, adapterId);
  }
  async listApprovedCliAutonomyAdapters(): Promise<string[]> {
    return listApprovedCliAutonomyAdaptersImpl(this);
  }

  /** Read the workflow currently selected for a task, if any. */
/** Synchronously resolve the parsed WorkflowIr that governs a task's columns */
/** U8 (KTD-2): record a pre-evaluated plugin gate verdict for a move into */
  recordPluginGateVerdict( taskId: string, toColumn: string, verdict: Omit<PluginGateVerdict, "recordedAt"> & { recordedAt?: number }, ): void {
    return recordPluginGateVerdictImpl(this, taskId, toColumn, verdict);
  }
  consumePluginGateVerdicts(taskId: string, toColumn: string): PluginGateVerdict[] {
    return consumePluginGateVerdictsImpl(this, taskId, toColumn);
  }
  public resolveTaskCustomFieldDefsSync(taskId: string): WorkflowFieldDefinition[] {
    return resolveTaskCustomFieldDefsSyncImpl(this, taskId);
  }
  public resolveTaskWorkflowIrSync(taskId: string): WorkflowIr {
    return resolveTaskWorkflowIrSyncImpl(this, taskId);
  }
  public resolveEffectiveWorkflowIdSync(taskId: string): string {
    return resolveEffectiveWorkflowIdSyncImpl(this, taskId);
  }
  public countActiveInCapacitySlotSync(params: { targetColumn: string; workflowId: string; countPending: boolean; excludeTaskId: string; }): number {
    return countActiveInCapacitySlotSyncImpl(this, params);
  }

  /**
   * FNXC:RuntimeTaskOrchestrationAsync 2026-06-24-14:35:
   */
  public async countActiveInCapacitySlotAsync(params: { tx: DbTransaction; targetColumn: string; workflowId: string; countPending: boolean; excludeTaskId: string; }): Promise<number> {
    return countActiveInCapacitySlotAsyncImpl(this, params);
  }
  getTaskWorkflowSelection(taskId: string): { workflowId: string; stepIds: string[] } | undefined {
    return getTaskWorkflowSelectionImpl(this, taskId);
  }
  /** FNXC:PostgresCutover 2026-07-04-00:00: authoritative backend-mode read (async Drizzle); SQLite delegates to the sync getter. */
  public async getTaskWorkflowSelectionAsync(taskId: string): Promise<{ workflowId: string; stepIds: string[] } | undefined> {
    return getTaskWorkflowSelectionAsyncImpl(this, taskId);
  }
  public async writeTaskWorkflowSelection(taskId: string, workflowId: string, stepIds: string[]): Promise<void> {
    return writeTaskWorkflowSelectionImpl(this, taskId, workflowId, stepIds);
  }

  /** Delete the WorkflowStep rows previously materialized for a task's selection
   *  and remove the selection record. Best-effort; safe to call when unset. */
  public async removeMaterializedSelection(taskId: string): Promise<void> {
    return removeMaterializedSelectionImpl(this, taskId);
  }
  public purgeTaskWorkflowSelectionRows(taskId: string): void {
    return purgeTaskWorkflowSelectionRowsImpl(this, taskId);
  }
  public cleanupOrphanedMaterializedSteps(stepIds: string[] | undefined): Promise<void> {
    return cleanupOrphanedMaterializedStepsImpl(this, stepIds);
  }
  public async materializeWorkflowSteps( workflowId: string, inputs: import("./types.js").WorkflowStepInput[], ): Promise<string[]> {
    return materializeWorkflowStepsImpl(this, workflowId, inputs);
  }

  /** Resolve the project-default workflow into materialized step ids, or null
   *  when no default is set / it is missing / it does not compile. */
  public async materializeDefaultWorkflowSteps(): Promise<{ workflowId: string; stepIds: string[]; entryColumnId?: string } | undefined> {
    return materializeDefaultWorkflowStepsImpl(this);
  }
  public async materializeExplicitWorkflowSteps( workflowId: string, ): Promise<{ workflowId: string; stepIds: string[]; entryColumnId?: string }> {
    return materializeExplicitWorkflowStepsImpl(this, workflowId);
  }
  async selectTaskWorkflow(taskId: string, workflowId: string): Promise<string[]> {
    return selectTaskWorkflowImpl(this, taskId, workflowId);
  }
  public async reconcileTaskCustomFieldsForSchema( taskId: string, oldFieldDefs: WorkflowFieldDefinition[], newFieldDefs: WorkflowFieldDefinition[], dropOrphans = false, ): Promise<void> {
    return reconcileTaskCustomFieldsForSchemaImpl(this, taskId, oldFieldDefs, newFieldDefs, dropOrphans);
  }

/** U5 (R20) workflow switch: select a workflow for a task and, when the */
  async selectTaskWorkflowAndReconcile( taskId: string, workflowId: string, ): Promise<{
    enabledWorkflowSteps: string[];
    reconciliation?: { preserved: boolean; fromColumn: string; toColumn: string };
  }> {
    return selectTaskWorkflowAndReconcileImpl(this, taskId, workflowId);
  }
  async clearTaskWorkflowSelection(taskId: string): Promise<void> {
    return clearTaskWorkflowSelectionImpl(this, taskId);
  }
  async close(): Promise<void> {
    return closeImpl(this);
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
   * The default preserves SQLite's aggressive TRUNCATE behavior for explicit maintenance/compaction calls.
   * Live engine maintenance should request PASSIVE explicitly to avoid forcing a blocking truncate on the shared event loop.
   */
  walCheckpoint(mode?: "PASSIVE" | "TRUNCATE"): { busy: number; log: number; checkpointed: number } {
    return this.db.walCheckpoint(mode);
  }

/** Delete append-only operational-log rows older than `retentionMs`. */
  pruneOperationalLogs(retentionMs: number): { deletedByTable: Record<string, number>; deletedTotal: number } {
    return this.db.pruneOperationalLogs(retentionMs);
  }

  async pruneOperationalLogsAsync(retentionMs: number): Promise<OperationalLogPruneResult> {
    if (!this.asyncLayer) {
      return this.pruneOperationalLogs(retentionMs);
    }
    return pruneOperationalLogsAsync(this.asyncLayer, retentionMs);
  }
  pruneAgentLogFiles(retentionDays: number): { prunedFiles: number; prunedEntries: number; freedBytes: number } {
    return pruneAgentLogFilesImpl(this, retentionDays);
  }
  /**
   * FNXC:PostgresOnlyDataAccess 2026-07-17-14:20:
   * Backend-mode entry point for agent-log-file pruning. The sync
   * `pruneAgentLogFiles` reads inactive task ids via `this.db` and throws in
   * backend mode; callers (the self-healing maintenance sweep) MUST use this
   * async variant, which routes to `project.tasks` when an AsyncDataLayer is
   * present and falls back to the legacy sync path otherwise. Mirrors
   * `pruneOperationalLogsAsync`.
   */
  async pruneAgentLogFilesAsync(retentionDays: number): Promise<{ prunedFiles: number; prunedEntries: number; freedBytes: number }> {
    if (!this.asyncLayer) {
      return this.pruneAgentLogFiles(retentionDays);
    }
    return pruneAgentLogFilesAsync(this.asyncLayer, this.tasksDir, retentionDays);
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

  /**
   * FNXC:PostgresOnlyDataAccess 2026-07-16-10:20:
   * This legacy synchronous SQLite accessor is unavailable in backend mode and
   * must not be used by plugin, dashboard, engine, or feature data paths.
   * Durable production access uses getAsyncLayer() and an async store.
   */
  getDatabase(): Database {
    return this.db;
  }

  /** FNXC:RuntimeBackendInjection 2026-06-24-14:25: Returns injected AsyncDataLayer (PostgreSQL) or null (legacy SQLite path). Returns null (not throw) so callers branch with `if (layer)`. */
  getAsyncLayer(): AsyncDataLayer | null {
    return this.asyncLayer;
  }

  /**
   * FNXC:RuntimeBackendInjection 2026-06-24-14:25: True when the store was constructed with an AsyncDataLayer and therefore routes data access through PostgreSQL.
   * Exposed for the decomposed modules and engine paths that need to branch without holding the layer reference.
   */
  isBackendMode(): boolean {
    return this.backendMode;
  }
  getBootstrappedAt(): number | null {
    return this.db.getBootstrappedAt();
  }
  async getSecretsStore(): Promise<SecretsStore> {
    return getSecretsStoreImpl(this);
  }
  getDatabaseHealth(): {
    healthy: boolean;
    corruptionDetected: boolean;
    corruptionErrors: string[];
    lastCheckedAt: Date | null;
    isRunning: boolean;
  } {
    return getDatabaseHealthImpl(this);
  }
  refreshDatabaseHealth(): ReturnType<TaskStore["getDatabaseHealth"]> {
    return refreshDatabaseHealthImpl(this);
  }
  getDistributedTaskIdAllocator(): DistributedTaskIdAllocator {
    return getDistributedTaskIdAllocatorImpl(this);
  }
  healthCheck(): boolean {
    return healthCheckImpl(this);
  }
  public generateSpecifiedPrompt(task: Task): string {
    return generateSpecifiedPromptImpl(this, task);
  }
  public getSettingsSync(): Settings {
    return getSettingsSyncImpl(this);
  }

  // ── Activity Log Methods ─────────────────────────────────────────

  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-16:00:
   */
  async recordActivity(entry: Omit<ActivityLogEntry, "id" | "timestamp">): Promise<ActivityLogEntry> {
    return recordActivityImpl(this, entry);
  }

/** Get activity log entries from SQLite. */
  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-16:02:
   */
  async getActivityLog(options?: { limit?: number; since?: string; type?: ActivityEventType }): Promise<ActivityLogEntry[]> {
    return getActivityLogImpl(this, options);
  }

  /**
   * FNXC:RuntimeWorkflowAsync 2026-06-24-16:04:
   */
  async getTaskMovedCountsByDay(options: { since: string; until: string; fromColumn?: string; toColumn?: string; }): Promise<Record<string, number>> {
    return getTaskMovedCountsByDayImpl(this, options);
  }
  async getInReviewDurationEvents(options: { since: string; until: string }): Promise<ActivityLogEntry[]> {
    return getInReviewDurationEventsImpl(this, options);
  }
  async getTaskMergedTaskIds(options: { since: string; until: string }): Promise<Set<string>> {
    return getTaskMergedTaskIdsImpl(this, options);
  }
  async clearActivityLog(): Promise<void> {
    return clearActivityLogImpl(this);
  }
  getMissionStore(): MissionStore | AsyncMissionStore {
    return getMissionStoreImpl(this);
  }

  getIdeationStore(): AsyncIdeationStore {
    return getIdeationStoreImpl(this);
  }
  getPluginStore(): PluginStore {
    return getPluginStoreImpl(this);
  }
  /**
   * FNXC:PluginPostgresSchema 2026-07-16-00:00:
   * FN-8104 retires the unreachable SQLite schema-init fallback that FN-8103
   * temporarily allowlisted. Every host now invokes only the PostgreSQL
   * AsyncDataLayer executor after loading plugins; SQLite-only hooks remain unsupported.
   */
  /** @internal Installed by the backend startup factory; never exposed through PluginContext. */
  setPluginPostgresSchemaExecutor(
    executor: (contracts: readonly LoadedPluginSchemaContract[]) => Promise<void>,
  ): void {
    this.pluginPostgresSchemaExecutor = executor;
  }

  preflightPluginSchema(
    pluginId: string,
    hooks: { onSchemaInit?: PluginOnSchemaInit; onPostgresSchemaInit?: () => PluginPostgresSchemaDefinition },
  ): LoadedPluginSchemaContract | null {
    const postgresSchema = hooks.onPostgresSchemaInit?.();
    const contract = hooks.onSchemaInit || postgresSchema
      ? { pluginId, legacyHook: hooks.onSchemaInit, postgresSchema }
      : null;
    if (this.backendMode && contract) assertLoadedPluginSchemaInitHooksSupported([contract]);
    return contract;
  }

  async runPluginSchemaInits(hooks: LoadedPluginSchemaContract[]): Promise<void> {
    if (!this.getAsyncLayer()) throw new Error("backend TaskStore is missing its AsyncDataLayer");
    assertLoadedPluginSchemaInitHooksSupported(hooks);
    if (!this.pluginPostgresSchemaExecutor) {
      throw new Error("backend TaskStore is missing its PostgreSQL plugin schema executor");
    }
    await this.pluginPostgresSchemaExecutor(hooks);
  }
  public async isPluginInstalled(pluginId: string): Promise<boolean> {
    return isPluginInstalledImpl(this, pluginId);
  }
  getInsightStore(): InsightStore | AsyncInsightStore {
    return getInsightStoreImpl(this);
  }
  getResearchStore(): ResearchStore | AsyncResearchStore {
    return getResearchStoreImpl(this);
  }
  getExperimentSessionStore(): ExperimentSessionStore {
    return getExperimentSessionStoreImpl(this);
  }
  getTodoStore(): TodoStore | AsyncTodoStore {
    return getTodoStoreImpl(this);
  }
   getGoalStore(): GoalStore | AsyncGoalStore {
    return getGoalStoreImpl(this);
  }
   getEvalStore(): EvalStore | AsyncEvalStore {
    return getEvalStoreImpl(this);
  }

  // ── Verification Cache ────────────────────────────────────────────────────

/** Look up a previously recorded verification cache pass for a given tree sha */
  async getVerificationCacheHit( treeSha: string, testCommand: string, buildCommand: string, ): Promise<{ recordedAt: string; taskId: string | null } | null> {
    return getVerificationCacheHitImpl(this, treeSha, testCommand, buildCommand);
  }

/** Record a successful verification pass for the given tree sha and commands. */
  async recordVerificationCachePass( treeSha: string, testCommand: string, buildCommand: string, taskId: string, ): Promise<void> {
    return recordVerificationCachePassImpl(this, treeSha, testCommand, buildCommand, taskId);
  }

  // ── Import Translation Cache ──────────────────────────────────────────────

  /*
  FNXC:GitHubImportTranslate 2026-07-15-09:30:
  Durable translation cache for the Import Tasks panel. The preview and the import path both read through here, so an imported task carries the same translated prose the operator approved in the preview.
  */

  /** Cached translation for an import item, or null on miss/edited-since. */
  getImportTranslation(
    key: ImportTranslationCacheKey,
  ): Promise<ImportTranslationCacheEntry | null> {
    return getImportTranslationImpl(this, key);
  }

  /** Upsert a translation for an import item. */
  recordImportTranslation(
    key: ImportTranslationCacheKey,
    value: { translatedTitle: string; translatedBody: string; detectedLocale?: string | null },
    recordedAt: string = new Date().toISOString(),
  ): Promise<void> {
    return recordImportTranslationImpl(this, key, value, recordedAt);
  }

  /** Drop cached translations for issues observed closed. */
  pruneImportTranslations(
    provider: string,
    repoKey: string,
    closedIssueNumbers: number[],
  ): Promise<number> {
    return pruneImportTranslationsImpl(this, provider, repoKey, closedIssueNumbers);
  }

  // ── Shared mesh state export/apply helpers ───────────────────────────────

  async upsertTaskCommitAssociation( input: Omit<TaskCommitAssociation, "id" | "createdAt" | "updatedAt"> & { id?: string }, ): Promise<TaskCommitAssociation> {
    return upsertTaskCommitAssociationImpl(this, input);
  }
  async getTaskCommitAssociationsByLineageId(lineageId: string): Promise<TaskCommitAssociation[]> {
    return getTaskCommitAssociationsByLineageIdImpl(this, lineageId);
  }

  /**
   * FNXC:CommandCenterLocBackfill 2026-06-19-12:30: Historical LOC backfill is an explicit operator action that fills only rows where both diff-stat columns are NULL.
   * FN-6704 writes additions/deletions atomically, so candidate selection and updates guard on both columns to stay idempotent and avoid overwriting already-captured stats.
   * Stored SHAs are untrusted; validate them before git interpolation.
   * Unavailable commit objects remain NULL because NULL means "stats unknown" while 0 is a real zero-line stat.
   * Dry-run reports the rows that would be updated without writing them.
   */
  async backfillCommitAssociationDiffStats( options: { dryRun?: boolean } = {}, ): Promise<CommitAssociationDiffBackfillReport> {
    return backfillCommitAssociationDiffStatsImpl(this, options);
  }
  async replaceLegacyTaskCommitAssociations( lineageId: string, associations: Array<Omit<TaskCommitAssociation, "id" | "createdAt" | "updatedAt" | "taskLineageId">>, ): Promise<void> {    return replaceLegacyTaskCommitAssociationsImpl(this, lineageId, associations);
  }

  // ── Backward Compatibility (Multi-Project Support) ────────────────────────

}

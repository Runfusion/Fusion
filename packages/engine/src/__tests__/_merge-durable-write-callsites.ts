/*
FNXC:MergeReliability 2026-08-09-12:00:
FN-8923 inventories durable writes over the pinned merge-module closure and the task-store
surface. This deliberately uses TypeScript AST nodes: textual scans cannot distinguish a call
from a comment or retain an enclosing closure when formatting changes.

The alias rule is deliberately narrow. A single-assignment local initialized from `store` or
`options.store` is a provable task-store alias; computed and destructured receivers fail closed
as suspects rather than being silently omitted from the frontier.
*/
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(__dirname, "../../../..");
const STORE_SOURCE = "packages/core/src/store.ts";
const ENTRY = "packages/engine/src/merge/merger-ai.ts";

/** These imports cross independently-owned subsystem boundaries; their internal writes are not
 * merge-body call sites. They remain explicit, pinned boundaries rather than an implicit cap. */
// FN-8923 walks the required finalization module. Boundaries are reserved for a genuinely
// structural edge that cannot be scanned; none is currently declared.
export const CLOSURE_BOUNDARY: readonly { module: string; reason: string }[] = [];

/** Module-level persistence helpers are not TaskStore methods. */
export const EXTRA_WRITERS = ["finalizeProvenAutoMergeTask", "syncGroupPrOnLanding"] as const;

/** Names which can look like extra writers but are local event callbacks, never TaskStore writes. */
const NOT_A_DURABLE_WRITE: Record<string, string> = {
  emit: "local merge strategy callback, not TaskStore.emit",
  checkAndRecordUnplannedExecutionBlock: "module helper call; its TaskStore write is scanned at the helper implementation rather than at this forwarding call",
};

export type SurfaceClassification = { method: string; kind: "writer" | "non-writer"; reason: string };
export type DerivedCallSite = { callSiteId: string; callSiteFingerprint: string; file: string; enclosingSymbolPath: string; writer: string; ordinal: number; lineHint: number };
export type Suspect = { file: string; line: number; text: string; reason: string };

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function repo(path: string): string { return relative(ROOT, path).replaceAll("\\", "/"); }
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  // TypeScript source conventionally imports emitted `.js` paths. Resolve that emitted suffix
  // back to the authored TypeScript module before probing candidates.
  const sourceBase = base.replace(/\.(?:m?js|cjs)$/, "");
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), `${sourceBase}.ts`, `${sourceBase}.tsx`, join(sourceBase, "index.ts")]) if (existsSync(candidate)) return candidate;
  return undefined;
}

/**
 * FNXC:MergeReliability 2026-08-10-20:22:
 * The durable surface is not a second hand-maintained writer list. This single classification
 * map is checked against every AST-extracted public TaskStore member; a new member is
 * unclassified until its durable-write semantics are reviewed here.
 */
const STORE_METHOD_CLASSIFICATION: Record<string, Omit<SurfaceClassification, "method">> = {
  // FN-8923: These are public TaskStore operations that persist, mutate, or announce task-scoped state.
  // They must remain writers even when no current merge path calls them, or a future merge call would evade the frontier.
  _createTaskInternal: { kind: "writer", reason: "persists or mutates TaskStore state" },
  _createTaskInternalBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  _maybeAutoArchiveSameAgentDuplicate: { kind: "writer", reason: "persists or mutates TaskStore state" },
  _maybeAutoArchiveSameAgentDuplicateBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addAttachment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addPrInfo: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addSteeringComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  addTaskComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendAgentLogBatch: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendCurrentPlanEvidence: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendSpecDriftReport: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendSpecDriftReportWhilePlanningLocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendSpecLock: { kind: "writer", reason: "persists or mutates TaskStore state" },
  applyBuiltInPromptOverridesAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  applyBuiltInPromptOverridesSync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  applyLegacyWorkflowStepOverrides: { kind: "writer", reason: "persists or mutates TaskStore state" },
  applyTerminalFailureAutoRecoveryRetry: { kind: "writer", reason: "persists terminal-failure recovery state" },
  claimTerminalFailureAutoRecoveryAttempt: { kind: "writer", reason: "persists terminal-failure recovery claim state" },
  applyPrMergedTransition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  approveCliAutonomy: { kind: "writer", reason: "persists or mutates TaskStore state" },
  approveWorkflowCliCommand: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveAllDone: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveDb: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveEntryToTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveTaskAndCleanup: { kind: "writer", reason: "persists or mutates TaskStore state" },
  archiveTaskBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  atomicCreateTaskJson: { kind: "writer", reason: "persists or mutates TaskStore state" },
  atomicWriteTaskJson: { kind: "writer", reason: "persists or mutates TaskStore state" },
  atomicWriteTaskJsonWithAudit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  backfillCommitAssociationDiffStats: { kind: "writer", reason: "persists or mutates TaskStore state" },
  bypassFailedPreMergeReviewStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cancelActiveWorkflowWorkItemsForTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  captureCurrentPlanEvidence: { kind: "writer", reason: "persists or mutates TaskStore state" },
  captureCurrentPlanEvidenceWhilePlanningLocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  checkAndRecordUnplannedExecutionBlock: { kind: "writer", reason: "persists or mutates TaskStore state" },
  claimNextToolFailureRetry: { kind: "writer", reason: "persists or mutates TaskStore state" },
  claimTaskVerificationRequest: { kind: "writer", reason: "persists or mutates TaskStore state" },
  claimTaskWedgeNotificationEpisode: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupArchivedTasks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupBranchForTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupNoOpTaskMovedActivityRowsOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupOrphanedMaterializedSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  cleanupStaleMergeQueueRows: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearActivityLog: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearCompletionHandoffAcceptedMarker: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearDoneTransientFields: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearLinkedAgentTaskIds: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearNearDuplicateReferencesTo: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearNearDuplicateReferencesToFailSoft: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearStaleExecutionStartBranchReferences: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearTaskWorkflowSelection: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearWorkflowRunBranches: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearWorkflowRunStepInstances: { kind: "writer", reason: "persists or mutates TaskStore state" },
  clearWorkflowRunStepInstancesAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  consumePluginGateVerdicts: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createBranchGroup: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createCompletionHandoffWorkflowWork: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTaskBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTaskVerificationRequest: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTaskWithDistributedReservation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createTaskWithReservedId: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createWorkflowDefinition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  createWorkflowStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteAttachment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskById: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskDocument: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteTaskIf: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteWorkflowDefinition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  deleteWorkflowStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  dequeueMergeQueueOnColumnExit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  detectAndCacheTaskIdIntegrityReport: { kind: "writer", reason: "persists or mutates TaskStore state" },
  duplicateTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  emitObservedTaskDeleted: { kind: "writer", reason: "persists or mutates TaskStore state" },
  emitTaskLifecycleEventSafely: { kind: "writer", reason: "persists or mutates TaskStore state" },
  emitUsageEvent: { kind: "writer", reason: "persists or mutates TaskStore state" },
  enqueueMergeQueue: { kind: "writer", reason: "persists or mutates TaskStore state" },
  ensureBranchGroupForSource: { kind: "writer", reason: "persists or mutates TaskStore state" },
  ensurePrEntityForSource: { kind: "writer", reason: "persists or mutates TaskStore state" },
  ensureWorkflowStepForTemplate: { kind: "writer", reason: "persists or mutates TaskStore state" },
  finishTaskVerificationRequest: { kind: "writer", reason: "persists or mutates TaskStore state" },
  flushAgentLogBuffer: { kind: "writer", reason: "persists or mutates TaskStore state" },
  importLegacyAgentLogs: { kind: "writer", reason: "persists or mutates TaskStore state" },
  importLegacyAgentLogsOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertArtifactRow: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertCompletionHandoffWorkflowWorkAudit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertRunAuditEventRow: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertTaskWithFtsRecovery: { kind: "writer", reason: "persists or mutates TaskStore state" },
  insertWorkflowDefinitionSync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  invalidateConfigCacheAfterMigration: { kind: "writer", reason: "persists or mutates TaskStore state" },
  linkGithubIssue: { kind: "writer", reason: "persists or mutates TaskStore state" },
  linkTaskRecommendation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  lockCurrentPlan: { kind: "writer", reason: "persists or mutates TaskStore state" },
  lockCurrentPlanWhilePlanningLocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  logTaskCreateConflict: { kind: "writer", reason: "persists or mutates TaskStore state" },
  markLegacyAutoMergeStampsOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  markToolFailureRetryExhaustedAudit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  markTerminalFailureAutoRecoveryBudgetExhausted: { kind: "writer", reason: "persists terminal-failure recovery budget state" },
  markTerminalFailureAutoRecoveryEscalationDelivered: { kind: "writer", reason: "persists terminal-failure escalation delivery state" },
  materializeDefaultWorkflowSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  materializeExplicitWorkflowSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  materializeWorkflowSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateActiveArchivedTasksToArchiveDb: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateAgentLogEntriesToFilesOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateLegacyArchiveEntriesToArchiveDb: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateLegacyWorkflowSteps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  migrateMovedSettingsToWorkflowValuesOnce: { kind: "writer", reason: "persists or mutates TaskStore state" },
  moveTaskIf: { kind: "writer", reason: "persists or mutates TaskStore state" },
  moveTaskInternal: { kind: "writer", reason: "persists or mutates TaskStore state" },
  moveToDone: { kind: "writer", reason: "persists or mutates TaskStore state" },
  patchTaskRowInTransaction: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pauseTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneAgentActivityEventsAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneAgentLogFiles: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneAgentLogFilesAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneImportTranslations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneOperationalLogs: { kind: "writer", reason: "persists or mutates TaskStore state" },
  pruneOperationalLogsAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  publishArchivedTaskDocumentAddition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  purgeTaskWorkflowSelectionRows: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileActiveTimingForEngineDowntime: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileDistributedTaskIdStateOnOpen: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileLegacyAutoMergeStamps: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileOrphanedTaskDirs: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcilePhantomCommittedReservations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileSoftDeletedColumnDriftBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileSpecDrift: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileSpecDriftWhilePlanningLocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileStaleSymbolLocks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  reconcileTaskCustomFieldsForSchema: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordActivity: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordActivityFromListener: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordAgentActivity: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordDependencyCycleRejectedAudit: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordGoalCitations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordImportTranslation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordPluginActivation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordPluginGateVerdict: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordPrThreadOutcome: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordRunAuditEventBackend: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recordVerificationCachePass: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recoverExpiredMergeQueueLeases: { kind: "writer", reason: "persists or mutates TaskStore state" },
  recoverStaleTransitionPending: { kind: "writer", reason: "persists or mutates TaskStore state" },
  refreshTaskIdIntegrityReport: { kind: "writer", reason: "persists or mutates TaskStore state" },
  registerArtifact: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rehomeOccupant: { kind: "writer", reason: "persists or mutates TaskStore state" },
  releaseMergeQueueLease: { kind: "writer", reason: "persists or mutates TaskStore state" },
  releaseSymbolLocks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  removeMaterializedSelection: { kind: "writer", reason: "persists or mutates TaskStore state" },
  renewCheckoutLease: { kind: "writer", reason: "persists or mutates TaskStore state" },
  renewSymbolLocks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  repairOverlapBlocker: { kind: "writer", reason: "persists or mutates TaskStore state" },
  replaceActiveTaskWorkflowContinuation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  replaceLegacyTaskCommitAssociations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  resetAllStepsToPending: { kind: "writer", reason: "persists or mutates TaskStore state" },
  resetPromptCheckboxes: { kind: "writer", reason: "persists or mutates TaskStore state" },
  resetTerminalFailureAutoRecoveryBudget: { kind: "writer", reason: "persists terminal-failure recovery budget state" },
  restoreFromArchive: { kind: "writer", reason: "persists or mutates TaskStore state" },
  resumeWorkflowStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  revokeCliAutonomy: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rewriteBlockedByResidueDependentsForRemoval: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rewriteDependentsForRemoval: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rewriteLineageChildrenForRemoval: { kind: "writer", reason: "persists or mutates TaskStore state" },
  rollbackConfiguration: { kind: "writer", reason: "persists or mutates TaskStore state" },
  runPluginColumnTransitionHooks: { kind: "writer", reason: "persists or mutates TaskStore state" },
  runPluginSchemaInits: { kind: "writer", reason: "persists or mutates TaskStore state" },
  runTaskFtsWriteWithRecovery: { kind: "writer", reason: "persists or mutates TaskStore state" },
  saveWorkflowRunBranch: { kind: "writer", reason: "persists or mutates TaskStore state" },
  saveWorkflowRunStepInstance: { kind: "writer", reason: "persists or mutates TaskStore state" },
  saveWorkflowRunStepInstanceAsync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  scanAndRecordCitations: { kind: "writer", reason: "persists or mutates TaskStore state" },
  seedStrandedPlanReviewContinuation: { kind: "writer", reason: "persists or mutates TaskStore state" },
  selectTaskWorkflow: { kind: "writer", reason: "persists or mutates TaskStore state" },
  selectTaskWorkflowAndReconcile: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setCompletionHandoffAcceptedMarker: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setDefaultWorkflowId: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setPluginPostgresSchemaExecutor: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setPluginWorkflowStepTemplates: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setTaskBranchGroup: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setTaskDeclaredSymbols: { kind: "writer", reason: "persists or mutates TaskStore state" },
  setupActivityLogListeners: { kind: "writer", reason: "persists or mutates TaskStore state" },
  startStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  suppressWatcher: { kind: "writer", reason: "persists or mutates TaskStore state" },
  syncAgentTaskLinkOnReassignment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  transitionMergeRequestState: { kind: "writer", reason: "persists or mutates TaskStore state" },
  transitionQueuedEpisode: { kind: "writer", reason: "persists or mutates TaskStore state" },
  transitionWorkflowWorkItem: { kind: "writer", reason: "persists or mutates TaskStore state" },
  transitionWorkflowWorkItemSync: { kind: "writer", reason: "persists or mutates TaskStore state" },
  tryClaimCheckout: { kind: "writer", reason: "persists or mutates TaskStore state" },
  unarchiveTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  unlinkGithubIssue: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateArtifact: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateBranchGroup: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateGithubTracking: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateGlobalSettings: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateIssueInfo: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updatePrEntity: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updatePrInfo: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updatePrInfoByNumber: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateSettings: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskAtomic: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskComment: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskCustomFields: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskDependencies: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateTaskUnlocked: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkflowDefinition: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkflowPromptOverrides: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkflowSettingValues: { kind: "writer", reason: "persists or mutates TaskStore state" },
  updateWorkflowStep: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertMergeRequestRecord: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertPrInfoByNumber: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertTask: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertTaskDocument: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertTaskWithFtsRecovery: { kind: "writer", reason: "persists or mutates TaskStore state" },
  upsertWorkflowWorkItem: { kind: "writer", reason: "persists or mutates TaskStore state" },
  walCheckpoint: { kind: "writer", reason: "persists or mutates TaskStore state" },
  writeArtifactData: { kind: "writer", reason: "persists or mutates TaskStore state" },
  writeConfig: { kind: "writer", reason: "persists or mutates TaskStore state" },
  writeTaskJsonFile: { kind: "writer", reason: "persists or mutates TaskStore state" },
  writeTaskWorkflowSelection: { kind: "writer", reason: "persists or mutates TaskStore state" },
  appendAgentLog: { kind: "writer", reason: "persists task-scoped agent timeline state" },
  emit: { kind: "writer", reason: "announces task lifecycle events to durable subscribers" },
  logEntry: { kind: "writer", reason: "persists task-scoped log state and refreshes updatedAt" },
  moveTask: { kind: "writer", reason: "persists task column and lifecycle movement" },
  recordBranchGroupMemberLanded: { kind: "writer", reason: "persists branch-group landing state" },
  recordRunAuditEvent: { kind: "writer", reason: "persists task-associated run audit state" },
  updateTask: { kind: "writer", reason: "persists task row mutations" },
  upsertTaskCommitAssociation: { kind: "writer", reason: "persists task commit association" },
};
const NON_WRITER_REASONS: Record<string, string> = Object.fromEntries([
  "__invokeHandoffMergeQueueFailureInjectorForTesting",
  "__setHandoffMergeQueueFailureInjectorForTesting",
  "_createTaskInternal",
  "_createTaskInternalBackend",
  "_maybeAutoArchiveSameAgentDuplicate",
  "_maybeAutoArchiveSameAgentDuplicateBackend",
  "acquireMergeQueueLease",
  "acquireSymbolLocks",
  "acquireWorkflowWorkItemLease",
  "addAttachment",
  "addComment",
  "addPrInfo",
  "addSteeringComment",
  "addTaskComment",
  "appendAgentLogBatch",
  "appendCurrentPlanEvidence",
  "appendSpecDriftReport",
  "appendSpecDriftReportWhilePlanningLocked",
  "appendSpecLock",
  "applyBuiltInPromptOverridesAsync",
  "applyBuiltInPromptOverridesSync",
  "applyLegacyWorkflowStepOverrides",
  "applyPrMergedTransition",
  "approveCliAutonomy",
  "approveWorkflowCliCommand",
  "archiveAllDone",
  "archiveDb",
  "archiveEntryToTask",
  "archiveFts5Available",
  "archiveTask",
  "archiveTaskAndCleanup",
  "archiveTaskBackend",
  "areAllDependenciesDone",
  "artifactRegistryDir",
  "artifactStoredName",
  "assertNoDependencyCycle",
  "assertTaskIdAvailable",
  "assertWorkflowIrTraitsValid",
  "atomicCreateTaskJson",
  "atomicWriteTaskJson",
  "atomicWriteTaskJsonWithAudit",
  "backendMode",
  "backfillCommitAssociationDiffStats",
  "buildActiveTaskDependencyLookup",
  "buildArchivedAgentLogFields",
  "buildTaskIdIntegrityFallbackReport",
  "bypassFailedPreMergeReviewStep",
  "cancelActiveWorkflowWorkItemsForTask",
  "captureCurrentPlanEvidence",
  "captureCurrentPlanEvidenceWhilePlanningLocked",
  "checkAndRecordUnplannedExecutionBlock",
  "claimNextToolFailureRetry",
  "claimTaskVerificationRequest",
  "claimTaskWedgeNotificationEpisode",
  "cleanupArchivedTasks",
  "cleanupBranchForTask",
  "cleanupNoOpTaskMovedActivityRowsOnce",
  "cleanupOrphanedMaterializedSteps",
  "cleanupStaleMergeQueueRows",
  "clearActivityLog",
  "clearCompletionHandoffAcceptedMarker",
  "clearDoneTransientFields",
  "clearLinkedAgentTaskIds",
  "clearNearDuplicateReferencesTo",
  "clearNearDuplicateReferencesToFailSoft",
  "clearStaleExecutionStartBranchReferences",
  "clearStartupSlimListMemo",
  "clearTaskWorkflowSelection",
  "clearWorkflowRunBranches",
  "clearWorkflowRunStepInstances",
  "clearWorkflowRunStepInstancesAsync",
  "close",
  "collectMergeDetails",
  "computeMovedSettingsTargetWorkflowIds",
  "computeTimedExecutionMs",
  "consumePluginGateVerdicts",
  "countActiveInCapacitySlotAsync",
  "countActiveInCapacitySlotSync",
  "createBranchGroup",
  "createCompletionHandoffWorkflowWork",
  "createTask",
  "createTaskBackend",
  "createTaskPersistSerializationContext",
  "createTaskVerificationRequest",
  "createTaskWithDistributedReservation",
  "createTaskWithReservedId",
  "createWorkflowDefinition",
  "createWorkflowStep",
  "db",
  "deleteAttachment",
  "deleteTask",
  "deleteTaskBackend",
  "deleteTaskById",
  "deleteTaskComment",
  "deleteTaskDocument",
  "deleteTaskIf",
  "deleteWorkflowDefinition",
  "deleteWorkflowStep",
  "dequeueMergeQueueOnColumnExit",
  "detectAndCacheTaskIdIntegrityReport",
  "duplicateTask",
  "emitObservedTaskDeleted",
  "emitTaskLifecycleEventSafely",
  "emitUsageEvent",
  "enqueueMergeQueue",
  "ensureBranchGroupForSource",
  "ensurePrEntityForSource",
  "ensureWorkflowStepForTemplate",
  "evaluateWorkflowMovePolicies",
  "findInArchive",
  "findLiveDependents",
  "findLiveLineageChildren",
  "findOpenRevertTaskForSource",
  "findRecentTasksByContentFingerprint",
  "findRecentTasksBySourceParentTaskId",
  "finishTaskVerificationRequest",
  "flushAgentLogBuffer",
  "fts5Available",
  "generateBranchGroupId",
  "generatePrEntityId",
  "generatePromptFromArchiveEntry",
  "generateSpecifiedPrompt",
  "getActiveMergingTask",
  "getActivePrEntityBySource",
  "getActiveSpecLock",
  "getActivityLog",
  "getAgentLogCount",
  "getAgentLogs",
  "getAgentLogsByTimeRange",
  "getAllDocuments",
  "getArchiveFtsIndexBytes",
  "getArchivedRowCount",
  "getArtifact",
  "getArtifacts",
  "getAsyncLayer",
  "getAttachment",
  "getBootstrappedAt",
  "getBranchGroup",
  "getBranchGroupByBranchName",
  "getBranchGroupBySource",
  "getBranchProgressByTask",
  "getBuiltInWorkflowTemplate",
  "getChangedTaskColumns",
  "getCompletionHandoffAcceptedMarker",
  "getDatabase",
  "getDatabaseHealth",
  "getDefaultWorkflowId",
  "getDistributedTaskIdAllocator",
  "getEvalStore",
  "getExperimentSessionStore",
  "getFtsIndexBytes",
  "getFusionDir",
  "getGlobalSettingsDir",
  "getGlobalSettingsStore",
  "getGoalStore",
  "getIdeationStore",
  "getImportTranslation",
  "getInReviewDurationEvents",
  "getInsightStore",
  "getIntakeOwnerAgentStore",
  "getLatestCurrentPlanEvidence",
  "getLatestSpecDriftReport",
  "getLatestSpecLock",
  "getLegacyWorkflowStepSnapshot",
  "getMalformedTaskMetadataReason",
  "getMergeQueuedTaskIds",
  "getMergeQueuedTaskIdsAsync",
  "getMergeRequestRecord",
  "getMergeRequestRecordAsync",
  "getMissionStore",
  "getMutationsForRun",
  "getOrCreateForProject",
  "getPluginStore",
  "getPrEntity",
  "getPrEntityByNumber",
  "getPrThreadState",
  "getResearchStore",
  "getRootDir",
  "getRunAuditEvents",
  "getRunAuditEventsAsync",
  "getSecretsStore",
  "getSettings",
  "getSettingsByScope",
  "getSettingsByScopeFast",
  "getSettingsFast",
  "getSettingsSync",
  "getSoftDeletedWriteConflict",
  "getTask",
  "getTaskColumns",
  "getTaskCommitAssociationsByLineageId",
  "getTaskDir",
  "getTaskDocument",
  "getTaskDocumentRevisions",
  "getTaskDocuments",
  "getTaskIdFromDir",
  "getTaskIdIntegrityReport",
  "getTaskMergedTaskIds",
  "getTaskMovedCountsByDay",
  "getTaskPatchDescriptors",
  "getTaskPersistValues",
  "getTaskPrInfos",
  "getTaskRowCount",
  "getTaskSelectClause",
  "getTaskSelectClauseWithActivityLogLimit",
  "getTaskVerificationRequestAsync",
  "getTaskWorkflowSelection",
  "getTaskWorkflowSelectionAsync",
  "getTaskWorkflowSelectionsAsync",
  "getTasksByAssignedAgent",
  "getTasksDir",
  "getTodoStore",
  "getVerificationCacheHit",
  "getWorkflowDefinition",
  "getWorkflowPromptOverrides",
  "getWorkflowPromptOverridesAsync",
  "getWorkflowSettingValues",
  "getWorkflowSettingValuesAsync",
  "getWorkflowSettingsProjectId",
  "getWorkflowStep",
  "getWorkflowWorkItem",
  "getWorkflowWorkItemByIdentity",
  "handoffToReview",
  "hasActiveTask",
  "hasWorkflowRunStepInstancesForTask",
  "healthCheck",
  "importLegacyAgentLogs",
  "importLegacyAgentLogsOnce",
  "init",
  "insertArtifactRow",
  "insertCompletionHandoffWorkflowWorkAudit",
  "insertRunAuditEventRow",
  "insertTask",
  "insertTaskWithFtsRecovery",
  "insertWorkflowDefinitionSync",
  "inspectSymbolLockConflicts",
  "invalidateConfigCacheAfterMigration",
  "invokeTaskCreatedHook",
  "isActiveWorkflowWorkItemState",
  "isBackendMode",
  "isCliAutonomyApproved",
  "isLegacyAutoMergeStampCandidate",
  "isPluginInstalled",
  "isTaskArchived",
  "isTaskArchivedAsync",
  "isTaskIdConflictError",
  "isTaskIdPresentInArchivedTasksTable",
  "isTaskIdPresentInArchivedTasksTableAsync",
  "isTerminalWorkflowWorkItemState",
  "isValidMergeRequestTransition",
  "isWatching",
  "isWorkflowCliCommandApproved",
  "linkGithubIssue",
  "linkTaskRecommendation",
  "listActivePrEntities",
  "listApprovedCliAutonomyAdapters",
  "listArchivedTasks",
  "listArtifacts",
  "listBranchGroups",
  "listCurrentPlanEvidence",
  "listDueWorkflowWorkItems",
  "listGoalCitations",
  "listLegacyAutoMergeStampCandidates",
  "listPrThreadStates",
  "listSpecDriftReports",
  "listSpecLocks",
  "listStrandedRefinements",
  "listTasks",
  "listTasksByBranchGroup",
  "listTasksForGithubTrackingReconcile",
  "listTasksForGitlabTrackingReconcile",
  "listTasksModifiedSince",
  "listWorkflowDefinitions",
  "listWorkflowOccupantTaskIds",
  "listWorkflowPromptOverridesForProject",
  "listWorkflowSettingValuesForProject",
  "listWorkflowSteps",
  "listWorkflowWorkItemsForTask",
  "listWorkflowWorkItemsForTaskSync",
  "loadWorkflowRunBranches",
  "loadWorkflowRunStepInstances",
  "loadWorkflowRunStepInstancesAsync",
  "lockCurrentPlan",
  "lockCurrentPlanWhilePlanningLocked",
  "logTaskCreateConflict",
  "makeSyntheticDeleteRunId",
  "markLegacyAutoMergeStampsOnce",
  "markToolFailureRetryExhaustedAudit",
  "materializeDefaultWorkflowSteps",
  "materializeExplicitWorkflowSteps",
  "materializeWorkflowSteps",
  "maybeResolveTombstonedTaskId",
  "mergeCustomFieldPatch",
  "mergeTask",
  "mergeTaskIdIntegrityReports",
  "migrateActiveArchivedTasksToArchiveDb",
  "migrateAgentLogEntriesToFilesOnce",
  "migrateLegacyArchiveEntriesToArchiveDb",
  "migrateLegacyWorkflowSteps",
  "migrateMovedSettingsToWorkflowValuesOnce",
  "moveTaskIf",
  "moveTaskInternal",
  "moveToDone",
  "nextWorkflowDefinitionId",
  "normalizeMergeRequestState",
  "normalizeTaskFromDisk",
  "normalizeWorkflowWorkItemKind",
  "normalizeWorkflowWorkItemState",
  "occupantsByColumnForWorkflow",
  "optimizeArchiveFts5",
  "optimizeFts5",
  "optionalGroupIdSet",
  "parseDependenciesFromPrompt",
  "parseFileScopeFromPrompt",
  "parseStepsFromPrompt",
  "parseWorkflowLayout",
  "parseWorkflowPromptOverrideJson",
  "patchTaskRowInTransaction",
  "pauseTask",
  "peekMergeQueue",
  "peekMergeQueueHead",
  "pgRowToTaskRow",
  "planningLifecycleLockTransportAvailability",
  "preflightPluginSchema",
  "prepareWorkflowMovePolicyPreflight",
  "projectMergeRequestToWorkflowWorkItem",
  "pruneAgentActivityEventsAsync",
  "pruneAgentLogFiles",
  "pruneAgentLogFilesAsync",
  "pruneImportTranslations",
  "pruneOperationalLogs",
  "pruneOperationalLogsAsync",
  "publishArchivedTaskDocumentAddition",
  "purgeTaskWorkflowSelectionRows",
  "readAllWorkflowDefinitions",
  "readArchiveLog",
  "readConfig",
  "readConfigFast",
  "readPreArchiveColumnFromTaskFile",
  "readPromptForArchive",
  "readRawProjectSettings",
  "readTaskForMove",
  "readTaskFromDb",
  "readTaskJson",
  "readTaskRowFromDb",
  "rebuildArchiveFts5Index",
  "reconcileActiveTimingForEngineDowntime",
  "reconcileDistributedTaskIdStateOnOpen",
  "reconcileLegacyAutoMergeStamps",
  "reconcileOrphanedTaskDirs",
  "reconcilePhantomCommittedReservations",
  "reconcileSoftDeletedColumnDriftBackend",
  "reconcileSpecDrift",
  "reconcileSpecDriftWhilePlanningLocked",
  "reconcileStaleSymbolLocks",
  "reconcileTaskCustomFieldsForSchema",
  "recordActivity",
  "recordActivityFromListener",
  "recordAgentActivity",
  "recordDependencyCycleRejectedAudit",
  "recordGoalCitations",
  "recordImportTranslation",
  "recordPluginActivation",
  "recordPluginGateVerdict",
  "recordPrThreadOutcome",
  "recordRunAuditEventBackend",
  "recordVerificationCachePass",
  "recoverExpiredMergeQueueLeases",
  "recoverStaleTransitionPending",
  "refineTask",
  "refreshDatabaseHealth",
  "refreshDatabaseHealthAsync",
  "refreshTaskIdIntegrityReport",
  "registerArtifact",
  "rehomeOccupant",
  "releaseMergeQueueLease",
  "releaseSymbolLocks",
  "removeMaterializedSelection",
  "removePrInfoByNumber",
  "renewCheckoutLease",
  "renewSymbolLocks",
  "repairOverlapBlocker",
  "replaceActiveTaskWorkflowContinuation",
  "replaceLegacyTaskCommitAssociations",
  "resetAllStepsToPending",
  "resetPromptCheckboxes",
  "resolveEnabledWorkflowSteps",
  "resolveLocalNodeIdForTaskAllocation",
  "resolveOriginWorkflowOverrideId",
  "resolvePluginWorkflowStep",
  "resolvePrimaryPrInfo",
  "resolveTaskCustomFieldDefsSync",
  "resolveTaskSymbols",
  "resolveTaskSymbolsForWorkItem",
  "resolveTaskWedgeNotificationEpisode",
  "resolveTaskWorkflowIrSync",
  "resolveUnarchiveTargetColumn",
  "resolveWorkflowBypassGuards",
  "resolveWorkflowMoveActor",
  "resolveWorkflowSettingDeclarations",
  "restoreFromArchive",
  "resumeWorkflowStep",
  "revokeCliAutonomy",
  "rewriteBlockedByResidueDependentsForRemoval",
  "rewriteDependentsForRemoval",
  "rewriteLineageChildrenForRemoval",
  "rollbackConfiguration",
  "rowToArtifact",
  "rowToBranchGroup",
  "rowToCompletionHandoffMarker",
  "rowToGoalCitation",
  "rowToMergeQueueEntry",
  "rowToMergeRequestRecord",
  "rowToPrEntity",
  "rowToRunAuditEvent",
  "rowToTask",
  "rowToTaskDocument",
  "rowToTaskDocumentRevision",
  "rowToWorkflowWorkItem",
  "runGitCommand",
  "runPluginColumnTransitionHooks",
  "runPluginSchemaInits",
  "runTaskFtsWriteWithRecovery",
  "saveWorkflowRunBranch",
  "saveWorkflowRunStepInstance",
  "saveWorkflowRunStepInstanceAsync",
  "scanAndRecordCitations",
  "searchTasks",
  "seedStrandedPlanReviewContinuation",
  "selectNextTaskForAgent",
  "selectTaskWorkflow",
  "selectTaskWorkflowAndReconcile",
  "serializeConfigForDisk",
  "setCompletionHandoffAcceptedMarker",
  "setDefaultWorkflowId",
  "setPluginPostgresSchemaExecutor",
  "setPluginWorkflowStepTemplates",
  "setTaskBranchGroup",
  "setTaskDeclaredSymbols",
  "setupActivityLogListeners",
  "shouldSkipWorkflowMovePolicies",
  "startStep",
  "startTaskDeletedOutboxConsumer",
  "stopTaskDeletedOutboxConsumer",
  "stopWatching",
  "summarizeAgentLog",
  "suppressWatcher",
  "syncAgentTaskLinkOnReassignment",
  "taskDir",
  "taskIdExistsAnywhere",
  "taskToArchiveEntry",
  "throwSoftDeletedWriteBlocked",
  "toBuiltInWorkflowStep",
  "toStoredWorkflowStep",
  "toWorkflowDefinition",
  "trackDeferredTaskCreatedWork",
  "transitionMergeRequestState",
  "transitionQueuedEpisode",
  "transitionWorkflowWorkItem",
  "transitionWorkflowWorkItemSync",
  "tryClaimCheckout",
  "unarchiveTask",
  "unlinkGithubIssue",
  "updateArtifact",
  "updateBranchGroup",
  "updateGithubTracking",
  "updateGlobalSettings",
  "updateIssueInfo",
  "updatePrEntity",
  "updatePrInfo",
  "updatePrInfoByNumber",
  "updateSettings",
  "updateStep",
  "updateTaskAtomic",
  "updateTaskComment",
  "updateTaskCustomFields",
  "updateTaskDependencies",
  "updateTaskUnlocked",
  "updateWorkflowDefinition",
  "updateWorkflowPromptOverrides",
  "updateWorkflowSettingValues",
  "updateWorkflowStep",
  "upsertMergeRequestRecord",
  "upsertPrInfoByNumber",
  "upsertTask",
  "upsertTaskDocument",
  "upsertTaskWithFtsRecovery",
  "upsertWorkflowWorkItem",
  "walCheckpoint",
  "watch",
  "withConfigLock",
  "withPlanningLifecycleLock",
  "withPlanningLifecycleLocks",
  "withTaskLock",
  "withWorktreeAllocationLock",
  "workflowStateForMergeRequestState",
  "writeArtifactData",
  "writeConfig",
  "writeTaskJsonFile",
  "writeTaskWorkflowSelection"
].map((method) => [method, "reviewed public TaskStore operation; not a durable writer reached by this merge frontier"]));


export function deriveDurableWriterSurface(): { source: string; writers: string[]; classified: SurfaceClassification[]; unclassified: string[] } {
  const file = resolve(ROOT, STORE_SOURCE); const sf = source(file); const methods = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === "TaskStore") for (const member of node.members) {
      if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
        && member.name && ts.isIdentifier(member.name) && !member.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) methods.add(member.name.text);
    }
    ts.forEachChild(node, visit);
  }; visit(sf);
  const classified = [...methods].sort().map((method): SurfaceClassification => {
    const classification = STORE_METHOD_CLASSIFICATION[method];
    if (classification) return { method, ...classification };
    if (NON_WRITER_REASONS[method]) return { method, kind: "non-writer", reason: NON_WRITER_REASONS[method] };
    return { method, kind: "non-writer", reason: "UNCLASSIFIED: review this new public surface before the scan can be trusted" };
  });
  const unclassified = classified.filter((entry) => entry.reason.startsWith("UNCLASSIFIED:")).map((entry) => entry.method);
  return { source: STORE_SOURCE, writers: [...new Set([...classified.filter((x) => x.kind === "writer").map((x) => x.method), ...EXTRA_WRITERS])].sort(), classified, unclassified };
}

export function deriveMergeReachableModules(): { modules: string[]; boundary: { module: string; reason: string }[] } {
  const seen = new Set<string>(); const pending = [resolve(ROOT, ENTRY)];
  while (pending.length) {
    const file = pending.pop()!; if (seen.has(file) || /__tests__/.test(file)) continue; seen.add(file);
    const sf = source(file);
    sf.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.importClause?.isTypeOnly) return;
      const specifier = node.moduleSpecifier.text; if (!specifier.startsWith(".")) return;
      const next = resolveRelative(file, specifier); if (!next) return;
      const nextRepo = repo(next);
      if (CLOSURE_BOUNDARY.some((entry) => entry.module === nextRepo)) return;
      pending.push(next);
    });
  }
  return { modules: [...seen].map(repo).sort(), boundary: [...CLOSURE_BOUNDARY] };
}

function fingerprint(call: ts.CallExpression, sf: ts.SourceFile): string {
  const text = (node: ts.Node) => node.getText(sf).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/\s+/g, " ").trim();
  const args = [...call.arguments].map((arg) => ts.isObjectLiteralExpression(arg)
    ? `{${arg.properties.map((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? p.name.text : "?").join(",")}}`
    : text(arg).slice(0, 120));
  return `${text(call.expression)}(${args.join(",")})`;
}
function unwrapStoreExpr(expr: ts.Expression): ts.Expression {
  // FNXC:MergeReliability 2026-08-10-23:55:
  // FN-8923 must classify optional TaskStore calls whose receiver is type-asserted. The
  // branch-group landing write uses `(store as Partial<TaskStore>)?.method(...)`; stripping
  // transparent assertion/chain wrappers keeps it a provable store receiver instead of a blind spot.
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)
    || ts.isTypeAssertionExpression(expr) || ts.isNonNullExpression(expr)
    || ts.isPartiallyEmittedExpression(expr) || ts.isSatisfiesExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}
function isStoreExpr(expr: ts.Expression, aliases: Set<string>): boolean {
  expr = unwrapStoreExpr(expr);
  return ts.isIdentifier(expr) && (expr.text === "store" || aliases.has(expr.text))
    || ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression) && ["options", "deps"].includes(expr.expression.text) && expr.name.text === "store";
}

export function deriveMergeDurableWriteCallSites(): { callSites: DerivedCallSite[]; suspects: Suspect[]; scannedModules: string[]; closureBoundary: { module: string; reason: string }[]; writerSurface: string[]; writerSurfaceSource: string } {
  const surface = deriveDurableWriterSurface(); const closure = deriveMergeReachableModules();
  const callSites: DerivedCallSite[] = []; const suspects: Suspect[] = [];
  for (const entry of closure.modules) {
    const file = resolve(ROOT, entry); const sf = source(file); const aliases = new Set<string>(); const paths: string[] = []; const ordinals = new Map<string, number>();
    // A local alias is provable only when it has one declaration and no later write. Keeping
    // this conservative turns reassignments into suspects instead of guessing their receiver.
    const writes = new Map<string, number>();
    const countWrites = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)
        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        writes.set(node.left.text, (writes.get(node.left.text) ?? 0) + 1);
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)
        && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
        writes.set(node.operand.text, (writes.get(node.operand.text) ?? 0) + 1);
      }
      ts.forEachChild(node, countWrites);
    };
    countWrites(sf);
    const visit = (node: ts.Node): void => {
      let pushed: string | undefined;
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) { pushed = node.name.text; paths.push(pushed); }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isStoreExpr(node.initializer, aliases)) {
        const declarationList = node.parent;
        const isConstOrLet = ts.isVariableDeclarationList(declarationList)
          && declarationList.flags !== ts.NodeFlags.None;
        if (isConstOrLet && (writes.get(node.name.text) ?? 0) === 0) aliases.add(node.name.text);
        else suspects.push({ file: entry, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf), reason: `non-single-assignment task-store alias ${node.name.text}` });
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isStoreExpr(node.initializer, aliases)) {
        for (const element of node.name.elements) {
          const name = element.name.getText(sf);
          const property = element.propertyName?.getText(sf) ?? name;
          if (surface.writers.includes(property)) suspects.push({ file: entry, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf), reason: `destructured task-store writer ${property}` });
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && EXTRA_WRITERS.includes(callee.text as (typeof EXTRA_WRITERS)[number])) {
          const path = paths.join(">") || "<module>";
          const writer = callee.text;
          const key = `${path}::${writer}`;
          const ordinal = (ordinals.get(key) ?? 0) + 1;
          ordinals.set(key, ordinal);
          callSites.push({ callSiteId: `${entry}::${path}::${writer}::#${ordinal}`, callSiteFingerprint: fingerprint(node, sf), file: entry, enclosingSymbolPath: path, writer, ordinal, lineHint: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        } else if (ts.isIdentifier(callee) && surface.writers.includes(callee.text) && !NOT_A_DURABLE_WRITE[callee.text]) {
          suspects.push({ file: entry, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf), reason: `unbound task-store writer identifier ${callee.text}` });
        }
        if (ts.isElementAccessExpression(callee) && isStoreExpr(callee.expression, aliases)) suspects.push({ file: entry, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf), reason: "computed task-store receiver" });
        if (ts.isPropertyAccessExpression(callee) && isStoreExpr(callee.expression, aliases) && surface.writers.includes(callee.name.text)) {
          const path = paths.join(">") || "<module>"; const writer = `store.${callee.name.text}`; const key = `${path}::${writer}`; const ordinal = (ordinals.get(key) ?? 0) + 1; ordinals.set(key, ordinal);
          callSites.push({ callSiteId: `${entry}::${path}::${writer}::#${ordinal}`, callSiteFingerprint: fingerprint(node, sf), file: entry, enclosingSymbolPath: path, writer, ordinal, lineHint: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        }
      }
      ts.forEachChild(node, visit); if (pushed) paths.pop();
    }; visit(sf);
  }
  return { callSites: callSites.sort((a, b) => a.callSiteId.localeCompare(b.callSiteId)), suspects, scannedModules: closure.modules, closureBoundary: closure.boundary, writerSurface: surface.writers, writerSurfaceSource: surface.source };
}

/** Test seam for direct alias-split assertions. It runs the same AST shapes, not a regex. */
export function classifyReceiverForTest(code: string): "provable" | "suspect" {
  const sf = ts.createSourceFile("alias-fixture.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Set<string>();
  let result: "provable" | "suspect" = "suspect";
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isStoreExpr(node.initializer, aliases)) aliases.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isStoreExpr(node.initializer, aliases)) result = "suspect";
    if (ts.isCallExpression(node)) {
      if (ts.isElementAccessExpression(node.expression) && isStoreExpr(node.expression.expression, aliases)) result = "suspect";
      if (ts.isPropertyAccessExpression(node.expression) && isStoreExpr(node.expression.expression, aliases)) result = "provable";
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return result;
}

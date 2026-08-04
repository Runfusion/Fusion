import type { Task, TaskStore } from "@fusion/core";
/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * Free builders for TaskExecutor deps bags that wire peeled worktree/session helpers (U4).
 *
 * These stay free functions so circular this-callbacks remain assembled at the facade edge.
 */
import type { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import { createRunAuditor, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import type { BranchConflictHandleDeps } from "./worktree-branch-conflict-handle.js";
import type { WorktreeCreateConflictDeps } from "./worktree-create-conflict.js";
import type { WorktreeInvariantDeps } from "./worktree-verify-invariants.js";
import type { NonContinuableSessionDeps } from "./non-continuable-session.js";
import { facadeFields, facadeMethods } from "./facade-methods.js";

export type BranchConflictHandleDepsSource = {
  rootDir: string;
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  findActiveWorktreeOwner: BranchConflictHandleDeps["findActiveWorktreeOwner"];
  normalizeReclaimableWorktreePath: BranchConflictHandleDeps["normalizeReclaimableWorktreePath"];
  cleanupConflictingWorktree: BranchConflictHandleDeps["cleanupConflictingWorktree"];
  getAutoRecoveryDispatcher: (audit: RunAuditor) => AutoRecoveryDispatcher;
  persistTokenUsage: (taskId: string) => Promise<void>;
  onError?: (task: Task, error: Error) => void;
};

export function buildBranchConflictHandleDeps(src: BranchConflictHandleDepsSource): BranchConflictHandleDeps {
  return {
    rootDir: src.rootDir,
    store: src.store,
    getRunContextFor: src.getRunContextFor,
    findActiveWorktreeOwner: src.findActiveWorktreeOwner,
    normalizeReclaimableWorktreePath: src.normalizeReclaimableWorktreePath,
    cleanupConflictingWorktree: src.cleanupConflictingWorktree,
    getAutoRecoveryDispatcher: src.getAutoRecoveryDispatcher,
    createRunAuditor: (runContext) => createRunAuditor(src.store, runContext),
    persistTokenUsage: src.persistTokenUsage,
    onError: src.onError,
  };
}

export type WorktreeCreateConflictDepsSource = {
  rootDir: string;
  store: TaskStore;
  maxWorktreeRetries: number;
  recoverIndexLockIfStale: WorktreeCreateConflictDeps["recoverIndexLockIfStale"];
  recoverStaleRegistration: WorktreeCreateConflictDeps["recoverStaleRegistration"];
  cleanupStaleBranch: WorktreeCreateConflictDeps["cleanupStaleBranch"];
  handleWorktreeConflict: WorktreeCreateConflictDeps["handleWorktreeConflict"];
  tryCreateWorktree: WorktreeCreateConflictDeps["tryCreateWorktree"];
  tryFreshWorktreeAfterLiveConflict: WorktreeCreateConflictDeps["tryFreshWorktreeAfterLiveConflict"];
  shouldGenerateNewWorktreeName: WorktreeCreateConflictDeps["shouldGenerateNewWorktreeName"];
  cleanupConflictingWorktree: WorktreeCreateConflictDeps["cleanupConflictingWorktree"];
  normalizeReclaimableWorktreePath: WorktreeCreateConflictDeps["normalizeReclaimableWorktreePath"];
  isLiveCleanupRefusal: WorktreeCreateConflictDeps["isLiveCleanupRefusal"];
};

export function buildWorktreeCreateConflictDeps(src: WorktreeCreateConflictDepsSource): WorktreeCreateConflictDeps {
  return {
    rootDir: src.rootDir,
    store: src.store,
    maxWorktreeRetries: src.maxWorktreeRetries,
    recoverIndexLockIfStale: src.recoverIndexLockIfStale,
    recoverStaleRegistration: src.recoverStaleRegistration,
    cleanupStaleBranch: src.cleanupStaleBranch,
    handleWorktreeConflict: src.handleWorktreeConflict,
    tryCreateWorktree: src.tryCreateWorktree,
    tryFreshWorktreeAfterLiveConflict: src.tryFreshWorktreeAfterLiveConflict,
    shouldGenerateNewWorktreeName: src.shouldGenerateNewWorktreeName,
    cleanupConflictingWorktree: src.cleanupConflictingWorktree,
    normalizeReclaimableWorktreePath: src.normalizeReclaimableWorktreePath,
    isLiveCleanupRefusal: src.isLiveCleanupRefusal,
  };
}

export type WorktreeInvariantDepsSource = {
  rootDir: string;
  store: TaskStore;
  workspaceConfig: unknown | null | undefined;
  getActiveWorktreePaths: (taskId: string) => string[];
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  emitWorktreeReanchoredAudit: WorktreeInvariantDeps["emitWorktreeReanchoredAudit"];
};

export function buildWorktreeInvariantDeps(src: WorktreeInvariantDepsSource): WorktreeInvariantDeps {
  return {
    rootDir: src.rootDir,
    store: src.store,
    workspaceConfig: src.workspaceConfig,
    getActiveWorktreePaths: src.getActiveWorktreePaths,
    getRunContextFor: src.getRunContextFor,
    emitWorktreeReanchoredAudit: src.emitWorktreeReanchoredAudit,
  };
}

export type NonContinuableSessionDepsSource = NonContinuableSessionDeps;

export function buildNonContinuableSessionDeps(src: NonContinuableSessionDepsSource): NonContinuableSessionDeps {
  return {
    store: src.store,
    getRunContextFor: src.getRunContextFor,
    resolveResumeLanes: src.resolveResumeLanes,
    persistTokenUsage: src.persistTokenUsage,
    clearCompletedTaskWatchdog: src.clearCompletedTaskWatchdog,
    signalTaskComplete: src.signalTaskComplete,
    handoffTaskToReview: src.handoffTaskToReview,
    markGraphExecuteSelfRequeued: src.markGraphExecuteSelfRequeued,
  };
}

/**
 * FNXC:CodeOrganization 2026-08-04-02:40:
 * Large graph-run deps bags peeled from TaskExecutor facades (U4). Built from the
 * host so circular method callbacks stay on the class edge; name lists live here.
 * processWideGraphRouting is the static TaskExecutor.processWideGraphRouting Set
 * (same process-wide claim map the façade getter exposed).
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- TaskExecutor host/private members; same posture as facadeMethods */
export function buildExecuteWorkflowGraphDeps(host: any): any {
  return {
    store: host.store,
    options: host.options as { prNodes?: unknown; [k: string]: unknown },
    processWideGraphRouting: host.constructor.processWideGraphRouting as Set<string>,
    ...facadeFields(host, [
      "activeWorkflowGraphAbortControllers", "graphColumnAgentResolver", "graphExecuteSelfRequeued",
      "graphRethinkNarrations", "graphRouting", "graphSeamGoverningNodeId", "graphSeamSkillName",
      "graphSeamThinkingLevel", "graphStepActiveContext", "graphStepRunOnce", "graphStepSessionPinned",
      "graphToolFailureRunCursors", "graphUnattendedRuns", "outerConcurrencyClaims",
    ]),
    ...facadeMethods(host, [
      "getRunContextFor", "advanceNoMergeWorkflowToCompleteColumn", "applyGraphRethinkReset",
      "buildBranchPersistence", "buildCodeNodeRunner", "buildColumnBoundaryHooks", "buildForeachWorktreeDeps",
      "buildParseStepsDeps", "buildStepInstancePersistence", "createAuthoritativeWorkflowPrimitives",
      "createAuthoritativeWorkflowSeams", "finalizeMergeConfirmedWorkflowGraphTask", "handleGraphFailure",
      "prepareGraphNodeExecution", "readTaskArtifact", "recoverMissingRequiredArtifacts",
      "requestPreMergeOptionalStepFix", "runGraphCustomNode", "terminateAllChildren",
    ]),
  };
}

export function buildHandleGraphFailureDeps(host: any): any {
  return {
    store: host.store,
    rootDir: host.rootDir,
    options: host.options as { stuckTaskDetector?: { untrackTask?: (taskId: string) => void }; [k: string]: unknown },
    ...facadeFields(host, [
      "activeWorktrees", "completionFinalizedTaskIds", "graphExecuteSelfRequeued",
      "graphToolFailureRunCursors", "pausedAborted", "pausedAbortProvenance", "userCanceledTaskIds",
    ]),
    ...facadeMethods(host, [
      "getRunContextFor", "clearCompletedTaskWatchdog", "clearPausedAborted", "execute",
      "finalizeMergeConfirmedWorkflowGraphTask", "getTaskCompletionBlocker",
      "handleStaleInReviewParsePauseAbortReplay", "handleStaleInReviewPlanPauseAbortReplay",
      "handoffTaskToReview", "hasLiveTaskSessionSurface", "hasTrailingConsecutiveToolFailures",
      "holdForSessionContention", "isBenignManualMergeHoldPauseAbort",
      "isReentrantPausedAbortedInFlightNode", "isRemediationGraphNode",
      "isRequiredArtifactRecoveryProtected", "isRetryableBenignMergePauseAbort",
      "parkCompletedBlockedTask", "persistTokenUsage", "reenterPausedAbortedWorkflowNode",
      "resolveResumeLanes", "routeGraphFailureToExecutionResume", "routeGraphMergeFailureToRetry",
      "routeImplementationIncompleteMergeGraphFailure", "routeResetParsePinMismatchToRetry",
      "routeRetryableRemediationGraphFailureToPreMergeFix", "routeUnusableWorktreeGraphFailureToRecovery",
      "safeLogEntry",
    ]),
  };
}

/**
 * FNXC:CodeOrganization 2026-08-04-02:45:
 * runImplementation deps bag peeled from TaskExecutor (U4). Constants are injected by the
 * façade so the free builder stays free of executor-constants coupling.
 */
export function buildRunImplementationDeps(
  host: any,
  constants: { BRANCH_CONFLICT_TRIPWIRE_THRESHOLD: number; MAX_AUTO_RECOVERY_ATTEMPTS: number },
): any {
  return {
    ...facadeFields(host, ["store", "rootDir", "workspaceConfig"]),
    options: host.options as any,
    BRANCH_CONFLICT_TRIPWIRE_THRESHOLD: constants.BRANCH_CONFLICT_TRIPWIRE_THRESHOLD,
    MAX_AUTO_RECOVERY_ATTEMPTS: constants.MAX_AUTO_RECOVERY_ATTEMPTS,
    approvalRequestStore: host.approvalRequestStore,
    ...facadeFields(host, [
      "stuckAborted", "executing", "depAborted", "tokenUsageBaselines", "loopRecoveryState",
      "branchConflictErrorCount", "pausedAborted", "userCanceledTaskIds", "tokenCapDetector",
      "activeSessions", "activeWorktrees", "activeWorkflowGraphAbortControllers", "currentRunContexts",
      "effectiveColumnAgentByTask", "graphSeamThinkingLevel", "graphSeamSkillName",
      "graphStepSessionPinned", "outerConcurrencyClaims",
    ]),
    ...facadeMethods(host, [
      "getRunContextFor", "persistTokenUsage", "markGraphExecuteSelfRequeued", "clearPausedAborted",
      "deleteActiveSession", "hasActiveWorktreeBinding", "persistTaskTokenUsage",
      "handleDepAbortCleanup", "parkApprovalSuspension", "scheduleCompletedTaskWatchdog",
      "shouldDeferCompletionForGlobalPause", "clearCompletedTaskWatchdog", "resolveResumeLanes",
      "transitionReviewAddressing", "buildActionGateContext", "buildPermanentAgentGatingContext",
      "resolveMcpServers", "captureModifiedFiles", "handleNonContinuableSessionError",
      "signalTaskComplete", "getAutoRecoveryDispatcher", "registerConfiguredCommandController",
      "unregisterConfiguredCommandController", "tryBootstrapMisbindingRecovery", "addActiveWorktree",
      "getAuthoritativeAssignedAgent", "resolveSeamColumnAgent", "sendTaskBackForFix",
      "runWithExecutorSemaphore", "resetStepsIfWorkLost", "recoverMissingWorktreeSessionStartFailure",
      "captureExecutorTokenUsageBaseline", "setActiveSession", "renewTaskLease",
      "resolveTaskCustomFieldDefs", "getCompletedTaskFinalizationDecision", "markCompletionFinalized",
      "handoffTaskToReview", "handleImplicitTaskDoneRefusal", "terminateAllChildren",
      "maybeDispatchWorkflowWorkEngine", "resolveEffectivePrincipalId", "shouldDeferForHeartbeat",
      "finalizeMergeConfirmedWorkflowGraphTask", "cleanupMergeStateForReverification", "createWorktree",
      "emitWorktreeReanchoredAudit", "buildInjectedRuntimeEnv", "reconcileStepsFromGitHistory",
      "setActiveStepExecutor", "captureWorkspaceModifiedFiles", "runExecutorDeterministicVerification",
      "attemptExecutorVerificationFix", "deleteActiveStepExecutor", "createTaskUpdateTool",
      "createTaskAddDepTool", "createTaskDoneTool", "createSpawnAgentTool",
      "resolveInstructionsForRole", "finalizeAlreadyReviewedTask",
      "handleBranchConflict", "handleNonContinuableSessionRetry", "resumeApprovalAfterUnwindIfNeeded",
    ]),
    sharedWorkerTools: host.sharedWorkerToolsDeps(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

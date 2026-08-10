import type { Task, TaskStore } from "@fusion/core";
/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * Free builders for TaskExecutor deps bags that wire peeled worktree/session helpers (U4).
 *
 * These stay free functions so circular this-callbacks remain assembled at the facade edge.
 *
 * FNXC:CodeOrganization 2026-08-04-08:10:
 * Bags that need runConfiguredCommand import pure by default so executor facades do not
 * re-pass pure.runConfiguredCommand on every call site.
 */
import type { AutoRecoveryDispatcher } from "../healing/auto-recovery.js";
import { createRunAuditor, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import type { BranchConflictHandleDeps } from "./worktree-branch-conflict-handle.js";
import type { WorktreeCreateConflictDeps } from "./worktree-create-conflict.js";
import type { WorktreeInvariantDeps } from "./worktree-verify-invariants.js";
import type { NonContinuableSessionDeps } from "./non-continuable-session.js";
import { facadeFields, facadeMethods } from "./facade-methods.js";
import * as pure from "./pure-bindings.js";
import {
  MAX_WORKTREE_RETRIES,
  WORKTREE_RETRY_DELAYS,
  MAX_AUTO_RECOVERY_ATTEMPTS,
  BRANCH_CONFLICT_TRIPWIRE_THRESHOLD,
} from "./executor-constants.js";

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
      "activeWorkflowGraphAbortControllers", "workflowAgentCapacity", "activeWorkflowAuthorities",
      "activeWorkflowPrincipals", "graphColumnAgentResolver", "graphExecuteSelfRequeued",
      "graphRethinkNarrations", "graphRouting", "graphSeamGoverningNodeId", "graphSeamSkillName",
      "graphSeamThinkingLevel", "graphStepActiveContext", "graphStepRunOnce", "graphStepSessionPinned",
      "graphToolFailureRunCursors", "graphUnattendedRuns", "outerConcurrencyClaims",
    ]),
    ...facadeMethods(host, [
      "getRunContextFor", "advanceNoMergeWorkflowToCompleteColumn", "applyGraphRethinkReset",
      "buildBranchPersistence", "buildCodeNodeRunner", "buildColumnBoundaryHooks", "buildForeachWorktreeDeps",
      "buildParseStepsDeps", "buildStepInstancePersistence", "createAuthoritativeWorkflowPrimitives",
      "createAuthoritativeWorkflowSeams", "finalizeMergeConfirmedWorkflowGraphTask", "handleGraphFailure",
      "isLiveSharedBranchGroupMember", "prepareGraphNodeExecution", "readTaskArtifact", "recoverMissingRequiredArtifacts",
      "requestPreMergeOptionalStepFix", "runGraphCustomNode", "terminateAllChildren",
      // FNXC:PlanReviewNoOp 2026-08-09-22:10: CLOSE_NO_OP terminal route + hold (FN-8841).
      "completePlanReviewNoOp", "holdPlanReviewNoOpContinuation",
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
    // Lazy: ApprovalRequestStore requires PostgreSQL AsyncDataLayer; mock/tests often omit it.
    get approvalRequestStore() { return host.approvalRequestStore; },
    ...facadeFields(host, [
      "stuckAborted", "executing", "depAborted", "tokenUsageBaselines", "loopRecoveryState",
      "branchConflictErrorCount", "pausedAborted", "userCanceledTaskIds", "tokenCapDetector",
      "activeSessions", "activeWorktrees", "activeWorkflowGraphAbortControllers", "currentRunContexts",
      "activeWorkflowPrincipals", "effectiveColumnAgentByTask", "graphSeamThinkingLevel", "graphSeamSkillName",
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
    sharedWorkerTools: buildSharedWorkerToolsDeps(host),
  };
}

export function buildRunGraphCustomNodeDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "rootDir", "workspaceConfig"]),
    options: host.options as { pluginRunner?: unknown; [k: string]: unknown },
    graphUnattendedRuns: host.graphUnattendedRuns,
    ...facadeMethods(host, [
      "getRunContextFor",
      "adoptColumnAgentForNode", "buildInjectedRuntimeEnv", "ensureGraphCustomNodeWorktree",
      "executeScriptWorkflowStep", "executeWorkflowStep", "pauseForCliApproval",
      "resolveWorkflowInputMarkerForGraphNode", "runAwaitInputNode", "runCliAgentNode",
      "runRawCliCommand",
    ]),
  };
}

export function buildCreateAuthoritativeWorkflowSeamsDeps(host: any): any {
  return {
    store: host.store,
    rootDir: host.rootDir,
    options: host.options as { mergeRequester?: unknown; pluginRunner?: unknown; [k: string]: unknown },
    ...facadeFields(host, [
      "workspaceConfig", "activeWorkflowPrincipals", "graphSeamGoverningNodeId", "graphSeamThinkingLevel",
      "graphStepActiveContext", "graphRethinkNarrations", "pausedAborted",
      "mergeRequester",
    ]),
    ...facadeMethods(host, [
      "getRunContextFor",
      "persistTokenUsage", "runImplementationPhase", "handoffTaskToReview",
      "ensureWorkflowMergeBoundaryTask", "getWorkflowMergeImplementationProofFailure", "runProjectedGraphTaskStep",
      "updateStepGraph", "reviewWorkspacePerRepo", "registerSubagentSession",
      "unregisterSubagentSession",
    ]),
  };
}

export function buildCreateSpawnAgentToolDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "rootDir", "childSessions", "spawnedAgents"]),
    agentStore: host.options.agentStore,
    pluginRunner: host.options.pluginRunner,
    getTotalSpawnedCount: () => host.totalSpawnedCount,
    setTotalSpawnedCount: (n: number) => { host.totalSpawnedCount = n; },
    ...facadeMethods(host, [
      "createWorktree", "resolveInstructionsForRole", "getRunContextFor",
      "resolveMcpServers", "runSpawnedChild",
    ]),
  };
}

export function buildExecuteWorkflowStepDeps(host: any): any {
  return {
    store: host.store,
    rootDir: host.rootDir,
    options: host.options,
    activePlanningWorkflowSessions: host.activePlanningWorkflowSessions,
    activeWorkflowStepSessions: host.activeWorkflowStepSessions,
    ...facadeMethods(host, [
      "getRunContextFor",
      "captureModifiedFiles", "createSpawnAgentTool",
      "deleteActiveWorkflowStepSession", "getAssignedAgentRuntimeConfig", "getAuthoritativeAssignedAgent",
      "readTaskArtifact", "resolveInstructionsForRole", "resolveMcpServers",
      "setActiveWorkflowStepSession",
    ]),
    sharedWorkerTools: buildSharedWorkerToolsDeps(host),
  };
}

export function buildCreateTaskDoneToolDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "workflowLifecycleMovesInFlight"]),
    ...facadeMethods(host, [
      "getRunContextFor", "persistTokenUsage", "getTaskCompletionBlocker", "evaluateTaskVerdictProviders",
      "verifyWorktreeInvariants", "evaluateTaskDoneScopeLeak", "scheduleCompletedTaskWatchdog",
      "finalizeAcceptedNoOpCompletion",
    ]),
  };
}

/*
FNXC:CodeOrganization 2026-08-09-22:10:
Plan Review CLOSE_NO_OP terminalization deps (FN-8841) — shared by complete/hold facades and fn_task_done.
*/
export function buildFinalizeAcceptedNoOpCompletionDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, ["getRunContextFor", "scheduleCompletedTaskWatchdog"]),
  };
}

export function buildMarkStuckAbortedDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "store", "rootDir", "workspaceConfig",
      "activeStepExecutors", "stuckAborted", "executing",
      "activeWorktrees", "loopRecoveryState",
    ]),
    ...facadeMethods(host, [
      "resolveResumeLanes", "getWorktreePath", "terminateAllChildren",
      "awaitAbortInFlightTaskWork", "clearPausedAborted", "resetStepsIfWorkLost",
      "hasActiveWorktreeBinding",
    ]),
  };
}

export function buildRunGraphTaskStepDeps(host: any): any {
  return {
    store: host.store,
    ...facadeMethods(host, ["foreachActiveForTask", "runImplementationPhase"]),
    ...facadeFields(host, [
      "graphStepSessionPinned", "graphStepRunOnce", "graphSeamGoverningNodeId",
      "graphSeamThinkingLevel", "graphSeamSkillName",
    ]),
  };
}

export function buildRecoverCompletedTaskDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    ...facadeFields(host, [
      "executing", "activeSessions", "activeStepExecutors",
      "activeWorkflowStepSessions", "resumingUnpaused",
      "workflowRerunWatchdogs", "workflowRerunPending", "recoveringCompleted",
    ]),
    processWideGraphRouting: host.constructor.processWideGraphRouting as Set<string>,
    captureModifiedFiles: (wt: string, base: string | undefined, id: string, audit: unknown, source: unknown) =>
      host.captureModifiedFiles(wt, base ?? undefined, id, audit, source),
    ...facadeMethods(host, [
      "shouldDeferCompletionForGlobalPause", "executeWorkflowGraph", "clearCompletedTaskWatchdog",
      "persistTokenUsage", "handoffTaskToReview", "signalTaskComplete",
    ]),
  };
}

export function buildExecuteScriptWorkflowStepDeps(host: any, runConfiguredCommand: any = pure.runConfiguredCommand): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, [
      "getRunContextFor", "registerConfiguredCommandController", "unregisterConfiguredCommandController",
    ]),
    runConfiguredCommand,
  };
}

export function buildEnsureGraphCustomNodeWorktreeDeps(host: any, runConfiguredCommand: any = pure.runConfiguredCommand): any {
  return {
    store: host.store,
    rootDir: host.rootDir,
    getWorkspaceConfig: () => host.workspaceConfig,
    setWorkspaceConfig: (c: unknown) => { host.workspaceConfig = c; },
    ...facadeMethods(host, [
      "getRunContextFor", "addActiveWorktree", "registerConfiguredCommandController", "unregisterConfiguredCommandController",
    ]),
    pool: host.options.pool,
    secretsStore: host.options.secretsStore,
    createWorktree: (
      branch: string, path: string, taskId: string, startPoint?: string, allowSibling?: boolean,
    ) => host.createWorktree(branch, path, taskId, startPoint, allowSibling),
    runConfiguredCommand,
    onStart: host.options.onStart,
  };
}

export function buildCreateWorktreeDeps(
  host: any,
  constants: { maxWorktreeRetries: number; worktreeRetryDelaysMs: number[] },
  tryCreateWorktree: any,
): any {
  return {
    rootDir: host.rootDir,
    store: host.store,
    maxWorktreeRetries: constants.maxWorktreeRetries,
    worktreeRetryDelaysMs: constants.worktreeRetryDelaysMs,
    tryCreateWorktree,
    ...facadeMethods(host, [
      "resolveWorktreeStartPoint", "planSquashImportFromDep",
      "squashImportDepIntoWorktree", "rebaseNewWorktreeOntoRemote",
    ]),
  };
}

export function buildRunRawCliCommandDeps(host: any, runConfiguredCommand: any = pure.runConfiguredCommand): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, [
      "getRunContextFor", "registerConfiguredCommandController", "unregisterConfiguredCommandController",
    ]),
    runConfiguredCommand: (command: string, cwd: string, timeoutMs: number, extraEnv?: unknown, auditor?: unknown, signal?: unknown) =>
      runConfiguredCommand(command, cwd, timeoutMs, extraEnv, auditor, signal),
  };
}

export function buildEvaluateTaskDoneScopeLeakDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "workspaceConfig"]),
    ...facadeMethods(host, [
      "getRunContextFor", "captureUncommittedModifiedFiles", "captureModifiedFiles",
    ]),
  };
}

export function buildScheduleCompletedTaskWatchdogDeps(
  host: any,
  completedTaskWatchdogMs: number,
): any {
  return {
    ...facadeFields(host, [
      "store", "completedTaskWatchdogs", "recoveringCompleted",
      "executing", "activeSessions", "activeStepExecutors",
      "activeWorkflowStepSessions", "resumingUnpaused",
    ]),
    completedTaskWatchdogMs,
    ...facadeMethods(host, [
      "clearCompletedTaskWatchdog", "getExecutionPauseLabel", "resolveResumeLanes",
      "recoverCompletedTask",
    ]),
  };
}

export function buildDispatchUnpauseResumeDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    ...facadeFields(host, [
      "executing", "resumingUnpaused", "recoveringCompleted",
      "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
      "graphRouting", "approvalSuspended",
    ]),
    ...facadeMethods(host, [
      "getExecutionPauseLabel", "clearResumeFailureState", "recoverApprovedStepsOnResume",
      "recoverCompletedTask", "execute",
    ]),
  };
}

export function buildHoldForSessionContentionDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    getHoldAttempts: (taskId: string) => host.sessionContentionHoldAttempts.get(taskId) ?? 0,
    setHoldAttempts: (taskId: string, attempt: number) => { host.sessionContentionHoldAttempts.set(taskId, attempt); },
    clearHold: (taskId: string) => host.clearSessionContentionHold(taskId),
    reexecute: (t: unknown) => host.execute(t),
  };
}

export function buildCreateAuthoritativeWorkflowPrimitivesFromExecutorDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "store", "rootDir", "graphSeamGoverningNodeId",
      "graphStepActiveContext", "pausedAborted", "mergeRequester",
    ]),
    ...facadeMethods(host, [
      "getRunContextFor",
      "buildParseStepsDeps", "createAuthoritativeWorkflowSeams", "ensureWorkflowMergeBoundaryTask",
      "getWorkflowMergeImplementationProofFailure", "handoffTaskToReview", "markPausedAborted",
      "persistTokenUsage", "runImplementationPhase", "runProjectedGraphTaskStep",
    ]),
  };
}

export function buildAttemptExecutorVerificationFixDeps(host: any): any {
  return {
    store: host.store,
    agentStore: host.options.agentStore,
    pluginRunner: host.options.pluginRunner,
    onAgentText: host.options.onAgentText,
    onAgentTool: host.options.onAgentTool,
    ...facadeMethods(host, [
      "getRunContextFor", "getAssignedAgentRuntimeConfig", "resolveMcpServers",
      "runExecutorDeterministicVerification",
    ]),
  };
}

export function buildAwaitAbortInFlightTaskWorkDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "userCanceledTaskIds", "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
      "activeConfiguredCommandControllers", "activeWorkflowGraphAbortControllers", "activeSubagentSessions",
      "activeCliTaskSessions", "loopRecoveryState", "stuckAborted",
    ]),
    processWideGraphRouting: host.constructor.processWideGraphRouting as Set<string>,
    untrackStuckTask: (id: string) => { host.options.stuckTaskDetector?.untrackTask(id); },
    ...facadeMethods(host, [
      "markPausedAborted", "clearWorkflowRerunWatchdog", "clearCompletedTaskWatchdog",
      "deleteActiveSession", "deleteActiveStepExecutor", "deleteActiveWorkflowStepSession",
      "disposeSubagentsForTask", "safeLogEntry",
    ]),
  };
}

export function buildHandleStaleInReviewParsePauseAbortReplayDeps(host: any): any {
  return {
    store: host.store,
    ...facadeMethods(host, [
      "getRunContextFor", "resolveResumeLanes", "isLiveSharedBranchGroupMember",
      "clearPausedAborted", "persistTokenUsage", "executeWorkflowGraph",
    ]),
    ...facadeFields(host, [
      "activeWorktrees", "activeSessions", "activeStepExecutors",
      "activeWorkflowStepSessions", "activeWorkflowGraphAbortControllers",
    ]),
    processWideGraphRouting: host.constructor.processWideGraphRouting as Set<string>,
  };
}

export function buildReenterPausedAbortedWorkflowNodeDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "store", "activeWorktrees", "activeSessions", "activeStepExecutors",
      "activeWorkflowStepSessions", "activeWorkflowGraphAbortControllers",
    ]),
    processWideGraphRouting: host.constructor.processWideGraphRouting as Set<string>,
    ...facadeMethods(host, [
      "getRunContextFor", "resolveResumeLanes", "clearPausedAborted",
      "persistTokenUsage", "executeWorkflowGraph", "execute",
    ]),
  };
}

export function buildScheduleWorkflowRerunDeps(host: any, workflowRerunWatchdogMs: number): any {
  return {
    ...facadeFields(host, ["store", "workflowRerunWatchdogs"]),
    workflowRerunWatchdogMs,
    ...facadeMethods(host, [
      "clearWorkflowRerunWatchdog", "performWorkflowRerunBounce", "getExecutionPauseLabel",
      "resolveResumeLanes",
    ]),
  };
}

export function buildClearPhantomExecutorBindingDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "activeWorktrees", "executing", "recoveringCompleted",
      "resumingUnpaused", "approvalSuspended", "approvalResumeAfterUnwind",
      "effectiveColumnAgentByTask",
    ]),
    processWideGraphRouting: host.constructor.processWideGraphRouting as Set<string>,
    ...facadeMethods(host, ["hasLiveSessionSurface", "getActiveWorktreePaths"]),
  };
}

export function buildShouldDeferWorkflowStepCompletionDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "pausedAborted", "userCanceledTaskIds"]),
    ...facadeMethods(host, [
      "getRunContextFor", "clearCompletedTaskWatchdog", "resolveResumeLanes",
      "shouldDeferCompletionForGlobalPause",
    ]),
  };
}

export function buildRequestPreMergeOptionalStepFixDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "workflowLifecycleMovesInFlight"]),
    ...facadeMethods(host, [
      "getRunContextFor", "recoverMissingRequiredArtifacts", "parkPlanReviewReplanCapExhausted",
      "clearPausedAborted", "sendTaskBackForFix",
    ]),
  };
}

export function buildHandleLoopDetectedDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "activeSessions", "loopRecoveryState"]),
    markLoopObserved: host.options.stuckTaskDetector
      ? (id: string) => host.options.stuckTaskDetector!.markLoopObserved(id)
      : undefined,
  };
}

export function buildSendTaskBackForFixDeps(host: any, maxWorkflowStepRetries: number): any {
  return {
    store: host.store,
    ...facadeMethods(host, [
      "clearCompletedTaskWatchdog", "injectWorkflowStepFailureInstructions", "reopenLastStepForRevision",
      "scheduleWorkflowRerun",
    ]),
    maxWorkflowStepRetries,
  };
}

export function buildAbortAllInFlightDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
      "activeConfiguredCommandControllers", "activeWorkflowGraphAbortControllers", "activeSubagentSessions",
      "activeCliTaskSessions", "childSessions",
    ]),
    ...facadeMethods(host, ["awaitAbortInFlightTaskWork"]),
  };
}

export function buildPerformWorkflowRerunBounceDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "workflowRerunPending"]),
    ...facadeMethods(host, [
      "getExecutionPauseLabel", "resolveResumeLanes", "clearTerminalStepFailuresForRetry",
    ]),
  };
}

export function buildExecuteReviewHandoffDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    ...facadeMethods(host, ["persistTokenUsage", "handoffTaskToReview", "deleteActiveSession"]),
    activeSessions: host.activeSessions,
    untrackStuckTask: (id: string) => { host.options.stuckTaskDetector?.untrackTask(id); },
  };
}

export function buildHandleImplicitTaskDoneRefusalDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, [
      "getRunContextFor", "markGraphExecuteSelfRequeued", "persistTokenUsage",
      "deleteActiveSession",
    ]),
    clearTokenUsageBaseline: (taskId: string) => { host.tokenUsageBaselines.delete(taskId); },
  };
}

export function buildCleanupTaskWorktreeDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "workspaceConfig", "activeWorktrees"]),
    getActiveWorktreePaths: (id: string) => host.getActiveWorktreePaths(id),
    removeOwnWorktreeWithReconcile: (...args: unknown[]) => host.removeOwnWorktreeWithReconcile(...args),
  };
}

export function buildResumeTaskForAgentDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "store", "executing", "activeSessions",
      "activeStepExecutors", "activeWorkflowStepSessions",
    ]),
    ...facadeMethods(host, ["listWipLaneTasks", "taskEffectiveAgentMatches", "execute"]),
  };
}

export function buildHasLiveSessionSurfaceDeps(host: any, pathsForTask: (id: string) => unknown): any {
  return {
    ...facadeFields(host, [
      "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
      "activeCliTaskSessions",
    ]),
    pathsForTask,
  };
}

export function buildBuildActionGateContextDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    approvalSuspended: host.approvalSuspended,
    awaitAbortInFlightTaskWork: (id: string, reason: string) => host.awaitAbortInFlightTaskWork(id, reason),
    agentStore: host.options.agentStore,
    // Lazy getter: only construct the PostgreSQL-backed store when a gate needs it.
    get approvalRequestStore() { return host.approvalRequestStore; },
    activeWorkflowAuthorities: host.activeWorkflowAuthorities,
    activeWorkflowGraphAbortControllers: host.activeWorkflowGraphAbortControllers,
  };
}

export function buildHandleStaleInReviewPlanPauseAbortReplayDeps(host: any): any {
  return {
    store: host.store,
    ...facadeMethods(host, [
      "getRunContextFor", "resolveResumeLanes", "isLiveSharedBranchGroupMember",
      "clearPausedAborted", "persistTokenUsage",
    ]),
    activeWorktrees: host.activeWorktrees,
  };
}

export function buildExecuteCoreDeps(host: any): any {
  return {
    completionFinalizedTaskIds: host.completionFinalizedTaskIds,
    graphRouting: host.graphRouting,
    releaseSemaphore: () => { host.options.semaphore?.release(); },
    ...facadeMethods(host, [
      "clearStalePauseAbortBeforeDispatch", "blockOuterDispatchWhenDependenciesUnmet",
      "executeWorkflowGraph",
    ]),
  };
}

export function buildRouteRetryableRemediationGraphFailureToPreMergeFixDeps(host: any): any {
  return {
    store: host.store,
    ...facadeMethods(host, [
      "getRunContextFor", "isPreMergeRemediationGraphNode", "isLiveSharedBranchGroupMember",
      "resolveFailedPreMergeWorkflowStepBudget", "recoverFailedPreMergeWorkflowStep", "persistTokenUsage",
    ]),
  };
}

export function buildRouteGraphFailureToExecutionResumeDeps(host: any): any {
  return {
    store: host.store,
    ...facadeMethods(host, [
      "getRunContextFor", "resolveResumeLanes", "clearTerminalStepFailuresForRetry",
      "persistTokenUsage",
      // FNXC:WorkflowRemediation 2026-08-09-21:41: FN-8910 completed-review park for refused remediation.
      "isRemediationGraphNode",
    ]),
  };
}

export function buildApplyGraphRethinkResetDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "rootDir", "store", "graphStepRunOnce",
      "graphRethinkNarrations",
    ]),
  };
}

export function buildRunCliAgentNodeDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    activeCliTaskSessions: host.activeCliTaskSessions,
    cliAgentRuntime: host.options.cliAgentRuntime,
    reapCliTaskSessionForHandoff: (session: unknown, id: string) => host.reapCliTaskSessionForHandoff(session, id),
  };
}

export function buildEnsureWorkflowMergeBoundaryTaskDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    ...facadeMethods(host, ["resolveMergeBoundaryColumn", "evaluateWorkflowMergeBoundary"]),
    shouldCompleteChecklistAtWorkflowMerge: (live: unknown, mergeProof: unknown) =>
      host.shouldCompleteChecklistAtWorkflowMerge(live, mergeProof),
  };
}

export function buildResolveSeamColumnAgentDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    agentStore: host.options.agentStore,
    graphSeamGoverningNodeId: host.graphSeamGoverningNodeId,
    graphColumnAgentResolver: host.graphColumnAgentResolver,
  };
}

export function buildReleasePreExecutionWorktreeDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "rootDir", "activeWorktrees"]),
    ...facadeMethods(host, ["getRunContextFor", "hasLiveTaskSessionSurface"]),
  };
}

export function buildRouteUnusableWorktreeGraphFailureToRecoveryDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "pausedAborted"]),
    ...facadeMethods(host, [
      "getRunContextFor", "resolveResumeLanes", "recoverMissingWorktreeSessionStartFailure",
    ]),
  };
}

export function buildHasLiveTaskSessionSurfaceDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
      "activeCliTaskSessions",
    ]),
  };
}

export function buildRecoverMissingWorktreeSessionStartFailureDeps(host: any): any {
  return {
    ...facadeFields(host, ["rootDir", "store"]),
    ...facadeMethods(host, [
      "getRunContextFor", "hasActiveWorktreeBinding", "markGraphExecuteSelfRequeued",
    ]),
  };
}

export function buildCleanupConflictingWorktreeDeps(host: any): any {
  return {
    ...facadeFields(host, ["rootDir", "store"]),
    ...facadeMethods(host, [
      "reconcileSelfOwnedBeforeRemove", "findActiveWorktreeOwner", "removeOwnWorktreeWithReconcile",
    ]),
  };
}

export function buildClearStalePauseAbortBeforeDispatchDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    hasPausedAborted: (taskId: string) => host.pausedAborted.has(taskId),
    ...facadeMethods(host, ["clearPausedAborted"]),
  };
}

export function buildRenewTaskLeaseDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    options: host.options as { agentStore?: unknown; [k: string]: unknown },
    ...facadeMethods(host, ["getRunContextFor"]),
  };
}

export function buildBuildPermanentAgentGatingContextDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    approvalSuspended: host.approvalSuspended,
    get approvalRequestStore() { return host.approvalRequestStore; },
  };
}

export function buildPersistTokenUsageDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    tokenUsageBaselines: host.tokenUsageBaselines,
    getActiveSession: (id: string) => host.activeSessions.get(id)?.session,
  };
}

export function buildRecoverMissingRequiredArtifactsDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    isRequiredArtifactRecoveryProtected: (t: unknown) => host.isRequiredArtifactRecoveryProtected(t),
    workflowLifecycleMovesInFlight: host.workflowLifecycleMovesInFlight,
  };
}

export function buildBuildForeachWorktreeDepsDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "rootDir"]),
    ...facadeMethods(host, ["createWorktree"]),
    semaphoreAvailableCount: () => host.options.semaphore?.availableCount ?? 1,
  };
}

export function buildRouteGraphMergeFailureToRetryDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    mergeRequester: host.mergeRequester,
    ...facadeMethods(host, ["ensureWorkflowMergeBoundaryTask", "persistTokenUsage"]),
  };
}

export function buildRouteImplementationIncompleteMergeGraphFailureDeps(host: any): any {
  return {
    ...buildStoreRunContextDeps(host),
    ...facadeMethods(host, ["clearPausedAborted", "routeGraphFailureToExecutionResume", "persistTokenUsage"]),
    activeWorktrees: host.activeWorktrees,
  };
}

export function buildBlockOuterDispatchWhenEphemeralDisabledDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    agentStore: host.options.agentStore,
    ...facadeMethods(host, ["getRunContextFor"]),
  };
}

export function buildCreateTaskAddDepToolDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "depAborted"]),
    getActiveSession: (id: string) => host.activeSessions.get(id),
    getActiveStepExecutor: (id: string) => host.activeStepExecutors.get(id),
  };
}

export function buildTerminateChildAgentDeps(host: any): any {
  return {
    options: host.options as { agentStore?: unknown; [k: string]: unknown },
    ...facadeFields(host, ["childSessions", "pendingEphemeralDeletions", "totalSpawnedCount"]),
    setTotalSpawnedCount: (n: number) => { host.totalSpawnedCount = n; },
  };
}

export function buildRunProjectedGraphTaskStepDeps(host: any): any {
  return {
    store: host.store,
    runGraphTaskStep: (
      t: unknown, idx: number, inst?: string, gov?: string, think?: unknown, skill?: string,
    ) => host.runGraphTaskStep(t, idx, inst, gov, think, skill),
  };
}

export function buildRunSpawnedChildDeps(host: any): any {
  return {
    agentStore: host.options.agentStore,
    childSessions: host.childSessions,
    adjustSpawnedCount: (delta: number) => {
      host.totalSpawnedCount = Math.max(0, host.totalSpawnedCount + delta);
    },
  };
}

export function buildTryFreshWorktreeAfterLiveConflictDeps(host: any, tryCreateWorktree: any): any {
  return {
    rootDir: host.rootDir,
    store: host.store,
    tryCreateWorktree,
  };
}

export function buildWorktreeCreateConflictFacadeDeps(
  host: any,
  maxWorktreeRetries: number,
  handleWorktreeConflict: any,
  tryCreateWorktree: any,
): any {
  return {
    rootDir: host.rootDir,
    store: host.store,
    maxWorktreeRetries,
    handleWorktreeConflict,
    tryCreateWorktree,
    ...facadeMethods(host, [
      "recoverIndexLockIfStale", "recoverStaleRegistration", "cleanupStaleBranch",
      "tryFreshWorktreeAfterLiveConflict", "shouldGenerateNewWorktreeName", "cleanupConflictingWorktree",
      "normalizeReclaimableWorktreePath", "isLiveCleanupRefusal",
    ]),
  };
}

/*
FNXC:CodeOrganization 2026-08-04-04:10:
Shared recovery-lane classifier bag for handleGraphFailure pause-abort helpers.
One store + resolveResumeLanes + isLiveSharedBranchGroupMember surface for
isRetryableBenignMergePauseAbort / isBenignManualMergeHoldPauseAbort /
isReentrantPausedAbortedInFlightNode so the three facades stay one-liners.
*/
export function buildResumeLaneClassifierDeps(host: any): any {
  return {
    store: host.store,
    ...facadeMethods(host, ["resolveResumeLanes", "isLiveSharedBranchGroupMember"]),
  };
}

export function buildMarkPausedAbortedDeps(host: any): any {
  return {
    ...facadeFields(host, ["pausedAborted", "pausedAbortProvenance"]),
    ...facadeMethods(host, ["safeLogEntry"]),
  };
}

export function buildResumeOrphanedDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "executing", "recoveringCompleted"]),
    processWideGraphRouting: host.constructor.processWideGraphRouting as Set<string>,
    ...facadeMethods(host, [
      "listWipLaneTasks", "clearResumeFailureState", "recoverApprovedStepsOnResume",
      "recoverCompletedTask", "execute",
    ]),
  };
}

/*
FNXC:CodeOrganization 2026-08-04-04:30:
Additional one-liner facade deps bags for remaining multi-line TaskExecutor wrappers.
*/
export function buildSignalTaskCompleteDeps(host: any): any {
  return {
    store: host.store,
    capturedReflectionTaskIds: host.capturedReflectionTaskIds,
    reflectionService: host.options.reflectionService,
    onComplete: host.options.onComplete,
  };
}

export function buildTriggerPostTaskReflectionCaptureDeps(host: any): any {
  return {
    store: host.store,
    capturedReflectionTaskIds: host.capturedReflectionTaskIds,
    reflectionService: host.options.reflectionService,
  };
}

export function buildParkApprovalSuspensionDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "approvalSuspended"]),
    ...facadeMethods(host, ["getRunContextFor", "clearPausedAborted"]),
  };
}

export function buildResumeApprovalAfterUnwindDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "approvalResumeAfterUnwind"]),
    ...facadeMethods(host, ["resolveResumeLanes", "dispatchUnpauseResume"]),
  };
}

export function buildHandoffTaskToReviewDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, ["getRunContextFor", "generateCompletionFeatureVideo"]),
  };
}

export function buildActiveSessionBookkeepingDeps(host: any): any {
  return {
    rootDir: host.rootDir,
    activeSessions: host.activeSessions,
    activeStepExecutors: host.activeStepExecutors,
    ...facadeFields(host, [
      "activeStepExecutorSeenSteeringIds", "activeWorkflowStepSessions", "activeWorkflowStepSessionSeenSteeringIds",
    ]),
    effectiveColumnAgentByTask: host.effectiveColumnAgentByTask,
    graphRouting: host.graphRouting,
    graphExecuteSelfRequeued: host.graphExecuteSelfRequeued,
    ...facadeMethods(host, ["getActiveWorktreePaths", "acquireSessionRegistryPath"]),
  };
}

export function buildAcquireSessionRegistryPathDeps(host: any): any {
  return {
    store: host.store,
    ...facadeMethods(host, ["hasLiveTaskSessionSurface"]),
  };
}

export function buildGetAutoRecoveryDispatcherDeps(host: any): any {
  return {
    store: host.store,
    rootDir: host.rootDir,
    autoRecoveryDispatcher: host.options.autoRecoveryDispatcher,
  };
}

export function buildEnsureTaskWorktreeForPlanningDeps(host: any): any {
  return {
    store: host.store,
    rootDir: host.rootDir,
    getWorkspaceConfig: () => host.workspaceConfig,
    setWorkspaceConfig: (cfg: unknown) => { host.workspaceConfig = cfg; },
    ensureGraphCustomNodeWorktree: (t: unknown, s: unknown, nodeId: string, refresh?: boolean) =>
      host.ensureGraphCustomNodeWorktree(t, s, nodeId, refresh),
  };
}

export function buildPrepareGraphNodeExecutionDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, ["getRunContextFor", "ensureGraphCustomNodeWorktree"]),
  };
}

export function buildCreateTaskUpdateToolDeps(host: any): any {
  return {
    store: host.store,
    resolveTaskCustomFieldDefs: (id: string) => host.resolveTaskCustomFieldDefs(id),
    loopRecoveryState: host.loopRecoveryState,
  };
}

export function buildRemoveOwnWorktreeWithReconcileDeps(host: any): any {
  return {
    ...facadeFields(host, ["rootDir", "store"]),
    ...facadeMethods(host, ["reconcileSelfOwnedBeforeRemove", "hasActiveWorktreeBinding"]),
  };
}

export function buildNormalizeReclaimableWorktreePathDeps(host: any): any {
  return {
    ...facadeFields(host, ["rootDir", "store"]),
    ...facadeMethods(host, ["hasActiveWorktreeBinding", "isLiveCleanupRefusal"]),
  };
}

export function buildResolveEffectivePrincipalIdDeps(host: any): any {
  return {
    graphSeamGoverningNodeId: host.graphSeamGoverningNodeId,
    graphColumnAgentResolver: host.graphColumnAgentResolver,
  };
}

export function buildInjectedRuntimeEnvDeps(host: any): any {
  return {
    rootDir: host.rootDir,
    collectExecutorRuntimeEnv: host.options.pluginRunner
      ? (input: unknown) => host.options.pluginRunner.collectExecutorRuntimeEnv(input)
      : undefined,
  };
}

export function buildGetAuthoritativeAssignedAgentDeps(host: any): any {
  return {
    store: host.store,
    rootDir: host.rootDir,
    agentStore: host.options.agentStore,
    getAuthoritativeAssignedAgentStore: () => host.authoritativeAssignedAgentStore,
    setAuthoritativeAssignedAgentStore: (s: unknown) => { host.authoritativeAssignedAgentStore = s; },
  };
}

export function buildFinalizeMergeConfirmedWorkflowGraphTaskDeps(host: any): any {
  return {
    ...facadeFields(host, ["rootDir", "store"]),
    ...facadeMethods(host, ["getRunContextFor"]),
  };
}

export function buildShouldDeferCompletionForGlobalPauseDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, ["getRunContextFor", "clearCompletedTaskWatchdog"]),
  };
}

export function buildNonContinuableSessionFacadeDeps(host: any): any {
  return buildNonContinuableSessionDeps({
    store: host.store,
    ...facadeMethods(host, [
      "getRunContextFor", "resolveResumeLanes", "persistTokenUsage",
      "clearCompletedTaskWatchdog", "signalTaskComplete", "handoffTaskToReview",
      "markGraphExecuteSelfRequeued",
    ]),
  });
}

export function buildColumnBoundaryHooksFacadeDeps(host: any): any {
  return {
    store: host.store,
    workflowLifecycleMovesInFlight: host.workflowLifecycleMovesInFlight,
  };
}

export function buildParseStepsFacadeDeps(host: any): any {
  return {
    store: host.store,
    readTaskArtifact: (id: string, key: string) => host.readTaskArtifact(id, key),
  };
}

export function buildCodeNodeRunnerFacadeDeps(host: any): any {
  return {
    store: host.store,
    rootDir: host.rootDir,
    readTaskArtifact: (id: string, key: string) => host.readTaskArtifact(id, key),
  };
}

export function buildEvaluateWorkflowMergeBoundaryDeps(host: any): any {
  return {
    store: host.store,
    loadMergeBoundaryInstances: (id: string, rid?: string) => host.loadMergeBoundaryInstances(id, rid),
  };
}

export function buildWorkflowMergeImplementationProofFailureDeps(host: any): any {
  return {
    store: host.store,
    evaluateWorkflowMergeBoundary: (t: unknown, rid?: string) => host.evaluateWorkflowMergeBoundary(t, rid),
  };
}

export function buildAdoptColumnAgentForNodeDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, ["getRunContextFor"]),
    agentStore: host.options.agentStore,
  };
}

export function buildWorktreeInvariantFacadeDeps(host: any): any {
  return buildWorktreeInvariantDeps({
    ...facadeFields(host, ["rootDir", "store", "workspaceConfig"]),
    ...facadeMethods(host, [
      "getActiveWorktreePaths", "getRunContextFor", "emitWorktreeReanchoredAudit",
    ]),
  });
}

export function buildHandleDepAbortCleanupDeps(host: any): any {
  return {
    ...facadeFields(host, ["rootDir", "store", "activeWorktrees"]),
    ...facadeMethods(host, ["removeOwnWorktreeWithReconcile"]),
  };
}

export function buildTryBootstrapMisbindingRecoveryDeps(host: any): any {
  return {
    ...facadeFields(host, ["rootDir", "store"]),
    ...facadeMethods(host, ["getRunContextFor", "markGraphExecuteSelfRequeued"]),
  };
}

export function buildBranchConflictHandleFacadeDeps(host: any): any {
  return buildBranchConflictHandleDeps({
    rootDir: host.rootDir,
    store: host.store,
    onError: host.options.onError,
    ...facadeMethods(host, [
      "getRunContextFor", "findActiveWorktreeOwner", "normalizeReclaimableWorktreePath",
      "cleanupConflictingWorktree", "getAutoRecoveryDispatcher", "persistTokenUsage",
    ]),
  });
}

export function buildReconcileStepsFromGitHistoryDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, ["getRunContextFor", "resolveTaskStepSource"]),
  };
}

export function buildResetStepsIfWorkLostDeps(host: any): any {
  return {
    rootDir: host.rootDir,
    resetLostWorkStepProgress: (t: unknown, count: number, reason: string) =>
      host.resetLostWorkStepProgress(t, count, reason),
  };
}

export function buildTerminateAllChildrenDeps(host: any): any {
  return {
    ...facadeFields(host, ["spawnedAgents"]),
    ...facadeMethods(host, ["terminateChildAgent"]),
  };
}

export function buildPauseAbortMarkerDeps(host: any): any {
  return {
    ...facadeFields(host, [
      "pausedAborted", "pausedAbortProvenance", "completionFinalizedTaskIds",
    ]),
    markPausedAborted: (id: string, provenance?: unknown, source?: string) =>
      host.markPausedAborted(id, provenance, source),
  };
}

export function buildFinalizeAlreadyReviewedTaskDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, ["getRunContextFor", "resolveResumeLanes"]),
  };
}

export function buildRunWithExecutorSemaphoreDeps(host: any): any {
  return {
    options: host.options as { semaphore?: unknown; [k: string]: unknown },
    outerConcurrencyClaims: host.outerConcurrencyClaims,
  };
}

export function buildResetMergeStateIfNeededDeps(host: any): any {
  return {
    store: host.store,
    cleanupMergeStateForReverification: (t: unknown, msg: string, opts?: unknown) =>
      host.cleanupMergeStateForReverification(t, msg, opts),
  };
}

export function buildResolveInstructionsForRoleDeps(host: any): any {
  return {
    rootDir: host.rootDir,
    agentStore: host.options.agentStore,
  };
}

export function buildRunImplementationPhaseDeps(host: any): any {
  return {
    runImplementation: (...a: unknown[]) => host.runImplementation(...a),
  };
}

export function buildRouteResetParsePinMismatchToRetryDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "activeWorktrees"]),
    ...facadeMethods(host, ["getRunContextFor", "clearPausedAborted", "persistTokenUsage"]),
  };
}

export function buildCreateWorktreeFacadeDeps(host: any, tryCreateWorktree: any): any {
  return buildCreateWorktreeDeps(
    host,
    { maxWorktreeRetries: MAX_WORKTREE_RETRIES, worktreeRetryDelaysMs: [...WORKTREE_RETRY_DELAYS] },
    tryCreateWorktree,
  );
}

export function buildGetAssignedAgentRuntimeConfigDeps(host: any): any {
  return {
    getAuthoritativeAssignedAgent: (...a: unknown[]) => host.getAuthoritativeAssignedAgent(...a),
  };
}

export function buildSharedWorkerToolsDeps(host: any): any {
  return {
    ...facadeFields(host, ["store", "rootDir"]),
    messageStore: host.options.messageStore,
    ...facadeMethods(host, ["getRunContextFor"]),
  };
}

export function buildTaskLivenessDeps(host: any): any {
  return {
    executing: host.executing,
    recoveringCompleted: host.recoveringCompleted,
    resumingUnpaused: host.resumingUnpaused,
    activeSessions: host.activeSessions,
    activePlanningWorkflowSessions: host.activePlanningWorkflowSessions,
    activeWorkflowStepSessions: host.activeWorkflowStepSessions,
    processWideGraphRouting: host.constructor.processWideGraphRouting as Set<string>,
  };
}

/** Feature-video options bag — keeps `as any` off executor.ts facades. */
export function buildGenerateCompletionFeatureVideoDeps(host: any): any {
  return { store: host.store, options: host.options };
}

export function buildStoreRunContextDeps(host: any): any {
  return { ...facadeFields(host, ["store"]), ...facadeMethods(host, ["getRunContextFor"]) };
}

export function buildCompletionFinalizationFacadeDeps(host: any): any {
  return {
    ...facadeFields(host, ["store"]),
    ...facadeMethods(host, ["getRunContextFor", "getTaskCompletionBlocker"]),
  };
}

export function buildStaleLockRecoveryDeps(host: any): any {
  return {
    ...facadeFields(host, ["rootDir", "store"]),
    ...facadeMethods(host, ["getRunContextFor"]),
  };
}

export function buildRecoverFailedPreMergeWorkflowStepDeps(host: any): any {
  return {
    store: host.store,
    ...facadeMethods(host, ["getRunContextFor", "resolveFailedPreMergeWorkflowStepBudget", "sendTaskBackForFix"]),
  };
}

export function buildRunImplementationFacadeDeps(host: any): any {
  return buildRunImplementationDeps(host, {
    BRANCH_CONFLICT_TRIPWIRE_THRESHOLD,
    MAX_AUTO_RECOVERY_ATTEMPTS,
  });
}

/*
FNXC:CodeOrganization 2026-08-04-06:45:
disposeStoreLifecycleDisposers deps bag (U4) — keeps TaskExecutor facade one-line while clear
callbacks still touch host disposer fields.
*/
export function buildDisposeStoreLifecycleDisposersDeps(host: any): any {
  return {
    clearTaskMoveDisposer: () => {
      host.unregisterTaskMoveDisposer?.();
      host.unregisterTaskMoveDisposer = undefined;
    },
    clearArchiveWorktreeDisposer: () => {
      host.unregisterArchiveWorktreeDisposer?.();
      host.unregisterArchiveWorktreeDisposer = undefined;
    },
    clearArchiveWorkspaceWorktreeDisposer: () => {
      host.unregisterArchiveWorkspaceWorktreeDisposer?.();
      host.unregisterArchiveWorkspaceWorktreeDisposer = undefined;
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

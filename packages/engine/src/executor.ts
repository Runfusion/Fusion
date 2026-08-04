// port-4040-allowlist: this file embeds the "never kill port 4040" rule in the executor prompt.
import {
  AgentStore,
  type TaskStore, type Task, type TaskDetail, type TaskTokenUsage, type Settings,
  type RunMutationContext, type Agent, type MergeResult, type WorkflowIrNode,
  type WorkflowStepResult as CoreWorkflowStepResult, type ThinkingLevel,
  type WorkflowIr, type WorkflowFieldDefinition, type WorkflowColumnAgent, type TaskMoveLanes,
  type ApprovalRequestStore, type WorkspaceConfig, type RunCommandResult,
} from "@fusion/core";
import type { ImplementationExit } from "./executor/implementation-exit.js";
import { resolvePlannerLanes } from "./execution/replan-target.js";
import { type WorkflowGraphTaskRunResult, type WorkflowColumnBoundaryHooks } from "./workflows/workflow-graph-task-runner.js";
import type { ParseStepsHandlerDeps, CodeNodeRunner, ForeachActiveContext, WorkflowLegacySeams } from "./workflows/workflow-node-handlers.js";
import type { WorkflowBranchPersistence } from "./workflows/workflow-graph-branches.js";
import type { WorkflowStepInstancePersistence } from "./workflows/workflow-graph-foreach.js";
import type { WorkflowNodePreparationRequirement, WorkflowNodeResult } from "./workflows/workflow-graph-executor.js";
import type { PreparedWorktree, WorkflowRuntimePrimitives } from "./execution/runtime-primitives.js";
import { createWorkflowRuntimePrimitiveProvider } from "./workflows/workflow-runtime-primitive-provider.js";
import { type VerificationResult } from "./execution/verification-utils.js";
import type { ReviewResult } from "./execution/reviewer.js";
import { ModelRegistry, type ToolDefinition, type AgentSession } from "@earendil-works/pi-coding-agent";
import { dropPreHeldExecutorSlot } from "./concurrency/concurrency.js";
/* FNXC:Workspace 2026-06-21-15:00: F5/F8 workspace-path helpers are consumed via free peels / pure-bindings, not direct imports here. */
import { RemovalReason, removeWorktree } from "./worktree/worktree-pool.js";
import { activeSessionRegistry, type ActiveSessionKind } from "./agents/active-session-registry.js";
import { CliTaskSession } from "./cli-agent/task-session.js";
import { TokenCapDetector } from "./errors/token-cap-detector.js";
import type { StuckTaskEvent } from "./healing/stuck-task-detector.js";
import { StepSessionExecutor } from "./execution/step-session-executor.js";
import type { RunTaskStepResult } from "./execution/step-runner.js";
import type { RunAuditor } from "./util/run-audit.js";
import { AutoRecoveryDispatcher } from "./healing/auto-recovery.js";
import { getTaskCompletionBlockerForStore } from "./execution/task-completion.js";
import type { AgentActionGateContext } from "./agents/agent-action-gate.js";

/* FNXC:CodeOrganization 2026-08-03-20:50: Public non-Free re-exports in executor/public-reexports.ts. */
export * from "./executor/public-reexports.js";
import type { PausedAbortProvenance } from "./executor/paused-abort-provenance.js";

/* FNXC:CodeOrganization 2026-08-04-02:05: Tunables live in executor/executor-constants.ts (U4). */
import {
  MAX_WORKFLOW_STEP_RETRIES,
  COMPLETED_TASK_WATCHDOG_MS,
  WORKFLOW_RERUN_WATCHDOG_MS,
  MAX_WORKTREE_RETRIES,
  WORKTREE_RETRY_DELAYS,
  MAX_AUTO_RECOVERY_ATTEMPTS,
  BRANCH_CONFLICT_TRIPWIRE_THRESHOLD,
} from "./executor/executor-constants.js";

/* FNXC:CodeOrganization 2026-08-03-21:45: Pure free-helper bindings (U4). */
import {
  isTaskWorkComplete,
  hasActiveWorktreeBinding, shouldGenerateNewWorktreeName, findActiveWorktreeOwner, isLiveCleanupRefusal,
  cleanupStaleBranch, planSquashImportFromDep, reconcileSelfOwnedBeforeRemove, emitStaleLockAudit,
  recoverIndexLockIfStale, recoverExecutorStaleRegistration, normalizeReclaimableWorktreePath, removeOwnWorktreeWithReconcile,
  tryFreshWorktreeAfterLiveConflict, runConfiguredCommand,
} from "./executor/pure-bindings.js";
/* FNXC:CodeOrganization 2026-08-03-21:15: Impl bindings barrel (U4). */
import {
  accumulateTokenUsageImpl, tokenUsageWithModelSnapshotImpl, extractSessionTokenUsageImpl,
  tryCreateWorktreeImpl, handleWorktreeConflictImpl, cleanupConflictingWorktreeImpl,
  createWorktreeImpl, squashImportDepIntoWorktreeImpl, rebaseNewWorktreeOntoRemoteImpl,
  resolveWorktreeStartPointImpl, reclaimExistingWorktreeImpl, handleBranchConflictImpl,
  recoverMissingWorktreeSessionStartFailureImpl, verifyWorktreeInvariantsImpl, emitWorktreeReanchoredAuditImpl,
  evaluateTaskDoneScopeLeakImpl, captureModifiedFilesImpl, captureWorkspaceModifiedFilesImpl,
  captureUncommittedModifiedFilesImpl, executeScriptWorkflowStepImpl, reviewWorkspacePerRepoImpl,
  workflowInputRepliesAfterWatermarkImpl, resolveWorkflowInputMarkerForGraphNodeImpl, parkCompletedBlockedTaskImpl,
  getCompletedTaskFinalizationDecisionImpl, shouldFinalizeCompletedTaskImpl, handleNonContinuableSessionErrorImpl,
  handleNonContinuableSessionRetryImpl, createTaskAddDepToolImpl, handleImplicitTaskDoneRefusalImpl,
  handleDepAbortCleanupImpl, reopenLastStepForRevisionImpl, runExecutorDeterministicVerificationImpl,
  injectWorkflowStepFailureInstructionsImpl, sendTaskBackForFixImpl, clearStalePauseAbortBeforeDispatchImpl,
  clearPauseAbortStateForManualRetryImpl, blockOuterDispatchWhenDependenciesUnmetImpl, finalizeMergeConfirmedWorkflowGraphTaskImpl,
  holdForSessionContentionImpl, runAwaitInputNodeImpl, pauseForCliApprovalImpl,
  recoverApprovedStepsOnResumeImpl, tryBootstrapMisbindingRecoveryImpl, advanceNoMergeWorkflowToCompleteColumnImpl,
  applyGraphRethinkResetImpl, disposeSubagentsForTaskImpl, ensureWorkflowMergeBoundaryTaskImpl,
  scheduleCompletedTaskWatchdogImpl, scheduleWorkflowRerunImpl, recoverMissingRequiredArtifactsImpl,
  isRequiredArtifactRecoveryProtectedImpl, performWorkflowRerunBounceImpl, dispatchUnpauseResumeImpl,
  persistTaskTokenUsageImpl, captureExecutorTokenUsageBaselineImpl, persistTokenUsageImpl,
  resetMergeStateIfNeededImpl, recoverFailedPreMergeWorkflowStepImpl, reconcileStepsFromGitHistoryImpl,
  clearPhantomExecutorBindingImpl, cleanupMergeStateForReverificationImpl, clearResumeFailureStateImpl,
  executeReviewHandoffImpl, shouldDeferForHeartbeatImpl, parkPlanReviewReplanCapExhaustedImpl,
  resumeTaskForAgentImpl, buildActionGateContextImpl, buildPermanentAgentGatingContextImpl,
  resolveInstructionsForRoleImpl, signalTaskCompleteImpl, triggerPostTaskReflectionCaptureImpl,
  listWipLaneTasksImpl, resolveSeamColumnAgentImpl, resumeOrphanedImpl,
  handleLoopDetectedImpl, recoverCompletedTaskImpl, markStuckAbortedImpl,
  awaitAbortInFlightTaskWorkImpl, abortAllInFlightImpl, maybeDispatchWorkflowWorkEngineImpl,
  executeCoreImpl, runCliAgentNodeImpl, reapCliTaskSessionForHandoffImpl,
  adoptColumnAgentForNodeImpl, runSpawnedChildImpl, getAutoRecoveryDispatcherImpl,
  prepareGraphNodeExecutionImpl, transitionReviewAddressingImpl, runGraphTaskStepImpl,
  getAuthoritativeAssignedAgentImpl, shouldDeferWorkflowStepCompletionImpl, runProjectedGraphTaskStepImpl,
  buildCodeNodeRunnerImpl, routeResetParsePinMismatchToRetryImpl, ensureGraphCustomNodeWorktreeImpl,
  taskEffectiveAgentMatchesImpl, runRawCliCommandImpl, resetStepsIfWorkLostImpl,
  routeRetryableRemediationGraphFailureToPreMergeFixImpl, buildForeachWorktreeDepsImpl, requestPreMergeOptionalStepFixImpl,
  createSpawnAgentToolImpl, createTaskUpdateToolImpl, attemptExecutorVerificationFixImpl,
  createTaskDoneToolImpl, resetLostWorkStepProgressImpl, resolveResumeLanesImpl,
  isReentrantPausedAbortedInFlightNodeImpl, routeGraphFailureToExecutionResumeImpl, reenterPausedAbortedWorkflowNodeImpl,
  isRetryableBenignMergePauseAbortImpl, isBenignManualMergeHoldPauseAbortImpl, handleStaleInReviewPlanPauseAbortReplayImpl,
  handleStaleInReviewParsePauseAbortReplayImpl, routeGraphMergeFailureToRetryImpl, routeImplementationIncompleteMergeGraphFailureImpl,
  evaluateTaskVerdictProvidersImpl, blockOuterDispatchWhenEphemeralDisabledImpl, routeUnusableWorktreeGraphFailureToRecoveryImpl,
  hasLiveTaskSessionSurfaceImpl, resolveFailedPreMergeWorkflowStepBudgetImpl, hasTrailingConsecutiveToolFailuresImpl,
  isLiveSharedBranchGroupMemberImpl, resolveEffectivePrincipalIdImpl, createAuthoritativeWorkflowPrimitivesFromExecutorImpl,
  createAuthoritativeWorkflowSeamsImpl, executeWorkflowGraphImpl, runGraphCustomNodeImpl,
  handleGraphFailureImpl, handoffTaskToReviewImpl, cleanupTaskWorktreeImpl,
  getAssignedAgentRuntimeConfigImpl, runImplementationPhaseImpl, runImplementationImpl,
  finalizeAlreadyReviewedTaskImpl, isTaskLiveForOverseerRetryImpl, abortAllSessionBashImpl,
  runWithExecutorSemaphoreImpl, buildParseStepsDepsImpl, releasePreExecutionWorktreeImpl,
  terminateChildAgentImpl, evaluateWorkflowMergeBoundaryImpl, getWorkflowMergeImplementationProofFailureImpl,
  renewTaskLeaseImpl, readTaskArtifactImpl, getExecutionPauseLabelImpl,
  resolveMergeBoundaryColumnImpl, loadMergeBoundaryInstancesImpl, shouldCompleteChecklistAtWorkflowMergeImpl,
  markPausedAbortedImpl, acquireSessionRegistryPathImpl, shouldDeferCompletionForGlobalPauseImpl,
  parkApprovalSuspensionImpl, resumeApprovalAfterUnwindIfNeededImpl, ensureTaskWorktreeForPlanningImpl,
  foreachActiveForTaskImpl, buildBranchPersistenceImpl, sessionRegistryPathImpl,
  addActiveWorktreeImpl, getActiveWorktreePathsImpl, setActiveSessionImpl,
  markGraphExecuteSelfRequeuedImpl, deleteActiveSessionImpl, setActiveStepExecutorImpl,
  deleteActiveStepExecutorImpl, setActiveWorkflowStepSessionImpl, deleteActiveWorkflowStepSessionImpl,
  markCompletionFinalizedImpl, clearPausedAbortedImpl, updateStepGraphImpl,
  buildColumnBoundaryHooksImpl, trackTaskDisposalImpl, registerConfiguredCommandControllerImpl,
  unregisterConfiguredCommandControllerImpl, safeLogEntryImpl, awaitFeatureVideoBoundedImpl,
  generateCompletionFeatureVideoImpl, getExecutingTaskIdsImpl, hasActivePlanningWorkflowSessionImpl,
  isTaskActiveImpl, clearCompletedTaskWatchdogImpl, terminateAllChildrenImpl,
  clearTerminalStepFailuresForRetryImpl, resolveTaskCustomFieldDefsImpl, disposeStoreLifecycleDisposersImpl,
  registerSubagentSessionImpl, unregisterSubagentSessionImpl, clearWorkflowRerunWatchdogImpl,
  getModelRegistryImpl, hasLiveSessionSurfaceImpl, listWorktreeHoldersImpl,
  isAgentEffectivelyExecutingImpl, getWorktreePathImpl, buildInjectedRuntimeEnvImpl,
  getApprovalRequestStoreImpl, buildStepInstancePersistenceImpl, resolveMcpServersImpl,
  isRemediationGraphNodeImpl, isPreMergeRemediationGraphNodeImpl, executeWorkflowStepImpl,
  isEphemeralDeletionPendingImpl, disposeEphemeralTimersImpl, resolveTaskStepSourceImpl,
} from "./executor/impl-bindings.js";

/* FNXC:CodeOrganization 2026-08-03-20:40: Free re-exports live in executor/free-reexports.ts (U4 barrel). */
export * from "./executor/free-reexports.js";
import type { ActiveSessionBookkeepingDeps } from "./executor/active-session-bookkeeping.js";
import type { TaskLivenessDeps } from "./executor/task-liveness.js";
import {
  buildBranchConflictHandleDeps,
  buildWorktreeInvariantDeps,
  buildNonContinuableSessionDeps,
  buildExecuteWorkflowGraphDeps,
  buildHandleGraphFailureDeps,
  buildRunImplementationDeps,
  buildRunGraphCustomNodeDeps,
  buildCreateAuthoritativeWorkflowSeamsDeps,
  buildCreateSpawnAgentToolDeps,
  buildExecuteWorkflowStepDeps,
  buildCreateTaskDoneToolDeps,
  buildMarkStuckAbortedDeps,
  buildRunGraphTaskStepDeps,
  buildRecoverCompletedTaskDeps,
  buildExecuteScriptWorkflowStepDeps,
  buildEnsureGraphCustomNodeWorktreeDeps,
  buildCreateWorktreeDeps,
  buildRunRawCliCommandDeps,
  buildEvaluateTaskDoneScopeLeakDeps,
  buildScheduleCompletedTaskWatchdogDeps,
  buildDispatchUnpauseResumeDeps,
  buildHoldForSessionContentionDeps,
  buildCreateAuthoritativeWorkflowPrimitivesFromExecutorDeps,
  buildAttemptExecutorVerificationFixDeps,
  buildAwaitAbortInFlightTaskWorkDeps,
  buildHandleStaleInReviewParsePauseAbortReplayDeps,
  buildReenterPausedAbortedWorkflowNodeDeps,
  buildScheduleWorkflowRerunDeps,
  buildClearPhantomExecutorBindingDeps,
  buildShouldDeferWorkflowStepCompletionDeps,
  buildRequestPreMergeOptionalStepFixDeps,
  buildHandleLoopDetectedDeps,
  buildSendTaskBackForFixDeps,
  buildAbortAllInFlightDeps,
  buildPerformWorkflowRerunBounceDeps,
  buildExecuteReviewHandoffDeps,
  buildHandleImplicitTaskDoneRefusalDeps,
  buildCleanupTaskWorktreeDeps,
  buildResumeTaskForAgentDeps,
  buildHasLiveSessionSurfaceDeps,
  buildBuildActionGateContextDeps,
  buildHandleStaleInReviewPlanPauseAbortReplayDeps,
  buildExecuteCoreDeps,
  buildRouteRetryableRemediationGraphFailureToPreMergeFixDeps,
  buildRouteGraphFailureToExecutionResumeDeps,
  buildApplyGraphRethinkResetDeps,
  buildRunCliAgentNodeDeps,
  buildEnsureWorkflowMergeBoundaryTaskDeps,
  buildResolveSeamColumnAgentDeps,
  buildReleasePreExecutionWorktreeDeps,
  buildRouteUnusableWorktreeGraphFailureToRecoveryDeps,
  buildHasLiveTaskSessionSurfaceDeps,
  buildRecoverMissingWorktreeSessionStartFailureDeps,
  buildCleanupConflictingWorktreeDeps,
  buildClearStalePauseAbortBeforeDispatchDeps,
  buildRenewTaskLeaseDeps,
  buildBuildPermanentAgentGatingContextDeps,
  buildPersistTokenUsageDeps,
  buildRecoverMissingRequiredArtifactsDeps,
  buildBuildForeachWorktreeDepsDeps,
  buildRouteGraphMergeFailureToRetryDeps,
  buildRouteImplementationIncompleteMergeGraphFailureDeps,
  buildBlockOuterDispatchWhenEphemeralDisabledDeps,
  buildCreateTaskAddDepToolDeps,
  buildTerminateChildAgentDeps,
  buildRunProjectedGraphTaskStepDeps,
  buildRunSpawnedChildDeps,
  buildTryFreshWorktreeAfterLiveConflictDeps,
  buildWorktreeCreateConflictFacadeDeps,
  buildResumeLaneClassifierDeps,
  buildMarkPausedAbortedDeps,
  buildResumeOrphanedDeps,
} from "./executor/deps-bags.js";
import { facadeFields, facadeMethods, type FacadeRestArgs, type FacadeAfterFirst, type FacadeAfterSecond } from "./executor/facade-methods.js";
import { bindHandleWorktreeConflict, bindTryCreateWorktree } from "./executor/worktree-create-binders.js";
import { buildWireExecutorLifecycleDeps, wireExecutorLifecycle } from "./executor/wire-executor-lifecycle.js";

export async function __runConfiguredCommandForTests(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
  auditor?: RunAuditor,
  signal?: AbortSignal,
): Promise<RunCommandResult> {
  return runConfiguredCommand(command, cwd, timeoutMs, extraEnv, auditor, signal);
}

/* FNXC:CodeOrganization 2026-08-04-02:35: Orphan await-input/conventions JSDoc removed — lives on await-input-parse.ts + workflow-step-verdict.ts peels. */
import type {
  WorkflowStepOutcome,
} from "./executor/workflow-step-verdict.js";

/* FNXC:CodeOrganization 2026-08-03-21:00: Options/types live in executor/task-executor-options.ts. */
export type {
  TaskExecutorOptions,
  CliAgentRuntime,
  ActiveExecutorSessionState,
  GraphCompletionCallback,
} from "./executor/task-executor-options.js";
import type {
  TaskExecutorOptions,
  ActiveExecutorSessionState,
} from "./executor/task-executor-options.js";

/* FNXC:CodeOrganization 2026-08-04-03:10: Rebound/guard Phase C FNXC lives on lifecycle-columns.ts; GraphCompletionCallback U5d/U5e on task-executor-options.ts. */

export class TaskExecutor {
  /* FNXC:CodeOrganization 2026-08-04-03:15: activeWorktrees SET semantics FNXC lives on active-worktrees.ts. */
  private activeWorktrees = new Map<string, Set<string>>();

  private addActiveWorktree(taskId: string, worktreePath: string): void {
    addActiveWorktreeImpl(this.activeWorktrees, taskId, worktreePath);
  }

  private getActiveWorktreePaths(taskId: string): string[] {
    return getActiveWorktreePathsImpl(this.activeWorktrees, taskId);
  }
  private executing = new Set<string>();
  /** Tasks currently being prepared for unpause resume, before execute() has registered them. */
  private resumingUnpaused = new Set<string>();
  /** Tasks whose active session was intentionally suspended by an action gate. */
  private approvalSuspended = new Set<string>();
  /** Approval decisions received while the old execute() lifecycle is still unwinding. */
  private approvalResumeAfterUnwind = new Set<string>();
  /** Completed orphan recovery tasks currently running during startup. */
  private recoveringCompleted = new Set<string>();
  /** FN-7528: once-per-completion reflection capture guard (see signal-task-complete.ts). */
  private capturedReflectionTaskIds = new Set<string>();
  /** Workflow-rerun bounce in flight (todo→in-progress); blocks premature task:moved execute(). */
  private workflowRerunPending = new Set<string>();
  /** Graph-owned task:moved emissions so external moves still hard-cancel. */
  private workflowLifecycleMovesInFlight = new Set<string>();
  /** FN-5256: in-flight session-disposal promises (await before re-dispatch worktree). */
  private pendingTaskDisposals = new Map<string, Promise<void>>();
  private unregisterTaskMoveDisposer: (() => void) | undefined;
  private unregisterArchiveWorktreeDisposer: (() => void) | undefined;
  private unregisterArchiveWorkspaceWorktreeDisposer: (() => void) | undefined;
  /** Active agent sessions per task, used to terminate on pause and inject steering. */
  private activeSessions = new Map<string, ActiveExecutorSessionState>();
  /** Active step-session executors per task (mutually exclusive with activeSessions). */
  private activeStepExecutors = new Map<string, StepSessionExecutor>();
  /** Steering comments already observed for active step-session executor runs. */
  private activeStepExecutorSeenSteeringIds = new Map<string, Set<string>>();
  /* FNXC:CodeOrganization 2026-08-04-03:35: effectiveColumnAgentByTask semantics on is-agent-effectively-executing.ts. */
  private effectiveColumnAgentByTask = new Map<string, string>();
  /** Active pre-merge workflow step sessions per task. */
  private activeWorkflowStepSessions = new Map<string, AgentSession>();
  /** FNXC:TaskTiming 2026-07-30-21:40: graph-owned Plan Review sessions only (self-healing liveness). */
  private activePlanningWorkflowSessions = new Set<string>();
  /** Steering comments already observed for active workflow step sessions. */
  private activeWorkflowStepSessionSeenSteeringIds = new Map<string, Set<string>>();
  /** Active configured-command abort controllers keyed by task. */
  private activeConfiguredCommandControllers = new Map<string, Set<AbortController>>();
  /** Lazy root-project AgentStore when execution is handed an agents-less worktree store. */
  private authoritativeAssignedAgentStore: AgentStore | null = null;
  /** Active workflow-graph runner abort controllers keyed by task. */
  private activeWorkflowGraphAbortControllers = new Map<string, AbortController>();
  /** CLI agent task sessions (U7) — hard-cancel SIGKILL + in-review PTY reap. */
  private activeCliTaskSessions = new Map<string, CliTaskSession>();
  private readonlyWorkflowStepAuditDone = false;
  /** Reviewer subagent sessions — disposed with parent kill paths. */
  private activeSubagentSessions = new Map<string, Set<AgentSession>>();
  /** Tasks that were paused mid-execution (to avoid marking them as "failed"). */
  private pausedAborted = new Set<string>();
  /* FNXC:CodeOrganization 2026-08-04-03:15: Pause/abort provenance FNXC lives on paused-abort-provenance.ts. */
  private pausedAbortProvenance = new Map<string, PausedAbortProvenance>();
  /* FNXC:CodeOrganization 2026-08-04-03:15: completionFinalizedTaskIds FNXC lives on pause-abort-markers.ts. */
  private completionFinalizedTaskIds = new Set<string>();
  /** Tasks that had a dependency added mid-execution (abort + discard worktree). */
  private depAborted = new Set<string>();
  /** Tasks killed by stuck task detector. Value = shouldRequeue (budget not exhausted). */
  private stuckAborted = new Map<string, boolean>();
  /** Tasks explicitly canceled by user move (in-progress → todo). */
  private userCanceledTaskIds = new Set<string>();
  /** Run-local marker: graph execute self-requeued for recoverable repair (outer failure sink must not overwrite). */
  private graphExecuteSelfRequeued = new Set<string>();
  /** In-memory loop recovery state per task. Keyed by taskId, not persisted.
   *  Tracks compact-and-resume attempt count per execute() lifecycle.
   *  Reset at execute() lifecycle end (finally block). */
  private loopRecoveryState = new Map<string, { attempts: number; pending: boolean }>();
  /** Spawned child agent IDs per parent task ID. Used for lifecycle tracking. */
  private spawnedAgents = new Map<string, Set<string>>();
  /** Per-task baseline of session stats used for delta persistence across repeated updates. */
  private tokenUsageBaselines = new Map<string, { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number }>();
  /** In-memory branch conflict error counters per task for tripwire protection. */
  private branchConflictErrorCount = new Map<string, number>();
  /** One-shot watchdogs for completed tasks that should have transitioned to in-review. */
  private completedTaskWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  /** One-shot watchdogs for workflow reruns that should have bounced back to in-progress. */
  private workflowRerunWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  /** Set of ephemeral spawned agent IDs with in-flight cleanup (prevents duplicate deletion attempts). */
  private pendingEphemeralDeletions = new Set<string>();
  private workspaceConfig: WorkspaceConfig | null | undefined = undefined;

  /* FNXC:CodeOrganization 2026-08-04-03:15: safeLogEntry FN-7335 breadcrumb FNXC lives on safe-log-entry.ts. */
  private safeLogEntry(taskId: string, message: string): void {
    safeLogEntryImpl(this.storeRunContextDeps(), taskId, message);
  }

  private markPausedAborted(
    ...args: FacadeRestArgs<typeof markPausedAbortedImpl>
  ): void {
    markPausedAbortedImpl(buildMarkPausedAbortedDeps(this), ...args);
  }

  private pauseAbortMarkerDeps() {
    return {
      ...facadeFields(this, [
        "pausedAborted", "pausedAbortProvenance", "completionFinalizedTaskIds",
      ]),
      markPausedAborted: (id: string, provenance?: import("./executor/paused-abort-provenance.js").PausedAbortProvenance, source?: string) =>
        this.markPausedAborted(id, provenance, source),
    };
  }
  private markCompletionFinalized(taskId: string): void { markCompletionFinalizedImpl(this.pauseAbortMarkerDeps(), taskId); }
  private clearPausedAborted(taskId: string): void { clearPausedAbortedImpl(this.pauseAbortMarkerDeps(), taskId); }

  private async clearStalePauseAbortBeforeDispatch(task: Task): Promise<void> {
    return clearStalePauseAbortBeforeDispatchImpl(
      buildClearStalePauseAbortBeforeDispatchDeps(this),
      task,
    );
  }

  clearPauseAbortStateForManualRetry(taskId: string): void {
    clearPauseAbortStateForManualRetryImpl(
      { clearPausedAborted: (id: string) => this.clearPausedAborted(id) },
      taskId,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:00: Full Workspace/PlanReviewWorktree FNXC lives on session-registry-path.ts. */
  private sessionRegistryPath(taskId: string, worktreePath: string): string {
    return sessionRegistryPathImpl(this.rootDir, taskId, worktreePath);
  }

  private activeSessionBookkeepingDeps(): ActiveSessionBookkeepingDeps {
    return {
      rootDir: this.rootDir, activeSessions: this.activeSessions, activeStepExecutors: this.activeStepExecutors,
      ...facadeFields(this, [
        "activeStepExecutorSeenSteeringIds", "activeWorkflowStepSessions", "activeWorkflowStepSessionSeenSteeringIds",
      ]),
      effectiveColumnAgentByTask: this.effectiveColumnAgentByTask, graphRouting: this.graphRouting,
      graphExecuteSelfRequeued: this.graphExecuteSelfRequeued,
      getActiveWorktreePaths: (id) => this.getActiveWorktreePaths(id),
      acquireSessionRegistryPath: (id, path, kind, owner) => this.acquireSessionRegistryPath(id, path, kind, owner),
    };
  }

  /* FNXC:CodeOrganization 2026-08-04-03:00: Full SessionContention FNXC lives on acquire-session-registry-path.ts. */
  private acquireSessionRegistryPath(taskId: string, registryPath: string, kind: ActiveSessionKind, ownerKey: string): void {
    acquireSessionRegistryPathImpl(
      {
        store: this.store,
        hasLiveTaskSessionSurface: (id) => this.hasLiveTaskSessionSurface(id),
      },
      taskId,
      registryPath,
      kind,
      ownerKey,
    );
  }

  private setActiveSession(taskId: string, sessionState: ActiveExecutorSessionState, worktreePath: string): void {
    setActiveSessionImpl(this.activeSessionBookkeepingDeps(), taskId, sessionState, worktreePath);
  }

  private markGraphExecuteSelfRequeued(taskId: string): void {
    markGraphExecuteSelfRequeuedImpl(this.activeSessionBookkeepingDeps(), taskId);
  }

  private deleteActiveSession(taskId: string, worktreePath?: string): void {
    deleteActiveSessionImpl(this.activeSessionBookkeepingDeps(), taskId, worktreePath);
  }

  private setActiveStepExecutor(taskId: string, stepExecutor: StepSessionExecutor, worktreePath: string, seenSteeringIds = new Set<string>()): void {
    setActiveStepExecutorImpl(this.activeSessionBookkeepingDeps(), taskId, stepExecutor, worktreePath, seenSteeringIds);
  }

  private deleteActiveStepExecutor(taskId: string, worktreePath?: string): void {
    deleteActiveStepExecutorImpl(this.activeSessionBookkeepingDeps(), taskId, worktreePath);
  }

  private setActiveWorkflowStepSession(taskId: string, session: AgentSession, worktreePath: string, seenSteeringIds = new Set<string>()): void {
    setActiveWorkflowStepSessionImpl(this.activeSessionBookkeepingDeps(), taskId, session, worktreePath, seenSteeringIds);
  }

  private deleteActiveWorkflowStepSession(taskId: string, worktreePath?: string): void {
    deleteActiveWorkflowStepSessionImpl(this.activeSessionBookkeepingDeps(), taskId, worktreePath);
  }

  private registerConfiguredCommandController(taskId: string, controller: AbortController): void {
    registerConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller);
  }

  private unregisterConfiguredCommandController(taskId: string, controller: AbortController): void {
    unregisterConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller);
  }

  private getAutoRecoveryDispatcher(audit: RunAuditor): AutoRecoveryDispatcher {
    return getAutoRecoveryDispatcherImpl(
      {
        store: this.store,
        rootDir: this.rootDir,
        autoRecoveryDispatcher: this.options.autoRecoveryDispatcher,
      },
      audit,
    );
  }

  private async renewTaskLease(
    ...args: FacadeRestArgs<typeof renewTaskLeaseImpl>
  ): Promise<void>  {
    return renewTaskLeaseImpl(buildRenewTaskLeaseDeps(this), ...args);
  }

  private async finalizeAlreadyReviewedTask(taskId: string): Promise<"merged" | "blocked" | "missing"> {
    return finalizeAlreadyReviewedTaskImpl(
      {
        ...facadeFields(this, ["store"]),
        ...facadeMethods(this, ["getRunContextFor", "resolveResumeLanes"]),
      },
      taskId,
    );
  }

  private async getExecutionPauseLabel(): Promise<"global pause" | "engine pause" | null> {
    return getExecutionPauseLabelImpl({ store: this.store });
  }

  private async shouldDeferCompletionForGlobalPause(
    ...args: FacadeRestArgs<typeof shouldDeferCompletionForGlobalPauseImpl>
  ): Promise<boolean> {
    return shouldDeferCompletionForGlobalPauseImpl(
      {
        ...facadeFields(this, ["store"]),
        ...facadeMethods(this, ["getRunContextFor", "clearCompletedTaskWatchdog"]),
      },
      ...args,
    );
  }

  private async shouldDeferWorkflowStepCompletion(
    ...args: FacadeRestArgs<typeof shouldDeferWorkflowStepCompletionImpl>
  ): Promise<boolean>  {
    return shouldDeferWorkflowStepCompletionImpl(buildShouldDeferWorkflowStepCompletionDeps(this), ...args);
  }

  /** Child agent sessions keyed by agent ID. Used for termination. */
  private childSessions = new Map<string, AgentSession>();
  /** Total count of currently spawned agents (across all parents). */
  private totalSpawnedCount = 0;
  /** Token cap detector for proactive context compaction. */
  private tokenCapDetector = new TokenCapDetector();
  private _modelRegistry?: Promise<ModelRegistry>;
  private _approvalRequestStore?: ApprovalRequestStore;
  /** Current run context for mutation correlation, keyed by task id. */
  private currentRunContexts = new Map<string, RunMutationContext>();

  private getRunContextFor(taskId: string): RunMutationContext | undefined {
    return this.currentRunContexts.get(taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:35: handoffTaskToReview reason/failure FNXC lives on handoff-task-to-review.ts. */
  private async handoffTaskToReview(task: Task, reason: string, runId = this.getRunContextFor(task.id)?.runId): Promise<Task> {
    /* eslint-disable @typescript-eslint/no-explicit-any -- thin facade */
    return handoffTaskToReviewImpl(
      {
        ...this.storeRunContextDeps(),
        generateCompletionFeatureVideo: (...args: unknown[]) => (this as any).generateCompletionFeatureVideo(...args),
      },
      task,
      reason,
      runId,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  /* FNXC:ReviewArtifacts 2026-07-19-10:00: best-effort feature-video before review handoff (never delays transition). */
  private async generateCompletionFeatureVideo(task: Task): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reviewArtifactGenerator is optional TaskExecutorOptions field
    return generateCompletionFeatureVideoImpl({ store: this.store, options: this.options as any }, task);
  }

  private async awaitFeatureVideoBounded(result: Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult>): Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult> {
    return awaitFeatureVideoBoundedImpl(result);
  }

  private getModelRegistry(): Promise<ModelRegistry> {
    return getModelRegistryImpl({
      getModelRegistryCache: () => this._modelRegistry,
      setModelRegistryCache: (value) => { this._modelRegistry = value; },
    });
  }

  private get approvalRequestStore(): ApprovalRequestStore {
    return getApprovalRequestStoreImpl({
      getCache: () => this._approvalRequestStore,
      setCache: (value) => { this._approvalRequestStore = value; },
      store: this.store,
    });
  }

  private buildActionGateContext(taskId: string | undefined, agent: Agent | null | undefined, projectDefaultPolicy?: { rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]>; toolRules?: import("@fusion/core").AgentPermissionPolicyToolRules }): AgentActionGateContext | undefined {
    return buildActionGateContextImpl(
      buildBuildActionGateContextDeps(this),
      taskId,
      agent,
      projectDefaultPolicy,
    );
  }

  private buildPermanentAgentGatingContext(taskId: string | undefined, agent: Agent | null | undefined, projectDefaultPolicy?: { rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]>; toolRules?: import("@fusion/core").AgentPermissionPolicyToolRules }): import("@fusion/core").PermanentAgentGatingContext | undefined {
    return buildPermanentAgentGatingContextImpl(
      buildBuildPermanentAgentGatingContextDeps(this),
      taskId,
      agent,
      projectDefaultPolicy,
    );
  }

  /** Returns the set of task IDs currently being executed. */

  private taskLivenessDeps(): TaskLivenessDeps {
    return {
      executing: this.executing, recoveringCompleted: this.recoveringCompleted, resumingUnpaused: this.resumingUnpaused,
      activeSessions: this.activeSessions, activePlanningWorkflowSessions: this.activePlanningWorkflowSessions,
      activeWorkflowStepSessions: this.activeWorkflowStepSessions, processWideGraphRouting: TaskExecutor.processWideGraphRouting,
    };
  }

  getExecutingTaskIds(): Set<string> {
    return getExecutingTaskIdsImpl(this.taskLivenessDeps());
  }

  /**
   * FNXC:TaskTiming 2026-07-30-21:40:
   * A planning segment has one owner: a graph Plan Review session is live only
   * while both its session registration and planning ownership marker remain.
   * This is intentionally narrower than isTaskActive(), which also covers
   * implementation and non-planning workflow sessions.
   */
  hasActivePlanningWorkflowSession(taskId: string): boolean {
    return hasActivePlanningWorkflowSessionImpl(this.taskLivenessDeps(), taskId);
  }

  isTaskActive(taskId: string): boolean {
    return isTaskActiveImpl(this.taskLivenessDeps(), taskId);
  }

  /*
  FNXC:PlannerOversight 2026-07-21-22:56:
  Overseer retry_step must not hard-cancel a live agent (FN-8471 thrash: status=failed from a raced graph park while step-execute still held a session, then overseer moveTask→todo aborted the live work three times). True when any in-process graph claim, coding/step/CLI session, or unpause-resume handoff still owns the task — broader than isTaskActive so step/workflow/CLI surfaces are covered.
  */
  isTaskLiveForOverseerRetry(taskId: string): boolean {
    return isTaskLiveForOverseerRetryImpl(
      {
        ...facadeFields(this, ["resumingUnpaused"]),
        ...facadeMethods(this, ["isTaskActive", "hasLiveTaskSessionSurface"]),
      },
      taskId,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:15: hasLiveSessionSurface / clearPhantom FNXC on has-live-session-surface.ts + clear-phantom-executor-binding.ts. */
  hasLiveSessionSurface(taskId: string): boolean {
    return hasLiveSessionSurfaceImpl(
      buildHasLiveSessionSurfaceDeps(this, (id) => activeSessionRegistry.pathsForTask(id)),
      taskId,
    );
  }

  clearPhantomExecutorBinding(taskId: string, options: { preserveWorktrees?: boolean } = {}): boolean {
    return clearPhantomExecutorBindingImpl(
      buildClearPhantomExecutorBindingDeps(this),
      taskId,
      options,
    );
  }

  isEphemeralDeletionPending(agentId: string): boolean {
    return isEphemeralDeletionPendingImpl(this.pendingEphemeralDeletions, agentId);
  }

  disposeEphemeralTimers(): void {
    disposeEphemeralTimersImpl(this.pendingEphemeralDeletions);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: abortAllSessionBash FNXC lives on abort-all-session-bash.ts. */

  private registerSubagentSession(taskId: string, session: AgentSession): void {
    registerSubagentSessionImpl(this.activeSubagentSessions, taskId, session);
  }

  private unregisterSubagentSession(taskId: string, session: AgentSession): void {
    unregisterSubagentSessionImpl(this.activeSubagentSessions, taskId, session);
  }

  private disposeSubagentsForTask(taskId: string, reason: string): void {
    disposeSubagentsForTaskImpl(this.activeSubagentSessions, taskId, reason);
  }

  /* FNXC:WorkflowResolvedColumns 2026-07-31-23:59: isPlannerColumnFor DELETED (zero production callers; inert sync-lane count drop). */

  /**
   * Was this card pulled BACKWARD out of a planner lane — as opposed to advancing forward
   * out of it?
   *
   * FNXC:WorkflowLifecycleColumns 2026-07-30-16:55 (PR #2628 review, greptile P1):
   * THE FORWARD EXCLUSIONS MUST RESOLVE TOO, and leaving them literal made this branch WORSE
   * than before I touched it. With a role-aware source check and name-matched destinations, a
   * renamed board's ordinary FORWARD move (planning -> building) passed the source test and
   * matched none of the exclusions, so the evacuation fired on a card that was simply
   * advancing: it aborted live planning work and deleted the valid pre-execution worktree.
   * Before the conversion the source check failed and nothing happened; a half-conversion
   * turned a missed rescue into active damage. Third time this program has produced that
   * shape — gates converted, destinations left literal.
   *
   * Forward means the workflow's own wip, review, or complete lane. When a role is not
   * declared it cannot be a forward target, so it is simply not excluded.
   *
   * FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (LANES COME FROM THE EMITTER — the sync resolver
   * is gone):
   * This took its lanes from `resolvePlannerLanes`, whose selection reader returns `undefined`
   * unconditionally under PostgreSQL, so it answered with the DEFAULT board for every task and both
   * its guards were INERT — counted by `check-inert-sync-lanes`, invisible to the census because
   * they already read as converted.
   *
   * The comment above said it had to be synchronous because the `task:moved` emitter is. That was
   * true and is no longer binding: the emitter now resolves the lanes ONCE, asynchronously
   * (`moves.ts` -> `resolveWorkflowIrForTask`), and hands them down on the payload. Reading a
   * parameter is as synchronous as reading `from`, so nothing is reordered and no listener resolves.
   *
   * `lanes` is REQUIRED rather than optional, deliberately. An optional parameter that the one
   * production caller happens to pass is the "seam with no supplier" shape this program keeps
   * finding — required means a future caller fails typecheck instead of silently falling back to a
   * default board. When the emitter itself could not resolve (`lanes` undefined on the payload), the
   * legacy ids answer, which is exactly what `resolvePlannerLanes` degraded to anyway.
   */
  private isBackwardMoveOutOfPlanning(taskId: string, from: string, to: string, moveLanes: TaskMoveLanes | undefined): boolean {
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (fallback CHANGED — adopting the better argument
    from the duplicate PR #3140):
    The payload is the real path and is preferred. The FALLBACK, for the case where the emitter could
    not resolve, is the SYNC resolver rather than the legacy literals.

    I had it the other way round. Falling back to literals reads cleaner and drops these guards off
    `check-inert-sync-lanes` — but it makes the NO-PAYLOAD path strictly WORSE, because
    `resolvePlannerLanes` is best-effort (it answers correctly under legacy SQLite, and only degrades
    to the default board under PostgreSQL) whereas a literal can never be right on a renamed board.
    Optimising the guard off a ratchet at the cost of the degraded path is scoring the number.

    THESE TWO GUARDS STAY COUNTED by `check-inert-sync-lanes`, which is the honest state: the sync
    call is still here, so the ratchet should still point at it. `executor.ts` goes 4 -> 2, from the
    `isPlannerColumnFor` deletion below, not from these.

    That took two corrections to get right, recorded because the intermediate state was wrong in a way
    that looked authoritative. I predicted "stays counted", the gate reported ZERO, and I wrote the
    under-reporting down as fact. It was a gate defect, not a property of this code: the scan
    registered a sync local only from a direct call initializer and did not follow one through a
    conditional (#3169) or through the object literal these lanes are rebuilt into (#3170). With both
    hops followed the gate reports 2 here — the original prediction.

    The shape was deliberately NOT rewritten to whatever form the scanner recognised. Payload-first
    with a sync fallback is correct on the merits, and a guard that pushes authors toward a worse
    degraded path to keep its own count tidy is a guard doing harm — so the scanner was fixed instead.
    */
    const sync = moveLanes ? undefined : resolvePlannerLanes(this.store, taskId);
    const lanes = {
      hold: moveLanes?.hold ?? sync?.hold ?? "todo",
      intake: moveLanes?.intake ?? sync?.intake ?? "triage",
      wip: moveLanes?.wip ?? sync?.wip ?? "in-progress",
      review: moveLanes?.review ?? sync?.review ?? "in-review",
      complete: moveLanes?.complete ?? sync?.complete ?? "done",
    };
    if (from !== lanes.hold && from !== lanes.intake) return false;
    const forwardTargets = [lanes.wip, lanes.review, lanes.complete].filter(
      (column): column is string => typeof column === "string",
    );
    /*
    DELIBERATELY NOT ALSO EXCLUDING planner-to-planner moves. The literal version fired the
    evacuation on `todo -> triage` (a replan rebound), and whether that is right is a separate
    question from this review fix — the replan path is engine-initiated, so aborting the planning
    session there may be exactly wrong, but changing it is a behavior change with its own
    surfaces to enumerate. This conversion keeps that case behaving as it does today.
    */
    return !forwardTargets.includes(to);
  }

  /** FN-5256: register in-flight disposal so re-dispatch awaits prior session reap. */
  private trackTaskDisposal(taskId: string, disposal: Promise<void>): void {
    trackTaskDisposalImpl({ pendingTaskDisposals: this.pendingTaskDisposals }, taskId, disposal);
  }

  /* FNXC:CodeOrganization 2026-08-04-02:10: awaitAbort / abortAllInFlight thin facades (U4). */
  async awaitAbortInFlightTaskWork(taskId: string, reason: string, options: { userCanceled?: boolean } = {}): Promise<void> {
    return awaitAbortInFlightTaskWorkImpl(
      buildAwaitAbortInFlightTaskWorkDeps(this),
      taskId,
      reason,
      options,
    );
  }

  async abortAllInFlight(reason: string): Promise<void> {
    return abortAllInFlightImpl(
      buildAbortAllInFlightDeps(this),
      reason,
    );
  }

  abortAllSessionBash(): void {
    abortAllSessionBashImpl({
      ...facadeFields(this, [
        "activeSessions", "childSessions", "activeStepExecutors",
      ]),
    });
  }

  private async parkApprovalSuspension(taskId: string, surface: string): Promise<boolean> {
    return parkApprovalSuspensionImpl(
      {
        ...facadeFields(this, ["store", "approvalSuspended"]),
        ...facadeMethods(this, ["getRunContextFor", "clearPausedAborted"]),
      },
      taskId,
      surface,
    );
  }

  private async dispatchUnpauseResume(task: Task): Promise<boolean> {
    return dispatchUnpauseResumeImpl(
      buildDispatchUnpauseResumeDeps(this),
      task,
    );
  }

  private async resumeApprovalAfterUnwindIfNeeded(taskId: string): Promise<boolean> {
    return resumeApprovalAfterUnwindIfNeededImpl(
      {
        ...facadeFields(this, ["store", "approvalResumeAfterUnwind"]),
        ...facadeMethods(this, ["resolveResumeLanes", "dispatchUnpauseResume"]),
      },
      taskId,
    );
  }

  private async resolveMcpServers(agentId?: string | null) {
    return resolveMcpServersImpl({ store: this.store }, agentId);
  }

  /**
   * Tasks whose graph run already owns a top-level concurrency slot (scheduler pre-held handoff).
   * Seam re-entry under that graph must not acquire a second slot.
   */
  private outerConcurrencyClaims = new Set<string>();

  /*
  FNXC:GlobalConcurrencyControls 2026-07-14-18:30:
  Prefer a scheduler pre-held global slot when present so the hold/release tryAcquire and the executor share one top-level claim. Without this handoff the executor would acquire a second slot (or leave a gap if the pre-held slot were dropped) and live running counts could drift above the global cap again. While this outer claim is active, seam/step sessions must not acquire again — a second top-level acquire under a full global cap deadlocks (parent holds the last slot, child waits forever).
  */
  private async runWithExecutorSemaphore<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    return runWithExecutorSemaphoreImpl(
      {
        options: this.options as { semaphore?: import("./concurrency/concurrency.js").AgentSemaphore; [k: string]: unknown },
        outerConcurrencyClaims: this.outerConcurrencyClaims,
      },
      taskId,
      work,
    );
  }

  /* FNXC:PlannerOversight 2026-07-13-23:05: session-advisor flush setter (options captured at construct). */
  setOnExecutorLogFlushed(cb: TaskExecutorOptions["onExecutorLogFlushed"]): void {
    this.options = { ...this.options, onExecutorLogFlushed: cb };
  }

  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TaskExecutorOptions = {},
  ) {
    /* FNXC:CodeOrganization 2026-08-04-04:00: constructor wiring via buildWireExecutorLifecycleDeps (U4). */
    const wired = wireExecutorLifecycle(buildWireExecutorLifecycleDeps(this));
    this.unregisterTaskMoveDisposer = wired.unregisterTaskMoveDisposer;
    this.unregisterArchiveWorktreeDisposer = wired.unregisterArchiveWorktreeDisposer;
    this.unregisterArchiveWorkspaceWorktreeDisposer = wired.unregisterArchiveWorkspaceWorktreeDisposer;
  }

  /* FNXC:CodeOrganization 2026-08-04-02:25: shared store + getRunContextFor deps bag for free-fn facades. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same any-spread posture as facadeMethods
  private storeRunContextDeps(): any {
    return {
      ...facadeFields(this, ["store"]),
      ...facadeMethods(this, ["getRunContextFor"]),
    };
  }

  private async resetMergeStateIfNeeded(task: Task, from: Task["column"]): Promise<Task> {
    return resetMergeStateIfNeededImpl(
      {
        store: this.store,
        cleanupMergeStateForReverification: (t, msg, opts) => this.cleanupMergeStateForReverification(t, msg, opts),
      },
      task,
      from,
    );
  }

  private async cleanupMergeStateForReverification(
    ...args: FacadeRestArgs<typeof cleanupMergeStateForReverificationImpl>
  ): Promise<Task>  {
    return cleanupMergeStateForReverificationImpl(this.storeRunContextDeps(), ...args);
  }

  private async clearResumeFailureState(task: Task): Promise<void> {
    return clearResumeFailureStateImpl({ store: this.store }, task);
  }

  private clearCompletedTaskWatchdog(taskId: string): void {
    clearCompletedTaskWatchdogImpl(this.completedTaskWatchdogs, taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:35: signalTaskComplete FN-7528 FNXC lives on signal-task-complete.ts. */
  private signalTaskComplete(task: Task): void {
    return signalTaskCompleteImpl(
      {
        store: this.store,
        capturedReflectionTaskIds: this.capturedReflectionTaskIds,
        reflectionService: this.options.reflectionService,
        onComplete: this.options.onComplete,
      },
      task,
    );
  }

  private triggerPostTaskReflectionCapture(task: Task): void {
    return triggerPostTaskReflectionCaptureImpl(
      {
        store: this.store,
        capturedReflectionTaskIds: this.capturedReflectionTaskIds,
        reflectionService: this.options.reflectionService,
      },
      task,
    );
  }

  private clearWorkflowRerunWatchdog(taskId: string): void {
    clearWorkflowRerunWatchdogImpl(this.workflowRerunWatchdogs, taskId);
  }

  private scheduleCompletedTaskWatchdog(taskId: string, trigger: string): void {
    scheduleCompletedTaskWatchdogImpl(
      buildScheduleCompletedTaskWatchdogDeps(this, COMPLETED_TASK_WATCHDOG_MS),
      taskId,
      trigger,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: clearTerminalStepFailures ReviewLeniency FNXC lives on clear-terminal-step-failures-for-retry.ts. */
  private async clearTerminalStepFailuresForRetry(taskId: string): Promise<void> {
    return clearTerminalStepFailuresForRetryImpl(
      {
        ...this.storeRunContextDeps(),
      },
      taskId,
    );
  }

  private async performWorkflowRerunBounce(
    ...args: FacadeRestArgs<typeof performWorkflowRerunBounceImpl>
  ): Promise<"bounced" | "skipped-pending" | "deferred-paused">  {
    return performWorkflowRerunBounceImpl(buildPerformWorkflowRerunBounceDeps(this), ...args);
  }

  private scheduleWorkflowRerun(
    ...args: FacadeRestArgs<typeof scheduleWorkflowRerunImpl>
  ): void {
    scheduleWorkflowRerunImpl(buildScheduleWorkflowRerunDeps(this, WORKFLOW_RERUN_WATCHDOG_MS), ...args);
  }

  private completionFinalizationDeps() {
    return {
      ...facadeFields(this, ["store"]),
      ...facadeMethods(this, ["getRunContextFor", "getTaskCompletionBlocker"]),
    };
  }

  private async parkCompletedBlockedTask(task: Task, completionBlocker: string, source: string, workComplete = isTaskWorkComplete(task)): Promise<boolean> {
    return parkCompletedBlockedTaskImpl(this.completionFinalizationDeps(), task, completionBlocker, source, workComplete);
  }

  private async getCompletedTaskFinalizationDecision(taskId: string, taskDone: boolean): Promise<"finalize" | "blocked" | "incomplete"> {
    return getCompletedTaskFinalizationDecisionImpl(this.completionFinalizationDeps(), taskId, taskDone);
  }

  private async shouldFinalizeCompletedTask(taskId: string, taskDone: boolean): Promise<boolean> {
    return shouldFinalizeCompletedTaskImpl(this.completionFinalizationDeps(), taskId, taskDone);
  }

  private nonContinuableSessionDeps() {
    return buildNonContinuableSessionDeps({
      store: this.store,
      ...facadeMethods(this, [
        "getRunContextFor", "resolveResumeLanes", "persistTokenUsage",
        "clearCompletedTaskWatchdog", "signalTaskComplete", "handoffTaskToReview",
        "markGraphExecuteSelfRequeued",
      ]),
    });
  }

  private async handleNonContinuableSessionError(task: Task, taskDone: boolean, errorMessage: string): Promise<boolean> {
    return handleNonContinuableSessionErrorImpl(this.nonContinuableSessionDeps(), task, taskDone, errorMessage);
  }

  private async handleNonContinuableSessionRetry(task: Task, errorMessage: string): Promise<boolean> {
    return handleNonContinuableSessionRetryImpl(this.nonContinuableSessionDeps(), task, errorMessage);
  }

  private async getTaskCompletionBlocker(task: Task): Promise<string | undefined> {
    return getTaskCompletionBlockerForStore(this.store, task);
  }

  /**
   * FNXC:TokenBudget 2026-07-16-00:00:
   * Step-session token usage bypasses the shared session helper, so all executor
   * writes use this seam to retain the required persist-time budget enforcement.
   */
  private async persistTaskTokenUsage(taskId: string, tokenUsage: TaskTokenUsage): Promise<void> {
    return persistTaskTokenUsageImpl(
      {
        ...this.storeRunContextDeps(),
      },
      taskId,
      tokenUsage,
    );
  }

  /*
   * FNXC:TokenAnalytics 2026-07-17-14:00:
   * `persistTokenUsage` is the sole writer for a central executor session. Prompt paths call this same delta seam rather than `accumulateSessionTokenUsage`, preventing independently-baselined helper and finalization writes from crediting the same cumulative tokens twice.
   */
  private async captureExecutorTokenUsageBaseline(taskId: string, session: AgentSession): Promise<void> {
    return captureExecutorTokenUsageBaselineImpl(
      { tokenUsageBaselines: this.tokenUsageBaselines },
      taskId,
      session,
    );
  }

  private async persistTokenUsage(taskId: string, session?: AgentSession): Promise<void> {
    return persistTokenUsageImpl(
      buildPersistTokenUsageDeps(this),
      taskId,
      session,
    );
  }

  // FNXC:CodeOrganization 2026-08-03-09:25:
  // Thin prototype facades for pure token helpers so Object.create(TaskExecutor.prototype) tests and any instance-method call sites keep working after the free-function peel.
  private accumulateTokenUsage(
    ...args: Parameters<typeof accumulateTokenUsageImpl>
  ): ReturnType<typeof accumulateTokenUsageImpl>  {
    return accumulateTokenUsageImpl(...args);
  }

  private tokenUsageWithModelSnapshot(
    ...args: Parameters<typeof tokenUsageWithModelSnapshotImpl>
  ): ReturnType<typeof tokenUsageWithModelSnapshotImpl>  {
    return tokenUsageWithModelSnapshotImpl(...args);
  }

  private async extractSessionTokenUsage(
    ...args: Parameters<typeof extractSessionTokenUsageImpl>
  ): ReturnType<typeof extractSessionTokenUsageImpl>  {
    return extractSessionTokenUsageImpl(...args);
  }

  /**
   * Execute a review handoff: move the task to in-review column with
   * awaiting-user-review status, assign the requesting user, and dispose
   * the agent session.
   */
  private async executeReviewHandoff(
    ...args: FacadeRestArgs<typeof executeReviewHandoffImpl>
  ): Promise<void>  {
    return executeReviewHandoffImpl(buildExecuteReviewHandoffDeps(this), ...args);
  }

  /**
   * Fast-path a completed task directly to in-review without spawning a new agent.
   * Captures modified files, runs workflow steps, and transitions the task.
   *
   * @returns true if the task was successfully transitioned, false otherwise.
   */
  async recoverCompletedTask(task: Task): Promise<boolean> {
    return recoverCompletedTaskImpl(
      buildRecoverCompletedTaskDeps(this),
      task,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: optional-step budget + replan-cap FNXC on request-pre-merge-optional-step-fix.ts + park-plan-review-replan-cap.ts. */
  private async parkPlanReviewReplanCapExhausted(
    ...args: FacadeRestArgs<typeof parkPlanReviewReplanCapExhaustedImpl>
  ): Promise<void>  {
    return parkPlanReviewReplanCapExhaustedImpl(this.storeRunContextDeps(), ...args);
  }

  private async requestPreMergeOptionalStepFix(
    ...args: FacadeRestArgs<typeof requestPreMergeOptionalStepFixImpl>
  ): Promise<boolean> {
    return requestPreMergeOptionalStepFixImpl(buildRequestPreMergeOptionalStepFixDeps(this), ...args);
  }

  private async recoverMissingRequiredArtifacts(
    ...args: FacadeRestArgs<typeof recoverMissingRequiredArtifactsImpl>
  ): Promise<void>  {
    return recoverMissingRequiredArtifactsImpl(buildRecoverMissingRequiredArtifactsDeps(this), ...args);
  }

  private async isRequiredArtifactRecoveryProtected(task: Task): Promise<boolean> {
    return isRequiredArtifactRecoveryProtectedImpl(
      this.store,
      (taskId: string) => this.resolveResumeLanes(taskId),
      task,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:30: recoverFailedPreMerge FNXC lives on recover-failed-pre-merge-step.ts. */
  async recoverFailedPreMergeWorkflowStep(task: Task): Promise<boolean> {
    return recoverFailedPreMergeWorkflowStepImpl(
      {
        ...facadeMethods(this, ["resolveFailedPreMergeWorkflowStepBudget", "sendTaskBackForFix"]),
      },
      task,
    );
  }

    /**
   * Returns true when execute() should be deferred because the agent bound to
   * this task has an active heartbeat run and allowParallelExecution=false.
   *
   * Only applies to permanent (non-ephemeral) agents. Always returns false
   * when agentStore is unavailable or the agent cannot be resolved.
   */
  private async shouldDeferForHeartbeat(agentId: string): Promise<boolean> {
    return shouldDeferForHeartbeatImpl(
      { agentStore: this.options.agentStore },
      agentId,
    );
  }

  private async getAuthoritativeAssignedAgent(
    assignedAgentId: string | null | undefined,
  ): Promise<Agent | null> {
    return getAuthoritativeAssignedAgentImpl(
      {
        store: this.store,
        rootDir: this.rootDir,
        agentStore: this.options.agentStore,
        getAuthoritativeAssignedAgentStore: () => this.authoritativeAssignedAgentStore,
        setAuthoritativeAssignedAgentStore: (s) => { this.authoritativeAssignedAgentStore = s; },
      },
      assignedAgentId,
    );
  }

  private async getAssignedAgentRuntimeConfig(
    assignedAgentId: string | null | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    /* eslint-disable @typescript-eslint/no-explicit-any -- thin facade */
    return getAssignedAgentRuntimeConfigImpl(
      {
        getAuthoritativeAssignedAgent: (...args: unknown[]) => (this as any).getAuthoritativeAssignedAgent(...args),
      },
      assignedAgentId,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  /* FNXC:CodeOrganization 2026-08-04-03:15: listWipLaneTasks resume-sweep FNXC lives on list-wip-lane-tasks.ts. */
  private async listWipLaneTasks(): Promise<Task[]> {
    return listWipLaneTasksImpl(this.store);
  }

  async resumeTaskForAgent(agentId: string): Promise<void> {
    return resumeTaskForAgentImpl(
      buildResumeTaskForAgentDeps(this),
      agentId,
    );
  }

  /** Column-agent U5/R6: effective principal matches agentId (fail-soft → false). */
  private async taskEffectiveAgentMatches(task: Task, agentId: string): Promise<boolean> {
    return taskEffectiveAgentMatchesImpl(this.store, task, agentId);
  }

  /** Resume orphaned in-progress tasks after crash/restart (complete → in-review fast path). */
  async resumeOrphaned(): Promise<void> {
    return resumeOrphanedImpl(buildResumeOrphanedDeps(this, TaskExecutor.processWideGraphRouting));
  }

  private async resolveInstructionsForRole(role: string, settings?: Settings): Promise<string> {
    return resolveInstructionsForRoleImpl(
      {
        rootDir: this.rootDir,
        agentStore: this.options.agentStore,
      },
      role,
      settings,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: graphCompletion U5d/U5e FNXC lives on task-executor-options.ts. */
  /** Per graph-run agent-log boundary; passed to failure handling rather than trusting stale task snapshots. */
  private graphToolFailureRunCursors = new Map<string, number>();

  /** Step-inversion pin for hard per-step boundary before step-review (cleared on graph finally). */
  private graphStepSessionPinned = new Set<string>();

  /** Step-inversion (U6/U8): once-per-run implementation-phase cache keyed by task id. */
  private graphStepRunOnce = new Map<string, Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }>>();

  /** Step-inversion (KTD-4): active foreach context for deferDoneToReview (`taskId:instanceId`). */
  private graphStepActiveContext = new Map<string, ForeachActiveContext>();

  /** FNXC:ProactiveChatStatus 2026-07-16-12:30: RETHINK summary held until rework reset succeeds. */
  private graphRethinkNarrations = new Map<string, string>();

  /** Per-run column-agent binding resolver (nodeId → binding); cleared in graph finally. */
  private graphColumnAgentResolver = new Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>();

  /** (U3) Unattended graph runs (LFG/pipeline) — FUSION_HEADLESS for skill steps. */
  private graphUnattendedRuns = new Set<string>();

  /** Governing seam node id for in-flight implementation pass (column-agent plan U4). */
  private graphSeamGoverningNodeId = new Map<string, string>();

  /** FNXC:Settings-ThinkingLevel 2026-07-10-00:00: per-run thinking pin for execute/step-execute seams. */
  private graphSeamThinkingLevel = new Map<string, ThinkingLevel>();

  /** FNXC:WorkflowStepSkills 2026-07-22-00:00: FN-8490 skill pin for pass-initiating foreach instance. */
  private graphSeamSkillName = new Map<string, string>();

  /** FN-4811 process-wide graph routing (cross-instance execute() races). */
  private get graphRouting(): Set<string> {
    return TaskExecutor.processWideGraphRouting;
  }

  private static processWideGraphRouting = new Set<string>();

  /** Wired by the runtime to ProjectEngine.onMerge. */
  private mergeRequester?: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>;

  setMergeRequester(requestMerge: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>): void {
    this.mergeRequester = requestMerge;
  }

  private async executeWorkflowGraph(
    ...args: FacadeRestArgs<typeof executeWorkflowGraphImpl>
  ): Promise<void> {
    return executeWorkflowGraphImpl(buildExecuteWorkflowGraphDeps(this), ...args);
  }

  private buildBranchPersistence(): WorkflowBranchPersistence | undefined {
    return buildBranchPersistenceImpl({ store: this.store });
  }

  /** Graph foreach instance persistence (KTD-6); undefined on pre-CRUD stores. */
  private buildStepInstancePersistence(): WorkflowStepInstancePersistence | undefined {
    return buildStepInstancePersistenceImpl({ store: this.store });
  }

  /* FNXC:CodeOrganization 2026-08-04-03:15: no-merge complete-column + IR pin FNXC lives on no-merge-complete-column.ts. */
  private async advanceNoMergeWorkflowToCompleteColumn(task: TaskDetail): Promise<void> {
    return advanceNoMergeWorkflowToCompleteColumnImpl(this.store, task);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:15: column-boundary hooks FNXC lives on build-column-boundary-hooks.ts. */
  private buildColumnBoundaryHooks(task: Pick<Task, "id">, workflowRunId?: string): WorkflowColumnBoundaryHooks {
    return buildColumnBoundaryHooksImpl(
      {
        store: this.store,
        workflowLifecycleMovesInFlight: this.workflowLifecycleMovesInFlight,
      },
      task,
      workflowRunId,
    );
  }

  /** KTD-12 parse-steps artifact/parser for graph-owned step lists (undefined = legacy). */
  private resolveTaskStepSource(ir: WorkflowIr | undefined): { artifact: string; parser: string } | undefined {
    return resolveTaskStepSourceImpl(ir);
  }

  /** KTD-13 workflow custom field defs for prompt surface (fail-soft → undefined). */
  private async resolveTaskCustomFieldDefs(taskId: string): Promise<WorkflowFieldDefinition[] | undefined> {
    return resolveTaskCustomFieldDefsImpl({ store: this.store }, taskId);
  }

  /**
   * Build the parse-steps node handler deps (KTD-12, U12): artifact read through
   * the task-documents machinery (PROMPT.md falls back to the task's own PROMPT
   * content the way step-init does), step-list write through the graph-source
   * projection (`updateTask({ steps })`), pin-protection probe (persisted instance
   * rows exist → re-parse illegal, KTD-3), and a logEntry-backed audit sink.
   */
  /**
   * Read a task artifact by key through the task-documents layer, falling back to
   * the task's own PROMPT content for the default `PROMPT.md` step-source artifact
   * (the same source the legacy step-init reads). Shared by the parse-steps and
   * code-node deps (FIX 7: one source of truth for the fallback).
   */
  private async readTaskArtifact(taskId: string, key: string): Promise<string | undefined> {
    return readTaskArtifactImpl({ store: this.store }, taskId, key);
  }

  private buildParseStepsDeps(runId?: string): ParseStepsHandlerDeps {
    return buildParseStepsDepsImpl(
      {
        store: this.store,
        readTaskArtifact: (id, key) => this.readTaskArtifact(id, key),
      },
      runId,
    );
  }

  /** KTD-15/U14 code-node runner (worktree cwd, artifact pre-read, customFields). */
  private buildCodeNodeRunner(): CodeNodeRunner {
    return buildCodeNodeRunnerImpl({
      store: this.store,
      rootDir: this.rootDir,
      readTaskArtifact: (id, key) => this.readTaskArtifact(id, key),
    });
  }

  private buildForeachWorktreeDeps(task: Task, runId?: string): ReturnType<typeof buildForeachWorktreeDepsImpl> {
    return buildForeachWorktreeDepsImpl(
      buildBuildForeachWorktreeDepsDeps(this),
      task,
      runId,
    );
  }

  private async applyGraphRethinkReset(taskId: string, active: ForeachActiveContext): Promise<void> {
    return applyGraphRethinkResetImpl(
      buildApplyGraphRethinkResetDeps(this),
      taskId,
      active,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: runImplementationPhase U5e FNXC lives on run-implementation-phase.ts. */
  private async runImplementationPhase(
    task: Task,
    prepared?: PreparedWorktree,
  ): Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }> {
    /* eslint-disable @typescript-eslint/no-explicit-any -- thin facade */
    return runImplementationPhaseImpl(
      {
        runImplementation: (...args: unknown[]) => (this as any).runImplementation(...args),
      },
      task,
      prepared,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: step-inversion driver FNXC lives on run-graph-task-step.ts. */
  private async runGraphTaskStep(
    ...args: FacadeRestArgs<typeof runGraphTaskStepImpl>
  ): Promise<{ success: boolean; error?: string; exit?: ImplementationExit }> {
    return runGraphTaskStepImpl(buildRunGraphTaskStepDeps(this), ...args);
  }

  /** Read the active foreach instance context for a graph-owned task (if any) so
   *  the step driver can honor `deferDoneToReview`. The active context is threaded
   *  through the foreach sub-walk; we surface it via a per-task slot the
   *  step-execute seam stamps. Returns undefined outside a foreach instance. */
  private foreachActiveForTask(taskId: string, instanceId?: string): ForeachActiveContext | undefined {
    return foreachActiveForTaskImpl(
      { graphStepActiveContext: this.graphStepActiveContext },
      taskId,
      instanceId,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:20: projected step worktree-gating FNXC lives on run-projected-graph-task-step.ts. */
  private async runProjectedGraphTaskStep(
    ...args: FacadeRestArgs<typeof runProjectedGraphTaskStepImpl>
  ): Promise<RunTaskStepResult> {
    return runProjectedGraphTaskStepImpl(buildRunProjectedGraphTaskStepDeps(this), ...args);
  }

  /** Public authoritative-driver seam factory: exposes the same real lifecycle
   * seams the internal graph runner uses, without changing legacy behavior. */
  public createAuthoritativeWorkflowPrimitives(settings: Settings): WorkflowRuntimePrimitives {
    return createWorkflowRuntimePrimitiveProvider((providerSettings) =>
      this.createAuthoritativeWorkflowPrimitivesFromExecutor(providerSettings),
    ).create(settings);
  }

  private createAuthoritativeWorkflowPrimitivesFromExecutor(settings: Settings): WorkflowRuntimePrimitives {
     
    return createAuthoritativeWorkflowPrimitivesFromExecutorImpl(
      buildCreateAuthoritativeWorkflowPrimitivesFromExecutorDeps(this),
      settings,
    );
     
  }

  private async resolveMergeBoundaryColumn(taskId: string, nodeId: string): Promise<string> {
    return resolveMergeBoundaryColumnImpl({ store: this.store }, taskId, nodeId);
  }

  private async ensureWorkflowMergeBoundaryTask(
    ...args: FacadeRestArgs<typeof ensureWorkflowMergeBoundaryTaskImpl>
  ): Promise<TaskDetail>  {
    return ensureWorkflowMergeBoundaryTaskImpl(buildEnsureWorkflowMergeBoundaryTaskDeps(this), ...args);
  }

  private async evaluateWorkflowMergeBoundary(task: TaskDetail, runId?: string): Promise<{
    resolved: boolean;
    hasRelevantNodeResult: boolean;
    allResultsTerminal: boolean;
    coverageComplete: boolean;
    hasForeachStepExecute: boolean;
    missingInstanceIds: string[];
    nonTerminalResult?: CoreWorkflowStepResult;
    complete: boolean;
  }> {
    return evaluateWorkflowMergeBoundaryImpl(
      {
        store: this.store,
        loadMergeBoundaryInstances: (id, rid) => this.loadMergeBoundaryInstances(id, rid),
      },
      task,
      runId,
    );
  }

  private async loadMergeBoundaryInstances(taskId: string, runId?: string): Promise<Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }>> {
    return loadMergeBoundaryInstancesImpl({ store: this.store }, taskId, runId);
  }

  private async getWorkflowMergeImplementationProofFailure(task: TaskDetail): Promise<string | undefined> {
    return getWorkflowMergeImplementationProofFailureImpl(
      {
        store: this.store,
        evaluateWorkflowMergeBoundary: (t, rid) => this.evaluateWorkflowMergeBoundary(t, rid),
      },
      task,
    );
  }

  /*
  FNXC:WorkflowMerge 2026-07-27-12:00:
  FN-8601 gates checklist projection and foreach merge admission on required node-result
  presence, terminal status for every present result, and expanded-instance coverage.
  Non-foreach/no-seam coverage is vacuous and does not change legacy move behavior.
  */
  private shouldCompleteChecklistAtWorkflowMerge(task: TaskDetail, proof?: { complete: boolean }): boolean {
    return shouldCompleteChecklistAtWorkflowMergeImpl(task, proof);
  }

  public createAuthoritativeWorkflowSeams(_settings: Settings): WorkflowLegacySeams {
    return createAuthoritativeWorkflowSeamsImpl(buildCreateAuthoritativeWorkflowSeamsDeps(this), _settings);
  }

  private async updateStepGraph(
    ...args: FacadeRestArgs<typeof updateStepGraphImpl>
  ): Promise<void> {
    return updateStepGraphImpl({ store: this.store }, ...args);
  }

  /**
   * Pause the graph for user input: park the task paused with status
   * "awaiting-user-input" and the node's question as pausedReason. On a later
   * re-run (after the user unpauses), consume the newest steering comment as
   * the answer. Pre-execute placement is fully supported; post-execute
   * placement re-walks earlier read-only nodes until CU-U5 checkpoints land.
   */
  private async runAwaitInputNode(node: WorkflowIrNode, live: TaskDetail): Promise<WorkflowNodeResult> {
    return runAwaitInputNodeImpl(
      {
        ...this.storeRunContextDeps(),
      },
      node,
      live,
    );
  }

  private async pauseForCliApproval(node: WorkflowIrNode, live: TaskDetail, command: string): Promise<WorkflowNodeResult> {
    return pauseForCliApprovalImpl(
      {
        ...this.storeRunContextDeps(),
      },
      node,
      live,
      command,
    );
  }

  /** Run an arbitrary (approved) CLI command in the task worktree, supervised. */
  private async runRawCliCommand(
    ...args: FacadeRestArgs<typeof runRawCliCommandImpl>
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return runRawCliCommandImpl(buildRunRawCliCommandDeps(this, runConfiguredCommand), ...args);
  }

  /** Column-agent U3 adoption for custom nodes (R8 fail-soft → undefined). */
  private async adoptColumnAgentForNode(
    ...args: FacadeRestArgs<typeof adoptColumnAgentForNodeImpl>
  ): Promise<{ modelProvider?: string; modelId?: string; persona?: string } | undefined> {
    return adoptColumnAgentForNodeImpl(
      {
        ...this.storeRunContextDeps(),
        agentStore: this.options.agentStore,
      },
      ...args,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:30: column-agent seam FNXC lives on resolve-seam-column-agent.ts / resolve-effective-principal-id.ts / is-agent-effectively-executing.ts. */
  private async resolveSeamColumnAgent(
    task: Task,
    detail: TaskDetail,
  ): Promise<{ agent: Agent; mode: WorkflowColumnAgent["mode"] | undefined } | undefined> {
    return resolveSeamColumnAgentImpl(
      buildResolveSeamColumnAgentDeps(this),
      task,
      detail,
    );
  }

  private resolveEffectivePrincipalId(
    task: Task,
    detail: Task,
  ): string | undefined {
    return resolveEffectivePrincipalIdImpl(
      {
        graphSeamGoverningNodeId: this.graphSeamGoverningNodeId,
        graphColumnAgentResolver: this.graphColumnAgentResolver,
      },
      task,
      detail,
    );
  }

  isAgentEffectivelyExecuting(agentId: string): boolean {
    return isAgentEffectivelyExecutingImpl(this.effectiveColumnAgentByTask, agentId);
  }

  /** Plugin-injected taskEnv (scoped; never mutates process.env). Shared by agentWork + graph skill steps. */
  private async buildInjectedRuntimeEnv(
    ...args: FacadeRestArgs<typeof buildInjectedRuntimeEnvImpl>
  ): Promise<{ env: NodeJS.ProcessEnv; injectedKeyCount: number; pathEntryCount: number }> {
    return buildInjectedRuntimeEnvImpl(
      {
        rootDir: this.rootDir,
        collectExecutorRuntimeEnv: this.options.pluginRunner
          ? (input) => this.options.pluginRunner!.collectExecutorRuntimeEnv(input)
          : undefined,
      },
      ...args,
    );
  }

  private async ensureGraphCustomNodeWorktree(
    ...args: FacadeRestArgs<typeof ensureGraphCustomNodeWorktreeImpl>
  ): Promise<TaskDetail>  {
    return ensureGraphCustomNodeWorktreeImpl(buildEnsureGraphCustomNodeWorktreeDeps(this, runConfiguredCommand), ...args);
  }

  public async releasePreExecutionWorktree(taskId: string, reason: string): Promise<boolean> {
    return releasePreExecutionWorktreeImpl(
      buildReleasePreExecutionWorktreeDeps(this),
      taskId,
      reason,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:25: planning worktree acquisition FNXC lives on ensure-task-worktree-for-planning.ts. */
  public async ensureTaskWorktreeForPlanning(taskId: string): Promise<string | null> {
    return ensureTaskWorktreeForPlanningImpl(
      {
        store: this.store,
        rootDir: this.rootDir,
        getWorkspaceConfig: () => this.workspaceConfig,
        setWorkspaceConfig: (cfg) => { this.workspaceConfig = cfg; },
        ensureGraphCustomNodeWorktree: (t, s, nodeId, refresh) => this.ensureGraphCustomNodeWorktree(t, s, nodeId, refresh),
      },
      taskId,
    );
  }

  private async prepareGraphNodeExecution(
    node: WorkflowIrNode,
    nodeTask: TaskDetail,
    settings: Settings,
    requirement: WorkflowNodePreparationRequirement,
  ): Promise<void> {
    return prepareGraphNodeExecutionImpl(
      {
        ...this.storeRunContextDeps(),
        ensureGraphCustomNodeWorktree: (t, s, nodeId, refresh) => this.ensureGraphCustomNodeWorktree(t, s, nodeId, refresh),
      },
      node,
      nodeTask,
      settings,
      requirement,
    );
  }

  private async finalizeMergeConfirmedWorkflowGraphTask(taskId: string, reason: string): Promise<boolean> {
    return finalizeMergeConfirmedWorkflowGraphTaskImpl(
      {
        ...facadeFields(this, ["rootDir", "store"]),
        ...facadeMethods(this, ["getRunContextFor"]),
      },
      taskId,
      reason,
    );
  }

  /** Custom (non-seam) graph node via WorkflowStep machinery; columnBinding U3/R precedence. */
  private async runGraphCustomNode(
    ...args: FacadeRestArgs<typeof runGraphCustomNodeImpl>
  ): Promise<WorkflowNodeResult> {
    return runGraphCustomNodeImpl(buildRunGraphCustomNodeDeps(this), ...args);
  }

  private async runCliAgentNode(
    ...args: FacadeRestArgs<typeof runCliAgentNodeImpl>
  ): Promise<WorkflowNodeResult>  {
    return runCliAgentNodeImpl(buildRunCliAgentNodeDeps(this), ...args);
  }

  /** U7 CLI handoff: graceful PTY reap as completed (best-effort; never blocks advancement). */
  private async reapCliTaskSessionForHandoff(session: CliTaskSession, taskId: string): Promise<void> {
    return reapCliTaskSessionForHandoffImpl(session, taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:30: session-contention hold FNXC lives on session-contention-hold.ts. */
  private sessionContentionHoldAttempts = new Map<string, number>();

  private clearSessionContentionHold(taskId: string): void {
    this.sessionContentionHoldAttempts.delete(taskId);
  }

  private async holdForSessionContention(
    ...args: FacadeRestArgs<typeof holdForSessionContentionImpl>
  ): Promise<void>  {
    return holdForSessionContentionImpl(buildHoldForSessionContentionDeps(this), ...args);
  }

  private async routeUnusableWorktreeGraphFailureToRecovery(
    ...args: FacadeRestArgs<typeof routeUnusableWorktreeGraphFailureToRecoveryImpl>
  ): Promise<boolean>  {
    return routeUnusableWorktreeGraphFailureToRecoveryImpl(buildRouteUnusableWorktreeGraphFailureToRecoveryDeps(this), ...args);
  }

  /*
  FNXC:WorkflowRemediation 2026-07-01-23:40:
  A live agent session surface for a task proves the work is still executing, independent of the persisted column/pause/status row that handleGraphFailure re-fetches. This mirrors clearPhantomExecutorBinding's `hasLiveSessionSurface` (FN-6736) but deliberately EXCLUDES `this.executing` and graph-routing membership: those are still set for the graph run that is currently ending (graphRouting is cleared in executeWorkflowGraph's finally, AFTER handleGraphFailure returns), so including them would report every ending run as "still executing" and suppress all failures. Only a registered coding/step/CLI session surface means a SEPARATE, live agent is working the task.
  */
  private hasLiveTaskSessionSurface(taskId: string): boolean {
    return hasLiveTaskSessionSurfaceImpl(
      buildHasLiveTaskSessionSurfaceDeps(this),
      taskId,
    );
  }

  /*
  FNXC:WorkflowRemediation 2026-07-01-23:40:
  A `pre-merge-remediation` / `plan-replan` node (e.g. `code-review-remediation`) is a FIRE-AND-FORGET async scheduler, not a terminal work node: its job is to hand off an implementation fix (sendTaskBackForFix re-dispatches the coding session) and stop traversal. These nodes carry only a `success` rework edge back to their gate and NO `failure` out-edge, so when their schedule call cannot re-arm (missing rehydrated failureContext after a restart → `missing-remediation-context`, `remediation-not-scheduled`, or an exhausted rework budget) the failure bubbles out as the terminal graph outcome and handleGraphFailure would stamp `status:"failed"` — even while a previously-scheduled fix/reviewer session is still live. Classify these nodes so that terminal sink can preserve a still-executing task instead of flagging a spurious failure. Detection prefers the resolved IR `workflowAction` (covers custom workflows), with a node-id fallback for the built-in ids when the IR cannot be resolved.
  */
  private async isRemediationGraphNode(taskId: string, failedNode: string | undefined): Promise<boolean> {
    return isRemediationGraphNodeImpl({ store: this.store }, taskId, failedNode);
  }

  /*
  FNXC:WorkflowRemediation 2026-07-03-23:10:
  Retryable parked-remediation recovery is only for pre-merge optional-step remediation nodes. Plan Review `plan-replan` failures must stay on the existing replan/triage path instead of delegating to `recoverFailedPreMergeWorkflowStep`, which reopens implementation work.
  */
  private async isPreMergeRemediationGraphNode(taskId: string, failedNode: string | undefined): Promise<boolean> {
    return isPreMergeRemediationGraphNodeImpl({ store: this.store }, taskId, failedNode);
  }

  private async resolveFailedPreMergeWorkflowStepBudget(
    task: Task,
    target: CoreWorkflowStepResult,
  ): Promise<{ unbounded: boolean; max: number; label: string; key: string; stepName?: string; attempts: number }> {
    return resolveFailedPreMergeWorkflowStepBudgetImpl({ store: this.store }, task, target);
  }

  private async isLiveSharedBranchGroupMember(live: Pick<TaskDetail, "branchContext">): Promise<boolean> {
    return isLiveSharedBranchGroupMemberImpl({ store: this.store, rootDir: this.rootDir }, live);
  }

  private async routeRetryableRemediationGraphFailureToPreMergeFix(
    ...args: FacadeRestArgs<typeof routeRetryableRemediationGraphFailureToPreMergeFixImpl>
  ): Promise<boolean>  {
    return routeRetryableRemediationGraphFailureToPreMergeFixImpl(buildRouteRetryableRemediationGraphFailureToPreMergeFixDeps(this), ...args);
  }

  /* Shared resumeLanesMemo: one snapshot for handleGraphFailure recovery paths (avoid disagreeing re-resolve). */
  private async isRetryableBenignMergePauseAbort(
    ...args: FacadeRestArgs<typeof isRetryableBenignMergePauseAbortImpl>
  ): Promise<boolean> {
    return isRetryableBenignMergePauseAbortImpl(buildResumeLaneClassifierDeps(this), ...args);
  }

  private async isBenignManualMergeHoldPauseAbort(
    ...args: FacadeRestArgs<typeof isBenignManualMergeHoldPauseAbortImpl>
  ): Promise<boolean> {
    return isBenignManualMergeHoldPauseAbortImpl(buildResumeLaneClassifierDeps(this), ...args);
  }

  private async handleStaleInReviewPlanPauseAbortReplay(
    ...args: FacadeRestArgs<typeof handleStaleInReviewPlanPauseAbortReplayImpl>
  ): Promise<boolean> {
    return handleStaleInReviewPlanPauseAbortReplayImpl(buildHandleStaleInReviewPlanPauseAbortReplayDeps(this), ...args);
  }

  private async handleStaleInReviewParsePauseAbortReplay(
    ...args: FacadeRestArgs<typeof handleStaleInReviewParsePauseAbortReplayImpl>
  ): Promise<boolean> {
    return handleStaleInReviewParsePauseAbortReplayImpl(buildHandleStaleInReviewParsePauseAbortReplayDeps(this), ...args);
  }

  private async isReentrantPausedAbortedInFlightNode(
    ...args: FacadeRestArgs<typeof isReentrantPausedAbortedInFlightNodeImpl>
  ): Promise<boolean> {
    return isReentrantPausedAbortedInFlightNodeImpl(buildResumeLaneClassifierDeps(this), ...args);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:05: Full Phase C resume-eligibility FNXC lives on resolve-resume-lanes.ts. */
  private async resolveResumeLanes(
    taskId: string,
    memo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<{ hold: string; wip: string; review: string; wipDeclared: boolean }> {
    return resolveResumeLanesImpl({ store: this.store }, taskId, memo);
  }

  private async reenterPausedAbortedWorkflowNode(
    ...args: FacadeRestArgs<typeof reenterPausedAbortedWorkflowNodeImpl>
  ): Promise<boolean>  {
    return reenterPausedAbortedWorkflowNodeImpl(buildReenterPausedAbortedWorkflowNodeDeps(this), ...args);
  }

  private async routeGraphMergeFailureToRetry(
    ...args: FacadeRestArgs<typeof routeGraphMergeFailureToRetryImpl>
  ): Promise<boolean>  {
    return routeGraphMergeFailureToRetryImpl(buildRouteGraphMergeFailureToRetryDeps(this), ...args);
  }

  private async routeImplementationIncompleteMergeGraphFailure(live: TaskDetail, failedNode: string): Promise<boolean> {
    return routeImplementationIncompleteMergeGraphFailureImpl(
      buildRouteImplementationIncompleteMergeGraphFailureDeps(this),
      live,
      failedNode,
    );
  }

  private async hasTrailingConsecutiveToolFailures(taskId: string, cursor: number | null | undefined, threshold: number): Promise<boolean> {
    return hasTrailingConsecutiveToolFailuresImpl({ store: this.store }, taskId, cursor, threshold);
  }

  /** Terminal failure of a graph run: record the error and park the task in
   *  review so a human can act — never leave it invisible in in-progress. */
  private async handleGraphFailure(task: Task, result: WorkflowGraphTaskRunResult): Promise<void> {
    return handleGraphFailureImpl(buildHandleGraphFailureDeps(this), task, result);
  }

  private async routeGraphFailureToExecutionResume(
    ...args: FacadeRestArgs<typeof routeGraphFailureToExecutionResumeImpl>
  ): Promise<boolean>  {
    return routeGraphFailureToExecutionResumeImpl(buildRouteGraphFailureToExecutionResumeDeps(this), ...args);
  }

  private async routeResetParsePinMismatchToRetry(live: TaskDetail): Promise<boolean> {
    return routeResetParsePinMismatchToRetryImpl(
      {
        ...facadeFields(this, ["store", "activeWorktrees"]),
        ...facadeMethods(this, ["getRunContextFor", "clearPausedAborted", "persistTokenUsage"]),
      },
      live,
    );
  }

  private async maybeDispatchWorkflowWorkEngine(task: Task): Promise<boolean> {
    return maybeDispatchWorkflowWorkEngineImpl({ store: this.store }, task);
  }

  private async evaluateTaskVerdictProviders(
    task: TaskDetail,
    context: Record<string, unknown> = {},
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return evaluateTaskVerdictProvidersImpl({ store: this.store }, task, context);
  }

  private async blockOuterDispatchWhenDependenciesUnmet(task: Task): Promise<boolean> {
    return blockOuterDispatchWhenDependenciesUnmetImpl(
      {
        ...this.storeRunContextDeps(),
      },
      task,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:25: ephemeral-off dispatch guard FNXC lives on block-outer-dispatch-when-ephemeral-disabled.ts. */
  private async blockOuterDispatchWhenEphemeralDisabled(task: Task): Promise<boolean> {
    return blockOuterDispatchWhenEphemeralDisabledImpl(
      buildBlockOuterDispatchWhenEphemeralDisabledDeps(this),
      task,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:25: execute wrapper + executeCore routing FNXC lives on execute-core.ts. */
  async execute(task: Task): Promise<void> {
    try {
      await this.executeCore(task);
    } finally {
      if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();
    }
  }

  private async executeCore(task: Task): Promise<void> {
    return executeCoreImpl(
      buildExecuteCoreDeps(this),
      task,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:25: runImplementation U5e/U10b/U8 FNXC lives on run-implementation.ts. */
  private async runImplementation(
    ...args: FacadeRestArgs<typeof runImplementationImpl>
  ): Promise<void> {
    return runImplementationImpl(
      buildRunImplementationDeps(this, {
        BRANCH_CONFLICT_TRIPWIRE_THRESHOLD,
        MAX_AUTO_RECOVERY_ATTEMPTS,
      }),
      ...args,
    );
  }

  /** FNXC:CodeOrganization 2026-08-03-22:25: shared free-tool deps bag for runImplementation + executeWorkflowStep. */
  private sharedWorkerToolsDeps(): import("./executor/shared-worker-tools.js").SharedWorkerToolsDeps {
    return {
      ...facadeFields(this, ["store", "rootDir"]),
      messageStore: this.options.messageStore,
      ...facadeMethods(this, ["getRunContextFor"]),
    };
  }

  // ── Custom tools for the worker agent ──────────────────────────────

  private createTaskUpdateTool(
    ...args: FacadeRestArgs<typeof createTaskUpdateToolImpl>
  ): ToolDefinition {
    return createTaskUpdateToolImpl(
      {
        store: this.store,
        resolveTaskCustomFieldDefs: (id) => this.resolveTaskCustomFieldDefs(id),
        loopRecoveryState: this.loopRecoveryState,
      },
      ...args,
    );
  }

  private createTaskAddDepTool(taskId: string): ToolDefinition {
    return createTaskAddDepToolImpl(
      buildCreateTaskAddDepToolDeps(this),
      taskId,
    );
  }

  private async transitionReviewAddressing(taskId: string, from: Array<"queued" | "in-progress" | "addressed" | "failed">, to: "queued" | "in-progress" | "addressed" | "failed"): Promise<void> {
    return transitionReviewAddressingImpl(this.store, taskId, from, to);
  }

  /*
  FNXC:CodeOrganization 2026-08-03-16:20:
  Thin facades over peeled verifyWorktreeInvariants / emitWorktreeReanchoredAudit (U4 Slice B).
  */
  private worktreeInvariantDeps() {
    return buildWorktreeInvariantDeps({
      ...facadeFields(this, [
        "rootDir", "store", "workspaceConfig",
      ]),
      ...facadeMethods(this, [
        "getActiveWorktreePaths", "getRunContextFor", "emitWorktreeReanchoredAudit",
      ]),
    });
  }

  private async verifyWorktreeInvariants(
    ...args: FacadeRestArgs<typeof verifyWorktreeInvariantsImpl>
  ): Promise<ReturnType<typeof verifyWorktreeInvariantsImpl>> {
    return verifyWorktreeInvariantsImpl(this.worktreeInvariantDeps(), ...args);
  }

  private async evaluateTaskDoneScopeLeak(
    ...args: FacadeRestArgs<typeof evaluateTaskDoneScopeLeakImpl>
  ): Promise<ReturnType<typeof evaluateTaskDoneScopeLeakImpl>> {
    return evaluateTaskDoneScopeLeakImpl(buildEvaluateTaskDoneScopeLeakDeps(this), ...args);
  }

  private async handleImplicitTaskDoneRefusal(
    ...args: FacadeRestArgs<typeof handleImplicitTaskDoneRefusalImpl>
  ): Promise<void>  {
    return handleImplicitTaskDoneRefusalImpl(buildHandleImplicitTaskDoneRefusalDeps(this), ...args);
  }

  private createTaskDoneTool(
    ...args: FacadeRestArgs<typeof createTaskDoneToolImpl>
  ): ToolDefinition  {
    return createTaskDoneToolImpl(buildCreateTaskDoneToolDeps(this), ...args);
  }

  /**
   * Clean up after a dep-abort: remove worktree, delete branch, move task to triage.
   * Shared between the try-block (graceful return) and catch-block (error) paths.
   */
  private async handleDepAbortCleanup(taskId: string, worktreePath: string): Promise<void> {
    return handleDepAbortCleanupImpl(
      {
        ...facadeFields(this, ["rootDir", "store", "activeWorktrees"]),
        ...facadeMethods(this, ["removeOwnWorktreeWithReconcile"]),
      },
      taskId,
      worktreePath,
    );
  }

  /**
   * Re-open the implementation-bearing slice of work for a revision/failure
   * handler. Returns the earliest reopened step and all reopened indexes, or
   * null when there was nothing to re-open.
   */
  private async reopenLastStepForRevision(
    taskId: string,
    task: Task,
  ): Promise<{ index: number; name: string; indexes: number[] } | null> {
    return reopenLastStepForRevisionImpl(this.store, taskId, task);
  }

  /**
   * Run deterministic verification (test + build commands) in the task's worktree.
   * Returns a structured result indicating whether all commands passed.
   */
  private async runExecutorDeterministicVerification(
    ...args: FacadeRestArgs<typeof runExecutorDeterministicVerificationImpl>
  ): Promise<VerificationResult>  {
    return runExecutorDeterministicVerificationImpl(this.storeRunContextDeps(), ...args);
  }

  private async attemptExecutorVerificationFix(
    ...args: FacadeRestArgs<typeof attemptExecutorVerificationFixImpl>
  ): Promise<boolean> {
    return attemptExecutorVerificationFixImpl(buildAttemptExecutorVerificationFixDeps(this), ...args);
  }

  private async sendTaskBackForFix(
    ...args: FacadeRestArgs<typeof sendTaskBackForFixImpl>
  ): Promise<void> {
    return sendTaskBackForFixImpl(buildSendTaskBackForFixDeps(this, MAX_WORKFLOW_STEP_RETRIES), ...args);
  }

  private async injectWorkflowStepFailureInstructions(
    ...args: FacadeAfterFirst<typeof injectWorkflowStepFailureInstructionsImpl>
  ): Promise<void>  {
    return injectWorkflowStepFailureInstructionsImpl(this.store, ...args);
  }

  private async captureModifiedFiles(
    ...args: Parameters<typeof captureModifiedFilesImpl>
  ): Promise<string[]>  {
    return captureModifiedFilesImpl(...args);
  }

  private async captureWorkspaceModifiedFiles(
    ...args: Parameters<typeof captureWorkspaceModifiedFilesImpl>
  ): Promise<string[]>  {
    return captureWorkspaceModifiedFilesImpl(...args);
  }

  private async reviewWorkspacePerRepo(
    ...args: Parameters<typeof reviewWorkspacePerRepoImpl>
  ): Promise<ReviewResult>  {
    return reviewWorkspacePerRepoImpl(...args);
  }

  private async captureUncommittedModifiedFiles(worktreePath: string): Promise<string[]> {
    return captureUncommittedModifiedFilesImpl(worktreePath);
  }

  // ── Worktree management ────────────────────────────────────────────

  /**
   * Execute a script-mode workflow step by resolving the scriptName to a command
   * from project settings and running it in the task worktree.
   */
  private async executeScriptWorkflowStep(
    ...args: FacadeRestArgs<typeof executeScriptWorkflowStepImpl>
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return executeScriptWorkflowStepImpl(
      buildExecuteScriptWorkflowStepDeps(this, runConfiguredCommand),
      ...args,
    );
  }

  private workflowInputRepliesAfterWatermark(task: TaskDetail, marker: string): Array<{ createdAt?: string }> {
    return workflowInputRepliesAfterWatermarkImpl(task, marker);
  }

  private async resolveWorkflowInputMarkerForGraphNode(live: TaskDetail, nodeId: string): Promise<"clear" | "waiting" | "none"> {
    return resolveWorkflowInputMarkerForGraphNodeImpl(
      {
        ...this.storeRunContextDeps(),
      },
      live,
      nodeId,
    );
  }

  /**
   * Execute a single workflow step by spawning an agent with the step's prompt.
   * Returns structured outcome with support for revision requests.
   */
  private async executeWorkflowStep(
    ...args: FacadeRestArgs<typeof executeWorkflowStepImpl>
  ): Promise<WorkflowStepOutcome> {
    return executeWorkflowStepImpl(buildExecuteWorkflowStepDeps(this), ...args);
  }

  private async tryBootstrapMisbindingRecovery(
    ...args: FacadeRestArgs<typeof tryBootstrapMisbindingRecoveryImpl>
  ): Promise<boolean> {
    return tryBootstrapMisbindingRecoveryImpl(
      {
        ...facadeFields(this, ["rootDir", "store"]),
        ...facadeMethods(this, ["getRunContextFor", "markGraphExecuteSelfRequeued"]),
      },
      ...args,
    );
  }

  /*
  FNXC:CodeOrganization 2026-08-03-16:05:
  Thin facades over peeled branch-conflict reclaim/handle + missing session-start recovery (U4 Slice B).
  */
  private branchConflictHandleDeps() {
    return buildBranchConflictHandleDeps({
      rootDir: this.rootDir,
      store: this.store,
      onError: this.options.onError,
      ...facadeMethods(this, [
        "getRunContextFor", "findActiveWorktreeOwner", "normalizeReclaimableWorktreePath",
        "cleanupConflictingWorktree", "getAutoRecoveryDispatcher", "persistTokenUsage",
      ]),
    });
  }

  private async reclaimExistingWorktree(
    ...args: FacadeRestArgs<typeof reclaimExistingWorktreeImpl>
  ): Promise<void> {
    return reclaimExistingWorktreeImpl(this.branchConflictHandleDeps(), ...args);
  }

  private async handleBranchConflict(
    ...args: FacadeRestArgs<typeof handleBranchConflictImpl>
  ): Promise<"retry" | "reclaimed" | "sticky"> {
    return handleBranchConflictImpl(this.branchConflictHandleDeps(), ...args);
  }

  private async recoverMissingWorktreeSessionStartFailure(
    ...args: FacadeRestArgs<typeof recoverMissingWorktreeSessionStartFailureImpl>
  ): Promise<false | "requeue-todo" | "escalate-exhausted">  {
    return recoverMissingWorktreeSessionStartFailureImpl(buildRecoverMissingWorktreeSessionStartFailureDeps(this), ...args);
  }

  private async emitWorktreeReanchoredAudit(
    ...args: FacadeRestArgs<typeof emitWorktreeReanchoredAuditImpl>
  ): Promise<void> {
    return emitWorktreeReanchoredAuditImpl(this.storeRunContextDeps(), ...args);
  }

  listWorktreeHolders(): Array<{ taskId: string; worktreePath: string }> {
    // FNXC:Workspace 2026-06-21-12:00: KTD2 — flat-map each task's Set into one holder row per worktree path. A workspace task emits N rows; the FN-6782 reaper (self-healing.ts) and in-process-runtime adapter key purely off taskId (verified) and are idempotent across duplicate-task rows, so multi-row holders do not mis-count maxWorktrees slots.
    return listWorktreeHoldersImpl(this.activeWorktrees);
  }

  /*
  FNXC:CodeOrganization 2026-08-03-14:20:
  Thin TaskExecutor facades over peeled free helpers so vi.spyOn(executor, method)
  surfaces in executor-worktree tests keep working after U4 Slice B extraction.
  */
  private hasActiveWorktreeBinding(taskId: string, worktreePath: string): boolean {
    return hasActiveWorktreeBinding(this.activeWorktrees, taskId, worktreePath);
  }

  private async shouldGenerateNewWorktreeName(conflictPath: string, currentTaskId: string): Promise<boolean> {
    return shouldGenerateNewWorktreeName(this.activeWorktrees, this.store, conflictPath, currentTaskId);
  }

  private async findActiveWorktreeOwner(worktreePath: string, requestingTaskId: string): Promise<string | null> {
    return findActiveWorktreeOwner(this.activeWorktrees, this.store, worktreePath, requestingTaskId);
  }

  private async isLiveCleanupRefusal(worktreePath: string, taskId: string): Promise<boolean> {
    return isLiveCleanupRefusal(this.activeWorktrees, this.store, worktreePath, taskId);
  }

  private async cleanupStaleBranch(branch: string, taskId: string): Promise<boolean> {
    return cleanupStaleBranch(this.rootDir, this.store, branch, taskId);
  }

  private async planSquashImportFromDep(
    ...args: FacadeAfterSecond<typeof planSquashImportFromDep>
  ): Promise<ReturnType<typeof planSquashImportFromDep>> {
    return planSquashImportFromDep(this.rootDir, this.store, ...args);
  }

  private async reconcileSelfOwnedBeforeRemove(worktreePath: string, taskId: string): Promise<void> {
    return reconcileSelfOwnedBeforeRemove(
      this.store,
      worktreePath,
      taskId,
      (ownerTaskId, path) => this.hasActiveWorktreeBinding(ownerTaskId, path),
    );
  }

  /*
  FNXC:CodeOrganization 2026-08-03-14:50:
  Thin facades over peeled stale-lock / reclaim / remove-own helpers (U4 Slice B).
  */
  private staleLockRecoveryDeps() {
    return {
      ...facadeFields(this, ["rootDir", "store"]),
      ...facadeMethods(this, ["getRunContextFor"]),
    };
  }

  private async emitStaleLockAudit(
    ...args: FacadeRestArgs<typeof emitStaleLockAudit>
  ): Promise<void> {
    return emitStaleLockAudit(this.staleLockRecoveryDeps(), ...args);
  }

  private async recoverIndexLockIfStale(taskId: string, path: string, conflictInfo: { lockPath?: string; message?: string }): Promise<boolean> {
    return recoverIndexLockIfStale(this.staleLockRecoveryDeps(), taskId, path, conflictInfo);
  }

  private async recoverStaleRegistration(taskId: string, path: string, conflictInfo: { path?: string; message?: string }): Promise<boolean> {
    return recoverExecutorStaleRegistration(this.staleLockRecoveryDeps(), taskId, path, conflictInfo);
  }

  private async normalizeReclaimableWorktreePath(
    ...args: FacadeRestArgs<typeof normalizeReclaimableWorktreePath>
  ): Promise<string> {
    return normalizeReclaimableWorktreePath(
      {
        ...facadeFields(this, ["rootDir", "store"]),
        ...facadeMethods(this, ["hasActiveWorktreeBinding", "isLiveCleanupRefusal"]),
      },
      ...args,
    );
  }

  private async tryFreshWorktreeAfterLiveConflict(input: {
    conflictPath: string;
    branch: string;
    taskId: string;
    startPoint?: string;
    attemptNumber?: number;
    allowSiblingBranchRename: boolean;
    settings: Partial<Settings>;
  }): Promise<{ path: string; branch: string }> {
    return tryFreshWorktreeAfterLiveConflict(
      buildTryFreshWorktreeAfterLiveConflictDeps(this, bindTryCreateWorktree(this)),
      input,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:45: worktree create/conflict deps bag + binders (U4). */
  private worktreeCreateConflictDeps(): import("./executor/worktree-create-conflict.js").WorktreeCreateConflictDeps {
    return buildWorktreeCreateConflictFacadeDeps(
      this,
      MAX_WORKTREE_RETRIES,
      bindHandleWorktreeConflict(this),
      bindTryCreateWorktree(this),
    );
  }

  private async tryCreateWorktree(
    ...args: FacadeRestArgs<typeof tryCreateWorktreeImpl>
  ): Promise<{ path: string; branch: string }> {
    return tryCreateWorktreeImpl(this.worktreeCreateConflictDeps(), ...args);
  }

  private async handleWorktreeConflict(
    ...args: FacadeRestArgs<typeof handleWorktreeConflictImpl>
  ): Promise<{ path: string; branch: string } | null> {
    return handleWorktreeConflictImpl(this.worktreeCreateConflictDeps(), ...args);
  }

  private async cleanupConflictingWorktree(
    ...args: FacadeRestArgs<typeof cleanupConflictingWorktreeImpl>
  ): Promise<boolean>  {
    return cleanupConflictingWorktreeImpl(buildCleanupConflictingWorktreeDeps(this), ...args);
  }

  /*
  FNXC:CodeOrganization 2026-08-03-15:20:
  Thin facades over outer worktree create path (createWorktree loop, squash import,
  post-create remote rebase, start-point resolution). U4 Slice B.
  */
  private async resolveWorktreeStartPoint(startPoint: string, taskId: string): Promise<string | null> {
    return resolveWorktreeStartPointImpl(this.rootDir, this.store, startPoint, taskId);
  }

  private async squashImportDepIntoWorktree(
    ...args: FacadeAfterFirst<typeof squashImportDepIntoWorktreeImpl>
  ): Promise<void>  {
    return squashImportDepIntoWorktreeImpl(this.store, ...args);
  }

  private async rebaseNewWorktreeOntoRemote(
    ...args: FacadeAfterSecond<typeof rebaseNewWorktreeOntoRemoteImpl>
  ): Promise<void> {
    return rebaseNewWorktreeOntoRemoteImpl(this.rootDir, this.store, ...args);
  }

  private async createWorktree(
    ...args: FacadeRestArgs<typeof createWorktreeImpl>
  ): Promise<{ path: string; branch: string }> {
    return createWorktreeImpl(
      buildCreateWorktreeDeps(
        this,
        { maxWorktreeRetries: MAX_WORKTREE_RETRIES, worktreeRetryDelaysMs: [...WORKTREE_RETRY_DELAYS] },
        bindTryCreateWorktree(this),
      ),
      ...args,
    );
  }

  private async removeOwnWorktreeWithReconcile(input: {
    worktreePath: string;
    settings: Settings;
    taskId: string;
    reason: RemovalReason;
    audit?: Parameters<typeof removeWorktree>[0]["audit"];
  }): Promise<void> {
    return removeOwnWorktreeWithReconcile(
      {
        ...facadeFields(this, ["rootDir", "store"]),
        ...facadeMethods(this, ["reconcileSelfOwnedBeforeRemove", "hasActiveWorktreeBinding"]),
      },
      input,
    );
  }

  /** Remove only this executor's store-scoped lifecycle disposer registrations. */
  disposeStoreLifecycleDisposers(): void {
    disposeStoreLifecycleDisposersImpl({
      clearTaskMoveDisposer: () => { this.unregisterTaskMoveDisposer?.(); this.unregisterTaskMoveDisposer = undefined; },
      clearArchiveWorktreeDisposer: () => { this.unregisterArchiveWorktreeDisposer?.(); this.unregisterArchiveWorktreeDisposer = undefined; },
      clearArchiveWorkspaceWorktreeDisposer: () => { this.unregisterArchiveWorkspaceWorktreeDisposer?.(); this.unregisterArchiveWorkspaceWorktreeDisposer = undefined; },
    });
  }

  async cleanup(taskId: string): Promise<void> {
    return cleanupTaskWorktreeImpl(
      buildCleanupTaskWorktreeDeps(this),
      taskId,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: recoverApprovedSteps FNXC lives on recover-approved-steps-on-resume.ts. */
  private async recoverApprovedStepsOnResume(taskId: string): Promise<void> {
    return recoverApprovedStepsOnResumeImpl(this.store, taskId);
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: reconcileStepsFromGitHistory FNXC lives on reconcile-steps-from-git-history.ts. */
  private async reconcileStepsFromGitHistory(taskId: string, detail: TaskDetail, worktreePath: string): Promise<void> {
    return reconcileStepsFromGitHistoryImpl(
      {
        ...this.storeRunContextDeps(),
        resolveTaskStepSource: (ir) => this.resolveTaskStepSource(ir),
      },
      taskId,
      detail,
      worktreePath,
    );
  }

    /**
   * Check whether the task's branch has any unique commits compared to main.
   * If the branch has no unique commits and the task has steps marked done,
   * those steps represent lost uncommitted work — reset them to "pending"
   * so the next execution doesn't skip them.
   *
   * Called during stuck-kill cleanup when the worktree is about to be destroyed.
   */
  private async resetStepsIfWorkLost(task: Task): Promise<void> {
    return resetStepsIfWorkLostImpl(
      {
        rootDir: this.rootDir,
        resetLostWorkStepProgress: (t, count, reason) => this.resetLostWorkStepProgress(t, count, reason),
      },
      task,
    );
  }

  private async resetLostWorkStepProgress(task: Task, completedStepCount: number, reason: string): Promise<void> {
    return resetLostWorkStepProgressImpl({ store: this.store }, task, completedStepCount, reason);
  }

  markStuckAborted(taskId: string, shouldRequeue: boolean = true): void {
    return markStuckAbortedImpl(
      buildMarkStuckAbortedDeps(this),
      taskId,
      shouldRequeue,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:40: handleLoopDetected FNXC lives on handle-loop-detected.ts. */
  async handleLoopDetected(event: StuckTaskEvent): Promise<boolean> {
    return handleLoopDetectedImpl(
      buildHandleLoopDetectedDeps(this),
      event,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:30: getWorktreePath KTD2 contract FNXC lives on active-worktrees helpers / free peel. */
  getWorktreePath(taskId: string): string | undefined {
    return getWorktreePathImpl(
      this.workspaceConfig,
      (id) => this.getActiveWorktreePaths(id),
      taskId,
    );
  }

  // ── Agent Spawning ─────────────────────────────────────────────────────

  /**
   * Terminate all child agents spawned by a parent task.
   * Called from the finally block of agentWork when the parent session ends.
   */
  private async terminateAllChildren(parentTaskId: string): Promise<void> {
    return terminateAllChildrenImpl(
      {
        ...facadeFields(this, ["spawnedAgents"]),
        ...facadeMethods(this, ["terminateChildAgent"]),
      },
      parentTaskId,
    );
  }

  /**
   * Terminate a single child agent by ID.
   * Disposes the session, updates AgentStore state, and cleans up tracking Maps.
   */
  private async terminateChildAgent(childId: string): Promise<void> {
    return terminateChildAgentImpl(
      buildTerminateChildAgentDeps(this),
      childId,
    );
  }

  /**
   * Run a spawned child agent's task to completion.
   * Handles state transitions and cleanup.
   */
  private async runSpawnedChild(
    ...args: FacadeRestArgs<typeof runSpawnedChildImpl>
  ): Promise<void>  {
    return runSpawnedChildImpl(buildRunSpawnedChildDeps(this), ...args);
  }

  private createSpawnAgentTool(
    ...args: FacadeRestArgs<typeof createSpawnAgentToolImpl>
  ): ToolDefinition {
    // FNXC:CodeOrganization 2026-08-03-12:35: get/set totalSpawnedCount so capacity tests that mutate priv.totalSpawnedCount still drive the free-fn path.
    return createSpawnAgentToolImpl(buildCreateSpawnAgentToolDeps(this), ...args);
  }

}

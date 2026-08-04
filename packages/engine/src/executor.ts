// port-4040-allowlist: this file embeds the "never kill port 4040" rule in the executor prompt.
import { type TaskStore, type Task, type TaskDetail, type TaskTokenUsage, type Settings, type WorkflowStep, type RunMutationContext, type Agent, type MergeResult, type WorkflowIrNode, type WorkflowStepResult as CoreWorkflowStepResult, type ThinkingLevel } from "@fusion/core";
import type { ImplementationExit, ImplementationExitReporter } from "./executor/implementation-exit.js";
import { AgentStore } from "@fusion/core";
import { resolvePlannerLanes } from "./execution/replan-target.js";
import type { WorkflowIr, WorkflowFieldDefinition, WorkflowColumnAgent, TaskMoveLanes } from "@fusion/core";
import { type WorkflowGraphTaskRunResult, type WorkflowColumnBoundaryHooks } from "./workflows/workflow-graph-task-runner.js";
import type { ParseStepsHandlerDeps, CodeNodeRunner } from "./workflows/workflow-node-handlers.js";
import type { WorkflowBranchPersistence } from "./workflows/workflow-graph-branches.js";
import type {
  WorkflowStepInstancePersistence,
} from "./workflows/workflow-graph-foreach.js";
import {

  type ForeachActiveContext,
  type WorkflowLegacySeams,
} from "./workflows/workflow-node-handlers.js";
import type { WorkflowNodePreparationRequirement, WorkflowNodeResult } from "./workflows/workflow-graph-executor.js";
import type {
  PreparedWorktree,
  WorkflowRuntimePrimitives,
} from "./execution/runtime-primitives.js";
import { createWorkflowRuntimePrimitiveProvider } from "./workflows/workflow-runtime-primitive-provider.js";
import { type ApprovalRequestStore, type WorkspaceConfig, type RunCommandResult } from "@fusion/core";
import { type VerificationResult } from "./execution/verification-utils.js";
import type { ReviewVerdict, ReviewResult } from "./execution/reviewer.js";
import { ModelRegistry, type ToolDefinition, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  dropPreHeldExecutorSlot,
} from "./concurrency/concurrency.js";
// FNXC:Workspace 2026-06-21-15:00: F5/F8 — wire in the previously dead workspace-path helpers.
// `normalizeRepoRelPath` is the single shared scope-path normalizer (F8); `deriveRepoScopeSubset`
// maps the task's repo-prefixed declared File Scope to a repo-LOCAL subset so the per-repo scope-leak
// filter reuses the SAME always-allowed/scope-match surface as the non-workspace path (F5). One-way
// executor→workspace-paths edge (workspace-paths imports nothing).
import { RemovalReason, removeWorktree } from "./worktree/worktree-pool.js";
import {
  activeSessionRegistry,
  type ActiveSessionKind,
} from "./agents/active-session-registry.js";
// CLI Agent Executor (U7): task ↔ CLI session orchestration seam.
import {
  CliTaskSession,
} from "./cli-agent/task-session.js";
import { BranchConflictError, BranchCrossContaminationError } from "./execution/branch-conflicts.js";

import { TokenCapDetector } from "./errors/token-cap-detector.js";
import type { StuckTaskDetector, StuckTaskEvent } from "./healing/stuck-task-detector.js";
import { StepSessionExecutor } from "./execution/step-session-executor.js";
import {
  type RunTaskStepResult,
} from "./execution/step-runner.js";
// FNXC:MergerUnification 2026-06-21-19:05: the foundation branch imported `acquireWorkspaceRepoWorktree` here but never used it in executor.ts (the agent tool wraps it via agent-tools.ts), which fails lint on the inherited base. Removed until master-plan U1 re-adds it together with its per-repo acquisition usage.

import { createRunAuditor, type RunAuditor } from "./util/run-audit.js";
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
  isTaskWorkComplete, evaluateTaskDoneRefusal,
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
} from "./executor/deps-bags.js";
import { facadeFields, facadeMethods } from "./executor/facade-methods.js";
import { bindHandleWorktreeConflict, bindTryCreateWorktree } from "./executor/worktree-create-binders.js";
import { wireExecutorLifecycle } from "./executor/wire-executor-lifecycle.js";

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
  GraphCompletionCallback,
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
  /**
   * FNXC:AgentReflection 2026-07-04-00:00:
   * FN-7528: taskIds for which a non-LLM post-task performance capture has already been fired via
   * `signalTaskComplete`. `onComplete` fires from several completion call sites (fresh completion,
   * duplicate in-review re-entry, auto-recovery, paused-after-completion finalize, retry-completed),
   * so this in-memory guard keeps capture to once per completion instead of once per call site.
   */
  private capturedReflectionTaskIds = new Set<string>();
  /** Tracks tasks whose workflow-rerun bounce is in flight (todo→in-progress).
   *  Prevents the task:moved handler from dispatching execute() before the
   *  bounce finishes its own dispatch. */
  private workflowRerunPending = new Set<string>();
  /**
   * Task ids whose current `task:moved` event is being emitted by this
   * executor's workflow lifecycle handling (column boundaries or Plan Review
   * replans). The store emits synchronously, so this narrowly distinguishes a
   * graph's own transition from an external engine/user move that must still
   * hard-cancel the active run.
   */
  private workflowLifecycleMovesInFlight = new Set<string>();
  /** FN-5256: in-flight session-disposal promises keyed by taskId. The
   *  task:moved (away from in-progress) and task:deleted listeners populate
   *  this so a fast re-dispatch (task:moved → in-progress) awaits the prior
   *  session being fully reaped before creating/acquiring a new worktree. */
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
  /** Column-agent principal alignment (plan U5, R6): the EFFECTIVE column-agent id
   *  currently running each executing task's coding/step session, when an
   *  override/defer binding governs the in-flight seam. Keyed by task id, populated
   *  by the execute / step-execute seam right after `resolveSeamColumnAgent` yields a
   *  column agent, and cleared alongside the session (deleteActiveSession /
   *  deleteActiveStepExecutor). Powers `isAgentEffectivelyExecuting`, the
   *  reverse-direction heartbeat-scheduler guard that must know an agent is running a
   *  task it is not `assignedAgentId` on. Empty for the legacy/no-binding path, so
   *  that path is byte-identical. */
  private effectiveColumnAgentByTask = new Map<string, string>();
  /** Active pre-merge workflow step sessions per task. */
  private activeWorkflowStepSessions = new Map<string, AgentSession>();
  /**
   * FNXC:TaskTiming 2026-07-30-21:40:
   * Only graph-owned Plan Review sessions appear here. Self-healing uses this
   * narrow liveness proof so it never finalizes an in-flight planning segment.
   */
  private activePlanningWorkflowSessions = new Set<string>();
  /** Steering comments already observed for active workflow step sessions. */
  private activeWorkflowStepSessionSeenSteeringIds = new Map<string, Set<string>>();
  /** Active configured-command abort controllers keyed by task. */
  private activeConfiguredCommandControllers = new Map<string, Set<AbortController>>();
  /** Lazily-created root-project reader used only when an execution lookup is handed an agents-less worktree store. */
  private authoritativeAssignedAgentStore: AgentStore | null = null;
  /** Active workflow-graph runner abort controllers keyed by task. */
  private activeWorkflowGraphAbortControllers = new Map<string, AbortController>();
  /**
   * Active CLI agent task sessions per task (U7). Mirrors activeSessions for the
   * cli-agent executor kind so the hard-cancel / abort path can SIGKILL the PTY
   * and mark `killed` (never resume-eligible), and the in-review handoff can reap
   * the PTY. A task has at most one live CLI session at a time.
   */
  private activeCliTaskSessions = new Map<string, CliTaskSession>();
  private readonlyWorkflowStepAuditDone = false;
  /**
   * Reviewer subagent sessions per task. Reviewers (`reviewer.ts`) create their
   * own AgentSessions that aren't part of `activeSessions`/`activeStepExecutors`,
   * so without this map they survive when the parent task is stopped — they
   * keep producing log entries and step transitions after the user thinks they
   * killed the task. Disposed alongside the main session in the move-out,
   * pause, and global-pause handlers below.
   */
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
    safeLogEntryImpl(
      {
        ...this.storeRunContextDeps(),
      },
      taskId,
      message,
    );
  }

  private markPausedAborted(
    taskId: string,
    provenance: PausedAbortProvenance = "hard-cancel",
    source = "unspecified",
  ): void {
    markPausedAbortedImpl(
      {
        pausedAborted: this.pausedAborted,
        pausedAbortProvenance: this.pausedAbortProvenance,
        safeLogEntry: (id, message) => this.safeLogEntry(id, message),
      },
      taskId,
      provenance,
      source,
    );
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
    taskId: string,
    agentId: string,
    leaseEpoch: number,
    nodeId: string,
    runId: string | undefined,
  ): Promise<void> {
    return renewTaskLeaseImpl(
      buildRenewTaskLeaseDeps(this),
      taskId,
      agentId,
      leaseEpoch,
      nodeId,
      runId,
    );
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
    taskId: string,
    context: string,
  ): Promise<boolean> {
    return shouldDeferCompletionForGlobalPauseImpl(
      {
        ...facadeFields(this, ["store"]),
        ...facadeMethods(this, ["getRunContextFor", "clearCompletedTaskWatchdog"]),
      },
      taskId,
      context,
    );
  }

  private async shouldDeferWorkflowStepCompletion(
    taskId: string,
    context: string,
  ): Promise<boolean> {
    return shouldDeferWorkflowStepCompletionImpl(
      buildShouldDeferWorkflowStepCompletionDeps(this),
      taskId,
      context,
    );
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

  /**
   * Stable handoff reasons used on task:handoff audit events.
   * Keep values greppable for executor/self-healing forensics: review-handoff-requested,
   * completed-task-recovered, step-session-completed, paused-after-completion,
   * fn_task_done, fn_task_done-retry-completed.
   *
   * FNXC:WorkflowLifecycle 2026-06-29-11:20:
   * Failed execution is not a review handoff. Error paths must either requeue
   * executable work for resume or fail in-place; `in-review` is reserved for
   * clean completion handoffs.
   */
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

  /*
  FNXC:ReviewArtifacts 2026-07-19-10:00:
  A successful executor handoff may offer reviewers a short local feature-video, but
  capture is strictly best-effort. Bound and swallow this optional work before the
  review transition so browser, scenario, and artifact failures never delay or fail it.
  */
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

  /**
   * Abort the in-flight bash subprocess (if any) on every active agent session.
   *
   * Invoked at runtime shutdown so detached subprocess trees spawned by agent
   * bash tools — including grandchildren like vitest workers — are killed via
   * pi-coding-agent's killProcessTree. Without this, when the worker is killed
   * those process groups are orphaned because they're detached.
   *
   * Sessions are not disposed here so any near-complete agent loop still has a
   * chance to wrap up during the runtime's graceful drain window.
   */

  /**
   * Register a subagent session (e.g. reviewer) under its parent task ID so it
   * can be disposed when the parent stops. Used as the `onSessionCreated`
   * callback passed to `reviewStep`.
   */
  private registerSubagentSession(taskId: string, session: AgentSession): void {
    registerSubagentSessionImpl(this.activeSubagentSessions, taskId, session);
  }

  /**
   * Deregister a subagent session that has finished naturally. The reviewer's
   * own `finally` block disposes the session — this just removes it from the
   * map.
   */
  private unregisterSubagentSession(taskId: string, session: AgentSession): void {
    unregisterSubagentSessionImpl(this.activeSubagentSessions, taskId, session);
  }

  /**
   * Dispose all subagent sessions for a task and remove them from the map.
   * Called by the kill paths (move-out-of-in-progress, pause, global pause)
   * so subagents stop alongside the main session.
   */
  private disposeSubagentsForTask(taskId: string, reason: string): void {
    disposeSubagentsForTaskImpl(this.activeSubagentSessions, taskId, reason);
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:59 — `isPlannerColumnFor` DELETED, and the deletion is
  the whole fix for its two guards.

  It was a private method with ZERO production callers. `tsc` reported it unused
  ("'isPlannerColumnFor' is declared but its value is never read"); the only things reaching it were
  two tests going through `executor as unknown as { isPlannerColumnFor: … }`, which is why nothing
  noticed. Its doc comment described the planning-evacuation branch of the `task:moved` handler — but
  that branch calls `isBackwardMoveOutOfPlanning` below, never this.

  So its two sync-resolved lane reads were counted as inert conversions in code that cannot run.
  Converting them would have "fixed" a guard with no behaviour behind it and produced two more sites
  to maintain; deleting is the honest reduction. The tests that only exercised it went with it — a
  test whose subject has no caller pins nothing.
  */

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

  /**
   * FN-5256: register an in-flight disposal so a subsequent dispatch (task:moved
   * → in-progress) can await it before acquiring/creating a worktree. Swallows
   * errors so a failed disposal doesn't poison the map; surfaces them via the
   * executor log instead.
   */
  private trackTaskDisposal(taskId: string, disposal: Promise<void>): void {
    trackTaskDisposalImpl({ pendingTaskDisposals: this.pendingTaskDisposals }, taskId, disposal);
  }

  /**
   * FN-5256: synchronously await session disposal so callers (e.g. pause-before-park)
   * can rely on the worktree-bound shells being reaped before they return. Mirrors
   * `abortInFlightTaskWork`, but awaits the async `abort()` / `terminateAllSessions()`
   * calls instead of fire-and-forget.
   */
  /*
  FNXC:CodeOrganization 2026-08-04-02:10:
  Thin facades over awaitAbortInFlight / abortAllInFlight (U4). Shared field/method bags
  replace hand-written this-bindings so hard-cancel deps stay one compact block.
  */
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

  /**
   * @param store — Task store instance (also used to listen for events)
   * @param rootDir — Project root directory
   * @param options — Executor configuration
   *
   * Listens for `task:moved` to auto-execute tasks moved to `in-progress`,
   * `task:updated` to terminate agent sessions when individual tasks are paused,
   * and `settings:updated` to terminate **all** active agent sessions when
   * `globalPause` transitions from `false` to `true`. `enginePaused` only
   * prevents new work dispatch — running sessions continue to completion.
   * Paused tasks are moved back to `todo` rather than marked as `failed`.
   */
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

  /**
   * FNXC:PlannerOversight 2026-07-13-23:05:
   * Wire session-advisor live log flush after ProjectEngine starts (options are
   * captured at TaskExecutor construction time; this setter updates the callback).
   */
  setOnExecutorLogFlushed(cb: TaskExecutorOptions["onExecutorLogFlushed"]): void {
    this.options = { ...this.options, onExecutorLogFlushed: cb };
  }

  constructor(
    private store: TaskStore,
    private rootDir: string,
    private options: TaskExecutorOptions = {},
  ) {
    /*
    FNXC:CodeOrganization 2026-08-03-22:40:
    Constructor lifecycle wiring lives in wire-executor-lifecycle.ts (U4 peel).
    */
    const wired = wireExecutorLifecycle({
      store: this.store,
      rootDir: this.rootDir,
      options: this.options,
      ...facadeFields(this, [
        "activeConfiguredCommandControllers", "activeSessions", "activeStepExecutorSeenSteeringIds",
        "activeStepExecutors", "activeSubagentSessions", "activeWorkflowGraphAbortControllers",
        "activeWorkflowStepSessionSeenSteeringIds", "activeWorkflowStepSessions",
        "approvalResumeAfterUnwind", "approvalSuspended", "effectiveColumnAgentByTask", "executing",
        "graphColumnAgentResolver", "graphRouting", "graphSeamGoverningNodeId", "loopRecoveryState",
        "pendingTaskDisposals", "recoveringCompleted", "spawnedAgents", "stuckAborted",
        "userCanceledTaskIds", "workflowLifecycleMovesInFlight",
      ]),
      ...facadeMethods(this, [
        "awaitAbortInFlightTaskWork", "clearWorkflowRerunWatchdog", "deleteActiveWorkflowStepSession",
        "dispatchUnpauseResume", "disposeSubagentsForTask", "execute", "executeReviewHandoff",
        "getAssignedAgentRuntimeConfig", "getModelRegistry", "getRunContextFor",
        "isBackwardMoveOutOfPlanning", "markPausedAborted", "releasePreExecutionWorktree",
        "removeOwnWorktreeWithReconcile", "resetMergeStateIfNeeded", "resolveResumeLanes",
        "terminateAllChildren", "trackTaskDisposal",
      ]),
    });
    this.unregisterTaskMoveDisposer = wired.unregisterTaskMoveDisposer;
    this.unregisterArchiveWorktreeDisposer = wired.unregisterArchiveWorktreeDisposer;
    this.unregisterArchiveWorkspaceWorktreeDisposer = wired.unregisterArchiveWorkspaceWorktreeDisposer;
  }

  /*
  FNXC:CodeOrganization 2026-08-04-02:25:
  Shared store + getRunContextFor deps bag for free-fn facades (U4). Most peeled
  lifecycle helpers need exactly these two; one helper keeps call sites one-liners.
  */
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
    task: Task,
    logMessage: string,
    options?: { preserveVerificationFailureCount?: boolean },
  ): Promise<Task> {
    return cleanupMergeStateForReverificationImpl(
      {
        ...this.storeRunContextDeps(),
        reopenLastStepForRevision: (id, t) => this.reopenLastStepForRevision(id, t),
      },
      task,
      logMessage,
      options,
    );
  }

  private async clearResumeFailureState(task: Task): Promise<void> {
    return clearResumeFailureStateImpl({ store: this.store }, task);
  }

  private clearCompletedTaskWatchdog(taskId: string): void {
    clearCompletedTaskWatchdogImpl(this.completedTaskWatchdogs, taskId);
  }

  /**
   * FNXC:AgentReflection 2026-07-04-00:00:
   * FN-7528: single seam for every `onComplete` call site. Fires the deterministic, non-LLM
   * post-task performance capture (best-effort, fire-and-forget — a capture failure must never
   * block or fail task completion) before forwarding to the configured `onComplete` callback.
   * Capture is completion-gated: only runs once per taskId (see `capturedReflectionTaskIds`),
   * guarded by `reflectionService` presence, `settings.reflectionEnabled`, and an assigned agent id
   * mirroring the existing in-session reflection-tool guard.
   */
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

  /**
   * Result of a workflow-rerun bounce attempt.
   *
   * - `bounced` — the move sequence completed successfully and the task is
   *   back in `in-progress` ready for re-execution.
   * - `skipped-pending` — another bounce for the same task is mid-flight;
   *   this attempt is a no-op. Callers (notably the watchdog) must NOT log
   *   this as a successful retry, since the original bounce may itself be
   *   stuck.
   */
  /*
  FNXC:ReviewLeniency 2026-07-02-02:10:
  Clear prior terminal failure results (failed/advisory_failure — incl. optional gate nodes like code-review) so a retry starts clean. Call this ONLY once the task has left the mergeable in-review column (i.e. it is in `todo`): clearing while still in-review drops the merge blocker during the rerun-bounce window and could let a concurrent auto-merge sweep merge an empty-`steps` graph-native task with its gate failure unaddressed. `moveTask(in-review→todo)` already clears ALL results (applyReopenFieldClears), so this is chiefly for the in-progress→todo bounce path where the move does not. Passed/skipped/pending evidence is kept.
  */
  private async clearTerminalStepFailuresForRetry(taskId: string): Promise<void> {
    return clearTerminalStepFailuresForRetryImpl(
      {
        ...this.storeRunContextDeps(),
      },
      taskId,
    );
  }

  private async performWorkflowRerunBounce(
    taskId: string,
    worktreePath: string,
    preserveResumeState: boolean = true,
  ): Promise<"bounced" | "skipped-pending" | "deferred-paused"> {
    return performWorkflowRerunBounceImpl(
      buildPerformWorkflowRerunBounceDeps(this),
      taskId,
      worktreePath,
      preserveResumeState,
    );
  }

  private scheduleWorkflowRerun(
    taskId: string,
    worktreePath: string,
    successMessage: string,
    preserveResumeState: boolean = true,
  ): void {
    scheduleWorkflowRerunImpl(
      buildScheduleWorkflowRerunDeps(this, WORKFLOW_RERUN_WATCHDOG_MS),
      taskId,
      worktreePath,
      successMessage,
      preserveResumeState,
    );
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
  ): ReturnType<typeof accumulateTokenUsageImpl> {
    return accumulateTokenUsageImpl(...args);
  }

  private tokenUsageWithModelSnapshot(
    ...args: Parameters<typeof tokenUsageWithModelSnapshotImpl>
  ): ReturnType<typeof tokenUsageWithModelSnapshotImpl> {
    return tokenUsageWithModelSnapshotImpl(...args);
  }

  private async extractSessionTokenUsage(
    ...args: Parameters<typeof extractSessionTokenUsageImpl>
  ): ReturnType<typeof extractSessionTokenUsageImpl> {
    return extractSessionTokenUsageImpl(...args);
  }

  /**
   * Execute a review handoff: move the task to in-review column with
   * awaiting-user-review status, assign the requesting user, and dispose
   * the agent session.
   */
  private async executeReviewHandoff(
    task: Task,
    _session: AgentSession,
    _sessionEntry: { session: AgentSession; seenSteeringIds: Set<string>; lastResolvedModelProvider?: string; lastResolvedModelId?: string; lastTaskModelProvider?: string | null; lastTaskModelId?: string | null; lastAssignedAgentId?: string | null },
  ): Promise<void> {
    return executeReviewHandoffImpl(
      buildExecuteReviewHandoffDeps(this),
      task,
      _session,
      _sessionEntry,
    );
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
    taskId: string,
    capLabel: string,
    currentCount: number,
    feedback: string,
  ): Promise<void> {
    return parkPlanReviewReplanCapExhaustedImpl(
      {
        ...this.storeRunContextDeps(),
      },
      taskId,
      capLabel,
      currentCount,
      feedback,
    );
  }

  private async requestPreMergeOptionalStepFix(
    taskId: string,
    fallbackTask: Task,
    info: {
      stepName: string;
      feedback: string;
      phase: CoreWorkflowStepResult["phase"];
      status: CoreWorkflowStepResult["status"];
      verdict?: string;
      /** Raw graph node result when no reviewer verdict was produced. */
      failureValue?: string;
      nodeId?: string;
      maxRevisions?: unknown;
    },
  ): Promise<boolean> {
    return requestPreMergeOptionalStepFixImpl(
      buildRequestPreMergeOptionalStepFixDeps(this),
      taskId,
      fallbackTask,
      info,
    );
  }

  private async recoverMissingRequiredArtifacts(
    task: Task,
    artifactKeys: string[],
    source: { source: "graph-entry" | "workflow-step"; nodeId?: string },
  ): Promise<void> {
    return recoverMissingRequiredArtifactsImpl(
      buildRecoverMissingRequiredArtifactsDeps(this),
      task,
      artifactKeys,
      source,
    );
  }

  private async isRequiredArtifactRecoveryProtected(task: Task): Promise<boolean> {
    return isRequiredArtifactRecoveryProtectedImpl(
      this.store,
      (taskId: string) => this.resolveResumeLanes(taskId),
      task,
    );
  }

  /**
   * Auto-revive an `in-review` task whose pre-merge workflow step(s) failed, by
   * replaying the same send-back-for-fix flow the executor uses during a live
   * run. Invoked by SelfHealingManager's `recoverReviewTasksWithFailedPreMergeSteps`
   * scan when a task is parked in review with a failed pre-merge step and no
   * active session.
   *
   * Picks the latest failed pre-merge workflow step result (there is usually only
   * one, but if several ran we want the most recent), injects its feedback into
   * `PROMPT.md`, resets steps, and schedules todo → in-progress. The caller may
   * account for a scheduled retry, but this method independently enforces the
   * effective finite-or-unlimited revision budget before it can reopen work.
   *
   * @returns true when the task was sent back, false when no eligible failed
   *          step exists (caller should skip).
   */
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

  /** Column-agent principal alignment (plan U5, R6). True when the EFFECTIVE agent
   *  governing `task`'s execute or step-execute seam — resolved through the shared
   *  core resolver against the task's workflow IR — is `agentId`. Used by the
   *  `resumeTaskForAgent` second pass to re-dispatch column-bound tasks the
   *  `assignedAgentId` filter misses. Best-effort: an unresolvable IR yields false. */
  private async taskEffectiveAgentMatches(task: Task, agentId: string): Promise<boolean> {
    return taskEffectiveAgentMatchesImpl(this.store, task, agentId);
  }

  /**
   * Resume orphaned in-progress tasks (e.g., after crash/restart).
   * Call once after engine startup.
   *
   * Tasks that are already complete (all steps done/skipped) are fast-pathed
   * directly to in-review without spawning a new agent session.
   */
  async resumeOrphaned(): Promise<void> {
    return resumeOrphanedImpl({
      ...facadeFields(this, [
        "store", "executing", "recoveringCompleted",
      ]),
      processWideGraphRouting: TaskExecutor.processWideGraphRouting,
      ...facadeMethods(this, [
        "listWipLaneTasks", "clearResumeFailureState", "recoverApprovedStepsOnResume",
        "recoverCompletedTask", "execute",
      ]),
    });
  }

  /**
   * Execute a task in an isolated git worktree.
   *
   * Worktree acquisition flow:
   * 1. If the worktree already exists on disk (resume after crash), reuse it.
   * 2. If a {@link WorktreePool} is provided and `recycleWorktrees` is enabled,
   *    attempt to acquire a warm worktree from the pool. Pooled worktrees skip
   *    the `worktreeInitCommand` since their build caches are already warm.
   * 3. Otherwise, create a fresh worktree via `git worktree add` and run the
   *    `worktreeInitCommand` if configured.
   */

  /**
   * Resolve custom instructions for a given agent role by looking up agents
   * in the AgentStore that have instructions configured.
   * Returns an empty string if no instructions are found.
   */
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

  /**
   * Execute a task in an isolated git worktree.
   *
   * **Worktree assignment:** New worktrees get humanized random names
   * (e.g., `.worktrees/swift-falcon/`) via `generateWorktreeName()` rather
   * than being named after the task ID. This decouples directory names from
   * tasks, enabling worktree reuse across dependency chains. When resuming
   * a task that already has `task.worktree` set, the existing path is used
   * as-is. Branches remain task-scoped (`fusion/{task-id}`).
   */
  // ── Workflow graph interpreter (cutover M-B/M-C) ─────────────────────────
  //
  // The workflow graph runner owns lifecycle SEQUENCING for every task:
  // custom prompt/script/gate nodes run via the WorkflowStep machinery, and the
  // planning/execute/review/merge seam nodes delegate to the engine primitives.
  // Interpreter-level failure parks the task as a workflow failure rather than
  // falling through to a second runtime path.

  /* FNXC:CodeOrganization 2026-08-04-03:20: graphCompletion U5d/U5e FNXC lives on task-executor-options.ts. */
  /** Per graph-run agent-log boundary; passed to failure handling rather than trusting stale task snapshots. */
  private graphToolFailureRunCursors = new Map<string, number>();

  /** Step-inversion (KTD-2/KTD-8, U6/U8): graph-owned step-execute can pin
   *  step-session physics for workflows that need a hard per-step boundary
   *  before step-review. Default final-review coding does not pin here and
   *  therefore respects `runStepsInNewSessions` (reuse one session when false,
   *  fresh per-step sessions when true). Cleared when the graph run ends
   *  (executeWorkflowGraph finally). */
  private graphStepSessionPinned = new Set<string>();

  /** Step-inversion (U6/U8): caches the per-run implementation-phase result for a
   *  graph-owned task so the foreach sub-walk's per-step `runTaskStep` driver runs
   *  the (step-session) implementation exactly once per run and lets later step
   *  instances observe the projection rather than re-running execute() per step.
   *  Keyed by task id; cleared alongside the pin. */
  private graphStepRunOnce = new Map<string, Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }>>();

  /** Step-inversion (KTD-4): the foreach instance the step-execute seam is
   *  currently driving for a graph-owned task, so `runGraphTaskStep` can honor
   *  `deferDoneToReview` when deciding whether a non-terminal step is a success
   *  (review will author done) or a failure (implementation left it incomplete).
   *  Stamped by the stepExecute seam around the runTaskStep call; cleared with the
   *  per-run pins. Keyed by `${task.id}:${instanceId}` so parallel foreach
   *  instances of the same task cannot clobber each other's active context
   *  (the read path threads the same instanceId through `runGraphTaskStep`). */
  private graphStepActiveContext = new Map<string, ForeachActiveContext>();

  /**
   * FNXC:ProactiveChatStatus 2026-07-16-12:30:
   * Keep a graph RETHINK summary until its rework reset succeeds. The status wording says the step
   * was rolled back, so it must not reach the task chat before resetStepToBaseline completes.
   */
  private graphRethinkNarrations = new Map<string, string>();

  /** Column-agent seam wiring (column-agent plan U4, R2/R3/R4). Per-run binding
   *  resolver keyed by task id: maps a governing node id to its column-agent
   *  binding (if any), computed once per run in executeWorkflowGraph from the
   *  resolved IR. The execute / step-execute seams consume it to decide whether the
   *  coding/step session runs as a column agent. Cleared in the run's finally. */
  private graphColumnAgentResolver = new Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>();

  /** (U3) Task ids whose current graph run is genuinely unattended (LFG /
   *  pipeline / disable-model-invocation — no human will ever answer). Set only
   *  by an explicit `unattended` workflow-run option; default-absent means a
   *  board run. runGraphCustomNode reads this to set FUSION_HEADLESS on skill
   *  steps. Cleared in executeWorkflowGraph's finally alongside the resolver. */
  private graphUnattendedRuns = new Set<string>();

  /** Column-agent seam wiring (column-agent plan U4). The governing graph node id
   *  for the implementation pass currently in flight for a task — the execute-seam
   *  prompt node's id (execute seam), or the foreach instance node id (step-execute
   *  seam, which the core resolver maps through template inheritance). Stamped by
   *  the seam from the reserved {@link SEAM_GOVERNING_NODE_CONTEXT_KEY} context key
   *  right before it drives the implementation phase, read inside execute()'s
   *  session build, and cleared by the seam afterward. Keyed by task id. */
  private graphSeamGoverningNodeId = new Map<string, string>();

  /**
   * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
   * Execute and step-execute seam nodes can pin reasoning effort for the implementation session; keep it per graph run so session creation applies node/step > task > settings precedence.
   */
  private graphSeamThinkingLevel = new Map<string, ThinkingLevel>();

  /**
   * FNXC:WorkflowStepSkills 2026-07-22-00:00:
   * FN-8490 pins the canonical `config.executor: "skill"` + trimmed
   * `config.skillName` request only for the pass-initiating foreach instance.
   * The implementation pass is shared across instances, so this template-constant
   * value must settle with the same lifecycle as governing-node and thinking pins.
   */
  private graphSeamSkillName = new Map<string, string>();

  /** Tasks currently being orchestrated by the graph runner. Process-wide for
   *  the same reason as executingTaskLock (FN-4811): duplicate execute()
   *  invocations can arrive from different TaskExecutor instances in one
   *  process (engine restart race, hybrid runtimes), and the graph runner does
   *  not hold the executing-task lock between seams. */
  private get graphRouting(): Set<string> {
    return TaskExecutor.processWideGraphRouting;
  }

  private static processWideGraphRouting = new Set<string>();

  /** Wired by the runtime to ProjectEngine.onMerge — resolves with the merge outcome. */
  private mergeRequester?: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>;

  setMergeRequester(requestMerge: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>): void {
    this.mergeRequester = requestMerge;
  }

  /**
   * Route a task through the workflow graph interpreter when eligible.
   * Returns true when the graph owned the task to a terminal disposition
   * (completed or failed); false when the legacy pipeline should run.
   */
  private async executeWorkflowGraph(task: Task, opts?: { alreadyClaimed?: boolean }): Promise<void> {
    return executeWorkflowGraphImpl(buildExecuteWorkflowGraphDeps(this), task, opts);
  }

  private buildBranchPersistence(): WorkflowBranchPersistence | undefined {
    return buildBranchPersistenceImpl({ store: this.store });
  }

  /**
   * Build the store-backed WorkflowStepInstancePersistence for graph-owned
   * foreach runs (KTD-6, U3/U4 seam). Returns undefined when the store predates
   * the instance CRUD methods (the SQLite migration is U4) so the sub-walk stays
   * fully in-memory — purely additive, same posture as buildBranchPersistence.
   */
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

  /**
   * Resolve which artifact/parser governs a graph-owned task's step list from its
   * workflow's `parse-steps` declaration (KTD-12). Returns undefined for legacy
   * tasks (no parse-steps node) so reconcile/resume keep their unchanged behavior.
   * Used by reconcile read-through to know which artifact backs the step source.
   */
  private resolveTaskStepSource(ir: WorkflowIr | undefined): { artifact: string; parser: string } | undefined {
    return resolveTaskStepSourceImpl(ir);
  }

  /**
   * Resolve the custom field definitions declared by a task's selected workflow
   * (KTD-13) so the executor prompt can surface the schema and current values to
   * the agent. Pure read; degrades to undefined on any resolution failure (no
   * selection, missing/corrupt definition, older store) so prompt-building never
   * throws and legacy tasks see no custom-fields section.
   */
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

  /**
   * Build the code node runner (KTD-15, U14): worktree cwd resolution, pre-read of
   * declared artifacts into the harness ctx, and customFields writes through the
   * U11 validation authority. Drives the esbuild-compile + child-process runner
   * in code-node-runner.ts.
   */
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
    task: Task,
    stepIndex: number,
    instanceId?: string,
    governingNodeId?: string,
    thinkingLevel?: ThinkingLevel,
    skillName?: string,
  ): Promise<{ success: boolean; error?: string; exit?: ImplementationExit }> {
    return runGraphTaskStepImpl(
      buildRunGraphTaskStepDeps(this),
      task,
      stepIndex,
      instanceId,
      governingNodeId,
      thinkingLevel,
      skillName,
    );
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
    task: Task,
    live: TaskDetail,
    stepIndex: number,
    active: ForeachActiveContext,
    governingNodeId?: string,
    thinkingLevel?: ThinkingLevel,
    skillName?: string,
  ): Promise<RunTaskStepResult> {
    return runProjectedGraphTaskStepImpl(
      buildRunProjectedGraphTaskStepDeps(this),
      task,
      live,
      stepIndex,
      active,
      governingNodeId,
      thinkingLevel,
      skillName,
    );
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
    task: TaskDetail,
    metadata: { reason: string; nodeId: string; workflowId: string; runId: string },
  ): Promise<TaskDetail> {
    return ensureWorkflowMergeBoundaryTaskImpl(
      buildEnsureWorkflowMergeBoundaryTaskDeps(this),
      task,
      metadata,
    );
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
    taskId: string,
    stepIndex: number,
    status: import("@fusion/core").StepStatus,
  ): Promise<void> {
    return updateStepGraphImpl({ store: this.store }, taskId, stepIndex, status);
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
    task: TaskDetail,
    label: string,
    command: string,
    worktreePath: string,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return runRawCliCommandImpl(
      buildRunRawCliCommandDeps(this, runConfiguredCommand),
      task,
      label,
      command,
      worktreePath,
      extraEnv,
    );
  }

  /** Fetch the column agent and surface its model + persona for adoption by a
   *  custom node (plan U3). Best-effort, mirroring the node-agent posture at the
   *  `"agent"` branch: on null/throw, log and return undefined so the caller
   *  falls back to the node's own/default resolution (R8). Emits a logEntry
   *  naming the substitution and mode so the audit trail explains who ran. */
  private async adoptColumnAgentForNode(
    node: WorkflowIrNode,
    live: TaskDetail,
    columnAgentId: string,
    mode: WorkflowColumnAgent["mode"] | undefined,
  ): Promise<{ modelProvider?: string; modelId?: string; persona?: string } | undefined> {
    return adoptColumnAgentForNodeImpl(
      {
        ...this.storeRunContextDeps(),
        agentStore: this.options.agentStore,
      },
      node,
      live,
      columnAgentId,
      mode,
    );
  }

  /**
   * Resolve the effective COLUMN AGENT governing the coding/step session currently
   * being built for a task (column-agent plan U4, R2/R3/R4/R8).
   *
   * Reads the governing node id stamped by the active seam ({@link
   * graphSeamGoverningNodeId}) and the per-run binding resolver ({@link
   * graphColumnAgentResolver}), both scoped to a graph-owned run. Feeds the task's
   * OWN settings (`assignedAgentId` + complete `modelProvider`/`modelId` pair) into
   * the shared core resolver (`resolveEffectiveAgent`, KTD-2/KTD-5) so defer/override
   * precedence is never reimplemented here. When the verdict is `column-agent`,
   * fetches the full Agent best-effort and audits the adoption; on a missing/deleted
   * agent it logs and returns undefined so the caller falls back to the
   * `assignedAgentId` path (R8). Returns undefined for the legacy/no-binding path so
   * the session build is byte-identical (characterization parity).
   *
   * Exposes the resolved Agent object (not just an id) so U5 can consume the same
   * effective principal for gating/heartbeat/restart without re-resolving.
   */
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

  /**
   * Column-agent principal alignment (plan U5, R6). Resolve the EFFECTIVE
   * principal id for the in-flight seam WITHOUT fetching the full Agent or
   * emitting an adoption log — a light counterpart to {@link resolveSeamColumnAgent}
   * used by the heartbeat-deferral gate (which only needs the id to call
   * {@link shouldDeferForHeartbeat}, which itself loads the agent).
   *
   * Returns the column-agent id when a governing binding selects it via the shared
   * core resolver (`resolveEffectiveAgent`, KTD-2/KTD-5), else `task.assignedAgentId`
   * (the legacy principal). Returns `undefined` only when there is no principal at
   * all (no binding AND no assigned agent) — keeping the no-binding path
   * byte-identical to the prior `assignedAgentId` deferral behavior.
   */
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

  /**
   * Column-agent principal alignment (plan U5, R6). True when `agentId` is the
   * EFFECTIVE column-agent principal currently running some executing task's
   * coding/step session — i.e. an override/defer-bound column staffs it, even
   * though the agent is not the task's `assignedAgentId`. Injected into the
   * heartbeat scheduler's reverse-direction parallel-execution guards
   * (`agent-heartbeat.ts`) so an `allowParallelExecution=false` column agent does
   * not heartbeat concurrently with its own override session. Returns false for the
   * legacy/no-binding path (the map is empty), preserving prior behavior exactly.
   */
  isAgentEffectivelyExecuting(agentId: string): boolean {
    return isAgentEffectivelyExecutingImpl(this.effectiveColumnAgentByTask, agentId);
  }

  /** Build the task-scoped runtime env that carries plugin-injected keys
   *  (e.g. compound-engineering `FUSION_CE_SKILLS_DIR` / `FUSION_CE_AGENTS_DIR`)
   *  plus the plugin PATH contribution. Shared by the legacy single-session path
   *  (agentWork, ~7434) and the graph-node skill-step path (runGraphCustomNode,
   *  U8) so both deliver the same injected env to their sessions. We never mutate
   *  process.env globally — this scoped env is threaded through taskEnv so session
   *  subprocesses inherit it without leaking across concurrent tasks. */
  private async buildInjectedRuntimeEnv(
    taskId: string,
    worktreePath: string,
    branch: string | undefined,
  ): Promise<{ env: NodeJS.ProcessEnv; injectedKeyCount: number; pathEntryCount: number }> {
    return buildInjectedRuntimeEnvImpl(
      {
        rootDir: this.rootDir,
        collectExecutorRuntimeEnv: this.options.pluginRunner
          ? (input) => this.options.pluginRunner!.collectExecutorRuntimeEnv(input)
          : undefined,
      },
      taskId,
      worktreePath,
      branch,
    );
  }

  private async ensureGraphCustomNodeWorktree(
    task: TaskDetail,
    settings: Settings,
    nodeId: string,
    refreshStaleBase = false,
  ): Promise<TaskDetail> {
    return ensureGraphCustomNodeWorktreeImpl(
      buildEnsureGraphCustomNodeWorktreeDeps(this, runConfiguredCommand),
      task,
      settings,
      nodeId,
      refreshStaleBase,
    );
  }

  /*
  FNXC:NodeWorktreeIsolation 2026-07-25-22:10 (planning acquires the task worktree):
  Public seam for the planning/triage lane. Specification runs a CODING-tool session; pointing it at
  the shared main checkout meant every planning agent had write tools in the operator's tree and every
  concurrent planner shared one path. Acquire the task's own worktree up front and let the whole
  lifecycle — planning, Plan Review, implementation, code review — reuse that single worktree.
  Returns null (caller falls back to the root, unchanged behavior) when the project is a workspace, or
  when acquisition fails: planning must never be blocked by a worktree problem.
  */
  public async releasePreExecutionWorktree(taskId: string, reason: string): Promise<boolean> {
    return releasePreExecutionWorktreeImpl(
      buildReleasePreExecutionWorktreeDeps(this),
      taskId,
      reason,
    );
  }

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

  /** Run a custom (non-seam) graph node on the proven WorkflowStep machinery.
   *
   *  `columnBinding` (plan U3) is the agent binding governing this node's
   *  declared column, resolved by the seam wiring in executeWorkflowGraph
   *  (the IR is not in scope here). When present, the core resolver decides
   *  whether the column agent supersedes (override) or defers to the node's own
   *  `cfg.agentId`/model pair — never a reimplemented precedence. */
  private async runGraphCustomNode(
    node: WorkflowIrNode,
    nodeTask: TaskDetail,
    settings: Settings,
    columnBinding?: WorkflowColumnAgent,
    graphContext?: Record<string, unknown>,
  ): Promise<WorkflowNodeResult> {
     
    return runGraphCustomNodeImpl(
      buildRunGraphCustomNodeDeps(this),
      node,
      nodeTask,
      settings,
      columnBinding,
      graphContext,
    );
     
  }

  private async runCliAgentNode(
    node: WorkflowIrNode,
    live: TaskDetail,
    cfg: Record<string, unknown>,
  ): Promise<WorkflowNodeResult> {
    return runCliAgentNodeImpl(
      buildRunCliAgentNodeDeps(this),
      node,
      live,
      cfg,
    );
  }

  /**
   * Reap a CLI task session at the execute→in-review handoff (U7). Graceful PTY
   * kill recorded as `completed`. Best-effort: a reap failure must not block the
   * pipeline advancement that the positive done already authorized.
   */
  private async reapCliTaskSessionForHandoff(session: CliTaskSession, taskId: string): Promise<void> {
    return reapCliTaskSessionForHandoffImpl(session, taskId);
  }

  /*
  FNXC:SessionContention 2026-07-25-21:30 (self-recovering wait — the task is never parked):
  Retry the graph in place on an exponential backoff while the holder finishes. The counter is
  IN-MEMORY on purpose: it needs no schema change, and an engine restart resetting it is the desired
  behavior (a restart also drops the in-process registry, so the contention is gone anyway).
  When the ladder is exhausted the task is left cleanly dispatchable — status/error cleared, progress
  untouched — so ordinary scheduling picks it up later with a fresh budget. There is no terminal branch
  here by design: lease contention always ends (the holder finishes, or self-healing sweeps it), so
  parking the task would only require a human to press Retry on a condition that fixed itself.
  */
  private sessionContentionHoldAttempts = new Map<string, number>();

  private clearSessionContentionHold(taskId: string): void {
    this.sessionContentionHoldAttempts.delete(taskId);
  }

  private async holdForSessionContention(
    task: Task,
    live: TaskDetail,
    result: WorkflowGraphTaskRunResult,
  ): Promise<void> {
    return holdForSessionContentionImpl(
      buildHoldForSessionContentionDeps(this),
      task,
      live,
      result,
    );
  }

  private async routeUnusableWorktreeGraphFailureToRecovery(
    task: Task,
    live: TaskDetail,
    result: WorkflowGraphTaskRunResult,
    /** Shared per-recovery lane snapshot — see `resolveResumeLanes`. */
    resumeLanesMemo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<boolean> {
    return routeUnusableWorktreeGraphFailureToRecoveryImpl(
      buildRouteUnusableWorktreeGraphFailureToRecoveryDeps(this),
      task,
      live,
      result,
      resumeLanesMemo,
    );
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
    live: TaskDetail,
    failedNode: string | undefined,
    failureValue: string | undefined,
  ): Promise<boolean> {
    return routeRetryableRemediationGraphFailureToPreMergeFixImpl(
      buildRouteRetryableRemediationGraphFailureToPreMergeFixDeps(this),
      live,
      failedNode,
      failureValue,
    );
  }

  private async isRetryableBenignMergePauseAbort(
    live: TaskDetail,
    result: WorkflowGraphTaskRunResult,
    abortProvenance: PausedAbortProvenance | undefined,
    pausedAborted: boolean,
    /** Shared per-recovery lane snapshot — see `resolveResumeLanes`; a fresh resolution here could disagree
     *  with the one the rest of `handleGraphFailure` uses. */
    resumeLanesMemo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<boolean> {
    return isRetryableBenignMergePauseAbortImpl(
      {
        store: this.store,
        ...facadeMethods(this, ["resolveResumeLanes", "isLiveSharedBranchGroupMember"]),
      },
      live,
      result,
      abortProvenance,
      pausedAborted,
      resumeLanesMemo,
    );
  }

  private async isBenignManualMergeHoldPauseAbort(
    live: TaskDetail,
    result: WorkflowGraphTaskRunResult,
    abortProvenance: PausedAbortProvenance | undefined,
    pausedAborted: boolean,
    /** Shared per-recovery lane snapshot — see `resolveResumeLanes`; a fresh resolution here could disagree
     *  with the one the rest of `handleGraphFailure` uses. */
    resumeLanesMemo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<boolean> {
    return isBenignManualMergeHoldPauseAbortImpl(
      {
        store: this.store,
        ...facadeMethods(this, ["resolveResumeLanes", "isLiveSharedBranchGroupMember"]),
      },
      live,
      result,
      abortProvenance,
      pausedAborted,
      resumeLanesMemo,
    );
  }

  private async handleStaleInReviewPlanPauseAbortReplay(
    live: TaskDetail,
    result: WorkflowGraphTaskRunResult,
    abortProvenance: PausedAbortProvenance | undefined,
    pausedAborted: boolean,
    userCanceled: boolean,
    /** Shared per-recovery lane snapshot — see `resolveResumeLanes`; a fresh resolution here could disagree
     *  with the one the rest of `handleGraphFailure` uses. */
    resumeLanesMemo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<boolean> {
    return handleStaleInReviewPlanPauseAbortReplayImpl(
      buildHandleStaleInReviewPlanPauseAbortReplayDeps(this),
      live,
      result,
      abortProvenance,
      pausedAborted,
      userCanceled,
      resumeLanesMemo,
    );
  }

  private async handleStaleInReviewParsePauseAbortReplay(
    live: TaskDetail,
    result: WorkflowGraphTaskRunResult,
    abortProvenance: PausedAbortProvenance | undefined,
    pausedAborted: boolean,
    userCanceled: boolean,
    /** Shared per-recovery lane snapshot — see `resolveResumeLanes`; a fresh resolution here could disagree
     *  with the one the rest of `handleGraphFailure` uses. */
    resumeLanesMemo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<boolean> {
    return handleStaleInReviewParsePauseAbortReplayImpl(
      buildHandleStaleInReviewParsePauseAbortReplayDeps(this),
      live,
      result,
      abortProvenance,
      pausedAborted,
      userCanceled,
      resumeLanesMemo,
    );
  }

  private async isReentrantPausedAbortedInFlightNode(
    live: TaskDetail,
    result: WorkflowGraphTaskRunResult,
    abortProvenance: PausedAbortProvenance | undefined,
    pausedAborted: boolean,
    userCanceled: boolean,
    resumeLanesMemo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<boolean> {
    return isReentrantPausedAbortedInFlightNodeImpl(
      {
        store: this.store,
        ...facadeMethods(this, ["resolveResumeLanes", "isLiveSharedBranchGroupMember"]),
      },
      live,
      result,
      abortProvenance,
      pausedAborted,
      userCanceled,
      resumeLanesMemo,
    );
  }

  /* FNXC:CodeOrganization 2026-08-04-03:05: Full Phase C resume-eligibility FNXC lives on resolve-resume-lanes.ts. */
  private async resolveResumeLanes(
    taskId: string,
    memo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<{ hold: string; wip: string; review: string; wipDeclared: boolean }> {
    return resolveResumeLanesImpl({ store: this.store }, taskId, memo);
  }

  private async reenterPausedAbortedWorkflowNode(
    live: TaskDetail,
    result: WorkflowGraphTaskRunResult,
    abortProvenance: PausedAbortProvenance | undefined,
    resumeLanesMemo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<boolean> {
    return reenterPausedAbortedWorkflowNodeImpl(
      buildReenterPausedAbortedWorkflowNodeDeps(this),
      live,
      result,
      abortProvenance,
      resumeLanesMemo,
    );
  }

  private async routeGraphMergeFailureToRetry(
    live: TaskDetail,
    result: WorkflowGraphTaskRunResult,
    abortProvenance: PausedAbortProvenance | undefined,
  ): Promise<boolean> {
    return routeGraphMergeFailureToRetryImpl(
      buildRouteGraphMergeFailureToRetryDeps(this),
      live,
      result,
      abortProvenance,
    );
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
    live: TaskDetail,
    failedNode: string,
    failureValue: string | undefined,
    /** Shared per-recovery lane snapshot — see `resolveResumeLanes`. */
    resumeLanesMemo?: { lanes?: { hold: string; wip: string; review: string; wipDeclared: boolean } },
  ): Promise<boolean> {
    return routeGraphFailureToExecutionResumeImpl(
      buildRouteGraphFailureToExecutionResumeDeps(this),
      live,
      failedNode,
      failureValue,
      resumeLanesMemo,
    );
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

  /*
  FNXC:EphemeralAgents 2026-07-01-00:00:
  `ephemeralAgentsEnabled: false` means "never spawn short-lived executor-FN-XXXX workers; only permanent agents run work" (see types.ts ephemeralAgentsEnabled). The legacy spawn refusal lives in EphemeralWorkerManager.onTaskStart (ephemeral-worker-manager.ts), but that runs as a fire-and-forget bookkeeping callback AFTER execution has already begun, so it cannot stop a run. The workflow-engine dispatch paths (executeWorkflowGraph, maybeDispatchWorkflowWorkEngine) execute tasks in-process without ever consulting the toggle. Any task that reaches execute() without a permanent assignment via a non-scheduler path (resume-after-restart, heartbeat re-entry, mission/autopilot, work-engine claim) therefore ran despite the operator disabling ephemeral agents.

  This guard is the executor's last line of defense, mirroring the scheduler cutover gate (scheduler.ts:2464) and the spawn refusal (ephemeral-worker-manager.ts:132). It runs once at the top of the outer dispatch — before all three workflow paths — so a single check covers every workflow dispatch entry point. A task explicitly assigned to a permanent (non-ephemeral) agent is exactly how ephemeral-off mode is meant to run, so those are allowed through; everything else is re-queued for the scheduler to auto-assign a permanent agent or hold.
  */
  private async blockOuterDispatchWhenEphemeralDisabled(task: Task): Promise<boolean> {
    return blockOuterDispatchWhenEphemeralDisabledImpl(
      buildBlockOuterDispatchWhenEphemeralDisabledDeps(this),
      task,
    );
  }

  /*
  FNXC:GlobalConcurrencyControls 2026-07-15-03:50:
  Structural cleanup for scheduler pre-held global slots: every execute() exit path
  (early return, throw, graph-owned, legacy handoff) must leave no unclaimed registration.
  take() removes the registration so a successful claim+release is a no-op here; early
  returns that never take() release the underlying semaphore. New early-return paths
  cannot reintroduce permanent capacity leaks without bypassing this wrapper.
  */
  async execute(task: Task): Promise<void> {
    try {
      await this.executeCore(task);
    } finally {
      if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();
    }
  }

  /*
  FNXC:WorkflowExecution 2026-07-19-02:10:
  U5e (R9) — `executeCore` is ROUTING ONLY. It decides who owns the task (duplicate-dispatch
  drop, dependency/ephemeral gates, the workflow graph, authoritative dispatch) and, when no
  one else claims it, drives the implementation phase itself.

  The routing block used to be wrapped in `if (!graphCompletion)` because the graph re-ENTERED
  `execute()` to run the implementation phase, and that inner call had to skip routing or it
  would recurse. The graph now calls `runImplementation()` directly, so there is no inner
  invocation to exclude and the gates are unconditional.
  */
  private async executeCore(task: Task): Promise<void> {
    return executeCoreImpl(
      buildExecuteCoreDeps(this),
      task,
    );
  }

  /*
  FNXC:WorkflowExecution 2026-07-19-02:10:
  U5e (R9) — the implementation phase, lifted out of the dual-purpose `executeCore` into a
  standalone runner the workflow graph calls DIRECTLY. Before the lift the graph re-entered
  `execute()` under a completion signal, because worktree / taskEnv / agent / semaphore state
  is assembled here and was not available standalone at `createGraphSeams` time. Lifting the
  body moves that assembly behind an ordinary method call, so the graph gets the state it
  needs without a second trip through routing.

  Owns: the process-wide task lock, soft-delete refusal, work-engine dispatch, heartbeat
  deferral, settings merge, worktree acquisition, the agent session, and everything up to the
  implementation-complete boundary. It does NOT own workflow gates, review handoff, or merge —
  those are the graph's.
  */
  private async runImplementation(
    task: Task,
    /*
    FNXC:WorkflowExecution 2026-07-19-17:50 (U10b / R9):
    REQUIRED, and an explicit parameter rather than an options bag. It was optional only to
    describe "a run the graph does not own" — the legacy fallback. That fallback is deleted, so
    every implementation pass is graph-owned and every completion boundary below is an
    unconditional handoff. Making it required is the type-level statement of that invariant:
    an implementation pass whose completion nothing owns can no longer be constructed.
    */
    graphCompletion: GraphCompletionCallback,
    /*
    FNXC:WorkflowExecutionOwnership 2026-07-28-20:15 (U8 / R4, R5):
    Optional exit reporter. `graphCompletion` can only say "done"; the endings it cannot express
    are the ones the executor transitions itself (see `executor/implementation-exit.ts`). This
    names them so they are OBSERVABLE before they are moved — it changes no routing and nothing
    branches on it, by R5: an exit id is a reaction, and a dropped reaction must never cost a
    state change. Optional so the ~22 uninstrumented dispositions stay silent rather than
    forcing a 3k-line diff; the ownership ledger is the record of that gap, not this callback.
    */
    reportImplementationExit?: ImplementationExitReporter,
  ): Promise<void> {
    return runImplementationImpl(
      buildRunImplementationDeps(this, {
        BRANCH_CONFLICT_TRIPWIRE_THRESHOLD,
        MAX_AUTO_RECOVERY_ATTEMPTS,
      }),
      task,
      graphCompletion,
      reportImplementationExit,
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
    taskId: string,
    codeReviewVerdicts: Map<number, ReviewVerdict>,
    sessionRef: { current: AgentSession | null },
    stuckDetector?: StuckTaskDetector,
  ): ToolDefinition {
    return createTaskUpdateToolImpl(
      {
        store: this.store,
        resolveTaskCustomFieldDefs: (id) => this.resolveTaskCustomFieldDefs(id),
        loopRecoveryState: this.loopRecoveryState,
      },
      taskId,
      codeReviewVerdicts,
      sessionRef,
      stuckDetector,
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
    task: Task,
    worktreePathOverride?: string,
    allowReanchor = true,
    options?: { noOpCompletion?: boolean; noOpCompletionReason?: string },
  ): Promise<{ ok: true } | { ok: false; reason: "wrong_toplevel" | "wrong_branch" | "no_commits"; observed: string; expected: string; repo?: string }> {
    return verifyWorktreeInvariantsImpl(
      this.worktreeInvariantDeps(),
      task,
      worktreePathOverride,
      allowReanchor,
      options,
    );
  }

  private async evaluateTaskDoneScopeLeak(
    task: Task,
    worktreePath: string,
    promptContent: string,
    settings: Settings,
    audit?: RunAuditor,
  ): Promise<{ blocked: false } | { blocked: true; message: string }> {
    return evaluateTaskDoneScopeLeakImpl(
      buildEvaluateTaskDoneScopeLeakDeps(this),
      task,
      worktreePath,
      promptContent,
      settings,
      audit,
    );
  }

  private async handleImplicitTaskDoneRefusal(
    task: Task,
    refusal: Extract<ReturnType<typeof evaluateTaskDoneRefusal>, { ok: false }>,
  ): Promise<void> {
    return handleImplicitTaskDoneRefusalImpl(
      buildHandleImplicitTaskDoneRefusalDeps(this),
      task,
      refusal,
    );
  }

  private createTaskDoneTool(
    taskId: string,
    worktreePath: string,
    promptContent: string,
    codeReviewVerdicts: Map<number, ReviewVerdict>,
    onDone: () => void,
    audit?: RunAuditor,
  ): ToolDefinition {
    return createTaskDoneToolImpl(
      buildCreateTaskDoneToolDeps(this),
      taskId,
      worktreePath,
      promptContent,
      codeReviewVerdicts,
      onDone,
      audit,
    );
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
    task: Task,
    worktreePath: string,
    settings: Settings,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<VerificationResult> {
    return runExecutorDeterministicVerificationImpl(
      {
        ...this.storeRunContextDeps(),
      },
      task,
      worktreePath,
      settings,
      extraEnv,
    );
  }

  /**
   * Attempt to fix verification failures by spawning a dedicated AI fix agent.
   * Follows the pattern established by the merger's attemptInMergeVerificationFix.
   * Returns true if verification passes after the fix attempt, false otherwise.
   */
  private async attemptExecutorVerificationFix(
    task: Task,
    worktreePath: string,
    failureContext: {
      command: string;
      exitCode: number | null;
      output: string;
      type: "test" | "build";
    },
    settings: Settings,
    retryNumber: number,
    maxRetries: number,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<boolean> {
    return attemptExecutorVerificationFixImpl(
      buildAttemptExecutorVerificationFixDeps(this),
      task,
      worktreePath,
      failureContext,
      settings,
      retryNumber,
      maxRetries,
      extraEnv,
    );
  }

  /**
   * Send a task back to in-progress after verification failure.
   * Injects failure feedback into PROMPT.md, resets steps, clears session,
   * and schedules a move to todo → in-progress after the executing guard clears.
   */
  private async sendTaskBackForFix(
    task: Task,
    worktreePath: string,
    failureFeedback: string,
    stepName: string,
    reason: string,
    preserveResumeState: boolean = true,
    mergeVerificationFailure: boolean = false,
    retryPresentation?: { attempt: number; max?: number },
  ): Promise<void> {
    return sendTaskBackForFixImpl(
      buildSendTaskBackForFixDeps(this, MAX_WORKFLOW_STEP_RETRIES),
      task,
      worktreePath,
      failureFeedback,
      stepName,
      reason,
      preserveResumeState,
      mergeVerificationFailure,
      retryPresentation,
    );
  }

  private async injectWorkflowStepFailureInstructions(
    task: Task,
    failureFeedback: string,
    stepName: string,
    retry: { attempt: number; max?: number },
  ): Promise<void> {
    return injectWorkflowStepFailureInstructionsImpl(this.store, task, failureFeedback, stepName, retry);
  }

  private async captureModifiedFiles(
    worktreePath: string,
    baseCommitSha: string | undefined,
    taskId: string,
    audit?: RunAuditor,
    source = "unspecified",
  ): Promise<string[]> {
    return captureModifiedFilesImpl(worktreePath, baseCommitSha, taskId, audit, source);
  }

  private async captureWorkspaceModifiedFiles(
    task: Task,
    audit?: RunAuditor,
    source = "post-session",
  ): Promise<string[]> {
    return captureWorkspaceModifiedFilesImpl(task, audit, source);
  }

  private async reviewWorkspacePerRepo(
    task: Task,
    invokeForCwd: (cwd: string) => Promise<ReviewResult>,
  ): Promise<ReviewResult> {
    return reviewWorkspacePerRepoImpl(task, invokeForCwd);
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
    task: Task,
    workflowStep: WorkflowStep,
    worktreePath: string,
    settings: Settings,
    extraEnv?: NodeJS.ProcessEnv,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    return executeScriptWorkflowStepImpl(
      buildExecuteScriptWorkflowStepDeps(this, runConfiguredCommand),
      task,
      workflowStep,
      worktreePath,
      settings,
      extraEnv,
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
    task: Task,
    workflowStep: WorkflowStep,
    worktreePath: string,
    settings: Settings,
    taskEnv?: NodeJS.ProcessEnv,
    stepOptions?: { unattended?: boolean },
  ): Promise<WorkflowStepOutcome> {
     
    return executeWorkflowStepImpl(
      buildExecuteWorkflowStepDeps(this),
      task,
      workflowStep,
      worktreePath,
      settings,
      taskEnv,
      stepOptions,
    );
     
  }

  private async tryBootstrapMisbindingRecovery(
    task: Task,
    contamination: BranchCrossContaminationError,
    audit: ReturnType<typeof createRunAuditor>,
  ): Promise<boolean> {
    return tryBootstrapMisbindingRecoveryImpl(
      {
        ...facadeFields(this, ["rootDir", "store"]),
        ...facadeMethods(this, ["getRunContextFor", "markGraphExecuteSelfRequeued"]),
      },
      task,
      contamination,
      audit,
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
    task: Task,
    livePath: string,
    branch: string,
    tipSha: string,
    count: number,
    settings: Partial<Settings>,
  ): Promise<void> {
    return reclaimExistingWorktreeImpl(
      this.branchConflictHandleDeps(),
      task,
      livePath,
      branch,
      tipSha,
      count,
      settings,
    );
  }

  private async handleBranchConflict(task: Task, error: BranchConflictError): Promise<"retry" | "reclaimed" | "sticky"> {
    return handleBranchConflictImpl(this.branchConflictHandleDeps(), task, error);
  }

  private async recoverMissingWorktreeSessionStartFailure(
    task: Task,
    worktreePath: string,
    error: unknown,
    audit: RunAuditor,
  ): Promise<false | "requeue-todo" | "escalate-exhausted"> {
    return recoverMissingWorktreeSessionStartFailureImpl(
      buildRecoverMissingWorktreeSessionStartFailureDeps(this),
      task,
      worktreePath,
      error,
      audit,
    );
  }

  private async emitWorktreeReanchoredAudit(
    taskId: string,
    fromPath: string,
    toPath: string,
    source: "verify-worktree-invariants" | "executor-liveness-gate",
  ): Promise<void> {
    return emitWorktreeReanchoredAuditImpl(
      {
        ...this.storeRunContextDeps(),
      },
      taskId,
      fromPath,
      toPath,
      source,
    );
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
    taskId: string,
    depTip: string,
    originalStartPoint: string | undefined,
  ): Promise<{ depTip: string; mainBase: string; label: string } | null> {
    return planSquashImportFromDep(this.rootDir, this.store, taskId, depTip, originalStartPoint);
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
    taskId: string,
    event: import("./executor/worktree-stale-lock-recovery.js").StaleLockAuditEvent,
    targetPath: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return emitStaleLockAudit(this.staleLockRecoveryDeps(), taskId, event, targetPath, metadata);
  }

  private async recoverIndexLockIfStale(taskId: string, path: string, conflictInfo: { lockPath?: string; message?: string }): Promise<boolean> {
    return recoverIndexLockIfStale(this.staleLockRecoveryDeps(), taskId, path, conflictInfo);
  }

  private async recoverStaleRegistration(taskId: string, path: string, conflictInfo: { path?: string; message?: string }): Promise<boolean> {
    return recoverExecutorStaleRegistration(this.staleLockRecoveryDeps(), taskId, path, conflictInfo);
  }

  private async normalizeReclaimableWorktreePath(
    sourcePath: string,
    targetPath: string,
    taskId: string,
    settings: Partial<Settings>,
  ): Promise<string> {
    return normalizeReclaimableWorktreePath(
      {
        ...facadeFields(this, ["rootDir", "store"]),
        ...facadeMethods(this, ["hasActiveWorktreeBinding", "isLiveCleanupRefusal"]),
      },
      sourcePath,
      targetPath,
      taskId,
      settings,
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

  /*
  FNXC:CodeOrganization 2026-08-03-15:10:
  Thin facades over tryCreateWorktree / handleWorktreeConflict / cleanupConflictingWorktree
  (U4 Slice B). Shared deps bag wires circular callbacks through this.

  FNXC:CodeOrganization 2026-08-04-02:05:
  Multi-arg create/conflict defaults fill via bindTryCreateWorktree / bindHandleWorktreeConflict
  so the three call sites stay one-liners without changing arity semantics.
  */
  private worktreeCreateConflictDeps(): import("./executor/worktree-create-conflict.js").WorktreeCreateConflictDeps {
    return buildWorktreeCreateConflictFacadeDeps(
      this,
      MAX_WORKTREE_RETRIES,
      bindHandleWorktreeConflict(this),
      bindTryCreateWorktree(this),
    );
  }

  private async tryCreateWorktree(
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber = 0,
    recoveryDepth = 0,
    allowSiblingBranchRename = false,
    settings: Partial<Settings> = {},
  ): Promise<{ path: string; branch: string }> {
    return tryCreateWorktreeImpl(
      this.worktreeCreateConflictDeps(),
      branch, path, taskId, startPoint, attemptNumber, recoveryDepth, allowSiblingBranchRename, settings,
    );
  }

  private async handleWorktreeConflict(
    conflictPath: string,
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    attemptNumber?: number,
    allowSiblingBranchRename = false,
    settings: Partial<Settings> = {},
  ): Promise<{ path: string; branch: string } | null> {
    return handleWorktreeConflictImpl(
      this.worktreeCreateConflictDeps(),
      conflictPath, branch, path, taskId, startPoint, attemptNumber, allowSiblingBranchRename, settings,
    );
  }

  private async cleanupConflictingWorktree(
    worktreePath: string,
    branch: string,
    taskId: string,
  ): Promise<boolean> {
    return cleanupConflictingWorktreeImpl(
      buildCleanupConflictingWorktreeDeps(this),
      worktreePath,
      branch,
      taskId,
    );
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
    worktreePath: string,
    taskId: string,
    depTip: string,
    label: string,
  ): Promise<void> {
    return squashImportDepIntoWorktreeImpl(this.store, worktreePath, taskId, depTip, label);
  }

  private async rebaseNewWorktreeOntoRemote(
    worktreePath: string,
    branch: string,
    taskId: string,
  ): Promise<void> {
    return rebaseNewWorktreeOntoRemoteImpl(this.rootDir, this.store, worktreePath, branch, taskId);
  }

  private async createWorktree(
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    allowSiblingBranchRename = false,
  ): Promise<{ path: string; branch: string }> {
    return createWorktreeImpl(
      buildCreateWorktreeDeps(
        this,
        { maxWorktreeRetries: MAX_WORKTREE_RETRIES, worktreeRetryDelaysMs: [...WORKTREE_RETRY_DELAYS] },
        bindTryCreateWorktree(this),
      ),
      branch,
      path,
      taskId,
      startPoint,
      allowSiblingBranchRename,
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

  /**
   * When the engine restarts mid-step, an `in-progress` step may have already
   * passed its code review (log: `code review Step N: APPROVE`) but not yet
   * been flipped to `done` by the agent's next `fn_task_update` call. Without
   * intervention, the next executor pass re-enters the step and replays plan
   * + code review, which we've measured at 5–20 min of pure waste per restart.
   *
   * This reconciler scans the task log for any in-progress step whose most
   * recent approved code review is newer than its most recent `→ pending`
   * transition, and marks those steps `done`. Subsequent resume logic then
   * advances to the next actually-pending step.
   */
  private async recoverApprovedStepsOnResume(taskId: string): Promise<void> {
    return recoverApprovedStepsOnResumeImpl(this.store, taskId);
  }

  /**
   * On resume (task already has a branch from a prior run), walk git history
   * and mark steps as done when a commit matching the step-completion convention
   * is found. This prevents the agent from redoing already-committed work after
   * an auto-requeue.
   *
   * Commit message convention (case-insensitive):
   *   feat|chore|fix(FN-XXXX): complete Step N
   *
   * Called after the worktree is acquired and before the agent session starts.
   */
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

  /**
   * Handle a loop-detected event from the stuck task detector.
   * Attempts an in-process compact-and-resume before falling back to kill/requeue.
   *
   * This method is the `onLoopDetected` callback wired through the dashboard.
   * It:
   * 1. Checks if the task has an active session
   * 2. Rejects if the one-attempt ceiling has been reached
   * 3. Calls `compactSessionContext()` to compact the conversation
   * 4. Sets recovery-pending state so the execution flow can resume
   *
   * @returns true if the executor accepted recovery ownership (detector skips kill),
   *   false if recovery should not be attempted (detector proceeds with kill/requeue)
   */
    async handleLoopDetected(event: StuckTaskEvent): Promise<boolean> {
    return handleLoopDetectedImpl(
      buildHandleLoopDetectedDeps(this),
      event,
    );
  }

  /**
   * FNXC:Workspace 2026-06-21-12:00: KTD2 single-path-getter contract. Returns the task's sole worktree path for single-repo tasks (one-element set). For a multi-worktree workspace task there is no single answer — callers must read the per-repo `task.workspaceWorktrees` entry instead — so this returns undefined. A workspace task tracked only at the browse-only root also returns undefined, matching the "no removable single worktree" semantics.
   */
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
    agentId: string,
    childSession: AgentSession,
    taskPrompt: string,
  ): Promise<void> {
    return runSpawnedChildImpl(
      buildRunSpawnedChildDeps(this),
      agentId,
      childSession,
      taskPrompt,
    );
  }

  private createSpawnAgentTool(
    taskId: string,
    worktreePath: string,
    settings: Settings,
    taskEnv?: NodeJS.ProcessEnv,
  ): ToolDefinition {
    // FNXC:CodeOrganization 2026-08-03-12:35: get/set totalSpawnedCount so capacity tests that mutate priv.totalSpawnedCount still drive the free-fn path.
    return createSpawnAgentToolImpl(
      buildCreateSpawnAgentToolDeps(this),
      taskId,
      worktreePath,
      settings,
      taskEnv,
    );
  }

}

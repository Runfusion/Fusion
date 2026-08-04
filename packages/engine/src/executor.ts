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
  buildWorktreeCreateConflictDeps,
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

/*
FNXC:WorkflowLifecycleTraits 2026-07-19-09:10 (U5b / KTD-10 / KTD-1):
Every executor "requeue to backlog for retry/resume" rebound targets the task's
TRAIT-derived backlog column (resolveReboundTarget: hold → intake → first), not the
literal "todo". builtin:coding resolves to `todo` so the default pipeline is
byte-identical; a custom/renamed workflow lands its recovered card in a valid
backlog column. These are the KTD-1 RECOVERABLE rebounds (they preserve progress /
resume state); the KTD-1 exhaustion parks (FN-8141 blocked, retry-exhausted) set
`status:"failed"` in place WITHOUT a move and are intentionally untouched here.
One IR resolution per rebound (a recovery path, not an enumeration loop); any
resolution failure falls back to the legacy "todo" so a rebound is never stranded.

FNXC:WorkflowLifecycleColumns 2026-07-30-15:10 (Phase C convergence):
THE "ALREADY THERE?" GUARDS NOW COMPARE AGAINST THIS RESULT. Eight call sites read
`X.column !== "todo"` before moving to the resolved column — so on a renamed board the
guard was ALWAYS true and the engine issued a move into the column the card was already
in. That is a real move: `moveTaskInternal` runs the reset-on-entry effects again. At the
`preserveProgress: false` site (stale workflow parse pins) it reset step progress a second
time on a card that had only been re-checked, and every site re-ran the status/error/pause
clears. The move TARGET was converted here in U5b; the guards in front of it were not,
which is the half-conversion shape: the correct target reached through a check that could
not see it. Each site now resolves once and uses the same value for both.
*/

/* FNXC:CodeOrganization 2026-08-04-02:35: GraphCompletionCallback U5d/U5e FNXC lives on task-executor-options.ts. */

export class TaskExecutor {
  /*
  FNXC:Workspace 2026-06-21-12:00:
  activeWorktrees tracks the worktree paths a task currently holds for liveness/owner checks. In workspace mode a single task acquires N sub-repo worktrees (foundation `task.workspaceWorktrees`), so the value is a SET of paths, not one path. A non-workspace (single-repo) task holds a one-element set — every consumer is converted to membership semantics so the single-repo path is byte-for-byte unchanged (KTD2). Helpers below add/remove/iterate the set.
  */
  private activeWorktrees = new Map<string, Set<string>>();

  /**
   * FNXC:Workspace 2026-06-21-12:00: Register a worktree path under a task's active set, creating the set on first add (KTD2). Single-repo tasks call this once → one-element set.
   */
  private addActiveWorktree(taskId: string, worktreePath: string): void {
    addActiveWorktreeImpl(this.activeWorktrees, taskId, worktreePath);
  }

  /**
   * FNXC:Workspace 2026-06-21-12:00: Read-only snapshot of every worktree path a task currently holds (KTD2). Empty when the task holds none.
   */
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
  /**
   * FNXC:WorkflowLifecycle 2026-06-17-03:42:
   * FN-6568 separates pause provenance from the legacy pausedAborted hard-cancel bit. Merge-seam/internal aborts caused FN-6528/FN-6531/FN-6534/FN-6537 to look like pause/resume aborts and left mergeRetries=NULL, so handleGraphFailure must know whether the abort came from global pause, the merge seam, or a generic hard cancel before choosing operator-action parking.
   *
   * FNXC:WorkflowLifecycle 2026-06-17-23:31:
   * FN-6625 adds completion-finalize provenance for the FN-6614 symptom where a completed/no-commit execution already handed off to in-review, then a trailing graph abort looked like a pause/resume engine abort and re-parked the task failed. Completion-finalize is sibling provenance to FN-6568 merge-seam, not operator pause intent.
   *
   * FNXC:WorkflowLifecycle 2026-07-26-11:20:
   * KB-PROV: `hard-cancel` had become a catch-all bucket: `awaitAbortInFlightTaskWork` stamped it unconditionally, so an ENGINE-initiated teardown was labeled with the provenance AGENTS.md reserves for the operator Move-Task hard cancel ("User moveTask(in-progress -> todo) is a hard cancel ... Engine rebounds must not set userPaused"). Observed on FN-8596: the graph's own `performWorkflowRerunBounce` (in-progress -> todo -> in-progress re-dispatch, moveSource "engine") logged `provenance=hard-cancel source=abort-in-flight:parent moved from in-progress to todo` even though `userCanceled` was correctly false and `userPaused` was never set. Behaviour was right, the LABEL lied.
   *
   * `engine-abort` splits that bucket: `hard-cancel` now means ONLY an operator withdrawal (`options.userCanceled === true`), `engine-abort` means an engine/lifecycle teardown. Both are "generic" (non-global-pause, non-merge-seam, non-completion-finalize) aborts, so every downstream classifier that used to accept `hard-cancel` must accept BOTH via `isGenericAbortProvenance()` — those classifiers exist FOR the engine case (see FN-6796's note that "an engine restart/pause-resume abort reaches graph-failure handling as `hard-cancel` provenance even when no user canceled the task") and discriminate real user intent through `userCanceledTaskIds`, not through the provenance label. Narrowing them to `hard-cancel` alone would strand benign engine aborts as operator-action failures.
   */
  private pausedAbortProvenance = new Map<string, PausedAbortProvenance>();
  /**
   * FNXC:WorkflowLifecycle 2026-06-18-10:56:
   * FN-6644 makes completed/no-commit finalize-to-review state durable beyond volatile pause provenance. FN-6641 showed FN-6625 was incomplete because teardown can re-mark `completion-finalize` as `hard-cancel`; this marker keeps the already-finalized handoff from being re-parked as an operator-action pause abort while preserving genuine live pauses and active hard-cancels.
   */
  private completionFinalizedTaskIds = new Set<string>();
  /** Tasks that had a dependency added mid-execution (abort + discard worktree). */
  private depAborted = new Set<string>();
  /** Tasks killed by stuck task detector. Value = shouldRequeue (budget not exhausted). */
  private stuckAborted = new Map<string, boolean>();
  /** Tasks explicitly canceled by user move (in-progress → todo). */
  private userCanceledTaskIds = new Set<string>();
  /*
  FNXC:WorkflowLifecycle 2026-06-23-21:16:
  During graph-owned execute nodes, the inner executor may intentionally self-requeue a task to `todo` for recoverable worktree/session repair. Persisted rows can be stale in tests or during store races, so keep a run-local marker that tells the outer graph failure sink not to overwrite that recovery with an in-review handoff.
  */
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

  /*
  FNXC:WorkflowLifecycle 2026-07-01-16:20:
  Breadcrumb task-log writes on the abort/pause/finalize paths are best-effort diagnostics and must NEVER break control flow. FN-7335 wired store.logEntry() straight into the SYNCHRONOUS markPausedAborted() as `void this.store.logEntry(...).catch(...)`; when store.logEntry is absent/throws synchronously (undefined method, store closed mid-abort, corrupted pager) the call throws a TypeError BEFORE the promise exists, so the trailing .catch() never runs and the exception unwinds out of markPausedAborted — aborting hard-cancel/pause and stranding the in-review handoff. Route every breadcrumb write through safeLogEntry() so both synchronous throws and async rejections are swallowed into a warn.
  */
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
      {
        ...facadeFields(this, ["store"]),
        hasPausedAborted: (taskId: string) => this.pausedAborted.has(taskId),
        ...facadeMethods(this, ["clearPausedAborted"]),
      },
      task,
    );
  }

  clearPauseAbortStateForManualRetry(taskId: string): void {
    clearPauseAbortStateForManualRetryImpl(
      { clearPausedAborted: (id: string) => this.clearPausedAborted(id) },
      taskId,
    );
  }

  /*
  FNXC:Workspace 2026-06-24-15:45 (concurrent workspace tasks — shared browse-root collision):
  In workspace mode `this.rootDir` is the SHARED browse-only (non-git) workspace root, and EVERY
  workspace task runs its agent session rooted there (per-sub-repo worktrees are acquired on demand).
  The session registrations below are keyed in the GLOBAL path-keyed activeSessionRegistry, whose
  foreign-task guard rejects a second task registering a path already held by a different task. With
  the bare root as the key, the second concurrent workspace task fails with "active-session path
  <root> is held by task <other>; task <self> may not overwrite it" — so only ONE task per workspace
  could ever run. Per-task session liveness does NOT require path-exclusivity on the shared root
  (real per-sub-repo exclusivity is enforced separately by the workspace-repo-acquire lease in
  worktree-acquisition.ts, keyed by sub-repo path). Give each task a task-scoped synthetic session
  key so the registry stays per-task. The in-memory activeWorktrees Set still holds the REAL root, so
  getActiveWorktreePaths() consumers that cd into a path are unaffected; only the registry key changes.
  Non-workspace tasks (unique worktree path != rootDir) are returned unchanged.
  */
  /*
  FNXC:PlanReviewWorktree 2026-07-25-20:40 (concurrent root-rooted step sessions — single-repo collision):
  The task-scoped key must apply to the shared repo root in EVERY project mode, not only workspace mode.
  Read-only graph nodes that need no worktree (Plan Review is the canonical one — it reviews the
  store-injected PROMPT.md, see FNXC:PlanReviewSpecInjection) run rooted at `this.rootDir`, and a todo
  task has no worktree of its own. With the bare root as the registry key, two tasks reaching Plan Review
  at the same time collided: the second failed with "active-session path <root> is held by task <other>;
  task <self> may not overwrite it", which surfaced as a Plan Review provider failure, burned the
  in-place retry budget against a hold that retrying can never clear, and left the task parked
  (reported: FN-1398 holding /home/ubuntu/dev/freemap-svelte while FN-1403 planned).
  Path-exclusivity on the shared root is not what keeps these sessions correct: write-capable nodes are
  refused at the root outright (no-worktree-for-write-node above), real per-sub-repo exclusivity is the
  workspace-repo-acquire lease, and every isPathActive consumer guards removable WORKTREE paths — the
  root is never one. Liveness still works because the synthetic key stays in the registry under the task.
  */
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

  /*
  FNXC:SessionContention 2026-07-25-21:30 (contention prevention at the registration seam):
  Every executor session registration goes through `acquireActiveSessionPath` instead of the raw
  `registerPath`, so a LEAKED entry owned by a task with no live session surface in this process is
  RECLAIMED rather than throwing at the newcomer. That closes the second contention class (a dead
  holder can never release, so waiting on it is waiting forever). A genuinely live holder still throws
  the typed error — that case is real serialization, and callers classify it as a retryable contention
  hold (SESSION_CONTENTION_HOLD_VALUE), never as a provider/model failure.
  The probe reports LIVE on any uncertainty: an unknown holder with a fresh entry is treated as live by
  the staleness floor, so the reclaim only ever fires on proven-dead, aged entries.
  */
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
      {
        ...facadeFields(this, ["store"]),
        options: this.options as { agentStore?: import("@fusion/core").AgentStore | null; [k: string]: unknown },
        ...facadeMethods(this, ["getRunContextFor"]),
      },
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
      {
        ...facadeFields(this, ["store", "pausedAborted", "userCanceledTaskIds"]),
        ...facadeMethods(this, [
          "getRunContextFor", "clearCompletedTaskWatchdog", "resolveResumeLanes",
          "shouldDeferCompletionForGlobalPause",
        ]),
      },
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
      {
        ...this.storeRunContextDeps(),
        approvalSuspended: this.approvalSuspended,
        awaitAbortInFlightTaskWork: (id, reason) => this.awaitAbortInFlightTaskWork(id, reason),
        agentStore: this.options.agentStore,
        approvalRequestStore: this.approvalRequestStore,
      },
      taskId,
      agent,
      projectDefaultPolicy,
    );
  }

  private buildPermanentAgentGatingContext(taskId: string | undefined, agent: Agent | null | undefined, projectDefaultPolicy?: { rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]>; toolRules?: import("@fusion/core").AgentPermissionPolicyToolRules }): import("@fusion/core").PermanentAgentGatingContext | undefined {
    return buildPermanentAgentGatingContextImpl(
      {
        ...this.storeRunContextDeps(),
        approvalSuspended: this.approvalSuspended,
        approvalRequestStore: this.approvalRequestStore,
      },
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

  /**
   * FNXC:ExecutorBinding 2026-06-19-00:00:
   * FN-6736 gives self-healing a narrow escape hatch for phantom in-memory executor bindings after the liveness gate proves the owner is dead. Never use this as a general task stopper: it refuses to detach observable live session surfaces, then clears only stale bookkeeping (`executing`, resume/recovery sets, process-wide graph routing, activeWorktrees, activeSessionRegistry paths, and executingTaskLock) so the scheduler can re-dispatch the preserved worktree.
   *
   * FNXC:ExecutorBinding 2026-06-30-00:00:
   * `preserveWorktrees: true` is the FN-6736 self-healing path. When the caller has already committed to `moveTask(..., { preserveWorktree: true })`, unregistering the held worktree path from `activeSessionRegistry` defeats the preserve: re-dispatch then sees the path as free and re-acquires a brand-new worktree (observed on FN-7249: gentle-peach orphaned, rosy-thorn rebuilt ~20s after reclaim). The preserve variant clears only the in-memory executor/lock bookkeeping and leaves the session-registry path entry intact so the re-dispatch reattaches to the same worktree. Non-self-healing callers (leaked-slot reaper, pause-abort recovery) keep the default full-clear behavior.
   */
  /*
  FNXC:NodeWorktreeIsolation 2026-07-29-06:05 (FN-6756 — one liveness predicate, PR #2531 review):
  READ-ONLY liveness probe, extracted so callers can ASK before they mutate.

  `clearPhantomExecutorBinding` both answers "is this live?" and performs a
  destructive release, which forced every caller into a false choice: check first
  and release ownership before their own fallible writes (a torn write — ownership
  gone, task un-repaired, nobody owning the repair), or write first and discover the
  refusal too late. Splitting the question from the act lets a caller gate on
  liveness with no side effect and release only after its writes have committed.

  Deliberately the SAME expression the destructive path uses, not a copy: a probe
  that could disagree with the guard it stands in for is worse than no probe, and
  independent re-derivation of "liveness" at each call site is precisely how this
  bug reached users three times (reclaim sweep -> leaked-slot reaper -> pause-abort).

  Registry paths count. A triage PLANNING session is owned by TriageProcessor and
  appears in NONE of the four executor-owned maps; it registers here instead.
  */
  hasLiveSessionSurface(taskId: string): boolean {
    return hasLiveSessionSurfaceImpl(
      {
        ...facadeFields(this, [
          "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
          "activeCliTaskSessions",
        ]),
        pathsForTask: (id) => activeSessionRegistry.pathsForTask(id),
      },
      taskId,
    );
  }

  clearPhantomExecutorBinding(taskId: string, options: { preserveWorktrees?: boolean } = {}): boolean {
    return clearPhantomExecutorBindingImpl(
      {
        ...facadeFields(this, [
          "activeWorktrees", "executing", "recoveringCompleted",
          "resumingUnpaused", "approvalSuspended", "approvalResumeAfterUnwind",
          "effectiveColumnAgentByTask",
        ]),
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        ...facadeMethods(this, ["hasLiveSessionSurface", "getActiveWorktreePaths"]),
      },
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
      {
        ...facadeFields(this, [
          "userCanceledTaskIds", "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
          "activeConfiguredCommandControllers", "activeWorkflowGraphAbortControllers", "activeSubagentSessions",
          "activeCliTaskSessions", "loopRecoveryState", "stuckAborted",
        ]),
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        untrackStuckTask: (id: string) => { this.options.stuckTaskDetector?.untrackTask(id); },
        ...facadeMethods(this, [
          "markPausedAborted", "clearWorkflowRerunWatchdog", "clearCompletedTaskWatchdog",
          "deleteActiveSession", "deleteActiveStepExecutor", "deleteActiveWorkflowStepSession",
          "disposeSubagentsForTask", "safeLogEntry",
        ]),
      },
      taskId,
      reason,
      options,
    );
  }

  async abortAllInFlight(reason: string): Promise<void> {
    return abortAllInFlightImpl(
      {
        ...facadeFields(this, [
          "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
          "activeConfiguredCommandControllers", "activeWorkflowGraphAbortControllers", "activeSubagentSessions",
          "activeCliTaskSessions", "childSessions",
        ]),
        ...facadeMethods(this, ["awaitAbortInFlightTaskWork"]),
      },
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
      {
        ...this.storeRunContextDeps(),
        ...facadeFields(this, [
          "executing", "resumingUnpaused", "recoveringCompleted",
          "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
          "graphRouting", "approvalSuspended",
        ]),
        ...facadeMethods(this, [
          "getExecutionPauseLabel", "clearResumeFailureState", "recoverApprovedStepsOnResume",
          "recoverCompletedTask", "execute",
        ]),
      },
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
      {
        ...facadeFields(this, [
          "store", "completedTaskWatchdogs", "recoveringCompleted",
          "executing", "activeSessions", "activeStepExecutors",
          "activeWorkflowStepSessions", "resumingUnpaused",
        ]),
        completedTaskWatchdogMs: COMPLETED_TASK_WATCHDOG_MS,
        ...facadeMethods(this, [
          "clearCompletedTaskWatchdog", "getExecutionPauseLabel", "resolveResumeLanes",
          "recoverCompletedTask",
        ]),
      },
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
      {
        ...facadeFields(this, ["store", "workflowRerunPending"]),
        ...facadeMethods(this, [
          "getExecutionPauseLabel", "resolveResumeLanes", "clearTerminalStepFailuresForRetry",
        ]),
      },
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
      {
        ...facadeFields(this, ["store", "workflowRerunWatchdogs"]),
        workflowRerunWatchdogMs: WORKFLOW_RERUN_WATCHDOG_MS,
        ...facadeMethods(this, [
          "clearWorkflowRerunWatchdog", "performWorkflowRerunBounce", "getExecutionPauseLabel",
          "resolveResumeLanes",
        ]),
      },
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
      {
        ...this.storeRunContextDeps(),
        tokenUsageBaselines: this.tokenUsageBaselines,
        getActiveSession: (id) => this.activeSessions.get(id)?.session,
      },
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
      {
        ...this.storeRunContextDeps(),
        ...facadeMethods(this, ["persistTokenUsage", "handoffTaskToReview", "deleteActiveSession"]),
        activeSessions: this.activeSessions,
        untrackStuckTask: (id) => { this.options.stuckTaskDetector?.untrackTask(id); },
      },
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
      {
        ...this.storeRunContextDeps(),
        ...facadeFields(this, [
          "executing", "activeSessions", "activeStepExecutors",
          "activeWorkflowStepSessions", "resumingUnpaused",
        ]),
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        ...facadeFields(this, [
          "workflowRerunWatchdogs", "workflowRerunPending", "recoveringCompleted",
        ]),
        captureModifiedFiles: (wt, base, id, audit, source) => this.captureModifiedFiles(wt, base ?? undefined, id, audit, source),
        ...facadeMethods(this, [
          "shouldDeferCompletionForGlobalPause", "executeWorkflowGraph", "clearCompletedTaskWatchdog",
          "persistTokenUsage", "handoffTaskToReview", "signalTaskComplete",
        ]),
      },
      task,
    );
  }

  /*
   * FNXC:WorkflowOptionalStepFix 2026-06-26-16:35:
   * Inline graph optional-step remediation consumes `postReviewFixCount` BEFORE calling `sendTaskBackForFix`, matching self-healing's budget-first ordering. Persistent optional-step REVISE loops are bounded by the resolved optional-group budget; `"unbounded"` intentionally skips the ceiling check so the step cycles until it returns APPROVE/APPROVE_WITH_NOTES or a human intervenes.
   *
   * FNXC:WorkflowRevisionBudget 2026-06-30-20:48:
   * Live Plan Review/spec and Code Review remediation must honor explicit workflow setting values before node `maxRevisions`, and must treat unset values as unbounded for those two built-in review paths. Browser Verification keeps the existing `maxPostReviewFixes` fallback unless its node config explicitly changes it.
   *
   * FNXC:WorkflowRevisionBudget 2026-06-30-22:04:
   * Plan Review and Code Review caps are independent policy budgets, so attempts are counted by workflow step key instead of the legacy aggregate `postReviewFixCount`. The aggregate still increments for existing dashboard summaries, but it must not let a Plan Review replan consume a Code Review remediation slot.
   */
  /*
   * FNXC:PlanReviewReplanCap 2026-07-19-00:10:
   * U3 — the graph is the sole Plan Review owner (triage's out-of-graph gate and
   * its blockAfterPlanReviewRevise cap-park are deleted). Re-own the replan-cap
   * escalation here: when the plan-review replan budget (node `maxRevisions` /
   * `planReviewReplanCap` setting, or the unbounded-default hard cap) is exhausted,
   * park the task at `awaiting-approval` with reason `plan-review-replan-cap` so a
   * persistent planner/reviewer disagreement surfaces to a human instead of looping
   * forever or silently sitting in place. The reason string is special-cased by the
   * dashboard + notifications, so it must be preserved verbatim.
   */
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
      {
        ...facadeFields(this, ["store", "workflowLifecycleMovesInFlight"]),
        ...facadeMethods(this, [
          "getRunContextFor", "recoverMissingRequiredArtifacts", "parkPlanReviewReplanCapExhausted",
          "clearPausedAborted", "sendTaskBackForFix",
        ]),
      },
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
      {
        ...this.storeRunContextDeps(),
        isRequiredArtifactRecoveryProtected: (t: Task) => this.isRequiredArtifactRecoveryProtected(t),
        workflowLifecycleMovesInFlight: this.workflowLifecycleMovesInFlight,
      },
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

  /**
   * Re-dispatch execute() for any unstarted in-progress task whose EFFECTIVE
   * principal is the given agent. Called after a heartbeat run completes to unblock
   * tasks that were deferred by the allowParallelExecution=false gate.
   *
   * TWO-PASS (plan U5, R6) — the `assignedAgentId`-only filter alone misses tasks an
   * override/defer column binding re-keys to the column agent:
   *   1. Tasks directly `assignedAgentId === agentId` (legacy, byte-identical).
   *   2. Tasks whose effective column agent resolves to `agentId` for their
   *      governing execute / step-execute seam — resolved per candidate via the core
   *      column-agent resolver against the task's workflow IR. Bounded: only
   *      not-already-executing in-progress tasks are probed, and the IR resolution is
   *      best-effort (failure → skip, never strands resume).
   * A task re-dispatched by pass 1 is not re-dispatched by pass 2 (dedupe set).
   */
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
  The wip-lane read for the two resume sweeps, resolved at PROJECT level.

  `listTasks`' `column` option filters in the store, so both sweeps returned an EMPTY array on a
  renamed board and neither resume ran:

    - `resumeTaskForAgent` — a durable agent coming back up adopted nothing, so its in-flight task
      stayed orphaned;
    - `resumeOrphaned` — the engine-wide sweep found no orphans to re-dispatch after a restart.

  Both are recovery paths, which is the expensive place to be silently inert: the failure only shows
  up after a crash or a restart, when the operator is already looking at something else. The census
  cannot see either — it scores comparisons, and a query filter is not one.

  Project-level because a read has no task in hand, legacy ids unioned so a board mid-rename still
  finds rows under the old one, deduped by id because one column can carry two roles.
  */
  private async listWipLaneTasks(): Promise<Task[]> {
    return listWipLaneTasksImpl(this.store);
  }

  async resumeTaskForAgent(agentId: string): Promise<void> {
    return resumeTaskForAgentImpl(
      {
        ...facadeFields(this, [
          "store", "executing", "activeSessions",
          "activeStepExecutors", "activeWorkflowStepSessions",
        ]),
        ...facadeMethods(this, ["listWipLaneTasks", "taskEffectiveAgentMatches", "execute"]),
      },
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

  /*
  FNXC:WorkflowExecution 2026-07-19-01:30:
  U5d (R9) — the `graphCompletionInterceptors` Map is DELETED. It was shared per-task
  mutable state used to signal "this execute() call is a graph implementation phase":
  the graph set an entry, re-entered execute(), and execute() read the Map at ~12 sites
  to decide whether to stop at the implementation-complete boundary, skip outer routing,
  suppress `fn_review_step`, and mark review gates graph-owned. Signalling through a
  shared Map made the graph/legacy split invisible at the call site and left stale
  entries to clean up on abort. It is replaced by an EXPLICIT optional
  `graphCompletion` callback: presence of the callback IS the "graph-owned implementation
  phase" signal, and invoking it hands the captured modifiedFiles back to the graph runner.

  FNXC:WorkflowExecution 2026-07-19-02:10:
  U5e (R9) — the RE-ENTRY is now gone too. `executeCore`'s implementation body was lifted
  into `runImplementation()`, which the graph seam calls DIRECTLY; `executeCore` is routing
  only and `execute()` no longer carries a completion parameter. There is no longer any path
  by which the graph runner calls back into `execute()`.
  */
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

  /*
  FNXC:WorkflowLifecycle 2026-07-18-14:20 (U5c / U1 KTD-1/2/3/12):
  Build the PRODUCTION column-boundary hooks for one graph run. This is the piece
  that makes the graph the single source of truth for lifecycle MOVES: as the
  interpreter enters each node, the controller (createWorkflowColumnBoundary) moves
  the card to the node's trait column via these hooks. All the move-safety lives in
  the controller (same-column no-op, KTD-2 hold→wip parked for the scheduler,
  rejected-move leaves the card in place), so the executor only supplies the raw
  seams:
    - moveTask   → real store.moveTask, engine-sourced with workflowMoveSource so
                   the move is attributed to the graph; bypassGuards (KTD-9: the
                   graph IS the lifecycle owner, so its own moves must not be
                   re-vetoed by the same trait guards it implements — capacity
                   KTD-10 is still enforced by moveTask).
    - emitAudit  → ids/counts-only run-audit (KTD-12) for column-transition/drift.
    - onWarn     → executor log sink; diagnostics never affect the run.

  FNXC:WorkflowIrPin 2026-07-19-18:30 (KTD-3 / U9b):
  The KTD-3 durable IR pin is WIRED: the U9b store schema landed the pin as task-row
  fields (workflowIrPin/workflowIrPinNodeId/workflowIrPinColumnId, migration 0026), so
  pinNodeEntry/loadPriorPin bind to that row via createStoreIrPinPersistence. Each real
  node entry persists the resolved IR's content hash (change-only writes); on restart/
  re-entry the runner loads the prior pin and detectDrift parks the run with
  task:reconcile-workflow-drift when the pinned node/column is gone or the hash no longer
  resolves, instead of traversing a mutated graph. Stores without the fields (in-memory
  fakes, pre-U9b DBs) degrade to the previous inert no-pin posture.
  */
  /*
  FNXC:WorkflowNoMergeCompletion 2026-07-19-12:40:
  A workflow with NO merge region had no way to reach its `complete` column.

  `end` is a graph terminal, never a column destination (KTD-1 — the boundary
  deliberately does not fire on it), so a card only lands in the complete column
  when a REAL node lives there. Every merge-bearing built-in gets that for free
  from `post-merge-verification`; a no-merge workflow does not. The two existing
  movers to the complete column (merger.completeTask, finalizeProvenAutoMergeTask)
  are both merge-proof-gated and unreachable without a merge, and the merge queue
  is only fed on entry to `in-review` — a column a no-merge workflow need not even
  declare. Net effect before this: a `builtin:lead-generation` card completed its
  whole graph and then sat in `outreach` forever, and its dependents never
  released because `complete` never became true for it.

  This is the trait-keyed completion mover for exactly that class. It is
  deliberately narrow:
   - it fires ONLY when the IR declares no merge-orchestration column, so every
     merge-bearing workflow (builtin:coding included) is byte-identical — the
     merge path keeps sole ownership of complete-column entry and the
     done-only-on-confirmed-merge invariant is untouched;
   - it does NOT reintroduce a move on `end`; KTD-1 stands;
   - an IR with no complete-trait column is a legal shape and no-ops here;
   - a task with no worktree (the normal case for a no-merge workflow) is not an
     error — nothing about the move depends on one.
  */
  private async advanceNoMergeWorkflowToCompleteColumn(task: TaskDetail): Promise<void> {
    return advanceNoMergeWorkflowToCompleteColumnImpl(this.store, task);
  }

  /*
  FNXC:WorkflowColumnBoundary 2026-07-27-16:40 (PR #2475 review, P2):
  The wiring itself now lives in `createExecutorColumnBoundaryHooks` so the E2E suite can drive the
  REAL hooks instead of rebuilding them (a hand copy had already diverged in three places). What
  stays here is only genuine Executor state: the in-flight graph-move marker and the logger.
  */
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
      {
        ...facadeFields(this, ["store", "rootDir"]),
        ...facadeMethods(this, ["createWorktree"]),
        semaphoreAvailableCount: () => this.options.semaphore?.availableCount ?? 1,
      },
      task,
      runId,
    );
  }

  private async applyGraphRethinkReset(taskId: string, active: ForeachActiveContext): Promise<void> {
    return applyGraphRethinkResetImpl(
      {
        ...facadeFields(this, [
          "rootDir", "store", "graphStepRunOnce",
          "graphRethinkNarrations",
        ]),
      },
      taskId,
      active,
    );
  }

  /**
   * Run ONLY the implementation phase for a graph-driven task — full setup plus the
   * agent session up to fn_task_done, stopping at the implementation-complete boundary
   * so the graph owns workflow gates, review, and merge.
   *
   * FNXC:WorkflowExecution 2026-07-19-02:10:
   * U5e (R9) — this now calls `runImplementation()` DIRECTLY. It used to re-enter
   * `execute()`, which meant every graph-driven implementation pass made a second trip
   * through routing (dependency/ephemeral gates, graph-routing duplicate check,
   * authoritative dispatch) that had to be suppressed by a signal. There is no re-entry
   * left: routing runs once, in `executeCore`, and the graph calls the runner.
   */
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

  /**
   * Step-inversion per-step driver (KTD-2/KTD-8, closes the U3 interim gap).
   *
   * The U3 stand-in ran `runImplementationPhase` once per foreach instance, which
   * re-ran the whole implementation for every step. The real driver:
   *
   *   1. Pins step-session physics only when the workflow needs a discrete
   *      per-step boundary before a step-review node. Final-review coding lets
   *      `runStepsInNewSessions` choose between one reused executor session and
   *      fresh per-step sessions.
   *   2. Drives the implementation phase exactly ONCE per run, memoized by task
   *      id. Each foreach instance's `runTaskStep` observes projection truth for
   *      its step rather than re-running the agent per step.
   *
   * Worktree/taskEnv/agent/semaphore state is threaded exactly the way
   * `runImplementationPhase` gets it — by re-entering `execute()` under a
   * completion interceptor — because that state is assembled inside `execute()`
   * and is not available standalone at createGraphSeams time (the plan's
   * documented threading approach for full step-session wiring).
   *
   * Returns whether the targeted step ended up `done`/`skipped` in the projection.
   */
  private async runGraphTaskStep(
    task: Task,
    stepIndex: number,
    instanceId?: string,
    governingNodeId?: string,
    thinkingLevel?: ThinkingLevel,
    skillName?: string,
  ): Promise<{ success: boolean; error?: string; exit?: ImplementationExit }> {
    return runGraphTaskStepImpl(
      {
        store: this.store,
        ...facadeMethods(this, ["foreachActiveForTask", "runImplementationPhase"]),
        ...facadeFields(this, [
          "graphStepSessionPinned", "graphStepRunOnce", "graphSeamGoverningNodeId",
          "graphSeamThinkingLevel", "graphSeamSkillName",
        ]),
      },
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

  /**
   * Project a graph-owned step only after it has a real worktree.
   *
   * A fresh task has no worktree until the authoritative implementation pass
   * acquires one. Projecting before that pass produces a false "step started"
   * event and captures the baseline from the project root. In that fresh path,
   * let the implementation pass own the first projection and reuse the base SHA
   * it captures during worktree acquisition. Resumed and isolated-step runs
   * already have a worktree, so they keep the normal per-step projection and
   * pre-work baseline behavior.
   */
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
      {
        store: this.store,
        runGraphTaskStep: (t, idx, inst, gov, think, skill) => this.runGraphTaskStep(t, idx, inst, gov, think, skill),
      },
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
      {
        ...facadeFields(this, [
          "store", "rootDir", "graphSeamGoverningNodeId",
          "graphStepActiveContext", "pausedAborted", "mergeRequester",
        ]),
        ...facadeMethods(this, [
          "getRunContextFor",
          "buildParseStepsDeps", "createAuthoritativeWorkflowSeams", "ensureWorkflowMergeBoundaryTask",
          "getWorkflowMergeImplementationProofFailure", "handoffTaskToReview", "markPausedAborted",
          "persistTokenUsage", "runImplementationPhase", "runProjectedGraphTaskStep",
        ]),
      },
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
      {
        ...this.storeRunContextDeps(),
        ...facadeMethods(this, ["resolveMergeBoundaryColumn", "evaluateWorkflowMergeBoundary"]),
        shouldCompleteChecklistAtWorkflowMerge: (live, mergeProof) =>
          this.shouldCompleteChecklistAtWorkflowMerge(live, mergeProof),
      },
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
      {
        ...facadeFields(this, ["store"]),
        ...facadeMethods(this, [
          "getRunContextFor", "registerConfiguredCommandController", "unregisterConfiguredCommandController",
        ]),
        runConfiguredCommand: (command, cwd, timeoutMs, extraEnv, auditor, signal) =>
          runConfiguredCommand(command, cwd, timeoutMs, extraEnv, auditor, signal),
      },
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
      {
        ...this.storeRunContextDeps(),
        agentStore: this.options.agentStore,
        graphSeamGoverningNodeId: this.graphSeamGoverningNodeId,
        graphColumnAgentResolver: this.graphColumnAgentResolver,
      },
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
      {
        store: this.store,
        rootDir: this.rootDir,
        getWorkspaceConfig: () => this.workspaceConfig,
        setWorkspaceConfig: (c) => { this.workspaceConfig = c; },
        ...facadeMethods(this, ["getRunContextFor", "addActiveWorktree", "registerConfiguredCommandController", "unregisterConfiguredCommandController"]),
        pool: this.options.pool,
        secretsStore: this.options.secretsStore,
        createWorktree: (branch, path, taskId, startPoint, allowSibling) =>
          this.createWorktree(branch, path, taskId, startPoint, allowSibling),
        runConfiguredCommand: (command, cwd, timeoutMs, extraEnv, auditor, signal) =>
          runConfiguredCommand(command, cwd, timeoutMs, extraEnv, auditor, signal),
        onStart: this.options.onStart,
      },
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
      {
        ...facadeFields(this, [
          "store", "rootDir", "activeWorktrees",
        ]),
        ...facadeMethods(this, ["getRunContextFor", "hasLiveTaskSessionSurface"]),
      },
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
      {
        ...this.storeRunContextDeps(),
        activeCliTaskSessions: this.activeCliTaskSessions,
        cliAgentRuntime: this.options.cliAgentRuntime,
        reapCliTaskSessionForHandoff: (session, id) => this.reapCliTaskSessionForHandoff(session, id),
      },
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
      {
        ...this.storeRunContextDeps(),
        getHoldAttempts: (taskId: string) => this.sessionContentionHoldAttempts.get(taskId) ?? 0,
        setHoldAttempts: (taskId: string, attempt: number) => { this.sessionContentionHoldAttempts.set(taskId, attempt); },
        clearHold: (taskId: string) => this.clearSessionContentionHold(taskId),
        reexecute: (t: Task) => this.execute(t),
      },
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
      {
        ...facadeFields(this, ["store", "pausedAborted"]),
        ...facadeMethods(this, [
          "getRunContextFor", "resolveResumeLanes", "recoverMissingWorktreeSessionStartFailure",
        ]),
      },
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
      {
        ...facadeFields(this, [
          "activeSessions", "activeStepExecutors", "activeWorkflowStepSessions",
          "activeCliTaskSessions",
        ]),
      },
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
      {
        store: this.store,
        ...facadeMethods(this, [
          "getRunContextFor", "isPreMergeRemediationGraphNode", "isLiveSharedBranchGroupMember",
          "resolveFailedPreMergeWorkflowStepBudget", "recoverFailedPreMergeWorkflowStep", "persistTokenUsage",
        ]),
      },
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
      {
        store: this.store,
        ...facadeMethods(this, [
          "getRunContextFor", "resolveResumeLanes", "isLiveSharedBranchGroupMember",
          "clearPausedAborted",
        ]),
        activeWorktrees: this.activeWorktrees,
        persistTokenUsage: (id) => this.persistTokenUsage(id),
      },
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
      {
        store: this.store,
        ...facadeMethods(this, [
          "getRunContextFor", "resolveResumeLanes", "isLiveSharedBranchGroupMember",
          "clearPausedAborted",
        ]),
        ...facadeFields(this, [
          "activeWorktrees", "activeSessions", "activeStepExecutors",
          "activeWorkflowStepSessions", "activeWorkflowGraphAbortControllers",
        ]),
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        ...facadeMethods(this, ["persistTokenUsage", "executeWorkflowGraph"]),
      },
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

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-16:00 (Phase C convergence — resume eligibility):
  The columns a RESUME may legitimately start from, resolved from the task's own workflow: the
  hold (backlog) lane, the wip lane, and the review lane.

  These decisions were spelled as the default lineage's three names, so on a renamed board every
  resume-safety check answered "not a safe resume state" and the paused-node re-entry, the
  pause-abort auto-continue, and the benign-todo abort-marker clear all stopped firing. The last
  of those is the one that bites: FN-6478's benign path exists so a re-queued card clears its
  abort marker instead of being parked `failed` for an operator — and on a renamed board it took
  the operator-action branch instead, which is the retry storm that path was written to end.

  ASYNC on purpose: every call site here is already async (a store read precedes each one), so
  there is no listener-ordering hazard of the kind that forced the synchronous planner-lane
  resolver in `replan-target.ts`.

  Fail-soft to the legacy trio so an unresolvable or column-less workflow behaves as before.

  FOLLOW-UP, deliberately not done here: PR #2628 exports a synchronous `resolvePlannerLanes`
  (hold/intake/wip) from `replan-target.ts`. Once both land, this helper and that one should
  become one resolver returning the full lane set — two resolvers for the same question is the
  drift this program keeps paying for. Kept separate now only to avoid a cross-branch dependency.
  */
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
      {
        ...facadeFields(this, [
          "store", "activeWorktrees", "activeSessions", "activeStepExecutors",
          "activeWorkflowStepSessions", "activeWorkflowGraphAbortControllers",
        ]),
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        ...facadeMethods(this, [
          "getRunContextFor", "resolveResumeLanes", "clearPausedAborted",
          "persistTokenUsage", "executeWorkflowGraph", "execute",
        ]),
      },
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
      {
        ...this.storeRunContextDeps(),
        mergeRequester: this.mergeRequester,
        ...facadeMethods(this, ["ensureWorkflowMergeBoundaryTask", "persistTokenUsage"]),
      },
      live,
      result,
      abortProvenance,
    );
  }

  private async routeImplementationIncompleteMergeGraphFailure(live: TaskDetail, failedNode: string): Promise<boolean> {
    return routeImplementationIncompleteMergeGraphFailureImpl(
      {
        ...this.storeRunContextDeps(),
        ...facadeMethods(this, ["clearPausedAborted", "routeGraphFailureToExecutionResume", "persistTokenUsage"]),
        activeWorktrees: this.activeWorktrees,
      },
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
      {
        store: this.store,
        ...facadeMethods(this, [
          "getRunContextFor", "resolveResumeLanes", "clearTerminalStepFailuresForRetry",
          "persistTokenUsage",
        ]),
      },
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
      {
        ...facadeFields(this, ["store"]),
        agentStore: this.options.agentStore,
        ...facadeMethods(this, ["getRunContextFor"]),
      },
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
      {
        completionFinalizedTaskIds: this.completionFinalizedTaskIds,
        graphRouting: this.graphRouting,
        releaseSemaphore: () => { this.options.semaphore?.release(); },
        ...facadeMethods(this, [
          "clearStalePauseAbortBeforeDispatch", "blockOuterDispatchWhenDependenciesUnmet", "blockOuterDispatchWhenEphemeralDisabled",
          "executeWorkflowGraph",
        ]),
      },
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
      {
        ...facadeFields(this, ["store", "depAborted"]),
        getActiveSession: (id: string) => this.activeSessions.get(id),
        getActiveStepExecutor: (id: string) => this.activeStepExecutors.get(id),
      },
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
      {
        ...facadeFields(this, ["store", "workspaceConfig"]),
        ...facadeMethods(this, [
          "getRunContextFor", "captureUncommittedModifiedFiles", "captureModifiedFiles",
        ]),
      },
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
      {
        ...facadeFields(this, ["store"]),
        ...facadeMethods(this, [
          "getRunContextFor", "markGraphExecuteSelfRequeued", "persistTokenUsage",
          "deleteActiveSession",
        ]),
        clearTokenUsageBaseline: (taskId: string) => { this.tokenUsageBaselines.delete(taskId); },
      },
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
      {
        store: this.store,
        agentStore: this.options.agentStore,
        pluginRunner: this.options.pluginRunner,
        onAgentText: this.options.onAgentText,
        onAgentTool: this.options.onAgentTool,
        ...facadeMethods(this, [
          "getRunContextFor", "getAssignedAgentRuntimeConfig", "resolveMcpServers",
          "runExecutorDeterministicVerification",
        ]),
      },
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
      {
        store: this.store,
        ...facadeMethods(this, [
          "clearCompletedTaskWatchdog", "injectWorkflowStepFailureInstructions", "reopenLastStepForRevision",
          "scheduleWorkflowRerun",
        ]),
        maxWorkflowStepRetries: MAX_WORKFLOW_STEP_RETRIES,
      },
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
      {
        ...facadeFields(this, ["store"]),
        ...facadeMethods(this, [
          "getRunContextFor", "registerConfiguredCommandController", "unregisterConfiguredCommandController",
        ]),
        runConfiguredCommand,
      },
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
      {
        ...facadeFields(this, ["rootDir", "store"]),
        ...facadeMethods(this, [
          "getRunContextFor", "hasActiveWorktreeBinding", "markGraphExecuteSelfRequeued",
        ]),
      },
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
      {
        rootDir: this.rootDir,
        store: this.store,
        tryCreateWorktree: bindTryCreateWorktree(this),
      },
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
    return buildWorktreeCreateConflictDeps({
      rootDir: this.rootDir,
      store: this.store,
      maxWorktreeRetries: MAX_WORKTREE_RETRIES,
      handleWorktreeConflict: bindHandleWorktreeConflict(this),
      tryCreateWorktree: bindTryCreateWorktree(this),
      ...facadeMethods(this, [
        "recoverIndexLockIfStale", "recoverStaleRegistration", "cleanupStaleBranch",
        "tryFreshWorktreeAfterLiveConflict", "shouldGenerateNewWorktreeName", "cleanupConflictingWorktree",
        "normalizeReclaimableWorktreePath", "isLiveCleanupRefusal",
      ]),
    });
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
      {
        ...facadeFields(this, ["rootDir", "store"]),
        ...facadeMethods(this, [
          "reconcileSelfOwnedBeforeRemove", "findActiveWorktreeOwner", "removeOwnWorktreeWithReconcile",
        ]),
      },
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
      {
        rootDir: this.rootDir,
        store: this.store,
        maxWorktreeRetries: MAX_WORKTREE_RETRIES,
        worktreeRetryDelaysMs: [...WORKTREE_RETRY_DELAYS],
        tryCreateWorktree: bindTryCreateWorktree(this),
        ...facadeMethods(this, [
          "resolveWorktreeStartPoint", "planSquashImportFromDep",
          "squashImportDepIntoWorktree", "rebaseNewWorktreeOntoRemote",
        ]),
      },
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
    /* eslint-disable @typescript-eslint/no-explicit-any -- thin facade */
    return cleanupTaskWorktreeImpl(
      {
        ...facadeFields(this, [
          "store", "workspaceConfig", "activeWorktrees",
        ]),
        getActiveWorktreePaths: (id) => this.getActiveWorktreePaths(id),
        removeOwnWorktreeWithReconcile: (...args: unknown[]) => (this as any).removeOwnWorktreeWithReconcile(...args),
      },
      taskId,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
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
      {
        ...facadeFields(this, [
          "store", "activeSessions", "loopRecoveryState",
        ]),
        markLoopObserved: this.options.stuckTaskDetector
          ? (id) => this.options.stuckTaskDetector!.markLoopObserved(id)
          : undefined,
      },
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
      {
        options: this.options as { agentStore?: import("@fusion/core").AgentStore | null; [k: string]: unknown },
         
        ...facadeFields(this, [
          "childSessions", "pendingEphemeralDeletions", "totalSpawnedCount",
        ]),
        setTotalSpawnedCount: (n) => { this.totalSpawnedCount = n; },
      },
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
      {
        agentStore: this.options.agentStore,
        childSessions: this.childSessions,
        adjustSpawnedCount: (delta) => {
          this.totalSpawnedCount = Math.max(0, this.totalSpawnedCount + delta);
        },
      },
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

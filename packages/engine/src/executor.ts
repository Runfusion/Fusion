// port-4040-allowlist: this file embeds the "never kill port 4040" rule in the executor prompt.
import {
  AgentStore,
  type TaskStore, type Task, type TaskDetail, type TaskTokenUsage, type Settings,
  type RunMutationContext, type Agent, type MergeResult, type WorkflowIrNode, type ThinkingLevel,
  type WorkflowIr, type WorkflowColumnAgent, type TaskMoveLanes,
  type ApprovalRequestStore, type WorkspaceConfig,
} from "@fusion/core";
import type { ImplementationExit } from "./executor/implementation-exit.js";
import { resolvePlannerLanes } from "./execution/replan-target.js";
import type { WorkflowGraphTaskRunResult } from "./workflows/workflow-graph-task-runner.js";
import type { ForeachActiveContext, WorkflowLegacySeams } from "./workflows/workflow-node-handlers.js";
import type { WorkflowRuntimePrimitives } from "./execution/runtime-primitives.js";
import { createWorkflowRuntimePrimitiveProvider } from "./workflows/workflow-runtime-primitive-provider.js";
import { ModelRegistry, type AgentSession } from "@earendil-works/pi-coding-agent";
import { dropPreHeldExecutorSlot } from "./concurrency/concurrency.js";
import { activeSessionRegistry } from "./agents/active-session-registry.js";
import { CliTaskSession } from "./cli-agent/task-session.js";
import { TokenCapDetector } from "./errors/token-cap-detector.js";
import { StepSessionExecutor } from "./execution/step-session-executor.js";
import type { RunAuditor } from "./util/run-audit.js";
import { getTaskCompletionBlockerForStore } from "./execution/task-completion.js";

export * from "./executor/public-reexports.js";
import type { PausedAbortProvenance } from "./executor/paused-abort-provenance.js";
import * as constants from "./executor/executor-constants.js";
import * as pure from "./executor/pure-bindings.js";
import * as impl from "./executor/impl-bindings.js";
export * from "./executor/free-reexports.js";
import type { ActiveSessionBookkeepingDeps } from "./executor/active-session-bookkeeping.js";
import type { TaskLivenessDeps } from "./executor/task-liveness.js";
import * as bags from "./executor/deps-bags.js";
import { facadeFields, facadeMethods, type FacadeRestArgs, type FacadeAfterFirst, type FacadeAfterSecond } from "./executor/facade-methods.js";
import { bindHandleWorktreeConflict, bindTryCreateWorktree } from "./executor/worktree-create-binders.js";
import { buildWireExecutorLifecycleDeps, wireExecutorLifecycle } from "./executor/wire-executor-lifecycle.js";
/* FNXC host for isBackwardMoveOutOfPlanning requirement history (body stays on TaskExecutor). */
import "./executor/is-backward-move-out-of-planning.js";
import "./executor/task-executor-fields.js";
import "./executor/facade-fnxc-pointers.js";
import "./executor/executor-product-fnxc.js";
import "./executor/executor-method-docs.js";
export type { TaskExecutorOptions, CliAgentRuntime, ActiveExecutorSessionState, GraphCompletionCallback } from "./executor/task-executor-options.js";
import type { TaskExecutorOptions, ActiveExecutorSessionState } from "./executor/task-executor-options.js";
export class TaskExecutor {
  private activeWorktrees = new Map<string, Set<string>>();
  private addActiveWorktree(taskId: string, worktreePath: string): void { impl.addActiveWorktreeImpl(this.activeWorktrees, taskId, worktreePath); }
  private getActiveWorktreePaths(taskId: string): ReturnType<typeof impl.getActiveWorktreePathsImpl> { return impl.getActiveWorktreePathsImpl(this.activeWorktrees, taskId); }
  private executing = new Set<string>();
  private resumingUnpaused = new Set<string>();
  private approvalSuspended = new Set<string>();
  private approvalResumeAfterUnwind = new Set<string>();
  private recoveringCompleted = new Set<string>();
  private capturedReflectionTaskIds = new Set<string>();
  private workflowRerunPending = new Set<string>();
  private workflowLifecycleMovesInFlight = new Set<string>();
  private pendingTaskDisposals = new Map<string, Promise<void>>();
  private unregisterTaskMoveDisposer: (() => void) | undefined;
  private unregisterArchiveWorktreeDisposer: (() => void) | undefined;
  private unregisterArchiveWorkspaceWorktreeDisposer: (() => void) | undefined;
  private activeSessions = new Map<string, ActiveExecutorSessionState>();
  private activeStepExecutors = new Map<string, StepSessionExecutor>();
  private activeStepExecutorSeenSteeringIds = new Map<string, Set<string>>();
  private effectiveColumnAgentByTask = new Map<string, string>();
  private activeWorkflowStepSessions = new Map<string, AgentSession>();
  private activePlanningWorkflowSessions = new Set<string>();
  private activeWorkflowStepSessionSeenSteeringIds = new Map<string, Set<string>>();
  private activeConfiguredCommandControllers = new Map<string, Set<AbortController>>();
  private authoritativeAssignedAgentStore: AgentStore | null = null;
  private activeWorkflowGraphAbortControllers = new Map<string, AbortController>();
  private activeCliTaskSessions = new Map<string, CliTaskSession>();
  private readonlyWorkflowStepAuditDone = false;
  private activeSubagentSessions = new Map<string, Set<AgentSession>>();
  private pausedAborted = new Set<string>();
  private pausedAbortProvenance = new Map<string, PausedAbortProvenance>();
  private completionFinalizedTaskIds = new Set<string>();
  private depAborted = new Set<string>();
  private stuckAborted = new Map<string, boolean>();
  private userCanceledTaskIds = new Set<string>();
  private graphExecuteSelfRequeued = new Set<string>();
  private loopRecoveryState = new Map<string, { attempts: number; pending: boolean }>();
  private spawnedAgents = new Map<string, Set<string>>();
  private tokenUsageBaselines = new Map<string, { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number; totalTokens: number }>();
  private branchConflictErrorCount = new Map<string, number>();
  private completedTaskWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private workflowRerunWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingEphemeralDeletions = new Set<string>();
  private workspaceConfig: WorkspaceConfig | null | undefined = undefined;
  private safeLogEntry(taskId: string, message: string): void { impl.safeLogEntryImpl(this.storeRunContextDeps(), taskId, message); }
  private markPausedAborted(...args: FacadeRestArgs<typeof impl.markPausedAbortedImpl>): void { impl.markPausedAbortedImpl(bags.buildMarkPausedAbortedDeps(this), ...args); }
  private pauseAbortMarkerDeps() { return bags.buildPauseAbortMarkerDeps(this); }
  private markCompletionFinalized(taskId: string): void { impl.markCompletionFinalizedImpl(this.pauseAbortMarkerDeps(), taskId); }
  private clearPausedAborted(taskId: string): void { impl.clearPausedAbortedImpl(this.pauseAbortMarkerDeps(), taskId); }
  private async clearStalePauseAbortBeforeDispatch(task: Task): ReturnType<typeof impl.clearStalePauseAbortBeforeDispatchImpl> { return impl.clearStalePauseAbortBeforeDispatchImpl(bags.buildClearStalePauseAbortBeforeDispatchDeps(this), task); }
  clearPauseAbortStateForManualRetry(taskId: string): void { impl.clearPauseAbortStateForManualRetryImpl({ clearPausedAborted: (id: string) => this.clearPausedAborted(id) }, taskId); }
  private sessionRegistryPath(taskId: string, worktreePath: string): ReturnType<typeof impl.sessionRegistryPathImpl> { return impl.sessionRegistryPathImpl(this.rootDir, taskId, worktreePath); }
  private activeSessionBookkeepingDeps(): ActiveSessionBookkeepingDeps { return bags.buildActiveSessionBookkeepingDeps(this); }
  private acquireSessionRegistryPath(...args: FacadeRestArgs<typeof impl.acquireSessionRegistryPathImpl>): void { impl.acquireSessionRegistryPathImpl(bags.buildAcquireSessionRegistryPathDeps(this), ...args); }
  private setActiveSession(taskId: string, sessionState: ActiveExecutorSessionState, worktreePath: string): void { impl.setActiveSessionImpl(this.activeSessionBookkeepingDeps(), taskId, sessionState, worktreePath); }
  private markGraphExecuteSelfRequeued(taskId: string): void { impl.markGraphExecuteSelfRequeuedImpl(this.activeSessionBookkeepingDeps(), taskId); }
  private deleteActiveSession(taskId: string, worktreePath?: string): void { impl.deleteActiveSessionImpl(this.activeSessionBookkeepingDeps(), taskId, worktreePath); }
  private setActiveStepExecutor(taskId: string, stepExecutor: StepSessionExecutor, worktreePath: string, seenSteeringIds = new Set<string>()): void { impl.setActiveStepExecutorImpl(this.activeSessionBookkeepingDeps(), taskId, stepExecutor, worktreePath, seenSteeringIds); }
  private deleteActiveStepExecutor(taskId: string, worktreePath?: string): void { impl.deleteActiveStepExecutorImpl(this.activeSessionBookkeepingDeps(), taskId, worktreePath); }
  private setActiveWorkflowStepSession(taskId: string, session: AgentSession, worktreePath: string, seenSteeringIds = new Set<string>()): void { impl.setActiveWorkflowStepSessionImpl(this.activeSessionBookkeepingDeps(), taskId, session, worktreePath, seenSteeringIds); }
  private deleteActiveWorkflowStepSession(taskId: string, worktreePath?: string): void { impl.deleteActiveWorkflowStepSessionImpl(this.activeSessionBookkeepingDeps(), taskId, worktreePath); }
  private registerConfiguredCommandController(taskId: string, controller: AbortController): void { impl.registerConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller); }
  private unregisterConfiguredCommandController(taskId: string, controller: AbortController): void { impl.unregisterConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller); }
  private getAutoRecoveryDispatcher(audit: RunAuditor): ReturnType<typeof impl.getAutoRecoveryDispatcherImpl> { return impl.getAutoRecoveryDispatcherImpl(bags.buildGetAutoRecoveryDispatcherDeps(this), audit); }
  private async renewTaskLease(...args: FacadeRestArgs<typeof impl.renewTaskLeaseImpl>): ReturnType<typeof impl.renewTaskLeaseImpl> { return impl.renewTaskLeaseImpl(bags.buildRenewTaskLeaseDeps(this), ...args); }
  private async finalizeAlreadyReviewedTask(taskId: string): ReturnType<typeof impl.finalizeAlreadyReviewedTaskImpl> { return impl.finalizeAlreadyReviewedTaskImpl(bags.buildFinalizeAlreadyReviewedTaskDeps(this), taskId); }
  private async getExecutionPauseLabel(): ReturnType<typeof impl.getExecutionPauseLabelImpl> { return impl.getExecutionPauseLabelImpl({ store: this.store }); }
  private async shouldDeferCompletionForGlobalPause(...args: FacadeRestArgs<typeof impl.shouldDeferCompletionForGlobalPauseImpl>): ReturnType<typeof impl.shouldDeferCompletionForGlobalPauseImpl> { return impl.shouldDeferCompletionForGlobalPauseImpl(bags.buildShouldDeferCompletionForGlobalPauseDeps(this), ...args); }
  private async shouldDeferWorkflowStepCompletion(...args: FacadeRestArgs<typeof impl.shouldDeferWorkflowStepCompletionImpl>): ReturnType<typeof impl.shouldDeferWorkflowStepCompletionImpl> { return impl.shouldDeferWorkflowStepCompletionImpl(bags.buildShouldDeferWorkflowStepCompletionDeps(this), ...args); }
  private childSessions = new Map<string, AgentSession>();
  private totalSpawnedCount = 0;
  private tokenCapDetector = new TokenCapDetector();
  private _modelRegistry?: Promise<ModelRegistry>;
  private _approvalRequestStore?: ApprovalRequestStore;
  private currentRunContexts = new Map<string, RunMutationContext>();
  private getRunContextFor(taskId: string): RunMutationContext | undefined { return this.currentRunContexts.get(taskId); }
  private async handoffTaskToReview(...args: FacadeRestArgs<typeof impl.handoffTaskToReviewImpl>): ReturnType<typeof impl.handoffTaskToReviewImpl> { return impl.handoffTaskToReviewImpl(bags.buildHandoffTaskToReviewDeps(this), ...args); }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional reviewArtifactGenerator on options
  private async generateCompletionFeatureVideo(task: Task): ReturnType<typeof impl.generateCompletionFeatureVideoImpl> { return impl.generateCompletionFeatureVideoImpl({ store: this.store, options: this.options as any }, task); }
  private async awaitFeatureVideoBounded(result: Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult>): Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult> { return impl.awaitFeatureVideoBoundedImpl(result); }
  private getModelRegistry(): Promise<ModelRegistry> { return impl.getModelRegistryImpl({ getModelRegistryCache: () => this._modelRegistry, setModelRegistryCache: (value) => { this._modelRegistry = value; } }); }
  private get approvalRequestStore(): ApprovalRequestStore { return impl.getApprovalRequestStoreImpl({ getCache: () => this._approvalRequestStore, setCache: (value) => { this._approvalRequestStore = value; }, store: this.store }); }
  private buildActionGateContext(...args: FacadeRestArgs<typeof impl.buildActionGateContextImpl>): ReturnType<typeof impl.buildActionGateContextImpl> { return impl.buildActionGateContextImpl(bags.buildBuildActionGateContextDeps(this), ...args); }
  private buildPermanentAgentGatingContext(...args: FacadeRestArgs<typeof impl.buildPermanentAgentGatingContextImpl>): ReturnType<typeof impl.buildPermanentAgentGatingContextImpl> { return impl.buildPermanentAgentGatingContextImpl(bags.buildBuildPermanentAgentGatingContextDeps(this), ...args); }
  private taskLivenessDeps(): TaskLivenessDeps { return bags.buildTaskLivenessDeps(this, TaskExecutor.processWideGraphRouting); }
  getExecutingTaskIds(): Set<string> { return impl.getExecutingTaskIdsImpl(this.taskLivenessDeps()); }
  hasActivePlanningWorkflowSession(taskId: string): boolean { return impl.hasActivePlanningWorkflowSessionImpl(this.taskLivenessDeps(), taskId); }
  isTaskActive(taskId: string): boolean { return impl.isTaskActiveImpl(this.taskLivenessDeps(), taskId); }
  isTaskLiveForOverseerRetry(taskId: string): boolean { return impl.isTaskLiveForOverseerRetryImpl({ ...facadeFields(this, ["resumingUnpaused"]), ...facadeMethods(this, ["isTaskActive", "hasLiveTaskSessionSurface"]) }, taskId); }
  hasLiveSessionSurface(taskId: string): boolean { return impl.hasLiveSessionSurfaceImpl(bags.buildHasLiveSessionSurfaceDeps(this, (id) => activeSessionRegistry.pathsForTask(id)), taskId); }
  clearPhantomExecutorBinding(taskId: string, options: { preserveWorktrees?: boolean } = {}): boolean { return impl.clearPhantomExecutorBindingImpl(bags.buildClearPhantomExecutorBindingDeps(this), taskId, options); }
  isEphemeralDeletionPending(agentId: string): boolean { return impl.isEphemeralDeletionPendingImpl(this.pendingEphemeralDeletions, agentId); }
  disposeEphemeralTimers(): void { impl.disposeEphemeralTimersImpl(this.pendingEphemeralDeletions); }
  private registerSubagentSession(taskId: string, session: AgentSession): void { impl.registerSubagentSessionImpl(this.activeSubagentSessions, taskId, session); }
  private unregisterSubagentSession(taskId: string, session: AgentSession): void { impl.unregisterSubagentSessionImpl(this.activeSubagentSessions, taskId, session); }
  private disposeSubagentsForTask(taskId: string, reason: string): void { impl.disposeSubagentsForTaskImpl(this.activeSubagentSessions, taskId, reason); }
  /* FNXC:WorkflowResolvedColumns 2026-07-31-23:59: isPlannerColumnFor DELETED (zero production callers; inert sync-lane count drop). */
  private isBackwardMoveOutOfPlanning(taskId: string, from: string, to: string, moveLanes: TaskMoveLanes | undefined): boolean {
    const sync = moveLanes ? undefined : resolvePlannerLanes(this.store, taskId);
    const lanes = { hold: moveLanes?.hold ?? sync?.hold ?? "todo", intake: moveLanes?.intake ?? sync?.intake ?? "triage", wip: moveLanes?.wip ?? sync?.wip ?? "in-progress", review: moveLanes?.review ?? sync?.review ?? "in-review", complete: moveLanes?.complete ?? sync?.complete ?? "done" };
    if (from !== lanes.hold && from !== lanes.intake) return false;
    const forwardTargets = [lanes.wip, lanes.review, lanes.complete].filter((column): column is string => typeof column === "string");
    return !forwardTargets.includes(to);
  }
  private trackTaskDisposal(taskId: string, disposal: Promise<void>): void { impl.trackTaskDisposalImpl({ pendingTaskDisposals: this.pendingTaskDisposals }, taskId, disposal); }
  async awaitAbortInFlightTaskWork(...args: FacadeRestArgs<typeof impl.awaitAbortInFlightTaskWorkImpl>): ReturnType<typeof impl.awaitAbortInFlightTaskWorkImpl> { return impl.awaitAbortInFlightTaskWorkImpl(bags.buildAwaitAbortInFlightTaskWorkDeps(this), ...args); }
  async abortAllInFlight(reason: string): Promise<void> { return impl.abortAllInFlightImpl(bags.buildAbortAllInFlightDeps(this), reason); }
  abortAllSessionBash(): void { impl.abortAllSessionBashImpl({ ...facadeFields(this, ["activeSessions", "childSessions", "activeStepExecutors"]) }); }
  private async parkApprovalSuspension(...args: FacadeRestArgs<typeof impl.parkApprovalSuspensionImpl>): ReturnType<typeof impl.parkApprovalSuspensionImpl> { return impl.parkApprovalSuspensionImpl(bags.buildParkApprovalSuspensionDeps(this), ...args); }
  private async dispatchUnpauseResume(task: Task): ReturnType<typeof impl.dispatchUnpauseResumeImpl> { return impl.dispatchUnpauseResumeImpl(bags.buildDispatchUnpauseResumeDeps(this), task); }
  private async resumeApprovalAfterUnwindIfNeeded(...args: FacadeRestArgs<typeof impl.resumeApprovalAfterUnwindIfNeededImpl>): ReturnType<typeof impl.resumeApprovalAfterUnwindIfNeededImpl> { return impl.resumeApprovalAfterUnwindIfNeededImpl(bags.buildResumeApprovalAfterUnwindDeps(this), ...args); }
  private async resolveMcpServers(agentId?: string | null) { return impl.resolveMcpServersImpl({ store: this.store }, agentId); }
  private outerConcurrencyClaims = new Set<string>();
  private async runWithExecutorSemaphore<T>(taskId: string, work: () => Promise<T>): Promise<T> { return impl.runWithExecutorSemaphoreImpl(bags.buildRunWithExecutorSemaphoreDeps(this), taskId, work); }
  setOnExecutorLogFlushed(cb: TaskExecutorOptions["onExecutorLogFlushed"]): void { this.options = { ...this.options, onExecutorLogFlushed: cb }; }
  constructor(private store: TaskStore, private rootDir: string, private options: TaskExecutorOptions = {}) {
    const wired = wireExecutorLifecycle(buildWireExecutorLifecycleDeps(this));
    this.unregisterTaskMoveDisposer = wired.unregisterTaskMoveDisposer;
    this.unregisterArchiveWorktreeDisposer = wired.unregisterArchiveWorktreeDisposer;
    this.unregisterArchiveWorkspaceWorktreeDisposer = wired.unregisterArchiveWorkspaceWorktreeDisposer;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same any-spread posture as facadeMethods
  private storeRunContextDeps(): any { return { ...facadeFields(this, ["store"]), ...facadeMethods(this, ["getRunContextFor"]) }; }
  private async resetMergeStateIfNeeded(task: Task, from: Task["column"]): ReturnType<typeof impl.resetMergeStateIfNeededImpl> { return impl.resetMergeStateIfNeededImpl(bags.buildResetMergeStateIfNeededDeps(this), task, from); }
  private async cleanupMergeStateForReverification(...args: FacadeRestArgs<typeof impl.cleanupMergeStateForReverificationImpl>): ReturnType<typeof impl.cleanupMergeStateForReverificationImpl> { return impl.cleanupMergeStateForReverificationImpl(this.storeRunContextDeps(), ...args); }
  private async clearResumeFailureState(task: Task): ReturnType<typeof impl.clearResumeFailureStateImpl> { return impl.clearResumeFailureStateImpl({ store: this.store }, task); }
  private clearCompletedTaskWatchdog(taskId: string): void { impl.clearCompletedTaskWatchdogImpl(this.completedTaskWatchdogs, taskId); }
  private signalTaskComplete(task: Task): ReturnType<typeof impl.signalTaskCompleteImpl> { return impl.signalTaskCompleteImpl(bags.buildSignalTaskCompleteDeps(this), task); }
  private triggerPostTaskReflectionCapture(task: Task): ReturnType<typeof impl.triggerPostTaskReflectionCaptureImpl> { return impl.triggerPostTaskReflectionCaptureImpl(bags.buildTriggerPostTaskReflectionCaptureDeps(this), task); }
  private clearWorkflowRerunWatchdog(taskId: string): void { impl.clearWorkflowRerunWatchdogImpl(this.workflowRerunWatchdogs, taskId); }
  private scheduleCompletedTaskWatchdog(taskId: string, trigger: string): void { impl.scheduleCompletedTaskWatchdogImpl(bags.buildScheduleCompletedTaskWatchdogDeps(this, constants.COMPLETED_TASK_WATCHDOG_MS), taskId, trigger); }
  private async clearTerminalStepFailuresForRetry(taskId: string): ReturnType<typeof impl.clearTerminalStepFailuresForRetryImpl> { return impl.clearTerminalStepFailuresForRetryImpl(this.storeRunContextDeps(), taskId); }
  private async performWorkflowRerunBounce(...args: FacadeRestArgs<typeof impl.performWorkflowRerunBounceImpl>): ReturnType<typeof impl.performWorkflowRerunBounceImpl> { return impl.performWorkflowRerunBounceImpl(bags.buildPerformWorkflowRerunBounceDeps(this), ...args); }
  private scheduleWorkflowRerun(...args: FacadeRestArgs<typeof impl.scheduleWorkflowRerunImpl>): void { impl.scheduleWorkflowRerunImpl(bags.buildScheduleWorkflowRerunDeps(this, constants.WORKFLOW_RERUN_WATCHDOG_MS), ...args); }
  private completionFinalizationDeps() { return bags.buildCompletionFinalizationFacadeDeps(this); }
  private async parkCompletedBlockedTask(task: Task, completionBlocker: string, source: string, workComplete = pure.isTaskWorkComplete(task)): Promise<boolean> { return impl.parkCompletedBlockedTaskImpl(this.completionFinalizationDeps(), task, completionBlocker, source, workComplete); }
  private async getCompletedTaskFinalizationDecision(taskId: string, taskDone: boolean): ReturnType<typeof impl.getCompletedTaskFinalizationDecisionImpl> { return impl.getCompletedTaskFinalizationDecisionImpl(this.completionFinalizationDeps(), taskId, taskDone); }
  private async shouldFinalizeCompletedTask(taskId: string, taskDone: boolean): ReturnType<typeof impl.shouldFinalizeCompletedTaskImpl> { return impl.shouldFinalizeCompletedTaskImpl(this.completionFinalizationDeps(), taskId, taskDone); }
  private nonContinuableSessionDeps() { return bags.buildNonContinuableSessionFacadeDeps(this); }
  private async handleNonContinuableSessionError(task: Task, taskDone: boolean, errorMessage: string): ReturnType<typeof impl.handleNonContinuableSessionErrorImpl> { return impl.handleNonContinuableSessionErrorImpl(this.nonContinuableSessionDeps(), task, taskDone, errorMessage); }
  private async handleNonContinuableSessionRetry(task: Task, errorMessage: string): ReturnType<typeof impl.handleNonContinuableSessionRetryImpl> { return impl.handleNonContinuableSessionRetryImpl(this.nonContinuableSessionDeps(), task, errorMessage); }
  private async getTaskCompletionBlocker(task: Task): Promise<string | undefined> { return getTaskCompletionBlockerForStore(this.store, task); }
  private async persistTaskTokenUsage(taskId: string, tokenUsage: TaskTokenUsage): ReturnType<typeof impl.persistTaskTokenUsageImpl> { return impl.persistTaskTokenUsageImpl(this.storeRunContextDeps(), taskId, tokenUsage); }
  private async captureExecutorTokenUsageBaseline(taskId: string, session: AgentSession): ReturnType<typeof impl.captureExecutorTokenUsageBaselineImpl> { return impl.captureExecutorTokenUsageBaselineImpl({ tokenUsageBaselines: this.tokenUsageBaselines }, taskId, session); }
  private async persistTokenUsage(...args: FacadeRestArgs<typeof impl.persistTokenUsageImpl>): ReturnType<typeof impl.persistTokenUsageImpl> { return impl.persistTokenUsageImpl(bags.buildPersistTokenUsageDeps(this), ...args); }
  private accumulateTokenUsage(...args: Parameters<typeof impl.accumulateTokenUsageImpl>): ReturnType<typeof impl.accumulateTokenUsageImpl> { return impl.accumulateTokenUsageImpl(...args); }
  private tokenUsageWithModelSnapshot(...args: Parameters<typeof impl.tokenUsageWithModelSnapshotImpl>): ReturnType<typeof impl.tokenUsageWithModelSnapshotImpl> { return impl.tokenUsageWithModelSnapshotImpl(...args); }
  private async extractSessionTokenUsage(...args: Parameters<typeof impl.extractSessionTokenUsageImpl>): ReturnType<typeof impl.extractSessionTokenUsageImpl> { return impl.extractSessionTokenUsageImpl(...args); }
  private async executeReviewHandoff(...args: FacadeRestArgs<typeof impl.executeReviewHandoffImpl>): ReturnType<typeof impl.executeReviewHandoffImpl> { return impl.executeReviewHandoffImpl(bags.buildExecuteReviewHandoffDeps(this), ...args); }
  async recoverCompletedTask(task: Task): Promise<boolean> { return impl.recoverCompletedTaskImpl(bags.buildRecoverCompletedTaskDeps(this), task); }
  private async parkPlanReviewReplanCapExhausted(...args: FacadeRestArgs<typeof impl.parkPlanReviewReplanCapExhaustedImpl>): ReturnType<typeof impl.parkPlanReviewReplanCapExhaustedImpl> { return impl.parkPlanReviewReplanCapExhaustedImpl(this.storeRunContextDeps(), ...args); }
  private async requestPreMergeOptionalStepFix(...args: FacadeRestArgs<typeof impl.requestPreMergeOptionalStepFixImpl>): ReturnType<typeof impl.requestPreMergeOptionalStepFixImpl> { return impl.requestPreMergeOptionalStepFixImpl(bags.buildRequestPreMergeOptionalStepFixDeps(this), ...args); }
  private async recoverMissingRequiredArtifacts(...args: FacadeRestArgs<typeof impl.recoverMissingRequiredArtifactsImpl>): ReturnType<typeof impl.recoverMissingRequiredArtifactsImpl> { return impl.recoverMissingRequiredArtifactsImpl(bags.buildRecoverMissingRequiredArtifactsDeps(this), ...args); }
  private async isRequiredArtifactRecoveryProtected(task: Task): ReturnType<typeof impl.isRequiredArtifactRecoveryProtectedImpl> { return impl.isRequiredArtifactRecoveryProtectedImpl(this.store, (taskId: string) => this.resolveResumeLanes(taskId), task); }
  async recoverFailedPreMergeWorkflowStep(task: Task): Promise<boolean> { return impl.recoverFailedPreMergeWorkflowStepImpl(bags.buildRecoverFailedPreMergeWorkflowStepDeps(this), task); }
  private async shouldDeferForHeartbeat(agentId: string): ReturnType<typeof impl.shouldDeferForHeartbeatImpl> { return impl.shouldDeferForHeartbeatImpl({ agentStore: this.options.agentStore }, agentId); }
  private async getAuthoritativeAssignedAgent(...args: FacadeRestArgs<typeof impl.getAuthoritativeAssignedAgentImpl>): ReturnType<typeof impl.getAuthoritativeAssignedAgentImpl> { return impl.getAuthoritativeAssignedAgentImpl(bags.buildGetAuthoritativeAssignedAgentDeps(this), ...args); }
  private async getAssignedAgentRuntimeConfig(...args: FacadeRestArgs<typeof impl.getAssignedAgentRuntimeConfigImpl>): ReturnType<typeof impl.getAssignedAgentRuntimeConfigImpl> { return impl.getAssignedAgentRuntimeConfigImpl(bags.buildGetAssignedAgentRuntimeConfigDeps(this), ...args); }
  private async listWipLaneTasks(): ReturnType<typeof impl.listWipLaneTasksImpl> { return impl.listWipLaneTasksImpl(this.store); }
  async resumeTaskForAgent(agentId: string): Promise<void> { return impl.resumeTaskForAgentImpl(bags.buildResumeTaskForAgentDeps(this), agentId); }
  private async taskEffectiveAgentMatches(task: Task, agentId: string): ReturnType<typeof impl.taskEffectiveAgentMatchesImpl> { return impl.taskEffectiveAgentMatchesImpl(this.store, task, agentId); }
  async resumeOrphaned(): Promise<void> { return impl.resumeOrphanedImpl(bags.buildResumeOrphanedDeps(this, TaskExecutor.processWideGraphRouting)); }
  private async resolveInstructionsForRole(role: string, settings?: Settings): ReturnType<typeof impl.resolveInstructionsForRoleImpl> { return impl.resolveInstructionsForRoleImpl(bags.buildResolveInstructionsForRoleDeps(this), role, settings); }
  private graphToolFailureRunCursors = new Map<string, number>();
  private graphStepSessionPinned = new Set<string>();
  private graphStepRunOnce = new Map<string, Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }>>();
  private graphStepActiveContext = new Map<string, ForeachActiveContext>();
  private graphRethinkNarrations = new Map<string, string>();
  private graphColumnAgentResolver = new Map<string, (nodeId: string) => WorkflowColumnAgent | undefined>();
  private graphUnattendedRuns = new Set<string>();
  private graphSeamGoverningNodeId = new Map<string, string>();
  private graphSeamThinkingLevel = new Map<string, ThinkingLevel>();
  private graphSeamSkillName = new Map<string, string>();
  private get graphRouting(): Set<string> { return TaskExecutor.processWideGraphRouting; }
  private static processWideGraphRouting = new Set<string>();
  private mergeRequester?: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>;
  setMergeRequester(requestMerge: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>): void { this.mergeRequester = requestMerge; }
  private async executeWorkflowGraph(...args: FacadeRestArgs<typeof impl.executeWorkflowGraphImpl>): ReturnType<typeof impl.executeWorkflowGraphImpl> { return impl.executeWorkflowGraphImpl(bags.buildExecuteWorkflowGraphDeps(this), ...args); }
  private buildBranchPersistence(): ReturnType<typeof impl.buildBranchPersistenceImpl> { return impl.buildBranchPersistenceImpl({ store: this.store }); }
  private buildStepInstancePersistence(): ReturnType<typeof impl.buildStepInstancePersistenceImpl> { return impl.buildStepInstancePersistenceImpl({ store: this.store }); }
  private async advanceNoMergeWorkflowToCompleteColumn(task: TaskDetail): ReturnType<typeof impl.advanceNoMergeWorkflowToCompleteColumnImpl> { return impl.advanceNoMergeWorkflowToCompleteColumnImpl(this.store, task); }
  private buildColumnBoundaryHooks(task: Pick<Task, "id">, workflowRunId?: string): ReturnType<typeof impl.buildColumnBoundaryHooksImpl> { return impl.buildColumnBoundaryHooksImpl(bags.buildColumnBoundaryHooksFacadeDeps(this), task, workflowRunId); }
  private resolveTaskStepSource(ir: WorkflowIr | undefined): { artifact: string; parser: string } | undefined { return impl.resolveTaskStepSourceImpl(ir); }
  private async resolveTaskCustomFieldDefs(taskId: string): ReturnType<typeof impl.resolveTaskCustomFieldDefsImpl> { return impl.resolveTaskCustomFieldDefsImpl({ store: this.store }, taskId); }
  private async readTaskArtifact(taskId: string, key: string): ReturnType<typeof impl.readTaskArtifactImpl> { return impl.readTaskArtifactImpl({ store: this.store }, taskId, key); }
  private buildParseStepsDeps(runId?: string): ReturnType<typeof impl.buildParseStepsDepsImpl> { return impl.buildParseStepsDepsImpl(bags.buildParseStepsFacadeDeps(this), runId); }
  private buildCodeNodeRunner(): ReturnType<typeof impl.buildCodeNodeRunnerImpl> { return impl.buildCodeNodeRunnerImpl(bags.buildCodeNodeRunnerFacadeDeps(this)); }
  private buildForeachWorktreeDeps(...args: FacadeRestArgs<typeof impl.buildForeachWorktreeDepsImpl>): ReturnType<typeof impl.buildForeachWorktreeDepsImpl> { return impl.buildForeachWorktreeDepsImpl(bags.buildBuildForeachWorktreeDepsDeps(this), ...args); }
  private async applyGraphRethinkReset(...args: FacadeRestArgs<typeof impl.applyGraphRethinkResetImpl>): ReturnType<typeof impl.applyGraphRethinkResetImpl> { return impl.applyGraphRethinkResetImpl(bags.buildApplyGraphRethinkResetDeps(this), ...args); }
  private async runImplementationPhase(...args: FacadeRestArgs<typeof impl.runImplementationPhaseImpl>): Promise<{ taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit }> { return impl.runImplementationPhaseImpl(bags.buildRunImplementationPhaseDeps(this), ...args); }
  private async runGraphTaskStep(...args: FacadeRestArgs<typeof impl.runGraphTaskStepImpl>): Promise<{ success: boolean; error?: string; exit?: ImplementationExit }> { return impl.runGraphTaskStepImpl(bags.buildRunGraphTaskStepDeps(this), ...args); }
  private foreachActiveForTask(taskId: string, instanceId?: string): ReturnType<typeof impl.foreachActiveForTaskImpl> { return impl.foreachActiveForTaskImpl({ graphStepActiveContext: this.graphStepActiveContext }, taskId, instanceId); }
  private async runProjectedGraphTaskStep(...args: FacadeRestArgs<typeof impl.runProjectedGraphTaskStepImpl>): ReturnType<typeof impl.runProjectedGraphTaskStepImpl> { return impl.runProjectedGraphTaskStepImpl(bags.buildRunProjectedGraphTaskStepDeps(this), ...args); }
  public createAuthoritativeWorkflowPrimitives(settings: Settings): WorkflowRuntimePrimitives { return createWorkflowRuntimePrimitiveProvider((providerSettings) => this.createAuthoritativeWorkflowPrimitivesFromExecutor(providerSettings)).create(settings); }
  private createAuthoritativeWorkflowPrimitivesFromExecutor(settings: Settings): ReturnType<typeof impl.createAuthoritativeWorkflowPrimitivesFromExecutorImpl> { return impl.createAuthoritativeWorkflowPrimitivesFromExecutorImpl(bags.buildCreateAuthoritativeWorkflowPrimitivesFromExecutorDeps(this), settings); }
  private async resolveMergeBoundaryColumn(taskId: string, nodeId: string): ReturnType<typeof impl.resolveMergeBoundaryColumnImpl> { return impl.resolveMergeBoundaryColumnImpl({ store: this.store }, taskId, nodeId); }
  private async ensureWorkflowMergeBoundaryTask(...args: FacadeRestArgs<typeof impl.ensureWorkflowMergeBoundaryTaskImpl>): ReturnType<typeof impl.ensureWorkflowMergeBoundaryTaskImpl> { return impl.ensureWorkflowMergeBoundaryTaskImpl(bags.buildEnsureWorkflowMergeBoundaryTaskDeps(this), ...args); }
  private async evaluateWorkflowMergeBoundary(...args: FacadeRestArgs<typeof impl.evaluateWorkflowMergeBoundaryImpl>): ReturnType<typeof impl.evaluateWorkflowMergeBoundaryImpl> { return impl.evaluateWorkflowMergeBoundaryImpl(bags.buildEvaluateWorkflowMergeBoundaryDeps(this), ...args); }
  private async loadMergeBoundaryInstances(...args: FacadeRestArgs<typeof impl.loadMergeBoundaryInstancesImpl>): ReturnType<typeof impl.loadMergeBoundaryInstancesImpl> { return impl.loadMergeBoundaryInstancesImpl({ store: this.store }, ...args); }
  private async getWorkflowMergeImplementationProofFailure(...args: FacadeRestArgs<typeof impl.getWorkflowMergeImplementationProofFailureImpl>): ReturnType<typeof impl.getWorkflowMergeImplementationProofFailureImpl> { return impl.getWorkflowMergeImplementationProofFailureImpl(bags.buildWorkflowMergeImplementationProofFailureDeps(this), ...args); }
  private shouldCompleteChecklistAtWorkflowMerge(task: TaskDetail, proof?: { complete: boolean }): ReturnType<typeof impl.shouldCompleteChecklistAtWorkflowMergeImpl> { return impl.shouldCompleteChecklistAtWorkflowMergeImpl(task, proof); }
  public createAuthoritativeWorkflowSeams(_settings: Settings): WorkflowLegacySeams { return impl.createAuthoritativeWorkflowSeamsImpl(bags.buildCreateAuthoritativeWorkflowSeamsDeps(this), _settings); }
  private async updateStepGraph(...args: FacadeRestArgs<typeof impl.updateStepGraphImpl>): ReturnType<typeof impl.updateStepGraphImpl> { return impl.updateStepGraphImpl({ store: this.store }, ...args); }
  private async runAwaitInputNode(node: WorkflowIrNode, live: TaskDetail): ReturnType<typeof impl.runAwaitInputNodeImpl> { return impl.runAwaitInputNodeImpl(this.storeRunContextDeps(), node, live); }
  private async pauseForCliApproval(node: WorkflowIrNode, live: TaskDetail, command: string): ReturnType<typeof impl.pauseForCliApprovalImpl> { return impl.pauseForCliApprovalImpl(this.storeRunContextDeps(), node, live, command); }
  private async runRawCliCommand(...args: FacadeRestArgs<typeof impl.runRawCliCommandImpl>): Promise<{ success: boolean; output?: string; error?: string }> { return impl.runRawCliCommandImpl(bags.buildRunRawCliCommandDeps(this, pure.runConfiguredCommand), ...args); }
  private async adoptColumnAgentForNode(...args: FacadeRestArgs<typeof impl.adoptColumnAgentForNodeImpl>): Promise<{ modelProvider?: string; modelId?: string; persona?: string } | undefined> { return impl.adoptColumnAgentForNodeImpl(bags.buildAdoptColumnAgentForNodeDeps(this), ...args); }
  private async resolveSeamColumnAgent(...args: FacadeRestArgs<typeof impl.resolveSeamColumnAgentImpl>): Promise<{ agent: Agent; mode: WorkflowColumnAgent["mode"] | undefined } | undefined> { return impl.resolveSeamColumnAgentImpl(bags.buildResolveSeamColumnAgentDeps(this), ...args); }
  private resolveEffectivePrincipalId(...args: FacadeRestArgs<typeof impl.resolveEffectivePrincipalIdImpl>): ReturnType<typeof impl.resolveEffectivePrincipalIdImpl> { return impl.resolveEffectivePrincipalIdImpl(bags.buildResolveEffectivePrincipalIdDeps(this), ...args); }
  isAgentEffectivelyExecuting(agentId: string): boolean { return impl.isAgentEffectivelyExecutingImpl(this.effectiveColumnAgentByTask, agentId); }
  private async buildInjectedRuntimeEnv(...args: FacadeRestArgs<typeof impl.buildInjectedRuntimeEnvImpl>): Promise<{ env: NodeJS.ProcessEnv; injectedKeyCount: number; pathEntryCount: number }> { return impl.buildInjectedRuntimeEnvImpl(bags.buildInjectedRuntimeEnvDeps(this), ...args); }
  private async ensureGraphCustomNodeWorktree(...args: FacadeRestArgs<typeof impl.ensureGraphCustomNodeWorktreeImpl>): ReturnType<typeof impl.ensureGraphCustomNodeWorktreeImpl> { return impl.ensureGraphCustomNodeWorktreeImpl(bags.buildEnsureGraphCustomNodeWorktreeDeps(this, pure.runConfiguredCommand), ...args); }
  public async releasePreExecutionWorktree(...args: FacadeRestArgs<typeof impl.releasePreExecutionWorktreeImpl>): ReturnType<typeof impl.releasePreExecutionWorktreeImpl> { return impl.releasePreExecutionWorktreeImpl(bags.buildReleasePreExecutionWorktreeDeps(this), ...args); }
  public async ensureTaskWorktreeForPlanning(taskId: string): Promise<string | null> { return impl.ensureTaskWorktreeForPlanningImpl(bags.buildEnsureTaskWorktreeForPlanningDeps(this), taskId); }
  private async prepareGraphNodeExecution(...args: FacadeRestArgs<typeof impl.prepareGraphNodeExecutionImpl>): ReturnType<typeof impl.prepareGraphNodeExecutionImpl> { return impl.prepareGraphNodeExecutionImpl(bags.buildPrepareGraphNodeExecutionDeps(this), ...args); }
  private async finalizeMergeConfirmedWorkflowGraphTask(...args: FacadeRestArgs<typeof impl.finalizeMergeConfirmedWorkflowGraphTaskImpl>): ReturnType<typeof impl.finalizeMergeConfirmedWorkflowGraphTaskImpl> { return impl.finalizeMergeConfirmedWorkflowGraphTaskImpl(bags.buildFinalizeMergeConfirmedWorkflowGraphTaskDeps(this), ...args); }
  private async runGraphCustomNode(...args: FacadeRestArgs<typeof impl.runGraphCustomNodeImpl>): ReturnType<typeof impl.runGraphCustomNodeImpl> { return impl.runGraphCustomNodeImpl(bags.buildRunGraphCustomNodeDeps(this), ...args); }
  private async runCliAgentNode(...args: FacadeRestArgs<typeof impl.runCliAgentNodeImpl>): ReturnType<typeof impl.runCliAgentNodeImpl> { return impl.runCliAgentNodeImpl(bags.buildRunCliAgentNodeDeps(this), ...args); }
  private async reapCliTaskSessionForHandoff(session: CliTaskSession, taskId: string): ReturnType<typeof impl.reapCliTaskSessionForHandoffImpl> { return impl.reapCliTaskSessionForHandoffImpl(session, taskId); }
  private sessionContentionHoldAttempts = new Map<string, number>();
  private clearSessionContentionHold(taskId: string): void { this.sessionContentionHoldAttempts.delete(taskId); }
  private async holdForSessionContention(...args: FacadeRestArgs<typeof impl.holdForSessionContentionImpl>): ReturnType<typeof impl.holdForSessionContentionImpl> { return impl.holdForSessionContentionImpl(bags.buildHoldForSessionContentionDeps(this), ...args); }
  private async routeUnusableWorktreeGraphFailureToRecovery(...args: FacadeRestArgs<typeof impl.routeUnusableWorktreeGraphFailureToRecoveryImpl>): ReturnType<typeof impl.routeUnusableWorktreeGraphFailureToRecoveryImpl> { return impl.routeUnusableWorktreeGraphFailureToRecoveryImpl(bags.buildRouteUnusableWorktreeGraphFailureToRecoveryDeps(this), ...args); }
  private hasLiveTaskSessionSurface(taskId: string): ReturnType<typeof impl.hasLiveTaskSessionSurfaceImpl> { return impl.hasLiveTaskSessionSurfaceImpl(bags.buildHasLiveTaskSessionSurfaceDeps(this), taskId); }
  private async isRemediationGraphNode(taskId: string, failedNode: string | undefined): ReturnType<typeof impl.isRemediationGraphNodeImpl> { return impl.isRemediationGraphNodeImpl({ store: this.store }, taskId, failedNode); }
  private async isPreMergeRemediationGraphNode(taskId: string, failedNode: string | undefined): ReturnType<typeof impl.isPreMergeRemediationGraphNodeImpl> { return impl.isPreMergeRemediationGraphNodeImpl({ store: this.store }, taskId, failedNode); }
  private async resolveFailedPreMergeWorkflowStepBudget(...args: FacadeAfterFirst<typeof impl.resolveFailedPreMergeWorkflowStepBudgetImpl>): ReturnType<typeof impl.resolveFailedPreMergeWorkflowStepBudgetImpl> { return impl.resolveFailedPreMergeWorkflowStepBudgetImpl({ store: this.store }, ...args); }
  private async isLiveSharedBranchGroupMember(live: Pick<TaskDetail, "branchContext">): ReturnType<typeof impl.isLiveSharedBranchGroupMemberImpl> { return impl.isLiveSharedBranchGroupMemberImpl({ store: this.store, rootDir: this.rootDir }, live); }
  private async routeRetryableRemediationGraphFailureToPreMergeFix(...args: FacadeRestArgs<typeof impl.routeRetryableRemediationGraphFailureToPreMergeFixImpl>): ReturnType<typeof impl.routeRetryableRemediationGraphFailureToPreMergeFixImpl> { return impl.routeRetryableRemediationGraphFailureToPreMergeFixImpl(bags.buildRouteRetryableRemediationGraphFailureToPreMergeFixDeps(this), ...args); }
  private async isRetryableBenignMergePauseAbort(...args: FacadeRestArgs<typeof impl.isRetryableBenignMergePauseAbortImpl>): ReturnType<typeof impl.isRetryableBenignMergePauseAbortImpl> { return impl.isRetryableBenignMergePauseAbortImpl(bags.buildResumeLaneClassifierDeps(this), ...args); }
  private async isBenignManualMergeHoldPauseAbort(...args: FacadeRestArgs<typeof impl.isBenignManualMergeHoldPauseAbortImpl>): ReturnType<typeof impl.isBenignManualMergeHoldPauseAbortImpl> { return impl.isBenignManualMergeHoldPauseAbortImpl(bags.buildResumeLaneClassifierDeps(this), ...args); }
  private async handleStaleInReviewPlanPauseAbortReplay(...args: FacadeRestArgs<typeof impl.handleStaleInReviewPlanPauseAbortReplayImpl>): ReturnType<typeof impl.handleStaleInReviewPlanPauseAbortReplayImpl> { return impl.handleStaleInReviewPlanPauseAbortReplayImpl(bags.buildHandleStaleInReviewPlanPauseAbortReplayDeps(this), ...args); }
  private async handleStaleInReviewParsePauseAbortReplay(...args: FacadeRestArgs<typeof impl.handleStaleInReviewParsePauseAbortReplayImpl>): ReturnType<typeof impl.handleStaleInReviewParsePauseAbortReplayImpl> { return impl.handleStaleInReviewParsePauseAbortReplayImpl(bags.buildHandleStaleInReviewParsePauseAbortReplayDeps(this), ...args); }
  private async isReentrantPausedAbortedInFlightNode(...args: FacadeRestArgs<typeof impl.isReentrantPausedAbortedInFlightNodeImpl>): ReturnType<typeof impl.isReentrantPausedAbortedInFlightNodeImpl> { return impl.isReentrantPausedAbortedInFlightNodeImpl(bags.buildResumeLaneClassifierDeps(this), ...args); }
  private async resolveResumeLanes(...args: FacadeRestArgs<typeof impl.resolveResumeLanesImpl>): Promise<{ hold: string; wip: string; review: string; wipDeclared: boolean }> { return impl.resolveResumeLanesImpl({ store: this.store }, ...args); }
  private async reenterPausedAbortedWorkflowNode(...args: FacadeRestArgs<typeof impl.reenterPausedAbortedWorkflowNodeImpl>): ReturnType<typeof impl.reenterPausedAbortedWorkflowNodeImpl> { return impl.reenterPausedAbortedWorkflowNodeImpl(bags.buildReenterPausedAbortedWorkflowNodeDeps(this), ...args); }
  private async routeGraphMergeFailureToRetry(...args: FacadeRestArgs<typeof impl.routeGraphMergeFailureToRetryImpl>): ReturnType<typeof impl.routeGraphMergeFailureToRetryImpl> { return impl.routeGraphMergeFailureToRetryImpl(bags.buildRouteGraphMergeFailureToRetryDeps(this), ...args); }
  private async routeImplementationIncompleteMergeGraphFailure(...args: FacadeRestArgs<typeof impl.routeImplementationIncompleteMergeGraphFailureImpl>): ReturnType<typeof impl.routeImplementationIncompleteMergeGraphFailureImpl> { return impl.routeImplementationIncompleteMergeGraphFailureImpl(bags.buildRouteImplementationIncompleteMergeGraphFailureDeps(this), ...args); }
  private async hasTrailingConsecutiveToolFailures(taskId: string, cursor: number | null | undefined, threshold: number): ReturnType<typeof impl.hasTrailingConsecutiveToolFailuresImpl> { return impl.hasTrailingConsecutiveToolFailuresImpl({ store: this.store }, taskId, cursor, threshold); }
  private async handleGraphFailure(task: Task, result: WorkflowGraphTaskRunResult): ReturnType<typeof impl.handleGraphFailureImpl> { return impl.handleGraphFailureImpl(bags.buildHandleGraphFailureDeps(this), task, result); }
  private async routeGraphFailureToExecutionResume(...args: FacadeRestArgs<typeof impl.routeGraphFailureToExecutionResumeImpl>): ReturnType<typeof impl.routeGraphFailureToExecutionResumeImpl> { return impl.routeGraphFailureToExecutionResumeImpl(bags.buildRouteGraphFailureToExecutionResumeDeps(this), ...args); }
  private async routeResetParsePinMismatchToRetry(live: TaskDetail): ReturnType<typeof impl.routeResetParsePinMismatchToRetryImpl> { return impl.routeResetParsePinMismatchToRetryImpl(bags.buildRouteResetParsePinMismatchToRetryDeps(this), live); }
  private async maybeDispatchWorkflowWorkEngine(task: Task): ReturnType<typeof impl.maybeDispatchWorkflowWorkEngineImpl> { return impl.maybeDispatchWorkflowWorkEngineImpl({ store: this.store }, task); }
  private async evaluateTaskVerdictProviders(...args: FacadeRestArgs<typeof impl.evaluateTaskVerdictProvidersImpl>): Promise<{ ok: true } | { ok: false; message: string }> { return impl.evaluateTaskVerdictProvidersImpl({ store: this.store }, ...args); }
  private async blockOuterDispatchWhenDependenciesUnmet(task: Task): ReturnType<typeof impl.blockOuterDispatchWhenDependenciesUnmetImpl> { return impl.blockOuterDispatchWhenDependenciesUnmetImpl(this.storeRunContextDeps(), task); }
  private async blockOuterDispatchWhenEphemeralDisabled(task: Task): ReturnType<typeof impl.blockOuterDispatchWhenEphemeralDisabledImpl> { return impl.blockOuterDispatchWhenEphemeralDisabledImpl(bags.buildBlockOuterDispatchWhenEphemeralDisabledDeps(this), task); }
  async execute(task: Task): Promise<void> {
    try { await this.executeCore(task); }
    finally { if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release(); }
  }
  private async executeCore(task: Task): ReturnType<typeof impl.executeCoreImpl> { return impl.executeCoreImpl(bags.buildExecuteCoreDeps(this), task); }
  private async runImplementation(...args: FacadeRestArgs<typeof impl.runImplementationImpl>): ReturnType<typeof impl.runImplementationImpl> { return impl.runImplementationImpl(bags.buildRunImplementationFacadeDeps(this), ...args); }
  private sharedWorkerToolsDeps(): import("./executor/shared-worker-tools.js").SharedWorkerToolsDeps { return bags.buildSharedWorkerToolsDeps(this); }
  private createTaskUpdateTool(...args: FacadeRestArgs<typeof impl.createTaskUpdateToolImpl>): ReturnType<typeof impl.createTaskUpdateToolImpl> { return impl.createTaskUpdateToolImpl(bags.buildCreateTaskUpdateToolDeps(this), ...args); }
  private createTaskAddDepTool(taskId: string): ReturnType<typeof impl.createTaskAddDepToolImpl> { return impl.createTaskAddDepToolImpl(bags.buildCreateTaskAddDepToolDeps(this), taskId); }
  private async transitionReviewAddressing(taskId: string, from: Array<"queued" | "in-progress" | "addressed" | "failed">, to: "queued" | "in-progress" | "addressed" | "failed"): ReturnType<typeof impl.transitionReviewAddressingImpl> { return impl.transitionReviewAddressingImpl(this.store, taskId, from, to); }
  private worktreeInvariantDeps() { return bags.buildWorktreeInvariantFacadeDeps(this); }
  private async verifyWorktreeInvariants(...args: FacadeRestArgs<typeof impl.verifyWorktreeInvariantsImpl>): ReturnType<typeof impl.verifyWorktreeInvariantsImpl> { return impl.verifyWorktreeInvariantsImpl(this.worktreeInvariantDeps(), ...args); }
  private async evaluateTaskDoneScopeLeak(...args: FacadeRestArgs<typeof impl.evaluateTaskDoneScopeLeakImpl>): ReturnType<typeof impl.evaluateTaskDoneScopeLeakImpl> { return impl.evaluateTaskDoneScopeLeakImpl(bags.buildEvaluateTaskDoneScopeLeakDeps(this), ...args); }
  private async handleImplicitTaskDoneRefusal(...args: FacadeRestArgs<typeof impl.handleImplicitTaskDoneRefusalImpl>): ReturnType<typeof impl.handleImplicitTaskDoneRefusalImpl> { return impl.handleImplicitTaskDoneRefusalImpl(bags.buildHandleImplicitTaskDoneRefusalDeps(this), ...args); }
  private createTaskDoneTool(...args: FacadeRestArgs<typeof impl.createTaskDoneToolImpl>): ReturnType<typeof impl.createTaskDoneToolImpl> { return impl.createTaskDoneToolImpl(bags.buildCreateTaskDoneToolDeps(this), ...args); }
  private async handleDepAbortCleanup(taskId: string, worktreePath: string): ReturnType<typeof impl.handleDepAbortCleanupImpl> { return impl.handleDepAbortCleanupImpl(bags.buildHandleDepAbortCleanupDeps(this), taskId, worktreePath); }
  private async reopenLastStepForRevision(...args: FacadeAfterFirst<typeof impl.reopenLastStepForRevisionImpl>): Promise<{ index: number; name: string; indexes: number[] } | null> { return impl.reopenLastStepForRevisionImpl(this.store, ...args); }
  private async runExecutorDeterministicVerification(...args: FacadeRestArgs<typeof impl.runExecutorDeterministicVerificationImpl>): ReturnType<typeof impl.runExecutorDeterministicVerificationImpl> { return impl.runExecutorDeterministicVerificationImpl(this.storeRunContextDeps(), ...args); }
  private async attemptExecutorVerificationFix(...args: FacadeRestArgs<typeof impl.attemptExecutorVerificationFixImpl>): ReturnType<typeof impl.attemptExecutorVerificationFixImpl> { return impl.attemptExecutorVerificationFixImpl(bags.buildAttemptExecutorVerificationFixDeps(this), ...args); }
  private async sendTaskBackForFix(...args: FacadeRestArgs<typeof impl.sendTaskBackForFixImpl>): ReturnType<typeof impl.sendTaskBackForFixImpl> { return impl.sendTaskBackForFixImpl(bags.buildSendTaskBackForFixDeps(this, constants.MAX_WORKFLOW_STEP_RETRIES), ...args); }
  private async injectWorkflowStepFailureInstructions(...args: FacadeAfterFirst<typeof impl.injectWorkflowStepFailureInstructionsImpl>): ReturnType<typeof impl.injectWorkflowStepFailureInstructionsImpl> { return impl.injectWorkflowStepFailureInstructionsImpl(this.store, ...args); }
  private async captureModifiedFiles(...args: Parameters<typeof impl.captureModifiedFilesImpl>): ReturnType<typeof impl.captureModifiedFilesImpl> { return impl.captureModifiedFilesImpl(...args); }
  private async captureWorkspaceModifiedFiles(...args: Parameters<typeof impl.captureWorkspaceModifiedFilesImpl>): ReturnType<typeof impl.captureWorkspaceModifiedFilesImpl> { return impl.captureWorkspaceModifiedFilesImpl(...args); }
  private async reviewWorkspacePerRepo(...args: Parameters<typeof impl.reviewWorkspacePerRepoImpl>): ReturnType<typeof impl.reviewWorkspacePerRepoImpl> { return impl.reviewWorkspacePerRepoImpl(...args); }
  private async captureUncommittedModifiedFiles(worktreePath: string): ReturnType<typeof impl.captureUncommittedModifiedFilesImpl> { return impl.captureUncommittedModifiedFilesImpl(worktreePath); }
  private async executeScriptWorkflowStep(...args: FacadeRestArgs<typeof impl.executeScriptWorkflowStepImpl>): Promise<{ success: boolean; output?: string; error?: string }> { return impl.executeScriptWorkflowStepImpl(bags.buildExecuteScriptWorkflowStepDeps(this, pure.runConfiguredCommand), ...args); }
  private workflowInputRepliesAfterWatermark(task: TaskDetail, marker: string): Array<{ createdAt?: string }> { return impl.workflowInputRepliesAfterWatermarkImpl(task, marker); }
  private async resolveWorkflowInputMarkerForGraphNode(live: TaskDetail, nodeId: string): ReturnType<typeof impl.resolveWorkflowInputMarkerForGraphNodeImpl> { return impl.resolveWorkflowInputMarkerForGraphNodeImpl(this.storeRunContextDeps(), live, nodeId); }
  private async executeWorkflowStep(...args: FacadeRestArgs<typeof impl.executeWorkflowStepImpl>): ReturnType<typeof impl.executeWorkflowStepImpl> { return impl.executeWorkflowStepImpl(bags.buildExecuteWorkflowStepDeps(this), ...args); }
  private async tryBootstrapMisbindingRecovery(...args: FacadeRestArgs<typeof impl.tryBootstrapMisbindingRecoveryImpl>): ReturnType<typeof impl.tryBootstrapMisbindingRecoveryImpl> { return impl.tryBootstrapMisbindingRecoveryImpl(bags.buildTryBootstrapMisbindingRecoveryDeps(this), ...args); }
  private branchConflictHandleDeps() { return bags.buildBranchConflictHandleFacadeDeps(this); }
  private async reclaimExistingWorktree(...args: FacadeRestArgs<typeof impl.reclaimExistingWorktreeImpl>): ReturnType<typeof impl.reclaimExistingWorktreeImpl> { return impl.reclaimExistingWorktreeImpl(this.branchConflictHandleDeps(), ...args); }
  private async handleBranchConflict(...args: FacadeRestArgs<typeof impl.handleBranchConflictImpl>): ReturnType<typeof impl.handleBranchConflictImpl> { return impl.handleBranchConflictImpl(this.branchConflictHandleDeps(), ...args); }
  private async recoverMissingWorktreeSessionStartFailure(...args: FacadeRestArgs<typeof impl.recoverMissingWorktreeSessionStartFailureImpl>): ReturnType<typeof impl.recoverMissingWorktreeSessionStartFailureImpl> { return impl.recoverMissingWorktreeSessionStartFailureImpl(bags.buildRecoverMissingWorktreeSessionStartFailureDeps(this), ...args); }
  private async emitWorktreeReanchoredAudit(...args: FacadeRestArgs<typeof impl.emitWorktreeReanchoredAuditImpl>): ReturnType<typeof impl.emitWorktreeReanchoredAuditImpl> { return impl.emitWorktreeReanchoredAuditImpl(this.storeRunContextDeps(), ...args); }
  listWorktreeHolders(): Array<{ taskId: string; worktreePath: string }> { return impl.listWorktreeHoldersImpl(this.activeWorktrees); }
  private hasActiveWorktreeBinding(taskId: string, worktreePath: string): boolean { return pure.hasActiveWorktreeBinding(this.activeWorktrees, taskId, worktreePath); }
  private async shouldGenerateNewWorktreeName(conflictPath: string, currentTaskId: string): Promise<boolean> { return pure.shouldGenerateNewWorktreeName(this.activeWorktrees, this.store, conflictPath, currentTaskId); }
  private async findActiveWorktreeOwner(worktreePath: string, requestingTaskId: string): Promise<string | null> { return pure.findActiveWorktreeOwner(this.activeWorktrees, this.store, worktreePath, requestingTaskId); }
  private async isLiveCleanupRefusal(worktreePath: string, taskId: string): Promise<boolean> { return pure.isLiveCleanupRefusal(this.activeWorktrees, this.store, worktreePath, taskId); }
  private async cleanupStaleBranch(branch: string, taskId: string): Promise<boolean> { return pure.cleanupStaleBranch(this.rootDir, this.store, branch, taskId); }
  private async planSquashImportFromDep(...args: FacadeAfterSecond<typeof pure.planSquashImportFromDep>): ReturnType<typeof pure.planSquashImportFromDep> { return pure.planSquashImportFromDep(this.rootDir, this.store, ...args); }
  private async reconcileSelfOwnedBeforeRemove(...args: FacadeRestArgs<typeof pure.reconcileSelfOwnedBeforeRemove>): ReturnType<typeof pure.reconcileSelfOwnedBeforeRemove> { return pure.reconcileSelfOwnedBeforeRemove(this.store, ...args); }
  private staleLockRecoveryDeps() { return bags.buildStaleLockRecoveryDeps(this); }
  private async emitStaleLockAudit(...args: FacadeRestArgs<typeof pure.emitStaleLockAudit>): ReturnType<typeof pure.emitStaleLockAudit> { return pure.emitStaleLockAudit(this.staleLockRecoveryDeps(), ...args); }
  private async recoverIndexLockIfStale(taskId: string, path: string, conflictInfo: { lockPath?: string; message?: string }): Promise<boolean> { return pure.recoverIndexLockIfStale(this.staleLockRecoveryDeps(), taskId, path, conflictInfo); }
  private async recoverStaleRegistration(taskId: string, path: string, conflictInfo: { path?: string; message?: string }): Promise<boolean> { return pure.recoverExecutorStaleRegistration(this.staleLockRecoveryDeps(), taskId, path, conflictInfo); }
  private async normalizeReclaimableWorktreePath(...args: FacadeRestArgs<typeof pure.normalizeReclaimableWorktreePath>): ReturnType<typeof pure.normalizeReclaimableWorktreePath> { return pure.normalizeReclaimableWorktreePath(bags.buildNormalizeReclaimableWorktreePathDeps(this), ...args); }
  private async tryFreshWorktreeAfterLiveConflict(...args: FacadeRestArgs<typeof pure.tryFreshWorktreeAfterLiveConflict>): Promise<{ path: string; branch: string }> { return pure.tryFreshWorktreeAfterLiveConflict(bags.buildTryFreshWorktreeAfterLiveConflictDeps(this, bindTryCreateWorktree(this)), ...args); }
  private worktreeCreateConflictDeps(): import("./executor/worktree-create-conflict.js").WorktreeCreateConflictDeps { return bags.buildWorktreeCreateConflictFacadeDeps(this, constants.MAX_WORKTREE_RETRIES, bindHandleWorktreeConflict(this), bindTryCreateWorktree(this)); }
  private async tryCreateWorktree(...args: FacadeRestArgs<typeof impl.tryCreateWorktreeImpl>): Promise<{ path: string; branch: string }> { return impl.tryCreateWorktreeImpl(this.worktreeCreateConflictDeps(), ...args); }
  private async handleWorktreeConflict(...args: FacadeRestArgs<typeof impl.handleWorktreeConflictImpl>): Promise<{ path: string; branch: string } | null> { return impl.handleWorktreeConflictImpl(this.worktreeCreateConflictDeps(), ...args); }
  private async cleanupConflictingWorktree(...args: FacadeRestArgs<typeof impl.cleanupConflictingWorktreeImpl>): ReturnType<typeof impl.cleanupConflictingWorktreeImpl> { return impl.cleanupConflictingWorktreeImpl(bags.buildCleanupConflictingWorktreeDeps(this), ...args); }
  private async resolveWorktreeStartPoint(startPoint: string, taskId: string): ReturnType<typeof impl.resolveWorktreeStartPointImpl> { return impl.resolveWorktreeStartPointImpl(this.rootDir, this.store, startPoint, taskId); }
  private async squashImportDepIntoWorktree(...args: FacadeAfterFirst<typeof impl.squashImportDepIntoWorktreeImpl>): ReturnType<typeof impl.squashImportDepIntoWorktreeImpl> { return impl.squashImportDepIntoWorktreeImpl(this.store, ...args); }
  private async rebaseNewWorktreeOntoRemote(...args: FacadeAfterSecond<typeof impl.rebaseNewWorktreeOntoRemoteImpl>): ReturnType<typeof impl.rebaseNewWorktreeOntoRemoteImpl> { return impl.rebaseNewWorktreeOntoRemoteImpl(this.rootDir, this.store, ...args); }
  private async createWorktree(...args: FacadeRestArgs<typeof impl.createWorktreeImpl>): Promise<{ path: string; branch: string }> { return impl.createWorktreeImpl(bags.buildCreateWorktreeFacadeDeps(this, bindTryCreateWorktree(this)), ...args); }
  private async removeOwnWorktreeWithReconcile(...args: FacadeRestArgs<typeof pure.removeOwnWorktreeWithReconcile>): ReturnType<typeof pure.removeOwnWorktreeWithReconcile> { return pure.removeOwnWorktreeWithReconcile(bags.buildRemoveOwnWorktreeWithReconcileDeps(this), ...args); }
  disposeStoreLifecycleDisposers(): void { impl.disposeStoreLifecycleDisposersImpl(bags.buildDisposeStoreLifecycleDisposersDeps(this)); }
  async cleanup(taskId: string): Promise<void> { return impl.cleanupTaskWorktreeImpl(bags.buildCleanupTaskWorktreeDeps(this), taskId); }
  private async recoverApprovedStepsOnResume(taskId: string): ReturnType<typeof impl.recoverApprovedStepsOnResumeImpl> { return impl.recoverApprovedStepsOnResumeImpl(this.store, taskId); }
  private async reconcileStepsFromGitHistory(taskId: string, detail: TaskDetail, worktreePath: string): ReturnType<typeof impl.reconcileStepsFromGitHistoryImpl> { return impl.reconcileStepsFromGitHistoryImpl(bags.buildReconcileStepsFromGitHistoryDeps(this), taskId, detail, worktreePath); }
  private async resetStepsIfWorkLost(task: Task): ReturnType<typeof impl.resetStepsIfWorkLostImpl> { return impl.resetStepsIfWorkLostImpl(bags.buildResetStepsIfWorkLostDeps(this), task); }
  private async resetLostWorkStepProgress(task: Task, completedStepCount: number, reason: string): ReturnType<typeof impl.resetLostWorkStepProgressImpl> { return impl.resetLostWorkStepProgressImpl({ store: this.store }, task, completedStepCount, reason); }
  markStuckAborted(...args: FacadeRestArgs<typeof impl.markStuckAbortedImpl>): ReturnType<typeof impl.markStuckAbortedImpl> { return impl.markStuckAbortedImpl(bags.buildMarkStuckAbortedDeps(this), ...args); }
  async handleLoopDetected(...args: FacadeRestArgs<typeof impl.handleLoopDetectedImpl>): ReturnType<typeof impl.handleLoopDetectedImpl> { return impl.handleLoopDetectedImpl(bags.buildHandleLoopDetectedDeps(this), ...args); }
  getWorktreePath(taskId: string): string | undefined { return impl.getWorktreePathImpl(this.workspaceConfig, (id) => this.getActiveWorktreePaths(id), taskId); }
  private async terminateAllChildren(parentTaskId: string): ReturnType<typeof impl.terminateAllChildrenImpl> { return impl.terminateAllChildrenImpl(bags.buildTerminateAllChildrenDeps(this), parentTaskId); }
  private async terminateChildAgent(childId: string): ReturnType<typeof impl.terminateChildAgentImpl> { return impl.terminateChildAgentImpl(bags.buildTerminateChildAgentDeps(this), childId); }
  private async runSpawnedChild(...args: FacadeRestArgs<typeof impl.runSpawnedChildImpl>): ReturnType<typeof impl.runSpawnedChildImpl> { return impl.runSpawnedChildImpl(bags.buildRunSpawnedChildDeps(this), ...args); }
  private createSpawnAgentTool(...args: FacadeRestArgs<typeof impl.createSpawnAgentToolImpl>): ReturnType<typeof impl.createSpawnAgentToolImpl> { return impl.createSpawnAgentToolImpl(bags.buildCreateSpawnAgentToolDeps(this), ...args); }
}

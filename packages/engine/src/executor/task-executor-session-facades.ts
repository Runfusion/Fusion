/**
 * FNXC:CodeOrganization 2026-08-04-08:15:
 * Active-session / step / CLI / configured-command bookkeeping facades peeled from
 * TaskExecutor (U4). Sits above pure worktree facades so executor.ts stays impl/bags thin.
 */
import * as impl from "./impl-bindings.js";
import * as bags from "./deps-bags.js";
import * as constants from "./executor-constants.js";
import { facadeFields, facadeMethods, type FacadeRestArgs } from "./facade-methods.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
import { getTaskCompletionBlockerForStore } from "../execution/task-completion.js";
import { buildWorkflowFailureScopeGuard } from "./workflow-failure-scope-guard.js";
import { resolveAuthoritativeExternalExecutionRoute } from "./resolve-authoritative-external-execution-route.js";
import { TaskExecutorWorktreePureFacades } from "./task-executor-worktree-pure-facades.js";

export abstract class TaskExecutorSessionFacades extends TaskExecutorWorktreePureFacades {
  protected addActiveWorktree(taskId: string, worktreePath: string): void { impl.addActiveWorktreeImpl(this.activeWorktrees, taskId, worktreePath); }
  protected getActiveWorktreePaths(taskId: string): ReturnType<typeof impl.getActiveWorktreePathsImpl> { return impl.getActiveWorktreePathsImpl(this.activeWorktrees, taskId); }
  protected sessionRegistryPath(taskId: string, worktreePath: string): ReturnType<typeof impl.sessionRegistryPathImpl> { return impl.sessionRegistryPathImpl(this.rootDir, taskId, worktreePath); }
  protected acquireSessionRegistryPath(...args: FacadeRestArgs<typeof impl.acquireSessionRegistryPathImpl>): void { impl.acquireSessionRegistryPathImpl(bags.buildAcquireSessionRegistryPathDeps(this), ...args); }
  protected setActiveSession(taskId: string, sessionState: Parameters<typeof impl.setActiveSessionImpl>[2], worktreePath: string): void { impl.setActiveSessionImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, sessionState, worktreePath); }
  protected markGraphExecuteSelfRequeued(taskId: string): void { impl.markGraphExecuteSelfRequeuedImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId); }
  protected deleteActiveSession(taskId: string, worktreePath?: string): void { impl.deleteActiveSessionImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, worktreePath); }
  protected setActiveStepExecutor(taskId: string, stepExecutor: Parameters<typeof impl.setActiveStepExecutorImpl>[2], worktreePath: string, seenSteeringIds = new Set<string>()): void { impl.setActiveStepExecutorImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, stepExecutor, worktreePath, seenSteeringIds); }
  protected deleteActiveStepExecutor(taskId: string, worktreePath?: string): void { impl.deleteActiveStepExecutorImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, worktreePath); }
  protected setActiveWorkflowStepSession(taskId: string, session: Parameters<typeof impl.setActiveWorkflowStepSessionImpl>[2], worktreePath: string, seenSteeringIds = new Set<string>()): void { impl.setActiveWorkflowStepSessionImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, session, worktreePath, seenSteeringIds); }
  protected deleteActiveWorkflowStepSession(taskId: string, worktreePath?: string): void { impl.deleteActiveWorkflowStepSessionImpl(bags.buildActiveSessionBookkeepingDeps(this), taskId, worktreePath); }
  protected registerConfiguredCommandController(taskId: string, controller: AbortController): void { impl.registerConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller); }
  protected unregisterConfiguredCommandController(taskId: string, controller: AbortController): void { impl.unregisterConfiguredCommandControllerImpl(this.activeConfiguredCommandControllers, taskId, controller); }
  protected registerSubagentSession(taskId: string, session: Parameters<typeof impl.registerSubagentSessionImpl>[2]): void { impl.registerSubagentSessionImpl(this.activeSubagentSessions, taskId, session); }
  protected unregisterSubagentSession(taskId: string, session: Parameters<typeof impl.unregisterSubagentSessionImpl>[2]): void { impl.unregisterSubagentSessionImpl(this.activeSubagentSessions, taskId, session); }
  protected disposeSubagentsForTask(taskId: string, reason: string): void { impl.disposeSubagentsForTaskImpl(this.activeSubagentSessions, taskId, reason); }
  protected getRunContextFor(taskId: string) { return this.currentRunContexts.get(taskId); }
  protected safeLogEntry(taskId: string, message: string): void { impl.safeLogEntryImpl(bags.buildStoreRunContextDeps(this), taskId, message); }
  protected markPausedAborted(...args: FacadeRestArgs<typeof impl.markPausedAbortedImpl>): void { impl.markPausedAbortedImpl(bags.buildMarkPausedAbortedDeps(this), ...args); }
  protected markCompletionFinalized(taskId: string): void { impl.markCompletionFinalizedImpl(bags.buildPauseAbortMarkerDeps(this), taskId); }
  protected clearPausedAborted(taskId: string): void { impl.clearPausedAbortedImpl(bags.buildPauseAbortMarkerDeps(this), taskId); }
  protected async clearStalePauseAbortBeforeDispatch(task: import("@fusion/core").Task): ReturnType<typeof impl.clearStalePauseAbortBeforeDispatchImpl> { return impl.clearStalePauseAbortBeforeDispatchImpl(bags.buildClearStalePauseAbortBeforeDispatchDeps(this), task); }
  clearPauseAbortStateForManualRetry(taskId: string): void { impl.clearPauseAbortStateForManualRetryImpl({ clearPausedAborted: (id: string) => this.clearPausedAborted(id) }, taskId); }
  protected trackTaskDisposal(taskId: string, disposal: Promise<void>): void { impl.trackTaskDisposalImpl({ pendingTaskDisposals: this.pendingTaskDisposals }, taskId, disposal); }
  isEphemeralDeletionPending(agentId: string): boolean { return impl.isEphemeralDeletionPendingImpl(this.pendingEphemeralDeletions, agentId); }
  disposeEphemeralTimers(): void { impl.disposeEphemeralTimersImpl(this.pendingEphemeralDeletions); }
  getExecutingTaskIds(): Set<string> { return impl.getExecutingTaskIdsImpl(bags.buildTaskLivenessDeps(this)); }
  hasActivePlanningWorkflowSession(taskId: string): boolean { return impl.hasActivePlanningWorkflowSessionImpl(bags.buildTaskLivenessDeps(this), taskId); }
  isTaskActive(taskId: string): boolean { return impl.isTaskActiveImpl(bags.buildTaskLivenessDeps(this), taskId); }
  isTaskLiveForOverseerRetry(taskId: string): boolean {
    return impl.isTaskLiveForOverseerRetryImpl({
      ...facadeFields(this, ["resumingUnpaused"]),
      ...facadeMethods(this, ["isTaskActive", "hasLiveTaskSessionSurface"]),
    }, taskId);
  }
  hasLiveSessionSurface(taskId: string): boolean {
    return impl.hasLiveSessionSurfaceImpl(bags.buildHasLiveSessionSurfaceDeps(this, (id) => activeSessionRegistry.pathsForTask(id)), taskId);
  }
  clearPhantomExecutorBinding(taskId: string, options: { preserveWorktrees?: boolean } = {}): boolean {
    return impl.clearPhantomExecutorBindingImpl(bags.buildClearPhantomExecutorBindingDeps(this), taskId, options);
  }
  async awaitAbortInFlightTaskWork(...args: FacadeRestArgs<typeof impl.awaitAbortInFlightTaskWorkImpl>): ReturnType<typeof impl.awaitAbortInFlightTaskWorkImpl> { return impl.awaitAbortInFlightTaskWorkImpl(bags.buildAwaitAbortInFlightTaskWorkDeps(this), ...args); }
  async abortAllInFlight(reason: string): Promise<void> { return impl.abortAllInFlightImpl(bags.buildAbortAllInFlightDeps(this), reason); }
  abortAllSessionBash(): void { impl.abortAllSessionBashImpl({ ...facadeFields(this, ["activeSessions", "childSessions", "activeStepExecutors"]) }); }
  protected async parkApprovalSuspension(...args: FacadeRestArgs<typeof impl.parkApprovalSuspensionImpl>): ReturnType<typeof impl.parkApprovalSuspensionImpl> { return impl.parkApprovalSuspensionImpl(bags.buildParkApprovalSuspensionDeps(this), ...args); }
  protected async dispatchUnpauseResume(task: import("@fusion/core").Task): ReturnType<typeof impl.dispatchUnpauseResumeImpl> { return impl.dispatchUnpauseResumeImpl(bags.buildDispatchUnpauseResumeDeps(this), task); }
  protected async resumeApprovalAfterUnwindIfNeeded(...args: FacadeRestArgs<typeof impl.resumeApprovalAfterUnwindIfNeededImpl>): ReturnType<typeof impl.resumeApprovalAfterUnwindIfNeededImpl> { return impl.resumeApprovalAfterUnwindIfNeededImpl(bags.buildResumeApprovalAfterUnwindDeps(this), ...args); }
  protected async resolveMcpServers(agentId?: string | null) { return impl.resolveMcpServersImpl({ store: this.store }, agentId); }
  protected async runWithExecutorSemaphore<T>(taskId: string, work: () => Promise<T>): Promise<T> { return impl.runWithExecutorSemaphoreImpl(bags.buildRunWithExecutorSemaphoreDeps(this), taskId, work); }
  protected clearCompletedTaskWatchdog(taskId: string): void { impl.clearCompletedTaskWatchdogImpl(this.completedTaskWatchdogs, taskId); }
  protected clearWorkflowRerunWatchdog(taskId: string): void { impl.clearWorkflowRerunWatchdogImpl(this.workflowRerunWatchdogs, taskId); }
  protected async persistTaskTokenUsage(taskId: string, tokenUsage: Parameters<typeof impl.persistTaskTokenUsageImpl>[2]): ReturnType<typeof impl.persistTaskTokenUsageImpl> { return impl.persistTaskTokenUsageImpl(bags.buildStoreRunContextDeps(this), taskId, tokenUsage); }
  protected async captureExecutorTokenUsageBaseline(taskId: string, session: Parameters<typeof impl.captureExecutorTokenUsageBaselineImpl>[2]): ReturnType<typeof impl.captureExecutorTokenUsageBaselineImpl> { return impl.captureExecutorTokenUsageBaselineImpl({ tokenUsageBaselines: this.tokenUsageBaselines }, taskId, session); }
  protected async persistTokenUsage(...args: FacadeRestArgs<typeof impl.persistTokenUsageImpl>): ReturnType<typeof impl.persistTokenUsageImpl> { return impl.persistTokenUsageImpl(bags.buildPersistTokenUsageDeps(this), ...args); }
  protected accumulateTokenUsage(...args: Parameters<typeof impl.accumulateTokenUsageImpl>): ReturnType<typeof impl.accumulateTokenUsageImpl> { return impl.accumulateTokenUsageImpl(...args); }
  protected tokenUsageWithModelSnapshot(...args: Parameters<typeof impl.tokenUsageWithModelSnapshotImpl>): ReturnType<typeof impl.tokenUsageWithModelSnapshotImpl> { return impl.tokenUsageWithModelSnapshotImpl(...args); }
  protected async extractSessionTokenUsage(...args: Parameters<typeof impl.extractSessionTokenUsageImpl>): ReturnType<typeof impl.extractSessionTokenUsageImpl> { return impl.extractSessionTokenUsageImpl(...args); }
  protected signalTaskComplete(task: import("@fusion/core").Task): ReturnType<typeof impl.signalTaskCompleteImpl> { return impl.signalTaskCompleteImpl(bags.buildSignalTaskCompleteDeps(this), task); }
  protected triggerPostTaskReflectionCapture(task: import("@fusion/core").Task): ReturnType<typeof impl.triggerPostTaskReflectionCaptureImpl> { return impl.triggerPostTaskReflectionCaptureImpl(bags.buildTriggerPostTaskReflectionCaptureDeps(this), task); }
  protected scheduleCompletedTaskWatchdog(taskId: string, trigger: string): void { impl.scheduleCompletedTaskWatchdogImpl(bags.buildScheduleCompletedTaskWatchdogDeps(this, constants.COMPLETED_TASK_WATCHDOG_MS), taskId, trigger); }
  protected async clearTerminalStepFailuresForRetry(taskId: string): ReturnType<typeof impl.clearTerminalStepFailuresForRetryImpl> { return impl.clearTerminalStepFailuresForRetryImpl(bags.buildStoreRunContextDeps(this), taskId); }
  protected async performWorkflowRerunBounce(...args: FacadeRestArgs<typeof impl.performWorkflowRerunBounceImpl>): ReturnType<typeof impl.performWorkflowRerunBounceImpl> { return impl.performWorkflowRerunBounceImpl(bags.buildPerformWorkflowRerunBounceDeps(this), ...args); }
  protected scheduleWorkflowRerun(...args: FacadeRestArgs<typeof impl.scheduleWorkflowRerunImpl>): void { impl.scheduleWorkflowRerunImpl(bags.buildScheduleWorkflowRerunDeps(this, constants.WORKFLOW_RERUN_WATCHDOG_MS), ...args); }
  protected async parkCompletedBlockedTask(...args: FacadeRestArgs<typeof impl.parkCompletedBlockedTaskImpl>): ReturnType<typeof impl.parkCompletedBlockedTaskImpl> { return impl.parkCompletedBlockedTaskImpl(bags.buildCompletionFinalizationFacadeDeps(this), ...args); }
  protected async getCompletedTaskFinalizationDecision(taskId: string, taskDone: boolean): ReturnType<typeof impl.getCompletedTaskFinalizationDecisionImpl> { return impl.getCompletedTaskFinalizationDecisionImpl(bags.buildCompletionFinalizationFacadeDeps(this), taskId, taskDone); }
  protected async shouldFinalizeCompletedTask(taskId: string, taskDone: boolean): ReturnType<typeof impl.shouldFinalizeCompletedTaskImpl> { return impl.shouldFinalizeCompletedTaskImpl(bags.buildCompletionFinalizationFacadeDeps(this), taskId, taskDone); }
  protected async handleNonContinuableSessionError(task: import("@fusion/core").Task, taskDone: boolean, errorMessage: string): ReturnType<typeof impl.handleNonContinuableSessionErrorImpl> { return impl.handleNonContinuableSessionErrorImpl(bags.buildNonContinuableSessionFacadeDeps(this), task, taskDone, errorMessage); }
  protected async handleNonContinuableSessionRetry(task: import("@fusion/core").Task, errorMessage: string): ReturnType<typeof impl.handleNonContinuableSessionRetryImpl> { return impl.handleNonContinuableSessionRetryImpl(bags.buildNonContinuableSessionFacadeDeps(this), task, errorMessage); }
  protected async getTaskCompletionBlocker(task: import("@fusion/core").Task) { return getTaskCompletionBlockerForStore(this.store, task); }
  protected async executeReviewHandoff(...args: FacadeRestArgs<typeof impl.executeReviewHandoffImpl>): ReturnType<typeof impl.executeReviewHandoffImpl> { return impl.executeReviewHandoffImpl(bags.buildExecuteReviewHandoffDeps(this), ...args); }
  async recoverCompletedTask(task: import("@fusion/core").Task): Promise<boolean> { return impl.recoverCompletedTaskImpl(bags.buildRecoverCompletedTaskDeps(this), task); }
  protected async parkPlanReviewReplanCapExhausted(...args: FacadeRestArgs<typeof impl.parkPlanReviewReplanCapExhaustedImpl>): ReturnType<typeof impl.parkPlanReviewReplanCapExhaustedImpl> { return impl.parkPlanReviewReplanCapExhaustedImpl(bags.buildStoreRunContextDeps(this), ...args); }
  protected async requestPreMergeOptionalStepFix(...args: FacadeRestArgs<typeof impl.requestPreMergeOptionalStepFixImpl>): ReturnType<typeof impl.requestPreMergeOptionalStepFixImpl> { return impl.requestPreMergeOptionalStepFixImpl(bags.buildRequestPreMergeOptionalStepFixDeps(this), ...args); }
  protected async recoverMissingRequiredArtifacts(...args: FacadeRestArgs<typeof impl.recoverMissingRequiredArtifactsImpl>): ReturnType<typeof impl.recoverMissingRequiredArtifactsImpl> { return impl.recoverMissingRequiredArtifactsImpl(bags.buildRecoverMissingRequiredArtifactsDeps(this), ...args); }
  async recoverFailedPreMergeWorkflowStep(task: import("@fusion/core").Task): Promise<boolean> { return impl.recoverFailedPreMergeWorkflowStepImpl(bags.buildRecoverFailedPreMergeWorkflowStepDeps(this), task); }
  protected async shouldDeferForHeartbeat(agentId: string): ReturnType<typeof impl.shouldDeferForHeartbeatImpl> { return impl.shouldDeferForHeartbeatImpl({ agentStore: this.options.agentStore }, agentId); }
  protected async getAuthoritativeAssignedAgent(...args: FacadeRestArgs<typeof impl.getAuthoritativeAssignedAgentImpl>): ReturnType<typeof impl.getAuthoritativeAssignedAgentImpl> { return impl.getAuthoritativeAssignedAgentImpl(bags.buildGetAuthoritativeAssignedAgentDeps(this), ...args); }
  protected async getAssignedAgentRuntimeConfig(...args: FacadeRestArgs<typeof impl.getAssignedAgentRuntimeConfigImpl>): ReturnType<typeof impl.getAssignedAgentRuntimeConfigImpl> { return impl.getAssignedAgentRuntimeConfigImpl(bags.buildGetAssignedAgentRuntimeConfigDeps(this), ...args); }
  protected async listWipLaneTasks(): ReturnType<typeof impl.listWipLaneTasksImpl> { return impl.listWipLaneTasksImpl(this.store); }
  async resumeTaskForAgent(agentId: string): Promise<void> { return impl.resumeTaskForAgentImpl(bags.buildResumeTaskForAgentDeps(this), agentId); }
  protected async taskEffectiveAgentMatches(task: import("@fusion/core").Task, agentId: string): ReturnType<typeof impl.taskEffectiveAgentMatchesImpl> { return impl.taskEffectiveAgentMatchesImpl(this.store, task, agentId); }
  async resumeOrphaned(): Promise<void> { return impl.resumeOrphanedImpl(bags.buildResumeOrphanedDeps(this)); }
  protected async resolveInstructionsForRole(role: string, settings?: import("@fusion/core").Settings): ReturnType<typeof impl.resolveInstructionsForRoleImpl> { return impl.resolveInstructionsForRoleImpl(bags.buildResolveInstructionsForRoleDeps(this), role, settings); }
  markStuckAborted(...args: FacadeRestArgs<typeof impl.markStuckAbortedImpl>): ReturnType<typeof impl.markStuckAbortedImpl> { return impl.markStuckAbortedImpl(bags.buildMarkStuckAbortedDeps(this), ...args); }
  async handleLoopDetected(...args: FacadeRestArgs<typeof impl.handleLoopDetectedImpl>): ReturnType<typeof impl.handleLoopDetectedImpl> { return impl.handleLoopDetectedImpl(bags.buildHandleLoopDetectedDeps(this), ...args); }
  protected async terminateAllChildren(parentTaskId: string): ReturnType<typeof impl.terminateAllChildrenImpl> { return impl.terminateAllChildrenImpl(bags.buildTerminateAllChildrenDeps(this), parentTaskId); }
  protected async terminateChildAgent(childId: string): ReturnType<typeof impl.terminateChildAgentImpl> { return impl.terminateChildAgentImpl(bags.buildTerminateChildAgentDeps(this), childId); }
  protected async runSpawnedChild(...args: FacadeRestArgs<typeof impl.runSpawnedChildImpl>): ReturnType<typeof impl.runSpawnedChildImpl> { return impl.runSpawnedChildImpl(bags.buildRunSpawnedChildDeps(this), ...args); }
  protected createSpawnAgentTool(...args: FacadeRestArgs<typeof impl.createSpawnAgentToolImpl>): ReturnType<typeof impl.createSpawnAgentToolImpl> { return impl.createSpawnAgentToolImpl(bags.buildCreateSpawnAgentToolDeps(this), ...args); }
  protected async captureModifiedFiles(...args: Parameters<typeof impl.captureModifiedFilesImpl>): ReturnType<typeof impl.captureModifiedFilesImpl> { return impl.captureModifiedFilesImpl(...args); }
  protected async captureWorkspaceModifiedFiles(...args: Parameters<typeof impl.captureWorkspaceModifiedFilesImpl>): ReturnType<typeof impl.captureWorkspaceModifiedFilesImpl> { return impl.captureWorkspaceModifiedFilesImpl(...args); }
  protected async reviewWorkspacePerRepo(...args: Parameters<typeof impl.reviewWorkspacePerRepoImpl>): ReturnType<typeof impl.reviewWorkspacePerRepoImpl> { return impl.reviewWorkspacePerRepoImpl(...args); }
  protected async captureUncommittedModifiedFiles(worktreePath: string): ReturnType<typeof impl.captureUncommittedModifiedFilesImpl> { return impl.captureUncommittedModifiedFilesImpl(worktreePath); }
  protected createTaskUpdateTool(...args: FacadeRestArgs<typeof impl.createTaskUpdateToolImpl>): ReturnType<typeof impl.createTaskUpdateToolImpl> { return impl.createTaskUpdateToolImpl(bags.buildCreateTaskUpdateToolDeps(this), ...args); }
  protected createTaskAddDepTool(taskId: string): ReturnType<typeof impl.createTaskAddDepToolImpl> { return impl.createTaskAddDepToolImpl(bags.buildCreateTaskAddDepToolDeps(this), taskId); }
  protected async transitionReviewAddressing(taskId: string, from: Array<"queued" | "in-progress" | "addressed" | "failed">, to: "queued" | "in-progress" | "addressed" | "failed"): ReturnType<typeof impl.transitionReviewAddressingImpl> { return impl.transitionReviewAddressingImpl(this.store, taskId, from, to); }
  protected async verifyWorktreeInvariants(...args: FacadeRestArgs<typeof impl.verifyWorktreeInvariantsImpl>): ReturnType<typeof impl.verifyWorktreeInvariantsImpl> { return impl.verifyWorktreeInvariantsImpl(bags.buildWorktreeInvariantFacadeDeps(this), ...args); }
  protected async evaluateTaskDoneScopeLeak(...args: FacadeRestArgs<typeof impl.evaluateTaskDoneScopeLeakImpl>): ReturnType<typeof impl.evaluateTaskDoneScopeLeakImpl> { return impl.evaluateTaskDoneScopeLeakImpl(bags.buildEvaluateTaskDoneScopeLeakDeps(this), ...args); }
  protected async handleImplicitTaskDoneRefusal(...args: FacadeRestArgs<typeof impl.handleImplicitTaskDoneRefusalImpl>): ReturnType<typeof impl.handleImplicitTaskDoneRefusalImpl> { return impl.handleImplicitTaskDoneRefusalImpl(bags.buildHandleImplicitTaskDoneRefusalDeps(this), ...args); }
  protected createTaskDoneTool(...args: FacadeRestArgs<typeof impl.createTaskDoneToolImpl>): ReturnType<typeof impl.createTaskDoneToolImpl> { return impl.createTaskDoneToolImpl(bags.buildCreateTaskDoneToolDeps(this), ...args); }
  /*
  FNXC:CodeOrganization 2026-08-09-22:15:
  Instance method mirrors main's private helper so tests/callers that touch the executor instance keep working.
  */
  protected buildWorkflowFailureScopeGuard(task: import("@fusion/core").Task, promptContent: string): string {
    return buildWorkflowFailureScopeGuard(task, promptContent);
  }
  /*
  FNXC:PlanReviewNoOp 2026-08-09-22:10:
  CLOSE_NO_OP terminalization (FN-8841) — protected so graph runner + tests can exercise the race fence.
  */
  protected async finalizeAcceptedNoOpCompletion(...args: FacadeRestArgs<typeof impl.finalizeAcceptedNoOpCompletionImpl>): ReturnType<typeof impl.finalizeAcceptedNoOpCompletionImpl> {
    return impl.finalizeAcceptedNoOpCompletionImpl(bags.buildFinalizeAcceptedNoOpCompletionDeps(this), ...args);
  }
  protected async completePlanReviewNoOp(...args: FacadeRestArgs<typeof impl.completePlanReviewNoOpImpl>): ReturnType<typeof impl.completePlanReviewNoOpImpl> {
    return impl.completePlanReviewNoOpImpl(bags.buildFinalizeAcceptedNoOpCompletionDeps(this), ...args);
  }
  protected async holdPlanReviewNoOpContinuation(...args: FacadeRestArgs<typeof impl.holdPlanReviewNoOpContinuationImpl>): ReturnType<typeof impl.holdPlanReviewNoOpContinuationImpl> {
    return impl.holdPlanReviewNoOpContinuationImpl({ store: this.store }, ...args);
  }
  /*
  FNXC:ExternalExecutionCheckout 2026-08-09-22:43:
  Re-read durable external checkout routing before execution/cleanup (tests call this instance method).
  */
  protected async resolveAuthoritativeExternalExecutionRoute(task: import("@fusion/core").Task) {
    return resolveAuthoritativeExternalExecutionRoute(this.store, task);
  }
  protected async handleDepAbortCleanup(taskId: string, worktreePath: string): ReturnType<typeof impl.handleDepAbortCleanupImpl> { return impl.handleDepAbortCleanupImpl(bags.buildHandleDepAbortCleanupDeps(this), taskId, worktreePath); }
  protected async reopenLastStepForRevision(...args: import("./facade-methods.js").FacadeAfterFirst<typeof impl.reopenLastStepForRevisionImpl>): Promise<{ index: number; name: string; indexes: number[] } | null> { return impl.reopenLastStepForRevisionImpl(this.store, ...args); }
  protected async runExecutorDeterministicVerification(...args: FacadeRestArgs<typeof impl.runExecutorDeterministicVerificationImpl>): ReturnType<typeof impl.runExecutorDeterministicVerificationImpl> { return impl.runExecutorDeterministicVerificationImpl(bags.buildStoreRunContextDeps(this), ...args); }
  protected async attemptExecutorVerificationFix(...args: FacadeRestArgs<typeof impl.attemptExecutorVerificationFixImpl>): ReturnType<typeof impl.attemptExecutorVerificationFixImpl> { return impl.attemptExecutorVerificationFixImpl(bags.buildAttemptExecutorVerificationFixDeps(this), ...args); }
  protected async sendTaskBackForFix(...args: FacadeRestArgs<typeof impl.sendTaskBackForFixImpl>): ReturnType<typeof impl.sendTaskBackForFixImpl> { return impl.sendTaskBackForFixImpl(bags.buildSendTaskBackForFixDeps(this, constants.MAX_WORKFLOW_STEP_RETRIES), ...args); }
  protected async injectWorkflowStepFailureInstructions(...args: import("./facade-methods.js").FacadeAfterFirst<typeof impl.injectWorkflowStepFailureInstructionsImpl>): ReturnType<typeof impl.injectWorkflowStepFailureInstructionsImpl> { return impl.injectWorkflowStepFailureInstructionsImpl(this.store, ...args); }
  protected async executeScriptWorkflowStep(...args: FacadeRestArgs<typeof impl.executeScriptWorkflowStepImpl>): Promise<{ success: boolean; output?: string; error?: string }> { return impl.executeScriptWorkflowStepImpl(bags.buildExecuteScriptWorkflowStepDeps(this), ...args); }
  protected workflowInputRepliesAfterWatermark(task: import("@fusion/core").TaskDetail, marker: string): Array<{ createdAt?: string }> { return impl.workflowInputRepliesAfterWatermarkImpl(task, marker); }
  protected async resolveWorkflowInputMarkerForGraphNode(live: import("@fusion/core").TaskDetail, nodeId: string): ReturnType<typeof impl.resolveWorkflowInputMarkerForGraphNodeImpl> { return impl.resolveWorkflowInputMarkerForGraphNodeImpl(bags.buildStoreRunContextDeps(this), live, nodeId); }
  protected async executeWorkflowStep(...args: FacadeRestArgs<typeof impl.executeWorkflowStepImpl>): ReturnType<typeof impl.executeWorkflowStepImpl> { return impl.executeWorkflowStepImpl(bags.buildExecuteWorkflowStepDeps(this), ...args); }
  protected async tryBootstrapMisbindingRecovery(...args: FacadeRestArgs<typeof impl.tryBootstrapMisbindingRecoveryImpl>): ReturnType<typeof impl.tryBootstrapMisbindingRecoveryImpl> { return impl.tryBootstrapMisbindingRecoveryImpl(bags.buildTryBootstrapMisbindingRecoveryDeps(this), ...args); }
  protected async recoverApprovedStepsOnResume(taskId: string): ReturnType<typeof impl.recoverApprovedStepsOnResumeImpl> { return impl.recoverApprovedStepsOnResumeImpl(this.store, taskId); }
  protected async reconcileStepsFromGitHistory(taskId: string, detail: import("@fusion/core").TaskDetail, worktreePath: string): ReturnType<typeof impl.reconcileStepsFromGitHistoryImpl> { return impl.reconcileStepsFromGitHistoryImpl(bags.buildReconcileStepsFromGitHistoryDeps(this), taskId, detail, worktreePath); }
  protected async resetStepsIfWorkLost(task: import("@fusion/core").Task): ReturnType<typeof impl.resetStepsIfWorkLostImpl> { return impl.resetStepsIfWorkLostImpl(bags.buildResetStepsIfWorkLostDeps(this), task); }
  protected async resetLostWorkStepProgress(task: import("@fusion/core").Task, completedStepCount: number, reason: string): ReturnType<typeof impl.resetLostWorkStepProgressImpl> { return impl.resetLostWorkStepProgressImpl({ store: this.store }, task, completedStepCount, reason); }
}

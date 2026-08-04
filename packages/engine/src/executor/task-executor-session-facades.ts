/**
 * FNXC:CodeOrganization 2026-08-04-08:15:
 * Active-session / step / CLI / configured-command bookkeeping facades peeled from
 * TaskExecutor (U4). Sits above pure worktree facades so executor.ts stays impl/bags thin.
 */
import * as impl from "./impl-bindings.js";
import * as bags from "./deps-bags.js";
import { facadeFields, facadeMethods, type FacadeRestArgs } from "./facade-methods.js";
import { activeSessionRegistry } from "../agents/active-session-registry.js";
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
}

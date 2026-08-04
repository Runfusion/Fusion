// port-4040-allowlist: never kill port 4040. FNXC:CodeOrganization 2026-08-04-08:00: facade imports + single reexport barrel (U4).
export * from "./executor/executor-reexports.js";
import {
  type TaskStore, type Task, type MergeResult, type TaskMoveLanes, resolvePlannerLanes,
  dropPreHeldExecutorSlot, impl, bags, type FacadeRestArgs,
  wireTaskExecutorLifecycle, type TaskExecutorOptions, TaskExecutorGraphFacades,
} from "./executor/task-executor-imports.js";
export class TaskExecutor extends TaskExecutorGraphFacades {
  private getAutoRecoveryDispatcher(audit: Parameters<typeof impl.getAutoRecoveryDispatcherImpl>[1]): ReturnType<typeof impl.getAutoRecoveryDispatcherImpl> { return impl.getAutoRecoveryDispatcherImpl(bags.buildGetAutoRecoveryDispatcherDeps(this), audit); }
  private async renewTaskLease(...args: FacadeRestArgs<typeof impl.renewTaskLeaseImpl>): ReturnType<typeof impl.renewTaskLeaseImpl> { return impl.renewTaskLeaseImpl(bags.buildRenewTaskLeaseDeps(this), ...args); }
  private async finalizeAlreadyReviewedTask(taskId: string): ReturnType<typeof impl.finalizeAlreadyReviewedTaskImpl> { return impl.finalizeAlreadyReviewedTaskImpl(bags.buildFinalizeAlreadyReviewedTaskDeps(this), taskId); }
  private async getExecutionPauseLabel(): ReturnType<typeof impl.getExecutionPauseLabelImpl> { return impl.getExecutionPauseLabelImpl({ store: this.store }); }
  private async shouldDeferCompletionForGlobalPause(...args: FacadeRestArgs<typeof impl.shouldDeferCompletionForGlobalPauseImpl>): ReturnType<typeof impl.shouldDeferCompletionForGlobalPauseImpl> { return impl.shouldDeferCompletionForGlobalPauseImpl(bags.buildShouldDeferCompletionForGlobalPauseDeps(this), ...args); }
  private async shouldDeferWorkflowStepCompletion(...args: FacadeRestArgs<typeof impl.shouldDeferWorkflowStepCompletionImpl>): ReturnType<typeof impl.shouldDeferWorkflowStepCompletionImpl> { return impl.shouldDeferWorkflowStepCompletionImpl(bags.buildShouldDeferWorkflowStepCompletionDeps(this), ...args); }
  private async handoffTaskToReview(...args: FacadeRestArgs<typeof impl.handoffTaskToReviewImpl>): ReturnType<typeof impl.handoffTaskToReviewImpl> { return impl.handoffTaskToReviewImpl(bags.buildHandoffTaskToReviewDeps(this), ...args); }
  private async generateCompletionFeatureVideo(task: Task): ReturnType<typeof impl.generateCompletionFeatureVideoImpl> { return impl.generateCompletionFeatureVideoImpl(bags.buildGenerateCompletionFeatureVideoDeps(this), task); }
  private async awaitFeatureVideoBounded(result: Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult>): Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult> { return impl.awaitFeatureVideoBoundedImpl(result); }
  private getModelRegistry() { return impl.getModelRegistryImpl({ getModelRegistryCache: () => this._modelRegistry, setModelRegistryCache: (value) => { this._modelRegistry = value; } }); }
  private get approvalRequestStore() { return impl.getApprovalRequestStoreImpl({ getCache: () => this._approvalRequestStore, setCache: (value) => { this._approvalRequestStore = value; }, store: this.store }); }
  private buildActionGateContext(...args: FacadeRestArgs<typeof impl.buildActionGateContextImpl>): ReturnType<typeof impl.buildActionGateContextImpl> { return impl.buildActionGateContextImpl(bags.buildBuildActionGateContextDeps(this), ...args); }
  private buildPermanentAgentGatingContext(...args: FacadeRestArgs<typeof impl.buildPermanentAgentGatingContextImpl>): ReturnType<typeof impl.buildPermanentAgentGatingContextImpl> { return impl.buildPermanentAgentGatingContextImpl(bags.buildBuildPermanentAgentGatingContextDeps(this), ...args); }
  private isBackwardMoveOutOfPlanning(taskId: string, from: string, to: string, moveLanes: TaskMoveLanes | undefined): boolean { const sync = moveLanes ? undefined : resolvePlannerLanes(this.store, taskId); const lanes = { hold: moveLanes?.hold ?? sync?.hold ?? "todo", intake: moveLanes?.intake ?? sync?.intake ?? "triage", wip: moveLanes?.wip ?? sync?.wip ?? "in-progress", review: moveLanes?.review ?? sync?.review ?? "in-review", complete: moveLanes?.complete ?? sync?.complete ?? "done" }; return (from === lanes.hold || from === lanes.intake) && ![lanes.wip, lanes.review, lanes.complete].filter((c): c is string => typeof c === "string").includes(to); }
  setOnExecutorLogFlushed(cb: TaskExecutorOptions["onExecutorLogFlushed"]): void { this.options = { ...this.options, onExecutorLogFlushed: cb }; }
  constructor(store: TaskStore, rootDir: string, options: TaskExecutorOptions = {}) { super(); this.store = store; this.rootDir = rootDir; this.options = options; wireTaskExecutorLifecycle(this); }
  private async resetMergeStateIfNeeded(task: Task, from: Task["column"]): ReturnType<typeof impl.resetMergeStateIfNeededImpl> { return impl.resetMergeStateIfNeededImpl(bags.buildResetMergeStateIfNeededDeps(this), task, from); }
  private async cleanupMergeStateForReverification(...args: FacadeRestArgs<typeof impl.cleanupMergeStateForReverificationImpl>): ReturnType<typeof impl.cleanupMergeStateForReverificationImpl> { return impl.cleanupMergeStateForReverificationImpl(bags.buildStoreRunContextDeps(this), ...args); }
  private async clearResumeFailureState(task: Task): ReturnType<typeof impl.clearResumeFailureStateImpl> { return impl.clearResumeFailureStateImpl({ store: this.store }, task); }
  private async isRequiredArtifactRecoveryProtected(task: Task): ReturnType<typeof impl.isRequiredArtifactRecoveryProtectedImpl> { return impl.isRequiredArtifactRecoveryProtectedImpl(this.store, (taskId: string) => this.resolveResumeLanes(taskId), task); }
  setMergeRequester(requestMerge: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>): void { this.mergeRequester = requestMerge; }
  async execute(task: Task): Promise<void> { try { await this.executeCore(task); } finally { if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release(); } }
  private async executeCore(task: Task): ReturnType<typeof impl.executeCoreImpl> { return impl.executeCoreImpl(bags.buildExecuteCoreDeps(this), task); }
  private async runImplementation(...args: FacadeRestArgs<typeof impl.runImplementationImpl>): ReturnType<typeof impl.runImplementationImpl> { return impl.runImplementationImpl(bags.buildRunImplementationFacadeDeps(this), ...args); }
}

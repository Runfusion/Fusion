/**
 * FNXC:CodeOrganization 2026-08-03-21:15:
 * Impl-aliased re-exports for TaskExecutor facades (U4).
 * Keeps executor.ts free of per-module Impl import lines.
 */

export {
  accumulateTokenUsage as accumulateTokenUsageImpl,
  tokenUsageWithModelSnapshot as tokenUsageWithModelSnapshotImpl,
  extractSessionTokenUsage as extractSessionTokenUsageImpl,
} from "./token-usage-pure.js";
export {
  tryCreateWorktree as tryCreateWorktreeImpl,
  handleWorktreeConflict as handleWorktreeConflictImpl,
} from "./worktree-create-conflict.js";
export { cleanupConflictingWorktree as cleanupConflictingWorktreeImpl } from "./worktree-cleanup-conflicting.js";
export {
  createWorktree as createWorktreeImpl,
  squashImportDepIntoWorktree as squashImportDepIntoWorktreeImpl,
  rebaseNewWorktreeOntoRemote as rebaseNewWorktreeOntoRemoteImpl,
  resolveWorktreeStartPoint as resolveWorktreeStartPointImpl,
} from "./worktree-create-outer.js";
export {
  reclaimExistingWorktree as reclaimExistingWorktreeImpl,
  handleBranchConflict as handleBranchConflictImpl,
} from "./worktree-branch-conflict-handle.js";
export { recoverMissingWorktreeSessionStartFailure as recoverMissingWorktreeSessionStartFailureImpl } from "./worktree-missing-session-recovery.js";
export {
  verifyWorktreeInvariants as verifyWorktreeInvariantsImpl,
  emitWorktreeReanchoredAudit as emitWorktreeReanchoredAuditImpl,
} from "./worktree-verify-invariants.js";
export { evaluateTaskDoneScopeLeak as evaluateTaskDoneScopeLeakImpl } from "./worktree-task-done-scope-leak.js";
export {
  captureModifiedFiles as captureModifiedFilesImpl,
  captureWorkspaceModifiedFiles as captureWorkspaceModifiedFilesImpl,
  captureUncommittedModifiedFiles as captureUncommittedModifiedFilesImpl,
} from "./worktree-capture-modified-files.js";
export { executeScriptWorkflowStep as executeScriptWorkflowStepImpl } from "./workflow-script-step.js";
export { reviewWorkspacePerRepo as reviewWorkspacePerRepoImpl } from "./workspace-review-per-repo.js";
export {
  workflowInputRepliesAfterWatermark as workflowInputRepliesAfterWatermarkImpl,
  resolveWorkflowInputMarkerForGraphNode as resolveWorkflowInputMarkerForGraphNodeImpl,
} from "./workflow-input-markers.js";
export {
  parkCompletedBlockedTask as parkCompletedBlockedTaskImpl,
  getCompletedTaskFinalizationDecision as getCompletedTaskFinalizationDecisionImpl,
  shouldFinalizeCompletedTask as shouldFinalizeCompletedTaskImpl,
} from "./completion-finalization.js";
export {
  handleNonContinuableSessionError as handleNonContinuableSessionErrorImpl,
  handleNonContinuableSessionRetry as handleNonContinuableSessionRetryImpl,
} from "./non-continuable-session.js";
export { createTaskAddDepTool as createTaskAddDepToolImpl } from "./task-add-dep-tool.js";
export { handleImplicitTaskDoneRefusal as handleImplicitTaskDoneRefusalImpl } from "./task-done-refusal-handler.js";
export { handleDepAbortCleanup as handleDepAbortCleanupImpl } from "./dep-abort-cleanup.js";
export { reopenLastStepForRevision as reopenLastStepForRevisionImpl } from "./reopen-last-step-for-revision.js";
export { runExecutorDeterministicVerification as runExecutorDeterministicVerificationImpl } from "./deterministic-verification.js";
export { injectWorkflowStepFailureInstructions as injectWorkflowStepFailureInstructionsImpl } from "./workflow-step-failure-injection.js";
export { sendTaskBackForFix as sendTaskBackForFixImpl } from "./send-task-back-for-fix.js";
export {
  clearStalePauseAbortBeforeDispatch as clearStalePauseAbortBeforeDispatchImpl,
  clearPauseAbortStateForManualRetry as clearPauseAbortStateForManualRetryImpl,
} from "./stale-pause-abort.js";
export { blockOuterDispatchWhenDependenciesUnmet as blockOuterDispatchWhenDependenciesUnmetImpl } from "./dependency-dispatch-gate.js";
export { finalizeMergeConfirmedWorkflowGraphTask as finalizeMergeConfirmedWorkflowGraphTaskImpl } from "./merge-confirmed-finalize.js";
export { holdForSessionContention as holdForSessionContentionImpl } from "./session-contention-hold.js";
export {
  runAwaitInputNode as runAwaitInputNodeImpl,
  pauseForCliApproval as pauseForCliApprovalImpl,
} from "./await-input-node.js";
export { recoverApprovedStepsOnResume as recoverApprovedStepsOnResumeImpl } from "./recover-approved-steps-on-resume.js";
export { tryBootstrapMisbindingRecovery as tryBootstrapMisbindingRecoveryImpl } from "./bootstrap-misbinding-recovery.js";
export { advanceNoMergeWorkflowToCompleteColumn as advanceNoMergeWorkflowToCompleteColumnImpl } from "./no-merge-complete-column.js";
export { applyGraphRethinkReset as applyGraphRethinkResetImpl } from "./graph-rethink-reset.js";
export { disposeSubagentsForTask as disposeSubagentsForTaskImpl } from "./dispose-subagents.js";
export { ensureWorkflowMergeBoundaryTask as ensureWorkflowMergeBoundaryTaskImpl } from "./workflow-merge-boundary.js";
export { scheduleCompletedTaskWatchdog as scheduleCompletedTaskWatchdogImpl } from "./completed-task-watchdog.js";
export { scheduleWorkflowRerun as scheduleWorkflowRerunImpl } from "./workflow-rerun-watchdog.js";
export {
  recoverMissingRequiredArtifacts as recoverMissingRequiredArtifactsImpl,
  isRequiredArtifactRecoveryProtected as isRequiredArtifactRecoveryProtectedImpl,
} from "./required-artifact-recovery.js";
export { performWorkflowRerunBounce as performWorkflowRerunBounceImpl } from "./workflow-rerun-bounce.js";
export { dispatchUnpauseResume as dispatchUnpauseResumeImpl } from "./unpause-resume.js";
export {
  persistTaskTokenUsage as persistTaskTokenUsageImpl,
  captureExecutorTokenUsageBaseline as captureExecutorTokenUsageBaselineImpl,
  persistTokenUsage as persistTokenUsageImpl,
} from "./persist-token-usage.js";
export { resetMergeStateIfNeeded as resetMergeStateIfNeededImpl } from "./reset-merge-state.js";
export { recoverFailedPreMergeWorkflowStep as recoverFailedPreMergeWorkflowStepImpl } from "./recover-failed-pre-merge-step.js";
export { reconcileStepsFromGitHistory as reconcileStepsFromGitHistoryImpl } from "./reconcile-steps-from-git-history.js";
export { clearPhantomExecutorBinding as clearPhantomExecutorBindingImpl } from "./clear-phantom-executor-binding.js";
export { cleanupMergeStateForReverification as cleanupMergeStateForReverificationImpl } from "./cleanup-merge-state.js";
export { clearResumeFailureState as clearResumeFailureStateImpl } from "./clear-resume-failure-state.js";
export { executeReviewHandoff as executeReviewHandoffImpl } from "./execute-review-handoff.js";
export { shouldDeferForHeartbeat as shouldDeferForHeartbeatImpl } from "./should-defer-for-heartbeat.js";
export { parkPlanReviewReplanCapExhausted as parkPlanReviewReplanCapExhaustedImpl } from "./park-plan-review-replan-cap.js";
export { resumeTaskForAgent as resumeTaskForAgentImpl } from "./resume-task-for-agent.js";
export { buildActionGateContext as buildActionGateContextImpl } from "./build-action-gate-context.js";
export { buildPermanentAgentGatingContext as buildPermanentAgentGatingContextImpl } from "./build-permanent-agent-gating-context.js";
export { resolveInstructionsForRole as resolveInstructionsForRoleImpl } from "./resolve-instructions-for-role.js";
export {
  signalTaskComplete as signalTaskCompleteImpl,
  triggerPostTaskReflectionCapture as triggerPostTaskReflectionCaptureImpl,
} from "./signal-task-complete.js";
export { listWipLaneTasks as listWipLaneTasksImpl } from "./list-wip-lane-tasks.js";
export { resolveSeamColumnAgent as resolveSeamColumnAgentImpl } from "./resolve-seam-column-agent.js";
export { resumeOrphaned as resumeOrphanedImpl } from "./resume-orphaned.js";
export { handleLoopDetected as handleLoopDetectedImpl } from "./handle-loop-detected.js";
export { recoverCompletedTask as recoverCompletedTaskImpl } from "./recover-completed-task.js";
export { markStuckAborted as markStuckAbortedImpl } from "./mark-stuck-aborted.js";
export { awaitAbortInFlightTaskWork as awaitAbortInFlightTaskWorkImpl } from "./await-abort-in-flight.js";
export { abortAllInFlight as abortAllInFlightImpl } from "./abort-all-in-flight.js";
export { maybeDispatchWorkflowWorkEngine as maybeDispatchWorkflowWorkEngineImpl } from "./maybe-dispatch-workflow-work-engine.js";
export { executeCore as executeCoreImpl } from "./execute-core.js";
export {
  runCliAgentNode as runCliAgentNodeImpl,
  reapCliTaskSessionForHandoff as reapCliTaskSessionForHandoffImpl,
} from "./run-cli-agent-node.js";
export { adoptColumnAgentForNode as adoptColumnAgentForNodeImpl } from "./adopt-column-agent-for-node.js";
export { runSpawnedChild as runSpawnedChildImpl } from "./run-spawned-child.js";
export { getAutoRecoveryDispatcher as getAutoRecoveryDispatcherImpl } from "./get-auto-recovery-dispatcher.js";
export { prepareGraphNodeExecution as prepareGraphNodeExecutionImpl } from "./prepare-graph-node-execution.js";
export { transitionReviewAddressing as transitionReviewAddressingImpl } from "./transition-review-addressing.js";
export { runGraphTaskStep as runGraphTaskStepImpl } from "./run-graph-task-step.js";
export { getAuthoritativeAssignedAgent as getAuthoritativeAssignedAgentImpl } from "./get-authoritative-assigned-agent.js";
export { shouldDeferWorkflowStepCompletion as shouldDeferWorkflowStepCompletionImpl } from "./should-defer-workflow-step-completion.js";
export { runProjectedGraphTaskStep as runProjectedGraphTaskStepImpl } from "./run-projected-graph-task-step.js";
export { buildCodeNodeRunner as buildCodeNodeRunnerImpl } from "./build-code-node-runner.js";
export { routeResetParsePinMismatchToRetry as routeResetParsePinMismatchToRetryImpl } from "./route-reset-parse-pin-mismatch.js";
export { ensureGraphCustomNodeWorktree as ensureGraphCustomNodeWorktreeImpl } from "./ensure-graph-custom-node-worktree.js";
export { taskEffectiveAgentMatches as taskEffectiveAgentMatchesImpl } from "./task-effective-agent-matches.js";
export { runRawCliCommand as runRawCliCommandImpl } from "./run-raw-cli-command.js";
export { resetStepsIfWorkLost as resetStepsIfWorkLostImpl } from "./reset-steps-if-work-lost.js";
export { routeRetryableRemediationGraphFailureToPreMergeFix as routeRetryableRemediationGraphFailureToPreMergeFixImpl } from "./route-retryable-remediation.js";
export { buildForeachWorktreeDeps as buildForeachWorktreeDepsImpl } from "./build-foreach-worktree-deps.js";
export { requestPreMergeOptionalStepFix as requestPreMergeOptionalStepFixImpl } from "./request-pre-merge-optional-step-fix.js";
export { createSpawnAgentTool as createSpawnAgentToolImpl } from "./create-spawn-agent-tool.js";
export { createTaskUpdateTool as createTaskUpdateToolImpl } from "./create-task-update-tool.js";
export { attemptExecutorVerificationFix as attemptExecutorVerificationFixImpl } from "./attempt-executor-verification-fix.js";
export { createTaskDoneTool as createTaskDoneToolImpl } from "./create-task-done-tool.js";
export {
  finalizeAcceptedNoOpCompletion as finalizeAcceptedNoOpCompletionImpl,
  completePlanReviewNoOp as completePlanReviewNoOpImpl,
  holdPlanReviewNoOpContinuation as holdPlanReviewNoOpContinuationImpl,
} from "./plan-review-no-op.js";
export { resetLostWorkStepProgress as resetLostWorkStepProgressImpl } from "./reset-lost-work-step-progress.js";
export { resolveResumeLanes as resolveResumeLanesImpl } from "./resolve-resume-lanes.js";
export { isReentrantPausedAbortedInFlightNode as isReentrantPausedAbortedInFlightNodeImpl } from "./is-reentrant-paused-aborted-in-flight-node.js";
export { routeGraphFailureToExecutionResume as routeGraphFailureToExecutionResumeImpl } from "./route-graph-failure-to-execution-resume.js";
export { reenterPausedAbortedWorkflowNode as reenterPausedAbortedWorkflowNodeImpl } from "./reenter-paused-aborted-workflow-node.js";
export { isRetryableBenignMergePauseAbort as isRetryableBenignMergePauseAbortImpl } from "./is-retryable-benign-merge-pause-abort.js";
export { isBenignManualMergeHoldPauseAbort as isBenignManualMergeHoldPauseAbortImpl } from "./is-benign-manual-merge-hold-pause-abort.js";
export { handleStaleInReviewPlanPauseAbortReplay as handleStaleInReviewPlanPauseAbortReplayImpl } from "./handle-stale-in-review-plan-pause-abort-replay.js";
export { handleStaleInReviewParsePauseAbortReplay as handleStaleInReviewParsePauseAbortReplayImpl } from "./handle-stale-in-review-parse-pause-abort-replay.js";
export { routeGraphMergeFailureToRetry as routeGraphMergeFailureToRetryImpl } from "./route-graph-merge-failure-to-retry.js";
export { routeImplementationIncompleteMergeGraphFailure as routeImplementationIncompleteMergeGraphFailureImpl } from "./route-implementation-incomplete-merge-graph-failure.js";
export { evaluateTaskVerdictProviders as evaluateTaskVerdictProvidersImpl } from "./evaluate-task-verdict-providers.js";
export { blockOuterDispatchWhenEphemeralDisabled as blockOuterDispatchWhenEphemeralDisabledImpl } from "./block-outer-dispatch-when-ephemeral-disabled.js";
export { routeUnusableWorktreeGraphFailureToRecovery as routeUnusableWorktreeGraphFailureToRecoveryImpl } from "./route-unusable-worktree-graph-failure-to-recovery.js";
export { hasLiveTaskSessionSurface as hasLiveTaskSessionSurfaceImpl } from "./has-live-task-session-surface.js";
export { resolveFailedPreMergeWorkflowStepBudget as resolveFailedPreMergeWorkflowStepBudgetImpl } from "./resolve-failed-pre-merge-workflow-step-budget.js";
export { hasTrailingConsecutiveToolFailures as hasTrailingConsecutiveToolFailuresImpl } from "./has-trailing-consecutive-tool-failures.js";
export { isLiveSharedBranchGroupMember as isLiveSharedBranchGroupMemberImpl } from "./is-live-shared-branch-group-member.js";
export { resolveEffectivePrincipalId as resolveEffectivePrincipalIdImpl } from "./resolve-effective-principal-id.js";
export { createAuthoritativeWorkflowPrimitivesFromExecutor as createAuthoritativeWorkflowPrimitivesFromExecutorImpl } from "./create-authoritative-workflow-primitives.js";
export { createAuthoritativeWorkflowSeams as createAuthoritativeWorkflowSeamsImpl } from "./create-authoritative-workflow-seams.js";
export { executeWorkflowGraph as executeWorkflowGraphImpl } from "./execute-workflow-graph.js";
export { runGraphCustomNode as runGraphCustomNodeImpl } from "./run-graph-custom-node.js";
export { handleGraphFailure as handleGraphFailureImpl } from "./handle-graph-failure.js";
export { handoffTaskToReview as handoffTaskToReviewImpl } from "./handoff-task-to-review.js";
export { cleanupTaskWorktree as cleanupTaskWorktreeImpl } from "./cleanup-task-worktree.js";
export { getAssignedAgentRuntimeConfig as getAssignedAgentRuntimeConfigImpl } from "./get-assigned-agent-runtime-config.js";
export { runImplementationPhase as runImplementationPhaseImpl } from "./run-implementation-phase.js";
export { runImplementation as runImplementationImpl } from "./run-implementation.js";
export { finalizeAlreadyReviewedTask as finalizeAlreadyReviewedTaskImpl } from "./finalize-already-reviewed-task.js";
export { isTaskLiveForOverseerRetry as isTaskLiveForOverseerRetryImpl } from "./is-task-live-for-overseer-retry.js";
export { abortAllSessionBash as abortAllSessionBashImpl } from "./abort-all-session-bash.js";
export { runWithExecutorSemaphore as runWithExecutorSemaphoreImpl } from "./run-with-executor-semaphore.js";
export { buildParseStepsDeps as buildParseStepsDepsImpl } from "./build-parse-steps-deps.js";
export { releasePreExecutionWorktree as releasePreExecutionWorktreeImpl } from "./release-pre-execution-worktree.js";
export { terminateChildAgent as terminateChildAgentImpl } from "./terminate-child-agent.js";
export {
  evaluateWorkflowMergeBoundary as evaluateWorkflowMergeBoundaryImpl,
  getWorkflowMergeImplementationProofFailure as getWorkflowMergeImplementationProofFailureImpl,
} from "./evaluate-workflow-merge-boundary.js";
export { renewTaskLease as renewTaskLeaseImpl } from "./renew-task-lease.js";
export { readTaskArtifact as readTaskArtifactImpl } from "./read-task-artifact.js";
export { getExecutionPauseLabel as getExecutionPauseLabelImpl } from "./get-execution-pause-label.js";
export {
  resolveMergeBoundaryColumn as resolveMergeBoundaryColumnImpl,
  loadMergeBoundaryInstances as loadMergeBoundaryInstancesImpl,
  shouldCompleteChecklistAtWorkflowMerge as shouldCompleteChecklistAtWorkflowMergeImpl,
} from "./workflow-merge-boundary-helpers.js";
export { markPausedAborted as markPausedAbortedImpl } from "./mark-paused-aborted.js";
export { acquireSessionRegistryPath as acquireSessionRegistryPathImpl } from "./acquire-session-registry-path.js";
export { shouldDeferCompletionForGlobalPause as shouldDeferCompletionForGlobalPauseImpl } from "./should-defer-completion-for-global-pause.js";
export { parkApprovalSuspension as parkApprovalSuspensionImpl } from "./park-approval-suspension.js";
export { resumeApprovalAfterUnwindIfNeeded as resumeApprovalAfterUnwindIfNeededImpl } from "./resume-approval-after-unwind.js";
export { ensureTaskWorktreeForPlanning as ensureTaskWorktreeForPlanningImpl } from "./ensure-task-worktree-for-planning.js";
export { foreachActiveForTask as foreachActiveForTaskImpl } from "./foreach-active-for-task.js";
export { buildBranchPersistence as buildBranchPersistenceImpl } from "./build-branch-persistence.js";
export { sessionRegistryPath as sessionRegistryPathImpl } from "./session-registry-path.js";
export {
  addActiveWorktree as addActiveWorktreeImpl,
  getActiveWorktreePaths as getActiveWorktreePathsImpl,
} from "./active-worktrees.js";
export {
  setActiveSession as setActiveSessionImpl,
  markGraphExecuteSelfRequeued as markGraphExecuteSelfRequeuedImpl,
  deleteActiveSession as deleteActiveSessionImpl,
  setActiveStepExecutor as setActiveStepExecutorImpl,
  deleteActiveStepExecutor as deleteActiveStepExecutorImpl,
  setActiveWorkflowStepSession as setActiveWorkflowStepSessionImpl,
  deleteActiveWorkflowStepSession as deleteActiveWorkflowStepSessionImpl,
} from "./active-session-bookkeeping.js";
export {
  markCompletionFinalized as markCompletionFinalizedImpl,
  clearPausedAborted as clearPausedAbortedImpl,
} from "./pause-abort-markers.js";
export { updateStepGraph as updateStepGraphImpl } from "./update-step-graph.js";
export { buildColumnBoundaryHooks as buildColumnBoundaryHooksImpl } from "./build-column-boundary-hooks.js";
export { trackTaskDisposal as trackTaskDisposalImpl } from "./track-task-disposal.js";
export {
  registerConfiguredCommandController as registerConfiguredCommandControllerImpl,
  unregisterConfiguredCommandController as unregisterConfiguredCommandControllerImpl,
} from "./configured-command-controllers.js";
export { safeLogEntry as safeLogEntryImpl } from "./safe-log-entry.js";
export {
  awaitFeatureVideoBounded as awaitFeatureVideoBoundedImpl,
  generateCompletionFeatureVideo as generateCompletionFeatureVideoImpl,
} from "./completion-feature-video.js";
export {
  getExecutingTaskIds as getExecutingTaskIdsImpl,
  hasActivePlanningWorkflowSession as hasActivePlanningWorkflowSessionImpl,
  isTaskActive as isTaskActiveImpl,
} from "./task-liveness.js";
export { clearCompletedTaskWatchdog as clearCompletedTaskWatchdogImpl } from "./clear-completed-task-watchdog.js";
export { terminateAllChildren as terminateAllChildrenImpl } from "./terminate-all-children.js";
export { clearTerminalStepFailuresForRetry as clearTerminalStepFailuresForRetryImpl } from "./clear-terminal-step-failures-for-retry.js";
export { resolveTaskCustomFieldDefs as resolveTaskCustomFieldDefsImpl } from "./resolve-task-custom-field-defs.js";
export { disposeStoreLifecycleDisposers as disposeStoreLifecycleDisposersImpl } from "./dispose-store-lifecycle-disposers.js";
export {
  registerSubagentSession as registerSubagentSessionImpl,
  unregisterSubagentSession as unregisterSubagentSessionImpl,
} from "./subagent-session-registry.js";
export { clearWorkflowRerunWatchdog as clearWorkflowRerunWatchdogImpl } from "./clear-workflow-rerun-watchdog.js";
export { getModelRegistry as getModelRegistryImpl } from "./get-model-registry.js";
export { hasLiveSessionSurface as hasLiveSessionSurfaceImpl } from "./has-live-session-surface.js";
export { listWorktreeHolders as listWorktreeHoldersImpl } from "./list-worktree-holders.js";
export { isAgentEffectivelyExecuting as isAgentEffectivelyExecutingImpl } from "./is-agent-effectively-executing.js";
export { getWorktreePath as getWorktreePathImpl } from "./get-worktree-path.js";
export { buildInjectedRuntimeEnv as buildInjectedRuntimeEnvImpl } from "./build-injected-runtime-env.js";
export { getApprovalRequestStore as getApprovalRequestStoreImpl } from "./get-approval-request-store.js";
export { buildStepInstancePersistence as buildStepInstancePersistenceImpl } from "./build-step-instance-persistence.js";
export { resolveMcpServers as resolveMcpServersImpl } from "./resolve-mcp-servers.js";
export {
  isRemediationGraphNode as isRemediationGraphNodeImpl,
  isPreMergeRemediationGraphNode as isPreMergeRemediationGraphNodeImpl,
} from "./remediation-graph-node.js";
export { executeWorkflowStep as executeWorkflowStepImpl } from "./execute-workflow-step.js";
export {
  isEphemeralDeletionPending as isEphemeralDeletionPendingImpl,
  disposeEphemeralTimers as disposeEphemeralTimersImpl,
} from "./ephemeral-deletion-pending.js";
export { resolveTaskStepSource as resolveTaskStepSourceImpl } from "./resolve-task-step-source.js";

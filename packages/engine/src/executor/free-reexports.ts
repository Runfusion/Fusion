/**
 * FNXC:CodeOrganization 2026-08-03-20:40:
 * Barrel of U4 Free re-exports peeled from executor.ts preamble.
 * TaskExecutor facades keep Impl imports; public Free symbols live here.
 */

export {
  tryCreateWorktree as tryCreateWorktreeFree,
  handleWorktreeConflict as handleWorktreeConflictFree,
} from "./worktree-create-conflict.js";
export { cleanupConflictingWorktree as cleanupConflictingWorktreeFree } from "./worktree-cleanup-conflicting.js";
export {
  createWorktree as createWorktreeFree,
  squashImportDepIntoWorktree as squashImportDepIntoWorktreeFree,
  rebaseNewWorktreeOntoRemote as rebaseNewWorktreeOntoRemoteFree,
  resolveWorktreeStartPoint as resolveWorktreeStartPointFree,
} from "./worktree-create-outer.js";
export {
  reclaimExistingWorktree as reclaimExistingWorktreeFree,
  handleBranchConflict as handleBranchConflictFree,
} from "./worktree-branch-conflict-handle.js";
export { recoverMissingWorktreeSessionStartFailure as recoverMissingWorktreeSessionStartFailureFree } from "./worktree-missing-session-recovery.js";
export {
  verifyWorktreeInvariants as verifyWorktreeInvariantsFree,
  emitWorktreeReanchoredAudit as emitWorktreeReanchoredAuditFree,
} from "./worktree-verify-invariants.js";
export { evaluateTaskDoneScopeLeak as evaluateTaskDoneScopeLeakFree } from "./worktree-task-done-scope-leak.js";
export {
  captureModifiedFiles as captureModifiedFilesFree,
  captureWorkspaceModifiedFiles as captureWorkspaceModifiedFilesFree,
  captureUncommittedModifiedFiles as captureUncommittedModifiedFilesFree,
} from "./worktree-capture-modified-files.js";
export { executeScriptWorkflowStep as executeScriptWorkflowStepFree } from "./workflow-script-step.js";
export { reviewWorkspacePerRepo as reviewWorkspacePerRepoFree } from "./workspace-review-per-repo.js";
export {
  workflowInputRepliesAfterWatermark as workflowInputRepliesAfterWatermarkFree,
  resolveWorkflowInputMarkerForGraphNode as resolveWorkflowInputMarkerForGraphNodeFree,
} from "./workflow-input-markers.js";
export {
  parkCompletedBlockedTask as parkCompletedBlockedTaskFree,
  getCompletedTaskFinalizationDecision as getCompletedTaskFinalizationDecisionFree,
  shouldFinalizeCompletedTask as shouldFinalizeCompletedTaskFree,
} from "./completion-finalization.js";
export {
  handleNonContinuableSessionError as handleNonContinuableSessionErrorFree,
  handleNonContinuableSessionRetry as handleNonContinuableSessionRetryFree,
} from "./non-continuable-session.js";
export { createTaskAddDepTool as createTaskAddDepToolFree } from "./task-add-dep-tool.js";
export {
  handleImplicitTaskDoneRefusal as handleImplicitTaskDoneRefusalFree,
  MAX_TASK_DONE_REQUEUE_RETRIES,
} from "./task-done-refusal-handler.js";
export { handleDepAbortCleanup as handleDepAbortCleanupFree } from "./dep-abort-cleanup.js";
export { reopenLastStepForRevision as reopenLastStepForRevisionFree } from "./reopen-last-step-for-revision.js";
export { runExecutorDeterministicVerification as runExecutorDeterministicVerificationFree } from "./deterministic-verification.js";
export { injectWorkflowStepFailureInstructions as injectWorkflowStepFailureInstructionsFree } from "./workflow-step-failure-injection.js";
export { sendTaskBackForFix as sendTaskBackForFixFree } from "./send-task-back-for-fix.js";
export {
  clearStalePauseAbortBeforeDispatch as clearStalePauseAbortBeforeDispatchFree,
  clearPauseAbortStateForManualRetry as clearPauseAbortStateForManualRetryFree,
} from "./stale-pause-abort.js";
export { blockOuterDispatchWhenDependenciesUnmet as blockOuterDispatchWhenDependenciesUnmetFree } from "./dependency-dispatch-gate.js";
export { finalizeMergeConfirmedWorkflowGraphTask as finalizeMergeConfirmedWorkflowGraphTaskFree } from "./merge-confirmed-finalize.js";
export {
  holdForSessionContention as holdForSessionContentionFree,
  MAX_SESSION_CONTENTION_HOLD_RETRIES,
  SESSION_CONTENTION_HOLD_BACKOFF_MS,
  SESSION_CONTENTION_HOLD_MAX_BACKOFF_MS,
} from "./session-contention-hold.js";
export {
  runAwaitInputNode as runAwaitInputNodeFree,
  pauseForCliApproval as pauseForCliApprovalFree,
} from "./await-input-node.js";
export { recoverApprovedStepsOnResume as recoverApprovedStepsOnResumeFree } from "./recover-approved-steps-on-resume.js";
export { tryBootstrapMisbindingRecovery as tryBootstrapMisbindingRecoveryFree } from "./bootstrap-misbinding-recovery.js";
export { advanceNoMergeWorkflowToCompleteColumn as advanceNoMergeWorkflowToCompleteColumnFree } from "./no-merge-complete-column.js";
export { applyGraphRethinkReset as applyGraphRethinkResetFree } from "./graph-rethink-reset.js";
export { disposeSubagentsForTask as disposeSubagentsForTaskFree } from "./dispose-subagents.js";
export { ensureWorkflowMergeBoundaryTask as ensureWorkflowMergeBoundaryTaskFree } from "./workflow-merge-boundary.js";
export { scheduleCompletedTaskWatchdog as scheduleCompletedTaskWatchdogFree } from "./completed-task-watchdog.js";
export { scheduleWorkflowRerun as scheduleWorkflowRerunFree } from "./workflow-rerun-watchdog.js";
export {
  recoverMissingRequiredArtifacts as recoverMissingRequiredArtifactsFree,
  isRequiredArtifactRecoveryProtected as isRequiredArtifactRecoveryProtectedFree,
} from "./required-artifact-recovery.js";
export { performWorkflowRerunBounce as performWorkflowRerunBounceFree } from "./workflow-rerun-bounce.js";
export { dispatchUnpauseResume as dispatchUnpauseResumeFree } from "./unpause-resume.js";
export {
  persistTaskTokenUsage as persistTaskTokenUsageFree,
  captureExecutorTokenUsageBaseline as captureExecutorTokenUsageBaselineFree,
  persistTokenUsage as persistTokenUsageFree,
} from "./persist-token-usage.js";
export { resetMergeStateIfNeeded as resetMergeStateIfNeededFree } from "./reset-merge-state.js";
export { recoverFailedPreMergeWorkflowStep as recoverFailedPreMergeWorkflowStepFree } from "./recover-failed-pre-merge-step.js";
export { reconcileStepsFromGitHistory as reconcileStepsFromGitHistoryFree } from "./reconcile-steps-from-git-history.js";
export { clearPhantomExecutorBinding as clearPhantomExecutorBindingFree } from "./clear-phantom-executor-binding.js";
export { cleanupMergeStateForReverification as cleanupMergeStateForReverificationFree } from "./cleanup-merge-state.js";
export { clearResumeFailureState as clearResumeFailureStateFree } from "./clear-resume-failure-state.js";
export { executeReviewHandoff as executeReviewHandoffFree } from "./execute-review-handoff.js";
export { shouldDeferForHeartbeat as shouldDeferForHeartbeatFree } from "./should-defer-for-heartbeat.js";
export { parkPlanReviewReplanCapExhausted as parkPlanReviewReplanCapExhaustedFree } from "./park-plan-review-replan-cap.js";
export { resumeTaskForAgent as resumeTaskForAgentFree } from "./resume-task-for-agent.js";
export { buildActionGateContext as buildActionGateContextFree } from "./build-action-gate-context.js";
export { buildPermanentAgentGatingContext as buildPermanentAgentGatingContextFree } from "./build-permanent-agent-gating-context.js";
export { resolveInstructionsForRole as resolveInstructionsForRoleFree } from "./resolve-instructions-for-role.js";
export {
  signalTaskComplete as signalTaskCompleteFree,
  triggerPostTaskReflectionCapture as triggerPostTaskReflectionCaptureFree,
} from "./signal-task-complete.js";
export { listWipLaneTasks as listWipLaneTasksFree } from "./list-wip-lane-tasks.js";
export { resolveSeamColumnAgent as resolveSeamColumnAgentFree } from "./resolve-seam-column-agent.js";
export { resumeOrphaned as resumeOrphanedFree } from "./resume-orphaned.js";
export { handleLoopDetected as handleLoopDetectedFree, LOOP_COMPACTION_TIMEOUT_MS } from "./handle-loop-detected.js";
export { recoverCompletedTask as recoverCompletedTaskFree } from "./recover-completed-task.js";
export { markStuckAborted as markStuckAbortedFree } from "./mark-stuck-aborted.js";
export { awaitAbortInFlightTaskWork as awaitAbortInFlightTaskWorkFree } from "./await-abort-in-flight.js";
export { abortAllInFlight as abortAllInFlightFree } from "./abort-all-in-flight.js";
export { maybeDispatchWorkflowWorkEngine as maybeDispatchWorkflowWorkEngineFree } from "./maybe-dispatch-workflow-work-engine.js";
export { executeCore as executeCoreFree } from "./execute-core.js";
export {
  runCliAgentNode as runCliAgentNodeFree,
  reapCliTaskSessionForHandoff as reapCliTaskSessionForHandoffFree,
} from "./run-cli-agent-node.js";
export { adoptColumnAgentForNode as adoptColumnAgentForNodeFree } from "./adopt-column-agent-for-node.js";
export { runSpawnedChild as runSpawnedChildFree } from "./run-spawned-child.js";
export { getAutoRecoveryDispatcher as getAutoRecoveryDispatcherFree } from "./get-auto-recovery-dispatcher.js";
export { prepareGraphNodeExecution as prepareGraphNodeExecutionFree } from "./prepare-graph-node-execution.js";
export { transitionReviewAddressing as transitionReviewAddressingFree } from "./transition-review-addressing.js";
export { runGraphTaskStep as runGraphTaskStepFree } from "./run-graph-task-step.js";
export { getAuthoritativeAssignedAgent as getAuthoritativeAssignedAgentFree } from "./get-authoritative-assigned-agent.js";
export { shouldDeferWorkflowStepCompletion as shouldDeferWorkflowStepCompletionFree } from "./should-defer-workflow-step-completion.js";
export { runProjectedGraphTaskStep as runProjectedGraphTaskStepFree } from "./run-projected-graph-task-step.js";
export { buildCodeNodeRunner as buildCodeNodeRunnerFree } from "./build-code-node-runner.js";
export { routeResetParsePinMismatchToRetry as routeResetParsePinMismatchToRetryFree } from "./route-reset-parse-pin-mismatch.js";
export { ensureGraphCustomNodeWorktree as ensureGraphCustomNodeWorktreeFree } from "./ensure-graph-custom-node-worktree.js";
export { taskEffectiveAgentMatches as taskEffectiveAgentMatchesFree } from "./task-effective-agent-matches.js";
export { runRawCliCommand as runRawCliCommandFree } from "./run-raw-cli-command.js";
export { resetStepsIfWorkLost as resetStepsIfWorkLostFree } from "./reset-steps-if-work-lost.js";
export { routeRetryableRemediationGraphFailureToPreMergeFix as routeRetryableRemediationGraphFailureToPreMergeFixFree } from "./route-retryable-remediation.js";
export { buildForeachWorktreeDeps as buildForeachWorktreeDepsFree } from "./build-foreach-worktree-deps.js";
export { requestPreMergeOptionalStepFix as requestPreMergeOptionalStepFixFree } from "./request-pre-merge-optional-step-fix.js";
export { createSpawnAgentTool as createSpawnAgentToolFree, spawnAgentParams as spawnAgentParamsFree } from "./create-spawn-agent-tool.js";
export { createTaskUpdateTool as createTaskUpdateToolFree } from "./create-task-update-tool.js";
export { attemptExecutorVerificationFix as attemptExecutorVerificationFixFree } from "./attempt-executor-verification-fix.js";
export { createTaskDoneTool as createTaskDoneToolFree } from "./create-task-done-tool.js";
export { resetLostWorkStepProgress as resetLostWorkStepProgressFree } from "./reset-lost-work-step-progress.js";
export { resolveResumeLanes as resolveResumeLanesFree } from "./resolve-resume-lanes.js";
export { isReentrantPausedAbortedInFlightNode as isReentrantPausedAbortedInFlightNodeFree } from "./is-reentrant-paused-aborted-in-flight-node.js";
export { routeGraphFailureToExecutionResume as routeGraphFailureToExecutionResumeFree } from "./route-graph-failure-to-execution-resume.js";
export { reenterPausedAbortedWorkflowNode as reenterPausedAbortedWorkflowNodeFree } from "./reenter-paused-aborted-workflow-node.js";
export { isRetryableBenignMergePauseAbort as isRetryableBenignMergePauseAbortFree } from "./is-retryable-benign-merge-pause-abort.js";
export { isBenignManualMergeHoldPauseAbort as isBenignManualMergeHoldPauseAbortFree } from "./is-benign-manual-merge-hold-pause-abort.js";
export { handleStaleInReviewPlanPauseAbortReplay as handleStaleInReviewPlanPauseAbortReplayFree } from "./handle-stale-in-review-plan-pause-abort-replay.js";
export { handleStaleInReviewParsePauseAbortReplay as handleStaleInReviewParsePauseAbortReplayFree } from "./handle-stale-in-review-parse-pause-abort-replay.js";
export { routeGraphMergeFailureToRetry as routeGraphMergeFailureToRetryFree } from "./route-graph-merge-failure-to-retry.js";
export { routeImplementationIncompleteMergeGraphFailure as routeImplementationIncompleteMergeGraphFailureFree } from "./route-implementation-incomplete-merge-graph-failure.js";
export { evaluateTaskVerdictProviders as evaluateTaskVerdictProvidersFree } from "./evaluate-task-verdict-providers.js";
export { blockOuterDispatchWhenEphemeralDisabled as blockOuterDispatchWhenEphemeralDisabledFree } from "./block-outer-dispatch-when-ephemeral-disabled.js";
export { routeUnusableWorktreeGraphFailureToRecovery as routeUnusableWorktreeGraphFailureToRecoveryFree } from "./route-unusable-worktree-graph-failure-to-recovery.js";
export { hasLiveTaskSessionSurface as hasLiveTaskSessionSurfaceFree } from "./has-live-task-session-surface.js";
export { isRemediationGraphNode as isRemediationGraphNodeFree, isPreMergeRemediationGraphNode as isPreMergeRemediationGraphNodeFree } from "./remediation-graph-node.js";
export { resolveFailedPreMergeWorkflowStepBudget as resolveFailedPreMergeWorkflowStepBudgetFree } from "./resolve-failed-pre-merge-workflow-step-budget.js";
export { hasTrailingConsecutiveToolFailures as hasTrailingConsecutiveToolFailuresFree } from "./has-trailing-consecutive-tool-failures.js";
export { isLiveSharedBranchGroupMember as isLiveSharedBranchGroupMemberFree } from "./is-live-shared-branch-group-member.js";
export { resolveEffectivePrincipalId as resolveEffectivePrincipalIdFree } from "./resolve-effective-principal-id.js";
export { createAuthoritativeWorkflowPrimitivesFromExecutor as createAuthoritativeWorkflowPrimitivesFromExecutorFree } from "./create-authoritative-workflow-primitives.js";
export { createAuthoritativeWorkflowSeams as createAuthoritativeWorkflowSeamsFree } from "./create-authoritative-workflow-seams.js";
export { executeWorkflowGraph as executeWorkflowGraphFree } from "./execute-workflow-graph.js";
export { runGraphCustomNode as runGraphCustomNodeFree } from "./run-graph-custom-node.js";
export { handleGraphFailure as handleGraphFailureFree } from "./handle-graph-failure.js";
export { executeWorkflowStep as executeWorkflowStepFree } from "./execute-workflow-step.js";
export { handoffTaskToReview as handoffTaskToReviewFree } from "./handoff-task-to-review.js";
export { cleanupTaskWorktree as cleanupTaskWorktreeFree } from "./cleanup-task-worktree.js";
export { getAssignedAgentRuntimeConfig as getAssignedAgentRuntimeConfigFree } from "./get-assigned-agent-runtime-config.js";
export { runImplementationPhase as runImplementationPhaseFree } from "./run-implementation-phase.js";
export { runImplementation as runImplementationFree } from "./run-implementation.js";
export { finalizeAlreadyReviewedTask as finalizeAlreadyReviewedTaskFree } from "./finalize-already-reviewed-task.js";
export { isTaskLiveForOverseerRetry as isTaskLiveForOverseerRetryFree } from "./is-task-live-for-overseer-retry.js";
export { abortAllSessionBash as abortAllSessionBashFree } from "./abort-all-session-bash.js";
export { runWithExecutorSemaphore as runWithExecutorSemaphoreFree } from "./run-with-executor-semaphore.js";
export { buildParseStepsDeps as buildParseStepsDepsFree } from "./build-parse-steps-deps.js";
export { releasePreExecutionWorktree as releasePreExecutionWorktreeFree } from "./release-pre-execution-worktree.js";
export { terminateChildAgent as terminateChildAgentFree } from "./terminate-child-agent.js";
export {
  evaluateWorkflowMergeBoundary as evaluateWorkflowMergeBoundaryFree,
  getWorkflowMergeImplementationProofFailure as getWorkflowMergeImplementationProofFailureFree,
} from "./evaluate-workflow-merge-boundary.js";
export { renewTaskLease as renewTaskLeaseFree } from "./renew-task-lease.js";
export { readTaskArtifact as readTaskArtifactFree } from "./read-task-artifact.js";
export { getExecutionPauseLabel as getExecutionPauseLabelFree } from "./get-execution-pause-label.js";
export {
  resolveMergeBoundaryColumn as resolveMergeBoundaryColumnFree,
  loadMergeBoundaryInstances as loadMergeBoundaryInstancesFree,
  shouldCompleteChecklistAtWorkflowMerge as shouldCompleteChecklistAtWorkflowMergeFree,
} from "./workflow-merge-boundary-helpers.js";
export { markPausedAborted as markPausedAbortedFree } from "./mark-paused-aborted.js";
export { acquireSessionRegistryPath as acquireSessionRegistryPathFree } from "./acquire-session-registry-path.js";
export { shouldDeferCompletionForGlobalPause as shouldDeferCompletionForGlobalPauseFree } from "./should-defer-completion-for-global-pause.js";
export { parkApprovalSuspension as parkApprovalSuspensionFree } from "./park-approval-suspension.js";
export { resumeApprovalAfterUnwindIfNeeded as resumeApprovalAfterUnwindIfNeededFree } from "./resume-approval-after-unwind.js";
export { ensureTaskWorktreeForPlanning as ensureTaskWorktreeForPlanningFree } from "./ensure-task-worktree-for-planning.js";
export { foreachActiveForTask as foreachActiveForTaskFree } from "./foreach-active-for-task.js";
export { buildBranchPersistence as buildBranchPersistenceFree } from "./build-branch-persistence.js";
export {
  buildBranchConflictHandleDeps as buildBranchConflictHandleDepsFree,
  buildWorktreeCreateConflictDeps as buildWorktreeCreateConflictDepsFree,
  buildWorktreeInvariantDeps as buildWorktreeInvariantDepsFree,
  buildNonContinuableSessionDeps as buildNonContinuableSessionDepsFree,
} from "./deps-bags.js";
export { sessionRegistryPath as sessionRegistryPathFree } from "./session-registry-path.js";
export { addActiveWorktree as addActiveWorktreeFree, getActiveWorktreePaths as getActiveWorktreePathsFree } from "./active-worktrees.js";
export { setActiveSession as setActiveSessionFree, markGraphExecuteSelfRequeued as markGraphExecuteSelfRequeuedFree, deleteActiveSession as deleteActiveSessionFree, setActiveStepExecutor as setActiveStepExecutorFree, deleteActiveStepExecutor as deleteActiveStepExecutorFree, setActiveWorkflowStepSession as setActiveWorkflowStepSessionFree, deleteActiveWorkflowStepSession as deleteActiveWorkflowStepSessionFree } from "./active-session-bookkeeping.js";
export { markCompletionFinalized as markCompletionFinalizedFree, clearPausedAborted as clearPausedAbortedFree } from "./pause-abort-markers.js";
export { updateStepGraph as updateStepGraphFree } from "./update-step-graph.js";
export { buildColumnBoundaryHooks as buildColumnBoundaryHooksFree } from "./build-column-boundary-hooks.js";
export { trackTaskDisposal as trackTaskDisposalFree } from "./track-task-disposal.js";
export { registerConfiguredCommandController as registerConfiguredCommandControllerFree, unregisterConfiguredCommandController as unregisterConfiguredCommandControllerFree } from "./configured-command-controllers.js";
export { safeLogEntry as safeLogEntryFree } from "./safe-log-entry.js";
export { awaitFeatureVideoBounded as awaitFeatureVideoBoundedFree, generateCompletionFeatureVideo as generateCompletionFeatureVideoFree } from "./completion-feature-video.js";
export { getExecutingTaskIds as getExecutingTaskIdsFree, hasActivePlanningWorkflowSession as hasActivePlanningWorkflowSessionFree, isTaskActive as isTaskActiveFree } from "./task-liveness.js";
export { clearCompletedTaskWatchdog as clearCompletedTaskWatchdogFree } from "./clear-completed-task-watchdog.js";
export { terminateAllChildren as terminateAllChildrenFree } from "./terminate-all-children.js";
export { clearTerminalStepFailuresForRetry as clearTerminalStepFailuresForRetryFree } from "./clear-terminal-step-failures-for-retry.js";
export { resolveTaskCustomFieldDefs as resolveTaskCustomFieldDefsFree } from "./resolve-task-custom-field-defs.js";
export { disposeStoreLifecycleDisposers as disposeStoreLifecycleDisposersFree } from "./dispose-store-lifecycle-disposers.js";
export { registerSubagentSession as registerSubagentSessionFree, unregisterSubagentSession as unregisterSubagentSessionFree } from "./subagent-session-registry.js";
export { clearWorkflowRerunWatchdog as clearWorkflowRerunWatchdogFree } from "./clear-workflow-rerun-watchdog.js";
export { getModelRegistry as getModelRegistryFree } from "./get-model-registry.js";
export { hasLiveSessionSurface as hasLiveSessionSurfaceFree } from "./has-live-session-surface.js";
export { listWorktreeHolders as listWorktreeHoldersFree } from "./list-worktree-holders.js";
export { isAgentEffectivelyExecuting as isAgentEffectivelyExecutingFree } from "./is-agent-effectively-executing.js";
export { getWorktreePath as getWorktreePathFree } from "./get-worktree-path.js";
export { buildInjectedRuntimeEnv as buildInjectedRuntimeEnvFree } from "./build-injected-runtime-env.js";
export { getApprovalRequestStore as getApprovalRequestStoreFree } from "./get-approval-request-store.js";
export { isEphemeralDeletionPending as isEphemeralDeletionPendingFree, disposeEphemeralTimers as disposeEphemeralTimersFree } from "./ephemeral-deletion-pending.js";
export { buildStepInstancePersistence as buildStepInstancePersistenceFree } from "./build-step-instance-persistence.js";
export { resolveMcpServers as resolveMcpServersFree } from "./resolve-mcp-servers.js";

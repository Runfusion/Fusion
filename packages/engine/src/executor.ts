// port-4040-allowlist: this file embeds the "never kill port 4040" rule in the executor prompt.
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

// Internal git plumbing intentionally bypasses sandbox backends.
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

import { delimiter, join, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DEFAULT_PROVIDER_INSTANCE_ID, type ProviderInstanceRef, type TaskStore, type Task, type TaskDetail, type TaskTokenUsage, type StepStatus, type Settings, type WorkflowStep, type MissionStore, type AsyncMissionStore, type Slice, type RunMutationContext, type Agent, type MergeResult, type WorkflowIrNode, type WorkflowStepResult as CoreWorkflowStepResult, type ThinkingLevel } from "@fusion/core";
import type { ImplementationExit, ImplementationExitReporter } from "./executor/implementation-exit.js";
import { resolveTaskLifecycleColumns, RetryStormError, serializeRetryStormError, evaluateSkipBypassTaint, resolveWorkflowIrForTask, columnsWithFlag, evaluateForeachMergeProof, resolveReboundTarget, resolveLifecycleColumns, resolveEffectiveAgent, resolveMaxConsecutiveToolFailureRetries, resolveConsecutiveToolFailureRetryBackoffMs, resolveConsecutiveToolFailureThreshold, resolveExecutorEscalationTarget, AgentStore, resolveExecutorFallbackModel, resolveValidatorFallbackModel, parseExplicitDuplicateMarker, nonExecutableDuplicateRedirectReason } from "@fusion/core";
import { mergeEffectiveSettings } from "./project/effective-settings.js";
import { generateFeatureVideo, type GenerateFeatureVideoOptions } from "./review-artifacts/feature-video.js";
import { moveTaskToReplanColumn, resolvePlannerLanes, resolveReplanTargetColumn } from "./execution/replan-target.js";
import type { TaskStep, WorkflowIr, WorkflowFieldDefinition, WorkflowColumnAgent, TaskMoveLanes } from "@fusion/core";
import { type WorkflowGraphTaskRunResult, type WorkflowColumnBoundaryHooks } from "./workflows/workflow-graph-task-runner.js";
import { createExecutorColumnBoundaryHooks } from "./workflow-column-boundary-hooks.js";
import { ensureWorkflowCompletionSummary } from "./workflows/workflow-completion-summary.js";
import type { ParseStepsHandlerDeps, CodeNodeRunner } from "./workflows/workflow-node-handlers.js";
import type { WorkflowBranchPersistence, WorkflowBranchRunState } from "./workflows/workflow-graph-branches.js";
import type {
  WorkflowStepInstancePersistence,
  WorkflowStepInstanceState,
} from "./workflows/workflow-graph-foreach.js";
import {




  type ForeachActiveContext,
  type WorkflowLegacySeams,
} from "./workflows/workflow-node-handlers.js";
import {
  MERGE_REGION_KINDS,
  PLAN_REVIEW_PROVIDER_FAILURE_HOLD_VALUE,
  WORKFLOW_DRIFT_PARK_CONTEXT_KEY,


} from "./workflows/workflow-graph-executor.js";
import type { WorkflowNodePreparationRequirement, WorkflowNodeResult } from "./workflows/workflow-graph-executor.js";
import type {
  PreparedWorktree,
  WorkflowRuntimePrimitives,
} from "./execution/runtime-primitives.js";
import { createWorkflowRuntimePrimitiveProvider } from "./workflows/workflow-runtime-primitive-provider.js";
import {
  buildStepFailureMessage,
  emitProactiveStatus,
  sanitizeFailureReason,
} from "./project/proactive-status.js";
import {
  ApprovalRequestStore,
  getTaskMergeBlocker,
  isEphemeralAgent,
  isMergeRequestContractShadowEnabled,
  resolvePersistAgentThinkingLog,
  loadWorkspaceConfig,
  type WorkspaceConfig,
  type RunCommandResult,
} from "@fusion/core";
import { findWorktreeUser } from "./merger.js";
import {
  summarizeVerificationOutput,
  type VerificationResult,
} from "./execution/verification-utils.js";
import { resolveWorktreesDir } from "./worktree/worktree-paths.js";
import { describeModel, formatModelMarkerDetails, promptWithFallback, compactSessionContext } from "./pi.js";
import { accumulateSessionTokenUsage, captureSessionTokenBaseline, resetSessionTokenBaseline } from "./execution/session-token-usage.js";
import { finalizePlanningSegment, startPlanningSegment, resolveEphemeralTaskCreationPolicy } from "@fusion/core";
import {
  createResolvedAgentSession,
  extractRuntimeHint,
  resolveExecutorSessionModel,
  resolveValidatorSessionModel,
  resolveExecutorThinkingLevel,
  resolveExecutorFallbackThinkingLevel,
  resolveValidatorThinkingLevel,
  resolveValidatorFallbackThinkingLevel,
} from "./agents/agent-session-helpers.js";
import { buildSessionSkillContext } from "./cli-runtime/session-skill-context.js";
import type { ReviewVerdict, ReviewResult } from "./execution/reviewer.js";
import { buildUserCommentsPromptSection, selectUserCommentsForAgentContext } from "./agents/agent-user-comments.js";
import { ModelRegistry, SessionManager, type ToolDefinition, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  PRIORITY_EXECUTE,

  dropPreHeldExecutorSlot,
  takePreHeldExecutorSlot,
  type AgentSemaphore,
} from "./concurrency/concurrency.js";
// FNXC:Workspace 2026-06-21-15:00: F5/F8 — wire in the previously dead workspace-path helpers.
// `normalizeRepoRelPath` is the single shared scope-path normalizer (F8); `deriveRepoScopeSubset`
// maps the task's repo-prefixed declared File Scope to a repo-LOCAL subset so the per-repo scope-leak
// filter reuses the SAME always-allowed/scope-match surface as the non-workspace path (F5). One-way
// executor→workspace-paths edge (workspace-paths imports nothing).
import { RemovalReason, classifyTaskWorktree, describeRegisteredWorktrees, detectGitRepository, detectNestedWorktreeRoot, isInsideWorktreesDir, removeWorktree, type WorktreePool } from "./worktree/worktree-pool.js";
import {canonicalizeWorktreePath, registerArchiveWorkspaceWorktreeDisposer, registerArchiveWorktreeDisposer, registerTaskMoveDisposer} from "@fusion/core";
import {
  ActiveSessionPathHeldByForeignTaskError,
  acquireActiveSessionPath,
  activeSessionRegistry,
  executingTaskLock,
  type ActiveSessionKind,
} from "./agents/active-session-registry.js";
// CLI Agent Executor (U7): task ↔ CLI session orchestration seam.
import {
  CliTaskSession,
} from "./cli-agent/task-session.js";
import type { CliSessionManager } from "./cli-agent/session-manager.js";
import type { TelemetryHub } from "./cli-agent/telemetry-hub.js";
import type { CliAdapterRegistry } from "./cli-agent/adapter.js";
import type { CliSessionStore } from "@fusion/core";
import {
  BranchConflictError,
  BranchCrossContaminationError,
  assertCleanBranchAtBase,
  autoRecoverCrossContamination,
  classifyForeignCommits,
  classifyForeignOnlyContamination,
  classifyMisroutedForeignCommit,
  isBranchConflictError,
  reportBranchAttribution,
} from "./execution/branch-conflicts.js";
import {
  classifyOrphanOurAdvance,
  rehomeOrphanOntoIntegration,
} from "./merge/merger-orphan-rehome.js";

import { AgentLogger } from "./agents/agent-logger.js";
import { executorLog, formatError } from "./logger.js";
import { TokenCapDetector } from "./errors/token-cap-detector.js";
import { isUsageLimitError, checkSessionError, type UsageLimitPauser } from "./errors/usage-limit-detector.js";
import { isTransientError, isSilentTransientError } from "./errors/transient-error-detector.js";
import { withRateLimitRetry } from "./errors/rate-limit-retry.js";
import type { CredentialInstanceRotator } from "./credential-instance-rotation.js";
import {
  detectExternalIntegrationEvidenceGaps,
  formatExternalIntegrationEvidenceDiagnostic,
} from "./spec-validation/external-integration-evidence.js";
import { computeRecoveryDecision, formatDelay, MAX_RECOVERY_RETRIES } from "./healing/recovery-policy.js";
import {
  isRequiredArtifactReadFailedValue,
  requiredArtifactMissingValue,
  requiredArtifactReadFailedValue,

} from "./execution/required-workflow-artifacts.js";
import type { StuckTaskDetector, StuckTaskEvent } from "./healing/stuck-task-detector.js";
import type { PluginRunner } from "./plugins/plugin-runner.js";
import { isContextLimitError } from "./errors/context-limit-detector.js";
import { StepSessionExecutor } from "./execution/step-session-executor.js";
import {
  type RunTaskStepResult,
} from "./execution/step-runner.js";
// FNXC:MergerUnification 2026-06-21-19:05: the foundation branch imported `acquireWorkspaceRepoWorktree` here but never used it in executor.ts (the agent tool wraps it via agent-tools.ts), which fails lint on the inherited base. Removed until master-plan U1 re-adds it together with its per-repo acquisition usage.
import { acquireTaskWorktree, type AcquireTaskWorktreeResult } from "./worktree/worktree-acquisition.js";

import {
  buildSystemPromptWithInstructions,
  buildPluginPromptSection,
} from "./agents/agent-instructions.js";
import { buildPromptLayers, collapsePromptLayers } from "./execution/prompt-layers.js";
import { resolveAndEmitGoalContext } from "./goals/goal-injection-diagnostics.js";
import type { AgentReflectionService } from "./agents/agent-reflection.js";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "./util/run-audit.js";
import { AutoRecoveryDispatcher } from "./healing/auto-recovery.js";
import {

} from "./healing/restart-recovery-coordinator.js";
import { PAUSE_ABORT_PARK_ERROR_MARKER, PAUSE_ABORT_PARK_OPERATOR_MARKER } from "./self-healing.js";
import { ReadonlyViolationError, filterCustomToolsForReadonly } from "./workflows/workflow-step-tool-policy.js";
import { evaluateSpecStaleness, getPromptPath } from "./execution/spec-staleness.js";
import { resolveDedicatedPlannerColumnsForTask } from "./planner-lane-resolution.js";
import {
  createAgentCreateTool,
  createAgentDeleteTool,
  createDelegateTaskTool,
  createTaskAssignTool,
  createGetAgentConfigTool,
  createListAgentsTool,
  createMemoryTools,
  createGoalRetrievalTools,
  createMissionTools,
  createIdeationTools,
  createWebFetchTool,
  createReadMessagesTool,
  createReflectOnPerformanceTool,
  createUpdateAgentConfigTool,
  createResearchTools,
  createSendMessageTool,
  createArtifactListTool as sharedCreateArtifactListTool,
  createArtifactRegisterTool as sharedCreateArtifactRegisterTool,
  createArtifactViewTool as sharedCreateArtifactViewTool,
  createTaskCreateTool as sharedCreateTaskCreateTool,
  isAgentTaskCreateToolAvailable,
  isAgentDelegateTaskToolAvailable,
  createTaskDocumentReadTool as sharedCreateTaskDocumentReadTool,
  createTaskDocumentWriteTool as sharedCreateTaskDocumentWriteTool,
  createTaskPromptWriteTool as sharedCreateTaskPromptWriteTool,
  createTaskFileScopeAddTool as sharedCreateTaskFileScopeAddTool,
  createTaskLogTool as sharedCreateTaskLogTool,
  createTaskLogsReadTool as sharedCreateTaskLogsReadTool,
  createWorkflowListTool as sharedCreateWorkflowListTool,
  createWorkflowGetTool as sharedCreateWorkflowGetTool,
  createWorkflowValidateTool as sharedCreateWorkflowValidateTool,
  createWorkflowSelectTool as sharedCreateWorkflowSelectTool,
  createTaskPromoteTool as sharedCreateTaskPromoteTool,
  createWorkflowCreateTool as sharedCreateWorkflowCreateTool,
  createWorkflowUpdateTool as sharedCreateWorkflowUpdateTool,
  createWorkflowDeleteTool as sharedCreateWorkflowDeleteTool,
  createWorkflowSettingsTool as sharedCreateWorkflowSettingsTool,
  createTraitListTool as sharedCreateTraitListTool,
  createAcquireRepoWorktreeTool,
} from "./agent-tools.js";
import { getTaskCompletionBlockerForStore } from "./execution/task-completion.js";
import { createStreamingDeltaNormalizer } from "./execution/streaming-delta.js";
import {
  getEnabledPluginTools,
  isResearchToolSurfaceEnabled,
} from "./execution/tool-availability.js";
import { createFusionAuthStorage, createFusionModelRegistry } from "./auth/auth-storage.js";
import { createRunVerificationTool, runVerificationCommand as runTaskVerificationCommand } from "./execution/run-verification-tool.js";
import { createFallbackModelObserver } from "./auth/fallback-model-observer.js";
import { recordRetry } from "./errors/retry-burned-logger.js";
import type { AgentActionGateContext } from "./agents/agent-action-gate.js";

export type { PausedAbortProvenance } from "./executor/paused-abort-provenance.js";
import {
  type PausedAbortProvenance,

} from "./executor/paused-abort-provenance.js";

// Re-export for backward compatibility (tests import from executor.ts)
export { summarizeToolArgs } from "./agents/agent-logger.js";
export {
  createAgentCreateTool,
  createAgentDeleteTool,
  createDelegateTaskTool,
  createTaskAssignTool,
  createGetAgentConfigTool,
  createListAgentsTool,
  createReadMessagesTool,
  createUpdateAgentConfigTool,
  createSendMessageTool,
  createTaskCreateTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  createTaskLogTool,
  delegateTaskParams,
  listAgentsParams,
  memoryAppendParams,
  memoryGetParams,
  memorySearchParams,
  readMessagesParams,
  sendMessageParams,
  taskCreateParams,
  taskLogParams,
} from "./agent-tools.js";

export {
  AGENT_BROWSER_NAVIGATION_SKILL_ID,
  probeAgentBrowserAvailability,
  augmentSessionSkillsForBrowserStep,
  formatAgentBrowserAvailabilityLog,
} from "./executor/browser-probe.js";
export type { AgentBrowserAvailabilityProbeResult } from "./executor/browser-probe.js";
import {
  probeAgentBrowserAvailability,
  augmentSessionSkillsForBrowserStep,
  formatAgentBrowserAvailabilityLog,
} from "./executor/browser-probe.js";
import type { AgentBrowserExec } from "./executor/browser-probe.js";

import {
  mergeAdditionalSkillPaths,
  isWorkflowStepSkillDiscoverable,
} from "./executor/skill-path-helpers.js";








/** Maximum retry attempts for workflow step hard failures before giving up */
const MAX_WORKFLOW_STEP_RETRIES = 3;
/** Maximum in-session retries when an agent exits without calling fn_task_done(). */
const MAX_TASK_DONE_SESSION_RETRIES = 3;
export {
  MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
  EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD,
  buildExecuteRequeueLoopSignature,
  isTransientMissingTaskJsonError,
} from "./executor/requeue-loop.js";
import {
  MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
  EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD,
  buildExecuteRequeueLoopHighWaterSignature,
  isInvalidAssistantContinuationErrorMessage,
} from "./executor/requeue-loop.js";

const MAX_TRANSIENT_GRAPH_RESUME_RETRIES = 2;
const TRANSIENT_GRAPH_RESUME_RETRY_BACKOFF_MS = process.env.VITEST || process.env.NODE_ENV === "test" ? 0 : 1_000;
/*
FNXC:SessionContention 2026-07-25-21:30:
The contention ladder is deliberately long and slow compared with the provider-failure budget (2 fast
retries): a lease is held for as long as the holder's own work takes — minutes, not milliseconds. Ten
attempts backing off 5s→60s covers ~8 minutes of waiting, after which the task is left queued for
ordinary re-dispatch rather than parked.
*/
/** How long to wait before recovering a completed task still stuck in in-progress. */
const COMPLETED_TASK_WATCHDOG_MS = 60_000;
/** How long to wait before retrying a workflow rerun handoff that never reached in-progress. */
const WORKFLOW_RERUN_WATCHDOG_MS = 15_000;

export type { PendingReviewBlockResult } from "./executor/pending-review-block.js";
import { detectPendingReviewBlock } from "./executor/pending-review-block.js";
import {
  isTaskWorkComplete,
  createSeenSteeringIds,
  createConfiguredCommandAbortError,
  graphActiveContextKey,
  isTerminalMergeGraphFailureValue,
  isAwaitingGraphFailureValue,
} from "./executor/task-predicates.js";
export {
  isTaskWorkComplete,
  isNoProgressNoTaskDoneFailure,
  createSeenSteeringIds,
  createConfiguredCommandAbortError,
  graphActiveContextKey,
  isRetryableMergePauseAbortStatus,
  isTerminalMergeGraphFailureValue,
  isAwaitingGraphFailureValue,
} from "./executor/task-predicates.js";
import {
  graphFailureValue,
  isMergeGraphFailure,

  isSessionContentionGraphFailure,
  isWorktreeBaseRefreshGraphFailure,
  graphRunReportedPendingReview,
} from "./executor/graph-failure-pure.js";
export {
  graphFailureErrorTexts,
  recordedNodeValue,
  graphFailureValue,
  extractUnusableWorktreeGraphFailure,
  isMergeGraphFailure,
  latestFailedPreMergeWorkflowStep,
  isStalePauseAbortParkFailure,
  isSessionContentionGraphFailure,
  isWorktreeBaseRefreshGraphFailure,
  graphRunReportedPendingReview,
} from "./executor/graph-failure-pure.js";
import {
  accumulateTokenUsage as accumulateTokenUsageImpl,
  tokenUsageWithModelSnapshot as tokenUsageWithModelSnapshotImpl,
  extractSessionTokenUsage as extractSessionTokenUsageImpl,
} from "./executor/token-usage-pure.js";
export {
  accumulateTokenUsage,
  tokenUsageWithModelSnapshot,
  extractSessionTokenUsage,
} from "./executor/token-usage-pure.js";
export {
  formatBranchConflictLifecycleLog,
  formatBranchConflictAgentLog,
} from "./executor/branch-conflict-format.js";
import {
  extractOwnSettings,
  buildAgentPersona,
} from "./executor/agent-binding-pure.js";
export {
  extractOwnSettings,
  buildAgentPersona,
} from "./executor/agent-binding-pure.js";
export { resolveCliExecutorConfig } from "./executor/cli-executor-config.js";
import {
  evaluateImplicitCompletionRefusal,
} from "./executor/completion-predicates.js";
export {
  isTaskAlreadyCompleteForNonContinuableSession,
  evaluateImplicitCompletionRefusal,
  skipBypassTaintUpdateForRefusal,
} from "./executor/completion-predicates.js";
import {
  isTransientResumeAfterRestartGraphFailure,
  isBenignInReviewPauseAbort,
} from "./executor/graph-resume-predicates.js";
export {
  isTransientResumeAfterRestartGraphFailure,
  isBenignInReviewPauseAbort,
} from "./executor/graph-resume-predicates.js";
export { buildWorkflowFailureScopeGuard } from "./executor/workflow-failure-scope-guard.js";
import {
  preExecutionWorktreeHasWork,
  resolveContaminationBaseRef,
  resolveDiffBaseRef,
  captureBaseCommitSha,
} from "./executor/worktree-git-refs.js";
export {
  preExecutionWorktreeHasWork,
  resolveContaminationBaseRef,
  resolveDiffBaseRef,
  captureBaseCommitSha,
} from "./executor/worktree-git-refs.js";
export {
  isRegisteredWorktree,
  assertWorktreePathNotNested,
  getWorktreeBranchMap,
} from "./executor/worktree-registry-helpers.js";



export { quoteShellArg } from "./executor/shell-quote.js";
import { isBenignEphemeralDeleteRaceError } from "./executor/ephemeral-delete-race.js";
export { isBenignEphemeralDeleteRaceError } from "./executor/ephemeral-delete-race.js";
export { logReviewCheckoutRouting } from "./executor/review-checkout-routing.js";



export { extractWorktreeConflictInfo } from "./executor/worktree-conflict-info.js";
export type { WorktreeConflictInfo } from "./executor/worktree-conflict-info.js";

export {
  evaluateTaskDoneRefusal,
  determineRevisionResetStart,
} from "./executor/task-done-refusal.js";
import {
  evaluateTaskDoneRefusal,
} from "./executor/task-done-refusal.js";



export {
  extractReferencedPathsFromWorkflowFeedback,
  isAlwaysAllowedScopeLeakPath,
  workflowPathMatchesDeclaredScope,
} from "./executor/workflow-feedback-paths.js";
export type { WorkflowRevisionFeedbackPartition } from "./executor/workflow-feedback-paths.js";


export {
  parseReviewLevelFromPrompt,
  evaluatePromptDerivedNoCommitEligibility,
  extractPromptSection,
  extractPromptListEntries,
} from "./executor/prompt-derived-eligibility.js";


export { NonRetryableWorktreeError } from "./executor/worktree-registry-helpers.js";
import {
  hasActiveWorktreeBinding,
  shouldGenerateNewWorktreeName,
  findActiveWorktreeOwner,
  isLiveCleanupRefusal,
} from "./executor/worktree-ownership.js";
export {
  hasActiveWorktreeBinding,
  shouldGenerateNewWorktreeName,
  findActiveWorktreeOwner,
  isLiveCleanupRefusal,
} from "./executor/worktree-ownership.js";
import { cleanupStaleBranch } from "./executor/worktree-stale-branch.js";
export { cleanupStaleBranch } from "./executor/worktree-stale-branch.js";
import { planSquashImportFromDep } from "./executor/worktree-squash-import-plan.js";
export { planSquashImportFromDep } from "./executor/worktree-squash-import-plan.js";
import { reconcileSelfOwnedBeforeRemove } from "./executor/worktree-self-owned-reconcile.js";
export { reconcileSelfOwnedBeforeRemove } from "./executor/worktree-self-owned-reconcile.js";
import {
  emitStaleLockAudit,
  recoverIndexLockIfStale,
  recoverExecutorStaleRegistration,
} from "./executor/worktree-stale-lock-recovery.js";
export {
  emitStaleLockAudit,
  recoverIndexLockIfStale,
  recoverExecutorStaleRegistration,
} from "./executor/worktree-stale-lock-recovery.js";
export type { StaleLockAuditEvent } from "./executor/worktree-stale-lock-recovery.js";
import { normalizeReclaimableWorktreePath } from "./executor/worktree-reclaim-path.js";
export { normalizeReclaimableWorktreePath } from "./executor/worktree-reclaim-path.js";
import { removeOwnWorktreeWithReconcile } from "./executor/worktree-remove-own.js";
export { removeOwnWorktreeWithReconcile } from "./executor/worktree-remove-own.js";
import { tryFreshWorktreeAfterLiveConflict } from "./executor/worktree-fresh-after-conflict.js";
export { tryFreshWorktreeAfterLiveConflict } from "./executor/worktree-fresh-after-conflict.js";
import {
  tryCreateWorktree as tryCreateWorktreeImpl,
  handleWorktreeConflict as handleWorktreeConflictImpl,
} from "./executor/worktree-create-conflict.js";
export {
  tryCreateWorktree as tryCreateWorktreeFree,
  handleWorktreeConflict as handleWorktreeConflictFree,
} from "./executor/worktree-create-conflict.js";
import { cleanupConflictingWorktree as cleanupConflictingWorktreeImpl } from "./executor/worktree-cleanup-conflicting.js";
export { cleanupConflictingWorktree as cleanupConflictingWorktreeFree } from "./executor/worktree-cleanup-conflicting.js";
import {
  createWorktree as createWorktreeImpl,
  squashImportDepIntoWorktree as squashImportDepIntoWorktreeImpl,
  rebaseNewWorktreeOntoRemote as rebaseNewWorktreeOntoRemoteImpl,
  resolveWorktreeStartPoint as resolveWorktreeStartPointImpl,
} from "./executor/worktree-create-outer.js";
export {
  createWorktree as createWorktreeFree,
  squashImportDepIntoWorktree as squashImportDepIntoWorktreeFree,
  rebaseNewWorktreeOntoRemote as rebaseNewWorktreeOntoRemoteFree,
  resolveWorktreeStartPoint as resolveWorktreeStartPointFree,
} from "./executor/worktree-create-outer.js";
import {
  reclaimExistingWorktree as reclaimExistingWorktreeImpl,
  handleBranchConflict as handleBranchConflictImpl,
} from "./executor/worktree-branch-conflict-handle.js";
export {
  reclaimExistingWorktree as reclaimExistingWorktreeFree,
  handleBranchConflict as handleBranchConflictFree,
} from "./executor/worktree-branch-conflict-handle.js";
import { recoverMissingWorktreeSessionStartFailure as recoverMissingWorktreeSessionStartFailureImpl } from "./executor/worktree-missing-session-recovery.js";
export { recoverMissingWorktreeSessionStartFailure as recoverMissingWorktreeSessionStartFailureFree } from "./executor/worktree-missing-session-recovery.js";
import {
  verifyWorktreeInvariants as verifyWorktreeInvariantsImpl,
  emitWorktreeReanchoredAudit as emitWorktreeReanchoredAuditImpl,
} from "./executor/worktree-verify-invariants.js";
export {
  verifyWorktreeInvariants as verifyWorktreeInvariantsFree,
  emitWorktreeReanchoredAudit as emitWorktreeReanchoredAuditFree,
} from "./executor/worktree-verify-invariants.js";
import { evaluateTaskDoneScopeLeak as evaluateTaskDoneScopeLeakImpl } from "./executor/worktree-task-done-scope-leak.js";
export { evaluateTaskDoneScopeLeak as evaluateTaskDoneScopeLeakFree } from "./executor/worktree-task-done-scope-leak.js";
import {
  captureModifiedFiles as captureModifiedFilesImpl,
  captureWorkspaceModifiedFiles as captureWorkspaceModifiedFilesImpl,
  captureUncommittedModifiedFiles as captureUncommittedModifiedFilesImpl,
} from "./executor/worktree-capture-modified-files.js";
export {
  captureModifiedFiles as captureModifiedFilesFree,
  captureWorkspaceModifiedFiles as captureWorkspaceModifiedFilesFree,
  captureUncommittedModifiedFiles as captureUncommittedModifiedFilesFree,
} from "./executor/worktree-capture-modified-files.js";
import { executeScriptWorkflowStep as executeScriptWorkflowStepImpl } from "./executor/workflow-script-step.js";
export { executeScriptWorkflowStep as executeScriptWorkflowStepFree } from "./executor/workflow-script-step.js";
import { reviewWorkspacePerRepo as reviewWorkspacePerRepoImpl } from "./executor/workspace-review-per-repo.js";
export { reviewWorkspacePerRepo as reviewWorkspacePerRepoFree } from "./executor/workspace-review-per-repo.js";
import {
  workflowInputRepliesAfterWatermark as workflowInputRepliesAfterWatermarkImpl,
  resolveWorkflowInputMarkerForGraphNode as resolveWorkflowInputMarkerForGraphNodeImpl,
} from "./executor/workflow-input-markers.js";
export {
  workflowInputRepliesAfterWatermark as workflowInputRepliesAfterWatermarkFree,
  resolveWorkflowInputMarkerForGraphNode as resolveWorkflowInputMarkerForGraphNodeFree,
} from "./executor/workflow-input-markers.js";
import {
  parkCompletedBlockedTask as parkCompletedBlockedTaskImpl,
  getCompletedTaskFinalizationDecision as getCompletedTaskFinalizationDecisionImpl,
  shouldFinalizeCompletedTask as shouldFinalizeCompletedTaskImpl,
} from "./executor/completion-finalization.js";
export {
  parkCompletedBlockedTask as parkCompletedBlockedTaskFree,
  getCompletedTaskFinalizationDecision as getCompletedTaskFinalizationDecisionFree,
  shouldFinalizeCompletedTask as shouldFinalizeCompletedTaskFree,
} from "./executor/completion-finalization.js";
import {
  handleNonContinuableSessionError as handleNonContinuableSessionErrorImpl,
  handleNonContinuableSessionRetry as handleNonContinuableSessionRetryImpl,
} from "./executor/non-continuable-session.js";
export {
  handleNonContinuableSessionError as handleNonContinuableSessionErrorFree,
  handleNonContinuableSessionRetry as handleNonContinuableSessionRetryFree,
} from "./executor/non-continuable-session.js";
import { createTaskAddDepTool as createTaskAddDepToolImpl } from "./executor/task-add-dep-tool.js";
export { createTaskAddDepTool as createTaskAddDepToolFree } from "./executor/task-add-dep-tool.js";
import {
  handleImplicitTaskDoneRefusal as handleImplicitTaskDoneRefusalImpl,
  MAX_TASK_DONE_REQUEUE_RETRIES,
} from "./executor/task-done-refusal-handler.js";
export {
  handleImplicitTaskDoneRefusal as handleImplicitTaskDoneRefusalFree,
  MAX_TASK_DONE_REQUEUE_RETRIES,
} from "./executor/task-done-refusal-handler.js";
import { handleDepAbortCleanup as handleDepAbortCleanupImpl } from "./executor/dep-abort-cleanup.js";
export { handleDepAbortCleanup as handleDepAbortCleanupFree } from "./executor/dep-abort-cleanup.js";
import { reopenLastStepForRevision as reopenLastStepForRevisionImpl } from "./executor/reopen-last-step-for-revision.js";
export { reopenLastStepForRevision as reopenLastStepForRevisionFree } from "./executor/reopen-last-step-for-revision.js";
import { runExecutorDeterministicVerification as runExecutorDeterministicVerificationImpl } from "./executor/deterministic-verification.js";
export { runExecutorDeterministicVerification as runExecutorDeterministicVerificationFree } from "./executor/deterministic-verification.js";
import { injectWorkflowStepFailureInstructions as injectWorkflowStepFailureInstructionsImpl } from "./executor/workflow-step-failure-injection.js";
export { injectWorkflowStepFailureInstructions as injectWorkflowStepFailureInstructionsFree } from "./executor/workflow-step-failure-injection.js";
import { sendTaskBackForFix as sendTaskBackForFixImpl } from "./executor/send-task-back-for-fix.js";
export { sendTaskBackForFix as sendTaskBackForFixFree } from "./executor/send-task-back-for-fix.js";
import {
  clearStalePauseAbortBeforeDispatch as clearStalePauseAbortBeforeDispatchImpl,
  clearPauseAbortStateForManualRetry as clearPauseAbortStateForManualRetryImpl,
} from "./executor/stale-pause-abort.js";
export {
  clearStalePauseAbortBeforeDispatch as clearStalePauseAbortBeforeDispatchFree,
  clearPauseAbortStateForManualRetry as clearPauseAbortStateForManualRetryFree,
} from "./executor/stale-pause-abort.js";
import { blockOuterDispatchWhenDependenciesUnmet as blockOuterDispatchWhenDependenciesUnmetImpl } from "./executor/dependency-dispatch-gate.js";
export { blockOuterDispatchWhenDependenciesUnmet as blockOuterDispatchWhenDependenciesUnmetFree } from "./executor/dependency-dispatch-gate.js";
import { finalizeMergeConfirmedWorkflowGraphTask as finalizeMergeConfirmedWorkflowGraphTaskImpl } from "./executor/merge-confirmed-finalize.js";
export { finalizeMergeConfirmedWorkflowGraphTask as finalizeMergeConfirmedWorkflowGraphTaskFree } from "./executor/merge-confirmed-finalize.js";
import {
  holdForSessionContention as holdForSessionContentionImpl,
} from "./executor/session-contention-hold.js";
export {
  holdForSessionContention as holdForSessionContentionFree,
  MAX_SESSION_CONTENTION_HOLD_RETRIES,
  SESSION_CONTENTION_HOLD_BACKOFF_MS,
  SESSION_CONTENTION_HOLD_MAX_BACKOFF_MS,
} from "./executor/session-contention-hold.js";
import {
  runAwaitInputNode as runAwaitInputNodeImpl,
  pauseForCliApproval as pauseForCliApprovalImpl,
} from "./executor/await-input-node.js";
export {
  runAwaitInputNode as runAwaitInputNodeFree,
  pauseForCliApproval as pauseForCliApprovalFree,
} from "./executor/await-input-node.js";
import { recoverApprovedStepsOnResume as recoverApprovedStepsOnResumeImpl } from "./executor/recover-approved-steps-on-resume.js";
export { recoverApprovedStepsOnResume as recoverApprovedStepsOnResumeFree } from "./executor/recover-approved-steps-on-resume.js";
import { tryBootstrapMisbindingRecovery as tryBootstrapMisbindingRecoveryImpl } from "./executor/bootstrap-misbinding-recovery.js";
export { tryBootstrapMisbindingRecovery as tryBootstrapMisbindingRecoveryFree } from "./executor/bootstrap-misbinding-recovery.js";
import { advanceNoMergeWorkflowToCompleteColumn as advanceNoMergeWorkflowToCompleteColumnImpl } from "./executor/no-merge-complete-column.js";
export { advanceNoMergeWorkflowToCompleteColumn as advanceNoMergeWorkflowToCompleteColumnFree } from "./executor/no-merge-complete-column.js";
import { applyGraphRethinkReset as applyGraphRethinkResetImpl } from "./executor/graph-rethink-reset.js";
export { applyGraphRethinkReset as applyGraphRethinkResetFree } from "./executor/graph-rethink-reset.js";
import { disposeSubagentsForTask as disposeSubagentsForTaskImpl } from "./executor/dispose-subagents.js";
export { disposeSubagentsForTask as disposeSubagentsForTaskFree } from "./executor/dispose-subagents.js";
import { ensureWorkflowMergeBoundaryTask as ensureWorkflowMergeBoundaryTaskImpl } from "./executor/workflow-merge-boundary.js";
export { ensureWorkflowMergeBoundaryTask as ensureWorkflowMergeBoundaryTaskFree } from "./executor/workflow-merge-boundary.js";
import { scheduleCompletedTaskWatchdog as scheduleCompletedTaskWatchdogImpl } from "./executor/completed-task-watchdog.js";
export { scheduleCompletedTaskWatchdog as scheduleCompletedTaskWatchdogFree } from "./executor/completed-task-watchdog.js";
import { scheduleWorkflowRerun as scheduleWorkflowRerunImpl } from "./executor/workflow-rerun-watchdog.js";
export { scheduleWorkflowRerun as scheduleWorkflowRerunFree } from "./executor/workflow-rerun-watchdog.js";
import {
  recoverMissingRequiredArtifacts as recoverMissingRequiredArtifactsImpl,
  isRequiredArtifactRecoveryProtected as isRequiredArtifactRecoveryProtectedImpl,
} from "./executor/required-artifact-recovery.js";
export {
  recoverMissingRequiredArtifacts as recoverMissingRequiredArtifactsFree,
  isRequiredArtifactRecoveryProtected as isRequiredArtifactRecoveryProtectedFree,
} from "./executor/required-artifact-recovery.js";
import { performWorkflowRerunBounce as performWorkflowRerunBounceImpl } from "./executor/workflow-rerun-bounce.js";
export { performWorkflowRerunBounce as performWorkflowRerunBounceFree } from "./executor/workflow-rerun-bounce.js";
import { dispatchUnpauseResume as dispatchUnpauseResumeImpl } from "./executor/unpause-resume.js";
export { dispatchUnpauseResume as dispatchUnpauseResumeFree } from "./executor/unpause-resume.js";
import {
  persistTaskTokenUsage as persistTaskTokenUsageImpl,
  captureExecutorTokenUsageBaseline as captureExecutorTokenUsageBaselineImpl,
  persistTokenUsage as persistTokenUsageImpl,
} from "./executor/persist-token-usage.js";
export {
  persistTaskTokenUsage as persistTaskTokenUsageFree,
  captureExecutorTokenUsageBaseline as captureExecutorTokenUsageBaselineFree,
  persistTokenUsage as persistTokenUsageFree,
} from "./executor/persist-token-usage.js";
import { resetMergeStateIfNeeded as resetMergeStateIfNeededImpl } from "./executor/reset-merge-state.js";
export { resetMergeStateIfNeeded as resetMergeStateIfNeededFree } from "./executor/reset-merge-state.js";
import { recoverFailedPreMergeWorkflowStep as recoverFailedPreMergeWorkflowStepImpl } from "./executor/recover-failed-pre-merge-step.js";
export { recoverFailedPreMergeWorkflowStep as recoverFailedPreMergeWorkflowStepFree } from "./executor/recover-failed-pre-merge-step.js";
import { reconcileStepsFromGitHistory as reconcileStepsFromGitHistoryImpl } from "./executor/reconcile-steps-from-git-history.js";
export { reconcileStepsFromGitHistory as reconcileStepsFromGitHistoryFree } from "./executor/reconcile-steps-from-git-history.js";
import { clearPhantomExecutorBinding as clearPhantomExecutorBindingImpl } from "./executor/clear-phantom-executor-binding.js";
export { clearPhantomExecutorBinding as clearPhantomExecutorBindingFree } from "./executor/clear-phantom-executor-binding.js";
import { cleanupMergeStateForReverification as cleanupMergeStateForReverificationImpl } from "./executor/cleanup-merge-state.js";
export { cleanupMergeStateForReverification as cleanupMergeStateForReverificationFree } from "./executor/cleanup-merge-state.js";
import { clearResumeFailureState as clearResumeFailureStateImpl } from "./executor/clear-resume-failure-state.js";
export { clearResumeFailureState as clearResumeFailureStateFree } from "./executor/clear-resume-failure-state.js";
import { executeReviewHandoff as executeReviewHandoffImpl } from "./executor/execute-review-handoff.js";
export { executeReviewHandoff as executeReviewHandoffFree } from "./executor/execute-review-handoff.js";
import { shouldDeferForHeartbeat as shouldDeferForHeartbeatImpl } from "./executor/should-defer-for-heartbeat.js";
export { shouldDeferForHeartbeat as shouldDeferForHeartbeatFree } from "./executor/should-defer-for-heartbeat.js";
import { parkPlanReviewReplanCapExhausted as parkPlanReviewReplanCapExhaustedImpl } from "./executor/park-plan-review-replan-cap.js";
export { parkPlanReviewReplanCapExhausted as parkPlanReviewReplanCapExhaustedFree } from "./executor/park-plan-review-replan-cap.js";
import { resumeTaskForAgent as resumeTaskForAgentImpl } from "./executor/resume-task-for-agent.js";
export { resumeTaskForAgent as resumeTaskForAgentFree } from "./executor/resume-task-for-agent.js";
import { buildActionGateContext as buildActionGateContextImpl } from "./executor/build-action-gate-context.js";
export { buildActionGateContext as buildActionGateContextFree } from "./executor/build-action-gate-context.js";
import { buildPermanentAgentGatingContext as buildPermanentAgentGatingContextImpl } from "./executor/build-permanent-agent-gating-context.js";
export { buildPermanentAgentGatingContext as buildPermanentAgentGatingContextFree } from "./executor/build-permanent-agent-gating-context.js";
import { resolveInstructionsForRole as resolveInstructionsForRoleImpl } from "./executor/resolve-instructions-for-role.js";
export { resolveInstructionsForRole as resolveInstructionsForRoleFree } from "./executor/resolve-instructions-for-role.js";
import {
  signalTaskComplete as signalTaskCompleteImpl,
  triggerPostTaskReflectionCapture as triggerPostTaskReflectionCaptureImpl,
} from "./executor/signal-task-complete.js";
export {
  signalTaskComplete as signalTaskCompleteFree,
  triggerPostTaskReflectionCapture as triggerPostTaskReflectionCaptureFree,
} from "./executor/signal-task-complete.js";
import { listWipLaneTasks as listWipLaneTasksImpl } from "./executor/list-wip-lane-tasks.js";
export { listWipLaneTasks as listWipLaneTasksFree } from "./executor/list-wip-lane-tasks.js";
import { resolveSeamColumnAgent as resolveSeamColumnAgentImpl } from "./executor/resolve-seam-column-agent.js";
export { resolveSeamColumnAgent as resolveSeamColumnAgentFree } from "./executor/resolve-seam-column-agent.js";
import { resumeOrphaned as resumeOrphanedImpl } from "./executor/resume-orphaned.js";
export { resumeOrphaned as resumeOrphanedFree } from "./executor/resume-orphaned.js";
import { handleLoopDetected as handleLoopDetectedImpl } from "./executor/handle-loop-detected.js";
export { handleLoopDetected as handleLoopDetectedFree, LOOP_COMPACTION_TIMEOUT_MS } from "./executor/handle-loop-detected.js";
import { recoverCompletedTask as recoverCompletedTaskImpl } from "./executor/recover-completed-task.js";
export { recoverCompletedTask as recoverCompletedTaskFree } from "./executor/recover-completed-task.js";
import { markStuckAborted as markStuckAbortedImpl } from "./executor/mark-stuck-aborted.js";
export { markStuckAborted as markStuckAbortedFree } from "./executor/mark-stuck-aborted.js";
import { awaitAbortInFlightTaskWork as awaitAbortInFlightTaskWorkImpl } from "./executor/await-abort-in-flight.js";
export { awaitAbortInFlightTaskWork as awaitAbortInFlightTaskWorkFree } from "./executor/await-abort-in-flight.js";
import { abortAllInFlight as abortAllInFlightImpl } from "./executor/abort-all-in-flight.js";
export { abortAllInFlight as abortAllInFlightFree } from "./executor/abort-all-in-flight.js";
import { maybeDispatchWorkflowWorkEngine as maybeDispatchWorkflowWorkEngineImpl } from "./executor/maybe-dispatch-workflow-work-engine.js";
export { maybeDispatchWorkflowWorkEngine as maybeDispatchWorkflowWorkEngineFree } from "./executor/maybe-dispatch-workflow-work-engine.js";
import { executeCore as executeCoreImpl } from "./executor/execute-core.js";
export { executeCore as executeCoreFree } from "./executor/execute-core.js";
import {
  runCliAgentNode as runCliAgentNodeImpl,
  reapCliTaskSessionForHandoff as reapCliTaskSessionForHandoffImpl,
} from "./executor/run-cli-agent-node.js";
export {
  runCliAgentNode as runCliAgentNodeFree,
  reapCliTaskSessionForHandoff as reapCliTaskSessionForHandoffFree,
} from "./executor/run-cli-agent-node.js";
import { adoptColumnAgentForNode as adoptColumnAgentForNodeImpl } from "./executor/adopt-column-agent-for-node.js";
export { adoptColumnAgentForNode as adoptColumnAgentForNodeFree } from "./executor/adopt-column-agent-for-node.js";
import { runSpawnedChild as runSpawnedChildImpl } from "./executor/run-spawned-child.js";
export { runSpawnedChild as runSpawnedChildFree } from "./executor/run-spawned-child.js";
import { getAutoRecoveryDispatcher as getAutoRecoveryDispatcherImpl } from "./executor/get-auto-recovery-dispatcher.js";
export { getAutoRecoveryDispatcher as getAutoRecoveryDispatcherFree } from "./executor/get-auto-recovery-dispatcher.js";
import { prepareGraphNodeExecution as prepareGraphNodeExecutionImpl } from "./executor/prepare-graph-node-execution.js";
export { prepareGraphNodeExecution as prepareGraphNodeExecutionFree } from "./executor/prepare-graph-node-execution.js";
import { transitionReviewAddressing as transitionReviewAddressingImpl } from "./executor/transition-review-addressing.js";
export { transitionReviewAddressing as transitionReviewAddressingFree } from "./executor/transition-review-addressing.js";
import { runGraphTaskStep as runGraphTaskStepImpl } from "./executor/run-graph-task-step.js";
export { runGraphTaskStep as runGraphTaskStepFree } from "./executor/run-graph-task-step.js";
import { getAuthoritativeAssignedAgent as getAuthoritativeAssignedAgentImpl } from "./executor/get-authoritative-assigned-agent.js";
export { getAuthoritativeAssignedAgent as getAuthoritativeAssignedAgentFree } from "./executor/get-authoritative-assigned-agent.js";
import { shouldDeferWorkflowStepCompletion as shouldDeferWorkflowStepCompletionImpl } from "./executor/should-defer-workflow-step-completion.js";
export { shouldDeferWorkflowStepCompletion as shouldDeferWorkflowStepCompletionFree } from "./executor/should-defer-workflow-step-completion.js";
import { runProjectedGraphTaskStep as runProjectedGraphTaskStepImpl } from "./executor/run-projected-graph-task-step.js";
export { runProjectedGraphTaskStep as runProjectedGraphTaskStepFree } from "./executor/run-projected-graph-task-step.js";
import { buildCodeNodeRunner as buildCodeNodeRunnerImpl } from "./executor/build-code-node-runner.js";
export { buildCodeNodeRunner as buildCodeNodeRunnerFree } from "./executor/build-code-node-runner.js";
import { routeResetParsePinMismatchToRetry as routeResetParsePinMismatchToRetryImpl } from "./executor/route-reset-parse-pin-mismatch.js";
export { routeResetParsePinMismatchToRetry as routeResetParsePinMismatchToRetryFree } from "./executor/route-reset-parse-pin-mismatch.js";
import { ensureGraphCustomNodeWorktree as ensureGraphCustomNodeWorktreeImpl } from "./executor/ensure-graph-custom-node-worktree.js";
export { ensureGraphCustomNodeWorktree as ensureGraphCustomNodeWorktreeFree } from "./executor/ensure-graph-custom-node-worktree.js";
import { taskEffectiveAgentMatches as taskEffectiveAgentMatchesImpl } from "./executor/task-effective-agent-matches.js";
export { taskEffectiveAgentMatches as taskEffectiveAgentMatchesFree } from "./executor/task-effective-agent-matches.js";
import { runRawCliCommand as runRawCliCommandImpl } from "./executor/run-raw-cli-command.js";
export { runRawCliCommand as runRawCliCommandFree } from "./executor/run-raw-cli-command.js";
import { resetStepsIfWorkLost as resetStepsIfWorkLostImpl } from "./executor/reset-steps-if-work-lost.js";
export { resetStepsIfWorkLost as resetStepsIfWorkLostFree } from "./executor/reset-steps-if-work-lost.js";
import { routeRetryableRemediationGraphFailureToPreMergeFix as routeRetryableRemediationGraphFailureToPreMergeFixImpl } from "./executor/route-retryable-remediation.js";
export { routeRetryableRemediationGraphFailureToPreMergeFix as routeRetryableRemediationGraphFailureToPreMergeFixFree } from "./executor/route-retryable-remediation.js";
import { buildForeachWorktreeDeps as buildForeachWorktreeDepsImpl } from "./executor/build-foreach-worktree-deps.js";
export { buildForeachWorktreeDeps as buildForeachWorktreeDepsFree } from "./executor/build-foreach-worktree-deps.js";
import { requestPreMergeOptionalStepFix as requestPreMergeOptionalStepFixImpl } from "./executor/request-pre-merge-optional-step-fix.js";
export { requestPreMergeOptionalStepFix as requestPreMergeOptionalStepFixFree } from "./executor/request-pre-merge-optional-step-fix.js";
import { createSpawnAgentTool as createSpawnAgentToolImpl } from "./executor/create-spawn-agent-tool.js";
export { createSpawnAgentTool as createSpawnAgentToolFree, spawnAgentParams as spawnAgentParamsFree } from "./executor/create-spawn-agent-tool.js";
import { createTaskUpdateTool as createTaskUpdateToolImpl } from "./executor/create-task-update-tool.js";
export { createTaskUpdateTool as createTaskUpdateToolFree } from "./executor/create-task-update-tool.js";
import { attemptExecutorVerificationFix as attemptExecutorVerificationFixImpl } from "./executor/attempt-executor-verification-fix.js";
export { attemptExecutorVerificationFix as attemptExecutorVerificationFixFree } from "./executor/attempt-executor-verification-fix.js";
import { createTaskDoneTool as createTaskDoneToolImpl } from "./executor/create-task-done-tool.js";
export { createTaskDoneTool as createTaskDoneToolFree } from "./executor/create-task-done-tool.js";
import { resetLostWorkStepProgress as resetLostWorkStepProgressImpl } from "./executor/reset-lost-work-step-progress.js";
export { resetLostWorkStepProgress as resetLostWorkStepProgressFree } from "./executor/reset-lost-work-step-progress.js";
import { resolveResumeLanes as resolveResumeLanesImpl } from "./executor/resolve-resume-lanes.js";
export { resolveResumeLanes as resolveResumeLanesFree } from "./executor/resolve-resume-lanes.js";
import { isReentrantPausedAbortedInFlightNode as isReentrantPausedAbortedInFlightNodeImpl } from "./executor/is-reentrant-paused-aborted-in-flight-node.js";
export { isReentrantPausedAbortedInFlightNode as isReentrantPausedAbortedInFlightNodeFree } from "./executor/is-reentrant-paused-aborted-in-flight-node.js";
import { routeGraphFailureToExecutionResume as routeGraphFailureToExecutionResumeImpl } from "./executor/route-graph-failure-to-execution-resume.js";
export { routeGraphFailureToExecutionResume as routeGraphFailureToExecutionResumeFree } from "./executor/route-graph-failure-to-execution-resume.js";
import { reenterPausedAbortedWorkflowNode as reenterPausedAbortedWorkflowNodeImpl } from "./executor/reenter-paused-aborted-workflow-node.js";
export { reenterPausedAbortedWorkflowNode as reenterPausedAbortedWorkflowNodeFree } from "./executor/reenter-paused-aborted-workflow-node.js";
import { isRetryableBenignMergePauseAbort as isRetryableBenignMergePauseAbortImpl } from "./executor/is-retryable-benign-merge-pause-abort.js";
export { isRetryableBenignMergePauseAbort as isRetryableBenignMergePauseAbortFree } from "./executor/is-retryable-benign-merge-pause-abort.js";
import { isBenignManualMergeHoldPauseAbort as isBenignManualMergeHoldPauseAbortImpl } from "./executor/is-benign-manual-merge-hold-pause-abort.js";
export { isBenignManualMergeHoldPauseAbort as isBenignManualMergeHoldPauseAbortFree } from "./executor/is-benign-manual-merge-hold-pause-abort.js";
import { handleStaleInReviewPlanPauseAbortReplay as handleStaleInReviewPlanPauseAbortReplayImpl } from "./executor/handle-stale-in-review-plan-pause-abort-replay.js";
export { handleStaleInReviewPlanPauseAbortReplay as handleStaleInReviewPlanPauseAbortReplayFree } from "./executor/handle-stale-in-review-plan-pause-abort-replay.js";
import { handleStaleInReviewParsePauseAbortReplay as handleStaleInReviewParsePauseAbortReplayImpl } from "./executor/handle-stale-in-review-parse-pause-abort-replay.js";
export { handleStaleInReviewParsePauseAbortReplay as handleStaleInReviewParsePauseAbortReplayFree } from "./executor/handle-stale-in-review-parse-pause-abort-replay.js";
import { routeGraphMergeFailureToRetry as routeGraphMergeFailureToRetryImpl } from "./executor/route-graph-merge-failure-to-retry.js";
export { routeGraphMergeFailureToRetry as routeGraphMergeFailureToRetryFree } from "./executor/route-graph-merge-failure-to-retry.js";
import { routeImplementationIncompleteMergeGraphFailure as routeImplementationIncompleteMergeGraphFailureImpl } from "./executor/route-implementation-incomplete-merge-graph-failure.js";
export { routeImplementationIncompleteMergeGraphFailure as routeImplementationIncompleteMergeGraphFailureFree } from "./executor/route-implementation-incomplete-merge-graph-failure.js";
import { evaluateTaskVerdictProviders as evaluateTaskVerdictProvidersImpl } from "./executor/evaluate-task-verdict-providers.js";
export { evaluateTaskVerdictProviders as evaluateTaskVerdictProvidersFree } from "./executor/evaluate-task-verdict-providers.js";
import { blockOuterDispatchWhenEphemeralDisabled as blockOuterDispatchWhenEphemeralDisabledImpl } from "./executor/block-outer-dispatch-when-ephemeral-disabled.js";
export { blockOuterDispatchWhenEphemeralDisabled as blockOuterDispatchWhenEphemeralDisabledFree } from "./executor/block-outer-dispatch-when-ephemeral-disabled.js";
import { routeUnusableWorktreeGraphFailureToRecovery as routeUnusableWorktreeGraphFailureToRecoveryImpl } from "./executor/route-unusable-worktree-graph-failure-to-recovery.js";
export { routeUnusableWorktreeGraphFailureToRecovery as routeUnusableWorktreeGraphFailureToRecoveryFree } from "./executor/route-unusable-worktree-graph-failure-to-recovery.js";
import { hasLiveTaskSessionSurface as hasLiveTaskSessionSurfaceImpl } from "./executor/has-live-task-session-surface.js";
export { hasLiveTaskSessionSurface as hasLiveTaskSessionSurfaceFree } from "./executor/has-live-task-session-surface.js";
import { isRemediationGraphNode as isRemediationGraphNodeImpl, isPreMergeRemediationGraphNode as isPreMergeRemediationGraphNodeImpl } from "./executor/remediation-graph-node.js";
export { isRemediationGraphNode as isRemediationGraphNodeFree, isPreMergeRemediationGraphNode as isPreMergeRemediationGraphNodeFree } from "./executor/remediation-graph-node.js";
import { resolveFailedPreMergeWorkflowStepBudget as resolveFailedPreMergeWorkflowStepBudgetImpl } from "./executor/resolve-failed-pre-merge-workflow-step-budget.js";
export { resolveFailedPreMergeWorkflowStepBudget as resolveFailedPreMergeWorkflowStepBudgetFree } from "./executor/resolve-failed-pre-merge-workflow-step-budget.js";
import { hasTrailingConsecutiveToolFailures as hasTrailingConsecutiveToolFailuresImpl } from "./executor/has-trailing-consecutive-tool-failures.js";
export { hasTrailingConsecutiveToolFailures as hasTrailingConsecutiveToolFailuresFree } from "./executor/has-trailing-consecutive-tool-failures.js";
import { isLiveSharedBranchGroupMember as isLiveSharedBranchGroupMemberImpl } from "./executor/is-live-shared-branch-group-member.js";
export { isLiveSharedBranchGroupMember as isLiveSharedBranchGroupMemberFree } from "./executor/is-live-shared-branch-group-member.js";
import { resolveEffectivePrincipalId as resolveEffectivePrincipalIdImpl } from "./executor/resolve-effective-principal-id.js";
export { resolveEffectivePrincipalId as resolveEffectivePrincipalIdFree } from "./executor/resolve-effective-principal-id.js";
import { createAuthoritativeWorkflowPrimitivesFromExecutor as createAuthoritativeWorkflowPrimitivesFromExecutorImpl } from "./executor/create-authoritative-workflow-primitives.js";
export { createAuthoritativeWorkflowPrimitivesFromExecutor as createAuthoritativeWorkflowPrimitivesFromExecutorFree } from "./executor/create-authoritative-workflow-primitives.js";
import { createAuthoritativeWorkflowSeams as createAuthoritativeWorkflowSeamsImpl } from "./executor/create-authoritative-workflow-seams.js";
export { createAuthoritativeWorkflowSeams as createAuthoritativeWorkflowSeamsFree } from "./executor/create-authoritative-workflow-seams.js";
import { executeWorkflowGraph as executeWorkflowGraphImpl } from "./executor/execute-workflow-graph.js";
export { executeWorkflowGraph as executeWorkflowGraphFree } from "./executor/execute-workflow-graph.js";
import { runGraphCustomNode as runGraphCustomNodeImpl } from "./executor/run-graph-custom-node.js";
export { runGraphCustomNode as runGraphCustomNodeFree } from "./executor/run-graph-custom-node.js";
import { handleGraphFailure as handleGraphFailureImpl } from "./executor/handle-graph-failure.js";
export { handleGraphFailure as handleGraphFailureFree } from "./executor/handle-graph-failure.js";
import { buildStepInstancePersistence as buildStepInstancePersistenceImpl } from "./executor/build-step-instance-persistence.js";
export { buildStepInstancePersistence as buildStepInstancePersistenceFree } from "./executor/build-step-instance-persistence.js";
import { resolveMcpServers as resolveMcpServersImpl } from "./executor/resolve-mcp-servers.js";
export { resolveMcpServers as resolveMcpServersFree } from "./executor/resolve-mcp-servers.js";





































import {
  canonicalizePath,
  formatGitRepositoryDetectionError,
  extractPersistedSessionWorktreePath,
  isSessionWorktreeCompatible,
} from "./executor/session-worktree-paths.js";


import {
  configuredCommandErrorMessage,
  getConfiguredCommandSandboxBackend,
} from "./executor/configured-command.js";
export { truncateWorkflowScriptOutput } from "./executor/configured-command.js";


async function runConfiguredCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
  auditor?: RunAuditor,
  signal?: AbortSignal,
): Promise<RunCommandResult> {
  const backend = getConfiguredCommandSandboxBackend(auditor);
  const result = await backend.run(command, {
    cwd,
    timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf-8",
    ...(extraEnv !== undefined && { env: extraEnv }),
    ...(signal !== undefined && { signal }),
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    bufferExceeded: result.bufferExceeded,
    timedOut: result.timedOut,
    spawnError: result.spawnError,
  };
}

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

// ── Tool parameter schemas (module-level for reuse in ToolDefinition generics) ──

// taskLogParams and taskCreateParams are imported from agent-tools.ts


/**
 * Sentinel a skill running in a Fusion workflow step emits when it needs to ask
 * the user a blocking question (it has no synchronous question tool — see the CE
 * skills' "Running inside Fusion" sections). The executor detects this in the
 * step's output and parks the task `awaiting-user-input`, reusing the same
 * pause/resume machinery as an `awaitInput` node (U6). Returns the question text,
 * or null when no well-formed sentinel is present.
 */
export {
  parseAwaitInputSentinel,
  parseAwaitInputQuestionToolCall,
} from "./executor/await-input-parse.js";
import {
  parseAwaitInputQuestionToolCall,
} from "./executor/await-input-parse.js";


/**
 * (U2 / KTD-2) Fusion workflow-step conventions preamble, prepended to a skill
 * step's prompt at the skill-prompt build path (runGraphCustomNode). It teaches
 * any bundled skill the conventions Fusion needs — in ONE engine-side place, so
 * the skills stay byte-for-byte upstream. The block is skill-agnostic and rides
 * on the node prompt; it deliberately overrides the upstream skill bodies that
 * still say "call AskUserQuestion" / "Task ce-*". Stable text — the await-input
 * grammar here must match `parseAwaitInputSentinel` and the persona-override
 * contract (fn_spawn_agent's `systemPromptOverride` param) verbatim.
 *
 * (U9 / KTD-7) The persona-fan-out instruction is path-confined: the skill must
 * resolve `<persona>.md` strictly within `$FUSION_CE_AGENTS_DIR` and reject any
 * `../` traversal before reading, since the file body is injected verbatim into a
 * child's system prompt (a filesystem prompt-injection surface otherwise).
 */
export {
  FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE,
  parseWorkflowStepVerdict,
  inferWorkflowStepVerdictFromProse,
  parseWorkflowStepOutput,
} from "./executor/workflow-step-verdict.js";
export type {
  WorkflowStepOutcome,
  WorkflowStepResult,
} from "./executor/workflow-step-verdict.js";
import {
  parseWorkflowStepOutput,
} from "./executor/workflow-step-verdict.js";
import type {
  WorkflowStepOutcome,
} from "./executor/workflow-step-verdict.js";

export { getExecutorSystemPrompt } from "./executor/system-prompt.js";
import { getExecutorSystemPrompt } from "./executor/system-prompt.js";


export interface TaskExecutorOptions {
  /*
   * FNXC:PlanReviewLease 2026-07-26-21:07:
   * Resolves this engine's cluster node id for review-gate lease attribution. A GETTER, not a
   * value: the runtime resolves the id asynchronously during start(), which can complete after
   * the executor is constructed, so a snapshot taken at construction would be permanently
   * undefined. Read at runner-construction time instead.
   */
  getLocalNodeId?: () => string | undefined;
  semaphore?: AgentSemaphore;
  /** Worktree pool for recycling idle worktrees across tasks. */
  pool?: WorktreePool;
  /**
   * FNXC:ProviderRateLimitIsolation 2026-07-21-18:00:
   * Parks only tasks routed through the provider whose API limit was detected.
   */
  usageLimitPauser?: UsageLimitPauser;
  /** Runtime-owned credential rotation inventory/cooldown coordinator. */
  credentialRotator?: CredentialInstanceRotator;
  /** Stuck task detector — monitors agent sessions for stagnation and triggers recovery. */
  stuckTaskDetector?: StuckTaskDetector;
  /** AgentStore for tracking spawned child agents. If not provided, spawning is disabled. */
  agentStore?: import("@fusion/core").AgentStore;
  /** Reflection service used to generate self-reflection insights for agents. */
  reflectionService?: AgentReflectionService;
  /** Plugin runner for invoking plugin hooks and providing plugin tools. */
  pluginRunner?: PluginRunner;
  /** MessageStore for sending messages to other agents. When provided, executor agents gain fn_send_message capability. */
  messageStore?: import("@fusion/core").MessageStore;
  missionStore?: MissionStore | AsyncMissionStore;
  secretsStore?: Pick<import("@fusion/core").SecretsStore, "listEnvExportable">;
  onSliceComplete?: (slice: Slice) => void;
  onStart?: (task: Task, worktreePath: string) => void;
  onComplete?: (task: Task) => void;
  onError?: (task: Task, error: Error) => void;
  /** Testable, best-effort completion-deliverable seam; production uses generateFeatureVideo. */
  reviewArtifactGenerator?: (options: GenerateFeatureVideoOptions) => Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult>;
  onAgentText?: (taskId: string, delta: string) => void;
  /**
   * FNXC:StuckDetector 2026-07-22-19:25:
   * Optional third arg is the primary-arg summary from AgentLogger so downstream
   * telemetry (and any external onAgentTool subscribers) keep the same fingerprint contract
   * the stuck detector uses — do not drop `detail` at the executor boundary.
   */
  onAgentTool?: (taskId: string, toolName: string, detail?: string) => void;
  /*
  FNXC:PlannerOversight 2026-07-13-23:05:
  Session-advisor live delta path — AgentLogger invokes this after durable
  log flushes. Fail-soft; must not throw.
  */
  onExecutorLogFlushed?: (
    taskId: string,
    entries: Array<{ type?: string; text?: string; detail?: string; agent?: string }>,
  ) => void;
  autoRecoveryDispatcher?: AutoRecoveryDispatcher;
  /** PR-entity node deps (U3): assembled `PrNodeDeps` (store + injected GitHub
   *  callbacks) for the `pr-create`/`pr-respond`/`pr-merge` workflow nodes. The
   *  runtime binds the store and threads the CLI-injected ops. Absent → the pr-*
   *  node kinds fail closed. */
  prNodes?: import("./merge/pr-nodes.js").PrNodeDeps;
  /**
   * CLI Agent Executor runtime (U7). When present, workflow nodes with
   * `config.executor === "cli-agent"` drive an engine-owned CLI session via the
   * task-session orchestration. Absent → cli-agent nodes report a clear config
   * error (the runtime was not wired). Bundled so a single option threads the
   * PTY manager + telemetry hub + adapter registry + hook endpoint together.
   */
  cliAgentRuntime?: CliAgentRuntime;
}

/** Bundled CLI Agent Executor runtime dependencies (U7). */
export interface CliAgentRuntime {
  /** Engine-owned PTY session manager (U2). */
  manager: CliSessionManager;
  /** In-process telemetry hub (U3) — owns per-session tokens + state machines. */
  hub: TelemetryHub;
  /** Adapter registry (U2) — resolves adapter id → adapter. */
  registry: CliAdapterRegistry;
  /** Durable session store (U1) — for re-entry / follow-up session lookups. */
  store: CliSessionStore;
  /** Project this runtime drives (the executor is per-project; `cli_sessions` needs it). */
  projectId: string;
  /**
   * Absolute URL of the dashboard hook ingestion endpoint the hook scripts POST
   * to (e.g. `http://127.0.0.1:4040/api/cli-agent/hooks`).
   */
  hookEndpointUrl: string;
  /** Optional override for the hook scratch-dir root (tests). */
  hookDirRoot?: string;
}

interface ActiveExecutorSessionState {
  session: AgentSession;
  seenSteeringIds: Set<string>;
  lastResolvedModelProvider?: string;
  lastResolvedModelId?: string;
  lastTaskModelProvider?: string | null;
  lastTaskModelId?: string | null;
  lastAssignedAgentId?: string | null;
  lastEffectiveColumnAgentId?: string | null;
}

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
export {
  LEGACY_TERMINAL_COLUMNS,
  resolveTerminalColumnsFor,
  resolveCompleteColumnFor,
  resolveReboundColumnFor,
} from "./executor/lifecycle-columns.js";
import {
  resolveTerminalColumnsFor,
  resolveCompleteColumnFor,
  resolveReboundColumnFor,
} from "./executor/lifecycle-columns.js";


/*
FNXC:WorkflowExecution 2026-07-19-01:30:
U5d (R9): explicit replacement for the deleted `graphCompletionInterceptors` Map. When this
callback is present the run IS a graph-owned implementation phase: execution stops at the
implementation-complete boundary (no workflow steps, no legacy in-review handoff),
`fn_review_step` is not injected, review gates are marked graph-owned, and the captured
modifiedFiles are handed back through the callback. Absent callback == the legacy path.

FNXC:WorkflowExecution 2026-07-19-02:10:
U5e (R9): this is now a parameter of `runImplementation()`, NOT of `execute()`. The graph
calls the runner directly, so the callback no longer travels through routing.

Remaining U5e work: the callback should become MANDATORY and collapse into an ordinary
return value. It is still optional only because `executeWorkflowGraph` keeps one
legacy fallback (executor.ts, the workflow-selection-api-unavailable branch) that minimal
TEST stores reach; production stores always expose a workflow-selection reader and are
always graph-owned. Deleting that fallback makes every `runImplementation` call
graph-owned, at which point this type disappears in favor of a returned outcome. See
docs/plans/2026-07-19-002-u5e-remaining-deletions-handoff.md.
*/
export type GraphCompletionCallback = (info: { modifiedFiles: string[] }) => void;

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
    const set = this.activeWorktrees.get(taskId) ?? new Set<string>();
    set.add(worktreePath);
    this.activeWorktrees.set(taskId, set);
  }

  /**
   * FNXC:Workspace 2026-06-21-12:00: Read-only snapshot of every worktree path a task currently holds (KTD2). Empty when the task holds none.
   */
  private getActiveWorktreePaths(taskId: string): string[] {
    const set = this.activeWorktrees.get(taskId);
    return set ? Array.from(set) : [];
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
    try {
      const result = this.store.logEntry(taskId, message, undefined, this.getRunContextFor(taskId));
      void Promise.resolve(result).catch((error) => {
        executorLog.warn(`${taskId}: failed to write task-log breadcrumb: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      executorLog.warn(`${taskId}: failed to write task-log breadcrumb: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private markPausedAborted(
    taskId: string,
    provenance: PausedAbortProvenance = "hard-cancel",
    source = "unspecified",
  ): void {
    const previousProvenance = this.pausedAbortProvenance.get(taskId);
    const alreadyMarked = this.pausedAborted.has(taskId);
    this.pausedAborted.add(taskId);
    this.pausedAbortProvenance.set(taskId, provenance);
    if (!alreadyMarked || previousProvenance !== provenance) {
      /*
      FNXC:WorkflowLifecycle 2026-07-01-22:24:
      Pause aborts are frequent enough that operators need task-log breadcrumbs at the marker source, not only at the later graph-failure sink. Log first-mark/provenance-change events so a task card shows why a workflow was interrupted and which code path owned the abort.
      */
      this.safeLogEntry(
        taskId,
        `Pause abort marked: provenance=${provenance} source=${source}${previousProvenance && previousProvenance !== provenance ? ` previous=${previousProvenance}` : ""}`,
      );
    }
  }

  private markCompletionFinalized(taskId: string): void {
    this.markPausedAborted(taskId, "completion-finalize", "completion-finalize");
    this.completionFinalizedTaskIds.add(taskId);
  }

  private clearPausedAborted(taskId: string): void {
    this.pausedAborted.delete(taskId);
    this.pausedAbortProvenance.delete(taskId);
    this.completionFinalizedTaskIds.delete(taskId);
  }

  private async clearStalePauseAbortBeforeDispatch(task: Task): Promise<void> {
    return clearStalePauseAbortBeforeDispatchImpl(
      {
        store: this.store,
        hasPausedAborted: (taskId: string) => this.pausedAborted.has(taskId),
        clearPausedAborted: (taskId: string) => this.clearPausedAborted(taskId),
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
    if (worktreePath === this.rootDir) {
      return `${worktreePath}#session:${taskId}`;
    }
    return worktreePath;
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
    const outcome = acquireActiveSessionPath(activeSessionRegistry, registryPath, { taskId, kind, ownerKey }, {
      holderLiveProbe: (holderTaskId) => this.hasLiveTaskSessionSurface(holderTaskId) || executingTaskLock.has(holderTaskId),
    });
    if (outcome.action === "contended") {
      throw new ActiveSessionPathHeldByForeignTaskError(registryPath, outcome.holderTaskId, taskId);
    }
    if (outcome.action === "reclaimed-stale-foreign") {
      executorLog.warn(
        `${taskId}: reclaimed a stale active-session entry on ${registryPath} from dead task ${outcome.holderTaskId} (idle ${outcome.ageMs}ms)`,
      );
      void this.store.recordRunAuditEvent?.({
        taskId,
        agentId: "executor",
        runId: generateSyntheticRunId("session-path-reclaim", taskId),
        domain: "database",
        mutationType: "session:reclaim-stale-foreign-path",
        target: taskId,
        metadata: { taskId, holderTaskId: outcome.holderTaskId, kind, ageMs: outcome.ageMs },
      })?.catch?.(() => undefined);
    }
  }

  private setActiveSession(taskId: string, sessionState: ActiveExecutorSessionState, worktreePath: string): void {
    this.activeSessions.set(taskId, sessionState);
    this.acquireSessionRegistryPath(taskId, this.sessionRegistryPath(taskId, worktreePath), "executor", taskId);
  }

  private markGraphExecuteSelfRequeued(taskId: string): void {
    if (this.graphRouting.has(taskId)) {
      this.graphExecuteSelfRequeued.add(taskId);
    }
  }

  private deleteActiveSession(taskId: string, worktreePath?: string): void {
    this.activeSessions.delete(taskId);
    // U5: drop the effective column-agent principal for this task's session.
    this.effectiveColumnAgentByTask.delete(taskId);
    // FNXC:Workspace 2026-06-21-12:00: KTD2 — when no explicit path is given, unregister EVERY worktree path the task holds (a workspace task holds N sub-repo paths); single-repo tasks resolve a one-element set.
    const resolvedWorktreePaths = worktreePath ? [worktreePath] : this.getActiveWorktreePaths(taskId);
    for (const path of resolvedWorktreePaths) {
      // FNXC:Workspace 2026-06-24-15:45: map through sessionRegistryPath so the task-scoped synthetic
      // session key registered for the shared workspace browse-root is the one we unregister (the
      // in-memory Set holds the REAL root). Non-workspace/sub-repo paths pass through unchanged.
      activeSessionRegistry.unregisterPath(this.sessionRegistryPath(taskId, path));
    }
  }

  private setActiveStepExecutor(taskId: string, stepExecutor: StepSessionExecutor, worktreePath: string, seenSteeringIds = new Set<string>()): void {
    this.activeStepExecutors.set(taskId, stepExecutor);
    this.activeStepExecutorSeenSteeringIds.set(taskId, seenSteeringIds);
    this.acquireSessionRegistryPath(taskId, this.sessionRegistryPath(taskId, worktreePath), "step-session", `${taskId}#step-session`);
  }

  private deleteActiveStepExecutor(taskId: string, worktreePath?: string): void {
    this.activeStepExecutors.delete(taskId);
    this.activeStepExecutorSeenSteeringIds.delete(taskId);
    // U5: drop the effective column-agent principal for this task's step session.
    this.effectiveColumnAgentByTask.delete(taskId);
    // FNXC:Workspace 2026-06-21-12:00: KTD2 — unregister every held worktree path (Set), not one.
    const resolvedWorktreePaths = worktreePath ? [worktreePath] : this.getActiveWorktreePaths(taskId);
    for (const path of resolvedWorktreePaths) {
      // FNXC:Workspace 2026-06-24-15:45: map through sessionRegistryPath so the task-scoped synthetic
      // session key registered for the shared workspace browse-root is the one we unregister (the
      // in-memory Set holds the REAL root). Non-workspace/sub-repo paths pass through unchanged.
      activeSessionRegistry.unregisterPath(this.sessionRegistryPath(taskId, path));
    }
  }

  private setActiveWorkflowStepSession(taskId: string, session: AgentSession, worktreePath: string, seenSteeringIds = new Set<string>()): void {
    this.activeWorkflowStepSessions.set(taskId, session);
    this.activeWorkflowStepSessionSeenSteeringIds.set(taskId, seenSteeringIds);
    this.acquireSessionRegistryPath(taskId, this.sessionRegistryPath(taskId, worktreePath), "workflow-step", `${taskId}#workflow-step`);
  }

  private deleteActiveWorkflowStepSession(taskId: string, worktreePath?: string): void {
    this.activeWorkflowStepSessions.delete(taskId);
    this.activeWorkflowStepSessionSeenSteeringIds.delete(taskId);
    // FNXC:Workspace 2026-06-21-12:00: KTD2 — unregister every held worktree path (Set), not one.
    const resolvedWorktreePaths = worktreePath ? [worktreePath] : this.getActiveWorktreePaths(taskId);
    for (const path of resolvedWorktreePaths) {
      // FNXC:Workspace 2026-06-24-15:45: map through sessionRegistryPath so the task-scoped synthetic
      // session key registered for the shared workspace browse-root is the one we unregister (the
      // in-memory Set holds the REAL root). Non-workspace/sub-repo paths pass through unchanged.
      activeSessionRegistry.unregisterPath(this.sessionRegistryPath(taskId, path));
    }
  }

  private registerConfiguredCommandController(taskId: string, controller: AbortController): void {
    const controllers = this.activeConfiguredCommandControllers.get(taskId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeConfiguredCommandControllers.set(taskId, controllers);
  }

  private unregisterConfiguredCommandController(taskId: string, controller: AbortController): void {
    const controllers = this.activeConfiguredCommandControllers.get(taskId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) {
      this.activeConfiguredCommandControllers.delete(taskId);
    }
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
    const renewedAt = new Date().toISOString();
    if (this.options.agentStore) {
      await this.options.agentStore.checkoutTask(
        agentId,
        taskId,
        {
          nodeId,
          runId,
          leaseEpoch,
          renewedAt,
        },
        this.getRunContextFor(taskId),
      );
      return;
    }
    await this.store.renewCheckoutLease(taskId, {
      checkoutRunId: runId ?? null,
      checkoutLeaseRenewedAt: renewedAt,
    });
  }

  private async finalizeAlreadyReviewedTask(taskId: string): Promise<"merged" | "blocked" | "missing"> {
    const latestTask = await this.store.getTask(taskId);
    /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the board's own review lane. Spelled as the
       literal, this reported "missing" — a word that reads as "the task is gone" — for a card sitting in
       review on a renamed board, and the already-reviewed finalize never ran. */
    if (!latestTask || latestTask.column !== (await this.resolveResumeLanes(taskId)).review) {
      return "missing";
    }

    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-14:40 (outer question resolved, inner one not):
    The guard directly above compares against `(await this.resolveResumeLanes(taskId)).review`, then this
    call re-asked with the literal — so a card that just PASSED the resolved lane check was refused by the
    unresolved blocker on any renamed board.
    */
    const resumeReviewLane = (await this.resolveResumeLanes(taskId)).review;
    const blocker = getTaskMergeBlocker(latestTask, {
      reviewColumns: new Set([resumeReviewLane ?? "in-review"]),
    });
    if (blocker) {
      await this.store.logEntry(taskId, "Task already in-review; merge deferred", blocker, this.getRunContextFor(taskId));
      return "blocked";
    }

    await this.store.logEntry(
      taskId,
      "Task already in-review after completion — finalizing merge",
      undefined,
      this.getRunContextFor(taskId),
    );
    await this.store.mergeTask(taskId);
    return "merged";
  }

  private async getExecutionPauseLabel(): Promise<"global pause" | "engine pause" | null> {
    const settings = await this.store.getSettings();
    if (settings.globalPause) return "global pause";
    if (settings.enginePaused) return "engine pause";
    return null;
  }

  private async shouldDeferCompletionForGlobalPause(
    taskId: string,
    context: string,
  ): Promise<boolean> {
    const settings = await this.store.getSettings();
    if (!settings.globalPause) {
      return false;
    }

    this.clearCompletedTaskWatchdog(taskId);
    executorLog.log(`${taskId}: completion handoff deferred — global pause active (${context})`);
    await this.store.logEntry(
      taskId,
      `Completion handoff deferred — global pause active (${context})`,
      undefined,
      this.getRunContextFor(taskId),
    ).catch(() => undefined);
    return true;
  }

  private async shouldDeferWorkflowStepCompletion(
    taskId: string,
    context: string,
  ): Promise<boolean> {
    return shouldDeferWorkflowStepCompletionImpl(
      {
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        pausedAborted: this.pausedAborted,
        userCanceledTaskIds: this.userCanceledTaskIds,
        clearCompletedTaskWatchdog: (id) => this.clearCompletedTaskWatchdog(id),
        resolveResumeLanes: (id) => this.resolveResumeLanes(id),
        shouldDeferCompletionForGlobalPause: (id, ctx) => this.shouldDeferCompletionForGlobalPause(id, ctx),
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
    const agentId = this.getRunContextFor(task.id)?.agentId;
    await this.generateCompletionFeatureVideo(task);
    if (reason.startsWith("workflow-")) {
      await ensureWorkflowCompletionSummary(this.store, task as TaskDetail, {
        reason,
        runId,
      }).catch((error: unknown) => {
        executorLog.warn(`${task.id}: failed to record workflow completion summary: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    const handedOff = await this.store.handoffToReview(task.id, {
      ownerAgentId: agentId ?? null,
      evidence: {
        reason,
        runId,
        agentId,
      },
    });

    const settings = await this.store.getSettings();
    if (isMergeRequestContractShadowEnabled(settings)) {
      this.store.setCompletionHandoffAcceptedMarker(task.id, {
        source: `executor:${reason}`,
      });
      await this.store.upsertMergeRequestRecord(task.id, {
        state: handedOff.autoMerge === false ? "manual-required" : "queued",
      });
    }

    return handedOff;
  }

  /*
  FNXC:ReviewArtifacts 2026-07-19-10:00:
  A successful executor handoff may offer reviewers a short local feature-video, but
  capture is strictly best-effort. Bound and swallow this optional work before the
  review transition so browser, scenario, and artifact failures never delay or fail it.
  */
  private async generateCompletionFeatureVideo(task: Task): Promise<void> {
    try {
      const [settings, detail] = await Promise.all([this.store.getSettings(), this.store.getTask(task.id)]);
      const generator = this.options.reviewArtifactGenerator ?? generateFeatureVideo;
      const result = await this.awaitFeatureVideoBounded(generator({ store: this.store, task: detail ?? task, settings }));
      executorLog.log(`${task.id}: feature-video ${result.status}${"reason" in result ? ` (${result.reason})` : ""}`);
    } catch (error) {
      executorLog.warn(`${task.id}: feature-video capture ignored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async awaitFeatureVideoBounded(result: Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult>): Promise<import("./review-artifacts/feature-video.js").FeatureVideoResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        result,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("feature-video timeout")), 20_000); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private getModelRegistry(): Promise<ModelRegistry> {
    if (!this._modelRegistry) {
      const authStorage = createFusionAuthStorage();
      this._modelRegistry = createFusionModelRegistry(authStorage);
    }
    return this._modelRegistry;
  }

  private get approvalRequestStore(): ApprovalRequestStore {
    if (!this._approvalRequestStore) {
      const layer = this.store.getAsyncLayer();
      if (!layer) throw new Error("Executor TaskStore is missing its PostgreSQL AsyncDataLayer");
      /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Runtime approval persistence is PostgreSQL-only; never reopen the removed project SQLite database when backend wiring is incomplete. */
      this._approvalRequestStore = new ApprovalRequestStore(null, { asyncLayer: layer });
    }
    return this._approvalRequestStore;
  }

  private buildActionGateContext(taskId: string | undefined, agent: Agent | null | undefined, projectDefaultPolicy?: { rules?: Partial<import("@fusion/core").AgentPermissionPolicy["rules"]>; toolRules?: import("@fusion/core").AgentPermissionPolicyToolRules }): AgentActionGateContext | undefined {
    return buildActionGateContextImpl(
      {
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        approvalSuspended: this.approvalSuspended,
        approvalRequestStore: this.approvalRequestStore,
      },
      taskId,
      agent,
      projectDefaultPolicy,
    );
  }

  /** Returns the set of task IDs currently being executed. */
  getExecutingTaskIds(): Set<string> {
    // Graph-routed tasks count as executing for their WHOLE interpreter run —
    // between seams the inner execute() has released this.executing, but the
    // graph still owns the lifecycle; self-healing/recovery must not touch it.
    return new Set([
      ...this.executing,
      ...this.recoveringCompleted,
      ...this.resumingUnpaused,
      ...TaskExecutor.processWideGraphRouting,
    ]);
  }

  /**
   * FNXC:TaskTiming 2026-07-30-21:40:
   * A planning segment has one owner: a graph Plan Review session is live only
   * while both its session registration and planning ownership marker remain.
   * This is intentionally narrower than isTaskActive(), which also covers
   * implementation and non-planning workflow sessions.
   */
  hasActivePlanningWorkflowSession(taskId: string): boolean {
    return this.activePlanningWorkflowSessions.has(taskId) && this.activeWorkflowStepSessions.has(taskId);
  }

  isTaskActive(taskId: string): boolean {
    return (
      this.executing.has(taskId)
      || this.activeSessions.has(taskId)
      || this.recoveringCompleted.has(taskId)
      || TaskExecutor.processWideGraphRouting.has(taskId)
    );
  }

  /*
  FNXC:PlannerOversight 2026-07-21-22:56:
  Overseer retry_step must not hard-cancel a live agent (FN-8471 thrash: status=failed from a raced graph park while step-execute still held a session, then overseer moveTask→todo aborted the live work three times). True when any in-process graph claim, coding/step/CLI session, or unpause-resume handoff still owns the task — broader than isTaskActive so step/workflow/CLI surfaces are covered.
  */
  isTaskLiveForOverseerRetry(taskId: string): boolean {
    // isTaskActive covers executing/graphRouting/coding session/recoveringCompleted;
    // hasLiveTaskSessionSurface adds step/workflow/CLI surfaces; resumingUnpaused is the unpause handoff gap.
    return (
      this.isTaskActive(taskId)
      || this.hasLiveTaskSessionSurface(taskId)
      || this.resumingUnpaused.has(taskId)
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
    return this.activeSessions.has(taskId)
      || this.activeStepExecutors.has(taskId)
      || this.activeWorkflowStepSessions.has(taskId)
      || this.activeCliTaskSessions.has(taskId)
      || activeSessionRegistry.pathsForTask(taskId).length > 0;
  }

  clearPhantomExecutorBinding(taskId: string, options: { preserveWorktrees?: boolean } = {}): boolean {
    return clearPhantomExecutorBindingImpl(
      {
        hasLiveSessionSurface: (id) => this.hasLiveSessionSurface(id),
        getActiveWorktreePaths: (id) => this.getActiveWorktreePaths(id),
        activeWorktrees: this.activeWorktrees,
        executing: this.executing,
        recoveringCompleted: this.recoveringCompleted,
        resumingUnpaused: this.resumingUnpaused,
        approvalSuspended: this.approvalSuspended,
        approvalResumeAfterUnwind: this.approvalResumeAfterUnwind,
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        effectiveColumnAgentByTask: this.effectiveColumnAgentByTask,
      },
      taskId,
      options,
    );
  }

    isEphemeralDeletionPending(agentId: string): boolean {
    return this.pendingEphemeralDeletions.has(agentId);
  }

  disposeEphemeralTimers(): void {
    this.pendingEphemeralDeletions.clear();
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
    let set = this.activeSubagentSessions.get(taskId);
    if (!set) {
      set = new Set();
      this.activeSubagentSessions.set(taskId, set);
    }
    set.add(session);
  }

  /**
   * Deregister a subagent session that has finished naturally. The reviewer's
   * own `finally` block disposes the session — this just removes it from the
   * map.
   */
  private unregisterSubagentSession(taskId: string, session: AgentSession): void {
    const set = this.activeSubagentSessions.get(taskId);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) this.activeSubagentSessions.delete(taskId);
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
    const wrapped = disposal
      .catch((err) => {
        executorLog.warn(`${taskId}: tracked disposal failed: ${err}`);
      })
      .finally(() => {
        if (this.pendingTaskDisposals.get(taskId) === wrapped) {
          this.pendingTaskDisposals.delete(taskId);
        }
      });
    this.pendingTaskDisposals.set(taskId, wrapped);
  }

  /**
   * FN-5256: synchronously await session disposal so callers (e.g. pause-before-park)
   * can rely on the worktree-bound shells being reaped before they return. Mirrors
   * `abortInFlightTaskWork`, but awaits the async `abort()` / `terminateAllSessions()`
   * calls instead of fire-and-forget.
   */
  async awaitAbortInFlightTaskWork(taskId: string, reason: string, options: { userCanceled?: boolean } = {}): Promise<void> {
    return awaitAbortInFlightTaskWorkImpl(
      {
        userCanceledTaskIds: this.userCanceledTaskIds,
        markPausedAborted: (id, provenance, source) => this.markPausedAborted(id, provenance, source),
        untrackStuckTask: (id) => { this.options.stuckTaskDetector?.untrackTask(id); },
        clearWorkflowRerunWatchdog: (id) => this.clearWorkflowRerunWatchdog(id),
        clearCompletedTaskWatchdog: (id) => this.clearCompletedTaskWatchdog(id),
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        activeSessions: this.activeSessions,
        deleteActiveSession: (id) => this.deleteActiveSession(id),
        activeStepExecutors: this.activeStepExecutors,
        deleteActiveStepExecutor: (id) => this.deleteActiveStepExecutor(id),
        activeWorkflowStepSessions: this.activeWorkflowStepSessions,
        deleteActiveWorkflowStepSession: (id) => this.deleteActiveWorkflowStepSession(id),
        activeConfiguredCommandControllers: this.activeConfiguredCommandControllers,
        activeWorkflowGraphAbortControllers: this.activeWorkflowGraphAbortControllers,
        activeSubagentSessions: this.activeSubagentSessions,
        disposeSubagentsForTask: (id, r) => this.disposeSubagentsForTask(id, r),
        activeCliTaskSessions: this.activeCliTaskSessions,
        loopRecoveryState: this.loopRecoveryState,
        stuckAborted: this.stuckAborted,
        safeLogEntry: (id, msg) => this.safeLogEntry(id, msg),
      },
      taskId,
      reason,
      options,
    );
  }

  async abortAllInFlight(reason: string): Promise<void> {
    return abortAllInFlightImpl(
      {
        activeSessions: this.activeSessions,
        activeStepExecutors: this.activeStepExecutors,
        activeWorkflowStepSessions: this.activeWorkflowStepSessions,
        activeConfiguredCommandControllers: this.activeConfiguredCommandControllers,
        activeWorkflowGraphAbortControllers: this.activeWorkflowGraphAbortControllers,
        activeSubagentSessions: this.activeSubagentSessions,
        activeCliTaskSessions: this.activeCliTaskSessions,
        childSessions: this.childSessions,
        awaitAbortInFlightTaskWork: (id, r) => this.awaitAbortInFlightTaskWork(id, r),
      },
      reason,
    );
  }


  abortAllSessionBash(): void {
    for (const [taskId, { session }] of this.activeSessions) {
      try {
        session.abortBash();
      } catch (err) {
        executorLog.warn(`abortAllSessionBash: failed for task ${taskId}: ${err}`);
      }
    }
    for (const [agentId, session] of this.childSessions) {
      try {
        session.abortBash();
      } catch (err) {
        executorLog.warn(`abortAllSessionBash: failed for child agent ${agentId}: ${err}`);
      }
    }
    for (const [taskId, stepExecutor] of this.activeStepExecutors) {
      try {
        stepExecutor.abortAllSessionBash();
      } catch (err) {
        executorLog.warn(`abortAllSessionBash: failed for step executor ${taskId}: ${err}`);
      }
    }
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
    if (!this.approvalSuspended.has(taskId)) return false;
    this.clearPausedAborted(taskId);
    await this.store.logEntry(
      taskId,
      `Execution suspended for approval — ${surface} disposed; task remains in progress for decision resume`,
      undefined,
      this.getRunContextFor(taskId),
    );
    executorLog.log(`${taskId}: approval suspension parked after ${surface} disposal`);
    return true;
  }

  private async dispatchUnpauseResume(task: Task): Promise<boolean> {
    return dispatchUnpauseResumeImpl(
      {
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
        executing: this.executing,
        resumingUnpaused: this.resumingUnpaused,
        recoveringCompleted: this.recoveringCompleted,
        activeSessions: this.activeSessions,
        activeStepExecutors: this.activeStepExecutors,
        activeWorkflowStepSessions: this.activeWorkflowStepSessions,
        graphRouting: this.graphRouting,
        approvalSuspended: this.approvalSuspended,
        getExecutionPauseLabel: () => this.getExecutionPauseLabel(),
        clearResumeFailureState: (t: Task) => this.clearResumeFailureState(t),
        recoverApprovedStepsOnResume: (taskId: string) => this.recoverApprovedStepsOnResume(taskId),
        recoverCompletedTask: (t: Task) => this.recoverCompletedTask(t),
        execute: (t: Task) => this.execute(t),
      },
      task,
    );
  }

  private async resumeApprovalAfterUnwindIfNeeded(taskId: string): Promise<boolean> {
    /*
    FNXC:ApprovalResume 2026-07-12-18:35:
    MAIN-008 review: this runs from execute()'s outer finally. A getTask throw
    (hard-deleted task between deferral and consume) must not escape finally and
    mask the original execute outcome — treat unreadable tasks as no deferred resume.
    */
    if (!this.approvalResumeAfterUnwind.delete(taskId)) return false;
    let latestTask;
    try {
      latestTask = await this.store.getTask(taskId);
    } catch (error) {
      executorLog.warn(`${taskId}: failed to read latest task state for deferred approval resume: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (latestTask.paused || latestTask.userPaused
      || latestTask.column !== (await this.resolveResumeLanes(taskId)).wip) return false;
    return this.dispatchUnpauseResume(latestTask);
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
    const sem = this.options.semaphore;
    if (!sem) {
      takePreHeldExecutorSlot(taskId);
      return work();
    }
    if (this.outerConcurrencyClaims.has(taskId)) {
      return work();
    }

    const runUnderOuterClaim = async (): Promise<T> => {
      this.outerConcurrencyClaims.add(taskId);
      try {
        return await work();
      } finally {
        this.outerConcurrencyClaims.delete(taskId);
      }
    };

    if (takePreHeldExecutorSlot(taskId)) {
      try {
        return await runUnderOuterClaim();
      } finally {
        sem.release();
      }
    }
    return sem.run(runUnderOuterClaim, PRIORITY_EXECUTE);
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
    FNXC:EngineDiagnostics 2026-07-26-09:39:
    Executor bookkeeping that fires on every dispatch/session (construct, execute() entry, worktree ready, session create/register, prompt start, graph event stream, column-boundary warns-as-info, model/plugin setup, skip/duplicate/no-op guards) is debug-only (FUSION_DEBUG=executor). Keep log/warn/error for lifecycle outcomes operators act on: Starting task, ✓/✗ completion, failures, requeues, handoffs, stuck kills, verification failures, real moves.
    */
    executorLog.debug(`TaskExecutor constructed (rootDir=${rootDir}, hasSemaphore=${!!options.semaphore}, hasStuckDetector=${!!options.stuckTaskDetector})`);
    this.unregisterTaskMoveDisposer = registerTaskMoveDisposer(store, async (task) => {
      // Start both paths without awaiting between them. Each synchronously
      // detaches its current targets before its first await, fencing late
      // cleanup from a replacement execution after the move timeout expires.
      const children = this.terminateAllChildren(task.id);
      const activeWork = this.awaitAbortInFlightTaskWork(task.id, "user moved task from in-progress to todo", {
        userCanceled: true,
      });
      await Promise.all([children, activeWork]);
    });
    /* FNXC:WorkflowLifecycle 2026-07-16-10:00: Executor replaces the baseline only for its own TaskStore, so archive awaits abort/sweep/removal before branch deletion without cross-store coupling. */
    this.unregisterArchiveWorktreeDisposer = registerArchiveWorktreeDisposer(store, async (task) => {
      if (!task.worktree || await canonicalizeWorktreePath(task.worktree) === await canonicalizeWorktreePath(this.rootDir)) return;
      await this.awaitAbortInFlightTaskWork(task.id, "task archived");
      for (const path of activeSessionRegistry.pathsForTask(task.id)) activeSessionRegistry.unregisterPath(path);
      await this.removeOwnWorktreeWithReconcile({worktreePath: task.worktree, settings: await store.getSettings(), taskId: task.id, reason: RemovalReason.ExecutorDispose});
      task.worktree = undefined;
    });
    this.unregisterArchiveWorkspaceWorktreeDisposer = registerArchiveWorkspaceWorktreeDisposer(store, async (task, plan) => {
      const removed: string[] = [];
      const failed: {repoRel: string; error: unknown}[] = [];
      await this.awaitAbortInFlightTaskWork(task.id, "workspace task archived");
      for (const entry of plan) {
        try {
          if (await canonicalizeWorktreePath(entry.worktreePath) === await canonicalizeWorktreePath(entry.repoRootDir)) throw new Error("Refusing to remove workspace repository root");
          activeSessionRegistry.unregisterPath(entry.worktreePath);
          await removeWorktree({worktreePath: entry.worktreePath, rootDir: entry.repoRootDir, settings: await store.getSettings(), taskId: task.id, reason: RemovalReason.ExecutorDispose, force: true});
          /* FNXC:WorkflowLifecycle 2026-07-16-16:00: Archive metadata can contain valid Git refs with shell metacharacters. Pass the ref as an argv value so cleanup never evaluates it as shell code. */
          await execFileAsync("git", ["branch", "-D", entry.branch], {cwd: entry.repoRootDir, timeout: 120_000, maxBuffer: 10 * 1024 * 1024});
          if (task.workspaceWorktrees) for (const repoRel of [entry.repoRel, ...entry.aliasRepoRels]) delete task.workspaceWorktrees[repoRel];
          removed.push(entry.repoRel);
        } catch (error) { failed.push({repoRel: entry.repoRel, error}); }
      }
      return {removed, failed};
    });

    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:20 (was FLAGGED AND LEFT COUNTED; RESOLVED below —
    still do NOT convert with `resolveTaskWorkflowIrSync` / `resolvePlannerLanes`):

    Four lifecycle literals live in this listener and they are genuinely wrong on a renamed board:
    execution never starts on a move INTO the board's own wip lane, terminal session release never
    runs on a move into its archive lane, and the two `from` guards never fire, so in-flight work is
    not aborted when a card leaves implementation. Nothing errors; the engine simply stops reacting.

    THE OBVIOUS FIX IS INERT, AND THAT IS NOW PROVED RATHER THAN ARGUED. `task:moved` is emitted
    synchronously, so an await here reorders this handler against every other subscriber — which
    points at the sync IR path. That path cannot answer for a renamed board, for TWO independent
    reasons (`sync-workflow-ir-second-blocker.test.ts`):

      1. `getTaskWorkflowSelectionImpl` returns `undefined` unconditionally under PostgreSQL, so
         `resolveTaskWorkflowIrSync` always takes its `!workflowId` branch;
      2. even with a selection, the CUSTOM-workflow branch loads its IR through `store.db`, whose
         implementation is an unconditional throw — so it falls into the catch and returns the
         DEFAULT IR anyway.

    A renamed lane IS a custom workflow, so (2) alone is decisive: the sync path can never serve this
    listener's case. `check-inert-sync-lane-conversions` already baselines twenty guards in exactly
    that state in `scheduler.ts`; these four must not join them.

    They stay literal and COUNTED, which is the honest state — an unconverted literal is visible to
    the census, while an inert conversion leaves the backlog and takes the evidence with it.

    THE CRITERION IS NARROWER THAN "THE LISTENER IS SYNC", and I got this wrong first time elsewhere:
    what blocks a guard is whether ITS ANSWER IS CONSUMED SYNCHRONOUSLY, not whether it happens to sit
    inside a synchronous function. In `self-healing.ts`'s fan-out, three of four guards only gated work
    the listener already `void`s, so they were reachable by the async resolver all along and are now
    converted. These four are NOT that case, for two independent reasons:

      A. `trackTaskDisposal` writes `pendingTaskDisposals` in THIS tick, and the `to === wip` branch
         above READS that map to serialise a fast bounce (in-progress -> todo -> in-progress; the
         FN-5256 note it carries). Deferring the branch selection to a microtask lets the second
         event's prologue read the map before the first event's write lands — which reopens exactly
         the race that comment exists to close.
      B. This is an if / else-if CHAIN, so the guards are entangled: converting one changes which
         branch a move falls into. They convert together or not at all, and (A) blocks the set.

    UNBLOCKING therefore needs the async resolver reachable from a SYNCHRONOUS consumer, which means
    either a sync reader that answers for custom workflows AND survives a writer on another node, or
    restructuring the disposal bookkeeping so nothing is read in-tick — the constraints are written up
    in `sync-workflow-ir-second-blocker.test.ts`.

    FNXC:WorkflowResolvedColumns 2026-07-31-23:55 — RESOLVED BY A THIRD ROUTE, and the analysis above
    is kept because it is what rules the other two out.

    The block reduces to "no resolver can be CALLED here". It never required that the answer be
    unavailable — only that this listener cannot go and fetch it. So the lanes are resolved ONCE by
    the emitter, which is already async, and ride along on the event payload (`moves.ts`). Every
    objection above is about calling a resolver in-tick, so none of them survive the move:

      - (2)/the PostgreSQL sync-IR dead end: no sync resolver is used, so neither blocker applies.
      - (A) the in-tick `pendingTaskDisposals` race: NO await is introduced. Destructuring one more
        field is as synchronous as reading `to`, so branch selection still happens in this tick and
        the FN-5256 fast-bounce serialisation is untouched.
      - (B) the entangled if / else-if chain: satisfied rather than dodged — all four convert in
        this one commit, so no move can fall into a different branch than before.

    THE RESIDUAL RISK MOVES TO THE EMITTER, AND IT IS NOT YET CLOSED — stated plainly because the
    tempting version of this note is the false one. `lanes` is OPTIONAL on the payload
    (`store.ts`: `lanes?: TaskMoveLanes`) and the fallback below is the LEGACY LITERAL, so a
    `task:moved` published without it leaves these four guards exactly as inert as before, on a
    renamed board, with nothing failing. The conversion is only as good as the emitters.

    That is a strictly better position than the flagged state — the fallback is reached on one path
    instead of every path, and `moves.ts` (the move path these branches actually serve) does pass
    lanes — but it is NOT the compile-time guarantee it would be if the field were required.
    Requiring it is the right end state and is deliberately NOT done here: it retypes every
    `task:moved` emitter, which is its own change with its own blast radius, and bundling it would
    put a mechanical retype in the same commit as this behavior change.

    FOLLOW-UP, tracked with the emitter-side work: either make `lanes` required, or add a gate that
    asserts every `task:moved` emit site supplies it. Until one of those lands, treat the fallback
    as a live inertness path rather than defensive dead code.
    */
    store.on("task:moved", ({ task, from, to, source, lanes }) => {
      executorLog.log(`[event:task:moved] ${task.id}: ${from} → ${to}`);
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-21:30 (fleet):
      Lanes come from the EMITTER (see `moves.ts`), not from a resolver called here.

      This listener is synchronous and its branches start execution, dispose worktrees and release
      sessions, so its prologue is load-bearing — an await ahead of those branches would defer the
      `execute()` dispatch itself. The sync IR resolver is not an option either: it answers with the
      DEFAULT workflow under PostgreSQL, so a guard written through it is inert.

      Fail-soft to the legacy ids when the emit path could not resolve, matching every other consumer
      of this payload. `wipLane`/`archivedLane`/`holdLane` are read as SINGLE ids rather than sets
      because each branch below is a lane-identity test on one column, which is what the literals were.
      */
      const wipLane = lanes?.wip ?? "in-progress";
      const archivedLane = lanes?.archived ?? "archived";
      const holdLane = lanes?.hold ?? "todo";
      if (to === wipLane) {
        this.userCanceledTaskIds.delete(task.id);
        if (this.recoveringCompleted.has(task.id)) {
          executorLog.debug(`[event:task:moved] Skipping execute() for ${task.id} — completed-task recovery in progress`);
          return;
        }
        this.clearWorkflowRerunWatchdog(task.id);
        executorLog.log(`[event:task:moved] Initiating execute() for ${task.id}`);
        void (async () => {
          // FN-5256: if the prior session is still being torn down (because the
          // task was just moved away from in-progress), wait for the worktree-
          // bound shells to reap before we acquire/create a new worktree. Without
          // this, a fast bounce (in-progress → todo → in-progress) races the
          // executor's own conflict cleanup against a still-live shell.
          const pending = this.pendingTaskDisposals.get(task.id);
          if (pending) {
            executorLog.log(`[event:task:moved] Awaiting pending disposal for ${task.id} before dispatch`);
            await pending;
          }
          const taskForExecution = await this.resetMergeStateIfNeeded(task, from);
          await this.execute(taskForExecution);
        })().catch((err) =>
          executorLog.error(`Failed to start ${task.id}:`, err),
        );
      } else if (to === archivedLane) {
        /*
        FNXC:WorkflowLifecycle 2026-07-09-00:05:
        Archived is terminal, so it must release every active-session registry entry the
        task holds. Plan Review / other workflow-step and step-session sessions run while
        the task is in triage/planning/todo (not in-progress), so the old
        `from === "in-progress"`-only disposal branch below never fired for them — the
        registry entry (activeSessions / activeStepExecutors / activeWorkflowStepSessions,
        keyed on the shared project browse root) leaked past archive and blocked a
        successor task from acquiring the same session path with
        ActiveSessionPathHeldByForeignTaskError (FN-7717 / NEXT-508 -> NEXT-433). We
        deliberately do NOT do this for to === "done" / "in-review": those columns
        legitimately hold ai-merge / workspace-repo-land merge leases that must survive
        the transition (FN-6736 / Phase C/D merge-lease guarantees).

        This branch is checked BEFORE `from === "in-progress"` (and handles it too — a
        task can be archived directly from in-progress via fn_task_archive, a single
        `task:moved` event with no intermediate todo hop). Ordering the plain
        `from === "in-progress"`-only branch first would let that direct
        in-progress → archived transition fall into the narrower branch and skip the
        leaked-entry sweep below, re-opening the exact class of leak this fix closes for
        that one origin column. `awaitAbortInFlightTaskWork` here is the same call the
        in-progress branch makes (superset of its cleanup), so no case regresses.
        */
        this.trackTaskDisposal(
          task.id,
          this.awaitAbortInFlightTaskWork(task.id, "task archived").then(() => {
            // Belt-and-suspenders sweep: clear any registry entry that survived the
            // abort above because its in-memory session map was already empty
            // (a leaked entry with no live session to abort).
            for (const path of activeSessionRegistry.pathsForTask(task.id)) {
              activeSessionRegistry.unregisterPath(path);
            }
          }),
        );
      } else if (this.isBackwardMoveOutOfPlanning(task.id, from, to, lanes)) {
        /*
        FNXC:PlanningEvacuation 2026-07-25-23:00:
        A card pulled BACKWARD out of a planner lane (the reported case: todo → Ideas) must stop all
        engine work on it, not just its planning session. Plan Review and other pre-execution graph
        nodes run while the card sits in todo/triage, so without this branch the reviewer kept
        streaming against a card the operator had withdrawn. Forward transitions are excluded — those
        are the card advancing, and their own lanes own the handoff. Also release the pre-execution
        worktree acquired at planning time so a withdrawn card leaves nothing behind on disk.
        */
        this.trackTaskDisposal(
          task.id,
          this.awaitAbortInFlightTaskWork(task.id, `task moved out of planning to ${to}`, {
            userCanceled: source === "user",
          }).then(async () => { await this.releasePreExecutionWorktree(task.id, `moved to ${to}`); }),
        );
      } else if (from === wipLane) {
        if (this.workflowLifecycleMovesInFlight.has(task.id) && this.graphRouting.has(task.id)) {
          executorLog.log(
            `[event:task:moved] Preserving graph run for ${task.id} across its own ${from} → ${to} boundary`,
          );
          return;
        }
        this.trackTaskDisposal(
          task.id,
          this.awaitAbortInFlightTaskWork(task.id, `parent moved from in-progress to ${to}`, {
            userCanceled: source === "user" && to === holdLane,
          }),
        );
      }
    });

    store.on("task:deleted", (task) => {
      this.approvalSuspended.delete(task.id);
      this.approvalResumeAfterUnwind.delete(task.id);
      this.trackTaskDisposal(
        task.id,
        this.awaitAbortInFlightTaskWork(task.id, "task soft-deleted", { userCanceled: true }),
      );
    });

    // When a task is paused while executing, terminate the agent session.
    // When steering comments are added during execution, inject them into the running session.
    //
    // Real-time steering comment injection mechanism:
    // 1. When execution starts, we initialize seenSteeringIds with all existing comment IDs
    // 2. On each task:updated event, we check if there are new comments not in seenSteeringIds
    // 3. New comments are injected via session.steer() which queues them for delivery
    //    after the current assistant turn completes (before the next LLM call)
    // 4. Comments are marked as seen BEFORE injection to prevent retry loops on failure
    // 5. Each injection is logged to the task for user visibility
    store.on("task:updated", async (task) => {
      try {
        // FN-5256: handle pause by synchronously reaping every active session
        // surface in one shot. Awaiting the abort ensures spawned shells are
        // disposed before any re-dispatch can race the worktree.
        if (
          task.paused
          && (
            this.activeSessions.has(task.id)
            || this.activeStepExecutors.has(task.id)
            || this.activeWorkflowStepSessions.has(task.id)
            || this.activeConfiguredCommandControllers.has(task.id)
          )
        ) {
          executorLog.log(`Pausing ${task.id} — awaiting in-flight session disposal`);
          await this.awaitAbortInFlightTaskWork(task.id, "task paused");
          return;
        }

        // Handle unpause of an in-progress task with no active session.
        // Approval can be decided while the old session is still unwinding;
        // remember that edge instead of losing the only task:updated event.
        /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): both checks in this listener ask "is
           this card still in the wip lane?"; one snapshot for the pair. With the literal neither fired on a
           renamed board — an unpaused card with no active session was never resumed. */
        const unpauseWipLane = (await this.resolveResumeLanes(task.id)).wip;
        if (!task.paused && task.column === unpauseWipLane && this.approvalSuspended.has(task.id)) {
          if (
            this.executing.has(task.id)
            || this.activeSessions.has(task.id)
            || this.activeStepExecutors.has(task.id)
            || this.activeWorkflowStepSessions.has(task.id)
          ) {
            this.approvalResumeAfterUnwind.add(task.id);
            executorLog.log(`${task.id}: approval decision received during session unwind — deferred one resume`);
            return;
          }
        }

        // Explicit unpause updates and non-failed orphan updates can resume here;
        // startup failed-orphan recovery is owned by resumeOrphaned().
        // dispatchUnpauseResume owns the terminal-failure and duplicate guards.
        if (
          !task.paused
          && task.column === unpauseWipLane
          && !this.activeSessions.has(task.id)
          && !this.activeStepExecutors.has(task.id)
          && !this.activeWorkflowStepSessions.has(task.id)
        ) {
          await this.dispatchUnpauseResume(task);
          return;
        }

        // Column-agent restart-invalidation (plan U5, R7/KTD-4). A workflow-
        // definition edit (re-pointing a column's agent) or an agent runtimeConfig
        // change mutates NOTHING the task-field diff below observes — the watcher
        // would never see it. KTD-4's primary mechanism is event-driven invalidation,
        // but no `workflow:updated`/`agent:updated` store event exists on TaskStore
        // today (only task:/settings: events). Per the unit's documented fallback, we
        // re-resolve the column-effective agent/model on each `task:updated` tick for
        // GRAPH-MODE active entries ONLY (those whose session adopted a column agent —
        // `lastEffectiveColumnAgentId != null`). This is bounded by the active session
        // count, and only graph runs with a real column binding pay any cost. The
        // weaker guarantee (vs an arbitrary-time diff) is that a stale session
        // restarts on the next tick, not instantly — acceptable per the Risks note.
        //
        // agent-DELETED → fall back per R8 (no restart; the running session finishes
        // on its current model). agent-CHANGED (different effective agent OR same
        // agent with a new runtimeConfig model) → hot-swap, same path as a
        // task.modelProvider change.
        if (
          this.activeSessions.has(task.id)
          && !task.paused
          && (this.activeSessions.get(task.id)!.lastEffectiveColumnAgentId ?? null) !== null
          && this.graphSeamGoverningNodeId.has(task.id)
          && this.graphColumnAgentResolver.has(task.id)
        ) {
          const activeEntry = this.activeSessions.get(task.id)!;
          const governingNodeId = this.graphSeamGoverningNodeId.get(task.id)!;
          const resolveBinding = this.graphColumnAgentResolver.get(task.id)!;
          const binding = resolveBinding(governingNodeId);
          const effective = binding
            ? resolveEffectiveAgent({ binding, ...extractOwnSettings(task) })
            : undefined;
          if (!effective || effective.source !== "column-agent") {
            // Binding RELEASED (PR #1432 review): a workflow edit removed the
            // binding, or `defer` now resolves to the task's own settings. Hand the
            // session back to normal resolution: hot-swap to the assigned/task
            // model (the same resolution the legacy block below owns), clear the
            // column-agent tracking, and release the reverse heartbeat guard so
            // isAgentEffectivelyExecuting() stops blocking the OLD agent.
            executorLog.log(`${task.id}: column-agent binding released — reverting session to own-settings resolution`);
            activeEntry.lastEffectiveColumnAgentId = null;
            this.effectiveColumnAgentByTask.delete(task.id);
            // Fire-and-forget audit (matches the deletion-fallback posture above).
            this.store.logEntry(
              task.id,
              "Column-agent binding released — session reverts to its own model/agent resolution",
              undefined,
              this.getRunContextFor(task.id),
            ).catch((err: unknown) => executorLog.warn(`${task.id}: failed to log column-agent release: ${err instanceof Error ? err.message : String(err)}`));
            const settings = await this.store.getSettings();
            const assignedRuntimeConfig = await this.getAssignedAgentRuntimeConfig(task.assignedAgentId);
            const { provider: ownProvider, modelId: ownModelId } = resolveExecutorSessionModel(
              task.modelProvider,
              task.modelId,
              settings,
              assignedRuntimeConfig,
            );
            const providerChanged = ownProvider !== activeEntry.lastResolvedModelProvider;
            const modelIdChanged = ownModelId !== activeEntry.lastResolvedModelId;
            if ((providerChanged || modelIdChanged) && ownProvider && ownModelId) {
              activeEntry.lastResolvedModelProvider = ownProvider;
              activeEntry.lastResolvedModelId = ownModelId;
              try {
                const model = (await this.getModelRegistry()).find(ownProvider, ownModelId);
                if (model) {
                  await activeEntry.session.setModel(model);
                  executorLog.log(`${task.id}: binding released — model reverted to ${ownProvider}/${ownModelId}`);
                }
              } catch (err: unknown) {
                executorLog.error(`${task.id}: failed to revert model after binding release: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          } else {
            {
              // Fetch the (possibly changed) effective column agent, best-effort.
              const newAgent = await this.options.agentStore?.getAgent(effective.agentId).catch(() => null) ?? null;
              if (!newAgent) {
                // agent-DELETED (R8): fall back, NO restart. The running session
                // keeps its current model; the NEXT resolution falls back. Update the
                // tracked id so we stop probing for the missing agent every tick.
                if (activeEntry.lastEffectiveColumnAgentId !== null) {
                  executorLog.log(`${task.id}: column agent '${effective.agentId}' deleted mid-session — falling back, no restart (R8)`);
                  // Fire-and-forget audit (matches the rework-log posture at ~3582):
                  // a logEntry failure must not abort this task:updated tick and skip
                  // the model-change detection below.
                  this.store.logEntry(
                    task.id,
                    `Column agent '${effective.agentId}' deleted mid-session — falling back to current model, no restart (R8)`,
                    undefined,
                    this.getRunContextFor(task.id),
                  ).catch((err: unknown) => executorLog.warn(`${task.id}: failed to log column-agent deletion fallback: ${err instanceof Error ? err.message : String(err)}`));
                  activeEntry.lastEffectiveColumnAgentId = null;
                  // Release the reverse heartbeat guard for the deleted agent
                  // (PR #1432 review): isAgentEffectivelyExecuting() must not keep
                  // blocking an agent that no longer governs this session.
                  this.effectiveColumnAgentByTask.delete(task.id);
                }
              } else {
                const settings = await this.store.getSettings();
                /*
                FNXC:ColumnAgentModel 2026-06-27-10:05:
                Override column agents own the active session model even when a mid-flight task edit adds its own modelProvider/modelId; ignore task-level model fields during column-agent re-resolution so the watcher cannot clobber the governing agent's runtime model.
                */
                const overrideColumnGoverns = binding!.mode === "override";
                const { provider: newProvider, modelId: newModelId } = resolveExecutorSessionModel(
                  overrideColumnGoverns ? undefined : task.modelProvider,
                  overrideColumnGoverns ? undefined : task.modelId,
                  settings,
                  (newAgent.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
                );
                const agentChanged = (activeEntry.lastEffectiveColumnAgentId ?? null) !== newAgent.id;
                const providerChanged = newProvider !== activeEntry.lastResolvedModelProvider;
                const modelIdChanged = newModelId !== activeEntry.lastResolvedModelId;
                if (agentChanged || providerChanged || modelIdChanged) {
                  activeEntry.lastEffectiveColumnAgentId = newAgent.id;
                  // Re-key the reverse heartbeat guard to the NEW agent (PR #1432
                  // review): the old agent stops being blocked, the new one starts.
                  this.effectiveColumnAgentByTask.set(task.id, newAgent.id);
                  activeEntry.lastResolvedModelProvider = newProvider;
                  activeEntry.lastResolvedModelId = newModelId;
                  if (newProvider && newModelId) {
                    try {
                      const model = (await this.getModelRegistry()).find(newProvider, newModelId);
                      if (model) {
                        await activeEntry.session.setModel(model);
                        executorLog.log(`${task.id}: column-agent hot-swap → agent '${newAgent.id}' model ${newProvider}/${newModelId}`);
                        await this.store.logEntry(task.id, `Column agent changed — model now ${newProvider}/${newModelId} (agent ${newAgent.id})`, undefined, this.getRunContextFor(task.id));
                      } else {
                        executorLog.log(`${task.id}: column-agent model ${newProvider}/${newModelId} not found in registry for hot-swap`);
                      }
                    } catch (err: unknown) {
                      const errorMessage = err instanceof Error ? err.message : String(err);
                      executorLog.error(`${task.id}: failed to column-agent hot-swap: ${errorMessage}`);
                      // Fire-and-forget audit (see ~3582): a logEntry failure here must
                      // not abort the tick and skip later model-change detection.
                      this.store.logEntry(task.id, `Column-agent change failed: ${errorMessage}`, undefined, this.getRunContextFor(task.id))
                        .catch((logErr: unknown) => executorLog.warn(`${task.id}: failed to log column-agent change failure: ${logErr instanceof Error ? logErr.message : String(logErr)}`));
                    }
                  }
                }
              }
            }
          }
        }

        // Handle executor model hot-swap on active single-session executions
        if (this.activeSessions.has(task.id) && !task.paused) {
          const activeEntry = this.activeSessions.get(task.id)!;
          // R3 guard: when an OVERRIDE column agent governs this running session, the
          // column-agent watcher block above OWNS the model (override supersedes the
          // task's own model/assigned-agent settings). The legacy task-model hot-swap
          // would otherwise resolve a model from task.assignedAgentId's runtimeConfig
          // and clobber the column agent's model on a mid-flight task edit. Skip it
          // entirely when override governs; defer-resolved-to-own-settings (or no
          // binding) keeps the legacy behavior identical.
          let overrideColumnGoverns = false;
          if ((activeEntry.lastEffectiveColumnAgentId ?? null) !== null) {
            const governingNodeId = this.graphSeamGoverningNodeId.get(task.id);
            const resolveBinding = this.graphColumnAgentResolver.get(task.id);
            if (governingNodeId && resolveBinding) {
              const binding = resolveBinding(governingNodeId);
              if (binding?.mode === "override") overrideColumnGoverns = true;
            }
          }

          const taskModelProviderChanged = task.modelProvider !== activeEntry.lastTaskModelProvider;
          const taskModelIdChanged = task.modelId !== activeEntry.lastTaskModelId;
          const assignedAgentChanged = (task.assignedAgentId ?? null) !== (activeEntry.lastAssignedAgentId ?? null);

          if (!overrideColumnGoverns && (taskModelProviderChanged || taskModelIdChanged || assignedAgentChanged)) {
            activeEntry.lastTaskModelProvider = task.modelProvider;
            activeEntry.lastTaskModelId = task.modelId;
            activeEntry.lastAssignedAgentId = task.assignedAgentId ?? null;

            const settings = await this.store.getSettings();
            const assignedRuntimeConfig = await this.getAssignedAgentRuntimeConfig(task.assignedAgentId);
            const { provider: newProvider, modelId: newModelId } = resolveExecutorSessionModel(
              task.modelProvider,
              task.modelId,
              settings,
              assignedRuntimeConfig,
            );

            const providerChanged = newProvider !== activeEntry.lastResolvedModelProvider;
            const modelIdChanged = newModelId !== activeEntry.lastResolvedModelId;
            if (!providerChanged && !modelIdChanged) {
              return;
            }
            activeEntry.lastResolvedModelProvider = newProvider;
            activeEntry.lastResolvedModelId = newModelId;

            if (newProvider && newModelId) {
              try {
                const model = (await this.getModelRegistry()).find(newProvider, newModelId);
                if (model) {
                  await activeEntry.session.setModel(model);
                  executorLog.log(`${task.id}: executor model hot-swapped to ${newProvider}/${newModelId}`);
                  await this.store.logEntry(task.id, `Model changed to ${newProvider}/${newModelId}`, undefined, this.getRunContextFor(task.id));
                } else {
                  executorLog.log(`${task.id}: model ${newProvider}/${newModelId} not found in registry for hot-swap`);
                }
              } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                executorLog.error(`${task.id}: failed to hot-swap model: ${errorMessage}`);
                await this.store.logEntry(task.id, `Model change failed: ${errorMessage}`, undefined, this.getRunContextFor(task.id));
              }
            }
          }
        }

        // Handle steering comments - inject new ones into whichever execution
        // surface currently owns the task: legacy single-session, step-session
        // executor (including graph-pinned/workflow stepwise runs), or an
        // individual workflow step AgentSession.
        if (task.steeringComments) {
          const injectionTargets: Array<{
            kind: "legacy" | "step-session" | "workflow-step";
            seenSteeringIds: Set<string>;
            inject: (message: string, comment: import("@fusion/core").SteeringComment) => Promise<"injected" | "queued">;
            legacySession?: AgentSession;
            legacyState?: ActiveExecutorSessionState;
          }> = [];

          const activeSession = this.activeSessions.get(task.id);
          if (activeSession) {
            injectionTargets.push({
              kind: "legacy",
              seenSteeringIds: activeSession.seenSteeringIds,
              inject: async (message) => {
                await activeSession.session.steer(message);
                return "injected";
              },
              legacySession: activeSession.session,
              legacyState: activeSession,
            });
          }

          const stepExecutor = this.activeStepExecutors.get(task.id);
          if (stepExecutor) {
            /*
            FNXC:TaskDetailChat 2026-06-17-13:24:
            Task-detail chat comments must reach the running LLM thread immediately across legacy, step-session, and workflow-step surfaces. Step-session runs can be between per-step AgentSessions when a comment arrives, so keep the executor's task snapshot current and treat zero-session fan-out as a next-prompt fallback while preserving seenSteeringIds exactly-once delivery.
            */
            stepExecutor.updateSteeringComments?.(task.steeringComments);
            const seenSteeringIds = this.activeStepExecutorSeenSteeringIds.get(task.id) ?? createSeenSteeringIds(task);
            this.activeStepExecutorSeenSteeringIds.set(task.id, seenSteeringIds);
            injectionTargets.push({
              kind: "step-session",
              seenSteeringIds,
              inject: async (message, comment) => {
                const steeredSessionCount = await stepExecutor.steerActiveSessions(message);
                if (steeredSessionCount > 0) {
                  stepExecutor.markSteeringCommentsDelivered?.([comment.id]);
                  return "injected";
                }
                return "queued";
              },
            });
          }

          const workflowSession = this.activeWorkflowStepSessions.get(task.id);
          if (workflowSession) {
            const seenSteeringIds = this.activeWorkflowStepSessionSeenSteeringIds.get(task.id) ?? createSeenSteeringIds(task);
            this.activeWorkflowStepSessionSeenSteeringIds.set(task.id, seenSteeringIds);
            injectionTargets.push({
              kind: "workflow-step",
              seenSteeringIds,
              inject: async (message) => {
                await workflowSession.steer(message);
                return "injected";
              },
            });
          }

          const loggedCommentIds = new Set<string>();
          let legacyReviewHandoff: {
            comments: import("@fusion/core").SteeringComment[];
            session: AgentSession;
            state: ActiveExecutorSessionState;
          } | undefined;

          for (const target of injectionTargets) {
            // Find new steering comments that haven't been seen by this running surface yet.
            const newComments = task.steeringComments.filter(c => !target.seenSteeringIds.has(c.id));
            if (newComments.length === 0) continue;

            for (const comment of newComments) {
              const summary = comment.text.length > 80
                ? comment.text.slice(0, 80) + "..."
                : comment.text;

              // Mark as seen BEFORE attempting injection to prevent retry loops on failure.
              target.seenSteeringIds.add(comment.id);

              const commentMessage = formatCommentForInjection(comment);
              try {
                executorLog.log(`Injecting comment into ${task.id} (${target.kind}): ${summary}`);
                const delivery = await target.inject(commentMessage, comment);
                if (delivery === "queued") {
                  executorLog.log(`Queued comment for next ${target.kind} prompt in ${task.id}`);
                } else {
                  executorLog.log(`Successfully injected comment into ${task.id} (${target.kind})`);
                }

                // Log to the task once per comment/tick even if multiple active surfaces exist.
                if (!loggedCommentIds.has(comment.id)) {
                  await this.store.logEntry(
                    task.id,
                    `Comment received mid-execution: ${summary}`,
                    `by ${comment.author}`
                  );
                  loggedCommentIds.add(comment.id);
                }
              } catch (err) {
                executorLog.error(`Failed to inject comment for ${task.id} (${target.kind}):`, err);
                // Comment is already marked as seen - we won't retry to avoid spamming
                // the agent with failed injections. The error is logged for debugging.
              }
            }

            if (target.kind === "legacy" && target.legacySession && target.legacyState) {
              legacyReviewHandoff = {
                comments: newComments,
                session: target.legacySession,
                state: target.legacyState,
              };
            }
          }

          // After injecting comments, check for review handoff intent on the legacy
          // session path. Step-session/workflow-step runs do not have the legacy
          // review handoff state required by executeReviewHandoff.
          if (legacyReviewHandoff) {
            // Only detect handoff in agent-authored comments when policy is enabled.
            // Merge per-task effective workflow settings (U3, KTD-3) so
            // reviewHandoffPolicy resolves from the workflow. Behavior-inert by default.
            const settings = await mergeEffectiveSettings(this.store, task, await this.store.getSettings());
            if (settings.reviewHandoffPolicy === "comment-triggered") {
              const agentComments = legacyReviewHandoff.comments.filter(c => c.author !== "user");
              for (const comment of agentComments) {
                if (detectReviewHandoffIntent(comment.text)) {
                  executorLog.log(`Review handoff detected in ${task.id}: ${comment.text.slice(0, 50)}...`);
                  await this.executeReviewHandoff(task, legacyReviewHandoff.session, legacyReviewHandoff.state);
                  return; // Exit early - handoff handles session disposal
                }
              }
            }
          }
        }
      } catch (err) {
        executorLog.error("Uncaught error in task:updated listener:", err);
      }
    });

    // When globalPause transitions from false → true, terminate all active agent sessions.
    store.on("settings:updated", ({ settings, previous }) => {
      if (settings.globalPause && !previous.globalPause) {
        for (const [taskId, controllers] of this.activeConfiguredCommandControllers) {
          executorLog.log(`Global pause — aborting configured command(s) for ${taskId}`);
          this.markPausedAborted(taskId, "global-pause", "global-pause:configured-command");
          this.options.stuckTaskDetector?.untrackTask(taskId);
          for (const controller of controllers) {
            controller.abort();
          }
          this.activeConfiguredCommandControllers.delete(taskId);
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
        // Dispose every reviewer subagent across every task. The per-task loops
        // below handle main + step sessions; reviewers live in their own map
        // and would otherwise outlive the global pause.
        for (const taskId of [...this.activeSubagentSessions.keys()]) {
          this.disposeSubagentsForTask(taskId, "global pause");
        }
        for (const [taskId, { session }] of this.activeSessions) {
          executorLog.log(`Global pause — terminating agent session for ${taskId}`);
          this.markPausedAborted(taskId, "global-pause", "global-pause:agent-session");
          this.options.stuckTaskDetector?.untrackTask(taskId);
          // abort() interrupts any in-flight LLM stream / tool call;
          // dispose() then releases session resources.
          const sessionWithAbort = session as unknown as { abort?: () => Promise<void> };
          if (typeof sessionWithAbort.abort === "function") {
            void sessionWithAbort.abort().catch((err) => {
              executorLog.warn(`Failed to abort agent session for ${taskId}: ${err}`);
            });
          }
          session.dispose();
          // Clean up all in-memory state so nothing leaks when tasks are later unpaused
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
        for (const [taskId, stepExecutor] of this.activeStepExecutors) {
          executorLog.log(`Global pause — terminating step sessions for ${taskId}`);
          this.markPausedAborted(taskId, "global-pause", "global-pause:step-session");
          this.options.stuckTaskDetector?.untrackTask(taskId);
          stepExecutor.terminateAllSessions().catch(err =>
            executorLog.warn(`Failed to terminate step sessions for global pause ${taskId}: ${err}`)
          );
          // Clean up all in-memory state so nothing leaks when tasks are later unpaused
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
        for (const [taskId, workflowSession] of this.activeWorkflowStepSessions) {
          executorLog.log(`Global pause — terminating workflow step session for ${taskId}`);
          this.markPausedAborted(taskId, "global-pause", "global-pause:workflow-step-session");
          this.options.stuckTaskDetector?.untrackTask(taskId);
          const sessionWithAbort = workflowSession as AgentSession & { abort?: () => Promise<void> };
          if (typeof sessionWithAbort.abort === "function") {
            void sessionWithAbort.abort().catch((err) => {
              executorLog.warn(`Failed to abort workflow step session for ${taskId}: ${err}`);
            });
          }
          workflowSession.dispose();
          this.deleteActiveWorkflowStepSession(taskId);
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
        for (const [taskId, controller] of this.activeWorkflowGraphAbortControllers) {
          executorLog.log(`Global pause — aborting workflow graph runner for ${taskId}`);
          this.markPausedAborted(taskId, "global-pause", "global-pause:workflow-graph");
          this.options.stuckTaskDetector?.untrackTask(taskId);
          controller.abort();
          this.activeWorkflowGraphAbortControllers.delete(taskId);
          this.loopRecoveryState.delete(taskId);
          this.spawnedAgents.delete(taskId);
          this.stuckAborted.delete(taskId);
        }
      }
    });

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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
    const handle = this.completedTaskWatchdogs.get(taskId);
    if (!handle) return;
    clearTimeout(handle);
    this.completedTaskWatchdogs.delete(taskId);
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
    const handle = this.workflowRerunWatchdogs.get(taskId);
    if (!handle) return;
    clearTimeout(handle);
    this.workflowRerunWatchdogs.delete(taskId);
  }

  private scheduleCompletedTaskWatchdog(taskId: string, trigger: string): void {
    scheduleCompletedTaskWatchdogImpl(
      {
        store: this.store,
        completedTaskWatchdogs: this.completedTaskWatchdogs,
        recoveringCompleted: this.recoveringCompleted,
        executing: this.executing,
        activeSessions: this.activeSessions,
        activeStepExecutors: this.activeStepExecutors,
        activeWorkflowStepSessions: this.activeWorkflowStepSessions,
        resumingUnpaused: this.resumingUnpaused,
        completedTaskWatchdogMs: COMPLETED_TASK_WATCHDOG_MS,
        clearCompletedTaskWatchdog: (id: string) => this.clearCompletedTaskWatchdog(id),
        getExecutionPauseLabel: () => this.getExecutionPauseLabel(),
        resolveResumeLanes: (id: string) => this.resolveResumeLanes(id),
        recoverCompletedTask: (task: Task) => this.recoverCompletedTask(task),
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
    const live = await this.store.getTask(taskId).catch(() => null);
    if (!live) return;
    const cleared = clearTerminalWorkflowStepFailures(live.workflowStepResults);
    if (cleared !== live.workflowStepResults) {
      await this.store.updateTask(taskId, { workflowStepResults: cleared }, this.getRunContextFor(taskId));
    }
  }

  private async performWorkflowRerunBounce(
    taskId: string,
    worktreePath: string,
    preserveResumeState: boolean = true,
  ): Promise<"bounced" | "skipped-pending" | "deferred-paused"> {
    return performWorkflowRerunBounceImpl(
      {
        store: this.store,
        workflowRerunPending: this.workflowRerunPending,
        getExecutionPauseLabel: () => this.getExecutionPauseLabel(),
        resolveResumeLanes: (id: string) => this.resolveResumeLanes(id),
        clearTerminalStepFailuresForRetry: (id: string) => this.clearTerminalStepFailuresForRetry(id),
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
        store: this.store,
        workflowRerunWatchdogs: this.workflowRerunWatchdogs,
        workflowRerunWatchdogMs: WORKFLOW_RERUN_WATCHDOG_MS,
        clearWorkflowRerunWatchdog: (id: string) => this.clearWorkflowRerunWatchdog(id),
        performWorkflowRerunBounce: (id, wp, preserve) => this.performWorkflowRerunBounce(id, wp, preserve),
        getExecutionPauseLabel: () => this.getExecutionPauseLabel(),
        resolveResumeLanes: (id: string) => this.resolveResumeLanes(id),
      },
      taskId,
      worktreePath,
      successMessage,
      preserveResumeState,
    );
  }

  private completionFinalizationDeps() {
    return {
      store: this.store,
      getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
      getTaskCompletionBlocker: (task: Task) => this.getTaskCompletionBlocker(task),
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
    return {
      store: this.store,
      getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
      resolveResumeLanes: (taskId: string) => this.resolveResumeLanes(taskId),
      persistTokenUsage: (taskId: string) => this.persistTokenUsage(taskId),
      clearCompletedTaskWatchdog: (taskId: string) => this.clearCompletedTaskWatchdog(taskId),
      signalTaskComplete: (task: Task) => this.signalTaskComplete(task),
      handoffTaskToReview: (task: Task, reason: string) => this.handoffTaskToReview(task, reason),
      markGraphExecuteSelfRequeued: (taskId: string) => this.markGraphExecuteSelfRequeued(taskId),
    };
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        persistTokenUsage: (id) => this.persistTokenUsage(id),
        handoffTaskToReview: (t, reason) => this.handoffTaskToReview(t, reason),
        activeSessions: this.activeSessions,
        deleteActiveSession: (id) => this.deleteActiveSession(id),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        executing: this.executing,
        activeSessions: this.activeSessions,
        activeStepExecutors: this.activeStepExecutors,
        activeWorkflowStepSessions: this.activeWorkflowStepSessions,
        resumingUnpaused: this.resumingUnpaused,
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        workflowRerunWatchdogs: this.workflowRerunWatchdogs,
        workflowRerunPending: this.workflowRerunPending,
        recoveringCompleted: this.recoveringCompleted,
        captureModifiedFiles: (wt, base, id, audit, source) => this.captureModifiedFiles(wt, base ?? undefined, id, audit, source),
        shouldDeferCompletionForGlobalPause: (id, ctx) => this.shouldDeferCompletionForGlobalPause(id, ctx),
        executeWorkflowGraph: (t) => this.executeWorkflowGraph(t),
        clearCompletedTaskWatchdog: (id) => this.clearCompletedTaskWatchdog(id),
        persistTokenUsage: (id) => this.persistTokenUsage(id),
        handoffTaskToReview: (t, reason) => this.handoffTaskToReview(t, reason),
        signalTaskComplete: (t) => this.signalTaskComplete(t),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        recoverMissingRequiredArtifacts: (task, keys, source) =>
          this.recoverMissingRequiredArtifacts(task, keys, source),
        parkPlanReviewReplanCapExhausted: (id, cap, count, feedback) =>
          this.parkPlanReviewReplanCapExhausted(id, cap, count, feedback),
        clearPausedAborted: (id) => this.clearPausedAborted(id),
        workflowLifecycleMovesInFlight: this.workflowLifecycleMovesInFlight,
        sendTaskBackForFix: (...args) => this.sendTaskBackForFix(...args),
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
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
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
        resolveFailedPreMergeWorkflowStepBudget: (t, target) => this.resolveFailedPreMergeWorkflowStepBudget(t, target),
        sendTaskBackForFix: (...args) => this.sendTaskBackForFix(...args),
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
    const agent = await this.getAuthoritativeAssignedAgent(assignedAgentId);
    return (agent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined;
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
        store: this.store,
        executing: this.executing,
        activeSessions: this.activeSessions,
        activeStepExecutors: this.activeStepExecutors,
        activeWorkflowStepSessions: this.activeWorkflowStepSessions,
        listWipLaneTasks: () => this.listWipLaneTasks(),
        taskEffectiveAgentMatches: (task, id) => this.taskEffectiveAgentMatches(task, id),
        execute: (task) => this.execute(task),
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
      store: this.store,
      executing: this.executing,
      recoveringCompleted: this.recoveringCompleted,
      processWideGraphRouting: TaskExecutor.processWideGraphRouting,
      listWipLaneTasks: () => this.listWipLaneTasks(),
      clearResumeFailureState: (t) => this.clearResumeFailureState(t),
      recoverApprovedStepsOnResume: (id) => this.recoverApprovedStepsOnResume(id),
      recoverCompletedTask: (t) => this.recoverCompletedTask(t),
      execute: (t) => this.execute(t),
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
    /* eslint-disable @typescript-eslint/no-explicit-any -- thin facade forwards TaskExecutor state/methods into free-function deps bag */
    return executeWorkflowGraphImpl(
      {
        store: this.store,
        options: this.options as { prNodes?: unknown; [k: string]: unknown },
        activeWorkflowGraphAbortControllers: this.activeWorkflowGraphAbortControllers,
        graphColumnAgentResolver: this.graphColumnAgentResolver,
        graphExecuteSelfRequeued: this.graphExecuteSelfRequeued,
        graphRethinkNarrations: this.graphRethinkNarrations,
        graphRouting: this.graphRouting,
        graphSeamGoverningNodeId: this.graphSeamGoverningNodeId,
        graphSeamSkillName: this.graphSeamSkillName,
        graphSeamThinkingLevel: this.graphSeamThinkingLevel,
        graphStepActiveContext: this.graphStepActiveContext,
        graphStepRunOnce: this.graphStepRunOnce,
        graphStepSessionPinned: this.graphStepSessionPinned,
        graphToolFailureRunCursors: this.graphToolFailureRunCursors,
        graphUnattendedRuns: this.graphUnattendedRuns,
        outerConcurrencyClaims: this.outerConcurrencyClaims,
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        getRunContextFor: (id) => this.getRunContextFor(id),
        advanceNoMergeWorkflowToCompleteColumn: (...args: unknown[]) => (this as any).advanceNoMergeWorkflowToCompleteColumn(...args),
        applyGraphRethinkReset: (...args: unknown[]) => (this as any).applyGraphRethinkReset(...args),
        buildBranchPersistence: (...args: unknown[]) => (this as any).buildBranchPersistence(...args),
        buildCodeNodeRunner: (...args: unknown[]) => (this as any).buildCodeNodeRunner(...args),
        buildColumnBoundaryHooks: (...args: unknown[]) => (this as any).buildColumnBoundaryHooks(...args),
        buildForeachWorktreeDeps: (...args: unknown[]) => (this as any).buildForeachWorktreeDeps(...args),
        buildParseStepsDeps: (...args: unknown[]) => (this as any).buildParseStepsDeps(...args),
        buildStepInstancePersistence: (...args: unknown[]) => (this as any).buildStepInstancePersistence(...args),
        createAuthoritativeWorkflowPrimitives: (...args: unknown[]) => (this as any).createAuthoritativeWorkflowPrimitives(...args),
        createAuthoritativeWorkflowSeams: (...args: unknown[]) => (this as any).createAuthoritativeWorkflowSeams(...args),
        finalizeMergeConfirmedWorkflowGraphTask: (...args: unknown[]) => (this as any).finalizeMergeConfirmedWorkflowGraphTask(...args),
        handleGraphFailure: (...args: unknown[]) => (this as any).handleGraphFailure(...args),
        prepareGraphNodeExecution: (...args: unknown[]) => (this as any).prepareGraphNodeExecution(...args),
        readTaskArtifact: (...args: unknown[]) => (this as any).readTaskArtifact(...args),
        recoverMissingRequiredArtifacts: (...args: unknown[]) => (this as any).recoverMissingRequiredArtifacts(...args),
        requestPreMergeOptionalStepFix: (...args: unknown[]) => (this as any).requestPreMergeOptionalStepFix(...args),
        runGraphCustomNode: (...args: unknown[]) => (this as any).runGraphCustomNode(...args),
        terminateAllChildren: (...args: unknown[]) => (this as any).terminateAllChildren(...args),
      },
      task,
      opts,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  private buildBranchPersistence(): WorkflowBranchPersistence | undefined {
    // FNXC:PostgresOnlyDataAccess 2026-07-16-12:40: the store methods are now
    // async (PostgreSQL routing); the persistence interfaces already accept
    // Promise-returning impls and await them.
    const store = this.store as unknown as {
      saveWorkflowRunBranch?: (state: WorkflowBranchRunState) => void | Promise<void>;
      loadWorkflowRunBranches?: (taskId: string, runId: string) => WorkflowBranchRunState[] | Promise<WorkflowBranchRunState[]>;
      clearWorkflowRunBranches?: (taskId: string, keepRunId: string) => void | Promise<void>;
    };
    if (typeof store.saveWorkflowRunBranch !== "function") return undefined;
    return {
      saveBranchState: (state) => store.saveWorkflowRunBranch?.(state),
      loadBranchStates: async (taskId, runId) => (await store.loadWorkflowRunBranches?.(taskId, runId)) ?? [],
      clearStaleBranchStates: (taskId, keepRunId) => store.clearWorkflowRunBranches?.(taskId, keepRunId),
    };
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
    return createExecutorColumnBoundaryHooks({
      store: this.store,
      task,
      workflowRunId,
      markMoveInFlight: (taskId) => this.workflowLifecycleMovesInFlight.add(taskId),
      clearMoveInFlight: (taskId) => this.workflowLifecycleMovesInFlight.delete(taskId),
      onWarn: (message, detail) => {
        executorLog.debug(`[workflow-column-boundary] ${task.id}: ${message} ${JSON.stringify(detail)}`);
      },
    });
  }

  /**
   * Resolve which artifact/parser governs a graph-owned task's step list from its
   * workflow's `parse-steps` declaration (KTD-12). Returns undefined for legacy
   * tasks (no parse-steps node) so reconcile/resume keep their unchanged behavior.
   * Used by reconcile read-through to know which artifact backs the step source.
   */
  private resolveTaskStepSource(ir: WorkflowIr | undefined): { artifact: string; parser: string } | undefined {
    if (!ir) return undefined;
    for (const node of ir.nodes) {
      if (node.kind !== "parse-steps") continue;
      const cfg = (node.config ?? {}) as { artifact?: unknown; parser?: unknown };
      const parser = typeof cfg.parser === "string" ? cfg.parser : undefined;
      if (!parser) continue;
      const artifact = typeof cfg.artifact === "string" && cfg.artifact.trim() !== "" ? cfg.artifact : "PROMPT.md";
      return { artifact, parser };
    }
    return undefined;
  }

  /**
   * Resolve the custom field definitions declared by a task's selected workflow
   * (KTD-13) so the executor prompt can surface the schema and current values to
   * the agent. Pure read; degrades to undefined on any resolution failure (no
   * selection, missing/corrupt definition, older store) so prompt-building never
   * throws and legacy tasks see no custom-fields section.
   */
  private async resolveTaskCustomFieldDefs(taskId: string): Promise<WorkflowFieldDefinition[] | undefined> {
    try {
      const ir = await resolveWorkflowIrForTask(this.store, taskId);
      const fields = ir.version === "v2" ? ir.fields : undefined;
      return fields && fields.length > 0 ? fields : undefined;
    } catch {
      return undefined;
    }
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
    // Declared artifacts ride the task-documents layer.
    let documentReadError: unknown;
    try {
      const doc = await this.store.getTaskDocument(taskId, key);
      if (doc) return doc.content;
    } catch (error) {
      documentReadError = error;
    }
    if (key === "PROMPT.md") {
      try {
        const detail = await this.store.getTask(taskId);
        if (typeof detail.prompt === "string") return detail.prompt;
        return undefined;
      } catch (error) {
        throw new Error(
          `Unable to read required artifact ${key} from task documents or task storage: ${error instanceof Error ? error.message : String(error)}`,
          { cause: documentReadError ?? error },
        );
      }
    }
    if (documentReadError) throw documentReadError;
    return undefined;
  }

  private buildParseStepsDeps(runId?: string): ParseStepsHandlerDeps {
    return {
      readArtifact: (task, key): Promise<string | undefined> => this.readTaskArtifact(task.id, key),
      writeSteps: async (task, steps: TaskStep[]): Promise<void> => {
        await this.store.updateTask(task.id, { steps });
      },
      hasExpandedForeach: async (task): Promise<boolean> => {
        const store = this.store as unknown as {
          loadWorkflowRunStepInstancesAsync?: (taskId: string, runId: string) => Promise<WorkflowStepInstanceState[]>;
          loadWorkflowRunStepInstances?: (taskId: string, runId: string) => WorkflowStepInstanceState[];
        };
        if (typeof store.loadWorkflowRunStepInstancesAsync !== "function" && typeof store.loadWorkflowRunStepInstances !== "function") return false;
        try {
          // Any persisted instance row for THIS run means a foreach has expanded —
          // re-parsing would desynchronize the pinned instance set (KTD-3). Probe
          // under the REAL run id (threaded from executeWorkflowGraph) so the
          // pin protection actually fires; fall back to the legacy literal only when
          // the run id was not threaded (older store / no definition).
          const rows = await store.loadWorkflowRunStepInstancesAsync?.(task.id, runId ?? `${task.id}:run`)
            ?? store.loadWorkflowRunStepInstances?.(task.id, runId ?? `${task.id}:run`)
            ?? [];
          return rows.length > 0;
        } catch {
          return false;
        }
      },
      audit: (reason, detail) => {
        // The detail string carries the task id (handler convention); emit on the
        // engine log so the routable failure is auditable without a taskId arg.
        executorLog.warn(`[parse-steps] ${reason}: ${detail}`);
      },
    };
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
        store: this.store,
        rootDir: this.rootDir,
        createWorktree: (branch, path, taskId, startPoint) => this.createWorktree(branch, path, taskId, startPoint),
        semaphoreAvailableCount: () => this.options.semaphore?.availableCount ?? 1,
      },
      task,
      runId,
    );
  }

  private async applyGraphRethinkReset(taskId: string, active: ForeachActiveContext): Promise<void> {
    return applyGraphRethinkResetImpl(
      {
        rootDir: this.rootDir,
        store: this.store,
        graphStepRunOnce: this.graphStepRunOnce,
        graphRethinkNarrations: this.graphRethinkNarrations,
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
    let captured: { taskDone: boolean; modifiedFiles: string[]; exit?: ImplementationExit } = { taskDone: false, modifiedFiles: [] };
    const graphCompletion: GraphCompletionCallback = (info) => {
      captured = { ...captured, taskDone: true, modifiedFiles: info.modifiedFiles };
    };
    /* Recorded independently of `graphCompletion`: the out-of-band exits never call it. */
    const reportExit: ImplementationExitReporter = (exit) => {
      captured = { ...captured, exit };
    };
    const executionTask = prepared
      ? {
          ...task,
          worktree: prepared.worktreePath || task.worktree,
          branch: prepared.branchName || task.branch,
        }
      : task;
    await this.runImplementation(executionTask, graphCompletion, reportExit);
    return captured;
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
        foreachActiveForTask: (id, inst) => this.foreachActiveForTask(id, inst),
        graphStepSessionPinned: this.graphStepSessionPinned,
        graphStepRunOnce: this.graphStepRunOnce,
        graphSeamGoverningNodeId: this.graphSeamGoverningNodeId,
        graphSeamThinkingLevel: this.graphSeamThinkingLevel,
        graphSeamSkillName: this.graphSeamSkillName,
        runImplementationPhase: (t) => this.runImplementationPhase(t),
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
    if (typeof instanceId === "string") {
      const byInstance = this.graphStepActiveContext.get(graphActiveContextKey(taskId, instanceId));
      if (byInstance) return byInstance;
    }
    // Fallback (single-instance / no instanceId threaded): return the sole slot
    // owned by this task if exactly one exists.
    const prefix = `${taskId}:`;
    let only: ForeachActiveContext | undefined;
    for (const [key, value] of this.graphStepActiveContext) {
      if (!key.startsWith(prefix)) continue;
      if (only) return undefined; // ambiguous: more than one instance active
      only = value;
    }
    return only;
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
    /* eslint-disable @typescript-eslint/no-explicit-any -- thin facade forwards TaskExecutor methods into the free-function deps bag */
    return createAuthoritativeWorkflowPrimitivesFromExecutorImpl(
      {
        store: this.store,
        rootDir: this.rootDir,
        graphSeamGoverningNodeId: this.graphSeamGoverningNodeId,
        graphStepActiveContext: this.graphStepActiveContext,
        pausedAborted: this.pausedAborted,
        mergeRequester: this.mergeRequester,
        getRunContextFor: (id) => this.getRunContextFor(id),
        buildParseStepsDeps: (...args: unknown[]) => (this as any).buildParseStepsDeps(...args),
        createAuthoritativeWorkflowSeams: (...args: unknown[]) => (this as any).createAuthoritativeWorkflowSeams(...args),
        ensureWorkflowMergeBoundaryTask: (...args: unknown[]) => (this as any).ensureWorkflowMergeBoundaryTask(...args),
        getWorkflowMergeImplementationProofFailure: (...args: unknown[]) => (this as any).getWorkflowMergeImplementationProofFailure(...args),
        handoffTaskToReview: (...args: unknown[]) => (this as any).handoffTaskToReview(...args),
        markPausedAborted: (...args: unknown[]) => (this as any).markPausedAborted(...args),
        persistTokenUsage: (...args: unknown[]) => (this as any).persistTokenUsage(...args),
        runImplementationPhase: (...args: unknown[]) => (this as any).runImplementationPhase(...args),
        runProjectedGraphTaskStep: (...args: unknown[]) => (this as any).runProjectedGraphTaskStep(...args),
      },
      settings,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  private async resolveMergeBoundaryColumn(taskId: string, nodeId: string): Promise<string> {
    try {
      const ir = await resolveWorkflowIrForTask(this.store, taskId);
      // Prefer the named node's column when it is itself a merge-class node
      // (merge-gate/merge-attempt/…). Otherwise fall back to the FIRST merge-class
      // node's column — the boundary's caller may pass a synthetic id
      // ("legacy-merge-seam") or a non-merge node, so keying on merge-class kinds
      // (not an arbitrary node's column) is what reliably lands the card in the
      // workflow's merge column: `in-review` for builtin:coding (KTD-7 parity),
      // `Merging` for the benchmark.
      const named = ir.nodes.find((n) => n.id === nodeId);
      if (named && MERGE_REGION_KINDS.has(named.kind) && named.column) return named.column;
      const mergeNode = ir.nodes.find((n) => MERGE_REGION_KINDS.has(n.kind) && n.column);
      if (mergeNode?.column) return mergeNode.column;
      return "in-review";
    } catch {
      return "in-review";
    }
  }

  private async ensureWorkflowMergeBoundaryTask(
    task: TaskDetail,
    metadata: { reason: string; nodeId: string; workflowId: string; runId: string },
  ): Promise<TaskDetail> {
    return ensureWorkflowMergeBoundaryTaskImpl(
      {
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
        resolveMergeBoundaryColumn: (taskId, nodeId) => this.resolveMergeBoundaryColumn(taskId, nodeId),
        evaluateWorkflowMergeBoundary: (live, runId) => this.evaluateWorkflowMergeBoundary(live, runId),
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
    const relevant = (task.workflowStepResults ?? []).filter((result) =>
      result.source === "node" && (result.phase ?? "pre-merge") === "pre-merge",
    );
    // FNXC:WorkflowMerge 2026-07-27-12:30: FN-8601 keeps required presence
    // independent from terminality: a failed node result proves execution occurred,
    // while allResultsTerminal separately rejects it at the merge boundary.
    const hasRelevantNodeResult = relevant.length > 0;
    const nonTerminalResult = relevant.find((result) => result.status !== "passed" && result.status !== "skipped");
    const allResultsTerminal = nonTerminalResult === undefined;
    let ir: WorkflowIr | undefined;
    try { ir = await resolveWorkflowIrForTask(this.store, task.id); } catch { /* preserve legacy behavior for unresolved IRs */ }
    if (!ir) return { resolved: false, hasRelevantNodeResult, allResultsTerminal, coverageComplete: true, hasForeachStepExecute: false, missingInstanceIds: [], nonTerminalResult, complete: false };

    let persistedInstances: Awaited<ReturnType<typeof this.loadMergeBoundaryInstances>> = [];
    try { persistedInstances = await this.loadMergeBoundaryInstances(task.id, runId); } catch { /* persistence is additive */ }
    const coverage = evaluateForeachMergeProof({ ir, steps: task.steps, workflowStepResults: task.workflowStepResults, persistedInstances });
    const complete = hasRelevantNodeResult && allResultsTerminal && coverage.missingInstanceIds.length === 0;
    return { resolved: true, hasRelevantNodeResult, allResultsTerminal, coverageComplete: coverage.missingInstanceIds.length === 0, hasForeachStepExecute: coverage.hasForeachStepExecute, missingInstanceIds: coverage.missingInstanceIds, nonTerminalResult, complete };
  }

  private async loadMergeBoundaryInstances(taskId: string, runId?: string): Promise<Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }>> {
    if (!runId) return [];
    const store = this.store as typeof this.store & {
      loadWorkflowRunStepInstancesAsync?: (id: string, idRun: string) => Promise<Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }>>;
      loadWorkflowRunStepInstances?: (id: string, idRun: string) => Array<{ foreachNodeId: string; stepIndex: number; pinnedStepCount: number }>;
    };
    try {
      return await store.loadWorkflowRunStepInstancesAsync?.(taskId, runId)
        ?? store.loadWorkflowRunStepInstances?.(taskId, runId)
        ?? [];
    } catch { return []; }
  }

  private async getWorkflowMergeImplementationProofFailure(task: TaskDetail): Promise<string | undefined> {
    /*
    FNXC:Lifecycle 2026-07-16-21:40:
    FN-8141 — the graph merge boundary is another AUTO-promotion path. If the task is
    skip-bypass tainted (steps skipped after a bulk-step-completion refusal with no
    accepted fn_task_done), treat it as missing implementation proof so the merge is
    blocked with `implementation-incomplete` rather than laundered through a no-op merge.
    Runs before the noCommitsExpected exemption so a tainted task cannot slip past it.
    */
    const taint = evaluateSkipBypassTaint(task);
    if (taint.blocked) return "implementation did not run: steps were skipped after a bulk-step-completion refusal without an accepted fn_task_done";
    if (task.noCommitsExpected === true) return undefined;
    let ir: WorkflowIr | undefined;
    try { ir = await resolveWorkflowIrForTask(this.store, task.id); } catch { ir = undefined; }
    if (!ir) return undefined;
    const usesParsedSteps = ir.nodes.some((node) => node.kind === "parse-steps");
    const usesExecuteSeam = ir.nodes.some((node) => node.kind === "prompt" && node.config?.seam === "execute");
    if (!usesParsedSteps && !usesExecuteSeam) return undefined;
    const steps = Array.isArray(task.steps) ? task.steps : [];
    const hasTerminalParsedSteps = steps.length > 0 && steps.every((step) => step.status === "done" || step.status === "skipped");
    const hasModifiedFiles = (task.modifiedFiles?.length ?? 0) > 0;
    const proof = await this.evaluateWorkflowMergeBoundary(task);
    const hasGraphNativeImplementationProof = proof.hasRelevantNodeResult && proof.allResultsTerminal && proof.coverageComplete;
    if (usesParsedSteps) {
      if (hasTerminalParsedSteps || hasGraphNativeImplementationProof) return undefined;
      return proof.hasForeachStepExecute && !proof.coverageComplete
        ? `implementation did not run: foreach step instances are incomplete (missing ${proof.missingInstanceIds.join(", ")})`
        : "implementation did not run: parsed coding steps are missing or incomplete";
    }
    if (usesExecuteSeam) return hasTerminalParsedSteps || hasModifiedFiles || hasGraphNativeImplementationProof ? undefined : "implementation did not run: execute seam has no completion proof";
    return undefined;
  }

  /*
  FNXC:WorkflowMerge 2026-07-27-12:00:
  FN-8601 gates checklist projection and foreach merge admission on required node-result
  presence, terminal status for every present result, and expanded-instance coverage.
  Non-foreach/no-seam coverage is vacuous and does not change legacy move behavior.
  */
  private shouldCompleteChecklistAtWorkflowMerge(task: TaskDetail, proof?: { complete: boolean }): boolean {
    if (!Array.isArray(task.steps) || task.steps.length === 0) return false;
    if (task.steps.every((step) => step.status === "done" || step.status === "skipped")) return false;
    if (proof) return proof.complete;
    const graphNodeResults = (task.workflowStepResults ?? []).filter((result) => result.source === "node" && (result.phase ?? "pre-merge") === "pre-merge");
    return graphNodeResults.length > 0 && graphNodeResults.every((result) => result.status === "passed" || result.status === "skipped");
  }

  public createAuthoritativeWorkflowSeams(_settings: Settings): WorkflowLegacySeams {
    /* eslint-disable @typescript-eslint/no-explicit-any -- thin facade forwards TaskExecutor methods into free-function deps bag */
    return createAuthoritativeWorkflowSeamsImpl(
      {
        store: this.store,
        rootDir: this.rootDir,
        options: this.options as { mergeRequester?: unknown; pluginRunner?: unknown; [k: string]: unknown },
        workspaceConfig: this.workspaceConfig,
        graphSeamGoverningNodeId: this.graphSeamGoverningNodeId,
        graphSeamThinkingLevel: this.graphSeamThinkingLevel,
        graphStepActiveContext: this.graphStepActiveContext,
        graphRethinkNarrations: this.graphRethinkNarrations,
        pausedAborted: this.pausedAborted,
        mergeRequester: this.mergeRequester,
        getRunContextFor: (id) => this.getRunContextFor(id),
        persistTokenUsage: (...args: unknown[]) => (this as any).persistTokenUsage(...args),
        runImplementationPhase: (...args: unknown[]) => (this as any).runImplementationPhase(...args),
        handoffTaskToReview: (...args: unknown[]) => (this as any).handoffTaskToReview(...args),
        ensureWorkflowMergeBoundaryTask: (...args: unknown[]) => (this as any).ensureWorkflowMergeBoundaryTask(...args),
        getWorkflowMergeImplementationProofFailure: (...args: unknown[]) => (this as any).getWorkflowMergeImplementationProofFailure(...args),
        runProjectedGraphTaskStep: (...args: unknown[]) => (this as any).runProjectedGraphTaskStep(...args),
        updateStepGraph: (...args: unknown[]) => (this as any).updateStepGraph(...args),
        reviewWorkspacePerRepo: (...args: unknown[]) => (this as any).reviewWorkspacePerRepo(...args),
        registerSubagentSession: (...args: unknown[]) => (this as any).registerSubagentSession(...args),
        unregisterSubagentSession: (...args: unknown[]) => (this as any).unregisterSubagentSession(...args),
      },
      _settings,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  private async updateStepGraph(
    taskId: string,
    stepIndex: number,
    status: import("@fusion/core").StepStatus,
  ): Promise<void> {
    const store = this.store as unknown as {
      updateStep: (
        id: string,
        idx: number,
        status: import("@fusion/core").StepStatus,
        opts?: { source?: "graph" },
      ) => Promise<unknown>;
    };
    await store.updateStep(taskId, stepIndex, status, { source: "graph" });
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
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
      },
      node,
      live,
    );
  }

  private async pauseForCliApproval(node: WorkflowIrNode, live: TaskDetail, command: string): Promise<WorkflowNodeResult> {
    return pauseForCliApprovalImpl(
      {
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        registerConfiguredCommandController: (id, c) => this.registerConfiguredCommandController(id, c),
        unregisterConfiguredCommandController: (id, c) => this.unregisterConfiguredCommandController(id, c),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
    if (!agentId) return false;
    for (const effectiveId of this.effectiveColumnAgentByTask.values()) {
      if (effectiveId === agentId) return true;
    }
    return false;
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
    const runtimeEnvContribution = await this.options.pluginRunner?.collectExecutorRuntimeEnv({
      taskId,
      worktreePath,
      rootDir: this.rootDir,
      branch,
    });
    const pathPrepend = runtimeEnvContribution?.pathPrepend ?? [];
    const injectedEnv = runtimeEnvContribution?.env ?? {};
    return {
      env: {
        ...process.env,
        ...injectedEnv,
        PATH: [...pathPrepend, process.env.PATH ?? ""].filter(Boolean).join(delimiter),
      },
      injectedKeyCount: Object.keys(injectedEnv).length,
      pathEntryCount: pathPrepend.length,
    };
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
        getRunContextFor: (id) => this.getRunContextFor(id),
        pool: this.options.pool,
        secretsStore: this.options.secretsStore,
        createWorktree: (branch, path, taskId, startPoint, allowSibling) =>
          this.createWorktree(branch, path, taskId, startPoint, allowSibling),
        runConfiguredCommand: (command, cwd, timeoutMs, extraEnv, auditor, signal) =>
          runConfiguredCommand(command, cwd, timeoutMs, extraEnv, auditor, signal),
        addActiveWorktree: (id, path) => this.addActiveWorktree(id, path),
        onStart: this.options.onStart,
        registerConfiguredCommandController: (id, c) => this.registerConfiguredCommandController(id, c),
        unregisterConfiguredCommandController: (id, c) => this.unregisterConfiguredCommandController(id, c),
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
  /*
  FNXC:PlanningEvacuation 2026-07-25-23:00 (pre-execution worktree release):
  Planning now acquires a worktree, so a card that never reaches execution — withdrawn to Ideas,
  archived from a planner lane, or parked pre-execution — would otherwise hold one forever. Release
  it. Safety conditions, all required:
   - the task never executed (`firstExecutionAt`/`executionStartedAt` unset): execution evidence means
     the worktree may hold real work, and only the normal merge/archive lifecycle may remove it;
   - no live session registered on the path (the same isPathActive guard the other sweeps use);
   - the branch carries no commits beyond its base — planning writes its spec to the task store, not
     the worktree, so a clean branch means there is genuinely nothing to lose.
  Metadata (`worktree`/`branch`) is cleared with it, so a later promotion re-acquires cleanly.
  Fail-soft throughout: a cleanup problem must never block the lifecycle move that triggered it.
  */
  public async releasePreExecutionWorktree(taskId: string, reason: string): Promise<boolean> {
    try {
      const live = await this.store.getTask(taskId);
      if (!live?.worktree) return false;
      if (live.firstExecutionAt || live.executionStartedAt) return false;
      if (activeSessionRegistry.isPathActive(live.worktree) || activeSessionRegistry.isPathActive(resolvePath(live.worktree))) return false;
      if (this.hasLiveTaskSessionSurface(taskId) || executingTaskLock.has(taskId)) return false;

      if (existsSync(live.worktree)) {
        if (await preExecutionWorktreeHasWork(live.worktree)) {
          executorLog.log(`${taskId}: keeping pre-execution worktree ${live.worktree} — it carries commits or uncommitted changes`);
          return false;
        }
        const settings = await this.store.getSettings();
        await removeWorktree({
          rootDir: this.rootDir,
          worktreePath: live.worktree,
          settings,
          taskId,
          reason: RemovalReason.SelfHealingReclaim,
        });
      }
      this.activeWorktrees.get(taskId)?.delete(live.worktree);
      await this.store.updateTask(taskId, { worktree: null, branch: null, baseCommitSha: null, sessionFile: null }, this.getRunContextFor(taskId));
      await this.store.logEntry(taskId, `Released the pre-execution worktree (${reason}) — it will be re-acquired when planning or execution resumes`, undefined, this.getRunContextFor(taskId)).catch(() => undefined);
      executorLog.log(`${taskId}: released pre-execution worktree ${live.worktree} (${reason})`);
      return true;
    } catch (error) {
      executorLog.warn(`${taskId}: could not release the pre-execution worktree: ${formatError(error).message}`);
      return false;
    }
  }

  public async ensureTaskWorktreeForPlanning(taskId: string): Promise<string | null> {
    try {
      if (this.workspaceConfig === undefined) {
        this.workspaceConfig = await loadWorkspaceConfig(this.rootDir);
      }
      if (this.workspaceConfig && (this.workspaceConfig.repos.length ?? 0) > 0) return null;

      const live = await this.store.getTask(taskId);
      if (live.worktree && existsSync(live.worktree)) return live.worktree;

      const settings = await this.store.getSettings();
      const acquisitionTask = live.worktree
        ? ({ ...live, worktree: undefined, sessionFile: undefined } as TaskDetail)
        : live;
      const acquired = await this.ensureGraphCustomNodeWorktree(acquisitionTask, settings, "planning");
      return acquired.worktree || null;
    } catch (error) {
      executorLog.warn(`${taskId}: could not acquire a planning worktree — planning falls back to the repo root: ${formatError(error)}`);
      return null;
    }
  }

  private async prepareGraphNodeExecution(
    node: WorkflowIrNode,
    nodeTask: TaskDetail,
    settings: Settings,
    requirement: WorkflowNodePreparationRequirement,
  ): Promise<void> {
    return prepareGraphNodeExecutionImpl(
      {
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
        rootDir: this.rootDir,
        store: this.store,
        getRunContextFor: (id: string) => this.getRunContextFor(id),
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
    /* eslint-disable @typescript-eslint/no-explicit-any -- thin facade forwards TaskExecutor methods into free-function deps bag */
    return runGraphCustomNodeImpl(
      {
        store: this.store,
        rootDir: this.rootDir,
        workspaceConfig: this.workspaceConfig,
        options: this.options as { pluginRunner?: unknown; [k: string]: unknown },
        graphUnattendedRuns: this.graphUnattendedRuns,
        getRunContextFor: (id) => this.getRunContextFor(id),
        adoptColumnAgentForNode: (...args: unknown[]) => (this as any).adoptColumnAgentForNode(...args),
        buildInjectedRuntimeEnv: (...args: unknown[]) => (this as any).buildInjectedRuntimeEnv(...args),
        ensureGraphCustomNodeWorktree: (...args: unknown[]) => (this as any).ensureGraphCustomNodeWorktree(...args),
        executeScriptWorkflowStep: (...args: unknown[]) => (this as any).executeScriptWorkflowStep(...args),
        executeWorkflowStep: (...args: unknown[]) => (this as any).executeWorkflowStep(...args),
        pauseForCliApproval: (...args: unknown[]) => (this as any).pauseForCliApproval(...args),
        resolveWorkflowInputMarkerForGraphNode: (...args: unknown[]) => (this as any).resolveWorkflowInputMarkerForGraphNode(...args),
        runAwaitInputNode: (...args: unknown[]) => (this as any).runAwaitInputNode(...args),
        runCliAgentNode: (...args: unknown[]) => (this as any).runCliAgentNode(...args),
        runRawCliCommand: (...args: unknown[]) => (this as any).runRawCliCommand(...args),
      },
      node,
      nodeTask,
      settings,
      columnBinding,
      graphContext,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  private async runCliAgentNode(
    node: WorkflowIrNode,
    live: TaskDetail,
    cfg: Record<string, unknown>,
  ): Promise<WorkflowNodeResult> {
    return runCliAgentNodeImpl(
      {
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        pausedAborted: this.pausedAborted,
        resolveResumeLanes: (id, memo) => this.resolveResumeLanes(id, memo),
        recoverMissingWorktreeSessionStartFailure: (liveTask, path, err, audit) =>
          this.recoverMissingWorktreeSessionStartFailure(liveTask, path, err, audit),
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
        activeSessions: this.activeSessions,
        activeStepExecutors: this.activeStepExecutors,
        activeWorkflowStepSessions: this.activeWorkflowStepSessions,
        activeCliTaskSessions: this.activeCliTaskSessions,
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
    return isLiveSharedBranchGroupMemberImpl({ store: this.store }, live);
  }

  private async routeRetryableRemediationGraphFailureToPreMergeFix(
    live: TaskDetail,
    failedNode: string | undefined,
    failureValue: string | undefined,
  ): Promise<boolean> {
    return routeRetryableRemediationGraphFailureToPreMergeFixImpl(
      {
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        isPreMergeRemediationGraphNode: (id, node) => this.isPreMergeRemediationGraphNode(id, node),
        isLiveSharedBranchGroupMember: (live) => this.isLiveSharedBranchGroupMember(live),
        resolveFailedPreMergeWorkflowStepBudget: (t, target) => this.resolveFailedPreMergeWorkflowStepBudget(t, target),
        recoverFailedPreMergeWorkflowStep: (t) => this.recoverFailedPreMergeWorkflowStep(t),
        persistTokenUsage: (id) => this.persistTokenUsage(id),
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
        resolveResumeLanes: (id, memo) => this.resolveResumeLanes(id, memo),
        isLiveSharedBranchGroupMember: (t) => this.isLiveSharedBranchGroupMember(t),
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
        resolveResumeLanes: (id, memo) => this.resolveResumeLanes(id, memo),
        isLiveSharedBranchGroupMember: (t) => this.isLiveSharedBranchGroupMember(t),
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
        getRunContextFor: (id) => this.getRunContextFor(id),
        resolveResumeLanes: (id, memo) => this.resolveResumeLanes(id, memo),
        isLiveSharedBranchGroupMember: (t) => this.isLiveSharedBranchGroupMember(t),
        clearPausedAborted: (id) => this.clearPausedAborted(id),
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
        getRunContextFor: (id) => this.getRunContextFor(id),
        resolveResumeLanes: (id, memo) => this.resolveResumeLanes(id, memo),
        isLiveSharedBranchGroupMember: (t) => this.isLiveSharedBranchGroupMember(t),
        clearPausedAborted: (id) => this.clearPausedAborted(id),
        activeWorktrees: this.activeWorktrees,
        activeSessions: this.activeSessions,
        activeStepExecutors: this.activeStepExecutors,
        activeWorkflowStepSessions: this.activeWorkflowStepSessions,
        activeWorkflowGraphAbortControllers: this.activeWorkflowGraphAbortControllers,
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        persistTokenUsage: (id) => this.persistTokenUsage(id),
        executeWorkflowGraph: (t) => this.executeWorkflowGraph(t),
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
        resolveResumeLanes: (id, memo) => this.resolveResumeLanes(id, memo),
        isLiveSharedBranchGroupMember: (t) => this.isLiveSharedBranchGroupMember(t),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        resolveResumeLanes: (id, memo) => this.resolveResumeLanes(id, memo),
        clearPausedAborted: (id) => this.clearPausedAborted(id),
        activeWorktrees: this.activeWorktrees,
        activeSessions: this.activeSessions,
        activeStepExecutors: this.activeStepExecutors,
        activeWorkflowStepSessions: this.activeWorkflowStepSessions,
        activeWorkflowGraphAbortControllers: this.activeWorkflowGraphAbortControllers,
        processWideGraphRouting: TaskExecutor.processWideGraphRouting,
        persistTokenUsage: (id) => this.persistTokenUsage(id),
        executeWorkflowGraph: (t) => this.executeWorkflowGraph(t),
        execute: (t) => this.execute(t),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        mergeRequester: this.mergeRequester,
        ensureWorkflowMergeBoundaryTask: (liveTask, opts) => this.ensureWorkflowMergeBoundaryTask(liveTask, opts),
        persistTokenUsage: (id) => this.persistTokenUsage(id),
      },
      live,
      result,
      abortProvenance,
    );
  }

  private async routeImplementationIncompleteMergeGraphFailure(live: TaskDetail, failedNode: string): Promise<boolean> {
    return routeImplementationIncompleteMergeGraphFailureImpl(
      {
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        clearPausedAborted: (id) => this.clearPausedAborted(id),
        activeWorktrees: this.activeWorktrees,
        routeGraphFailureToExecutionResume: (t, node, value) => this.routeGraphFailureToExecutionResume(t, node, value),
        persistTokenUsage: (id) => this.persistTokenUsage(id),
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
  /** Terminal failure of a graph run: record the error and park the task in
   *  review so a human can act — never leave it invisible in in-progress. */
  private async handleGraphFailure(task: Task, result: WorkflowGraphTaskRunResult): Promise<void> {
    /* eslint-disable @typescript-eslint/no-explicit-any -- thin facade forwards TaskExecutor methods into free-function deps bag */
    return handleGraphFailureImpl(
      {
        store: this.store,
        rootDir: this.rootDir,
        options: this.options as { stuckTaskDetector?: { untrackTask?: (taskId: string) => void }; [k: string]: unknown },
        activeWorktrees: this.activeWorktrees,
        completionFinalizedTaskIds: this.completionFinalizedTaskIds,
        graphExecuteSelfRequeued: this.graphExecuteSelfRequeued,
        graphToolFailureRunCursors: this.graphToolFailureRunCursors,
        pausedAborted: this.pausedAborted,
        pausedAbortProvenance: this.pausedAbortProvenance,
        userCanceledTaskIds: this.userCanceledTaskIds,
        getRunContextFor: (id) => this.getRunContextFor(id),
        clearCompletedTaskWatchdog: (id) => this.clearCompletedTaskWatchdog(id),
        clearPausedAborted: (id) => this.clearPausedAborted(id),
        execute: (...args: unknown[]) => (this as any).execute(...args),
        finalizeMergeConfirmedWorkflowGraphTask: (...args: unknown[]) => (this as any).finalizeMergeConfirmedWorkflowGraphTask(...args),
        getTaskCompletionBlocker: (...args: unknown[]) => (this as any).getTaskCompletionBlocker(...args),
        handleStaleInReviewParsePauseAbortReplay: (...args: unknown[]) => (this as any).handleStaleInReviewParsePauseAbortReplay(...args),
        handleStaleInReviewPlanPauseAbortReplay: (...args: unknown[]) => (this as any).handleStaleInReviewPlanPauseAbortReplay(...args),
        handoffTaskToReview: (...args: unknown[]) => (this as any).handoffTaskToReview(...args),
        hasLiveTaskSessionSurface: (...args: unknown[]) => (this as any).hasLiveTaskSessionSurface(...args),
        hasTrailingConsecutiveToolFailures: (...args: unknown[]) => (this as any).hasTrailingConsecutiveToolFailures(...args),
        holdForSessionContention: (...args: unknown[]) => (this as any).holdForSessionContention(...args),
        isBenignManualMergeHoldPauseAbort: (...args: unknown[]) => (this as any).isBenignManualMergeHoldPauseAbort(...args),
        isReentrantPausedAbortedInFlightNode: (...args: unknown[]) => (this as any).isReentrantPausedAbortedInFlightNode(...args),
        isRemediationGraphNode: (...args: unknown[]) => (this as any).isRemediationGraphNode(...args),
        isRequiredArtifactRecoveryProtected: (...args: unknown[]) => (this as any).isRequiredArtifactRecoveryProtected(...args),
        isRetryableBenignMergePauseAbort: (...args: unknown[]) => (this as any).isRetryableBenignMergePauseAbort(...args),
        parkCompletedBlockedTask: (...args: unknown[]) => (this as any).parkCompletedBlockedTask(...args),
        persistTokenUsage: (...args: unknown[]) => (this as any).persistTokenUsage(...args),
        reenterPausedAbortedWorkflowNode: (...args: unknown[]) => (this as any).reenterPausedAbortedWorkflowNode(...args),
        resolveResumeLanes: (...args: unknown[]) => (this as any).resolveResumeLanes(...args),
        routeGraphFailureToExecutionResume: (...args: unknown[]) => (this as any).routeGraphFailureToExecutionResume(...args),
        routeGraphMergeFailureToRetry: (...args: unknown[]) => (this as any).routeGraphMergeFailureToRetry(...args),
        routeImplementationIncompleteMergeGraphFailure: (...args: unknown[]) => (this as any).routeImplementationIncompleteMergeGraphFailure(...args),
        routeResetParsePinMismatchToRetry: (...args: unknown[]) => (this as any).routeResetParsePinMismatchToRetry(...args),
        routeRetryableRemediationGraphFailureToPreMergeFix: (...args: unknown[]) => (this as any).routeRetryableRemediationGraphFailureToPreMergeFix(...args),
        routeUnusableWorktreeGraphFailureToRecovery: (...args: unknown[]) => (this as any).routeUnusableWorktreeGraphFailureToRecovery(...args),
        safeLogEntry: (...args: unknown[]) => (this as any).safeLogEntry(...args),
      },
      task,
      result,
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
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
        getRunContextFor: (id) => this.getRunContextFor(id),
        resolveResumeLanes: (id, memo) => this.resolveResumeLanes(id, memo),
        clearTerminalStepFailuresForRetry: (id) => this.clearTerminalStepFailuresForRetry(id),
        persistTokenUsage: (id) => this.persistTokenUsage(id),
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        clearPausedAborted: (id) => this.clearPausedAborted(id),
        activeWorktrees: this.activeWorktrees,
        persistTokenUsage: (id) => this.persistTokenUsage(id),
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
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
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
        store: this.store,
        agentStore: this.options.agentStore,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
        clearStalePauseAbortBeforeDispatch: (t) => this.clearStalePauseAbortBeforeDispatch(t),
        blockOuterDispatchWhenDependenciesUnmet: (t) => this.blockOuterDispatchWhenDependenciesUnmet(t),
        blockOuterDispatchWhenEphemeralDisabled: (t) => this.blockOuterDispatchWhenEphemeralDisabled(t),
        executeWorkflowGraph: (t, opts) => this.executeWorkflowGraph(t, opts),
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

    // FN-4811 follow-up (FN-4814/FN-4809/FN-4811 production failure): claim a
    // PROCESS-WIDE lock synchronously before any other work. Per-instance
    // `this.executing` was insufficient in production because two execute()
    // invocations for the same task ID still both reached "Executor detected
    // stale merge state" (executor.ts:2661) and both generated runIds — producing
    // duplicate "Worktree created at /..." log entries within the same second.
    // The only fully-reliable guard is a singleton lock shared across all
    // TaskExecutor instances in the same process (e.g., engine restart race,
    // multi-project hybrid runtime, etc.). This is `executingTaskLock` in
    // active-session-registry.ts, a module-level Set.
    const claimed = executingTaskLock.tryClaim(task.id);
    executorLog.debug(`execute() called for ${task.id} (claimed=${claimed}, perInstanceExecuting=${this.executing.has(task.id)})`);
    if (!claimed) {
      // FNXC:GlobalConcurrencyControls 2026-07-15-02:55: graph fallback may have re-registered a pre-held slot; drop it when this process cannot claim the executor lock.
      if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();
      return;
    }

    // Maintain the per-instance Set too, for back-compat with all the existing
    // `this.executing.has()` checks throughout the file (handler gates,
    // stuck-detector, resumeTaskForAgent, etc.). Per-instance state stays
    // consistent with the process-wide lock.
    this.executing.add(task.id);

    if (task.deletedAt) {
      executorLog.warn(`${task.id}: refusing execute — task is soft-deleted`);
      this.executing.delete(task.id);
      executingTaskLock.release(task.id);
      if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();
      return;
    }

    if (await this.maybeDispatchWorkflowWorkEngine(task)) {
      executorLog.log(`${task.id}: workflow work engine claimed execution`);
      this.executing.delete(task.id);
      executingTaskLock.release(task.id);
      // FNXC:GlobalConcurrencyControls 2026-07-15-02:55: work-engine ownership never take()s the legacy handoff registration — release the reserved global slot.
      if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();
      return;
    }

    // Column-agent principal alignment (plan U5, R6): the heartbeat-deferral gate
    // must consult the EFFECTIVE principal, not blindly `assignedAgentId`. For a
    // graph-routed seam the binding context (governing node id + per-run resolver)
    // is already set by the time the seam re-enters execute() — so the effective
    // column agent (when an override/defer binding governs) is the principal whose
    // `allowParallelExecution=false` must serialize. For the legacy/no-binding path
    // `resolveEffectivePrincipalId` returns `assignedAgentId`, so the gate is
    // byte-identical to before.
    const deferralPrincipalId = this.resolveEffectivePrincipalId(task, task);
    if (deferralPrincipalId && await this.shouldDeferForHeartbeat(deferralPrincipalId)) {
      executorLog.debug(`${task.id}: skipping execute — agent ${deferralPrincipalId} has active heartbeat run (allowParallelExecution=false)`);
      // Release the slot we just claimed — we never actually ran.
      this.executing.delete(task.id);
      executingTaskLock.release(task.id);
      // FNXC:GlobalConcurrencyControls 2026-07-15-02:55: heartbeat defer must free any re-registered pre-held global slot so capacity is not stranded until the next dispatch.
      if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();
      return;
    }

    executorLog.log(`Starting ${task.id}: ${task.title || task.description.slice(0, 60)}`);

    // Fetch settings early — needed for worktree naming and later configuration.
    // Merge per-task effective workflow settings (U3, KTD-3) OVER the project/global
    // base so the ~20 flat `settings.<key>` read sites threaded from here (workflow
    // step timeout, scope enforcement, runStepsInNewSessions, model lanes,
    // reviewHandoffPolicy, …) pick up workflow values with zero read-site changes.
    // Behavior-inert when nothing is customized (declaration defaults === legacy
    // defaults; absent-default lanes never override).
    const settings = await mergeEffectiveSettings(this.store, task, await this.store.getSettings());

    // Keep runtime plugin workflow step templates synchronized into TaskStore.
    // TaskStore resolves plugin-prefixed workflow IDs from this injected cache
    // to avoid a PluginLoader↔TaskStore circular dependency.
    const pluginWorkflowStepTemplates = this.options.pluginRunner?.getPluginWorkflowStepTemplates() ?? [];
    this.store.setPluginWorkflowStepTemplates(pluginWorkflowStepTemplates);

    // Read execution mode to determine whether to skip review and workflow steps
    const executionMode = task.executionMode ?? "standard";

    // Construct run context for mutation correlation
    // Use a synthetic correlation ID: task ID + timestamp + random suffix
    const syntheticRunId = generateSyntheticRunId("exec", task.id);
    this.currentRunContexts.set(task.id, {
      runId: syntheticRunId,
      agentId: task.assignedAgentId ?? "executor",
    });

    // Build engine run context for audit instrumentation (FN-1404)
    const engineRunContext: EngineRunContext = {
      runId: syntheticRunId,
      agentId: task.assignedAgentId ?? "executor",
      taskId: task.id,
      phase: "execute",
    };

    // Create run auditor for TaskStore-backed audit emission (no-ops if store doesn't support it)
    const audit = createRunAuditor(this.store, engineRunContext);

    // Stale spec enforcement: check if PROMPT.md has aged beyond the configured threshold.
    // When enabled, stale tasks are moved back to triage with status "needs-replan"
    // so they receive fresh specification before execution. This guard runs early in
    // execute() to prevent stale tasks from entering worktree creation or agent sessions.
    // If timestamp evaluation is skipped (missing/unreadable file), continue with execution
    // so existing filesystem validation paths remain authoritative.
    // Skip for tasks that are already in-progress, in-review, merging, or done —
    // these should not be interrupted and sent back to triage for re-planning.
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40:
    THIS GUARD DID THE EXACT THING ITS OWN COMMENT SAYS IT MUST NOT.

    The comment directly above is explicit: skip for tasks already in-progress, in-review, merging or
    done, because "these should not be interrupted and sent back to triage for re-planning". Keyed on
    a hard-coded `Set`, a renamed board matched NOTHING, so `isActiveTask` was false for a card in a
    renamed wip/review/complete lane — the stale-spec guard then ran on a LIVE task and
    `moveTaskToReplanColumn` + `status: "needs-replan"` yanked it out of execution mid-flight.

    `activeMergeStatuses` still covers the merging states, so a merging card was protected by
    accident; a plain in-progress card was not.

    CENSUS-INVISIBLE: a `Set` literal is a definition, not a comparison, so nothing in the lifecycle
    backlog pointed here. Found by grepping for lane-shaped list literals.

    Resolved from the task's OWN workflow, unioned with the legacy trio for the reason documented on
    `resolveTerminalColumnsFor`: `resolveWorkflowIrForTask` returns the BUILT-IN IR rather than
    throwing when a definition is missing or corrupt, so a degraded resolution must not NARROW this
    set — narrowing it re-opens the interruption this fixes.
    */
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-16:10 (the arity trap, seventh site):
    MEMBERSHIP, not first-per-role. `activeColumns` is a `.has()` test, but was filled from
    `resolveLifecycleColumns`, which returns the FIRST column carrying each trait — so a workflow with two
    wip lanes, or a review lane plus a second merge-blocking one, had only one of each recognised as
    active. A card in the second read as INACTIVE and its prompt file was treated as reclaimable.

    The IR is already in hand one line up; `columnsWithFlag` returns every column carrying the trait.
    The legacy trio stays unioned in — this predicate is about liveness, and under-reporting active is
    the destructive direction.
    */
    const activeIr = await resolveWorkflowIrForTask(this.store, task.id);
    const activeColumns = new Set<string>(["in-progress", "in-review", "done"]);
    if (activeIr) {
      for (const flag of ["countsTowardWip", "mergeOrchestration", "mergeBlocker", "humanReview", "complete"] as const) {
        for (const lane of columnsWithFlag(activeIr, flag)) activeColumns.add(lane);
      }
    }
    const activeMergeStatuses = new Set(["merging", "merging-pr", "merging-fix"]);
    const isActiveTask = activeColumns.has(task.column) || activeMergeStatuses.has(task.status ?? "");
    if (!isActiveTask) {
      const tasksDir = join(this.store.getFusionDir(), "tasks");
      const promptPath = getPromptPath(tasksDir, task.id);
      const staleness = await evaluateSpecStaleness({
        settings,
        promptPath,
        task,
        /* FNXC:WorkflowLifecycleColumns 2026-07-30-12:40 (U11): one-line pass-through
           so the guard is driven rather than defaulted. Touches no executor logic. */
        plannerColumns: await resolveDedicatedPlannerColumnsForTask(this.store, task.id),
      });
      if (staleness.isStale) {
        executorLog.warn(`Task ${task.id} specification is stale — ${staleness.reason}`);
        // Move to the workflow-aware replan column first, then set status so the task
        // enters it with needs-replan (workflows without "triage" replan in place in todo).
        await moveTaskToReplanColumn(this.store, task);
        await this.store.updateTask(task.id, { status: "needs-replan" });
        await this.store.logEntry(task.id, staleness.reason, undefined, this.getRunContextFor(task.id));
        // FNXC:GlobalConcurrencyControls 2026-07-15-02:55: replan handoff never starts agent work — free any re-registered pre-held slot before leaving execute().
        if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();
        return;
      }
    }

    // Drift detection: a task that is already in-progress (i.e. we're not
    // dispatching it fresh from todo) should always carry a `worktree`. If it
    // doesn't, some prior update — most likely a partial pause/abort sequence
    // where updateTask({ worktree: null }) succeeded but the subsequent
    // moveTask()/status write failed — left the row in a half-state. The
    // executor can still recover by falling through to the fresh-worktree
    // path below, but we emit a loud audit record so these states stop being
    // silent.
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: execute() preflight): THREE DRIFT CHECKS, ONE
    SNAPSHOT — merge-confirmed while still executing, stale mergeDetails, and in-wip with no worktree. None
    fired on a renamed board, so every recovery they perform silently stopped happening. The third one's own
    message says it "usually indicates a partial updateTask/moveTask sequence failed" — a diagnostic that
    could never print on a renamed board.
    */
    const preflightWipLane = (await this.resolveResumeLanes(task.id)).wip;
    if (task.column === preflightWipLane && task.mergeDetails?.mergeConfirmed === true) {
      if (await this.finalizeMergeConfirmedWorkflowGraphTask(task.id, "execute-preflight")) {
        this.executing.delete(task.id);
        executingTaskLock.release(task.id);
        if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();
        return;
      }
    }

    if (task.column === preflightWipLane && task.mergeDetails) {
      executorLog.warn(`${task.id}: stale mergeDetails found while executing in-progress task — resetting merge state before continuing`);
      task = await this.cleanupMergeStateForReverification(
        task,
        "Executor detected stale merge state while task was in-progress — reset verification steps and merge metadata before resuming",
      );
    }

    if (task.column === preflightWipLane && !task.worktree) {
      executorLog.error(
        `${task.id}: drift detected — task is in-progress with no worktree. ` +
          `Recovering by creating a fresh worktree. This usually indicates a partial ` +
          `updateTask/moveTask sequence failed somewhere upstream.`,
      );
      await this.store.logEntry(
        task.id,
        "Drift detected: in-progress with no worktree — creating fresh worktree to recover",
        undefined,
        this.getRunContextFor(task.id),
      );
    }

    // Hoist worktreePath so it's accessible in the catch block for dep-abort cleanup
    let worktreePath = task.worktree ?? "";

    // Set by stuck-abort handlers; the actual moveTask("todo") is deferred to
    // the finally block so this.executing is cleared first (prevents re-dispatch race).
    // true = requeue to todo, false = budget exhausted (already marked failed).
    let stuckRequeue: boolean | null = null;
    let staleAssistantContinuationRequeue = false;
    let taskDone = false;
    let reviewAddressingActivated = false;
    let taskEnv: NodeJS.ProcessEnv | undefined;

    try {
      await this.transitionReviewAddressing(task.id, ["queued"], "in-progress");
      reviewAddressingActivated = true;
      // Check dependencies
      const allTasks = await this.store.listTasks({ slim: true, includeArchived: false });
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (batch-engine — dependency satisfaction, per DEPENDENCY):
      Resolved from each DEPENDENCY's own workflow, not this task's: dependencies routinely span workflows,
      so asking "is my blocker finished?" against the blocked task's vocabulary is the wrong question. That
      is the answer main settled on in `branch-group-ops.ts` (#2720) and it is reused here rather than
      re-derived.

      MEMBERSHIP and unioned with the legacy trio, because a workflow may declare more than one complete or
      review lane and `resolveWorkflowIrForTask` yields the BUILT-IN IR for a missing workflow rather than
      throwing — without the union a degraded renamed board treats a finished blocker as unmet and the
      dependent never runs.

      NOTE the set is wider than the terminal pair: this guard has always counted `in-review` as satisfying
      a dependency, so the review role is included. Narrowing it to terminal-only would be a behaviour
      change, not a conversion.
      */
      const depIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const satisfiedByDep = new Map<string, ReadonlySet<string>>();
      for (const depId of task.dependencies) {
        if (satisfiedByDep.has(depId)) continue;
        const satisfied = new Set<string>(["done", "in-review", "archived"]);
        try {
          const depIr = await resolveWorkflowIrForTask(this.store, depId, depIrCache);
          if (depIr) {
            for (const flag of ["complete", "archived", "mergeOrchestration", "mergeBlocker", "humanReview"] as const) {
              for (const id of columnsWithFlag(depIr, flag)) satisfied.add(id);
            }
          }
        } catch { /* degraded: the legacy trio */ }
        satisfiedByDep.set(depId, satisfied);
      }
      const unmetDeps = task.dependencies.filter((depId) => {
        const dep = allTasks.find((t) => t.id === depId);
        return dep !== undefined && !satisfiedByDep.get(depId)!.has(dep.column);
      });

      if (unmetDeps.length > 0) {
        executorLog.log(`${task.id} blocked by: ${unmetDeps.join(", ")} — deferring`);
        return;
      }

      if (this.workspaceConfig === undefined) {
        this.workspaceConfig = await loadWorkspaceConfig(this.rootDir);
      }
      /*
      FNXC:Workspace 2026-06-22-00:00:
      Workspace mode is only meaningful with at least one usable sub-repo. An empty `{ repos: [] }`
      must NOT bypass the git-repository guard, inject workspace instructions, or expose the
      workspace tool — otherwise a non-git directory with an empty config would skip validation
      and enable a workspace with nothing to work on. Gate every workspace check on repos.length > 0.
      */
      const hasWorkspaceRepos = (this.workspaceConfig?.repos.length ?? 0) > 0;
      if (!hasWorkspaceRepos) {
        const gitDetection = await detectGitRepository(this.rootDir);
        if (gitDetection.status === "not-repo") {
          await this.store.logEntry(
            task.id,
            "Cannot execute task: project directory is not a Git repository. Fusion requires a Git repository for worktree-based task execution.",
          );
          throw new Error(
            "Project directory is not a Git repository. Fusion requires a Git repository for worktree creation. Initialize with 'git init' or run from a Git project directory.",
          );
        }
        if (gitDetection.status === "error") {
          /*
          FNXC:Worktree 2026-07-10-00:00:
          FN-7799 requires environmental Git probe failures in valid repos to surface the real cause instead of telling operators to run `git init`. Dubious ownership and similar persistent failures otherwise block every task across restarts with a false non-repo diagnosis.
          */
          const message = formatGitRepositoryDetectionError(this.rootDir, gitDetection);
          await this.store.logEntry(task.id, message);
          throw new Error(message);
        }
      }

      const hadAssignedWorktree = Boolean(task.worktree);
      const taskCommandAbortController = new AbortController();
      this.registerConfiguredCommandController(task.id, taskCommandAbortController);
      /*
      FNXC:Workspace 2026-06-21-12:00:
      KTD1 — in workspace mode `this.rootDir` is a NON-git parent. Acquiring a root worktree there fails. Skip root acquisition entirely and run the agent session rooted at the browse-only workspace root; the agent acquires per-sub-repo worktrees on demand via fn_acquire_repo_worktree. `task.worktree` stays unset. We synthesize a non-fresh, non-resume acquisition with an empty branch so the downstream env-injection/onStart bookkeeping runs unchanged while every rootDir git preflight (base capture, contamination, liveness) is gated off below. The non-workspace branch is byte-for-byte the original acquisition path.
      */
      const acquisition: AcquireTaskWorktreeResult = this.workspaceConfig
        ? {
            worktreePath: this.rootDir,
            branch: "",
            source: "existing",
            hydrated: true,
            isResume: Boolean(task.sessionFile),
          }
        : await (async () => {
        try {
          return await acquireTaskWorktree({
            task,
            rootDir: this.rootDir,
            store: this.store,
            settings,
            pool: this.options.pool,
            logger: executorLog,
            audit,
            runContext: this.getRunContextFor(task.id),
            runInitCommand: true,
            createWorktree: this.createWorktree.bind(this),
            runConfiguredCommand: (command, cwd, timeoutMs, env) =>
              runConfiguredCommand(
                command,
                cwd,
                timeoutMs,
                env,
                audit,
                taskCommandAbortController.signal,
              ).then((result) => {
                if (taskCommandAbortController.signal.aborted) {
                  throw createConfiguredCommandAbortError(task.id, command);
                }
                return result;
              }),
            taskEnv,
            secretsStore: this.options.secretsStore,
            refreshStaleBase: true,
          });
        } finally {
          this.unregisterConfiguredCommandController(task.id, taskCommandAbortController);
        }
      })();
      worktreePath = acquisition.worktreePath;

      if (acquisition.reclaimed) {
        await audit.git({
          type: "branch:auto-reclaim",
          target: acquisition.branch,
          metadata: {
            taskId: task.id,
            branch: acquisition.branch,
            worktreePath: acquisition.worktreePath,
            existingTipSha: acquisition.reclaimed.existingTipSha,
            strandedCommitCount: acquisition.reclaimed.strandedCommitCount ?? 0,
            trigger: "dispatch-preflight",
          },
        });
      }

      if (!acquisition.isResume && acquisition.source === "fresh" && settings.setupScript) {
        const scriptCommand = settings.scripts?.[settings.setupScript];
        if (scriptCommand) {
          const setupStartedAt = Date.now();
          const setupAbortController = new AbortController();
          this.registerConfiguredCommandController(task.id, setupAbortController);
          try {
            const setupResult = await runConfiguredCommand(
              scriptCommand,
              worktreePath,
              120_000,
              taskEnv,
              audit,
              setupAbortController.signal,
            );
            if (setupAbortController.signal.aborted) {
              throw createConfiguredCommandAbortError(task.id, scriptCommand);
            }
            if (setupResult.spawnError || setupResult.timedOut || setupResult.exitCode !== 0) {
              throw new Error(configuredCommandErrorMessage(setupResult));
            }
            await this.store.logEntry(task.id, `[timing] Setup script '${settings.setupScript}' completed in ${Date.now() - setupStartedAt}ms`, scriptCommand, this.getRunContextFor(task.id));
          } catch (err: unknown) {
            if (err instanceof Error && err.name === "AbortError") {
              throw err;
            }
            const execError = err instanceof Error ? err : new Error(String(err));
            const message = "stderr" in execError && typeof (execError as Record<string, unknown>).stderr === "string"
              ? String((execError as Record<string, unknown>).stderr)
              : execError.message;
            await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' failed: ${message}`, undefined, this.getRunContextFor(task.id));
          } finally {
            this.unregisterConfiguredCommandController(task.id, setupAbortController);
          }
        } else {
          await this.store.logEntry(task.id, `Setup script '${settings.setupScript}' not found in scripts map — skipping`, undefined, this.getRunContextFor(task.id));
        }
      }

      /*
      FNXC:Workspace 2026-06-21-12:00:
      KTD1 — every preflight below (base-commit capture, contamination check, worktree-liveness gate) runs git against `worktreePath`, which equals the non-git workspace root in workspace mode. They would all fail. Gate the whole block off in workspace mode; the per-repo equivalents return in Phase B (master U3) against each acquired sub-repo worktree. The non-workspace branch is unchanged.
      */
      if (!this.workspaceConfig) {
      // Capture the base commit SHA for diff computation whenever a task
      // starts with a newly assigned worktree.
      if (!acquisition.isResume) {
        await captureBaseCommitSha(this.store, task, worktreePath, audit, { isResume: false });
      }

      // Contamination check must use a FRESH merge-base with the integration
      // branch — NOT task.baseCommitSha. baseCommitSha is intentionally
      // preserved across sessions for stable diff math, which makes it
      // potentially stale relative to main. Using it here would falsely flag
      // every legitimately-merged commit on main since that stale SHA as
      // "foreign contamination" (see FN-4417). The real signal we want is:
      // does the branch contain commits past its current merge-base with main
      // that are attributed to OTHER tasks? Compute the merge-base fresh.
      const contaminationBaseRef = await resolveContaminationBaseRef(worktreePath);
      if (contaminationBaseRef) {
        try {
          await assertCleanBranchAtBase(this.rootDir, acquisition.branch, contaminationBaseRef, task.id);
        } catch (contaminationError: unknown) {
          if (!(contaminationError instanceof BranchCrossContaminationError)) {
            throw contaminationError;
          }
          const recovered = await this.tryBootstrapMisbindingRecovery(task, contaminationError, audit);
          if (recovered) {
            return;
          }
          throw contaminationError;
        }
      }

      const expectedRoot = canonicalizePath(this.rootDir);
      let observedWorktreeRealpath: string;
      let livenessFailure: string | null = null;
      try {
        observedWorktreeRealpath = canonicalizePath(worktreePath);
        if (observedWorktreeRealpath === expectedRoot) {
          livenessFailure = "realpath_matches_repo_root";
        }
      } catch (error) {
        observedWorktreeRealpath = `unresolvable:${worktreePath}`;
        livenessFailure = `unresolvable_worktree:${error instanceof Error ? error.message : String(error)}`;
      }

      if (!livenessFailure && !isInsideWorktreesDir(this.rootDir, worktreePath, settings)) {
        livenessFailure = "outside_worktrees_dir";
      }

      let livenessFailureReason: string | null = null;
      let livenessClassification: string | null = null;
      const shouldGate = acquisition.isResume || (hadAssignedWorktree && !task.sessionFile && acquisition.source !== "fresh");
      if (!livenessFailure && shouldGate) {
        const classification = await classifyTaskWorktree(this.rootDir, worktreePath);
        if (!classification.ok) {
          const reanchor = await detectNestedWorktreeRoot(this.rootDir, worktreePath, settings);
          if (reanchor.reanchored) {
            await this.store.updateTask(task.id, { worktree: reanchor.root });
            await this.store.logEntry(task.id, `Re-anchored nested task.worktree from ${worktreePath} to ${reanchor.root}`, undefined, this.getRunContextFor(task.id));
            await this.emitWorktreeReanchoredAudit(task.id, worktreePath, reanchor.root, "executor-liveness-gate");
            worktreePath = reanchor.root;
            observedWorktreeRealpath = canonicalizePath(reanchor.root);
          } else {
            livenessClassification = classification.classification;
            livenessFailureReason = classification.reason;
            livenessFailure = `not_usable_task_worktree:${classification.classification}`;
          }
        }
      }

      if (livenessFailure) {
        const expected = `${resolveWorktreesDir(this.rootDir, settings)}/* (usable, registered)`;
        const observed = `${worktreePath} (${observedWorktreeRealpath})`;
        let registeredPaths: string[] = [];
        try {
          const registeredSnapshot = await describeRegisteredWorktrees(this.rootDir);
          registeredPaths = registeredSnapshot.canonicalized;
        } catch {
          registeredPaths = [];
        }
        const visibleRegistered = registeredPaths.slice(0, 10);
        const registeredSuffix = registeredPaths.length > 10
          ? `, … +${registeredPaths.length - 10} more`
          : "";
        const registeredSection = ` — registered=[${visibleRegistered.join(", ")}${registeredSuffix}]`;
        const reasonSection = livenessFailureReason ? ` (${livenessFailureReason})` : "";
        const failureMessage = `worktree liveness assertion failed: ${livenessFailure}${reasonSection} — observed=${observed}, expected=${expected}${registeredSection}`;
        executorLog.error(`${task.id}: ${failureMessage}`);
        await this.store.logEntry(task.id, failureMessage, undefined, this.getRunContextFor(task.id));

        const priorRequeues = task.taskDoneRetryCount ?? 0;
        const nextRequeueCount = priorRequeues + 1;
        const terminalAction = priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES ? "requeue-todo" : "park-in-review";
        const isRepoRootCollision = livenessFailure === "realpath_matches_repo_root";
        const auditClassification = livenessClassification ?? (isRepoRootCollision ? "repo-root" : null);
        const auditReason = livenessFailureReason ?? (isRepoRootCollision ? "worktree path realpath matches the project root, not a task worktree" : null);
        /*
         * FNXC:WorktreeLiveness 2026-06-21-11:10:
         * The executor still keeps the repo-root realpath check as defense in depth. If acquisition ever hands the root to this gate, emit structured evidence that separates the invalid checkout path from the normal git registered-worktree snapshot and the configured task-worktree pattern.
         */
        if (auditClassification) {
          const registeredContainsObserved = registeredPaths.includes(observedWorktreeRealpath);
          await audit.git({
            type: "worktree:incomplete-detected",
            target: worktreePath,
            metadata: {
              classification: auditClassification,
              reason: auditReason ?? undefined,
              source: "executor-liveness-gate",
              taskId: task.id,
              retryCount: nextRequeueCount,
              maxRetries: MAX_TASK_DONE_REQUEUE_RETRIES,
              terminalAction,
              observed: worktreePath,
              observedRealpath: observedWorktreeRealpath,
              expected,
              registered: visibleRegistered,
              registeredTotal: registeredPaths.length,
              registeredContainsObserved,
              invalidCheckoutPath: isRepoRootCollision ? "repo-root" : undefined,
              expectedPatternExcludesRepoRoot: isRepoRootCollision,
            },
          });
        }

        if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
          await this.store.updateTask(task.id, {
            status: "queued",
            error: null,
            worktree: null,
            branch: null,
            sessionFile: null,
            taskDoneRetryCount: nextRequeueCount,
            paused: false,
            pausedByAgentId: null,
          });
          await this.store.logEntry(
            task.id,
            `${failureMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
            undefined,
            this.getRunContextFor(task.id),
          );
          this.markGraphExecuteSelfRequeued(task.id);
          await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveProgress: true });
          executorLog.log(`✗ ${task.id} worktree liveness failed — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
        } else {
          await this.store.updateTask(task.id, {
            status: "failed",
            error: failureMessage,
            worktree: null,
            branch: null,
            sessionFile: null,
            paused: false,
            pausedByAgentId: null,
          });
          await this.store.logEntry(task.id, `${failureMessage} — execution failed after worktree liveness retry budget was exhausted`, undefined, this.getRunContextFor(task.id));
          await this.persistTokenUsage(task.id);
          executorLog.log(`✗ ${task.id} worktree liveness failed`);
        }
        this.options.onError?.(task, new Error(failureMessage));
        return;
      }
      } // end !this.workspaceConfig preflight gate (FNXC:Workspace KTD1)

      // FNXC:Workspace 2026-06-21-12:00: KTD2 — register the worktree path under the task's Set. In workspace mode `worktreePath` is the browse-only root; per-repo sub-repo worktree paths ARE now added to the same Set as the agent acquires them (F2: fn_acquire_repo_worktree's onAcquired callback → addActiveWorktree), so the Set holds root + N sub-repo paths, not just the root. Non-workspace tasks add exactly one path → a one-element set (unchanged liveness/owner semantics).
      this.addActiveWorktree(task.id, worktreePath);
      executorLog.debug(`${task.id}: worktree ready at ${worktreePath}`);

      const injected = await this.buildInjectedRuntimeEnv(task.id, worktreePath, acquisition.branch ?? undefined);
      taskEnv = injected.env;
      // FNXC:EngineDiagnostics 2026-08-03-05:54: env injection counts are session setup, not operator state changes.
      executorLog.debug(`${task.id}: executor runtime env injected (${injected.pathEntryCount} PATH entries, ${injected.injectedKeyCount} env keys)`);

      this.options.onStart?.(task, worktreePath);

      const detail = await this.store.getTask(task.id);
      executorLog.debug(`${task.id}: fetched task detail (${detail.steps.length} steps, prompt length=${detail.prompt?.length ?? 0})`);

      // Initialize steps from PROMPT.md if empty
      if (detail.steps.length === 0) {
        const steps = await this.store.parseStepsFromPrompt(task.id);
        if (steps.length > 0) {
          await this.store.updateStep(task.id, 0, "pending");
        }
      }

      // On resume (task.branch already set from a prior run), reconcile step
      // statuses from git history so the agent doesn't redo already-committed work.
      if (acquisition.isResume && task.branch && detail.steps.length > 0) {
        await this.reconcileStepsFromGitHistory(task.id, detail, worktreePath);
      }

      // ── Step-Session vs Single-Session execution path ──
      // When runStepsInNewSessions is enabled, each step runs in its own
      // fresh agent session via StepSessionExecutor. Otherwise, the existing
      // single-session flow runs all steps in one monolithic session.

      // Build skill selection context early so it's available in both paths
      const skillContext = await buildSessionSkillContext({
        agentStore: this.options.agentStore!,
        task: detail,
        sessionPurpose: "executor",
        projectRootDir: this.rootDir,
        pluginRunner: this.options.pluginRunner,
      });
      const graphSeamSkillName = this.graphSeamSkillName.get(task.id);
      const ceSkillsDir = typeof taskEnv?.FUSION_CE_SKILLS_DIR === "string" && taskEnv.FUSION_CE_SKILLS_DIR.trim()
        ? taskEnv.FUSION_CE_SKILLS_DIR.trim()
        : typeof process.env.FUSION_CE_SKILLS_DIR === "string" && process.env.FUSION_CE_SKILLS_DIR.trim()
          ? process.env.FUSION_CE_SKILLS_DIR.trim()
          : undefined;
      let stepSessionSkillSelection = skillContext.skillSelectionContext;
      if (graphSeamSkillName) {
        const bare = graphSeamSkillName.includes(":")
          ? graphSeamSkillName.slice(graphSeamSkillName.lastIndexOf(":") + 1)
          : graphSeamSkillName;
        const existing = stepSessionSkillSelection?.requestedSkillNames ?? [];
        stepSessionSkillSelection = {
          projectRootDir: stepSessionSkillSelection?.projectRootDir ?? this.rootDir,
          ...(stepSessionSkillSelection?.sessionPurpose
            ? { sessionPurpose: stepSessionSkillSelection.sessionPurpose }
            : { sessionPurpose: "executor" }),
          requestedSkillNames: [...new Set([...existing, graphSeamSkillName, bare])],
        };
      }
      const stepSessionAdditionalSkillPaths = mergeAdditionalSkillPaths(
        skillContext.additionalSkillPaths,
        graphSeamSkillName && ceSkillsDir ? [ceSkillsDir] : undefined,
      );
      if (
        graphSeamSkillName
        && !isWorkflowStepSkillDiscoverable(graphSeamSkillName, stepSessionAdditionalSkillPaths, ceSkillsDir)
      ) {
        await this.store.logEntry(
          task.id,
          `[skill-load] Foreach step-execute requests skill '${graphSeamSkillName}' but it cannot be discovered from configured plugin body directories or FUSION_CE_SKILLS_DIR; the step runs with role-fallback skills only.`,
        );
      }

      // Graph-owned stepwise runs force step-session physics for the run (KTD-2/
      // KTD-8): the discrete per-step boundary the foreach driver needs exists only
      // in StepSessionExecutor. Pinned per run so a mid-flight setting toggle never
      // selects the unsupported (graph ON × step-sessions OFF) combination.
      const forceStepSession = this.graphStepSessionPinned.has(task.id);
      if (settings.runStepsInNewSessions || forceStepSession) {
        // ── Step-Session Path ──────────────────────────────────────────
        executorLog.debug(`${task.id}: using step-session mode (maxParallel=${settings.maxParallelSteps ?? 2}${forceStepSession ? ", graph-pinned" : ""})`);

        const stepSessionAgent = await this.getAuthoritativeAssignedAgent(detail.assignedAgentId);

        // Column-agent SESSION IDENTITY (U4, R2/R3/R4/R8): when the governing
        // step-execute node's declared column binds an agent that supersedes the
        // task's assigned agent, the per-step session's MODEL, runtime hint, and
        // attribution adopt the column agent. The core resolver decides defer vs
        // override (KTD-2); a missing agent logs + falls back (R8). Principal
        // alignment (U5, R5/R6): the gating contexts below ALSO key off the
        // effective `stepIdentityAgent`, and the effective principal is tracked for
        // the reverse-direction heartbeat guard.
        const stepColumnAgent = await this.resolveSeamColumnAgent(task, detail);
        const stepIdentityAgent = stepColumnAgent?.agent ?? stepSessionAgent;
        // U5 (R6): track the effective column-agent principal so the heartbeat
        // scheduler's reverse guard knows this agent is executing a task it may not
        // be assigned to. Cleared in deleteActiveStepExecutor.
        if (stepColumnAgent?.agent) {
          this.effectiveColumnAgentByTask.set(task.id, stepColumnAgent.agent.id);
        }
        const stepSessionRuntimeHint = extractRuntimeHint(stepIdentityAgent?.runtimeConfig);

        let accumulatedStepTokenUsage = detail.tokenUsage;
        const tokenUsageRecordedSteps = new Set<number>();
        let stepRotationEvent: import("./credential-instance-rotation.js").RotationEvent | undefined;
        let stepRotationDeclined = false;
        let stepDispatchedRotation = false;
        const initialStepSessionModel = resolveExecutorSessionModel(
          detail.modelProvider,
          detail.modelId,
          settings,
          (stepIdentityAgent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
          detail.credentialInstanceId ?? undefined,
        );
        let activeStepInstanceRef: ProviderInstanceRef | undefined = initialStepSessionModel.provider
          ? {
              providerId: initialStepSessionModel.provider,
              instanceId: initialStepSessionModel.credentialInstanceId ?? DEFAULT_PROVIDER_INSTANCE_ID,
            }
          : undefined;
        const stepExecutorRef: { current?: StepSessionExecutor } = {};
        const nextStepInstance = async (): Promise<ProviderInstanceRef | undefined> => {
          /*
          FNXC:CredentialInstanceRotation 2026-08-01-11:22:
          Executor-step retries refresh task and project pause state at the limit
          boundary, rather than trusting dispatch snapshots. A pause arriving while
          a session is in flight must prevent an autonomous billed-account switch.
          */
          const [liveTask, liveSettings] = await Promise.all([
            this.store.getTask(task.id).catch(() => undefined),
            this.store.getSettings().catch(() => settings),
          ]);
          if (stepRotationDeclined || this.pausedAborted.has(task.id) || !liveTask
            || liveTask.userPaused === true || liveTask.autoMerge === false
            || liveSettings.globalPause === true || liveSettings.enginePaused === true
            || !activeStepInstanceRef?.providerId) return undefined;
          stepRotationEvent ??= await this.options.credentialRotator?.beginEvent({
            providerId: activeStepInstanceRef.providerId,
            startingInstanceId: activeStepInstanceRef.instanceId,
            lane: "executor-step",
            taskId: task.id,
          });
          if (!stepRotationEvent) { stepRotationDeclined = true; return undefined; }
          // FNXC:CredentialInstanceRotation 2026-08-01-11:34: beginEvent awaits credential inventory, so repeat the human-control check after it resolves. A pause that races this await must prevent cooldown writes and credential dispatch.
          const [postInventoryTask, postInventorySettings] = await Promise.all([
            this.store.getTask(task.id).catch(() => undefined),
            this.store.getSettings().catch(() => settings),
          ]);
          if (this.pausedAborted.has(task.id) || !postInventoryTask
            || postInventoryTask.userPaused === true || postInventoryTask.autoMerge === false
            || postInventorySettings.globalPause === true || postInventorySettings.enginePaused === true) return undefined;
          this.options.credentialRotator?.markLimited(activeStepInstanceRef);
          if (stepDispatchedRotation) stepRotationEvent.recordOutcome("rotation-failed-limit");
          const next = await stepRotationEvent.next();
          if (!next) { stepRotationEvent.finishExhausted(); return undefined; }
          activeStepInstanceRef = next;
          stepDispatchedRotation = true;
          await stepExecutorRef.current?.retargetCredentialInstance(next);
          return next;
        };
        /*
        FNXC:WorkflowStepControl 2026-06-29-10:15:
        Graph-pinned step sessions are lifecycle-owned by the workflow graph, not by the legacy executor prompt/tools. Their callback projection must use source:"graph" so independent steps can finish out of index order and so duplicate graph runner writes do not trigger the legacy sequential fn_task_update guard.
        */
        const stepProjectionOptions = forceStepSession ? { source: "graph" as const } : undefined;

        const stepExecutor = new StepSessionExecutor({
          store: this.store,
          taskDetail: detail,
          worktreePath,
          rootDir: this.rootDir,
          settings,
          // FNXC:GlobalConcurrencyControls 2026-07-14-18:30: When the graph run already owns a top-level slot (outerConcurrencyClaims), do not pass the semaphore into per-step sessions — each step would acquire a second slot and can deadlock under a full global cap.
          semaphore: this.outerConcurrencyClaims.has(task.id) ? undefined : this.options.semaphore,
          stuckTaskDetector: this.options.stuckTaskDetector,
          pluginRunner: this.options.pluginRunner,
          runtimeHint: stepSessionRuntimeHint,
          assignedAgentRuntimeConfig: (stepIdentityAgent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
          /*
           * FNXC:CredentialInstanceRotation 2026-08-01-10:41:
           * Step sessions must start on the task-selected account. On a usage-limit
           * retry, re-read the live selection and resolve its provider with the same
           * effective column-agent runtime config used to create the session.
           */
          credentialInstanceId: detail.credentialInstanceId,
          resolveCredentialInstanceRetarget: nextStepInstance,
          // Attribute the per-step run auditor to the column agent when it governs
          // (U4); absent → StepSessionExecutor falls back to assignedAgentId.
          effectiveAgentId: stepColumnAgent?.agent.id,
          actionGateContext: this.buildActionGateContext(task.id, stepIdentityAgent, settings.defaultAgentPermissionPolicy),
          permanentAgentGating: this.buildPermanentAgentGatingContext(task.id, stepIdentityAgent, settings.defaultAgentPermissionPolicy),
          // FNXC:McpConfig 2026-06-25-23:03: Per-step workflow sessions are an executor lane, so they inherit the task's resolved MCP set from the effective step identity agent and never re-read or log plaintext secret values.
          mcpServers: await this.resolveMcpServers(stepIdentityAgent?.id),
          workflowStepThinkingLevel: this.graphSeamThinkingLevel.get(task.id),
          // FNXC:PluginSkills 2026-07-12-00:00: Step sessions must forward plugin skill body dirs alongside requested names; otherwise plugin-provided SKILL.md bodies are invisible to the inner createFnAgent loader.
          skillSelection: stepSessionSkillSelection,
          additionalSkillPaths: stepSessionAdditionalSkillPaths,
          // Pass agentStore and messageStore for delegation and messaging tools
          agentStore: this.options.agentStore,
          messageStore: this.options.messageStore,
          callerIsEphemeral: !stepIdentityAgent || isEphemeralAgent(stepIdentityAgent),
          sourceTaskId: task.id,
          sourceAgentId: stepIdentityAgent?.id,
          taskEnv,
          // FNXC:StepLifecycle 2026-07-22-09:53: Await the dependency-aware store projection before session allocation so a rejected out-of-order start cannot execute while its persisted step remains pending.
          onStepStart: async (stepIndex) => {
            try {
              const startResult = await this.store.startStep(
                task.id,
                stepIndex,
                stepProjectionOptions,
              );
              if (!startResult.accepted) {
                executorLog.warn(
                  `${task.id}: step ${stepIndex} start was rejected (${startResult.disposition}); persisted status is ` +
                  `${startResult.task.steps?.[stepIndex]?.status ?? "missing"}`,
                );
                return false;
              }
              this.options.stuckTaskDetector?.recordProgress(task.id);
            } catch (err) {
              executorLog.warn(`${task.id}: failed to update step ${stepIndex} status to in-progress: ${err}`);
              return false;
            }
          },
          onStepComplete: (stepIndex, result) => {
            // FNXC:EngineDiagnostics 2026-07-26-10:05: per-step success is expected bookkeeping (incl. foreach instances); failures stay at log.
            if (result.success) {
              executorLog.debug(`${task.id}: step ${stepIndex} succeeded (${result.retries} retries)`);
            } else {
              executorLog.log(`${task.id}: step ${stepIndex} failed (${result.retries} retries)`);
            }
            try {
              this.store.updateStep(task.id, stepIndex, result.success ? "done" : "skipped", stepProjectionOptions).catch((err) => {
                executorLog.warn(`${task.id}: failed to update step ${stepIndex} status: ${err}`);
              });
              const safeReason = result.success ? undefined : sanitizeFailureReason(result.error);
              if (!result.success) {
                void emitProactiveStatus(
                  this.store,
                  task.id,
                  buildStepFailureMessage(stepIndex, detail.steps[stepIndex]?.name, safeReason!),
                  "executor",
                  safeReason,
                );
              }
            } catch (err) {
              executorLog.warn(`${task.id}: failed to update step ${stepIndex} status: ${err}`);
            }

            if (!result.tokenUsage) {
              return;
            }

            const previousStepTokenUsage = accumulatedStepTokenUsage;
            accumulatedStepTokenUsage = accumulateTokenUsageImpl(accumulatedStepTokenUsage, result.tokenUsage);
            if (accumulatedStepTokenUsage) {
              // FNXC:TokenAnalytics 2026-06-19-15:55: Step-scoped token writes now carry the producing session model so workflow-step sessions contribute their exact deltas to per-model analytics instead of relying on the last central session snapshot.
              accumulatedStepTokenUsage = tokenUsageWithModelSnapshotImpl(accumulatedStepTokenUsage, undefined, previousStepTokenUsage, result.tokenUsage, accumulatedStepTokenUsage.lastUsedAt, { provider: result.tokenUsage.modelProvider, id: result.tokenUsage.modelId });
            }
            tokenUsageRecordedSteps.add(stepIndex);
            if (!accumulatedStepTokenUsage) {
              return;
            }

            this.persistTaskTokenUsage(task.id, accumulatedStepTokenUsage).catch((err) => {
              executorLog.warn(`${task.id}: failed to persist token usage on step ${stepIndex} complete: ${err}`);
            });
          },
        });
        stepExecutorRef.current = stepExecutor;
        this.setActiveStepExecutor(task.id, stepExecutor, worktreePath, createSeenSteeringIds(detail));

        const stepWork = async () => {
          const results = await stepExecutor.executeAll();

          // Check abort conditions after execution completes
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
            return;
          }
          if (this.pausedAborted.has(task.id)) {
            if (this.userCanceledTaskIds.has(task.id)) {
              this.clearPausedAborted(task.id);
              this.stuckAborted.delete(task.id);
              this.userCanceledTaskIds.delete(task.id);
              await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            if (await this.parkApprovalSuspension(task.id, "step sessions")) return;
            this.clearPausedAborted(task.id);
            await this.store.logEntry(task.id, "Execution paused — step sessions terminated, moved to todo", undefined, this.getRunContextFor(task.id));
            this.markGraphExecuteSelfRequeued(task.id);
            await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveResumeState: true });
            return;
          }
          if (this.stuckAborted.has(task.id)) {
            stuckRequeue = this.stuckAborted.get(task.id) ?? true;
            this.stuckAborted.delete(task.id);
            return;
          }

          for (const result of results) {
            if (!result.tokenUsage || tokenUsageRecordedSteps.has(result.stepIndex)) {
              continue;
            }
            const previousStepTokenUsage = accumulatedStepTokenUsage;
            accumulatedStepTokenUsage = accumulateTokenUsageImpl(accumulatedStepTokenUsage, result.tokenUsage);
            if (accumulatedStepTokenUsage) {
              accumulatedStepTokenUsage = tokenUsageWithModelSnapshotImpl(accumulatedStepTokenUsage, undefined, previousStepTokenUsage, result.tokenUsage, accumulatedStepTokenUsage.lastUsedAt, { provider: result.tokenUsage.modelProvider, id: result.tokenUsage.modelId });
            }
          }

          if (accumulatedStepTokenUsage) {
            await this.persistTaskTokenUsage(task.id, accumulatedStepTokenUsage);
          }

          const allSuccess = results.every(r => r.success);
          if (allSuccess) {
            const updatedTask = await this.store.getTask(task.id);
            // FNXC:Workspace 2026-06-21-23:30: KTD1 — per-repo post-session capture.
            // The singular call below runs UNGATED with worktreePath = the browse-only non-git workspace root and silently returns [] (resolveDiffBaseRef swallows the git failure at the root). In workspace mode there is nothing to diff at the root; the real changes live in each acquired sub-repo worktree. So we ADD (not replace) a workspace branch that loops `task.workspaceWorktrees` and reuses the EXISTING captureModifiedFiles per repo — reusing it (rather than hand-building `git diff <base>..HEAD`) gives us the merge-base fallback for an undefined repo.baseCommitSha (resolveDiffBaseRef) AND restores the contamination/divergence audit (filterFilesToOwnTaskCommits) for free per repo. Returned files are repo-prefixed (e.g. `repo-a/src/foo.ts`) and aggregated into task.modifiedFiles.
            if (this.workspaceConfig) {
              const workspaceWorktrees = updatedTask.workspaceWorktrees ?? {};
              const aggregated = await this.captureWorkspaceModifiedFiles(updatedTask, audit, "post-session");
              for (const [repoRel, repo] of Object.entries(workspaceWorktrees)) {
                // Per-repo branch-attribution audit (cwd = sub-repo). Run against repo.worktreePath/repo.branch, NOT the non-git root (a root call would fail and surface nothing). The contamination signal already rides on captureWorkspaceModifiedFiles above; this is the supplementary commit-attribution surface (FN-5233 pattern).
                try {
                  const attributionBase = await resolveContaminationBaseRef(repo.worktreePath);
                  if (attributionBase && repo.branch) {
                    const attribution = await reportBranchAttribution(repo.worktreePath, repo.branch, attributionBase, task.id);
                    const hasAnomaly = attribution.foreign.length > 0 || attribution.unattributed.length > 0 || attribution.ownUntrailed.length > 0;
                    if (hasAnomaly) {
                      const summary = `branch-attribution anomalies on ${repoRel}@${repo.branch}: foreign=${attribution.foreign.length}, unattributed=${attribution.unattributed.length}, ownUntrailed=${attribution.ownUntrailed.length}, ownTrailed=${attribution.ownTrailed}`;
                      executorLog.warn(`${task.id}: ${summary}`);
                      await this.store.logEntry(task.id, `[branch-attribution] ${summary}`, undefined, this.getRunContextFor(task.id));
                      await audit.git({
                        type: "branch:attribution-anomaly",
                        target: repo.branch,
                        metadata: {
                          taskId: task.id,
                          repo: repoRel,
                          baseSha: attributionBase,
                          ownTrailed: attribution.ownTrailed,
                          foreign: attribution.foreign,
                          unattributed: attribution.unattributed,
                          ownUntrailed: attribution.ownUntrailed,
                        },
                      });
                    }
                  }
                } catch (attributionErr: unknown) {
                  executorLog.warn(`${task.id}: post-session per-repo branch-attribution audit failed for ${repoRel}: ${attributionErr instanceof Error ? attributionErr.message : String(attributionErr)}`);
                }
              }
              if (aggregated.length > 0) {
                await this.store.updateTask(task.id, { modifiedFiles: aggregated });
                executorLog.log(`${task.id}: captured ${aggregated.length} modified files across ${Object.keys(workspaceWorktrees).length} sub-repo(s)`);
                await audit.filesystem({ type: "file:capture-modified", target: task.id, metadata: { files: aggregated } });
              }
            } else {
            const modifiedFiles = await this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha, task.id, audit, "post-session");
            if (modifiedFiles.length > 0) {
              await this.store.updateTask(task.id, { modifiedFiles });
              executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
              // Audit trail: record filesystem mutation (FN-1404)
              await audit.filesystem({ type: "file:capture-modified", target: task.id, metadata: { files: modifiedFiles } });
            }

            // Post-session branch attribution audit: walk base..branch and surface
            // any commit that's foreign (different FN-id), unattributed (no subject
            // tag AND no Fusion-Task-Id trailer), or own-but-untrailed (signals the
            // commit-msg hook didn't fire — typically a worktree without identity
            // guards or a plumbing-driven commit). Logged loudly so contamination
            // gets caught within minutes of happening rather than days later at
            // merge time (FN-5233 was this pattern).
            try {
              const attributionBase = await resolveContaminationBaseRef(worktreePath);
              if (attributionBase && updatedTask.branch) {
                const attribution = await reportBranchAttribution(this.rootDir, updatedTask.branch, attributionBase, task.id);
                const hasAnomaly = attribution.foreign.length > 0 || attribution.unattributed.length > 0 || attribution.ownUntrailed.length > 0;
                if (hasAnomaly) {
                  const summary = `branch-attribution anomalies on ${updatedTask.branch}: foreign=${attribution.foreign.length}, unattributed=${attribution.unattributed.length}, ownUntrailed=${attribution.ownUntrailed.length}, ownTrailed=${attribution.ownTrailed}`;
                  executorLog.warn(`${task.id}: ${summary}`);
                  await this.store.logEntry(task.id, `[branch-attribution] ${summary}`, undefined, this.getRunContextFor(task.id));
                  await audit.git({
                    type: "branch:attribution-anomaly",
                    target: updatedTask.branch,
                    metadata: {
                      taskId: task.id,
                      baseSha: attributionBase,
                      ownTrailed: attribution.ownTrailed,
                      foreign: attribution.foreign,
                      unattributed: attribution.unattributed,
                      ownUntrailed: attribution.ownUntrailed,
                    },
                  });
                }
              }
            } catch (attributionErr: unknown) {
              executorLog.warn(`${task.id}: post-session branch-attribution audit failed: ${attributionErr instanceof Error ? attributionErr.message : String(attributionErr)}`);
            }
            } // end !this.workspaceConfig singular capture (FNXC:Workspace KTD1)

            this.scheduleCompletedTaskWatchdog(task.id, "step-session completion");
            if (await this.shouldDeferCompletionForGlobalPause(task.id, "before workflow steps after step-session completion")) {
              return;
            }

            // ── Deterministic verification gate (FN-3345) ──────────
            // Run testCommand/buildCommand after all steps succeed but BEFORE
            // workflow steps and the in-review transition. Skipped in fast mode
            // and when no verification commands are configured.
            if (executionMode !== "fast") {
              if (settings.testCommand?.trim() || settings.buildCommand?.trim()) {
                const verificationResult = await this.runExecutorDeterministicVerification(task, worktreePath, settings, taskEnv);

                if (!verificationResult.allPassed) {
                  const failedType = verificationResult.failedCommand === "testCommand" ? "test" : "build";
                  const failedResult = failedType === "test" ? verificationResult.testResult! : verificationResult.buildResult!;
                  const failedCommand = failedResult.command;
                  const failureOutput = failedResult.stderr || failedResult.stdout || "Unknown error";
                  const summary = summarizeVerificationOutput(failureOutput, failedType);

                  executorLog.log(`${task.id}: [verification] ${failedType} failed — attempting fix agent`);
                  await this.store.logEntry(
                    task.id,
                    `[verification] ${failedType} command failed (exit ${failedResult.exitCode}). Attempting fix agent...`,
                    summary,
                    this.getRunContextFor(task.id),
                  );

                  const maxFixRetries = Math.min(settings.verificationFixRetries ?? 3, 3);

                  if (maxFixRetries === 0) {
                    executorLog.log(`${task.id}: [verification] fix retries set to 0 — sending task back immediately`);
                    await this.sendTaskBackForFix(
                      task, worktreePath,
                      `${failedType} command \`${failedCommand}\` failed (exit ${failedResult.exitCode}):\n${summary}`,
                      `Verification (${failedType})`,
                      `Deterministic verification failed (${failedType})`,
                      true,
                      true,
                    );
                    return;
                  }

                  let fixSucceeded = false;
                  for (let attempt = 1; attempt <= maxFixRetries; attempt++) {
                    const fixed = await this.attemptExecutorVerificationFix(
                      task, worktreePath,
                      {
                        command: failedCommand,
                        exitCode: failedResult.exitCode,
                        output: failureOutput,
                        type: failedType,
                      },
                      settings,
                      attempt,
                      maxFixRetries,
                      taskEnv,
                    );
                    if (fixed) {
                      fixSucceeded = true;
                      executorLog.log(`${task.id}: [verification] fix agent succeeded on attempt ${attempt}/${maxFixRetries}`);
                      await this.store.logEntry(
                        task.id,
                        `[verification] Fix agent succeeded on attempt ${attempt}/${maxFixRetries}. Verification now passing.`,
                        undefined,
                        this.getRunContextFor(task.id),
                      );
                      break;
                    }
                    executorLog.log(`${task.id}: [verification] fix agent attempt ${attempt}/${maxFixRetries} failed`);
                    await this.store.logEntry(
                      task.id,
                      `[verification] Fix agent attempt ${attempt}/${maxFixRetries} failed`,
                      undefined,
                      this.getRunContextFor(task.id),
                    );
                  }

                  if (!fixSucceeded) {
                    executorLog.log(`${task.id}: [verification] all fix attempts exhausted (${maxFixRetries}/${maxFixRetries}) — sending task back`);
                    await this.sendTaskBackForFix(
                      task, worktreePath,
                      `${failedType} command \`${failedCommand}\` failed (exit ${failedResult.exitCode}) after ${maxFixRetries} fix attempts:\n${summary}`,
                      `Verification (${failedType})`,
                      `Deterministic verification failed after ${maxFixRetries} fix attempts`,
                      true,
                      true,
                    );
                    return;
                  }
                }
              }
            }

            // FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2/KTD-5) — workflow
            // steps are graph-owned. For a graph-driven run the execute seam
            // registered a completion interceptor; stop at the
            // implementation-complete boundary and hand the remaining lifecycle
            // (workflow gates → review → merge) back to the graph runner, which
            // records results into task.workflowStepResults (U2). The legacy
            // runWorkflowSteps loop was deleted. A NON-graph run reaching here has no
            // enabled workflow steps to run (a minimal store WITH enabled steps is
            // parked fail-closed inside executeWorkflowGraph, KTD-5), so there
            // is nothing to gate before the in-review handoff.
            this.clearCompletedTaskWatchdog(task.id);
            executorLog.log(`✓ ${task.id} implementation complete — graph interpreter owns the remaining lifecycle`);
            const liveModified = (await this.store.getTask(task.id).catch(() => task)).modifiedFiles ?? [];
            reportImplementationExit?.("complete-from-live-files");
            graphCompletion({ modifiedFiles: liveModified });
            return;
          } else {
            const failedSteps = results.filter(r => !r.success);
            const errorSummary = failedSteps.map(r => `Step ${r.stepIndex}: ${r.error || "unknown error"}`).join("; ");
            await this.store.updateTask(task.id, { status: null, error: null });
            await this.store.logEntry(task.id, `Step-session failed — requeued for execution resume: ${errorSummary}`, undefined, this.getRunContextFor(task.id));
            this.markGraphExecuteSelfRequeued(task.id);
            await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
            executorLog.log(`✗ ${task.id} step-session failed → todo resume: ${errorSummary}`);
            this.options.onError?.(task, new Error(errorSummary));
          }
        };

        const retryableStepWork = () => withRateLimitRetry(stepWork, {
          signal: this.activeWorkflowGraphAbortControllers.get(task.id)?.signal,
          rotation: this.options.credentialRotator && activeStepInstanceRef ? {
            providerId: activeStepInstanceRef.providerId,
            nextInstance: nextStepInstance,
          } : undefined,
          onRetry: (attempt, delayMs, error) => {
            const delaySec = Math.round(delayMs / 1000);
            executorLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
            this.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`, undefined, this.getRunContextFor(task.id)).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              executorLog.warn(`${task.id} failed to log rate-limit retry: ${msg}`);
            });
          },
        });

        try {
          await this.runWithExecutorSemaphore(task.id, retryableStepWork);
          if (stepDispatchedRotation) stepRotationEvent?.recordOutcome("rotation-succeeded");
        } catch (err: unknown) {
          const { message: errorMessage, detail: errorDetail, stack: errorStack } = formatError(err);
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
          } else if (this.pausedAborted.has(task.id)) {
            if (this.userCanceledTaskIds.has(task.id)) {
              this.clearPausedAborted(task.id);
              this.stuckAborted.delete(task.id);
              this.userCanceledTaskIds.delete(task.id);
              await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            if (await this.parkApprovalSuspension(task.id, "step session")) return;
            this.clearPausedAborted(task.id);
            await this.store.logEntry(task.id, "Execution paused during step-session", undefined, this.getRunContextFor(task.id));
            this.markGraphExecuteSelfRequeued(task.id);
            await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveResumeState: true });
          } else if (this.stuckAborted.has(task.id)) {
            stuckRequeue = this.stuckAborted.get(task.id) ?? true;
            this.stuckAborted.delete(task.id);
          } else if (this.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
            await this.options.usageLimitPauser.onUsageLimitHit("executor", task.id, errorMessage);
          } else if (isTransientError(errorMessage)) {
            const decision = computeRecoveryDecision({
              recoveryRetryCount: task.recoveryRetryCount,
              nextRecoveryAt: task.nextRecoveryAt,
            });

            if (decision.shouldRetry) {
              const attempt = decision.nextState.recoveryRetryCount;
              const delay = formatDelay(decision.delayMs);
              if (!isSilentTransientError(errorMessage)) {
                executorLog.warn(`⚡ ${task.id} transient error — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
                await this.store.logEntry(task.id, `Transient error (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, this.getRunContextFor(task.id));
              }
              if (worktreePath && existsSync(worktreePath)) {
                try {
                  const settings = await this.store.getSettings();
                  await removeWorktree({
                    worktreePath,
                    rootDir: this.rootDir,
                    settings,
                    taskId: task.id,
                    audit,
                    reason: RemovalReason.ExecutorTransientRetry,
                    expectedOwnerTaskId: task.id,
                    liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
                  });
                } catch (wtErr: unknown) {
                  const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
                  executorLog.warn(`${task.id}: worktree removal failed during transient-error retry cleanup (${worktreePath}): ${msg}`);
                }
              }
              await this.store.updateTask(task.id, {
                recoveryRetryCount: decision.nextState.recoveryRetryCount,
                nextRecoveryAt: decision.nextState.nextRecoveryAt,
                worktree: null,
                branch: null,
              });
              this.markGraphExecuteSelfRequeued(task.id);
              await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveProgress: true });
              stuckRequeue = null; // Prevent outer finally from re-processing
              return;
            }

            executorLog.error(`✗ ${task.id} transient error retries exhausted: ${errorDetail}`);
            if (errorStack) {
              await this.store.logEntry(task.id, `Transient error retries exhausted: ${errorMessage}`, errorStack, this.getRunContextFor(task.id));
            }
            await this.store.updateTask(task.id, {
              status: "failed",
              error: errorMessage,
              recoveryRetryCount: null,
              nextRecoveryAt: null,
            });
            if (accumulatedStepTokenUsage) {
              await this.persistTaskTokenUsage(task.id, accumulatedStepTokenUsage);
            }
            executorLog.log(`✗ ${task.id} transient retries exhausted — failed in execution`);
            this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          } else {
            if (accumulatedStepTokenUsage) {
              await this.persistTaskTokenUsage(task.id, accumulatedStepTokenUsage);
            }
            if (await this.handleNonContinuableSessionError(task, false, errorMessage)) {
              return;
            }
            executorLog.error(`✗ ${task.id} step-session execution failed:`, errorDetail);
            await this.store.logEntry(task.id, `Step-session execution failed: ${errorMessage}`, errorStack ?? errorDetail, this.getRunContextFor(task.id));
            await this.store.updateTask(task.id, { status: null, error: null });
            this.markGraphExecuteSelfRequeued(task.id);
            await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
            executorLog.log(`✗ ${task.id} step-session execution failed → todo resume`);
            this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          }
        } finally {
          this.executing.delete(task.id);
          executingTaskLock.release(task.id);
          this.loopRecoveryState.delete(task.id);
          // Wrap cleanup in try/catch so activeStepExecutors.delete() always runs.
          // If cleanup() throws, the executor continues to clean up the in-memory map
          // and requeue logic without leaking the reference.
          try {
            await stepExecutor.cleanup();
          } catch (cleanupErr) {
            executorLog.warn(`StepSessionExecutor cleanup failed for ${task.id}: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
          }
          this.deleteActiveStepExecutor(task.id);

          // Stuck-requeue: clean up worktree and move to todo
          if (stuckRequeue === true) {
            try {
              // Re-read latest task state. Self-healing may have already moved
              // the task out of in-progress while this step-session execution
              // was unwinding; continuing the cleanup would clobber a valid
              // recovery (see the analogous block in the outer finally for the
              // full reasoning).
              /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet: stuck-requeue family): "has a
                 concurrent recovery already moved this card on?" — the pre-completion lanes are the board's
                 wip and hold. With literals a renamed board always answered "moved on", the cleanup never
                 ran, and the log line blamed a concurrent recovery that had not happened. */
              const latestTask = await this.store.getTask(task.id);
              const requeueLanes = await this.resolveResumeLanes(task.id);
              if (latestTask.column !== requeueLanes.wip && latestTask.column !== requeueLanes.hold) {
                executorLog.log(
                  `${task.id} stuck-requeue skipped — task is now in '${latestTask.column}' (recovered concurrently)`,
                );
              } else {
                const settings = await this.store.getSettings();
                const preserveProgress = settings.preserveProgressOnStuckRequeue !== false;

                /*
                FNXC:StuckRequeue 2026-06-27-23:15:
                Stuck requeue may destroy a checkout that contains only uncommitted step output. Always reconcile lost-work step state before worktree removal, even when preserve-progress is enabled, so a retry cannot skip code that no longer exists.
                */
                await this.resetStepsIfWorkLost(latestTask);

                if (worktreePath && existsSync(worktreePath)) {
                  try {
                    await removeWorktree({
                      worktreePath,
                      rootDir: this.rootDir,
                      settings,
                      taskId: task.id,
                      reason: RemovalReason.ExecutorStuckKilled,
                      expectedOwnerTaskId: task.id,
                      liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
                    });
                  } catch (wtErr: unknown) {
                    const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
                    executorLog.warn(`${task.id}: worktree removal failed during stuck-requeue cleanup (${worktreePath}): ${msg}`);
                  }
                }
                await this.store.updateTask(task.id, {
                  status: "queued",
                  error: null,
                  worktree: null,
                  branch: null,
                });
                const reboundColumn = await resolveReboundColumnFor(this.store, task.id);
                if (latestTask.column !== reboundColumn) {
                  this.markGraphExecuteSelfRequeued(task.id);
                  await this.store.moveTask(task.id, reboundColumn, preserveProgress ? { preserveProgress: true } : undefined);
                  executorLog.log(`${task.id} moved to ${reboundColumn} for retry after stuck kill${preserveProgress ? " (progress preserved)" : ""}`);
                }
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              executorLog.error(`Failed to requeue stuck task ${task.id}: ${errorMessage}`);
            }
            stuckRequeue = null; // Prevent outer finally from re-processing
          }
        }
        // Step-session path handled completely — return before outer catch/finally
        return;
      }

      // ── Single-Session Path (default) ────────────────────────────────
      // Build custom tools for the worker
      // Track the last code review verdict per step so we can enforce REVISE
      // (block fn_task_update status="done" until the agent re-reviews and gets APPROVE).
      // Keyed by the canonical 0-indexed step number used by PROMPT.md headings.
      const codeReviewVerdicts = new Map<number, ReviewVerdict>();

      let wasPaused = false;
      // Mutable ref — populated after createFnAgent, tools access lazily via closure
      const sessionRef: { current: AgentSession | null } = { current: null };
      /*
      FNXC:ReviewerProviderErrors 2026-07-19-02:30:
      DELETED (U10/R9): the deferred provider-error re-raise channel (`reviewerFatalRef`) and the
      per-step conversation checkpoint map (`stepCheckpoints`, the RETHINK rewind target) existed
      only to serve the legacy in-session `fn_review_step` tool. Both die with it. Graph-owned
      review nodes run on their own session and can throw directly, and a RETHINK is a graph edge
      rather than an in-conversation `navigateTree` rewind — so neither mechanism has a caller.
      Do not re-introduce a tool-handler-deferred error channel here: it only ever existed because
      pi-agent-core converts a tool throw into a `tool_error` result the model reads and retries.
      */

      const stuckDetector = this.options.stuckTaskDetector;
      const assignedAgentId = detail.assignedAgentId?.trim();
      const reflectionTools = this.options.reflectionService && settings.reflectionEnabled && assignedAgentId
        ? [createReflectOnPerformanceTool(this.options.reflectionService, assignedAgentId)]
        : [];
      const assignedAgent = await this.getAuthoritativeAssignedAgent(assignedAgentId);

      // Column-agent SESSION IDENTITY (U4, R2/R3/R4/R8): when the governing execute
      // seam node's declared column binds an agent that supersedes the task's
      // assigned agent, the coding session's MODEL, runtime hint, persona, and
      // memory tools adopt the column agent. The core resolver decides defer vs
      // override (KTD-2); a missing agent logs + falls back (R8). No binding →
      // `columnAgentSeam` is undefined and every line below is byte-identical to the
      // assigned-agent path (characterization parity). Gating contexts key off
      // `identityAgent` — the effective column agent when a binding governs, else
      // the assigned agent (U5/KTD-3 principal substitution).
      const columnAgentSeam = await this.resolveSeamColumnAgent(task, detail);
      const identityAgent = columnAgentSeam?.agent ?? assignedAgent;
      const executorRuntimeHint = extractRuntimeHint(identityAgent?.runtimeConfig);
      // U5 (R6): track the effective column-agent principal so the heartbeat
      // scheduler's reverse guard knows this agent is executing a task it may not
      // be assigned to. Cleared in deleteActiveSession.
      if (columnAgentSeam?.agent) {
        this.effectiveColumnAgentByTask.set(task.id, columnAgentSeam.agent.id);
      }

      // Log fast mode status
      if (executionMode === "fast") {
        executorLog.debug(`${task.id}: fast mode`);
      }

      /*
      FNXC:TaskVerificationRequest 2026-07-30-00:00:
      Chat can only enqueue a server-resolved profile. The executor owns the live
      worktree, so it claims and runs that request here through the existing bounded
      runner (which acquires withVerificationSlot); no chat-side subprocess exists.
      */
      let verificationRequestInFlight = false;
      const runPendingTaskVerification = async (): Promise<void> => {
        if (verificationRequestInFlight) return;
        const pendingVerification = await this.store.getTaskVerificationRequestAsync(task.id);
        if (pendingVerification?.status !== "requested") return;
        verificationRequestInFlight = true;
        try {
          const claimedVerification = await this.store.claimTaskVerificationRequest(task.id, pendingVerification.requestId);
          if (!claimedVerification) return;
          const startedAt = Date.now();
          try {
            const verificationResult = await runTaskVerificationCommand({
              command: claimedVerification.command,
              cwd: worktreePath,
              timeoutMs: settings.verificationCommandTimeoutMs ?? 300_000,
              onHeartbeat: () => stuckDetector?.recordActivity(task.id),
            });
            await this.store.finishTaskVerificationRequest(task.id, claimedVerification.requestId, verificationResult.success ? "passed" : "failed", {
              success: verificationResult.success, exitCode: verificationResult.exitCode,
              durationMs: Date.now() - startedAt, timedOut: verificationResult.timedOut ?? false,
              stdoutTail: verificationResult.stdout.slice(-8_000), stderrTail: verificationResult.stderr.slice(-8_000),
            });
          } catch (error) {
            await this.store.finishTaskVerificationRequest(task.id, claimedVerification.requestId, "failed", undefined, error instanceof Error ? error.message.slice(0, 1_000) : "Verification runner failed");
          }
        } finally {
          verificationRequestInFlight = false;
        }
      };
      await runPendingTaskVerification();

      /*
      FNXC:EphemeralAgentTaskCreation 2026-07-26-06:20:
      A `deny` project policy removes fn_task_create from the session's tool list instead of
      registering a tool that only refuses at execute time; see isAgentTaskCreateToolAvailable.

      FNXC:EphemeralAgentTaskCreation 2026-07-26-07:40:
      fn_delegate_task is withheld by the same policy (it creates a task through the same
      primitive), and the suppression emits a run-audit event. Without the event an operator
      cannot distinguish "the policy suppressed the tool" from "the agent had nothing to file" —
      every other policy decision in this engine leaves that trail.
      */
      const executionCallerIsEphemeral = !identityAgent || isEphemeralAgent(identityAgent);
      const taskCreateWithheld = !isAgentTaskCreateToolAvailable(settings, executionCallerIsEphemeral);
      const delegateWithheld = !isAgentDelegateTaskToolAvailable(settings, executionCallerIsEphemeral);
      if (taskCreateWithheld || delegateWithheld) {
        await this.store.recordRunAuditEvent?.({
          taskId: task.id,
          agentId: identityAgent?.id ?? "executor",
          runId: this.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("task-create-withheld", task.id),
          domain: "database",
          mutationType: "agent:task-create-withheld",
          target: task.id,
          metadata: {
            taskId: task.id,
            policy: resolveEphemeralTaskCreationPolicy(settings),
            withheldTaskCreate: taskCreateWithheld,
            withheldDelegateTask: delegateWithheld,
            lane: "execution-session",
          },
        }).catch(() => undefined);
      }
      /*
      FNXC:AgentProvisioningGate 2026-07-26-13:20:
      fn_agent_create / fn_agent_delete previously received no options in the executor lane,
      which made the factory synthesize approvalMode "never" and disabled the provisioning
      approval gate in production. Pass a live settingsProvider plus the shared
      PostgreSQL-backed ApprovalRequestStore when the async layer exists; without a layer we
      pass no approval store so the factory fails CLOSED (require-approval => DENY).
      */
      const provisioningApprovalLayer = typeof this.store.getAsyncLayer === "function" ? this.store.getAsyncLayer() : null;
      const agentProvisioningToolOptions = {
        settingsProvider: async () => await this.store.getSettings(),
        ...(provisioningApprovalLayer ? { approvalRequestStore: this.approvalRequestStore } : {}),
      };
      const customTools = [
        this.createTaskUpdateTool(task.id, codeReviewVerdicts, sessionRef, stuckDetector),
        this.createTaskLogTool(task.id),
        this.createTaskLogsReadTool(task.id),
        ...(taskCreateWithheld
          ? []
          : [this.createTaskCreateTool(executionCallerIsEphemeral, task.id, identityAgent?.id)]),
        this.createTaskAddDepTool(task.id),
        this.createTaskDoneTool(task.id, worktreePath, detail.prompt ?? "", codeReviewVerdicts, () => { taskDone = true; }, audit),
        createRunVerificationTool({
          worktreePath,
          rootDir: this.rootDir,
          taskId: task.id,
          recordActivity: () => stuckDetector?.recordActivity(task.id),
          verificationCommandTimeoutMs: settings.verificationCommandTimeoutMs,
          onVerificationStart: (timeoutMs) => stuckDetector?.beginVerification(task.id, timeoutMs),
          onVerificationEnd: () => stuckDetector?.endVerification(task.id),
          log: {
            info: (s) => executorLog.log(s),
            debug: (s) => executorLog.debug(s),
            warn: (s) => executorLog.warn(s),
            error: (s) => executorLog.warn(s),
          },
        }),
        /*
        FNXC:WorkflowReviewGates 2026-07-19-02:30:
        U10 (R9): the legacy in-session `fn_review_step` tool is DELETED. Plan/code/browser
        review gates are owned exclusively by workflow-graph nodes, so an implementation
        session never spawns its own reviewer. Nothing is injected here; the entry is kept
        as a tombstone marker so a future reader does not re-add a second review authority.
        */
        this.createSpawnAgentTool(task.id, worktreePath, settings, taskEnv),
        this.createTaskDocumentWriteTool(task.id),
        this.createTaskDocumentReadTool(task.id),
        // FNXC:FileScope 2026-07-08-22:40: let the coding agent extend its own declared ## File Scope at runtime (fn_task_file_scope_add) so edits beyond the initial scope are not stranded by the scope-aware squash merge.
        this.createTaskFileScopeAddTool(task.id),
        this.createArtifactListTool(),
        this.createArtifactViewTool(),
        /*
        FNXC:ArtifactRegistry 2026-07-10-14:30:
        fn_artifact_register was previously gated on assignedAgentId, but default ephemeral mode never
        sets assignedAgentId on in-progress tasks — so executor agents never had the register tool at
        all and agent-produced screenshots/wireframes could not reach the Artifacts gallery. Always
        expose it, attributing ephemeral runs to the established "executor" fallback author.
        */
        this.createArtifactRegisterTool(assignedAgentId ?? "executor", task.id, worktreePath),
        this.createWorkflowListTool(),
        this.createWorkflowGetTool(),
        this.createWorkflowValidateTool(),
        this.createWorkflowSelectTool(task.id),
        this.createTaskPromoteTool(task.id),
        this.createWorkflowCreateTool(),
        this.createWorkflowUpdateTool(),
        this.createWorkflowDeleteTool(),
        this.createWorkflowSettingsTool(),
        this.createTraitListTool(),
        ...(isResearchToolSurfaceEnabled(settings)
          ? createResearchTools({
            store: this.store,
            rootDir: this.rootDir,
            getSettings: async () => this.store.getSettings(),
          })
          : []),
        ...createMissionTools(this.store, {
          agentId: engineRunContext.agentId,
          agentName: identityAgent?.name,
        }),
        ...createIdeationTools(this.store),
        ...createGoalRetrievalTools(this.store, {
          runContext: {
            runId: engineRunContext.runId,
            agentId: engineRunContext.agentId,
          },
          taskId: task.id,
        }),
        createWebFetchTool(),
        ...createMemoryTools(this.rootDir, settings, identityAgent ? {
          agentMemory: {
            agentId: identityAgent.id,
            agentName: identityAgent.name,
            memory: identityAgent.memory,
          },
        } : undefined),
        // Conditionally add agent self-reflection when enabled and task has an assigned agent.
        ...reflectionTools,
        // Agent delegation tools — discover and delegate work to other agents.
        ...(this.options.agentStore ? [
          createListAgentsTool(this.options.agentStore),
          ...(delegateWithheld
            ? []
            : [createDelegateTaskTool(this.options.agentStore, this.store, { rootDir: this.rootDir, sourceTaskId: task.id, sourceAgentId: assignedAgentId, callerIsEphemeral: executionCallerIsEphemeral })]),
          createTaskAssignTool(this.options.agentStore, this.store),
          ...(assignedAgentId ? [
            createGetAgentConfigTool(this.options.agentStore, assignedAgentId),
            createUpdateAgentConfigTool(this.options.agentStore, assignedAgentId),
            createAgentCreateTool(this.options.agentStore, assignedAgentId, agentProvisioningToolOptions),
            createAgentDeleteTool(this.options.agentStore, assignedAgentId, agentProvisioningToolOptions),
          ] : []),
        ] : []),
        // Messaging tools — allows executor agents to send and receive messages.
        ...(this.options.messageStore && assignedAgentId ? [
          createSendMessageTool(this.options.messageStore, assignedAgentId, { autoRecovery: settings.autoRecovery, runAudit: audit, taskStore: this.store, settings, agentStore: this.options.agentStore }),
          createReadMessagesTool(this.options.messageStore, assignedAgentId),
        ] : []),
        // Add plugin tools from PluginRunner
        ...getEnabledPluginTools(this.options.pluginRunner),
      ];

      if (this.workspaceConfig && this.workspaceConfig.repos.length > 0) {
        customTools.push(createAcquireRepoWorktreeTool({
          workspaceRootDir: this.rootDir,
          workspaceRepos: this.workspaceConfig.repos,
          task,
          store: this.store,
          settings,
          logger: executorLog,
          secretsStore: this.options.secretsStore,
          runContext: engineRunContext,
          audit,
          // FNXC:Workspace 2026-06-21-22:30: F2 — register each freshly-acquired sub-repo worktree path in this task's activeWorktrees Set (KTD2) so owner/liveness checks see live per-repo worktrees, not just the browse-only root.
          onAcquired: (worktreePath: string) => this.addActiveWorktree(task.id, worktreePath),
          taskEnv,
          // FNXC:Workspace 2026-06-22 — forward the configured worktree-init runner so sub-repo worktrees run configured setup.
          runConfiguredCommand: (command, cwd, timeoutMs, env) =>
            runConfiguredCommand(command, cwd, timeoutMs, env, audit),
        }));
      }

      // Accumulates the full assistant text output for the most recent session.
      // Reset to "" each time a new session begins so detectPseudoPause only
      // sees the last session's output, not the entire conversation history.
      let lastAssistantText = "";

      const agentLogger = new AgentLogger({
        store: this.store,
        taskId: task.id,
        agent: "executor",
        persistAgentToolOutput: settings.persistAgentToolOutput,
        // Executor sessions are task-scoped ephemeral workers.
        persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
        onAgentText: (taskId, delta) => {
          lastAssistantText += delta;
          stuckDetector?.recordActivity(taskId);
          this.options.onAgentText?.(taskId, delta);
        },
        onAgentTool: (taskId, toolName, detail) => {
          /*
          FNXC:StuckDetector 2026-07-22-18:05:
          Tool heartbeats carry name+detail fingerprints so the stuck detector can distinguish
          legitimate iterative single-step work from repetitive thrash loops.

          FNXC:StuckDetector 2026-07-22-19:25:
          Forward `detail` to options.onAgentTool so external telemetry keeps the full
          fingerprint contract (CodeRabbit on PR #2404).
          */
          stuckDetector?.recordActivity(taskId, { toolName, toolDetail: detail });
          this.options.onAgentTool?.(taskId, toolName, detail);
        },
        // FNXC:PlannerOversight 2026-07-13-23:05: live session-advisor delta path (fail-soft).
        onEntriesFlushed: (taskId, entries) => {
          try {
            this.options.onExecutorLogFlushed?.(taskId, entries);
          } catch {
            /* ignore */
          }
        },
      });

      let agentRotationEvent: import("./credential-instance-rotation.js").RotationEvent | undefined;
      let agentRotationDeclined = false;
      let agentDispatchedRotation = false;
      let activeAgentInstanceRef: ProviderInstanceRef | undefined;

      const agentWork = async () => {
        // Resolve model settings using canonical lane hierarchy:
        // 1. Task override pair (modelProvider + modelId)
        // 2. Project execution lane pair (executionProvider + executionModelId)
        // 3. Global execution lane pair (executionGlobalProvider + executionGlobalModelId)
        // 4. Project default override pair (defaultProviderOverride + defaultModelIdOverride)
        // 5. Global default pair (defaultProvider + defaultModelId)
        // Column-agent session identity (U4): the model precedence input is the
        // EFFECTIVE identity agent's runtimeConfig (column agent when it governs,
        // else the assigned agent — byte-identical no-binding path).
        /*
        FNXC:ColumnAgentModel 2026-06-27-11:24:
        Override column agents own initial session model selection as well as mid-flight re-resolution. Ignore task-level modelProvider/modelId before resolveExecutorSessionModel so pre-existing task model pairs cannot run the column-agent identity on the task model.
        */
        const overrideColumnGovernsInitialSession = columnAgentSeam?.mode === "override";
        const executorSessionModel = resolveExecutorSessionModel(
          overrideColumnGovernsInitialSession ? undefined : detail.modelProvider,
          overrideColumnGovernsInitialSession ? undefined : detail.modelId,
          settings,
          (identityAgent?.runtimeConfig ?? undefined) as Record<string, unknown> | undefined,
          overrideColumnGovernsInitialSession ? undefined : activeAgentInstanceRef?.instanceId ?? detail.credentialInstanceId,
        );
        const { provider: executorProvider, modelId: executorModelId } = executorSessionModel;
        /*
        FNXC:ProviderAuth 2026-08-03-17:35:
        Keep a synthetic "default" ref only for credential-rotation bookkeeping (startingInstanceId).
        Never force that synthetic id into createResolvedAgentSession: chat omits unset instance ids
        and custom providers authenticate via customProviders.apiKey. Passing "default" required an
        auth.json default instance and failed step-execute while chat with the same model worked.
        After a usage-limit rotation, agentDispatchedRotation is true and the offered instance is real.
        */
        activeAgentInstanceRef ??= executorProvider
          ? { providerId: executorProvider, instanceId: executorSessionModel.credentialInstanceId ?? DEFAULT_PROVIDER_INSTANCE_ID }
          : undefined;
        const sessionCredentialInstanceId = agentDispatchedRotation
          ? activeAgentInstanceRef?.instanceId
          : executorSessionModel.credentialInstanceId;
        const { provider: executorFallbackProvider, modelId: executorFallbackModelId } = resolveExecutorFallbackModel(settings);
        const executorSessionThinkingSource = this.graphSeamThinkingLevel.get(task.id) ?? detail.thinkingLevel;
        const executorThinkingLevel = resolveExecutorThinkingLevel(executorSessionThinkingSource, settings);
        const executorFallbackThinkingLevel = resolveExecutorFallbackThinkingLevel(executorSessionThinkingSource, settings);

        // U1 telemetry: now that the session model/provider/node are resolved,
        // give the agent logger the context it needs to emit usage_events tool
        // rows (KTD3). nodeId is sourced from the routed/effective node, null
        // when the task has no node context.
        agentLogger.setUsageContext({
          model: executorModelId ?? null,
          provider: executorProvider ?? null,
          nodeId: detail.effectiveNodeId ?? detail.nodeId ?? null,
          agentId: engineRunContext.agentId ?? null,
        });

        // Determine whether we're resuming a previous session (pause/resume)
        // or starting fresh. Use file-based sessions so conversation state
        // persists across pause/unpause cycles. Resume is allowed only when
        // persisted session metadata still matches the task's live worktree.
        let isResuming = !!task.sessionFile && existsSync(task.sessionFile);
        if (isResuming) {
          const persistedWorktreePath = await extractPersistedSessionWorktreePath(task.sessionFile!, this.rootDir, settings);
          if (!isSessionWorktreeCompatible(persistedWorktreePath, worktreePath)) {
            executorLog.warn(
              `${task.id}: stale sessionFile worktree mismatch (session=${persistedWorktreePath}, task=${worktreePath}); starting fresh session`,
            );
            await this.store.logEntry(
              task.id,
              `Detected stale persisted session metadata (worktree mismatch: ${persistedWorktreePath} vs ${worktreePath}) — discarded resume state and started fresh session`,
              undefined,
              this.getRunContextFor(task.id),
            );
            await this.store.updateTask(task.id, { sessionFile: null });
            isResuming = false;
          }
        }

        const sessionManager = isResuming
          ? SessionManager.open(task.sessionFile!)
          : SessionManager.create(worktreePath);

        executorLog.debug(`${task.id}: creating agent session (provider=${executorProvider ?? "default"}, model=${executorModelId ?? "default"}, resuming=${isResuming})`);

        // Resolve per-agent custom instructions for the executor role.
        // Column-agent session identity (U4, R3/KTD-6): when a column agent governs,
        // its TYPED persona (soul/instructionsText, via buildAgentPersona — the same
        // source the custom-node path uses) supersedes the role-resolved executor
        // instructions, so the coding session speaks AS the column agent. No binding
        // → role instructions unchanged (characterization parity).
        const columnAgentPersona = columnAgentSeam ? buildAgentPersona(columnAgentSeam.agent) : undefined;
        const executorInstructions = columnAgentPersona
          ?? (await this.resolveInstructionsForRole("executor", settings));

        // Build structured layers for cross-session prompt caching.
        const executorPluginContributions = await buildPluginPromptSection(
          "executor-system",
          this.options.pluginRunner,
        );
        if (executorPluginContributions) {
          executorLog.debug(`${task.id}: applied plugin prompt contributions for executor-system surface`);
        }

        const executorGoalResolution = await resolveAndEmitGoalContext({
          lane: "executor",
          store: this.store,
          audit,
          taskId: task.id,
          runContext: engineRunContext,
        });
        const executorGoalContext = executorGoalResolution.goalContext;

        const executorLayers = buildPromptLayers({
          basePrompt: getExecutorSystemPrompt(settings, { taskCreateWithheld, delegateWithheld }),
          goalContext: executorGoalContext,
          agentInstructions: executorInstructions,
          pluginContributions: executorPluginContributions,
        });

        const executorSystemPromptFinal = collapsePromptLayers(executorLayers);

        // sessionFile must be let because it's assigned before downstream retry-session reassignment.
        let session: AgentSession;
        let sessionFile: string | null | undefined;
        try {
          const createdSession = await createResolvedAgentSession({
            sessionPurpose: "executor",
            runtimeHint: executorRuntimeHint,
            pluginRunner: this.options.pluginRunner,
            cwd: worktreePath,
            systemPrompt: executorSystemPromptFinal,
            systemPromptLayers: executorLayers,
            tools: "coding",
            customTools,
            onText: agentLogger.onText,
            onThinking: agentLogger.onThinking,
            onToolStart: agentLogger.onToolStart,
            onToolEnd: agentLogger.onToolEnd,
            defaultProvider: executorProvider,
            defaultModelId: executorModelId,
            ...(sessionCredentialInstanceId ? { credentialInstanceId: sessionCredentialInstanceId } : {}),
            fallbackProvider: executorFallbackProvider,
            fallbackModelId: executorFallbackModelId,
            fallbackThinkingLevel: executorFallbackThinkingLevel,
            defaultThinkingLevel: executorThinkingLevel,
            runAuditor: audit,
            settings,
            sessionManager,
            taskEnv,
            mcpServers: await this.resolveMcpServers(identityAgent?.id),
            // FNXC:PluginSkills 2026-07-12-00:00: Plugin skill session delivery requires forwarding both requested names and body directories so the pi loader can discover plugin-package SKILL.md files.
            ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
            ...(skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
            // Column-agent principal alignment (plan U5, R5): action gating is
            // computed for the agent ACTUALLY RUNNING. When the governing execute
            // seam's column binds an agent that supersedes the assigned agent,
            // `identityAgent` is that column agent; otherwise it is `assignedAgent`
            // (byte-identical to before). The builders already accept an `Agent`
            // object, so this is a call-site object swap, not gating-internals surgery.
            actionGateContext: this.buildActionGateContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
            permanentAgentGating: this.buildPermanentAgentGatingContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
            taskId: task.id,
            taskTitle: detail.title,
            onFallbackModelUsed: createFallbackModelObserver({
              agent: "executor",
              label: "executor",
              store: this.store,
              taskId: task.id,
              taskTitle: detail.title,
            }),
          });
          session = createdSession.session;
          sessionFile = createdSession.sessionFile;
        } catch (sessionStartError) {
          if (await this.recoverMissingWorktreeSessionStartFailure(task, worktreePath, sessionStartError, audit)) {
            return;
          }
          throw sessionStartError;
        }

        const executorModelDesc = describeModel(session);
        const executorModelDetails = formatModelMarkerDetails(executorModelDesc, executorThinkingLevel);
        const executorModelMarker = `Executor using model: ${executorModelDetails}`;
        if (isResuming) {
          executorLog.debug(`${task.id}: resumed session from ${task.sessionFile}`);
          await this.store.logEntry(task.id, `Resumed agent session after unpause (model: ${executorModelDesc})`, undefined, this.getRunContextFor(task.id));
        } else {
          executorLog.debug(`${task.id}: using model ${executorModelDesc}`);
          await this.store.logEntry(task.id, executorModelMarker, undefined, this.getRunContextFor(task.id));
          // Persist session file path so pause/resume can reopen it
          if (sessionFile) {
            await this.store.updateTask(task.id, { sessionFile });
          }
        }
        await this.store.appendAgentLog(task.id, executorModelMarker, "status", undefined, "executor");

        // Capture both executor and session-helper baselines before any task prompt consumes tokens.
        await this.captureExecutorTokenUsageBaseline(task.id, session);
        captureSessionTokenBaseline(session);

        // Make session available to custom tools
        sessionRef.current = session;

        // Register session so the pause listener can terminate it.
        // Initialize with all existing steering comments so only mid-flight
        // comments are injected into the running session.
        const seenSteeringIds = createSeenSteeringIds(detail);
        this.setActiveSession(task.id, {
          session,
          seenSteeringIds,
          lastResolvedModelProvider: executorProvider,
          lastResolvedModelId: executorModelId,
          lastTaskModelProvider: detail.modelProvider,
          lastTaskModelId: detail.modelId,
          lastAssignedAgentId: detail.assignedAgentId ?? null,
          // U5 (R7): the effective column-agent governing this session (null when no
          // binding governs — legacy path). The watcher re-resolves this for graph-
          // mode entries to detect a mid-flight workflow-edit / agent-config change.
          lastEffectiveColumnAgentId: columnAgentSeam?.agent.id ?? null,
        }, worktreePath);

        /*
        FNXC:TaskVerificationRequest 2026-07-30-17:40:
        A chat request can arrive after this executor session starts. Poll while
        this task retains the live worktree so requested records are claimed by
        their owner rather than waiting for an unrelated future dispatch.
        */
        const verificationRequestTimer = setInterval(() => {
          void runPendingTaskVerification().catch((error) => {
            executorLog.warn(`${task.id}: verification request pickup failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, 1_000);
        let leaseRenewalTimer: ReturnType<typeof setInterval> | undefined;
        if (detail.assignedAgentId && detail.checkedOutBy === detail.assignedAgentId) {
          const leaseEpoch = detail.checkoutLeaseEpoch ?? 0;
          const checkoutNodeId = detail.checkoutNodeId ?? detail.effectiveNodeId ?? detail.nodeId ?? "local";
          const runId = this.getRunContextFor(task.id)?.runId;
          await this.renewTaskLease(task.id, detail.assignedAgentId, leaseEpoch, checkoutNodeId, runId).catch(() => {});
          leaseRenewalTimer = setInterval(() => {
            void this.renewTaskLease(task.id, detail.assignedAgentId!, leaseEpoch, checkoutNodeId, runId).catch(() => {});
          }, 30_000);
        }

        // Register with stuck task detector for heartbeat monitoring
        stuckDetector?.trackTask(task.id, session);
        executorLog.debug(`${task.id}: session registered (model=${describeModel(session)}, stuckDetector=${!!stuckDetector})`);

        // Invoke plugin onAgentRunStart hook (fire-and-forget)
        void this.options.pluginRunner?.invokeHookSafe("onAgentRunStart", task.id);

        try {
          // Record activity on prompt start (heartbeat for stuck detection)
          stuckDetector?.recordActivity(task.id);

          executorLog.debug(`${task.id}: calling promptWithFallback()...`);
          if (isResuming) {
            // Session already has full conversation history — just tell the
            // agent it was paused and should pick up where it left off.
            await promptWithFallback(session, [
              "Your session was paused and has now been resumed.",
              "Continue working on the task from where you left off.",
              "Review the current state of your worktree and proceed with the next pending step.",
            ].join("\n"));
          } else {
            const customFieldDefs = await this.resolveTaskCustomFieldDefs(task.id);
            const pluginTaskContributions = await buildPluginPromptSection("executor-task", this.options.pluginRunner);
            const agentPrompt = buildExecutionPrompt(
              detail,
              this.rootDir,
              settings,
              worktreePath,
              this.options.pluginRunner,
              customFieldDefs,
              this.workspaceConfig,
              {
                pluginTaskContributions,
              },
            );
            await promptWithFallback(session, agentPrompt);
          }

          // Re-raise errors that pi-coding-agent swallowed after exhausting retries.
          // session.prompt() resolves normally even when retries are exhausted —
          // the error is stored on session.state.error instead of being thrown.
          checkSessionError(session);
          await this.persistTokenUsage(task.id, session);

          // Check if proactive context compaction is needed based on token cap setting.
          // This runs after the main prompt completes to avoid interrupting active work.
          try {
            const capResult = await this.tokenCapDetector.checkAndCompact(
              session,
              task.id,
              settings.tokenCap,
              async (s) => {
                const compactResult = await compactSessionContext(s);
                if (compactResult) {
                  await this.store.logEntry(
                    task.id,
                    `Context compacted at ${compactResult.tokensBefore} tokens (token cap: ${settings.tokenCap})`,
                    undefined,
                    this.getRunContextFor(task.id),
                  );
                }
                return compactResult;
              },
            );
            if (capResult.triggered) {
              executorLog.debug(`${task.id} token cap check: ${capResult.message}`);
            }
          } catch (err) {
            executorLog.debug(`${task.id} token cap check failed (non-fatal): ${err}`);
          }

          // If loop recovery is pending (compact-and-resume was triggered by
          // handleLoopDetected), consume the pending state and resume with a
          // deterministic prompt. The session has already been compacted, so
          // we just need to send a fresh prompt to continue execution.
          const loopState = this.loopRecoveryState.get(task.id);
          if (loopState?.pending) {
            loopState.pending = false;
            executorLog.log(`${task.id} consuming loop recovery — resuming with fresh context`);
            await this.store.logEntry(task.id, "Resuming execution after context compaction — taking a different approach", undefined, this.getRunContextFor(task.id));

            // Reset activity tracking so the detector doesn't immediately re-trigger
            stuckDetector?.recordProgress(task.id);

            const resumePrompt = [
              "Your conversation was compacted because you were looping without making progress.",
              "Review the current state of the worktree carefully:",
              "1. Check `git log --oneline` to see what's already been committed",
              "2. Read the files you were working on to understand current state",
              "3. Review the PROMPT.md steps to see which are still pending",
              "",
              "Take a DIFFERENT approach from what you were doing before.",
              "If the current step is complete, call fn_task_update to mark it done and move to the next step.",
              "If you're stuck on a problem, try a simpler or alternative solution.",
              "",
              "Continue the task from where you left off.",
            ].join("\n");

            await promptWithFallback(session, resumePrompt);
            checkSessionError(session);
            await this.persistTokenUsage(task.id, session);
          }

          // If dependency was added during execution, discard worktree and move to triage
          if (this.depAborted.has(task.id)) {
            this.depAborted.delete(task.id);
            await this.handleDepAbortCleanup(task.id, worktreePath);
            return;
          }

          // If paused during execution, move to todo so the scheduler can resume
          // after unpause. This path fires when session.dispose() causes the
          // prompt to resolve gracefully instead of throwing.
          if (this.pausedAborted.has(task.id)) {
            if (this.userCanceledTaskIds.has(task.id)) {
              this.clearPausedAborted(task.id);
              this.stuckAborted.delete(task.id);
              this.userCanceledTaskIds.delete(task.id);
              await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            if (await this.parkApprovalSuspension(task.id, "agent session")) {
              wasPaused = true;
              return;
            }
            this.clearPausedAborted(task.id);
            wasPaused = true;
            const finalizationDecision = await this.getCompletedTaskFinalizationDecision(task.id, taskDone);
            if (finalizationDecision === "finalize") {
              if (await this.shouldDeferCompletionForGlobalPause(task.id, "paused after completion")) {
                return;
              }
              executorLog.log(`${task.id} paused after completion (graceful session exit) — finalizing to in-review`);
              await this.store.logEntry(task.id, "Execution paused after completion — finalizing to in-review");
              await this.persistTokenUsage(task.id);
              /*
              FNXC:WorkflowLifecycle 2026-06-17-23:33:
              FN-6625: the completed/no-commit handoff may dispose graph execution after the task is already in-review. Mark that abort as completion-finalize so a trailing FN-6614-style graph failure resolves benignly instead of looking like a user/global pause; FN-6568 uses the same provenance seam for merge aborts.

              FNXC:WorkflowLifecycle 2026-06-18-10:58:
              FN-6644/FN-6641: the graceful-session-exit handoff must also record durable completed-finalize state because a later teardown can re-mark the abort as `hard-cancel`. The classifier uses that durable handoff marker, not the volatile provenance alone, to keep completed no-commit tasks from being re-parked failed.
              */
              this.markCompletionFinalized(task.id);
              reportImplementationExit?.("review-handoff-paused-after-completion");
              await this.handoffTaskToReview(task, "paused-after-completion");
              this.clearCompletedTaskWatchdog(task.id);
              this.signalTaskComplete(task);
            } else if (finalizationDecision === "blocked") {
              await this.persistTokenUsage(task.id);
              return;
            } else {
              executorLog.log(`${task.id} paused (graceful session exit) — moving to todo`);
              await this.store.logEntry(task.id, "Execution paused — session preserved for resume, moved to todo");
              this.markGraphExecuteSelfRequeued(task.id);
              await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveResumeState: true });
            }
            return;
          }

          // If the stuck task detector disposed the session and the agent exited
          // cleanly, stop here. The requeue is deferred to the finally block
          // (after this.executing is cleared) to prevent a race where the
          // scheduler re-dispatches while the old execution guard is still set.
          if (this.stuckAborted.has(task.id)) {
            if (this.userCanceledTaskIds.has(task.id)) {
              this.clearPausedAborted(task.id);
              this.stuckAborted.delete(task.id);
              this.userCanceledTaskIds.delete(task.id);
              await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
              return;
            }
            stuckRequeue = this.stuckAborted.get(task.id) ?? true;
            this.stuckAborted.delete(task.id);
            executorLog.log(`${task.id} terminated by stuck task detector (graceful session exit)`);
            return;
          }

          // If the agent didn't explicitly call fn_task_done, check whether
          // all steps are already complete — treat as implicit done to avoid
          // unnecessary retry sessions for context-overflow / compaction cases.
          if (!taskDone) {
            const implicitCheck = await this.store.getTask(task.id);
            if (implicitCheck.steps.length > 0 &&
                implicitCheck.steps.every((s) => s.status === "done" || s.status === "skipped")) {
              // Implicit and explicit paths share the same structural pending-review and bulk-step-completion guards.
              const refusal = evaluateImplicitCompletionRefusal(implicitCheck, codeReviewVerdicts);
              if (!refusal.ok) {
                await this.handleImplicitTaskDoneRefusal(implicitCheck, refusal);
                return;
              }
              taskDone = true;
              executorLog.log(`${task.id} all steps done — treating as implicit fn_task_done`);
              await this.store.logEntry(task.id, "All steps complete — implicit fn_task_done (agent did not call tool explicitly)", undefined, this.getRunContextFor(task.id));
              this.scheduleCompletedTaskWatchdog(task.id, "implicit fn_task_done");
            }
          }

          if (taskDone) {
            // Capture modified files before running workflow steps
            const updatedTask = await this.store.getTask(task.id);
            const modifiedFiles = await this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha, task.id, audit, "workflow-fanout");
            if (modifiedFiles.length > 0) {
              await this.store.updateTask(task.id, { modifiedFiles });
              executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
            }

            // Graph-driven completion (interpreter cutover): the workflow graph
            // owns workflow steps, review handoff, and merge from here — stop
            // at the implementation-complete boundary and hand control back.
            this.clearCompletedTaskWatchdog(task.id);
            executorLog.log(`✓ ${task.id} implementation complete — graph interpreter owns the remaining lifecycle`);
            reportImplementationExit?.("complete");
            graphCompletion({ modifiedFiles });
            return;
          } else {
            let taskDoneSessionRetries = 0;
            let retryAbortedDueToReclaim = false;
            let refusalHandled = false;
            let pendingReviewParked = false;
            /* FNXC:ExecutorTaskDonePark 2026-07-15-16:10: FN-7965 — set when the row was terminally parked (status=failed) by the in-session fn_task_done refusal handler; suppresses both the retry and every post-loop completion/requeue branch so the park survives. */
            let terminallyParked = false;
            while (!taskDone && taskDoneSessionRetries < MAX_TASK_DONE_SESSION_RETRIES) {
              const liveTask = await this.store.getTask(task.id);
              /*
              FNXC:ExecutorTaskDonePark 2026-07-15-16:10:
              FN-7965: the explicit `fn_task_done` tool handler parks the task terminally (status=failed, worktree/branch/sessionFile cleared) once the refusal retry budget is exhausted — but it runs INSIDE the agent session, so this loop never learned the row had been parked and spawned a retry session anyway. That session completed and marked the task done against a row with no worktree, so the pre-merge graph died on the first write-capable node with `no-worktree-for-write-node` and surfaced as a bogus "terminated at code-review-remediation" instead of the real refusal. Re-read state and honor the park.
              This deliberately does NOT reuse the FN-4806 reclaim branch below: that silently requeues to `todo`, which would clear the park and — with the refusal budget already exhausted — re-park on the next pickup, looping todo→execute→park. A terminal park is the agent's own failure and must stay parked for a human.
              Note the reclaim probes below cannot cover this: they test `liveTask.worktree === null`, but the store maps a cleared column to `undefined`, never `null` (`task-store/serialization.ts` — `row.worktree || undefined`). Tightening that probe is a separate change with real blast radius, so the park is detected by status here instead.
              */
              if (liveTask.status === "failed") {
                const parkMessage = `${task.id}: task parked failed during no-fn_task_done retry — honoring park, not retrying`;
                executorLog.log(parkMessage);
                await this.store.logEntry(task.id, parkMessage, undefined, this.getRunContextFor(task.id));
                this.deleteActiveSession(task.id);
                this.tokenUsageBaselines.delete(task.id);
                session.dispose();
                terminallyParked = true;
                break;
              }
              const hasExplicitWorktreeBinding = typeof liveTask.worktree === "string" || liveTask.worktree === null;
              const hasExplicitBranchBinding = typeof liveTask.branch === "string" || liveTask.branch === null;
              /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the contract holds while the card is
                 in ITS board's wip lane; the literal made every renamed-board retry look reclaimed. */
              const worktreeContractIntact = liveTask.column === (await this.resolveResumeLanes(task.id)).wip
                && !liveTask.paused
                && (!hasExplicitWorktreeBinding || liveTask.worktree === worktreePath)
                && (!hasExplicitBranchBinding || (typeof liveTask.branch === "string" && liveTask.branch.length > 0));
              if (!worktreeContractIntact) {
                const reclaimMessage = `${task.id}: worktree/branch reclaimed during no-fn_task_done retry — aborting retry and requeueing`;
                executorLog.log(reclaimMessage);
                await this.store.logEntry(task.id, reclaimMessage, undefined, this.getRunContextFor(task.id));
                this.deleteActiveSession(task.id);
                this.tokenUsageBaselines.delete(task.id);
                session.dispose();
                retryAbortedDueToReclaim = true;
                break;
              }

              const pendingReviewBlock = detectPendingReviewBlock(liveTask, codeReviewVerdicts);
              if (pendingReviewBlock.blocked) {
                executorLog.log(
                  `[executor] ${task.id}: fn_task_done not called but task is blocked on pending review (${pendingReviewBlock.reason}) — skipping retry session`,
                );
                await this.store.logEntry(
                  task.id,
                  `Agent finished without calling fn_task_done but Step ${pendingReviewBlock.stepIndex} is blocked on pending review (${pendingReviewBlock.reason}) — skipping retry session`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
                this.deleteActiveSession(task.id);
                this.tokenUsageBaselines.delete(task.id);
                session.dispose();
                await this.persistTokenUsage(task.id);
                // A pending-review block is not an execution failure. The executor
                // cannot continue until the reviewer decision is resolved, so park
                // the task in review without setting status=failed; otherwise the
                // merge/review queue deadlocks on a task that is both in-review and
                // failed.
                /*
                FNXC:WorkflowExecutionOwnership 2026-07-29-18:50 (U8 / R4):
                The `handoffTaskToReview` call that stood here is GONE — the graph performs it via
                the `review-pending-handoff` node the live primitive now routes to. What remains is
                a report and a stop, which is all an implementation phase should do. Why review and
                not `failed` (a pending-review block is a wait; status=failed on an in-review row
                deadlocks the merge queue) now lives with the node in the IR, where the routing
                decision is.
                */
                reportImplementationExit?.("review-handoff-pending-review");
                pendingReviewParked = true;
                break;
              }

              taskDoneSessionRetries++;
              executorLog.log(
                `⚠ ${task.id} finished without fn_task_done — retrying with new session (${taskDoneSessionRetries}/${MAX_TASK_DONE_SESSION_RETRIES})`,
              );
              await this.store.logEntry(
                task.id,
                `Agent finished without calling fn_task_done — retrying with new session (${taskDoneSessionRetries}/${MAX_TASK_DONE_SESSION_RETRIES})`,
                undefined,
                this.getRunContextFor(task.id),
              );

              // Capture and analyse the previous session's text before resetting.
              const previousSessionText = lastAssistantText;
              const pseudoPause = detectPseudoPause(previousSessionText);

              if (pseudoPause.kind !== "none") {
                const shortMatch = (pseudoPause.matched ?? "").slice(0, 120);
                await this.store.logEntry(
                  task.id,
                  `Pseudo-pause detected (kind=${pseudoPause.kind}, matched='${shortMatch}')`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
                executorLog.log(`${task.id} pseudo-pause detected (kind=${pseudoPause.kind}): ${shortMatch}`);
              }

              // Dispose old session and create a fresh one.
              // Reset lastAssistantText so the new session's text is tracked cleanly.
              lastAssistantText = "";
              this.deleteActiveSession(task.id);
              this.tokenUsageBaselines.delete(task.id);
              session.dispose();

              let retrySession: AgentSession | null = null;
              try {
                const createdRetrySession = await createResolvedAgentSession({
                  sessionPurpose: "executor",
                  runtimeHint: executorRuntimeHint,
                  pluginRunner: this.options.pluginRunner,
                  cwd: worktreePath,
                  systemPrompt: executorSystemPromptFinal,
                  systemPromptLayers: executorLayers,
                  tools: "coding",
                  customTools,
                  onText: agentLogger.onText,
                  onThinking: agentLogger.onThinking,
                  onToolStart: agentLogger.onToolStart,
                  onToolEnd: agentLogger.onToolEnd,
                  defaultProvider: executorProvider,
                  defaultModelId: executorModelId,
                  ...(executorSessionModel.credentialInstanceId ? { credentialInstanceId: executorSessionModel.credentialInstanceId } : {}),
                  fallbackProvider: executorFallbackProvider,
                  fallbackModelId: executorFallbackModelId,
                  fallbackThinkingLevel: executorFallbackThinkingLevel,
                  defaultThinkingLevel: executorThinkingLevel,
                  runAuditor: audit,
                  settings,
                  sessionManager: SessionManager.create(worktreePath),
                  taskEnv,
                  mcpServers: await this.resolveMcpServers(identityAgent?.id),
                  // FNXC:PluginSkills 2026-07-12-00:00: Retry executor sessions must keep the same plugin skill body discovery paths as the primary attempt so requested plugin skill names resolve to real bodies.
                  ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
                  ...(skillContext.additionalSkillPaths.length > 0 ? { additionalSkillPaths: skillContext.additionalSkillPaths } : {}),
                  // U5 (R5): retry session re-keys gating to the effective principal,
                  // mirroring the primary execute-seam session above.
                  actionGateContext: this.buildActionGateContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
                  permanentAgentGating: this.buildPermanentAgentGatingContext(task.id, identityAgent, settings.defaultAgentPermissionPolicy),
                  // FNXC:SessionRouting 2026-06-24-11:20:
                  // #1675: propagate task id so retry-session requests carry the same
                  // X-Session-Id/X-Session-Affinity as the primary session, keeping the
                  // task's LLM requests grouped under one stable routing/observability id.
                  taskId: task.id,
                });
                retrySession = createdRetrySession.session;
                await this.captureExecutorTokenUsageBaseline(task.id, retrySession);
                captureSessionTokenBaseline(retrySession);
                if (createdRetrySession.sessionFile) {
                  this.store.updateTask(task.id, { sessionFile: createdRetrySession.sessionFile }).catch((err: unknown) => {
                    const msg = err instanceof Error ? err.message : String(err);
                    executorLog.warn(`${task.id} failed to persist retry sessionFile: ${msg}`);
                  });
                }

                session = retrySession;
                sessionRef.current = retrySession;
                this.setActiveSession(task.id, {
                  session: retrySession,
                  seenSteeringIds,
                  lastResolvedModelProvider: executorProvider,
                  lastResolvedModelId: executorModelId,
                  lastTaskModelProvider: detail.modelProvider,
                  lastTaskModelId: detail.modelId,
                  lastAssignedAgentId: detail.assignedAgentId ?? null,
                  // U5 (R7): preserve the effective column-agent across the retry.
                  lastEffectiveColumnAgentId: columnAgentSeam?.agent.id ?? null,
                }, worktreePath);
                stuckDetector?.trackTask(task.id, retrySession);

                const retryCustomFieldDefs = await this.resolveTaskCustomFieldDefs(task.id);
                const retryPluginTaskContributions = await buildPluginPromptSection("executor-task", this.options.pluginRunner);
                let retryPrompt: string;
                if (pseudoPause.kind !== "none") {
                  const shortMatch = (pseudoPause.matched ?? "").slice(0, 120);
                  retryPrompt = [
                    `Your previous turn ended with a pseudo-pause: "${shortMatch}". This is forbidden.`,
                    "",
                    "Turn-ending rules you violated:",
                    "- You MUST NOT end a turn by asking the user a question, summarizing progress, or requesting permission to continue.",
                    "- Phrases like 'If you want, I can continue', 'Should I proceed?', 'Let me know if...' are FORBIDDEN turn-endings.",
                    "- The user is not watching this conversation. Questions written as prose are ignored.",
                    "- If you genuinely cannot proceed, call fn_task_done with a clear explanation — never write the blocker as plain prose.",
                    "",
                    "What you must do now:",
                    "1. Review the PROMPT.md steps and identify the next pending step.",
                    "2. Do the work for that step immediately — call fn_task_update, write code, run tests.",
                    "3. Continue until all steps are done, then call fn_task_done.",
                    "Do NOT ask for permission. Do NOT write a summary. Just call a tool and keep working.",
                    "",
                    "Original task:",
                    buildExecutionPrompt(
                      detail,
                      this.rootDir,
                      settings,
                      worktreePath,
                      this.options.pluginRunner,
                      retryCustomFieldDefs,
                      this.workspaceConfig,
                      {
                        pluginTaskContributions: retryPluginTaskContributions,
                      },
                    ),
                  ].join("\n");
                } else {
                  retryPrompt = [
                    "Your previous session ended without calling the fn_task_done tool.",
                    "The task may already be complete — review the current state of the worktree and either:",
                    "1. If the work is done, call fn_task_done with a summary of what was accomplished.",
                    "2. If there is remaining work, finish it and then call fn_task_done.",
                    "",
                    "Original task:",
                    buildExecutionPrompt(
                      detail,
                      this.rootDir,
                      settings,
                      worktreePath,
                      this.options.pluginRunner,
                      retryCustomFieldDefs,
                      this.workspaceConfig,
                      {
                        pluginTaskContributions: retryPluginTaskContributions,
                      },
                    ),
                  ].join("\n");
                }

                stuckDetector?.recordActivity(task.id);
                await promptWithFallback(retrySession, retryPrompt);
                checkSessionError(retrySession);
                await this.persistTokenUsage(task.id, retrySession);
              } catch (retryError) {
                this.deleteActiveSession(task.id);
                this.tokenUsageBaselines.delete(task.id);
                retrySession?.dispose();
                if (await this.recoverMissingWorktreeSessionStartFailure(task, worktreePath, retryError, audit)) {
                  return;
                }
                throw retryError;
              }

              if (!taskDone) {
                const implicitCheck = await this.store.getTask(task.id);
                if (implicitCheck.steps.length > 0 &&
                    implicitCheck.steps.every((s) => s.status === "done" || s.status === "skipped")) {
                  // Implicit and explicit paths share the same structural pending-review and bulk-step-completion guards.
                  const refusal = evaluateImplicitCompletionRefusal(implicitCheck, codeReviewVerdicts);
                  if (!refusal.ok) {
                    await this.handleImplicitTaskDoneRefusal(implicitCheck, refusal);
                    retrySession?.dispose();
                    retrySession = null;
                    retryAbortedDueToReclaim = false;
                    refusalHandled = true;
                    break;
                  }
                  taskDone = true;
                  executorLog.log(`${task.id} all steps done — treating as implicit fn_task_done`);
                  await this.store.logEntry(task.id, "All steps complete — implicit fn_task_done (agent did not call tool explicitly)", undefined, this.getRunContextFor(task.id));
                  this.scheduleCompletedTaskWatchdog(task.id, "implicit fn_task_done");
                }
              }
            }

            if (taskDone) {
              const updatedTask = await this.store.getTask(task.id);
              const modifiedFiles = await this.captureModifiedFiles(worktreePath, updatedTask.baseCommitSha, task.id, audit, "no-task-done-retry");
              if (modifiedFiles.length > 0) {
                await this.store.updateTask(task.id, { modifiedFiles });
                executorLog.log(`${task.id}: captured ${modifiedFiles.length} modified files`);
              }

              this.scheduleCompletedTaskWatchdog(task.id, "task completion retry");
              if (await this.shouldDeferCompletionForGlobalPause(task.id, "before in-review transition after task completion retry")) {
                return;
              }

              // FNXC:WorkflowExecution 2026-06-25-00:00: U4 (KTD-2/KTD-5) — workflow
              // gates are graph-owned (record into task.workflowStepResults, U2); the
              // legacy runWorkflowSteps loop was deleted. For a graph-driven run the
              // execute seam registered a completion interceptor, so stop at the
              // implementation boundary and let the graph own the remaining
              // lifecycle. A non-graph fallback reaching here has NO enabled workflow
              // steps (a minimal store WITH enabled steps is parked fail-closed in
              // executeWorkflowGraph, KTD-5) — nothing to gate before handoff.
              this.clearCompletedTaskWatchdog(task.id);
              executorLog.log(`✓ ${task.id} implementation complete (retry) — graph interpreter owns the remaining lifecycle`);
              reportImplementationExit?.("complete-after-retry");
              graphCompletion({ modifiedFiles });
              return;
            } else if (terminallyParked) {
              // FN-7965: the in-session refusal handler already wrote the terminal failure and cleared
              // the binding. Nothing further to do — requeueing or handing off to review here is exactly
              // the resurrection that stranded the pre-merge graph.
              await this.persistTokenUsage(task.id);
              return;
            } else if (retryAbortedDueToReclaim) {
              // FN-4806: Worktree/branch was reclaimed mid-retry by an engine-side housekeeping path
              // (e.g. FN-4546 stale-active-branch reclaim, FN-4742 self-healing removals). This is NOT
              // an agent failure — the agent never got a fair retry attempt. Silently requeue to todo
              // with preserved progress so a fresh worktree is created on next pickup. Do not mark
              // status=failed, do not surface onError, do not burn taskDoneRetryCount budget.
              const silentMessage = `${task.id}: worktree/branch reclaimed mid-retry — requeued to todo (engine self-heal, no failure)`;
              await this.store.logEntry(
                task.id,
                "Worktree/branch reclaimed mid-retry — requeued to todo (engine self-heal, no failure)",
                undefined,
                this.getRunContextFor(task.id),
              );
              // Clear any stale binding so the next pickup creates a fresh worktree.
              // baseCommitSha is also cleared because it pinned to the now-reclaimed worktree;
              // the next pickup will re-anchor it on the fresh checkout.
              await this.store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
              await this.persistTokenUsage(task.id);
              this.markGraphExecuteSelfRequeued(task.id);
              await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveProgress: true });
              executorLog.log(silentMessage);
            } else if (refusalHandled) {
              return;
            } else if (pendingReviewParked) {
              return;
            } else {
              // FN-4806: Genuine "agent finished without calling fn_task_done after N retries"
              // exhaustion. Not a reclaim/self-heal — the agent had a fair chance and failed to
              // signal completion. Mark failed, surface onError, and either requeue (budget
              // remaining) or escalate to in-review (budget exhausted).
              const priorRequeues = task.taskDoneRetryCount ?? 0;
              const nextRequeueCount = priorRequeues + 1;
              const errorMessage = `Agent finished without calling fn_task_done (after ${MAX_TASK_DONE_SESSION_RETRIES} retries)`;

              if (priorRequeues < MAX_TASK_DONE_REQUEUE_RETRIES) {
                await this.store.updateTask(task.id, {
                  status: "queued",
                  error: null,
                  taskDoneRetryCount: nextRequeueCount,
                });
                await this.store.logEntry(
                  task.id,
                  `${errorMessage} — requeued to todo immediately (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
                this.markGraphExecuteSelfRequeued(task.id);
                await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveProgress: true });
                executorLog.log(`✗ ${task.id} failed after ${MAX_TASK_DONE_SESSION_RETRIES} retries — requeued to todo (${nextRequeueCount}/${MAX_TASK_DONE_REQUEUE_RETRIES})`);
              } else {
                await this.store.updateTask(task.id, { status: "failed", error: errorMessage });
                await this.store.logEntry(task.id, `${errorMessage} — execution failed after task-done retry budget was exhausted`, undefined, this.getRunContextFor(task.id));
                await this.persistTokenUsage(task.id);
                executorLog.log(`✗ ${task.id} failed after ${MAX_TASK_DONE_SESSION_RETRIES} retries — no fn_task_done`);
              }
              this.options.onError?.(task, new Error(errorMessage));
            }
          }
        } finally {
          clearInterval(verificationRequestTimer);
          if (leaseRenewalTimer) {
            clearInterval(leaseRenewalTimer);
          }
          this.deleteActiveSession(task.id);
          stuckDetector?.untrackTask(task.id);
          await agentLogger.flush();
          await this.persistTokenUsage(task.id, session).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            executorLog.warn(`${task.id}: failed to persist final single-session token usage before dispose: ${msg}`);
          });
          this.tokenUsageBaselines.delete(task.id);
          resetSessionTokenBaseline(session);
          session.dispose();
          // Terminate all spawned child agents when parent session ends
          await this.terminateAllChildren(task.id);
          // Clear session file when task completes or fails (not when paused —
          // the file is preserved so unpause can resume the conversation).
          // Check both the local flag (graceful exit) and the instance set
          // (error path where dispose caused prompt to throw).
          if (!wasPaused && !this.pausedAborted.has(task.id)) {
            this.store.updateTask(task.id, { sessionFile: null }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              executorLog.warn(`${task.id} failed to clear sessionFile: ${msg}`);
            });
          }
          // Invoke plugin onAgentRunEnd hook (fire-and-forget)
          void this.options.pluginRunner?.invokeHookSafe("onAgentRunEnd", task.id);
        }
      };

      const retryableWork = () => withRateLimitRetry(agentWork, {
        signal: this.activeWorkflowGraphAbortControllers.get(task.id)?.signal,
        rotation: this.options.credentialRotator ? {
          providerId: activeAgentInstanceRef?.providerId ?? detail.modelProvider ?? "",
          nextInstance: async () => {
            /*
            FNXC:CredentialInstanceRotation 2026-08-01-11:05:
            Executor agent runs rotate only after the shared retry helper classifies a
            usage limit. Live task/settings reads and the executor pause-abort marker
            bail before opening an event, because a pause arriving mid-run cannot
            authorize changing the billed credential. A successful offer causes
            agentWork to construct a fresh session; a non-limit failure intentionally
            leaves its attempt without an outcome row.
            */
            const [liveTask, liveSettings] = await Promise.all([
              this.store.getTask(task.id).catch(() => undefined),
              this.store.getSettings().catch(() => settings),
            ]);
            if (agentRotationDeclined || this.pausedAborted.has(task.id) || !liveTask
              || liveTask.userPaused === true || liveTask.autoMerge === false
              || liveSettings.globalPause === true || liveSettings.enginePaused === true
              || !activeAgentInstanceRef?.providerId) return undefined;
            agentRotationEvent ??= await this.options.credentialRotator!.beginEvent({
              providerId: activeAgentInstanceRef.providerId,
              startingInstanceId: activeAgentInstanceRef.instanceId,
              lane: "executor-agent",
              taskId: task.id,
            });
            if (!agentRotationEvent) { agentRotationDeclined = true; return undefined; }
            // FNXC:CredentialInstanceRotation 2026-08-01-11:34: Inventory lookup is asynchronous; re-check human control before this retry marks a credential limited or offers another billed account.
            const [postInventoryTask, postInventorySettings] = await Promise.all([
              this.store.getTask(task.id).catch(() => undefined),
              this.store.getSettings().catch(() => settings),
            ]);
            if (this.pausedAborted.has(task.id) || !postInventoryTask
              || postInventoryTask.userPaused === true || postInventoryTask.autoMerge === false
              || postInventorySettings.globalPause === true || postInventorySettings.enginePaused === true) return undefined;
            this.options.credentialRotator!.markLimited(activeAgentInstanceRef);
            if (agentDispatchedRotation) agentRotationEvent.recordOutcome("rotation-failed-limit");
            const next = await agentRotationEvent.next();
            if (!next) { agentRotationEvent.finishExhausted(); return undefined; }
            activeAgentInstanceRef = next;
            agentDispatchedRotation = true;
            return next;
          },
        } : undefined,
        onRetry: (attempt, delayMs, error) => {
          const delaySec = Math.round(delayMs / 1000);
          executorLog.warn(`⏳ ${task.id} rate limited — retry ${attempt} in ${delaySec}s: ${error.message}`);
          this.store.logEntry(task.id, `Rate limited — retry ${attempt} in ${delaySec}s`, undefined, this.getRunContextFor(task.id)).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            executorLog.warn(`${task.id} failed to log rate-limit retry: ${msg}`);
          });
        },
      });

      await this.runWithExecutorSemaphore(task.id, retryableWork);
      if (agentDispatchedRotation) agentRotationEvent?.recordOutcome("rotation-succeeded");
    } catch (err: unknown) {
      const { message: errorMessage, detail: errorDetail, stack: errorStack } = formatError(err);
      if (this.depAborted.has(task.id)) {
        // Dependency added mid-execution — discard worktree and move to triage
        this.depAborted.delete(task.id);
        await this.handleDepAbortCleanup(task.id, worktreePath);
      } else if (isInvalidAssistantContinuationErrorMessage(errorMessage)) {
        /*
        FNXC:PostDoneContinuation 2026-07-16-11:57:
        FN-8111 requires a completed task to win over stale-transcript retry handling. An assistant-last error after the task already reached in-review must signal completion and clear the watchdog rather than create a deferred retry that never dispatches.
        */
        if (await this.handleNonContinuableSessionError(task, taskDone, errorMessage)) {
          return;
        }
        /*
        FNXC:ExecutorSessionRecovery 2026-07-14-06:03:
        A stale assistant-last transcript gets a bounded fresh-session retry with the shared recovery backoff. The retry counter must survive the deferred move so repeated fresh-session failures eventually become a visible execution failure instead of cycling through Todo forever.

        FNXC:ExecutorSessionRecovery 2026-07-14-06:19:
        Deferred self-requeues must mark the workflow graph recovery and release the active worktree slot after the executor lock drops; otherwise graph failure cleanup can overwrite the recovery and the parked task can keep consuming maxWorktrees capacity.
        */
        const liveTask = await this.store.getTask(task.id);
        const decision = computeRecoveryDecision({
          recoveryRetryCount: liveTask.recoveryRetryCount,
          nextRecoveryAt: liveTask.nextRecoveryAt,
        });
        if (!decision.shouldRetry) {
          executorLog.error(`✗ ${task.id} stale assistant-continuation retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
          await this.store.logEntry(
            task.id,
            `Stale assistant-continuation fresh-session retries exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`,
            errorStack ?? errorDetail,
            this.getRunContextFor(task.id),
          );
          await this.store.updateTask(task.id, {
            status: "failed",
            error: errorMessage,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          await this.persistTokenUsage(task.id);
          this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
        }

        staleAssistantContinuationRequeue = true;
        const attempt = decision.nextState.recoveryRetryCount;
        const delay = formatDelay(decision.delayMs);
        executorLog.warn(`${task.id} stale assistant-continuation session detected — fresh-session retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay} after executor lock release`);
        await this.store.logEntry(
          task.id,
          `Detected stale assistant-continuation session — fresh-session retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay} with progress preserved: ${errorMessage}`,
          undefined,
          this.getRunContextFor(task.id),
        );
        await this.store.updateTask(task.id, {
          sessionFile: null,
          recoveryRetryCount: decision.nextState.recoveryRetryCount,
          nextRecoveryAt: decision.nextState.nextRecoveryAt,
        });
        return;
      } else if (errorMessage.includes("Invalid transition")) {
        // Task was moved by user/process while executor was running — already in desired state
        // This check must come before pausedAborted since it's more specific
        const transitionMatch = errorMessage.match(/Invalid transition: '([^']+)' → '([^']+)'/);
        const fromColumn = transitionMatch?.[1] ?? "unknown";
        const toColumn = transitionMatch?.[2] ?? "unknown";
        const logMessage = `Task already moved from '${fromColumn}' — skipping transition to '${toColumn}'`;
        executorLog.log(`${task.id} ${logMessage}`);
        await this.store.logEntry(task.id, logMessage, errorMessage, this.getRunContextFor(task.id));
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-09:25 (fleet: executor lifecycle roles):
        `fromColumn`/`toColumn` are parsed out of the store's rejection message, so they carry
        whatever ids that workflow declares. Comparing them to the literal `in-review` meant a
        renamed review lane never matched and the duplicate-handoff finalize never ran, leaving
        the card mid-transition with nothing to complete it. Resolve the task's own review role;
        an unresolvable workflow keeps the legacy literal, so behaviour is unchanged wherever the
        vocabulary cannot be read.
        */
        const reviewLane = (await resolveTaskLifecycleColumns(this.store, task.id).catch(() => undefined))?.review ?? "in-review";
        if (fromColumn === reviewLane && toColumn === reviewLane) {
          try {
            const finalizeResult = await this.finalizeAlreadyReviewedTask(task.id);
            executorLog.debug(`${task.id} duplicate in-review finalization result: ${finalizeResult}`);
          } catch (finalizeErr: unknown) {
            const finalizeErrMessage = finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr);
            executorLog.warn(`${task.id} failed to finalize duplicate in-review transition: ${finalizeErrMessage}`);
          }
        }
        // Task finished successfully (just already moved), so call onComplete
        this.signalTaskComplete(task);
      } else if (this.pausedAborted.has(task.id)) {
        // Task was paused mid-execution — clean up worktree and move to todo
        if (this.userCanceledTaskIds.has(task.id)) {
          this.clearPausedAborted(task.id);
          this.stuckAborted.delete(task.id);
          this.userCanceledTaskIds.delete(task.id);
          await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
          return;
        }
        if (await this.parkApprovalSuspension(task.id, "executor session")) return;
        this.clearPausedAborted(task.id);
        const latestTask = await this.store.getTask(task.id);
        if (
          /* FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): the HOLD lane — this recognises a card the
             abort already parked with its progress preserved, and skipping the cleanup is what keeps that
             progress. On a renamed board the cleanup ran anyway and discarded it. */
          latestTask?.column === (await this.resolveResumeLanes(task.id)).hold &&
          latestTask.paused === true &&
          ((latestTask.currentStep ?? 0) > 0 || latestTask.steps?.some((step) => step.status === "done" || step.status === "in-progress"))
        ) {
          executorLog.debug(`${task.id} paused-abort cleanup skipped — incomplete task is already parked with progress preserved`);
          await this.store.logEntry(
            task.id,
            "Execution abort cleanup skipped — incomplete stuck-loop task is already parked with progress preserved",
            undefined,
            this.getRunContextFor(task.id),
          );
          return;
        }
        const finalizationDecision = await this.getCompletedTaskFinalizationDecision(task.id, taskDone);
        if (finalizationDecision === "finalize") {
          if (await this.shouldDeferCompletionForGlobalPause(task.id, "paused after completion")) {
            return;
          }
          executorLog.log(`${task.id} paused after completion — finalizing to in-review`);
          await this.store.logEntry(task.id, "Execution paused after completion — finalizing to in-review", undefined, this.getRunContextFor(task.id));
          await this.persistTokenUsage(task.id);
          /*
          FNXC:WorkflowLifecycle 2026-06-17-23:33:
          FN-6625: the completed/no-commit handoff may dispose graph execution after the task is already in-review. Mark that abort as completion-finalize so a trailing FN-6614-style graph failure resolves benignly instead of looking like a user/global pause; FN-6568 uses the same provenance seam for merge aborts.

          FNXC:WorkflowLifecycle 2026-06-18-10:59:
          FN-6644/FN-6641: the finally-block handoff must record durable completed-finalize state because a later teardown can overwrite provenance to `hard-cancel`. The classifier must still resolve that completed no-commit tail failure benignly without weakening genuine pause or active hard-cancel behavior.
          */
          this.markCompletionFinalized(task.id);
          reportImplementationExit?.("review-handoff-paused-after-completion");
              await this.handoffTaskToReview(task, "paused-after-completion");
          this.signalTaskComplete(task);
        } else if (finalizationDecision === "blocked") {
          await this.persistTokenUsage(task.id);
          return;
        } else {
          executorLog.log(`${task.id} paused — moving to todo`);
          if (worktreePath && existsSync(worktreePath)) {
            try {
              const settings = await this.store.getSettings();
              await removeWorktree({
                worktreePath,
                rootDir: this.rootDir,
                settings,
                taskId: task.id,
                audit,
                reason: RemovalReason.ExecutorDispose,
                expectedOwnerTaskId: task.id,
                liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
              });
              executorLog.log(`Removed old worktree for paused task: ${worktreePath}`);
            } catch (cleanupErr: unknown) {
              const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
            }
          }
          // FNXC:WorkflowLifecycle 2026-06-21-00:00: FN-6722 — a mid-run abort on
          // a task that already has real step progress must not discard that
          // progress on the bounce to todo. The sibling pause-park path moves
          // with preserveResumeState;
          // this teardown branch historically did not — it cleared `branch` AND
          // moved without preservation, which reset every step to pending
          // (store.moveTaskInternal ~7322 resetAllStepsToPending) and dropped the
          // pointer to the commits already on the task branch. The next dispatch
          // then re-planned from Step 0 even though the work was committed on the
          // branch — observably a "lost all progress / stuck" failure. Preserve the
          // branch + resume state when there is resumable progress so execute()
          // resumes onto the existing branch (the `acquisition.isResume &&
          // task.branch` reconciliation ~7679) from the first incomplete step. The
          // worktree is still removed above and its binding cleared below to free
          // the concurrency slot (FN-6782) — only the durable pointers (branch +
          // step state) are kept. The 9227 guard above covers the same intent but
          // is race-contingent on the move having already landed; this makes the
          // fall-through path safe regardless.
          //
          // Read progress from `latestTask` (the store snapshot fetched at ~9226),
          // NOT the `task` parameter: `task` is frozen at dispatch time and never
          // mutated mid-run, so a fresh task (currentStep 0, all steps pending at
          // dispatch) whose agent committed step progress to the store during this
          // session would otherwise look progress-less here and hit the destructive
          // reset — the exact FN-6722 failure mode. Fall back to `task` when the
          // store read came back empty.
          const progressSource = latestTask ?? task;
          const hasResumableProgress =
            (progressSource.currentStep ?? 0) > 0
            || (progressSource.steps?.some((step) => step.status === "done" || step.status === "in-progress") ?? false);
          /*
          FNXC:WorkflowLifecycle 2026-07-12-09:05:
          Pause-bounce loop (observed on FN-7851): this teardown runs BECAUSE the user paused the task, but the plain move-to-todo below wiped the pause flags (store reopen block), leaving an unpaused dispatchable todo row. The graph-failure classifier then read `paused=false, userPaused=false`, misclassified the abort as engine-internal, and auto-continued the session; once the shared graphResumeRetryCount budget was exhausted the scheduler simply re-dispatched the row seconds later — so pausing an in-progress task could never stick. When the pause that caused this abort is still in force at teardown time, move with `preservePause` so the row lands in todo still parked (`paused` kept; scheduler skips paused/userPaused todo rows) and the classifier sees the pause and routes benignly. An unpause during the teardown window leaves `paused` unset and restores the old requeue-for-normal-scheduling behavior.
          */
          const pauseStillInForce = latestTask?.paused === true;
          await this.store.updateTask(
            task.id,
            hasResumableProgress ? { worktree: undefined } : { worktree: undefined, branch: undefined },
          );
          await this.store.logEntry(
            task.id,
            pauseStillInForce
              ? "Execution paused — agent terminated, parked in todo (pause preserved, awaiting explicit unpause)"
              : "Execution paused — agent terminated, moved to todo",
            undefined,
            this.getRunContextFor(task.id),
          );
          this.markGraphExecuteSelfRequeued(task.id);
          await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), {
            ...(hasResumableProgress ? { preserveResumeState: true } : {}),
            ...(pauseStillInForce ? { preservePause: true } : {}),
          });
        }
      } else if (this.stuckAborted.has(task.id)) {
        // Task was killed by stuck task detector — defer requeue to finally block
        // (after this.executing is cleared) to prevent re-dispatch race.
        if (this.userCanceledTaskIds.has(task.id)) {
          this.clearPausedAborted(task.id);
          this.stuckAborted.delete(task.id);
          this.userCanceledTaskIds.delete(task.id);
          await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
          return;
        }
        stuckRequeue = this.stuckAborted.get(task.id) ?? true;
        this.stuckAborted.delete(task.id);
        executorLog.log(`${task.id} terminated by stuck task detector — will ${stuckRequeue ? "retry" : "not retry (budget exhausted)"}`);
      } else {
        // Context-limit error reached the executor after promptWithFallback's auto-compaction
        // already attempted to recover. Recovery strategy (in order):
        //   1. Reduced-prompt retry in the same session (up to MAX_REDUCED_PROMPT_ATTEMPTS)
        //   2. Fresh-session requeue — terminate the saturated session and move the task
        //      back to "todo" so the next dispatch gets a clean session (bounded by
        //      recoveryRetryCount / MAX_RECOVERY_RETRIES).
        // FN-2182 class: Step 7 overflow after earlier compaction used to hit the
        // loopAttempts<1 guard and fail permanently; the requeue path below recovers
        // by restarting with a fresh session against the already-written step output.
        const MAX_REDUCED_PROMPT_ATTEMPTS = 3;
        const loopState = this.loopRecoveryState.get(task.id);
        const loopAttempts = loopState?.attempts ?? 0;
        const isContextError = isContextLimitError(errorMessage);

        if (isContextError && loopAttempts < MAX_REDUCED_PROMPT_ATTEMPTS) {
          const activeEntry = this.activeSessions.get(task.id);
          if (activeEntry) {
            executorLog.log(`${task.id} context limit error after auto-compaction — attempting reduced-prompt retry (${loopAttempts + 1}/${MAX_REDUCED_PROMPT_ATTEMPTS})`);
            await this.store.logEntry(task.id, `Context limit error after auto-compaction — attempting reduced-prompt retry (${loopAttempts + 1}/${MAX_REDUCED_PROMPT_ATTEMPTS}): ${errorMessage}`, undefined, this.getRunContextFor(task.id));

            this.loopRecoveryState.set(task.id, { attempts: loopAttempts + 1, pending: false });

            try {
              this.options.stuckTaskDetector?.recordProgress(task.id);
              // Build a reduced prompt that's simpler and shorter to avoid context overflow
              const reducedPrompt = [
                "Your previous attempt hit the context window limit.",
                "Focus on completing the task efficiently with minimal context:",
                "1. Review git status and git log to see what's been done",
                "2. Identify the most critical remaining work",
                "3. Complete it with a simpler, more focused approach",
                "",
                "Do not repeat what's already been done. Just complete the task and call fn_task_done.",
              ].join("\n");

              await promptWithFallback(activeEntry.session, reducedPrompt);
              checkSessionError(activeEntry.session);
              await this.persistTokenUsage(task.id, activeEntry.session);

              // Reduced-prompt retry succeeded — return to let the finally block clean up
              // without marking the task as failed.
              executorLog.log(`${task.id} reduced-prompt recovery succeeded — continuing`);
              await this.store.logEntry(task.id, "Reduced-prompt recovery succeeded — continuing execution", undefined, this.getRunContextFor(task.id));
              return;
            } catch (reducedErr: unknown) {
              const reducedErrorMessage = reducedErr instanceof Error ? reducedErr.message : String(reducedErr);
              if (!isContextLimitError(reducedErrorMessage)) {
                executorLog.error(`${task.id} reduced-prompt recovery also failed: ${reducedErrorMessage}`);
                await this.store.logEntry(task.id, `Reduced-prompt recovery failed: ${reducedErrorMessage}`, undefined, this.getRunContextFor(task.id));
                // Non-context failure — fall through to mark task as failed
              } else {
                // Still a context error — the session is saturated beyond recovery.
                // Fall through to the fresh-session requeue path below.
                executorLog.warn(`${task.id} session still saturated after reduced-prompt retry — will attempt fresh-session requeue`);
                await this.store.logEntry(task.id, `Reduced-prompt retry still over context — will attempt fresh-session requeue`, undefined, this.getRunContextFor(task.id));
              }
            }
          }
        }

        // Fresh-session requeue for context-limit errors: the saturated session
        // cannot be salvaged, but the task's git state is intact. Move the task
        // back to todo so the next scheduling pass creates a new session.
        if (isContextError) {
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            executorLog.warn(`⚡ ${task.id} context-overflow fresh-session requeue ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}`);
            await this.store.logEntry(task.id, `Context-overflow fresh-session requeue (${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, this.getRunContextFor(task.id));
            // Retain the worktree and accumulated step progress so the fresh
            // session resumes where the saturated one left off, but clear
            // sessionFile synchronously here so the next dispatch is forced
            // to spawn a brand-new session instead of reopening the
            // over-context one. The session-end finally block also clears
            // sessionFile, but it runs as fire-and-forget — if moveTask
            // wins the task lock first, the next executor pass would
            // observe a stale sessionFile and resume into the saturated
            // session, looping on the same context-limit failure.
            await this.store.updateTask(task.id, {
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
              sessionFile: null,
            });
            this.markGraphExecuteSelfRequeued(task.id);
            await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveResumeState: true });
            return;
          }

          executorLog.error(`✗ ${task.id} context-overflow requeue budget exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorMessage}`);
          await this.store.logEntry(task.id, `Context-overflow requeues exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`, undefined, this.getRunContextFor(task.id));
          // Reset so downstream failure path can persist cleanly
          await this.store.updateTask(task.id, {
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          // Fall through to terminal failure marking
        // Contamination recovery lives in executor because branch cross-contamination
        // is surfaced here from task execution preflight; merger empty-cherry-pick
        // handling does not throw BranchCrossContaminationError in its own path.
        } else if (err instanceof BranchCrossContaminationError) {
          const details = err.foreignCommits
            .map((commit) => `${commit.sha.slice(0, 12)}:${commit.foreignTaskId}`)
            .join(", ");
          await this.store.logEntry(task.id, `[recovery] branch cross-contamination detected on ${err.branchName} since ${err.baseSha}: ${details}`, undefined, this.getRunContextFor(task.id));

          try {
            const recoveredBootstrapMisbinding = await this.tryBootstrapMisbindingRecovery(task, err, audit);
            if (recoveredBootstrapMisbinding) {
              return;
            }

            const classified = await classifyForeignCommits({
              repoDir: this.rootDir,
              branchName: err.branchName,
              baseSha: err.baseSha,
              foreignCommits: err.foreignCommits,
            });

            const misrouted: Array<{ commit: (typeof classified.unique)[number]; foreignTaskId: string; paths: string[] }> = [];
            const preOrphanUnique: typeof classified.unique = [];
            for (const commit of classified.unique) {
              const misroutedResult = await classifyMisroutedForeignCommit({
                repoDir: this.rootDir,
                sha: commit.sha,
                commitSubject: commit.subject,
                commitBody: await execAsync(`git log -1 --format=%b ${commit.sha}`, { cwd: this.rootDir, encoding: "utf-8" }).then((r) => r.stdout).catch(() => ""),
                currentTaskId: task.id,
              });
              if (misroutedResult.misrouted && misroutedResult.foreignTaskId) {
                misrouted.push({ commit, foreignTaskId: misroutedResult.foreignTaskId, paths: misroutedResult.paths ?? [] });
              } else {
                preOrphanUnique.push(commit);
              }
            }

            // Orphan-our-advance: a "unique" foreign commit attributed to a
            // task that's already `done` is a stranded merge from the pre-FF
            // ref-advance bug. FF-rehomeable orphans are advanced onto the
            // integration branch and then dropped from this task's branch
            // alongside already-upstream commits. Non-FF orphans (diverged
            // from current integration tip) are logged with a cherry-pick
            // hint and left as `genuinelyUnique` for human adjudication.
            const rehomedOrphans: typeof classified.unique = [];
            const genuinelyUnique: typeof classified.unique = [];
            const integrationBranchForOrphan = task.mergeDetails?.mergeTargetBranch
              ?? task.baseBranch
              ?? "main";
            for (const commit of preOrphanUnique) {
              const orphanBody = await execAsync(`git log -1 --format=%b ${commit.sha}`, { cwd: this.rootDir, encoding: "utf-8" })
                .then((r) => r.stdout)
                .catch(() => "");
              const orphanClass = await classifyOrphanOurAdvance({
                repoDir: this.rootDir,
                taskStore: this.store,
                integrationBranch: integrationBranchForOrphan,
                currentTaskId: task.id,
                commitSha: commit.sha,
                commitSubject: commit.subject,
                commitBody: orphanBody,
              });
              if (!orphanClass.orphan) {
                genuinelyUnique.push(commit);
                continue;
              }
              const rehome = await rehomeOrphanOntoIntegration({
                rootDir: this.rootDir,
                projectRootDir: this.rootDir,
                integrationBranch: integrationBranchForOrphan,
                orphanSha: commit.sha,
                taskId: task.id,
                audit,
              }).catch((rehomeError: unknown): { rehomed: false; reason: string } => ({
                rehomed: false,
                reason: rehomeError instanceof Error ? rehomeError.message : String(rehomeError),
              }));
              if (rehome.rehomed) {
                rehomedOrphans.push(commit);
                await this.store.logEntry(
                  task.id,
                  `[recovery] rehomed orphan-our-advance commit ${commit.sha.slice(0, 12)} (source ${orphanClass.sourceTaskId}) onto ${integrationBranchForOrphan} via fast-forward; dropping from branch`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
              } else {
                const hint = "cherryPickHint" in rehome && rehome.cherryPickHint
                  ? ` — manual rehome: \`${rehome.cherryPickHint}\``
                  : "";
                await this.store.logEntry(
                  task.id,
                  `[recovery] orphan-our-advance commit ${commit.sha.slice(0, 12)} (source ${orphanClass.sourceTaskId}) refused auto-rehome: ${rehome.reason}${hint}`,
                  undefined,
                  this.getRunContextFor(task.id),
                );
                genuinelyUnique.push(commit);
              }
            }

            const alreadyShas = classified.alreadyUpstream.map((commit) => commit.sha.slice(0, 12)).join(", ") || "none";
            const misroutedShas = misrouted.map(({ commit }) => commit.sha.slice(0, 12)).join(", ") || "none";
            const rehomedShas = rehomedOrphans.map((commit) => commit.sha.slice(0, 12)).join(", ") || "none";
            const uniqueShas = genuinelyUnique.map((commit) => commit.sha.slice(0, 12)).join(", ") || "none";
            await this.store.logEntry(
              task.id,
              `[recovery] contamination classification: already-upstream=[${alreadyShas}] misrouted=[${misroutedShas}] rehomed-orphan=[${rehomedShas}] unique=[${uniqueShas}]`,
              undefined,
              this.getRunContextFor(task.id),
            );

            const alreadyAttemptedRecovery = (task.recoveryRetryCount ?? 0) > 0;
            if (genuinelyUnique.length === 0 && !alreadyAttemptedRecovery) {
              // Run the recovery inside the worktree (when one exists) so the final
              // `git checkout <branch>` step doesn't collide with the worktree's own
              // checkout. If we operate from this.rootDir while the branch is checked
              // out in a worktree, git refuses the recheckout with
              // "branch already used by worktree" and the in-line happy path silently
              // fails — every contaminated task would then fall through to the
              // dispatcher pause path even when it could have auto-recovered.
              const recoveryRepoDir = task.worktree ?? this.rootDir;
              const recovery = await autoRecoverCrossContamination({
                repoDir: recoveryRepoDir,
                branchName: err.branchName,
                baseSha: err.baseSha,
                taskId: task.id,
                shasToDrop: [
                  ...classified.alreadyUpstream.map((commit) => commit.sha),
                  ...misrouted.map(({ commit }) => commit.sha),
                  ...rehomedOrphans.map((commit) => commit.sha),
                ],
              });

              await this.store.logEntry(
                task.id,
                `[recovery] auto-recovered branch-cross-contamination: dropped ${recovery.droppedShas.length} commits (already-upstream + misrouted, SHAs: ${recovery.droppedShas.map((sha) => sha.slice(0, 12)).join(", ")}); new tip ${recovery.newTipSha.slice(0, 12)}`,
                undefined,
                this.getRunContextFor(task.id),
              );

              for (const dropped of misrouted) {
                await audit.database({
                  type: "task:auto-recover-misrouted-foreign-commit",
                  target: task.id,
                  metadata: {
                    droppedSha: dropped.commit.sha,
                    foreignTaskId: dropped.foreignTaskId,
                    paths: dropped.paths,
                  },
                });
              }

              await this.store.updateTask(task.id, {
                recoveryRetryCount: 1,
                nextRecoveryAt: null,
                paused: false,
                pausedReason: null,
                error: null,
              });
              // FN-4939: preserve the worktree across requeue. The recovery operated
              // inside the worktree (re-anchored the branch and re-checked it out), so
              // the worktree directory remains internally consistent and usable. Nulling
              // task.worktree here was the root cause of transient
              // `no-worktree-no-merge-confirmed` stall signals — a live mapped worktree
              // would still exist on disk while task.worktree was null, and downstream
              // classifiers (in-review-stall.ts, TaskChangesTab) cannot distinguish
              // "worktree gone" from "pointer not yet repopulated". Matches sibling
              // recovery paths in auto-recovery-handlers/contamination.ts,
              // tryBootstrapMisbindingRecovery, and self-healing reclaim.
              this.markGraphExecuteSelfRequeued(task.id);
              await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveResumeState: true, preserveWorktree: true });
              return;
            }

            if (alreadyAttemptedRecovery) {
              await this.store.logEntry(
                task.id,
                "[recovery] auto-recovery already attempted; escalating to human adjudication",
                undefined,
                this.getRunContextFor(task.id),
              );
            } else if (genuinelyUnique.length > 0) {
              await this.store.logEntry(
                task.id,
                `[recovery] unique foreign commits require human adjudication: ${genuinelyUnique.map((commit) => commit.sha.slice(0, 12)).join(", ")}`,
                undefined,
                this.getRunContextFor(task.id),
              );
            }
          } catch (recoveryError: unknown) {
            const recoveryMessage = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
            await this.store.logEntry(task.id, `[recovery] contamination auto-recovery failed: ${recoveryMessage}`, undefined, this.getRunContextFor(task.id));
          }

          const autoRecoveryDispatcher = this.getAutoRecoveryDispatcher(audit);
          const ownCommits = err.foreignCommits.filter((commit) => commit.foreignTaskId === task.id).length;
          const foreignAttributedCommits = err.foreignCommits.filter((commit) => commit.foreignTaskId !== task.id).length;
          const foreignOnlyClassification = (task.branch && task.baseCommitSha)
            ? await classifyForeignOnlyContamination({
              repoDir: this.rootDir,
              branchName: task.branch,
              baseSha: task.baseCommitSha,
              taskId: task.id,
            }).catch(() => null)
            : null;
          const decision = await autoRecoveryDispatcher.dispatch({
            class: "branch-cross-contamination",
            taskId: task.id,
            runId: this.getRunContextFor(task.id)?.runId,
            pausedReason: "branch-cross-contamination",
            evidence: {
              ownCommits,
              foreignAttributedCommits,
              foreignOnlyKind: foreignOnlyClassification?.kind,
            },
            underlyingError: err,
          }, {
            task,
            retryCount: task.recoveryRetryCount ?? 0,
            settings: (await this.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
          });
          if (decision.action === "pause") {
            await this.store.updateTask(task.id, {
              status: "failed",
              error: err.message,
              paused: true,
              pausedReason: "branch-cross-contamination",
            });
          }
          return;
        } else if (isBranchConflictError(err)) {
          const conflictCount = (this.branchConflictErrorCount.get(task.id) ?? 0) + 1;
          this.branchConflictErrorCount.set(task.id, conflictCount);

          if (conflictCount > this.BRANCH_CONFLICT_TRIPWIRE_THRESHOLD) {
            const details = [
              `branch=${err.branchName}`,
              `worktree=${err.conflictingWorktreePath}`,
              `existingTipSha=${err.existingTipSha}`,
              `startPoint=${err.startPoint}`,
            ].join(" ");
            const tripwireMessage = `Branch conflict tripwire fired after ${conflictCount} events (threshold ${this.BRANCH_CONFLICT_TRIPWIRE_THRESHOLD}). ${details}`;
            await this.store.logEntry(task.id, `[recovery] ${tripwireMessage}`, undefined, this.getRunContextFor(task.id));
            const autoRecoveryDispatcher = this.getAutoRecoveryDispatcher(audit);
            const decision = await autoRecoveryDispatcher.dispatch({
              class: "branch-conflict-tripwire",
              taskId: task.id,
              runId: this.getRunContextFor(task.id)?.runId,
              pausedReason: "branch-conflict-tripwire",
              evidence: {
                branchName: err.branchName,
                conflictingWorktreePath: err.conflictingWorktreePath,
              },
              underlyingError: err,
            }, {
              task,
              retryCount: task.recoveryRetryCount ?? 0,
              settings: (await this.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
            });
            if (decision.action === "pause") {
              await this.store.updateTask(task.id, {
                status: "failed",
                error: tripwireMessage,
                paused: true,
                pausedReason: "branch-conflict-tripwire",
              });
            }
            return;
          }

          let outcome: "retry" | "reclaimed" | "sticky" = "sticky";
          for (let attempt = 1; attempt <= this.MAX_AUTO_RECOVERY_ATTEMPTS; attempt += 1) {
            outcome = await this.handleBranchConflict(task, err);
            if (outcome !== "retry") break;
            await this.store.logEntry(task.id, `[recovery] ${task.id} branch-conflict auto-retry requested (${attempt}/${this.MAX_AUTO_RECOVERY_ATTEMPTS})`, undefined, this.getRunContextFor(task.id));
            const taskForRetry = await this.store.getTask(task.id);
            await recordRetry({
              store: this.store,
              settings: await this.store.getSettings(),
              task: taskForRetry,
              category: "branchConflict",
              role: "executor",
              agentId: task.assignedAgentId ?? undefined,
              attempt,
            });
          }
          if (outcome === "retry") {
            const autoRecoveryDispatcher = this.getAutoRecoveryDispatcher(audit);
            const decision = await autoRecoveryDispatcher.dispatch({
              class: "branch-conflict-recovery-exhausted",
              taskId: task.id,
              runId: this.getRunContextFor(task.id)?.runId,
              pausedReason: "branch-conflict-recovery-exhausted",
              evidence: {
                branchName: err.branchName,
                conflictingWorktreePath: err.conflictingWorktreePath,
              },
              underlyingError: err,
            }, {
              task,
              retryCount: task.recoveryRetryCount ?? 0,
              settings: (await this.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
            });
            if (decision.action === "pause") {
              await this.store.updateTask(task.id, {
                status: "failed",
                error: err.message,
                paused: true,
                pausedReason: "branch-conflict-recovery-exhausted",
              });
            }
            return;
          }
          return;
        } else if (await this.handleNonContinuableSessionError(task, taskDone, errorMessage)) {
          return;
        } else if (await this.handleNonContinuableSessionRetry(task, errorMessage)) {
          return;
        } else if (this.options.usageLimitPauser && isUsageLimitError(errorMessage)) {
          await this.options.usageLimitPauser.onUsageLimitHit("executor", task.id, errorMessage);
        } else if (isTransientError(errorMessage)) {
          // Transient network/infrastructure error — use bounded recovery policy
          const decision = computeRecoveryDecision({
            recoveryRetryCount: task.recoveryRetryCount,
            nextRecoveryAt: task.nextRecoveryAt,
          });

          if (decision.shouldRetry) {
            const attempt = decision.nextState.recoveryRetryCount;
            const delay = formatDelay(decision.delayMs);
            // Silent transient errors (e.g., "request was aborted") are noisy — skip logging
            if (!isSilentTransientError(errorMessage)) {
              executorLog.warn(`⚡ ${task.id} transient error — retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}: ${errorMessage}`);
              await this.store.logEntry(task.id, `Transient error (retry ${attempt}/${MAX_RECOVERY_RETRIES} in ${delay}): ${errorMessage}`, undefined, this.getRunContextFor(task.id));
            }
            // Clean up the old worktree so the retry gets a fresh one
            if (worktreePath && existsSync(worktreePath)) {
              try {
                const settings = await this.store.getSettings();
                await removeWorktree({
                  worktreePath,
                  rootDir: this.rootDir,
                  settings,
                  taskId: task.id,
                  audit,
                  reason: RemovalReason.ExecutorTransientRetry,
                  expectedOwnerTaskId: task.id,
                  liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
                });
                executorLog.log(`Removed old worktree for transient retry: ${worktreePath}`);
              } catch (cleanupErr: unknown) {
                const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
              }
            }
            await this.store.updateTask(task.id, {
              recoveryRetryCount: decision.nextState.recoveryRetryCount,
              nextRecoveryAt: decision.nextState.nextRecoveryAt,
              worktree: null,
              branch: null,
            });
            this.markGraphExecuteSelfRequeued(task.id);
            await this.store.moveTask(task.id, await resolveReboundColumnFor(this.store, task.id), { preserveProgress: true });
            return;
          }

          // Recovery budget exhausted — escalate to real failure
          executorLog.error(`✗ ${task.id} transient error retries exhausted (${MAX_RECOVERY_RETRIES} attempts): ${errorDetail}`);
          await this.store.logEntry(task.id, `Transient error retries exhausted after ${MAX_RECOVERY_RETRIES} attempts: ${errorMessage}`, errorStack ?? errorDetail, this.getRunContextFor(task.id));
          await this.store.updateTask(task.id, {
            status: "failed",
            error: errorMessage,
            recoveryRetryCount: null,
            nextRecoveryAt: null,
          });
          await this.persistTokenUsage(task.id);
          executorLog.log(`✗ ${task.id} transient retries exhausted — failed in execution`);
          this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
          return;
        }
        const terminalError = err instanceof RetryStormError
          ? JSON.stringify(serializeRetryStormError(err))
          : errorMessage;
        executorLog.error(`✗ ${task.id} execution failed:`, errorDetail);
        await this.store.logEntry(task.id, `Execution failed: ${terminalError}`, errorStack ?? errorDetail, this.getRunContextFor(task.id));
        await this.store.updateTask(task.id, { status: "failed", error: terminalError });
        await this.persistTokenUsage(task.id);
        executorLog.log(`✗ ${task.id} execution failed`);
        this.options.onError?.(task, err instanceof Error ? err : new Error(errorMessage));
      }
    } finally {
      if (reviewAddressingActivated) {
        const latestTask = await this.store.getTask(task.id);
        if (taskDone) {
          await this.transitionReviewAddressing(task.id, ["in-progress", "queued"], "addressed");
        } else if (latestTask.status === "failed") {
          await this.transitionReviewAddressing(task.id, ["in-progress", "queued"], "failed");
        }
      }

      /*
      FNXC:GlobalConcurrencyControls 2026-07-15-02:55:
      Belt-and-suspenders for graph→legacy pre-held handoff inside the lock-claimed try:
      release any still-registered slot before lock/executing cleanup. execute()'s outer
      finally also drops (no-op once take/drop already cleared the registration).
      */
      if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release();

      this.executing.delete(task.id);
      executingTaskLock.release(task.id);
      // Clear run context at end of execute() lifecycle
      this.currentRunContexts.delete(task.id);
      // U5 (R6) leak guard: effectiveColumnAgentByTask is set() in the outer execute()
      // scope (execute-seam ~6191, step-session ~5674) BEFORE the session-entry try
      // whose finally (deleteActiveSession / deleteActiveStepExecutor) normally clears
      // it. A throw between the set() and that try would otherwise leak the entry and
      // permanently block the column agent's heartbeat ticks. Deleting here in the
      // outer finally covers BOTH paths since both run inside execute().
      this.effectiveColumnAgentByTask.delete(task.id);

      // Terminate all spawned child agents on ALL exit paths.
      // This must run here (in the outer finally) rather than only in agentWork's
      // finally block, because failures during worktree creation or before
      // agentWork is entered leave children orphaned with no other cleanup path.
      try {
        await this.terminateAllChildren(task.id);
      } catch (err) {
        executorLog.warn(`terminateAllChildren failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Reset loop recovery state at end of execute() lifecycle.
      // State is in-memory and per-run — should not persist across attempts.
      this.loopRecoveryState.delete(task.id);
      this.tokenUsageBaselines.delete(task.id);

      if (taskDone) {
        this.branchConflictErrorCount.delete(task.id);
      } else {
        const latestTask = await this.store.getTask(task.id);
        if ((await resolveTerminalColumnsFor(this.store, task.id)).includes(latestTask.column)) {
          this.branchConflictErrorCount.delete(task.id);
        }
      }

      // Requeue stale assistant-continuation sessions AFTER this.executing is cleared.
      // Moving the task while the execution guard is still held can cause the scheduler's
      // task:moved dispatch to no-op, stranding the task in todo with no fresh run.
      if (staleAssistantContinuationRequeue) {
        /*
        FNXC:ExecutorSessionRecovery 2026-07-14-06:26:
        Claim the process-wide executor lock for deferred cleanup, release it immediately before moveTask emits task:moved, and always drop the claim on errors. This closes the guard-release race without recreating the original no-op dispatch: a fresh retry cannot start while stale state is being cleared, but can claim the task when the committed move event fires.

        FNXC:ExecutorSessionRecovery 2026-07-14-06:34:
        Release the stale run's activeWorktrees slot before releasing the executor lock. Once the lock is open, the fresh retry may install its own slot while moveTask dispatches; deleting afterward would erase the new run's capacity and liveness tracking.
        */
        const cleanupClaimed = executingTaskLock.tryClaim(task.id);
        if (!cleanupClaimed) {
          executorLog.debug(`${task.id} stale assistant-continuation requeue skipped — a fresh executor already claimed the task`);
        } else {
          let cleanupLockHeld = true;
          try {
            const latestTask = await this.store.getTask(task.id);
            const continuationLanes = await this.resolveResumeLanes(task.id);
            if (latestTask.column === continuationLanes.wip || latestTask.column === continuationLanes.hold) {
              await this.store.updateTask(task.id, {
                sessionFile: null,
                status: null,
                error: null,
              });
              const continuationReboundColumn = await resolveReboundColumnFor(this.store, task.id);
              if (latestTask.column !== continuationReboundColumn) {
                this.markGraphExecuteSelfRequeued(task.id);
                this.activeWorktrees.delete(task.id);
                executingTaskLock.release(task.id);
                cleanupLockHeld = false;
                await this.store.moveTask(task.id, continuationReboundColumn, { preserveResumeState: true });
              } else {
                this.activeWorktrees.delete(task.id);
              }
              executorLog.log(`${task.id} stale assistant-continuation session cleared — requeued to ${continuationReboundColumn} with progress preserved`);
            } else {
              executorLog.debug(`${task.id} stale assistant-continuation requeue skipped — task is now in '${latestTask.column}'`);
            }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            executorLog.error(`Failed to requeue stale assistant-continuation task ${task.id}: ${errorMessage}`);
          } finally {
            if (cleanupLockHeld) {
              executingTaskLock.release(task.id);
            }
          }
        }
      }

      // Requeue stuck-killed task AFTER this.executing is cleared.
      // This prevents the race where the scheduler re-dispatches the task
      // (via task:moved → execute()) while the old execution guard is still set,
      // which caused the new execute() call to silently no-op, stranding the
      // task in "in-progress" with no active session or worktree.
      if (stuckRequeue === true) {
        if (this.userCanceledTaskIds.has(task.id)) {
          this.clearPausedAborted(task.id);
          this.stuckAborted.delete(task.id);
          this.userCanceledTaskIds.delete(task.id);
          await this.store.logEntry(task.id, "Execution canceled by user — leaving task in todo");
        } else {
          try {
          // Re-read latest task state. While this execute() invocation was
          // unwinding, self-healing (e.g. recoverCompletedTasks) may have
          // already transitioned the task to in-review or done. Continuing
          // the stuck-requeue cleanup in that case would destroy the worktree
          // the recovery now relies on and clobber the task back to todo with
          // all step progress reset, undoing valid completion. Skip the
          // entire cleanup if the column has moved on past in-progress/todo.
          const latestTask = await this.store.getTask(task.id);
          const outerRequeueLanes = await this.resolveResumeLanes(task.id);
          if (latestTask.column !== outerRequeueLanes.wip && latestTask.column !== outerRequeueLanes.hold) {
            executorLog.log(
              `${task.id} stuck-requeue skipped — task is now in '${latestTask.column}' (recovered concurrently)`,
            );
          } else {
            const settings = await this.store.getSettings();
            const preserveProgress = settings.preserveProgressOnStuckRequeue !== false;

            /*
            FNXC:StuckRequeue 2026-06-27-23:15:
            Preserve-progress stuck requeues still remove the old checkout. Reconcile steps first so uncommitted-only output is reset to pending while committed progress can remain complete.
            */
            await this.resetStepsIfWorkLost(latestTask);

            // Clean up the old worktree so the retry gets a fresh one
            if (worktreePath && existsSync(worktreePath)) {
              try {
                await removeWorktree({
                  worktreePath,
                  rootDir: this.rootDir,
                  settings,
                  taskId: task.id,
                  audit,
                  reason: RemovalReason.ExecutorStuckKilled,
                  expectedOwnerTaskId: task.id,
                  liveOwnerProbe: (path, ownerTaskId) => this.hasActiveWorktreeBinding(ownerTaskId, path),
                });
                executorLog.log(`Removed old worktree for stuck-killed retry: ${worktreePath}`);
              } catch (cleanupErr: unknown) {
                const cleanupErrMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
                executorLog.warn(`Failed to remove old worktree ${worktreePath}: ${cleanupErrMessage}`);
              }
            }
            await this.store.updateTask(task.id, {
              status: "queued",
              error: null,
              worktree: null,
              branch: null,
            });
            // Only move to todo if not already there. Use the freshly-read
            // latestTask.column rather than the stale captured task.column —
            // the captured snapshot can be hours old and would race against
            // any concurrent recovery (see comment above).
            const stuckReboundColumn = await resolveReboundColumnFor(this.store, task.id);
            if (latestTask.column !== stuckReboundColumn) {
              this.markGraphExecuteSelfRequeued(task.id);
              await this.store.moveTask(task.id, stuckReboundColumn, preserveProgress ? { preserveProgress: true } : undefined);
              /*
              Audit trail: record task move (FN-1404).
              FNXC:WorkflowLifecycleColumns 2026-07-30-15:15: `to` records the column the card was
              ACTUALLY moved to. It was hardcoded `"todo"` while the move target was already
              resolved from the workflow, so on a renamed board the audit row named a column the
              move never touched — a run-audit trail that disagrees with the move it describes is
              worse than none, because it is the record an operator reaches for afterwards.
              */
              await audit.database({ type: "task:move", target: task.id, metadata: { to: stuckReboundColumn } });
              executorLog.log(`${task.id} moved to ${stuckReboundColumn} for retry after stuck kill${preserveProgress ? " (progress preserved)" : ""}`);
            } else {
              executorLog.debug(`${task.id} already in ${stuckReboundColumn} — skipping redundant move`);
            }
          }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            executorLog.error(`Failed to requeue stuck task ${task.id}: ${errorMessage}`);
          }
        }
      }

      /*
       * FNXC:AgentGating 2026-07-12-17:12:
       * MAIN-008 closes the approval-decision/unwind race. The dashboard can
       * unpause while the original executor still owns its process-wide lock;
       * consume that single deferred edge only after every old-session cleanup
       * path above has run, then bootstrap one new executor session. A Set plus
       * resumingUnpaused makes duplicate task updates idempotent.
       */
      await this.resumeApprovalAfterUnwindIfNeeded(task.id);
    }
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

  private createTaskLogTool(taskId: string): ToolDefinition {
    return sharedCreateTaskLogTool(this.store, taskId);
  }

  private createTaskLogsReadTool(taskId: string): ToolDefinition {
    return sharedCreateTaskLogsReadTool(this.store, taskId);
  }

  /*
  FNXC:EphemeralAgentTaskCreation 2026-07-01-00:00:
  A task-execution session is an ephemeral worker when no permanent identity agent governs it (default executor-FN-XXXX worker) or the governing agent is itself ephemeral. Pass that through so fn_task_create honors the project `ephemeralAgentsCanCreateTasks` toggle; permanent-agent sessions are never gated.
  */
  private createTaskCreateTool(callerIsEphemeral: boolean, sourceTaskId?: string, sourceAgentId?: string): ToolDefinition {
    return sharedCreateTaskCreateTool(this.store, { sourceType: "api", sourceAgentId, sourceParentTaskId: sourceTaskId }, { rootDir: this.rootDir, callerIsEphemeral, sourceTaskId, sourceAgentId, messageStore: this.options.messageStore });
  }

  private createTaskDocumentWriteTool(taskId: string): ToolDefinition {
    return sharedCreateTaskDocumentWriteTool(this.store, taskId);
  }

  private createTaskDocumentReadTool(taskId: string): ToolDefinition {
    return sharedCreateTaskDocumentReadTool(this.store, taskId);
  }

  private createTaskPromptWriteTool(taskId: string): ToolDefinition {
    return sharedCreateTaskPromptWriteTool(this.store, taskId, this.getRunContextFor(taskId));
  }

  private createTaskFileScopeAddTool(taskId: string): ToolDefinition {
    return sharedCreateTaskFileScopeAddTool(this.store, taskId, this.getRunContextFor(taskId));
  }

  /*
  FNXC:ArtifactRegistry 2026-07-10-14:30:
  Executor-lane registration anchors relative `path` payloads at the task worktree (where the agent
  saves screenshots/wireframes/mocks) and defaults taskId to the executing task so agent-produced
  media surfaces in the per-task Artifacts tab without the agent having to repeat its own task id.
  */
  private createArtifactRegisterTool(authorId: string, taskId: string, worktreePath: string): ToolDefinition {
    return sharedCreateArtifactRegisterTool(this.store, authorId, this.options.messageStore, {
      baseDir: worktreePath,
      defaultTaskId: taskId,
    });
  }

  private createArtifactListTool(): ToolDefinition {
    return sharedCreateArtifactListTool(this.store);
  }

  private createArtifactViewTool(): ToolDefinition {
    return sharedCreateArtifactViewTool(this.store);
  }

  private createWorkflowListTool(): ToolDefinition {
    return sharedCreateWorkflowListTool(this.store);
  }

  private createWorkflowGetTool(): ToolDefinition {
    return sharedCreateWorkflowGetTool(this.store);
  }

  private createWorkflowValidateTool(): ToolDefinition {
    return sharedCreateWorkflowValidateTool(this.store);
  }

  private createWorkflowSelectTool(taskId: string): ToolDefinition {
    return sharedCreateWorkflowSelectTool(this.store, taskId);
  }

  private createTaskPromoteTool(taskId: string): ToolDefinition {
    return sharedCreateTaskPromoteTool(this.store, taskId);
  }

  private createWorkflowCreateTool(): ToolDefinition {
    return sharedCreateWorkflowCreateTool(this.store);
  }

  private createWorkflowUpdateTool(): ToolDefinition {
    return sharedCreateWorkflowUpdateTool(this.store);
  }

  private createWorkflowDeleteTool(): ToolDefinition {
    return sharedCreateWorkflowDeleteTool(this.store);
  }

  private createWorkflowSettingsTool(): ToolDefinition {
    return sharedCreateWorkflowSettingsTool(this.store);
  }

  private createTraitListTool(): ToolDefinition {
    return sharedCreateTraitListTool();
  }

  private createTaskAddDepTool(taskId: string): ToolDefinition {
    return createTaskAddDepToolImpl(
      {
        store: this.store,
        depAborted: this.depAborted,
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
    return {
      rootDir: this.rootDir,
      store: this.store,
      workspaceConfig: this.workspaceConfig,
      getActiveWorktreePaths: (taskId: string) => this.getActiveWorktreePaths(taskId),
      getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
      emitWorktreeReanchoredAudit: (
        taskId: string,
        fromPath: string,
        toPath: string,
        source: "verify-worktree-invariants" | "executor-liveness-gate",
      ) => this.emitWorktreeReanchoredAudit(taskId, fromPath, toPath, source),
    };
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
        store: this.store,
        workspaceConfig: this.workspaceConfig,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
        captureUncommittedModifiedFiles: (wp: string) => this.captureUncommittedModifiedFiles(wp),
        captureModifiedFiles: (wp, base, taskId, a, source) =>
          this.captureModifiedFiles(wp, base, taskId, a, source),
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
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
        markGraphExecuteSelfRequeued: (taskId: string) => this.markGraphExecuteSelfRequeued(taskId),
        persistTokenUsage: (taskId: string) => this.persistTokenUsage(taskId),
        deleteActiveSession: (taskId: string) => this.deleteActiveSession(taskId),
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
      {
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
        workflowLifecycleMovesInFlight: this.workflowLifecycleMovesInFlight,
        persistTokenUsage: (id) => this.persistTokenUsage(id),
        getTaskCompletionBlocker: (task) => this.getTaskCompletionBlocker(task),
        evaluateTaskVerdictProviders: (task, opts) => this.evaluateTaskVerdictProviders(task, opts),
        verifyWorktreeInvariants: (task, wt, strict, opts) => this.verifyWorktreeInvariants(task, wt, strict, opts),
        evaluateTaskDoneScopeLeak: (task, wt, prompt, settings, a) => this.evaluateTaskDoneScopeLeak(task, wt, prompt, settings, a),
        scheduleCompletedTaskWatchdog: (id, source) => this.scheduleCompletedTaskWatchdog(id, source),
      },
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
        rootDir: this.rootDir,
        store: this.store,
        activeWorktrees: this.activeWorktrees,
        removeOwnWorktreeWithReconcile: (input) => this.removeOwnWorktreeWithReconcile(input),
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
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
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
        getRunContextFor: (id) => this.getRunContextFor(id),
        getAssignedAgentRuntimeConfig: (id) => this.getAssignedAgentRuntimeConfig(id),
        resolveMcpServers: (id) => this.resolveMcpServers(id),
        runExecutorDeterministicVerification: (t, wt, st, env) =>
          this.runExecutorDeterministicVerification(t, wt, st, env),
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
        clearCompletedTaskWatchdog: (taskId: string) => this.clearCompletedTaskWatchdog(taskId),
        injectWorkflowStepFailureInstructions: (t, fb, sn, r) => this.injectWorkflowStepFailureInstructions(t, fb, sn, r),
        reopenLastStepForRevision: (taskId, t) => this.reopenLastStepForRevision(taskId, t),
        scheduleWorkflowRerun: (taskId, wp, msg, preserve) => this.scheduleWorkflowRerun(taskId, wp, msg, preserve),
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
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
        registerConfiguredCommandController: (taskId, controller) =>
          this.registerConfiguredCommandController(taskId, controller),
        unregisterConfiguredCommandController: (taskId, controller) =>
          this.unregisterConfiguredCommandController(taskId, controller),
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
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
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
    let toolMode: "coding" | "readonly" = workflowStep.toolMode || "readonly";
    // (U3) Genuinely-unattended run — set FUSION_HEADLESS=1 below so skills record
    // assumptions and proceed instead of parking on a question. Explicit opt-in
    // only (default false = board run); see runGraphCustomNode / KTD-3.
    const unattended = stepOptions?.unattended === true;
    const isPlanReviewStep = workflowStep.id === "graph:plan-review-step" || workflowStep.name === "Plan Review";
    const workflowStepMetadata = workflowStep as WorkflowStep & {
      optionalGroupId?: string;
      reviewCanFixInline?: boolean;
      requireExternalIntegrationEvidence?: boolean;
    };
    const optionalGroupId = workflowStepMetadata.optionalGroupId;
    const isReviewTypeWorkflowStep =
      isPlanReviewStep
      || workflowStepMetadata.reviewCanFixInline === true
      || /(?:^|\b)(?:review|verification)(?:\b|$)/i.test(workflowStep.name)
      || optionalGroupId === "plan-review"
      || optionalGroupId === "code-review"
      || optionalGroupId === "browser-verification";
    const reviewerInlineFixesEnabled = (settings as Settings & { reviewerInlineFixes?: boolean }).reviewerInlineFixes !== false;
    const allowReviewerInlineFixes = reviewerInlineFixesEnabled && isReviewTypeWorkflowStep && workflowStep.mode === "prompt";
    const allowPlanReviewPromptWrite = allowReviewerInlineFixes && isPlanReviewStep;
    if (allowReviewerInlineFixes && !isPlanReviewStep) {
      /*
       * FNXC:WorkflowReviewers 2026-07-01-12:36:
       * Review-type workflow nodes can now repair their own findings when the workflow setting `reviewerInlineFixes` is on. Use coding tools for implementation review sessions so Code Review, Browser Verification, and custom review/verification gates do not have to bounce through executor remediation for issues they can safely fix inline. Plan Review stays on a narrow PROMPT.md writer because it runs before implementation.
       */
      toolMode = "coding";
    }
    const requireExternalIntegrationEvidence =
      workflowStepMetadata.requireExternalIntegrationEvidence === true;

    /*
     * FNXC:WorkflowReviewSpecInjection 2026-07-18-18:15:
     * FN-7561 established that review agents cannot reliably locate the project-root PROMPT.md from a task worktree. Load it once through the store and embed it for every review-type node. FN-8288 extends that invariant beyond Plan Review: approved planning revisions are authoritative, the original task description is historical, and a failed artifact read must stay visible instead of silently restoring superseded scope.
     */
    let workflowReviewSpecArtifact: string | undefined;
    if (isReviewTypeWorkflowStep) {
      try {
        workflowReviewSpecArtifact = await this.readTaskArtifact(task.id, "PROMPT.md");
      } catch (error) {
        const diagnostic = `PROMPT.md could not be read because task storage failed; ${workflowStep.name} must retry without replanning. ${error instanceof Error ? error.message : String(error)}`;
        await this.store.logEntry(task.id, `[pre-merge] ${workflowStep.name} artifact read failed: ${diagnostic}`);
        return {
          success: false,
          error: diagnostic,
          output: diagnostic,
          failureValue: requiredArtifactReadFailedValue("PROMPT.md"),
        };
      }
    }
    const workflowReviewSpecText = typeof workflowReviewSpecArtifact === "string" ? workflowReviewSpecArtifact : "";
    const planReviewSpecText = isPlanReviewStep ? workflowReviewSpecText : "";

    /*
    FNXC:PlanReview 2026-07-21-16:30:
    Review steps must never approve or execute against an unavailable contract. Confirmed missing or whitespace-only PROMPT.md fails closed before reviewer creation; typed recovery routes ownership back to planning without spending the review-revision budget.
    */
    if (isReviewTypeWorkflowStep && !workflowReviewSpecText.trim()) {
      const diagnostic = `PROMPT.md could not be loaded; ${workflowStep.name} cannot approve without the authoritative task contract.`;
      await this.store.logEntry(
        task.id,
        `[pre-merge] ${workflowStep.name} refused to run without PROMPT.md: ${diagnostic}`,
      );
      return {
        success: false,
        revisionRequested: true,
        output: `REVISE: ${diagnostic}`,
        verdict: "REVISE",
        notes: diagnostic,
        failureValue: requiredArtifactMissingValue(["PROMPT.md"]),
      };
    }

    if (isPlanReviewStep && requireExternalIntegrationEvidence) {
      /*
       * FNXC:PlanValidation 2026-06-30-09:03:
       * Coding (per-step review) intentionally keeps external-integration evidence as a Plan Review gate. Enforce it here, not in triage, so only workflows that set `requireExternalIntegrationEvidence` block and failures route through the graph's normal plan-replan loop.
       */
      const evidenceGaps = detectExternalIntegrationEvidenceGaps({
        promptContent: planReviewSpecText,
      });
      if (evidenceGaps.length > 0) {
        const diagnostic = formatExternalIntegrationEvidenceDiagnostic(evidenceGaps);
        const output = `REVISE: ${diagnostic}`;
        await this.store.logEntry(
          task.id,
          `[pre-merge] Plan Review deterministic external-integration evidence check requested revision: ${diagnostic}`,
        );
        return {
          success: false,
          revisionRequested: true,
          output,
          verdict: "REVISE",
          notes: diagnostic,
        };
      }
    }

    // Compute the diff scope so the workflow step agent reviews only what THIS
    // task changed — not unrelated files it might wander into. Without this,
    // open-ended review prompts (e.g. "verify visual polish") have been
    // observed to spend the entire timeout budget reading pre-existing files
    // that match the task description's keywords. See FN-3327 post-mortem.
    const scopedFiles = await this.captureModifiedFiles(worktreePath, task.baseCommitSha, task.id, undefined, "workflow-step-handler");
    let diffShortstat: string | undefined;
    try {
      const baseRef = await resolveDiffBaseRef(worktreePath, task.baseCommitSha);
      if (baseRef) {
        const { stdout } = await execAsync(`git diff --shortstat ${baseRef}..HEAD`, {
          cwd: worktreePath,
          encoding: "utf-8",
        });
        diffShortstat = stdout.trim() || undefined;
      }
    } catch {
      // best-effort — fall through with no shortstat
    }

    const MAX_SCOPE_FILES = 100;
    const scopeFileBlock = scopedFiles.length === 0
      ? "(no modified files detected for this task — review the worktree directly, but do NOT browse unrelated files)"
      : scopedFiles.length > MAX_SCOPE_FILES
        ? `${scopedFiles.slice(0, MAX_SCOPE_FILES).map((f) => `- ${f}`).join("\n")}\n- ... (${scopedFiles.length - MAX_SCOPE_FILES} more files truncated)`
        : scopedFiles.map((f) => `- ${f}`).join("\n");

    /*
     * FNXC:PlanReviewScope 2026-06-29-00:57:
     * Plan Review validates the planned PROMPT.md before execution. It must not
     * inherit the generic workflow-step diff scope, because dirty worktrees or
     * unrelated local commits can make a plan-only gate reject implementation
     * state and loop back to triage after the planner already approved the spec.
     */
    const approvedContractBlock = isReviewTypeWorkflowStep && !isPlanReviewStep
      ? `

Approved Task Contract:
- PROMPT.md is the authoritative current contract for this review. It includes any approved planning revisions and scope decisions.
- The Task Description is historical input only. Do not enforce superseded requirements from the original Task Description when they conflict with PROMPT.md.
- Do not request behavior that PROMPT.md explicitly defers, excludes, or forbids. Review the implementation against the approved contract reproduced below.
- Scope exclusions do not waive security, correctness, or data-integrity defects in the approved implementation.

--- BEGIN APPROVED PROMPT.md ---
${workflowReviewSpecText}
--- END APPROVED PROMPT.md ---`
      : "";
    const scopeBlock = isPlanReviewStep
      ? `Plan Review Scope:
- Review the task plan artifact (PROMPT.md), reproduced verbatim below, and task metadata only.
- The plan is embedded in this prompt — do NOT go looking for a PROMPT.md file in the worktree; it lives at the project root (\`.fusion/tasks/${task.id}/PROMPT.md\`), outside this worktree, so review the embedded copy.
- Do NOT judge current implementation diffs, uncommitted worktree changes, or unrelated repository changes.
- If the plan is internally consistent, complete, scoped, and verifiable, approve even when the worktree contains unrelated changes from another task.

--- BEGIN PROMPT.md ---
${planReviewSpecText}
--- END PROMPT.md ---`
      : `Diff Scope (files changed by THIS task vs base):
${scopeFileBlock}${diffShortstat ? `\nDiff stat: ${diffShortstat}` : ""}

CRITICAL SCOPING RULES — read before doing anything else:
- Review ONLY the files listed above. Do NOT analyze unmodified files or unrelated parts of the codebase.
- If NONE of the files in the diff scope are relevant to your review category (e.g. a UX/design reviewer with no UI/CSS/component files in scope, a security reviewer with no auth/network code in scope, an a11y reviewer with no markup changes), respond IMMEDIATELY with a single short approval line such as "No relevant changes in scope — approved." and STOP. Do not start exploring the codebase.
- Your wall-clock budget is short. Spending it browsing unmodified files will cause this step to time out and block merge.${approvedContractBlock}`;

    const latestTaskForUserComments = await this.store.getTask(task.id).catch(() => task);
    const workflowStepUserComments = selectUserCommentsForAgentContext(latestTaskForUserComments, { limit: null });
    const workflowStepUserCommentSection = buildUserCommentsPromptSection(workflowStepUserComments);

    /*
     * FNXC:AgentSteering 2026-06-30-14:08:
     * Prompt/custom workflow-step reviewers, including Browser Verification agents, do not call reviewStep. They still gate quality, so their system prompt must carry the same canonical uncapped user comments plus legacy steering selected from a fresh task snapshot.
     */

    // (KTD-6) Verdict-contract reconciliation. The trailing-verdict JSON is the
    // gate-parsing contract — it only matters for steps that gate merge. A skill
    // step that isn't a gate (e.g. ce-plan / ce-work / ce-compound) produces
    // skill-native output (and may emit a ===FUSION_AWAIT_INPUT=== sentinel and
    // stop), so forcing a verdict would contradict the U2 preamble. Require the
    // verdict only for gate steps (and skill-less prompt steps, which keep the
    // legacy reviewer contract); relax it for non-gate skill steps. The executor
    // runs parseAwaitInputSentinel on output regardless, so the await-input
    // sentinel always takes priority when present.
    const isSkillStep = typeof workflowStep.skillName === "string" && workflowStep.skillName.trim().length > 0;
    const isSummaryProjectionStep = (workflowStep as WorkflowStep & { summaryTarget?: string }).summaryTarget === "task";
    const requireVerdict = !isSummaryProjectionStep && (workflowStep.gateMode === "gate" || !isSkillStep);
    const verdictBlock = requireVerdict
      ? `

## Feedback Format

When your review is complete, your final line MUST be a single JSON object (no markdown fences):

{"verdict":"APPROVE|APPROVE_WITH_NOTES|REVISE","notes":"..."}

Rules:
- Output exactly one trailing JSON object and stop.
- verdict must be exactly APPROVE, APPROVE_WITH_NOTES, or REVISE.
- notes should be concise and actionable. Use an empty string when there are no notes.
- For out-of-scope fast-bail responses, use: {"verdict":"APPROVE","notes":"out of scope: no UI files changed"}

Backward compat fallback: if JSON is unavailable, you may still begin output with REQUEST REVISION to request changes.`
      : `

## Output Format

Follow the skill's own output conventions. You are NOT required to end with a
verdict JSON object — this step does not gate merge. If you need to ask the user
a question, emit a single ===FUSION_AWAIT_INPUT=== block and stop (see the
workflow-step conventions in your instructions).`;

    const inlineFixBlock = allowReviewerInlineFixes
      ? `

## Same-Session Fix Policy

This review-type node may fix issues it finds before returning a final verdict.
- If you find an in-scope issue you can fix safely, edit the relevant files in this same session, run the smallest relevant verification, and then return APPROVE or APPROVE_WITH_NOTES.
- Return REVISE only when the issue is still present, cannot be safely fixed in this reviewer session, needs broader executor remediation, or needs user input.
- Plan Review may use fn_task_prompt_write to replace the task's PROMPT.md with the complete revised plan. Do not implement product code from Plan Review.
- Code Review and Browser Verification may fix implementation issues inside the assigned task worktree and should mention the fix in notes.`
      : "";

    const systemPrompt = `You are a workflow step agent executing: ${workflowStep.name}

Task Context:
- Task ID: ${task.id}
- Task Description: ${task.description}
- Worktree: ${worktreePath}

${scopeBlock}${workflowStepUserCommentSection ? `\n\n${workflowStepUserCommentSection}` : ""}

Your role:
- Execute this workflow step exactly as scoped.
- Prioritize high-impact correctness/risk findings over stylistic nits.
- Keep feedback actionable and directly tied to evidence in files/outputs.

Your Instructions:
${workflowStep.prompt}

You have access to the file system to review changes.${inlineFixBlock}${verdictBlock}`;

    const agentLogger = new AgentLogger({
      store: this.store,
      taskId: task.id,
      agent: "reviewer",
      persistAgentToolOutput: settings.persistAgentToolOutput,
      // Review-in-executor sessions are task-scoped ephemeral workers.
      persistAgentThinkingLog: resolvePersistAgentThinkingLog(settings, { ephemeral: true }),
      onAgentText: (taskId, delta) => {
        this.options.onAgentText?.(taskId, delta);
      },
      onAgentTool: (taskId, toolName, detail) => {
        this.options.onAgentTool?.(taskId, toolName, detail);
      },
    });

    // Determine primary model and an explicit fallback. Review-type workflow
    // steps use the validator lane; ordinary workflow prompts use the executor
    // lane. A complete per-step override remains authoritative for either lane.
    // FNXC:ModelResolution 2026-06-25-12:00: FN-7039 requires ordinary workflow
    // steps to inherit project execution-lane model settings before defaults.
    // Review gates are independent validation surfaces and must not silently use
    // the same implementation model merely because they execute in this method.
    const assignedRuntimeConfig = await this.getAssignedAgentRuntimeConfig(task.assignedAgentId);
    const laneModel = isReviewTypeWorkflowStep
      ? resolveValidatorSessionModel(
          task.validatorModelProvider,
          task.validatorModelId,
          settings,
          assignedRuntimeConfig,
          task.validatorCredentialInstanceId,
        )
      : resolveExecutorSessionModel(
          task.modelProvider,
          task.modelId,
          settings,
          assignedRuntimeConfig,
          task.credentialInstanceId,
        );
    const useOverride = !!(workflowStep.modelProvider && workflowStep.modelId);
    const primaryProvider = useOverride ? workflowStep.modelProvider : laneModel.provider;
    const primaryModelId = useOverride ? workflowStep.modelId : laneModel.modelId;
    // FNXC:ProviderAuth 2026-08-01-08:39: A workflow-step model override has no paired instance selection, so only the resolved primary task lane may carry its requested credential instance. Fallback attempts must retain their provider-default behavior rather than inheriting a primary-provider identity.
    const primaryCredentialInstanceId = useOverride ? undefined : laneModel.credentialInstanceId;

    const workflowFallback = isReviewTypeWorkflowStep
      ? resolveValidatorFallbackModel(settings)
      : resolveExecutorFallbackModel(settings);
    const fallback = workflowFallback.provider && workflowFallback.modelId
      && (workflowFallback.provider !== primaryProvider || workflowFallback.modelId !== primaryModelId)
      ? workflowFallback
      : undefined;
    const fallbackSettingsHint = isReviewTypeWorkflowStep
      ? "settings.validatorFallbackProvider/validatorFallbackModelId or fallbackProvider/fallbackModelId"
      : "settings.executionFallbackProvider/executionFallbackModelId or fallbackProvider/fallbackModelId";
    const fallbackLaneLabel = isReviewTypeWorkflowStep ? "validator" : "executor";

    const timeoutMs = Math.max(60_000, settings.workflowStepTimeoutMs ?? 900_000);

    const runOnce = async (
      provider: string | undefined,
      modelId: string | undefined,
      attemptLabel: string,
    ): Promise<WorkflowStepOutcome> => {
      const stepInstructions = await this.resolveInstructionsForRole("executor", settings);
      const stepSystemPrompt = buildSystemPromptWithInstructions(systemPrompt, stepInstructions);

      // Build skill selection context for workflow step session
      const skillContext = await buildSessionSkillContext({
        agentStore: this.options.agentStore!,
        task,
        sessionPurpose: "executor",
        projectRootDir: this.rootDir,
        pluginRunner: this.options.pluginRunner,
      });

      const workflowAgent = await this.getAuthoritativeAssignedAgent(task.assignedAgentId);
      const workflowRuntimeHint = extractRuntimeHint(workflowAgent?.runtimeConfig);
      // Signal to skills running in this step (e.g. compound-engineering ce-plan /
      // ce-work) that they are inside a Fusion autonomous workflow step, NOT an
      // interactive Claude Code session. There is no synchronous blocking-question
      // tool here, so a skill must surface user questions via the await-input
      // convention (which the dashboard / task card renders) instead of calling
      // AskUserQuestion into the void. Scoped to the step session — the main
      // executor session deliberately does not carry it.
      // (U3) FUSION_HEADLESS=1 marks a genuinely-unattended run (LFG/pipeline) so
      // skills record assumptions and proceed instead of parking. Set ONLY when
      // the explicit `unattended` flag is true; absent on a board run.
      const stepEnv: NodeJS.ProcessEnv = {
        ...(taskEnv ?? process.env),
        FUSION_WORKFLOW_STEP: "1",
      };
      // FNXC:WorkflowSteps 2026-06-21-06:30:
      // Default-safe invariant (KTD-3): a board run must NEVER be headless. Since
      // stepEnv spreads taskEnv/process.env, an inherited FUSION_HEADLESS (e.g. an
      // outer pipeline exported it) would otherwise leak in and silently skip user
      // questions. Set it ONLY on an explicit opt-in; strip any inherited value
      // otherwise so absence of the flag always yields a board run.
      if (unattended) {
        stepEnv.FUSION_HEADLESS = "1";
      } else {
        delete stepEnv.FUSION_HEADLESS;
      }

      // (U1) Load the step's named skill into THIS session. The interactive fix
      // proved the resolver works when fed BOTH a requested name AND a discovery
      // path (compound-engineering-skill-resolution.test.ts). Here we mirror it:
      // merge the step's skillName (both namespaced `compound-engineering:ce-work`
      // and bare `ce-work` — the resolver matches bare names case-insensitively)
      // into the resolved requestedSkillNames, and pass the CE install root (from
      // the injected FUSION_CE_SKILLS_DIR env) as additionalSkillPaths so the
      // loader can actually discover the bundled SKILL.md. Without both halves the
      // named skill was only prompt text pointing at a skill the session never had.
      let effectiveSkillSelection = skillContext.skillSelectionContext;
      const ceSkillsDir = typeof stepEnv.FUSION_CE_SKILLS_DIR === "string" && stepEnv.FUSION_CE_SKILLS_DIR.trim()
        ? stepEnv.FUSION_CE_SKILLS_DIR.trim()
        : undefined;
      if (workflowStep.skillName && workflowStep.skillName.trim()) {
        const namespaced = workflowStep.skillName.trim();
        const bare = namespaced.includes(":") ? namespaced.slice(namespaced.lastIndexOf(":") + 1) : namespaced;
        const existing = effectiveSkillSelection?.requestedSkillNames ?? [];
        const mergedNames = [...new Set([...existing, namespaced, bare])];
        effectiveSkillSelection = {
          projectRootDir: effectiveSkillSelection?.projectRootDir ?? this.rootDir,
          ...(effectiveSkillSelection?.sessionPurpose ? { sessionPurpose: effectiveSkillSelection.sessionPurpose } : { sessionPurpose: "executor" }),
          requestedSkillNames: mergedNames,
        };
      }
      const additionalSkillPaths = mergeAdditionalSkillPaths(skillContext.additionalSkillPaths, ceSkillsDir ? [ceSkillsDir] : undefined);
      // FNXC:WorkflowSteps 2026-07-30-21:40:
      // FN-8461 / GitHub #2388: workflow steps resolve skills from enabled-plugin
      // body directories and the optional CE install root. Warn only after merging
      // those sources when THIS named skill remains undiscoverable: a non-empty path
      // array for another skill is not viable, while an actual plugin body makes CE
      // env absence expected rather than misleading operator-facing noise.
      if (
        workflowStep.skillName?.trim()
        && !isWorkflowStepSkillDiscoverable(workflowStep.skillName.trim(), additionalSkillPaths, ceSkillsDir)
      ) {
        await this.store.logEntry(
          task.id,
          `[skill-load] Workflow step '${workflowStep.name}' requests skill '${workflowStep.skillName}' but it cannot be discovered from configured plugin body directories or FUSION_CE_SKILLS_DIR; the step runs with role-fallback skills only.`,
        );
      }
      const logBrowserVerificationActivity = async (message: string) => {
        await this.store.logEntry(task.id, message);
        await this.store.appendAgentLog(task.id, message, "status", undefined, "reviewer");
      };
      if (workflowStep.requiresBrowser === true) {
        effectiveSkillSelection = augmentSessionSkillsForBrowserStep(effectiveSkillSelection, this.rootDir);
        await logBrowserVerificationActivity(`[browser-verification] starting browser verification for task ${task.id} using step '${workflowStep.name}'`);
        const browserProbe = await probeAgentBrowserAvailability(execAsync as AgentBrowserExec, {
          cwd: worktreePath,
          env: stepEnv,
          timeoutMs: 5_000,
        });
        await logBrowserVerificationActivity(formatAgentBrowserAvailabilityLog(browserProbe));
      }

      // (U8b) Coding-mode skill steps fan out to ce-<persona> subagents via
      // fn_spawn_agent (read the persona def, pass its body as systemPromptOverride).
      // That tool is registered only in the main executor session — never here —
      // so coding mode granted write/edit but NOT spawn. Register it for
      // coding-mode steps now; readonly steps keep no spawn (filterCustomToolsForReadonly
      // strips it). The spawn tool inherits the injected env so children also see
      // FUSION_CE_AGENTS_DIR.
      //
      // (U9 / KTD-4, Risk-1) ACCEPTED WRITE-CAPABILITY POSTURE: coding mode also
      // exposes write/edit. The CE plan/code-review steps run coding ONLY to gain
      // spawn (they are not supposed to mutate the tree), but the tool policy is
      // binary today — coding is the only mode that carries fn_spawn_agent. There
      // is NO engine guard preventing those steps from writing; the only protection
      // is skill discipline plus the U6 no-diff detection assertion. The proper fix
      // (a dedicated readonly-plus-spawn tool mode) is deferred; this is a
      // knowingly-accepted gap, not a closed one — re-evaluate before enabling the
      // CE workflow for genuinely-unattended (FUSION_HEADLESS) LFG/pipeline runs.
      const planReviewPromptTools: ToolDefinition[] = allowPlanReviewPromptWrite
        ? [this.createTaskPromptWriteTool(task.id)]
        : [];
      const codingCustomTools: ToolDefinition[] = toolMode === "coding"
        ? [this.createSpawnAgentTool(task.id, worktreePath, settings, stepEnv)]
        : [];
      const workflowCustomTools = [...planReviewPromptTools, ...codingCustomTools];
      const readonlyCustomTools = toolMode === "readonly"
        ? filterCustomToolsForReadonly(workflowCustomTools, {
            allowTool: (tool) => allowPlanReviewPromptWrite && tool.name === "fn_task_prompt_write",
          })
        : { allowed: workflowCustomTools, denied: [] as string[] };
      if (toolMode === "readonly" && readonlyCustomTools.denied.length > 0) {
        await this.store.logEntry(
          task.id,
          `[readonly-violation] Workflow step '${workflowStep.name}' dropped denied custom tools: ${readonlyCustomTools.denied.join(", ")}`,
        );
      }

      /*
       * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
       * WorkflowStep sessions resolve reasoning effort as node/step `thinkingLevel` first, then the task override for their selected model lane, then settings defaults/lane fallbacks.
       *
       * FNXC:Settings-ThinkingLevel 2026-07-10-14:20:
       * The step's own `fallback` attempt already swaps to a distinct model (validator fallback OR global fallback pair) — it must honor THAT model's fallback thinking level, not silently reuse the primary lane's thinking level. Route by which candidate `fallback.label` actually matched instead of only special-casing `validatorFallback`.
       */
      const workflowStepThinkingSource = workflowStep.thinkingLevel
        ?? (isReviewTypeWorkflowStep ? task.validatorThinkingLevel ?? task.thinkingLevel : task.thinkingLevel);
      const workflowStepThinkingLevel = attemptLabel === "fallback"
        ? isReviewTypeWorkflowStep
          ? resolveValidatorFallbackThinkingLevel(workflowStepThinkingSource, settings)
          : resolveExecutorFallbackThinkingLevel(workflowStepThinkingSource, settings)
        : isReviewTypeWorkflowStep
          ? resolveValidatorThinkingLevel(workflowStepThinkingSource, settings)
          : resolveExecutorThinkingLevel(workflowStepThinkingSource, settings);
      const workflowStepFallbackThinkingLevel = isReviewTypeWorkflowStep
        ? resolveValidatorFallbackThinkingLevel(workflowStepThinkingSource, settings)
        : resolveExecutorFallbackThinkingLevel(workflowStepThinkingSource, settings);
      const { session } = await createResolvedAgentSession({
        sessionPurpose: "executor",
        runtimeHint: workflowRuntimeHint,
        pluginRunner: this.options.pluginRunner,
        cwd: worktreePath,
        systemPrompt: stepSystemPrompt,
        tools: toolMode,
        defaultProvider: provider,
        defaultModelId: modelId,
        ...(attemptLabel !== "fallback" && primaryCredentialInstanceId
          ? { credentialInstanceId: primaryCredentialInstanceId }
          : {}),
        fallbackProvider: workflowFallback.provider,
        fallbackModelId: workflowFallback.modelId,
        fallbackThinkingLevel: workflowStepFallbackThinkingLevel,
        defaultThinkingLevel: workflowStepThinkingLevel,
        runAuditor: createRunAuditor(this.store, this.getRunContextFor(task.id)),
        settings,
        taskEnv: stepEnv,
        mcpServers: await this.resolveMcpServers(undefined),
        // FNXC:SessionRouting 2026-06-24-11:20:
        // #1675: propagate task id so workflow-step requests carry the same
        // X-Session-Id/X-Session-Affinity as the primary session.
        taskId: task.id,
        // FNXC:PluginSkills 2026-07-12-00:00: Workflow-step sessions union plugin skill body dirs with CE's FUSION_CE_SKILLS_DIR so neither plugin-package nor compound-engineering skills are overwritten.
        // Skill selection: assigned-agent / role-fallback skills, plus the step's own named skill (U1) made discoverable via additionalSkillPaths.
        ...(effectiveSkillSelection ? { skillSelection: effectiveSkillSelection } : {}),
        ...(additionalSkillPaths ? { additionalSkillPaths } : {}),
        ...(readonlyCustomTools.allowed.length > 0 ? { customTools: readonlyCustomTools.allowed } : {}),
      });

      const workflowModelDetails = formatModelMarkerDetails(
        describeModel(session),
        workflowStepThinkingLevel,
        [
          useOverride && attemptLabel === "primary" ? "workflow step override" : "",
          attemptLabel === "fallback" ? "fallback after timeout" : "",
        ],
      );
      executorLog.debug(`${task.id}: workflow step '${workflowStep.name}' using model ${workflowModelDetails}`);
      await this.store.logEntry(
        task.id,
        `Workflow step '${workflowStep.name}' using model: ${workflowModelDetails}`,
      );
      this.setActiveWorkflowStepSession(task.id, session, worktreePath, createSeenSteeringIds(task));
      // FNXC:TaskTiming 2026-07-30-21:40: graph-owned Plan Review is the only
      // post-spec planning lane. Start before prompting and finalize in finally before any replan handoff.
      const ownsPlanningSegment = workflowStep.id === "graph:plan-review-step" || workflowStep.name === "Plan Review";
      if (ownsPlanningSegment) {
        this.activePlanningWorkflowSessions.add(task.id);
        const planningStart = startPlanningSegment(task);
        try {
          if (planningStart.planningStartedAt) await this.store.updateTask(task.id, planningStart);
        } catch (error) {
          this.activePlanningWorkflowSessions.delete(task.id);
          throw error;
        }
      }

      let output = "";
      const deltaNormalizer = createStreamingDeltaNormalizer();
      let detectedQuestion: string | null = null;
      let resolveQuestion: ((value: "await-input") => void) | undefined;
      const questionPromise = new Promise<"await-input">((resolve) => {
        resolveQuestion = resolve;
      });
      session.subscribe((event) => {
        if (event.type === "message_update") {
          const msgEvent = event.assistantMessageEvent;
          if (msgEvent.type === "text_delta") {
            // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
            // including tool-call cross-message boundaries (see streaming-delta.ts).
            const delta = deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "text");
            output += delta;
            agentLogger.onText(delta);
          } else if (msgEvent.type === "thinking_delta") {
            // Repair dropped sentence-boundary spaces at the shared engine delta chokepoint,
            // including tool-call cross-message boundaries (see streaming-delta.ts).
            const delta = deltaNormalizer.normalize(msgEvent.partial, msgEvent.contentIndex, msgEvent.delta, "thinking");
            agentLogger.onThinking(delta);
          }
        }
        if (event.type === "tool_execution_start") {
          agentLogger.onToolStart(event.toolName, event.args as Record<string, unknown> | undefined);
          if (!unattended && detectedQuestion === null) {
            const question = parseAwaitInputQuestionToolCall(
              event.toolName,
              event.args as Record<string, unknown> | undefined,
            );
            if (question) {
              detectedQuestion = question;
              resolveQuestion?.("await-input");
            }
          }
        }
        if (event.type === "tool_execution_end") {
          agentLogger.onToolEnd(event.toolName, event.isError, event.result);
        }
      });

      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          resolveTimeout("timeout");
        }, timeoutMs);
      });

      try {
        const promptPromise = promptWithFallback(
          session,
          `Execute the workflow step "${workflowStep.name}" for task ${task.id}.\n\n` +
          `Review the work done in this worktree and evaluate it against the criteria in your instructions.`,
        );

        const outcome = await Promise.race([
          promptPromise.then(() => "completed" as const),
          timeoutPromise,
          questionPromise,
        ]);

        if (outcome === "await-input" && detectedQuestion) {
          try { session.dispose(); } catch { /* best-effort */ }
          await agentLogger.flush();
          return {
            success: true,
            output: `===FUSION_AWAIT_INPUT===\n${detectedQuestion}\n===END_FUSION_AWAIT_INPUT===`,
          };
        }

        if (outcome === "timeout") {
          executorLog.warn(`${task.id}: workflow step '${workflowStep.name}' (${attemptLabel}) timed out after ${timeoutMs}ms — disposing session`);
          await this.store.logEntry(
            task.id,
            `Workflow step '${workflowStep.name}' ${attemptLabel === "primary" ? "primary" : "fallback"} model timed out after ${Math.round(timeoutMs / 1000)}s — aborting session`,
          );
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: timed out`);
          }
          // FNXC:TaskCost 2026-07-30-21:40: Plan Review tokens are task cost;
          // snapshot before timeout disposal just like normal completion.
          await accumulateSessionTokenUsage(this.store, task.id, session, { agentId: task.assignedAgentId ?? undefined, role: "executor" });
          try { session.dispose(); } catch { /* best-effort */ }
          await agentLogger.flush();
          return { success: false, error: `workflow step timed out after ${timeoutMs}ms`, timedOut: true };
        }

        // Completed within the timeout — let any post-completion errors surface.
        checkSessionError(session);
        await accumulateSessionTokenUsage(this.store, task.id, session, {
            agentId: task.assignedAgentId ?? undefined,
            role: "executor",
          });
        session.dispose();
        await agentLogger.flush();

        const parsed = requireVerdict ? parseWorkflowStepOutput(output) : parseWorkflowStepOutput(output, { requireVerdict: false });
        if (parsed.verdict) {
          const revisionRequested = parsed.verdict === "REVISE";
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: verdict ${parsed.verdict}`);
          }
          return {
            success: !revisionRequested,
            revisionRequested,
            output: parsed.output,
            verdict: parsed.verdict,
            notes: parsed.notes,
          };
        }

        if (parsed.malformed) {
          // FNXC:ReviewLeniency 2026-07-02-00:30: malformed output (after the
          // fallback-model retry) is recorded as a NON-BLOCKING advisory, not a
          // hard gate block — see runGraphCustomNode's outcome mapping.
          await this.store.logEntry(
            task.id,
            `[pre-merge] Workflow step '${workflowStep.name}' produced malformed output (no parseable verdict) — recorded as non-blocking advisory`,
          );
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: malformed output`);
          }
          return {
            success: false,
            output: parsed.output,
            error: "malformed output — no verdict extracted",
            notes: undefined,
            malformed: true,
          };
        }

        if (workflowStep.requiresBrowser === true) {
          await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: completed`);
        }
        return { success: true, output: parsed.output };
      } catch (err: unknown) {
        await agentLogger.flush();
        // Persist the delta before error disposal so graph-owned planning reviews
        // cannot disappear from operator cost totals.
        await accumulateSessionTokenUsage(this.store, task.id, session, { agentId: task.assignedAgentId ?? undefined, role: "executor" });
        try { session.dispose(); } catch { /* best-effort */ }
        if ((err instanceof ReadonlyViolationError) || ((err as { code?: string } | null)?.code === "READONLY_VIOLATION")) {
          const violation = err as ReadonlyViolationError;
          const deniedTool = violation.toolName || "unknown";
          await this.store.logEntry(
            task.id,
            `[readonly-violation] Workflow step '${workflowStep.name}' attempted denied tool '${deniedTool}'`,
          );
          if (workflowStep.requiresBrowser === true) {
            await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: readonly violation`);
          }
          return { success: false, error: `[readonly-violation] ${violation.message}` };
        }
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (workflowStep.requiresBrowser === true) {
          await logBrowserVerificationActivity(`[browser-verification] finished browser verification for task ${task.id}: failed — ${errorMessage}`);
        }
        return { success: false, error: errorMessage };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (ownsPlanningSegment) {
          try {
            const livePlanningTask = await this.store.getTask(task.id);
            if (livePlanningTask) {
              const planningEnd = finalizePlanningSegment(livePlanningTask);
              if (planningEnd.planningStartedAt === null) await this.store.updateTask(task.id, planningEnd);
            }
          } finally {
            // Finalize before releasing Plan Review ownership so triage can only
            // begin a subsequent, non-overlapping planning segment.
            this.activePlanningWorkflowSessions.delete(task.id);
          }
        }
        const activeWorkflowStepSession = this.activeWorkflowStepSessions.get(task.id);
        if (activeWorkflowStepSession === session) {
          this.deleteActiveWorkflowStepSession(task.id, worktreePath);
        }
        // Suppress unused-variable warning; `timedOut` documents intent.
        void timedOut;
      }
    };

    const primaryOutcome = await runOnce(primaryProvider, primaryModelId, "primary");
    /*
    FNXC:ReviewLeniency 2026-07-02-00:30:
    Retry the fallback model on a MALFORMED (unparseable-verdict) primary response, not only on a timeout. A single fumbled response — reasoning with no trailing verdict — should get one more attempt on the fallback model before the gate result is recorded, mirroring the reviewer path's UNAVAILABLE retry. If no fallback is configured the malformed primary is returned as-is (and is treated as a non-blocking advisory downstream, see runGraphCustomNode).
    */
    const primaryMalformed = (primaryOutcome as { malformed?: boolean }).malformed === true;
    if (!primaryOutcome.timedOut && !primaryMalformed) return primaryOutcome;

    if (!fallback) {
      /*
       * FNXC:ReviewLeniency 2026-07-05-17:24:
       * FN-7561: when NO fallback model is configured, a MALFORMED primary (unparseable verdict — a single fumbled response) still deserves one retry so a transient formatting fumble does not feed the plan-review replan loop. Self-retry once on the SAME primary model. Timeouts are NOT self-retried — they would likely just time out again and burn another full budget. If the self-retry is still malformed it is returned as a non-blocking advisory downstream.
       */
      if (primaryMalformed && !primaryOutcome.timedOut) {
        executorLog.log(`${task.id}: workflow step '${workflowStep.name}' produced malformed output and no fallback is configured — retrying once on the primary model`);
        const retryOutcome = await runOnce(primaryProvider, primaryModelId, "primary-retry");
        const retryMalformed = (retryOutcome as { malformed?: boolean }).malformed === true;
        if (!retryMalformed) return retryOutcome;
        await this.store.logEntry(
          task.id,
          `Workflow step '${workflowStep.name}' produced malformed output on both the primary attempt and one self-retry — no fallback model configured (set ${fallbackSettingsHint})`,
        );
        return retryOutcome;
      }
      const reason = primaryOutcome.timedOut ? "timed out" : "produced malformed output";
      executorLog.warn(`${task.id}: workflow step '${workflowStep.name}' ${reason} and no fallback model is configured`);
      await this.store.logEntry(
        task.id,
        `Workflow step '${workflowStep.name}' ${reason} — no fallback model configured (set ${fallbackSettingsHint})`,
      );
      return primaryOutcome;
    }

    executorLog.log(`${task.id}: retrying workflow step '${workflowStep.name}' with ${fallbackLaneLabel} fallback ${fallback.provider}/${fallback.modelId} after primary ${primaryOutcome.timedOut ? "timeout" : "malformed output"}`);
    return runOnce(fallback.provider, fallback.modelId, "fallback");
  }

  private MAX_WORKTREE_RETRIES = 3;
  private WORKTREE_RETRY_DELAYS = [100, 500, 1000]; // ms


  private readonly MAX_AUTO_RECOVERY_ATTEMPTS = 3;
  private readonly BRANCH_CONFLICT_TRIPWIRE_THRESHOLD = 5;

  private async tryBootstrapMisbindingRecovery(
    task: Task,
    contamination: BranchCrossContaminationError,
    audit: ReturnType<typeof createRunAuditor>,
  ): Promise<boolean> {
    return tryBootstrapMisbindingRecoveryImpl(
      {
        rootDir: this.rootDir,
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
        markGraphExecuteSelfRequeued: (taskId: string) => this.markGraphExecuteSelfRequeued(taskId),
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
    return {
      rootDir: this.rootDir,
      store: this.store,
      getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
      findActiveWorktreeOwner: (worktreePath: string, requestingTaskId: string) =>
        this.findActiveWorktreeOwner(worktreePath, requestingTaskId),
      normalizeReclaimableWorktreePath: (
        sourcePath: string,
        targetPath: string,
        taskId: string,
        settings: Partial<Settings>,
      ) => this.normalizeReclaimableWorktreePath(sourcePath, targetPath, taskId, settings),
      cleanupConflictingWorktree: (worktreePath: string, branch: string, taskId: string) =>
        this.cleanupConflictingWorktree(worktreePath, branch, taskId),
      getAutoRecoveryDispatcher: (audit: RunAuditor) => this.getAutoRecoveryDispatcher(audit),
      createRunAuditor: (runContext: EngineRunContext | undefined) => createRunAuditor(this.store, runContext),
      persistTokenUsage: (taskId: string) => this.persistTokenUsage(taskId),
      onError: this.options.onError,
    };
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
        rootDir: this.rootDir,
        store: this.store,
        getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
        hasActiveWorktreeBinding: (taskId: string, path: string) => this.hasActiveWorktreeBinding(taskId, path),
        markGraphExecuteSelfRequeued: (taskId: string) => this.markGraphExecuteSelfRequeued(taskId),
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
        store: this.store,
        getRunContextFor: (id: string) => this.getRunContextFor(id),
      },
      taskId,
      fromPath,
      toPath,
      source,
    );
  }

  listWorktreeHolders(): Array<{ taskId: string; worktreePath: string }> {
    const holders: Array<{ taskId: string; worktreePath: string }> = [];
    // FNXC:Workspace 2026-06-21-12:00: KTD2 — flat-map each task's Set into one holder row per worktree path. A workspace task emits N rows; the FN-6782 reaper (self-healing.ts) and in-process-runtime adapter key purely off taskId (verified) and are idempotent across duplicate-task rows, so multi-row holders do not mis-count maxWorktrees slots.
    for (const [taskId, worktreePaths] of this.activeWorktrees) {
      for (const worktreePath of worktreePaths) {
        holders.push({ taskId, worktreePath });
      }
    }
    return holders;
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
      rootDir: this.rootDir,
      store: this.store,
      getRunContextFor: (taskId: string) => this.getRunContextFor(taskId),
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
        rootDir: this.rootDir,
        store: this.store,
        hasActiveWorktreeBinding: (tid, p) => this.hasActiveWorktreeBinding(tid, p),
        isLiveCleanupRefusal: (p, tid) => this.isLiveCleanupRefusal(p, tid),
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
        tryCreateWorktree: (
          branch, path, taskId, startPoint, attemptNumber, recoveryDepth, allowSiblingBranchRename, settings,
        ) => this.tryCreateWorktree(
          branch, path, taskId, startPoint, attemptNumber, recoveryDepth, allowSiblingBranchRename ?? false, settings ?? {},
        ),
      },
      input,
    );
  }

  /*
  FNXC:CodeOrganization 2026-08-03-15:10:
  Thin facades over tryCreateWorktree / handleWorktreeConflict / cleanupConflictingWorktree
  (U4 Slice B). Shared deps bag wires circular callbacks through this.
  */
  private worktreeCreateConflictDeps(): import("./executor/worktree-create-conflict.js").WorktreeCreateConflictDeps {
    return {
      rootDir: this.rootDir,
      store: this.store,
      maxWorktreeRetries: this.MAX_WORKTREE_RETRIES,
      recoverIndexLockIfStale: (taskId, path, info) => this.recoverIndexLockIfStale(taskId, path, info),
      recoverStaleRegistration: (taskId, path, info) => this.recoverStaleRegistration(taskId, path, info),
      cleanupStaleBranch: (branch, taskId) => this.cleanupStaleBranch(branch, taskId),
      handleWorktreeConflict: (
        conflictPath, branch, path, taskId, startPoint, attemptNumber, allowSiblingBranchRename, settings,
      ) => this.handleWorktreeConflict(
        conflictPath, branch, path, taskId, startPoint, attemptNumber, allowSiblingBranchRename ?? false, settings ?? {},
      ),
      tryCreateWorktree: (
        branch, path, taskId, startPoint, attemptNumber, recoveryDepth, allowSiblingBranchRename, settings,
      ) => this.tryCreateWorktree(
        branch, path, taskId, startPoint, attemptNumber, recoveryDepth, allowSiblingBranchRename ?? false, settings ?? {},
      ),
      tryFreshWorktreeAfterLiveConflict: (input) => this.tryFreshWorktreeAfterLiveConflict(input),
      shouldGenerateNewWorktreeName: (conflictPath, taskId) => this.shouldGenerateNewWorktreeName(conflictPath, taskId),
      cleanupConflictingWorktree: (worktreePath, branch, taskId) => this.cleanupConflictingWorktree(worktreePath, branch, taskId),
      normalizeReclaimableWorktreePath: (sourcePath, targetPath, taskId, settings) =>
        this.normalizeReclaimableWorktreePath(sourcePath, targetPath, taskId, settings),
      isLiveCleanupRefusal: (worktreePath, taskId) => this.isLiveCleanupRefusal(worktreePath, taskId),
    };
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
        rootDir: this.rootDir,
        store: this.store,
        reconcileSelfOwnedBeforeRemove: (p, tid) => this.reconcileSelfOwnedBeforeRemove(p, tid),
        findActiveWorktreeOwner: (p, tid) => this.findActiveWorktreeOwner(p, tid),
        removeOwnWorktreeWithReconcile: (input) => this.removeOwnWorktreeWithReconcile(input),
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
        maxWorktreeRetries: this.MAX_WORKTREE_RETRIES,
        worktreeRetryDelaysMs: this.WORKTREE_RETRY_DELAYS,
        resolveWorktreeStartPoint: (sp, tid) => this.resolveWorktreeStartPoint(sp, tid),
        planSquashImportFromDep: (tid, tip, orig) => this.planSquashImportFromDep(tid, tip, orig),
        tryCreateWorktree: (
          b, p, tid, start, attempt, recoveryDepth, allowSibling, settings,
        ) => this.tryCreateWorktree(
          b, p, tid, start, attempt, recoveryDepth, allowSibling ?? false, settings ?? {},
        ),
        squashImportDepIntoWorktree: (wp, tid, tip, label) => this.squashImportDepIntoWorktree(wp, tid, tip, label),
        rebaseNewWorktreeOntoRemote: (wp, b, tid) => this.rebaseNewWorktreeOntoRemote(wp, b, tid),
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
        rootDir: this.rootDir,
        store: this.store,
        reconcileSelfOwnedBeforeRemove: (p, tid) => this.reconcileSelfOwnedBeforeRemove(p, tid),
        hasActiveWorktreeBinding: (tid, p) => this.hasActiveWorktreeBinding(tid, p),
      },
      input,
    );
  }




  /** Remove only this executor's store-scoped lifecycle disposer registrations. */
  disposeStoreLifecycleDisposers(): void {
    this.unregisterTaskMoveDisposer?.();
    this.unregisterTaskMoveDisposer = undefined;
    this.unregisterArchiveWorktreeDisposer?.();
    this.unregisterArchiveWorktreeDisposer = undefined;
    this.unregisterArchiveWorkspaceWorktreeDisposer?.();
    this.unregisterArchiveWorkspaceWorktreeDisposer = undefined;
  }



  /**
   * Extract conflict information from git worktree error output.
   * Handles multiple error patterns:
   * - "already used by worktree at '...'"
   * - "invalid reference" / "unable to resolve reference" / "stale file handle"
   * - "could not create leading directories"
   * - "working tree already exists"
   */
  async cleanup(taskId: string): Promise<void> {
    const worktreePaths = this.getActiveWorktreePaths(taskId);
    if (worktreePaths.length === 0) return;

    this.activeWorktrees.delete(taskId);

    // FNXC:Workspace 2026-06-21-12:00: KTD1 — in workspace mode the tracked path is the non-git workspace root (browse-only), never a removable worktree. Drop the in-memory tracking above but never remove the root. Per-repo worktree teardown returns in Phase B.
    if (this.workspaceConfig) {
      return;
    }
    // Non-workspace tasks hold a one-element set — preserve the original single-path removal semantics.
    const worktreePath = worktreePaths[0];

    // Check if another task still needs this worktree
    const otherUser = await findWorktreeUser(this.store, worktreePath, taskId);
    if (otherUser) {
      executorLog.log(`Worktree retained for ${taskId} — still needed by ${otherUser}`);
      return;
    }

    try {
      const settings = await this.store.getSettings();
      await this.removeOwnWorktreeWithReconcile({
        worktreePath,
        settings,
        taskId,
        reason: RemovalReason.ExecutorDispose,
      });
      executorLog.log(`Cleaned up worktree for ${taskId}`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      executorLog.error(`Failed to clean up worktree for ${taskId}:`, errorMessage);
    }
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
        store: this.store,
        getRunContextFor: (id) => this.getRunContextFor(id),
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
      {
        store: this.store,
        rootDir: this.rootDir,
        workspaceConfig: this.workspaceConfig,
        activeStepExecutors: this.activeStepExecutors,
        stuckAborted: this.stuckAborted,
        executing: this.executing,
        activeWorktrees: this.activeWorktrees,
        loopRecoveryState: this.loopRecoveryState,
        resolveResumeLanes: (id) => this.resolveResumeLanes(id),
        getWorktreePath: (id) => this.getWorktreePath(id),
        terminateAllChildren: (id) => this.terminateAllChildren(id),
        awaitAbortInFlightTaskWork: (id, reason) => this.awaitAbortInFlightTaskWork(id, reason),
        clearPausedAborted: (id) => this.clearPausedAborted(id),
        resetStepsIfWorkLost: (t) => this.resetStepsIfWorkLost(t),
        hasActiveWorktreeBinding: (owner, path) => this.hasActiveWorktreeBinding(owner, path),
      },
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
        store: this.store,
        activeSessions: this.activeSessions,
        loopRecoveryState: this.loopRecoveryState,
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
    if (this.workspaceConfig) {
      return undefined;
    }
    return this.getActiveWorktreePaths(taskId)[0];
  }

  // ── Agent Spawning ─────────────────────────────────────────────────────

  /**
   * Terminate all child agents spawned by a parent task.
   * Called from the finally block of agentWork when the parent session ends.
   */
  private async terminateAllChildren(parentTaskId: string): Promise<void> {
    const childIds = this.spawnedAgents.get(parentTaskId);
    if (!childIds || childIds.size === 0) return;

    executorLog.log(`Terminating ${childIds.size} child agents for parent ${parentTaskId}`);
    // Detach the parent generation before any agent-store await. A replacement
    // execution may register a new set for the same task ID while cleanup is
    // still settling; the old generation must never delete that new set.
    this.spawnedAgents.delete(parentTaskId);
    await Promise.all([...childIds].map((childId) => this.terminateChildAgent(childId)));
  }

  /**
   * Terminate a single child agent by ID.
   * Disposes the session, updates AgentStore state, and cleans up tracking Maps.
   */
  private async terminateChildAgent(childId: string): Promise<void> {
    const childSession = this.childSessions.get(childId);
    if (childSession) {
      childSession.dispose();
      this.childSessions.delete(childId);
    }

    try {
      await this.options.agentStore?.updateAgentState(childId, "paused");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      executorLog.warn(`Failed to update spawned child ${childId} state to 'terminated' during cleanup: ${msg}`);
    }

    this.pendingEphemeralDeletions.add(childId);
    try {
      await this.options.agentStore?.deleteAgent(childId);
    } catch (err: unknown) {
      if (!isBenignEphemeralDeleteRaceError(childId, err)) {
        const msg = err instanceof Error ? err.message : String(err);
        executorLog.warn(`Failed to delete spawned agent ${childId}: ${msg}`);
      }
    } finally {
      this.pendingEphemeralDeletions.delete(childId);
    }

    this.totalSpawnedCount = Math.max(0, this.totalSpawnedCount - 1);
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
      {
        store: this.store,
        rootDir: this.rootDir,
        agentStore: this.options.agentStore,
        pluginRunner: this.options.pluginRunner,
        getTotalSpawnedCount: () => this.totalSpawnedCount,
        setTotalSpawnedCount: (n) => { this.totalSpawnedCount = n; },
        childSessions: this.childSessions,
        spawnedAgents: this.spawnedAgents,
        createWorktree: (branch, path, tid, startPoint) => this.createWorktree(branch, path, tid, startPoint),
        resolveInstructionsForRole: (role, s) => this.resolveInstructionsForRole(role, s),
        getRunContextFor: (id) => this.getRunContextFor(id),
        resolveMcpServers: (agentId) => this.resolveMcpServers(agentId),
        runSpawnedChild: (agentId, session, prompt) => this.runSpawnedChild(agentId, session, prompt),
      },
      taskId,
      worktreePath,
      settings,
      taskEnv,
    );
  }

}

export {
  buildExecutionPrompt,
  formatCommentForInjection,
  formatTimestamp,
  scopePromptToWorktree,
  buildSourceIssueRef,
} from "./executor/execution-prompt.js";
import {
  buildExecutionPrompt,
  formatCommentForInjection,
} from "./executor/execution-prompt.js";

export { clearTerminalWorkflowStepFailures } from "./executor/workflow-step-failures.js";
import { clearTerminalWorkflowStepFailures } from "./executor/workflow-step-failures.js";

export {
  hasNonTerminalWorkflowSteps,
  workflowStepResultPassed,
  areExplicitEnabledWorkflowStepsSatisfied,
  hasUnsatisfiedExplicitEnabledWorkflowSteps,
  areEnabledPreMergeWorkflowStepsSatisfied,
  preservePreExecutionWorkflowStepResults,
} from "./executor/workflow-step-satisfaction.js";

export {
  detectPseudoPause,
  detectReviewHandoffIntent,
} from "./executor/pseudo-pause.js";
export type { PseudoPauseResult } from "./executor/pseudo-pause.js";
import {
  detectPseudoPause,
  detectReviewHandoffIntent,
} from "./executor/pseudo-pause.js";

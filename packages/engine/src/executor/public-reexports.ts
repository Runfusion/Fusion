/**
 * FNXC:CodeOrganization 2026-08-03-20:50:
 * Non-Free public re-exports peeled from executor.ts preamble (U4).
 * Keeps TaskExecutor facade file free of pure re-export noise.
 */

export type { PausedAbortProvenance } from "./paused-abort-provenance.js";
export {
  AGENT_BROWSER_NAVIGATION_SKILL_ID,
  probeAgentBrowserAvailability,
  augmentSessionSkillsForBrowserStep,
  formatAgentBrowserAvailabilityLog,
} from "./browser-probe.js";
export type { AgentBrowserAvailabilityProbeResult } from "./browser-probe.js";
export {
  MAX_EXECUTE_REQUEUE_LOOP_CYCLES,
  EXECUTE_REQUEUE_LOOP_VISIBLE_THRESHOLD,
  buildExecuteRequeueLoopSignature,
  isTransientMissingTaskJsonError,
} from "./requeue-loop.js";
export type { PendingReviewBlockResult } from "./pending-review-block.js";
export {
  isTaskWorkComplete,
  isNoProgressNoTaskDoneFailure,
  createSeenSteeringIds,
  createConfiguredCommandAbortError,
  graphActiveContextKey,
  isRetryableMergePauseAbortStatus,
  isTerminalMergeGraphFailureValue,
  isAwaitingGraphFailureValue,
} from "./task-predicates.js";
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
} from "./graph-failure-pure.js";
export {
  accumulateTokenUsage,
  tokenUsageWithModelSnapshot,
  extractSessionTokenUsage,
} from "./token-usage-pure.js";
export {
  formatBranchConflictLifecycleLog,
  formatBranchConflictAgentLog,
} from "./branch-conflict-format.js";
export {
  extractOwnSettings,
  buildAgentPersona,
} from "./agent-binding-pure.js";
export { resolveCliExecutorConfig } from "./cli-executor-config.js";
export {
  isTaskAlreadyCompleteForNonContinuableSession,
  evaluateImplicitCompletionRefusal,
  skipBypassTaintUpdateForRefusal,
} from "./completion-predicates.js";
export {
  isTransientResumeAfterRestartGraphFailure,
  isBenignInReviewPauseAbort,
} from "./graph-resume-predicates.js";
export { buildWorkflowFailureScopeGuard } from "./workflow-failure-scope-guard.js";
export {
  resolveContaminationBaseRef,
  resolveDiffBaseRef,
  captureBaseCommitSha,
  preExecutionWorktreeHasWork,
} from "./worktree-git-refs.js";
export {
  isRegisteredWorktree,
  assertWorktreePathNotNested,
  getWorktreeBranchMap,
} from "./worktree-registry-helpers.js";
export { quoteShellArg } from "./shell-quote.js";
export { isBenignEphemeralDeleteRaceError } from "./ephemeral-delete-race.js";
export { logReviewCheckoutRouting } from "./review-checkout-routing.js";
export { extractWorktreeConflictInfo } from "./worktree-conflict-info.js";
export type { WorktreeConflictInfo } from "./worktree-conflict-info.js";
export {
  evaluateTaskDoneRefusal,
  determineRevisionResetStart,
} from "./task-done-refusal.js";
export {
  extractReferencedPathsFromWorkflowFeedback,
  isAlwaysAllowedScopeLeakPath,
  workflowPathMatchesDeclaredScope,
} from "./workflow-feedback-paths.js";
export type { WorkflowRevisionFeedbackPartition } from "./workflow-feedback-paths.js";
export {
  parseReviewLevelFromPrompt,
  evaluatePromptDerivedNoCommitEligibility,
  extractPromptSection,
  extractPromptListEntries,
} from "./prompt-derived-eligibility.js";
export { NonRetryableWorktreeError } from "./worktree-registry-helpers.js";
export {
  hasActiveWorktreeBinding,
  shouldGenerateNewWorktreeName,
  findActiveWorktreeOwner,
  isLiveCleanupRefusal,
} from "./worktree-ownership.js";
export { cleanupStaleBranch } from "./worktree-stale-branch.js";
export { planSquashImportFromDep } from "./worktree-squash-import-plan.js";
export { reconcileSelfOwnedBeforeRemove } from "./worktree-self-owned-reconcile.js";
export {
  emitStaleLockAudit,
  recoverIndexLockIfStale,
  recoverExecutorStaleRegistration,
} from "./worktree-stale-lock-recovery.js";
export type { StaleLockAuditEvent } from "./worktree-stale-lock-recovery.js";
export { normalizeReclaimableWorktreePath } from "./worktree-reclaim-path.js";
export { removeOwnWorktreeWithReconcile } from "./worktree-remove-own.js";
export { tryFreshWorktreeAfterLiveConflict } from "./worktree-fresh-after-conflict.js";
export { truncateWorkflowScriptOutput, runConfiguredCommand } from "./configured-command.js";
export {
  parseAwaitInputSentinel,
  parseAwaitInputQuestionToolCall,
} from "./await-input-parse.js";
export {
  FUSION_WORKFLOW_STEP_CONVENTIONS_PREAMBLE,
  parseWorkflowStepVerdict,
  inferWorkflowStepVerdictFromProse,
  parseWorkflowStepOutput,
} from "./workflow-step-verdict.js";
export type {
  WorkflowStepOutcome,
  WorkflowStepResult,
} from "./workflow-step-verdict.js";
export { getExecutorSystemPrompt } from "./system-prompt.js";
export {
  LEGACY_TERMINAL_COLUMNS,
  resolveTerminalColumnsFor,
  resolveCompleteColumnFor,
  resolveReboundColumnFor,
} from "./lifecycle-columns.js";

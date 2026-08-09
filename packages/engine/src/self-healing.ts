/**
 * SelfHealingManager — enables unattended multi-day/week operation by
 * providing automatic recovery from common failure modes.
 *
 * Four subsystems:
 * 1. **Auto-unpause**: Clears rate-limit-triggered `globalPause` with
 *    escalating backoff (5 min → 60 min cap). Resets on sustained unpause.
 * 2. **Stuck kill budget**: Caps how many times a task can be killed by the
 *    stuck-task detector before marking it as permanently failed.
 * 3. **Periodic maintenance**: Worktree pruning, orphan cleanup, SQLite
 *    WAL checkpoint — all on a configurable interval (default 15 min).
 * 4. **Worktree cap enforcement**: Prevents unbounded worktree accumulation
 *    by cleaning oldest idle worktrees when count exceeds 2× maxWorktrees.
 * 5. **Completion handoff limbo recovery**: Re-enqueues merge-eligible in-review
 *    tasks stuck after `Task marked done by agent` with missing fan-out state.
 *
 * Worktrunk ownership/deference table (`worktrunk.enabled`):
 * - `pruneWorktrees`: defer to backend prune
 * - `cleanupOrphans`: defer to backend prune/remove semantics
 * - `reapUnregisteredOrphans`: defer to backend prune/remove semantics
 * - `cleanupStaleTempMergeWorktrees`: remains native (dedicated AI-merge root + legacy roots)
 * - `enforceWorktreeCap`: defer to backend prune/remove semantics
 * - `reclaimSelfOwnedBranchConflicts`: remains native (branch-level)
 * - `reclaimStaleActiveBranches`: remains native (branch-level)
 */

import { execSync } from "node:child_process";
import { setImmediate as setImmediateCb } from "node:timers";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type TaskMoveLanes, resolveColumnFlags, IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX, IN_REVIEW_STALL_LOG_PREFIX, IN_REVIEW_STALL_TERMINAL_LOG_PREFIX, allowsAutoMergeProcessing, hasSharedBranchMemberAutoMergeHold, resolveEffectiveAutoMerge, countRecentIdenticalStallEntries, detectDependencyCycle, detectSelfDefeatingDependency, evaluateNoCommitsNoOpFinalize, evaluateCompletedPromotionFailureProvenance, evaluateSkipBypassTaint, getInReviewStalledSignal, getInReviewStallReason, getPrimaryPrInfo, getStalePausedReviewSignal, getStalePausedTodoSignal, getTaskHardMergeBlocker, getTaskMergeBlocker, isEphemeralAgent, isMergeRequestContractShadowEnabled, isWorkspaceTask, isSharedBranchGroupMemberIntegration, isLiveSharedBranchGroupMemberIntegration, isNearDuplicateCanonicalInactive, resolveExplicitDuplicateMarker, flagTriageDuplicate, isTriageDuplicateKeepAcknowledged, resolveMaxAutoMergeRetries, resolveOptionalStepRevisionBudget, resolveOptionalReviewRevisionBudget, getBuiltinWorkflow, isBuiltinWorkflowId, resolveWorkflowIrForTask, resolveWorkflowIrForTaskWithProvenance, resolveReboundTarget, resolveReboundTargetForTask, resolveArchiveTargetForTask, columnsWithFlag, resolveLifecycleColumns, resolveTaskLifecycleColumns, workflowHasColumn, planLegacyAdoption, resolveOrphanedPendingStepResults, classifyReviewLease, PLAN_REVIEW_LEASE_STALENESS_MS, DEFAULT_MAX_POST_REVIEW_FIXES, ACTIVE_WORKFLOW_WORK_ITEM_STATES, AWAITING_APPROVAL_PAUSE_REASON, type Agent, type AgentStore, type ChatStore, type MessageStore, type TaskStore, type Settings, type Task, type MergeDetails, type TaskPriority, type MergeResult, type WorkflowStepResult, type WorkflowIr,
  resolveNearDuplicateCanonicalFlags,
  LEGACY_COLUMN_IDS_BY_ROLE,
  TERMINAL_ROLES,
  resolveProjectColumnsForRoles,
  REVIEW_ROLES,
  pruneTaskLifecycleEvents,
  pruneGitHubCheckStatesAsync,
  resolveAgentActivityAttribution,
} from "@fusion/core";
import { finalizePlanningSegment } from "@fusion/core";
import type { MeshLeaseManager } from "./project/mesh-lease-manager.js";
import { createLogger, schedulerLog } from "./logger.js";
import {
  TRIAGE_MARKER_CLEARED_REPLAN_LOG_ACTION,
  buildInactiveDuplicateClearFeedback,
  buildKeepDuplicateClearFeedback,
  buildMarkerClearedReplanTaskPatch,
  buildMarkerExhaustedFailedTaskPatch,
  buildDuplicateReplanExhaustedError,
} from "./duplicate-marker-clear.js";
import { mergeEffectiveSettings } from "./project/effective-settings.js";
import { RemovalReason, classifyTaskWorktree, getRegisteredWorktreeBranchMap, getRegisteredWorktreePaths, hasUsableWorktreeShape, isUsableTaskWorktree, relocateReclaimableWorktreeIntoRoot, removeWorktree, resolveWorktreeBackend, scanIdleWorktrees, scanOrphanedBranches } from "./worktree/worktree-pool.js";
import {
  classifyMissingWorktreeSessionStartFailure,
  extractMissingWorktreePathFromSessionStartFailure,
  isMissingWorktreeSessionStartFailure,
  isMergeActiveMissingWorktreeSessionStartFailure,
  isRecoverableMissingWorktreeReviewFailureNoProgress,
  isRecoverableMissingWorktreeReviewFailureWithProgress,
  MERGE_ACTIVE_MISSING_WORKTREE_STATUSES,
} from "./healing/restart-recovery-coordinator.js";
import { extractMissingModulePath, isNonContinuableSessionError, isStaleWorktreeModuleResolutionError } from "./errors/transient-error-detector.js";
import {
  buildHeartbeatErrorRecoveryMetadata,
  HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON,
  HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
  isHeartbeatErrorRecoverable,
  isModelUnavailablePark,
  isModelUnavailableParkRecoveryEligible,
  readHeartbeatErrorRetryCount,
  resetHeartbeatErrorRecoveryMetadata,
  resolveErrorRecoveryLimit,
} from "./agent-heartbeat.js";
import { classifyForeignOnlyContamination, deriveTaskIdFromFusionBranch, inspectBranchConflict, listUniqueBranchCommits } from "./execution/branch-conflicts.js";
import { createRunAuditor, generateSyntheticRunId, type DatabaseMutationType, type RunAuditor } from "./util/run-audit.js";
import { finalizeProvenAutoMergeTask, validateWorkflowDoneMergeProof } from "./merge/auto-merge-finalization.js";
import { AutoRecoveryDispatcher } from "./healing/auto-recovery.js";
import { activeSessionRegistry, executingTaskLock } from "./agents/active-session-registry.js";
import { isTaskStillInPlanningStage } from "./execution/replan-target.js";
import { classifyPersistedPlanHandoff, LEGACY_NULL_PLAN_HANDOFF_STALE_MS } from "./planning-handoff-recovery.js";
import { getPromptPath } from "./execution/spec-staleness.js";
import { evaluateStrandedHoldContinuation, seedPreReleasePlanReviewContinuation } from "./plan-review-continuation.js";
/*
FNXC:Workspace 2026-06-22-14:10 (Phase D review G — cycle dissolved):
`isRepoLanded` is the CANONICAL per-repo landed predicate (Phase C, exported A6). It now lives in
the dependency-free `workspace-land-predicate` module, NOT merger-ai. Previously self-healing
imported it from merger-ai while merger-ai imports `MIN_TEMP_WORKTREE_REAP_AGE_MS` from
self-healing — a real import cycle. Importing from the predicate module breaks the cycle.
*/
import { isRepoLanded } from "./merge/workspace-land-predicate.js";
import { getCommitTaskOwnership } from "./merge/already-merged-detector.js";
import { getTaskCompletionBlockerForStore } from "./execution/task-completion.js";
import { shouldReclaimWedgedMerge } from "./merge/merge-reclaim-policy.js";

import { advanceIntegrationBranchRef } from "./merge/merger-ref-update-advance.js";
import { isAiMergeContainerDir, resolveAiMergeRootPath, resolveLegacyAiMergeRootPath, resolveWorktreesDir } from "./worktree/worktree-paths.js";
import { canonicalFusionBranchName, resolveTaskWorkingBranch } from "./worktree/worktree-names.js";
import { preservedWorktreeTargetPathForTask } from "./worktree/worktree-pinning.js";
import { resolveIntegrationBranch } from "./merge/integration-branch.js";
import { resolveBranchGroupMergeRouting } from "./merge/group-merge-coordinator.js";
import type { OwnedLandedClassification } from "./merger.js";
import { regenerateBareMergeSubject } from "./merge/merger-bare-subject.js";
import { recoverForeignOnlyContamination } from "./recovery/foreign-only-contamination.js";
import {
  buildNtfyClickUrl,
  getActiveNotificationService,
  isNtfyEventEnabled,
  resolveNtfyEvents,
  sendNtfyNotification,
  type NtfyNotifier,
} from "./util/notifier.js";
import type { GhostBugDecision } from "./triage-domain/triage-preflight.js";
import { filterPathsByIgnoreList, getUnmetSchedulingDependencies, isCoordinationOnlyTask, pathsOverlap, shouldHoldActiveFileScopeLease, resolveDependencySatisfactionColumns} from "./scheduler.js";
import { runSurfacingSweep, hours, type SurfacingCycle } from "./surfacing-sweeps.js";
/* U4 substrate PR1: the git-evidence readers and their helpers now live in
   self-healing-git-evidence.ts. Imported back here because call sites remain. */
import { SelfHealingGitEvidence, execAsync, shellQuote } from "./self-healing-git-evidence.js";
import { evaluateParkedAgentTaskLink, PARKED_AGENT_LINK_FRESH_RUN_MS } from "./agents/task-agent-sync.js";
import { describeSelfHealingNoActionWedge } from "./notification/task-wedge-notification.js";

export {
  COMPLETED_BLOCKED_PAUSE_REASON,
  STALE_TEMP_MERGE_WORKTREE_MS,
  DONE_TASK_TEMP_WORKTREE_GRACE_MS,
  MIN_TEMP_WORKTREE_REAP_AGE_MS,
  STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
  COMPLETION_HANDOFF_LIMBO_GRACE_MS,
  MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES,
  MAX_POST_DONE_NONCONTINUABLE_WEDGE_RECOVERIES,
  VALIDATOR_RUN_STALE_MAX_AGE_MS,
  MAX_WORKTREE_SESSION_RETRIES,
  PAUSE_ABORT_PARK_ERROR_MARKER,
  PAUSE_ABORT_PARK_OPERATOR_MARKER,
  MAX_AUTO_MERGE_RETRIES,
  MAX_TRANSIENT_MERGE_RECOVERIES,
} from "./healing/self-healing-constants.js";
import {
  COMPLETED_BLOCKED_PAUSE_REASON,
  STALE_TEMP_MERGE_WORKTREE_MS,
  DONE_TASK_TEMP_WORKTREE_GRACE_MS,
  MIN_TEMP_WORKTREE_REAP_AGE_MS,
  STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
  COMPLETION_HANDOFF_LIMBO_GRACE_MS,
  MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES,
  MAX_POST_DONE_NONCONTINUABLE_WEDGE_RECOVERIES,
  MAX_WORKTREE_SESSION_RETRIES,
  PAUSE_ABORT_PARK_ERROR_MARKER,
  PAUSE_ABORT_PARK_OPERATOR_MARKER,
  MAX_TRANSIENT_MERGE_RECOVERIES,
} from "./healing/self-healing-constants.js";
export { isBranchAheadOfBase } from "./healing/self-healing-branch.js";
import { isBranchAheadOfBase } from "./healing/self-healing-branch.js";

export {
  OPTIONAL_STEP_REVISION_KEY_MARKER,
  normalizeOptionalStepRevisionKey,
  optionalStepRevisionKey,
  countOptionalStepRevisionAttempts,
  optionalStepRevisionLogOutcome,
} from "./healing/self-healing-optional-step-revision.js";
import {
  optionalStepRevisionKey,
  countOptionalStepRevisionAttempts,
  optionalStepRevisionLogOutcome,
} from "./healing/self-healing-optional-step-revision.js";

export {
  extractTaskIdFromTempMergeDir,
  getErrorMessage,
  isTaskNotFoundError,
  buildResumeLimboStepSignature,
  formatRecoveryTimestamp,
  matchGlob,
  matchesScope,
} from "./healing/self-healing-path-utils.js";
import {
  extractTaskIdFromTempMergeDir,
  getErrorMessage,
  isTaskNotFoundError,
  buildResumeLimboStepSignature,
  formatRecoveryTimestamp,
  matchesScope,
} from "./healing/self-healing-path-utils.js";


const log = createLogger("self-healing");

/*
DELIBERATE-LITERAL — the no-metadata fallback for dependency satisfaction, mirroring
`isLegacyDependencySatisfied` in scheduler.ts (reviewed there 2026-07-30-20:40).

Reached ONLY when `resolveDependencySatisfactionColumns` left a dependency unmapped, i.e. its workflow
could not be read at all. DELETING these literals does not "finish the conversion" — it makes an
unresolvable dependency read as never-satisfied, which blocks its dependent forever. That is strictly
worse than the legacy behaviour it would replace.

Hoisted to module scope so the marker sits in the node's LEADING comments, which is where the census
looks; inline in the conditional it was attached to the wrong node and scored as three unconverted
guards (86 -> 89 on #2883).
*/
function isDependencySatisfiedWithoutWorkflowMetadata(column: string): boolean {
  return column === "done" || column === "archived" || column === "in-review";
}
const worktreeMetadataReconcileLog = createLogger("worktree-metadata-reconcile");
/*
FNXC:EngineDiagnostics 2026-07-26-10:25:
Self-healing no-action/skip/defer/worktrunk-skip/maintenance lifecycle lines fire every sweep and drowned recoveries in the TUI. Those are debug (FUSION_DEBUG=self-healing). Keep log/warn/error for real recoveries (Recovered/Reclaimed/Cleaned/Revived/…), stuck kills, and failures.
*/
const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediateCb(resolve));
const DONE_TASK_INTEGRITY_SWEEP_LIMIT = 50;
const BOARD_STALL_NOTIFICATION_COOLDOWN_MS = 60 * 60_000;
const DB_CORRUPTION_NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;
const PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER = 3;
const MAX_NO_PROGRESS_RESUME_ATTEMPTS = 2;

type WorkflowRecoveryRoute =
  | { kind: "node-requeue"; reason: "pause-abort-active-work" }
  | { kind: "work-item-resume"; reason: "pause-abort-review-progress" | "pause-abort-manual-merge-hold" }
  | { kind: "no-action"; reason: "not-pause-abort" | "unsafe-or-not-routable" };


function resolveRepoLocalAiMergeRoot(rootDir: string, settings?: Pick<Settings, "worktreesDir">): string {
  return resolveAiMergeRootPath(rootDir, settings);
}



type BranchGroupLandingRecorder = {
  recordBranchGroupMemberLanded?: (groupId: string, payload: {
    taskId: string;
    branchName: string;
    worktreePath: string | null;
    status: "open";
  }) => unknown;
};

// listTasks already enforces ACTIVE_TASKS_WHERE (`"deletedAt" IS NULL`), but
// deadlock/stall sweeps still defensively skip soft-deleted rows in case a
// future caller bypasses that contract (includeDeleted, fixtures, ad-hoc SQL).

export async function archiveAsGhostBug(
  store: TaskStore,
  taskId: string,
  taskTitle: string,
  decision: GhostBugDecision,
): Promise<void> {
  await store.logEntry(
    taskId,
    "Auto-archived as ghost bug — cited code construct not present on main",
    JSON.stringify({ reason: decision.reason, findings: decision.findings }, null, 2),
  );
  await store.recordActivity({
    type: "task:auto-archived-ghost-bug",
    taskId,
    taskTitle,
    details: "Cited construct not found on main",
    metadata: {
      reason: decision.reason,
      findings: decision.findings.slice(0, 10),
    },
  });
  // #1411: recovery/terminal move — recoveryRehome skips order-derived adjacency
  // so a custom-workflow card can always reach the terminal column.
  await store.moveTask(taskId, await resolveArchiveTargetForTask(store, taskId), { moveSource: "engine", recoveryRehome: true });
}

async function classifyOwnedLandedEvidenceForSelfHealing(rootDir: string, task: Task, mergeTargetBranch: string): Promise<OwnedLandedClassification> {
  const { classifyOwnedLandedEvidence } = await import("./merger.js");
  return classifyOwnedLandedEvidence(rootDir, task, { mergeTargetBranch });
}



async function preserveWorktreeChanges(repoDir: string, worktreePath: string, taskId: string): Promise<string | null> {
  try {
    const status = (await execAsync("git status --porcelain", { cwd: worktreePath, encoding: "utf-8" })).stdout.trim();
    if (!status) {
      return null;
    }

    const diff = (await execAsync("git diff HEAD --binary", { cwd: worktreePath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 })).stdout;
    const recoveryDir = join(repoDir, ".fusion", "recovery");
    mkdirSync(recoveryDir, { recursive: true });
    const patchPath = join(recoveryDir, `${taskId.toLowerCase()}-${formatRecoveryTimestamp()}.patch`);
    writeFileSync(patchPath, diff, "utf-8");
    return patchPath;
  } catch (error) {
    log.warn(`Failed to preserve worktree changes for ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}



/*
FNXC:PlanningEvacuation 2026-07-25-23:20:
The pre-execution worktree sweep touches VERY OLD trees only. Planning-acquired worktrees are cheap to
re-create but expensive to lose track of, and a card parked for a few hours is routinely resumed — so
the sweep waits a month of complete inactivity before reclaiming anything. The event-driven release on
an explicit operator withdrawal (todo -> Ideas) is separate and immediate; this constant governs only
the unattended background pass.
*/
const PRE_EXECUTION_WORKTREE_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SelfHealingOptions {
  /** Project root directory (parent of .worktrees/) */
  rootDir: string;
  /*
   * FNXC:PlanReviewLease 2026-07-26-20:30:
   * This engine's cluster node id, matching what the graph stamps into
   * `WorkflowStepResult.leaseNodeId`. Only used to recognize review-gate leases left by a PREVIOUS
   * process on this same node so they can be reclaimed immediately rather than waiting out the
   * 15-minute staleness floor. Unset (single-node, tests) keeps floor-only semantics.
   */
  localNodeId?: string;
  /** Optional callback to release TaskExecutor in-memory worktree ownership for a task. */
  releaseExecutorWorktreeOwnership?: (taskId: string) => void;
  /**
   * FN-6782: read-only snapshot of the executor's in-memory worktree holders
   * ({ taskId, worktreePath }), so the leaked-slot reaper can cross-check each
   * holder's task column and reclaim a slot whose holder is no longer in-progress.
   */
  listWorktreeHolders?: () => Array<{ taskId: string; worktreePath: string }>;
  /**
   * Optional callback to clear a demonstrably-stale executor binding without
   * touching live sessions. Returns `true` if the binding was cleared, `false`
   * if the executor refused because a live session surface is still registered
   * (the leaked-slot reaper relies on this refusal signal).
   */
  clearPhantomExecutorBinding?: (taskId: string, options?: { preserveWorktrees?: boolean }) => boolean | void;
  /*
  FNXC:NodeWorktreeIsolation 2026-07-29-06:05 (FN-6756):
  READ-ONLY liveness probe. Lets a sweep gate on "is an agent working this task?"
  WITHOUT the destructive release, so it can refuse before mutating and still hold
  ownership until its own writes commit. Same expression as
  clearPhantomExecutorBinding's refusal, exposed rather than re-derived.
  */
  hasLiveSessionSurface?: (taskId: string) => boolean;
  /*
  FNXC:PlanningEvacuation 2026-07-25-23:00:
  Releases a task's PRE-EXECUTION worktree (acquired at planning time) when the card is parked
  without ever executing. The executor owns the safety conditions — never executed, no live session,
  clean branch — so this sweep only supplies candidates. Returns true when a worktree was released.
  */
  releasePreExecutionWorktree?: (taskId: string, reason: string) => Promise<boolean>;
  /** Optional AgentStore for agent-level self-healing checks. */
  agentStore?: AgentStore;
  /** Canonical stale-lease recovery manager. */
  leaseManager?: MeshLeaseManager;
  /**
   * Callback to recover a completed task that is stranded in todo/in-progress.
   * Called by periodic self-healing passes when task work is complete but the
   * final transition never happened (for example killed after task_done).
   *
   * Should return true if the task was successfully transitioned, false if
   * recovery failed.
   */
  recoverCompletedTask?: (task: Task) => Promise<boolean>;
  /**
   * Returns the set of task IDs currently being executed by the executor.
   * Used to avoid recovering tasks that are actively being worked on.
   */
  getExecutingTaskIds?: () => Set<string>;
  /**
   * Recover a triage task whose spec was approved but whose final transition
   * out of `status: "planning"` never completed.
   */
  recoverApprovedTriageTask?: (task: Task) => Promise<boolean>;
  /**
   * Returns the set of task IDs currently being specified by triage.
   * Used to avoid recovering active triage sessions.
   */
  getPlanningTaskIds?: () => Set<string>;
  /** True only while the executor owns a graph Plan Review session for this task. */
  hasActivePlanningWorkflowSession?: (taskId: string) => boolean;
  /** Atomically fence planner ownership while advanced triage recovery runs. */
  reserveAdvancedTriageRecovery?: (taskId: string) => (() => void) | undefined;
  /**
   * Evict tasks from the triage processor's `processing` set that have been
   * there longer than the staleness threshold (hung promises from stuck kills).
   * Called before recovery checks so stale entries don't block recovery.
   */
  evictStaleTriageProcessing?: () => Set<string>;
  /**
   * Auto-revive an `in-review` task whose pre-merge workflow step failed.
   * Delegates to the executor, which injects the failure feedback into
   * `PROMPT.md`, resets steps, and schedules todo → in-progress.
   *
   * Should return true if the task was successfully sent back, false otherwise.
   */
  recoverFailedPreMergeStep?: (task: Task) => Promise<boolean>;
  /**
   * Re-enqueue a task into the auto-merge queue. Used by
   * `recoverInterruptedMergingTasks` so that a stale `merging` status that was
   * just cleared is retried immediately instead of waiting on the next
   * 15s polling sweep — and so the engine's in-memory `mergeActive` set is
   * refreshed (otherwise a leftover entry from a SIGKILL'd merge would cause
   * the polling sweep's enqueue to silently no-op).
   */
  enqueueMerge?: (taskId: string) => boolean;
  requeueForAutoMerge?: (taskId: string) => boolean | void | Promise<boolean | void>;
  isTaskActive?: (taskId: string) => boolean;
  clearMergeActive?: (taskId: string) => void;
  /**
   * Minimum age before a transient merge status is considered stale when no
   * active merge session is associated with that task.
   */
  staleMergingStatusMinAgeMs?: number;
  /**
   * Returns the task ID actively merging in this engine process, if any.
   * Used to avoid clearing a transient merge status mid-merge.
   */
  getActiveMergeTaskId?: () => string | null;
  /**
   * Wall-clock ms when the current active merge session was claimed
   * (`activeMergeTaskId` set). Used to reclaim wedged merges without trusting
   * `task.updatedAt` (overseer/logEntry refresh that field continuously).
   */
  getActiveMergeStartedAtMs?: () => number | null;
  /**
   * Force-abort the in-process active merge for `taskId` (AbortController +
   * session dispose + clear identity) so drainMergeQueue can settle even when
   * the agent ignores cooperative abort. Returns true when this task was the
   * active owner and abort was issued.
   */
  abortActiveMerge?: (taskId: string, reason: string) => boolean;
  /*
  FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU — merge-queue dispatch blind spot):
  Returns true if the task is ANYWHERE in ProjectEngine's in-memory merge pipeline — queued in
  `mergeQueue` OR dequeued-and-merging (`mergeActive`). Unlike `getActiveMergeTaskId` (only the
  single in-flight rawMerge) and the session-registry / executingTaskLock / land-lease signals,
  this covers the dequeue→rawMerge window where a workspace task is being merged but NONE of those
  signals fire yet. The workspace reconcilers consult it before re-enqueuing a partial-land
  candidate (prevents a second concurrent `landWorkspaceTask` → double-squash) or reclaiming a
  workspace-repo-land lease (the owner is mid-dispatch and is about to register that lease).
  Undefined = "not pending" (graceful when unwired); production always wires it.
  */
  isMergePending?: (taskId: string) => boolean;
  /**
   * Minimum blocker age before stale merge fan-out is cleared from downstream
   * blockedBy pointers. Must be >= staleMergingStatusMinAgeMs.
   */
  staleMergingFanoutMinAgeMs?: number;
  /**
   * Grace window for treating in-review merging statuses as unbacked when no
   * active merger owns the task. Intended for manual retry/unpause refreshes.
   */
  unbackedMergingFanoutGraceMs?: number;
  hasActiveAgentExecution?: (agentId: string) => boolean;
  /**
   * Re-dispatches an agent's orphaned assigned in-progress execution forward,
   * via Executor.resumeTaskForAgent. This must never move the task backward in
   * lifecycle; the executor seam owns all in-memory double-execution guards.
   */
  resumeAssignedTaskForAgent?: (agentId: string) => Promise<void>;
  restartDurableAgentHeartbeat?: (agentId: string, context: { reason: string; attempt: number }) => Promise<boolean>;
  autoRecoveryDispatcher?: AutoRecoveryDispatcher;
  /** Optional ChatStore for maintenance chat-retention cleanup. */
  chatStore?: ChatStore;
  /** Optional MessageStore for maintenance mail-retention cleanup. */
  messageStore?: MessageStore;
  /** Optional notifier for board-stall unrecovered alerts. */
  ntfyNotifier?: Pick<NtfyNotifier, "notifyBoardStallUnrecovered">;
  getProjectId?: () => string;
  /** Optional callback to reconcile active mission features during maintenance. */
  reconcileAllMissionFeatures?: () => Promise<number>;
  /** Optional callback to re-run mission validation recovery during maintenance. */
  recoverActiveMissionValidations?: () => Promise<{ recoveredCount: number }>;
  /** Optional callback to reap stale mission validator runs during startup and maintenance. */
  reapStaleMissionValidatorRuns?: () => Promise<{ reapedCount: number }>;
  /**
   * U8 (CLI Agent Executor): returns true when a worktree path backs a
   * resume-eligible `cli_sessions` record. Idle-worktree sweeps
   * (`enforceWorktreeCap`, `cleanupOrphans`, `reapUnregisteredOrphans`) MUST
   * treat such a worktree as in-use, so a reaped-but-resumable session cannot
   * have its worktree reclaimed out from under it before the resume coordinator
   * relaunches the CLI. Narrow seam: a single predicate; absence (undefined)
   * preserves the prior behavior. The path passed is the absolute worktree dir.
   */
  isWorktreeResumeReserved?: (worktreePath: string) => boolean;
}

const APPROVED_TRIAGE_RECOVERY_GRACE_MS = 60_000;
const STARVED_REFINEMENT_RECOVERY_GRACE_MS = 10 * 60_000;
const STARVED_PEER_PROGRESS_THRESHOLD = 3;
const STARVED_REFINEMENT_ESCALATION_COOLDOWN_MS = STARVED_REFINEMENT_RECOVERY_GRACE_MS * 4;
const ORPHANED_EXECUTION_RECOVERY_GRACE_MS = 60_000;
/**
 * FN-6782 leaked-slot reaper grace: a worktree holder whose task has sat in a
 * reapable column (todo/triage) shorter than this is left alone, so the reaper
 * never races a task mid-transition out of in-progress.
 */
const STALLED_CARD_WATCHDOG_MS = 30 * 60_000;
const LEAKED_WORKTREE_SLOT_GRACE_MS = 60_000;
/*
FNXC:MergeQueue 2026-07-15-09:50:
AI merge sets status="reviewing" during the clean-room review pass (merger-ai mergeAndReview). That is still live merge activity. Without it here, recoverInterruptedMergingTasks ignored hung review-phase merges and the single-flight pump stayed wedged while the board showed no merging badge.
*/
/*
FNXC:MergeQueue 2026-07-15-10:40:
Include landing (post-approve advance/cleanup) with reviewing so a hung worktree remove cannot leave the single-flight pump un-reclaimable while the board shows no merging badge.
*/
/*
FNXC:MergeReliability 2026-07-15-21:45 (FN-8004 follow-up):
Moved to the leaf `merge-active-status.ts` and re-exported so the dashboard's manual Retry gate
shares ONE definition with this sweep. Previously the manual gate hardcoded its own stricter view
and refused to retry ANY merge-active status, so an orphaned `landing` stamp was un-retryable by
hand while this sweep cleared it automatically minutes later.
*/
import { ACTIVE_MERGE_STATUSES, DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS, isStaleMergeActiveStatus } from "./merge/merge-active-status.js";
export { ACTIVE_MERGE_STATUSES, DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS, isMergeActiveStatus, isStaleMergeActiveStatus } from "./merge/merge-active-status.js";
const NON_TERMINAL_STEP_STATUSES = new Set(["pending", "in-progress"]);
const STRANDED_COMPLETED_TODO_ACTIVE_STATUSES = new Set([
  "in-progress",
  "planning",
  "specifying",

  "merging",
  "merging-pr",
  "merging-fix",
  "mission-validation",
]);
/** Statuses that represent an explicit human-handoff or active merge —
 *  the ghost-review fallback must not disturb tasks parked in these states. */
const GHOST_REVIEW_PRESERVED_STATUSES = new Set([
  "failed",
  "awaiting-user-review",
  "awaiting-approval",
  "merging",
  "merging-pr",
  "merging-fix",
]);
/**
 * Longer grace period for tasks that still have a worktree on disk.
 * This avoids racing with `executor.resumeOrphaned()` which runs on
 * engine startup and may legitimately re-execute these tasks.
 * 5 minutes is well past any startup window.
 */
const ORPHANED_WITH_WORKTREE_GRACE_MS = 300_000;

/**
 * Maximum times a task can be auto-requeued after the agent exits without
 * calling `fn_task_done`. Bounded so a persistently-broken task cannot loop
 * forever; when exhausted the task stays in `in-review` for human inspection.
 */
const MAX_TASK_DONE_RETRIES = 3;
const RECONCILE_SCOPE_OVERRIDE_MERGE_ACTIVE_STATUS_SET = new Set<string>(MERGE_ACTIVE_MISSING_WORKTREE_STATUSES);
/**
 * FNXC:WorkflowLifecycle 2026-06-20-00:00: single source of truth for the
 * pause-abort park error message markers. The executor's handleGraphFailure
 * builds the parked-failure message from these, and `recoverPausedAbortFailures`
 * matches on them — sharing the constants prevents the recovery predicate from
 * silently drifting if the message text is ever edited (greptile review on
 * PR #1687: a string-coupled predicate breaks with no compile-time signal).
 */
/**
 * FNXC:AutoMergeRetries 2026-06-17-04:20:
 * Keep this export as the historical default seed for tests and dashboard fallback alignment, but SelfHealingManager must call resolveMaxAutoMergeRetries(settings) at decision points so configured projects do not recover or stall at the old fixed value.
 */
// FN-5627: classifier extracted to `transient-merge-error-classifier.ts`
// to avoid pulling `createLogger` into modules that mock `../logger.js`
// (notification-service tests in particular). Re-exported here for callers
// that already depend on `self-healing.ts` exports.
import { classifyTransientMergeError } from "./errors/transient-merge-error-classifier.js";
export { classifyTransientMergeError } from "./errors/transient-merge-error-classifier.js";
const MAX_STARVATION_DROPS = 3;
const DEADLOCK_RECOVERY_COOLDOWN_MS = 15 * 60_000;
// DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS now lives in ./merge-active-status.js (imported above)
// so the manual Retry gate and this sweep cannot drift apart (FN-8004 follow-up).
const DEFAULT_STALE_MERGING_FANOUT_MIN_AGE_MS = 15 * 60_000;
const DEFAULT_UNBACKED_MERGING_FANOUT_GRACE_MS = 60_000;
const DURABLE_ERROR_RECOVERY_BASE_COOLDOWN_MS = 30_000;
const DURABLE_ERROR_RECOVERY_MAX_COOLDOWN_MS = 15 * 60_000;
const RUNNING_ON_INACTIVE_TASK_STALE_RUN_MS = PARKED_AGENT_LINK_FRESH_RUN_MS;

function bumpTaskPriority(priority: TaskPriority | undefined): TaskPriority {
  switch (priority ?? "normal") {
    case "low":
      return "normal";
    case "normal":
      return "high";
    case "high":
      return "urgent";
    case "urgent":
      return "urgent";
  }
}

export async function autoRecoverWorktreeSessionStartFailure(
  store: TaskStore,
  task: Task,
  opts: {
    failure: unknown;
    source: "executor-session-start" | "in-review-sweep" | "merge-active-sweep" | "resume-guard";
    auditor: RunAuditor | null;
    forceClearWorktreeMetadata?: boolean;
    resetRetryBudgetOnStaleMetadataClear?: boolean;
    staleMetadataClearRecoveryRetryCount?: number;
    /**
     * FNXC:MissingWorktreeRecovery 2026-07-26-08:35:
     * Project root. Pass it whenever the caller has one so the liveness probe can also reject a
     * recorded worktree that IS the main checkout (FN-6861 repo-root requeue loop). Optional so
     * narrow test callers and any future caller without a root still type-check.
     */
    rootDir?: string;
  },
): Promise<{ outcome: "requeue-todo" | "escalate-exhausted"; retries: number; classification: "missing" | "incomplete" | "unregistered" | "unknown" }> {
  const classification = classifyMissingWorktreeSessionStartFailure(opts.failure);
  /*
  FNXC:MissingWorktreeRecovery 2026-07-10-18:15:
  Upstream #1992 showed merge-active review-fix sessions can exhaust the unusable-worktree retry budget while every retry reuses the same phantom worktree metadata. When a guarded recovery clears that stale worktree/branch/session reference, the next dispatch must get a fresh session-start retry budget instead of inheriting the exhausted context that caused the strand.

  FNXC:MissingWorktreeRecovery 2026-07-10-21:36:
  The merge-active sweep still needs a bounded human-escalation circuit breaker after clearing stale metadata, so it tracks those guarded clears through recoveryRetryCount instead of repeatedly resetting worktreeSessionRetryCount to zero on every recurrence.
  */
  const resetRetryBudget = opts.resetRetryBudgetOnStaleMetadataClear === true;
  const staleMetadataClearRecoveryRetryCount = opts.staleMetadataClearRecoveryRetryCount;
  const currentStaleMetadataClearRecoveryCount = staleMetadataClearRecoveryRetryCount ?? 0;
  const nextStaleMetadataClearRecoveryCount = staleMetadataClearRecoveryRetryCount === undefined
    ? undefined
    : currentStaleMetadataClearRecoveryCount + 1;
  if (nextStaleMetadataClearRecoveryCount !== undefined && nextStaleMetadataClearRecoveryCount > MAX_WORKTREE_SESSION_RETRIES) {
    await store.logEntry(
      task.id,
      `Auto-recovery exhausted (${MAX_WORKTREE_SESSION_RETRIES}/${MAX_WORKTREE_SESSION_RETRIES}) for merge-active unusable-worktree stale-metadata clears — leaving in-review for human inspection`,
    );
    await opts.auditor?.database({
      type: "task:auto-recover-worktree-session-exhausted",
      target: task.id,
      metadata: {
        retries: currentStaleMetadataClearRecoveryCount,
        maxRetries: MAX_WORKTREE_SESSION_RETRIES,
        source: opts.source,
        counter: "recoveryRetryCount",
      },
    });
    return { outcome: "escalate-exhausted", retries: currentStaleMetadataClearRecoveryCount, classification };
  }
  const nextCount = resetRetryBudget ? 0 : (task.worktreeSessionRetryCount ?? 0) + 1;
  if (!resetRetryBudget && nextCount > MAX_WORKTREE_SESSION_RETRIES) {
    await store.logEntry(
      task.id,
      `Auto-recovery exhausted (${MAX_WORKTREE_SESSION_RETRIES}/${MAX_WORKTREE_SESSION_RETRIES}) for unusable-worktree session-start failure — leaving in-review for human inspection`,
    );
    await opts.auditor?.database({
      type: "task:auto-recover-worktree-session-exhausted",
      target: task.id,
      metadata: {
        retries: task.worktreeSessionRetryCount ?? 0,
        maxRetries: MAX_WORKTREE_SESSION_RETRIES,
        source: opts.source,
      },
    });
    return { outcome: "escalate-exhausted", retries: task.worktreeSessionRetryCount ?? 0, classification };
  }

  const staleWorktree = task.worktree;
  const missingWorktreePath = extractMissingWorktreePathFromSessionStartFailure(opts.failure);
  /*
  FNXC:MissingWorktreeRecovery 2026-07-26-07:15:
  A failing path that DIFFERS from `task.worktree` does not prove the recorded worktree is live.
  The reported strand (in-review MG-047) had both gone: an AI-merge clean room refused as an
  "incomplete worktree" while the recorded task worktree had already been removed. The mismatch
  branch preserved that dead path, so every requeue re-dispatched into a directory that no longer
  existed ("Working directory does not exist: …" / "Cannot execute bash commands") until the retry
  budget burned out and the card parked failed in review. Preserve the recorded worktree only when
  it is STILL a usable checkout; otherwise clear it so the next dispatch builds a fresh one from
  the branch.

  `hasUsableWorktreeShape` is the deliberately NARROW probe (see its own note in worktree-pool.ts):
  recovery must not spawn git to decide how to recover from a git failure, so it proves only that
  the path exists, carries `.git`, and is not the repo root. A stale-but-present `.git` pointer
  therefore still reads as usable and is preserved here; the executor's own session-start assertion
  is the backstop that catches that shape and routes it back through this recovery with the path now
  named in the failure, at which point the branch below clears it.

  FNXC:MissingWorktreeRecovery 2026-07-26-08:35:
  WHAT THIS DECISION ACTUALLY CONTROLS: `branch`. The rebound below is a reopen move
  (in-review/in-progress -> todo|triage), and a reopen CLEARS `task.worktree` unless the caller
  passes `preserveWorktree` (packages/core/src/task-store/moves.ts + default-workflow-hooks.ts
  applyResetOnEntryEffects) — which this recovery deliberately does not, because a fresh checkout is
  the correct thing to hand the next dispatch. The `worktree` value written here is therefore
  overwritten by the move on every reopen path; it is kept in the patch only so the row is coherent
  for the non-reopen case (already sitting in the rebound column, where no reopen effects fire).
  Do not read the preserve branch as "the worktree survives" — it does not.
  */
  const recordedWorktreeStillUsable = hasUsableWorktreeShape(staleWorktree, opts.rootDir);
  const hasMismatchedLiveWorktree =
    recordedWorktreeStillUsable
    && typeof missingWorktreePath === "string" && missingWorktreePath.length > 0
    && resolve(staleWorktree as string) !== resolve(missingWorktreePath);
  const noProgress = !hasStepProgress(task);
  const forceClearWorktreeMetadata = opts.forceClearWorktreeMetadata === true;
  const clearWorktreeMetadata = noProgress || forceClearWorktreeMetadata || !hasMismatchedLiveWorktree;
  /*
  FNXC:MissingWorktreeRecovery 2026-07-26-08:35:
  Clearing `branch` is only safe for the CANONICAL `fusion/<id>` name, which acquisition re-derives
  from the task id (resolveTaskWorkingBranch) — dropping it costs nothing. A non-canonical branch
  (a `-2` suffix, a legacy case-mismatched name) is NOT re-derivable, so nulling it would abandon the
  only pointer to the card's commits. Keep such a branch even while clearing the dead worktree; the
  worktree is rebuilt from whatever branch survives.
  */
  const branchIsRederivable =
    typeof task.branch !== "string"
    || task.branch.length === 0
    || task.branch.toLowerCase() === `fusion/${task.id}`.toLowerCase();
  const nextBranch = clearWorktreeMetadata && branchIsRederivable ? null : task.branch ?? null;

  await store.updateTask(task.id, {
    status: null,
    error: null,
    worktreeSessionRetryCount: nextCount,
    ...(nextStaleMetadataClearRecoveryCount === undefined ? {} : { recoveryRetryCount: nextStaleMetadataClearRecoveryCount }),
    worktree: clearWorktreeMetadata ? null : staleWorktree,
    branch: nextBranch,
    sessionFile: null,
  });
  await opts.auditor?.database({
    type: "task:auto-recover-worktree-session-metadata",
    target: task.id,
    metadata: {
      source: opts.source,
      classification,
      // The decision this recovery makes, as ids/outcomes-only facts an agent can read without
      // parsing the human log prose below (agent-native parity with the dashboard activity log).
      recordedWorktreeStillUsable,
      clearedWorktreeMetadata: clearWorktreeMetadata,
      clearedBranch: nextBranch === null && (task.branch ?? null) !== null,
      retainedNonCanonicalBranch: clearWorktreeMetadata && !branchIsRederivable,
    },
  });

  const rawFailureExcerpt = typeof task.error === "string"
    ? task.error.slice(0, 200)
    : opts.failure instanceof Error
      ? opts.failure.message.slice(0, 200)
      : String(opts.failure).slice(0, 200);
  const failureExcerpt = isMissingWorktreeSessionStartFailure(rawFailureExcerpt)
    ? "session-start unusable-worktree assertion"
    : rawFailureExcerpt;
  const attemptLabel = resetRetryBudget
    ? `retry budget reset from ${task.worktreeSessionRetryCount ?? 0}/${MAX_WORKTREE_SESSION_RETRIES}`
    : `attempt ${nextCount}/${MAX_WORKTREE_SESSION_RETRIES}`;
  /*
  FNXC:WorkflowLifecycleTraits 2026-07-19-06:30 (U6 / KTD-10):
  Requeue the recovered card to the workflow's TRAIT-derived backlog column (hold →
  intake → first), not the literal "todo". builtin:coding resolves to `todo` (its
  hold column) so the log + move stay byte-identical; a custom workflow that renamed
  or omitted `todo` lands its recovered card in a valid backlog column instead of
  stranding it. One IR resolution per recovered task (a rare failure path, not a
  sweep loop) so this stays within the no-per-task-resolution-in-enumeration rule.
  */
  let reboundColumn = "todo";
  try {
    reboundColumn = resolveReboundTarget(await resolveWorkflowIrForTask(store, task.id)) ?? "todo";
  } catch {
    // Keep the legacy literal on any IR-resolution failure.
  }
  await store.logEntry(
    task.id,
    noProgress
      ? `Auto-recovered (no-progress): session-start refused unusable worktree${staleWorktree ? ` (${staleWorktree})` : ""} — cleared stale session metadata and requeued to ${reboundColumn} (${attemptLabel}, failure: ${failureExcerpt})`
      : hasMismatchedLiveWorktree && !forceClearWorktreeMetadata
        ? `Auto-recovered: stale resume referenced unusable worktree (${missingWorktreePath}) while the recorded task worktree ${staleWorktree} is still a live checkout — cleared stale session metadata and requeued to ${reboundColumn} (${attemptLabel}, failure: ${failureExcerpt})`
        /*
        FNXC:MissingWorktreeRecovery 2026-07-26-08:35:
        Name WHICH path was unusable. The old single sentence credited the failure to the recorded
        worktree even when the session had actually targeted some other path (an AI-merge clean
        room), which is what made the MG-047 strand unreadable from the activity log: the operator
        saw "targeted unusable worktree (<task worktree>)" while the refusal named the clean room.
        */
        : `Auto-recovered: session start refused unusable worktree${missingWorktreePath ? ` (${missingWorktreePath})` : ""}${
          staleWorktree && (!missingWorktreePath || resolve(staleWorktree) !== resolve(missingWorktreePath))
            ? `; the recorded task worktree ${staleWorktree} is ${recordedWorktreeStillUsable ? "still present" : "gone too"}`
            : ""
        } — cleared stale session metadata${clearWorktreeMetadata && !branchIsRederivable ? ` (kept non-canonical branch ${task.branch})` : ""} and requeued to ${reboundColumn} (${attemptLabel}, failure: ${failureExcerpt})`,
  );
  if (noProgress) {
    // #1411: backward recovery move — recoveryRehome skips order-derived adjacency.
    await store.moveTask(task.id, reboundColumn, { moveSource: "engine", recoveryRehome: true });
  } else {
    await store.moveTask(task.id, reboundColumn, { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
  }
  return { outcome: "requeue-todo", retries: nextCount, classification };
}

type RebindOutcome =
  | {
    taskId: string;
    result: "applied";
    branch: string;
    aheadCount: number;
    integrationBase: string;
    previousBranch: string | null;
  }
  | {
    taskId: string;
    result: "skipped";
    reason:
      | "binding-intact"
      | "no-live-branch"
      | "ambiguous-candidates"
      | "no-unique-work"
      | "unsafe-to-auto-mutate:user-paused"
      | "unsafe-to-auto-mutate:checked-out"
      | "workspace-task";
    candidates?: Array<{ branch: string; aheadCount: number }>;
  };

type AutoRebindSafetyResult =
  | { safe: true }
  | {
    safe: false;
    reason: "unsafe-to-auto-mutate:user-paused" | "unsafe-to-auto-mutate:checked-out";
    detail: string;
  };

export type RebindResult = { repaired: number; outcomes: RebindOutcome[] };


/**
 * Decide whether a git commit belongs to a given task.
 *
 * Ownership is line-anchored and subject-anchored: it is NOT sufficient for the
 * task ID to appear in prose. FN-5441/FN-5446 regression — both were
 * mis-attributed to e3dbfaae (an FN-5483 commit whose body merely *mentioned*
 * them by name) because the previous `subject.includes(taskId)` check matched
 * any substring anywhere in the subject.
 *
 * Accept (any of):
 *  - `Fusion-Task-Lineage: <lineageId>` as a complete trailer line in the body
 *  - `Fusion-Task-Id: <taskId>` as a complete trailer line in the body
 *  - Subject anchored on the task ID in conventional-commit form:
 *      `<type>(<taskId>): …` or `<taskId>: …` or `<type>(<taskId>/...): …`
 */





function hasTerminalInvalidDoneTransition(task: Pick<Task, "error">): boolean {
  const error = task.error ?? "";
  return error.includes("Invalid transition:") && error.includes("→ 'done'");
}

/** Sentinel for a workflow selection whose READ failed, distinct from "no selection". */
const UNREADABLE_WORKFLOW_SELECTION = "\u0000unreadable-workflow-selection";

export class SelfHealingManager extends SelfHealingGitEvidence {
  // ── Auto-unpause state ──────────────────────────────────────────────
  private unpauseTimer: ReturnType<typeof setTimeout> | null = null;
  private unpauseAttempt = 0;
  private lastPauseTriggeredAt = 0;
  private lastUnpauseAt = 0;

  // ── Maintenance timer ───────────────────────────────────────────────
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private maintenanceRunning = false;

  // ── Event listener cleanup ──────────────────────────────────────────
  private settingsListener: ((data: { settings: Settings; previous: Settings }) => void) | null = null;
  /* FNXC:WorkflowResolvedColumns 2026-07-31-23:40: `lanes` is the emitter-resolved payload #3109
     added; optional, because an emit path that cannot resolve sends none. */
  private taskMovedFanoutListener: ((data: { task: Task; from: string; to: string; source: string; lanes?: TaskMoveLanes }) => void) | null = null;

  // ── Per-task deadlock recovery cooldown ─────────────────────────────
  private deadlockRecoveryCooldown: Map<string, number> = new Map();
  private mergeStarvationDrops: Map<string, number> = new Map();
  /*
  FNXC:Workspace 2026-06-22-14:10 (Phase D review B/E — bounded workspace re-enqueue / orphan-remove):
  Per-task drop counter for the workspace partial-land re-enqueue (mirror of `mergeStarvationDrops`):
  `enqueueMerge` returns false when the merge queue rejects (full). Without bounding, a perpetually
  rejected workspace task is re-enqueued FOREVER. After MAX_STARVATION_DROPS consecutive drops we
  park it `status:"failed"`. `orphanWorktreeRemovalFailures` likewise bounds the per-path
  `git worktree remove --force` retry in reconcileOrphanedWorkspaceWorktrees.
  */
  private workspacePartialLandDrops: Map<string, number> = new Map();
  private orphanWorktreeRemovalFailures: Map<string, number> = new Map();
  private finalizeUnprovenWarned = new Set<string>();
  /*
   * FNXC:Lifecycle 2026-07-16-10:30:
   * FN-8141 dedup: `task:reconcile-stranded-completed-no-action` is emitted at most once per taskId
   * while a failure-provenance block persists, so the sweeps don't spam run-audit every housekeeping
   * cycle. Cleared on stop(); a fresh clean execution that clears the block re-arms emission naturally
   * because the task leaves the promotable state before returning to it.
   */
  private strandedCompletedFailureProvenanceWarned = new Set<string>();
  /*
   * FNXC:StrandedHoldContinuation 2026-07-26-14:15:
   * FN-8592 no-action findings are candidate-only but can persist across
   * maintenance passes. Keep their `(taskId, reason)` memo on the manager,
   * rather than recreating it per sweep, so periodic recovery stays visible
   * without flooding run-audit.
   */
  private strandedHoldContinuationNoActionAudited = new Set<string>();
  /* FNXC:SymbolLock 2026-07-30-14:20: idle symbol-lock sweeps emit one no-action audit until a stale lock re-arms the diagnostic. */
  private symbolLockNoActionAudited = false;
  private maintenanceTickCounter = 0;
  private readonly taskLifecycleRetentionLastPrunedAt = new Map<string, number>();
  private readonly githubCheckStateRetentionLastPrunedAt = new Map<string, number>();
  private readonly processBootStartedAt = Date.now();
  private lastDbCorruptionNotifiedAt: number | null = null;

  private boardStallWindow: {
    windowStartMs: number;
    windowStartBlockedDepth: number;
    transitionsOutOfInProgressInWindow: number;
    pendingVerification: { holderIds: string[]; followerCount: number; startedAt: number; tick: number } | null;
    lastNtfyAt: number | null;
  } | null = null;

  /*
   * FNXC:ApprovalHold 2026-07-09-00:15:
   * FN-7736: AWAITING_APPROVAL_PAUSE_REASON must be excluded here so a task
   * parked mid-execution on a pending tool-approval decision (`pauseForApproval`
   * -> `pauseTask(id, true, { pausedReason: AWAITING_APPROVAL_PAUSE_REASON })`)
   * is never rebounded to `todo` by this scope-decay sweep before the operator
   * approves or denies -- this was the reported symptom (a follower task's
   * scope-decay threshold elapsing could silently defeat the approval gate).
   */
  private static readonly PAUSED_SCOPE_DECAY_EXCLUDED_REASONS = new Set([
    "branch-conflict-unrecoverable",
    "worktrunk_operation_failed",
    "token_budget_exceeded",
    AWAITING_APPROVAL_PAUSE_REASON,
  ]);

  constructor(
    private store: TaskStore,
    protected readonly options: SelfHealingOptions,
  ) {
    /* U4 substrate PR1: the git-evidence readers moved to a base class, so this
       derived constructor needs an explicit super(). No other change. */
    super();
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-14:20 (fleet):
  `columns` is REQUIRED, not optional-with-a-literal-fallback. This router is called from exactly two
  places — the candidate filter and the post-re-read re-verify — and they must agree: an optional
  parameter lets one caller resolve and the other default, and the disagreement shows up as a recovery
  that selects a card and then declines to act on it, with nothing logged. Requiring it makes that
  divergence a compile error instead of a silent no-op. Degraded resolution is handled inside the two
  resolvers, which union the legacy ids, so "required" never means "callers must invent a column set".
  */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-14:20 (fleet):
  The column-FREE half of the pause-abort predicate, split out so the sweep can identify candidate rows
  without reading a workflow IR for every task on the board. It tests only the two error markers, which
  is what makes it safe to run over the full list.

  Deliberately NOT the whole guard: it omits the paused/executing checks as well as the column routing,
  because it is a prefilter and `classifyPausedAbortWorkflowRecovery` remains the single authority on
  whether a row is actually recoverable. Widening it into a second authority is how the filter and the
  re-verify drift apart.
  */
  private isPauseAbortParkCandidate(task: Task): boolean {
    return task.status === "failed"
      && typeof task.error === "string"
      && task.error.includes(PAUSE_ABORT_PARK_OPERATOR_MARKER)
      && task.error.includes(PAUSE_ABORT_PARK_ERROR_MARKER);
  }

  /** The review + active-work sets the pause-abort router needs, resolved together over one IR cache. */
  private async resolvePauseAbortColumnsFor(
    taskId: string,
    cache: Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>,
  ): Promise<{ review: ReadonlySet<string>; activeWork: ReadonlySet<string> }> {
    return {
      review: await this.resolveReviewColumnsFor(taskId, cache),
      activeWork: await this.resolveActiveWorkColumnsFor(taskId, cache),
    };
  }

  /*
  FNXC:SharedBranchMemberHold 2026-08-05-23:35:
  Pause-abort recovery must resolve the same live intermediate-group predicate as
  merge admission. Shared metadata alone is stale after group closure or a
  default-branch collision, so it cannot suppress that task's standalone hold.
  */
  private async isLiveSharedMemberIntegration(task: Task, settings: Settings): Promise<boolean> {
    const groupId = task.branchContext?.groupId?.trim();
    const group = groupId ? await (this.store as Partial<Pick<TaskStore, "getBranchGroup">>).getBranchGroup?.(groupId) : null;
    const defaultBranch = await resolveIntegrationBranch(this.options.rootDir, settings);
    return isLiveSharedBranchGroupMemberIntegration(task, group, defaultBranch);
  }

  private async classifyPausedAbortWorkflowRecovery(
    task: Task,
    settings: Settings,
    isExecuting: boolean,
    columns: { review: ReadonlySet<string>; activeWork: ReadonlySet<string> },
  ): Promise<WorkflowRecoveryRoute> {
    const isPausedAbortPark =
      task.status === "failed" &&
      typeof task.error === "string" &&
      task.error.includes(PAUSE_ABORT_PARK_OPERATOR_MARKER) &&
      task.error.includes(PAUSE_ABORT_PARK_ERROR_MARKER);
    if (!isPausedAbortPark) return { kind: "no-action", reason: "not-pause-abort" };
    if (task.paused || task.userPaused || isExecuting) return { kind: "no-action", reason: "unsafe-or-not-routable" };

    const errorText = typeof task.error === "string" ? task.error.toLowerCase() : "";
    const isTerminalMergePark = errorText.includes("conflict")
      || errorText.includes("contamination")
      || errorText.includes("foreign")
      || errorText.includes("retry-exhausted")
      || errorText.includes("retries exhausted")
      || errorText.includes("max retries");
    const completedSteps = task.steps.length > 0
      && task.steps.every((step) => step.status === "done" || step.status === "skipped");
    const liveSharedBranchMember = await this.isLiveSharedMemberIntegration(task, settings);
    const sharedMemberHold = hasSharedBranchMemberAutoMergeHold(task, settings);
    const autoMergeProcessing = !sharedMemberHold && (allowsAutoMergeProcessing(task, settings) || liveSharedBranchMember);
    const hasReviewProgress =
      columns.review.has(task.column)
      && autoMergeProcessing
      && task.mergeDetails?.mergeConfirmed !== true
      && !isTerminalMergePark
      && completedSteps;
    const hasManualMergeHoldProgress =
      columns.review.has(task.column)
      && (sharedMemberHold || !allowsAutoMergeProcessing(task, settings) || resolveEffectiveAutoMerge(task, settings) === false)
      // FNXC:SharedBranchMemberHold 2026-08-08-01:58: a project-level Off is
      // the same durable member hold as user Off at this recovery boundary.
      && (!liveSharedBranchMember || sharedMemberHold)
      && task.mergeDetails?.mergeConfirmed !== true
      && !isTerminalMergePark
      && completedSteps;

    /*
    FNXC:WorkflowRecoveryRouter 2026-06-29-11:47:
    Pause-abort self-healing should classify recovery intent before mutating task
    state. Active work routes to a workflow node requeue in todo; completed review
    progress routes to a work-item/review resume in-place. Unsafe rows stay
    untouched so invariant repair and human holds remain separate decisions.

    FNXC:WorkflowRecoveryRouter 2026-07-09-14:59:
    FN-7749 / FN-5147: an auto-merge-off manual merge hold is a human terminal `in-review` state. A stale pause-abort park in that state is recoverable only by clearing status/error in place; never move it backward, pause it, or re-enqueue it.
    */
    if (hasManualMergeHoldProgress) {
      return { kind: "work-item-resume", reason: "pause-abort-manual-merge-hold" };
    }
    if (hasReviewProgress) {
      return { kind: "work-item-resume", reason: "pause-abort-review-progress" };
    }
    if (columns.activeWork.has(task.column)) {
      return { kind: "node-requeue", reason: "pause-abort-active-work" };
    }
    return { kind: "no-action", reason: "unsafe-or-not-routable" };
  }

  public getActiveMergeTaskId(): string | null {
    return this.options.getActiveMergeTaskId?.() ?? null;
  }

  /** The configured staleness floor shared by automatic recovery and manual Retry. */
  public getStaleMergingStatusMinAgeMs(): number {
    return this.options.staleMergingStatusMinAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS;
  }

  private async isMergeLaneOwned(taskId: string): Promise<boolean> {
    if (this.options.getActiveMergeTaskId?.() === taskId) return true;

    try {
      const queue = await this.store.peekMergeQueue();
      return queue.some((entry) => entry.taskId === taskId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`Unable to inspect merge queue ownership for ${taskId}: ${errorMessage}`);
      return false;
    }
  }

  private async isFalseCompletionHandoffExhaustionWhileMergeOwned(task: Task): Promise<boolean> {
    // FNXC:WorkflowResolvedColumns 2026-07-30-22:25 (batch-engine): resolved review MEMBERSHIP, legacy id unioned in.
    const reviewColumns = await this.resolveReviewColumnsFor(task.id, new Map());
    return reviewColumns.has(task.column)
      && task.status === "failed"
      && typeof task.error === "string"
      && task.error.includes("Completion handoff limbo recovery exhausted")
      && await this.isMergeLaneOwned(task.id);
  }

  private emitTaskMerged(task: Task | undefined | null, overrides: Partial<MergeResult> = {}): void {
    if (!task) return;
    this.store.emit("task:merged", {
      task,
      branch: task.branch ?? "",
      merged: true,
      worktreeRemoved: false,
      branchDeleted: false,
      mergeConfirmed: task.mergeDetails?.mergeConfirmed,
      mergedAt: task.mergeDetails?.mergedAt,
      mergeTargetBranch: task.mergeDetails?.mergeTargetBranch,
      ...overrides,
    } as MergeResult);
  }

  private async handoffTaskToReview(taskId: string, reason: string): Promise<Task> {
    const runId = generateSyntheticRunId("self-heal-handoff", taskId);
    const handedOff = await this.store.handoffToReview(taskId, {
      ownerAgentId: null,
      evidence: {
        reason,
        runId,
        agentId: "self-healing",
      },
    });

    /*
    FNXC:AgentActivityStream 2026-08-09-11:50:
    Recovery handoffs bypass TaskExecutor.handoffTaskToReview, so they write the same durable event here with a closed self-healing source. Preserve a real assignee as a roster claim; only an unassigned recovery falls back to the executor lane, which must never create an org-map node. `handoffToReview` returns the same `updatedAt` for its same-column retry path, so that transition timestamp plus the reason is the deterministic discriminator. The generated run id is observability metadata only: it is random and must never defeat replay deduplication.
    */
    try {
      await this.store.recordAgentActivity({
        type: "task:handed-off",
        attributionClaim: resolveAgentActivityAttribution([{
          id: handedOff.assignedAgentId ?? "executor",
          provenance: handedOff.assignedAgentId ? "roster" : "lane",
        }], "executor"),
        taskId,
        occurredAt: handedOff.updatedAt,
        discriminator: `${handedOff.updatedAt}:${reason}`,
        metadata: { runId, reason, source: "self-healing" },
      });
    } catch {
      // Monitoring must not prevent recovery from handing work to review.
    }

    const settings = await this.store.getSettings();
    if (isMergeRequestContractShadowEnabled(settings)) {
      this.store.setCompletionHandoffAcceptedMarker(taskId, {
        source: `self-healing:${reason}`,
      });
      await this.store.upsertMergeRequestRecord(taskId, {
        state: handedOff.autoMerge === false ? "manual-required" : "queued",
      });
    }

    return handedOff;
  }

  private async hasRecentWorktreeIncompleteDetected(taskId: string, graceMs: number): Promise<boolean> {
    if (!Number.isFinite(graceMs) || graceMs <= 0) return false;
    let events: Array<{ timestamp?: string | null }> = [];
    try {
      events = await this.store.getRunAuditEventsAsync({ taskId, mutationType: "worktree:incomplete-detected", limit: 20 });
    } catch {
      return false;
    }
    if (!Array.isArray(events) || events.length === 0) return false;
    const cutoff = Date.now() - graceMs;
    return events.some((event) => {
      const ts = Date.parse(event.timestamp ?? "");
      return Number.isFinite(ts) && ts >= cutoff;
    });
  }

  /*
  FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD2 — workspace-aware liveness predicate):
  `evaluateBackwardMoveTripleProof` is NOT workspace-aware: it keys liveness off the SINGULAR
  `task.worktree` / `canonicalFusionBranchName(task.id)`, but a workspace task's liveness lives
  across N sub-repo worktrees (task.worktree is null). A workspace task is LIVE iff ANY of its
  sub-repo paths is still registered as active in the in-memory session registry
  (`pathsForTask` ∩ `isPathActive`) OR a process-wide executing/active signal is held. Used by
  the partial-land reconciler as the "safe to move backward / re-enqueue" gate so a live merging
  task is never moved backward.
  */
  private isWorkspaceTaskLive(task: Task): { live: boolean; livePaths: string[] } {
    const livePaths = activeSessionRegistry.pathsForTask(task.id).filter((path) => activeSessionRegistry.isPathActive(path));
    const live = livePaths.length > 0
      || executingTaskLock.has(task.id)
      || this.options.isTaskActive?.(task.id) === true;
    return { live, livePaths };
  }

  /*
  FNXC:Workspace 2026-06-22-14:10 (Phase D review C — terminal-owner liveness for lease reclaim):
  A `workspace-repo-land` lease may only be reclaimed when its owning task ROW is demonstrably
  TERMINAL — i.e. not running anymore in any sense. The Phase-D bug: the prior predicate only
  treated an in-review task WITH an active transient merge status as live, so a task still in column
  `in-progress` (executing, registered its land lease early, no merge status yet) read as NOT live →
  its lease was reclaimed MID-EXECUTION. This predicate inverts to the SAFE direction: the owner is
  LIVE unless it is provably terminal — null/missing, `done`, or `failed`. Every other state
  (`in-progress`, `in-review` with or without a merge status, `todo`, `triage`, paused, etc.) is
  treated as LIVE so we never yank a lease out from under a task that could still be running. The
  executing-lock / active-merge-lane checks at the call site are an ADDITIONAL live guard on top of
  this. (Distinct from `isWorkspaceTaskLive`, which probes the session REGISTRY; this probes the
  task ROW lifecycle.)
  */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:40:
  `completeColumns` is REQUIRED and resolved by the caller (async, once per sweep) because this
  predicate is sync and its caller is not.

  MEMBERSHIP of `complete` ONLY, deliberately: the literal it replaces was `done` alone, and the
  comment above spells out that every non-terminal state must read LIVE so a lease is never yanked
  from a task that could still be running. Adding `archived` would widen what counts as terminal and
  reclaim leases the old code kept — a behaviour change riding inside a column conversion.
  */
  private isWorkspaceOwnerLive(owner: Task | null | undefined, completeColumns: ReadonlySet<string>): boolean {
    if (!owner) return false; // not found / deleted → terminal.
    if (completeColumns.has(owner.column)) return false;
    if (owner.status === "failed") return false;
    return true;
  }

  private async evaluateBackwardMoveTripleProof(
    task: Task,
    input: {
      stage: string;
      graceMs: number;
      stalenessAnchor: string | null | undefined;
      reason: string;
      extra?: Record<string, unknown>;
    },
  ): Promise<{ ok: boolean; stalenessMs: number; reason: string; metadata: Record<string, unknown> }> {
    const livePaths = activeSessionRegistry.pathsForTask(task.id);
    const hasActiveRegisteredPath = livePaths.some((path) => activeSessionRegistry.isPathActive(path));
    const sessionDead = !hasActiveRegisteredPath && !executingTaskLock.has(task.id) && this.options.isTaskActive?.(task.id) !== true;

    let worktreeUnusable = true;
    let worktreeClassification: { ok: boolean; classification?: string; reason?: string };
    if (task.worktree) {
      const cls = await classifyTaskWorktree(this.options.rootDir, task.worktree);
      worktreeClassification = cls.ok
        ? { ok: true }
        : { ok: false, classification: cls.classification, reason: cls.reason };
      worktreeUnusable = !cls.ok;
    } else {
      const expected = canonicalFusionBranchName(task.id);
      const registeredPaths = await getRegisteredWorktreePaths(this.options.rootDir);
      const registeredBranchMap = await getRegisteredWorktreeBranchMap(this.options.rootDir);
      const matchingRegisteredPaths = [...registeredPaths].filter((path) => {
        const branch = registeredBranchMap.get(path);
        return typeof branch === "string" && branch.trim().toLowerCase() === expected;
      });
      worktreeClassification = matchingRegisteredPaths.length === 0
        ? { ok: false, classification: "missing", reason: "task.worktree is null and no registered fusion worktree exists" }
        : { ok: true, reason: "registered fusion worktree exists while task.worktree is null" };
      worktreeUnusable = matchingRegisteredPaths.length === 0;
    }

    const anchorMs = input.stalenessAnchor ? Date.parse(input.stalenessAnchor) : Number.NaN;
    const stalenessMs = Number.isFinite(anchorMs) ? Math.max(0, Date.now() - anchorMs) : Number.POSITIVE_INFINITY;
    const noRecentActivity = stalenessMs >= input.graceMs && !(await this.hasRecentWorktreeIncompleteDetected(task.id, input.graceMs));

    const ok = sessionDead && worktreeUnusable && noRecentActivity;
    return {
      ok,
      stalenessMs,
      reason: input.reason,
      metadata: {
        priorWorktree: task.worktree ?? null,
        priorBranch: task.branch ?? null,
        hadWorktree: Boolean(task.worktree),
        stalenessMs,
        graceMs: input.graceMs,
        sessionDead,
        worktreeUnusable,
        noRecentActivity,
        livePaths,
        hasExecutingTaskLock: executingTaskLock.has(task.id),
        taskActive: this.options.isTaskActive?.(task.id) === true,
        worktreeClassification,
        ...input.extra,
      },
    };
  }

  private async emitBackwardMoveNoAction(task: Task, stage: string, mutationType: string, proof: { stalenessMs: number; reason: string; metadata: Record<string, unknown> }): Promise<void> {
    try {
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId(`self-healing-${stage}`, task.id),
        agentId: "self-healing",
        taskId: task.id,
        taskLineageId: task.lineageId,
        phase: stage,
      }).database({
        type: mutationType as DatabaseMutationType,
        target: task.id,
        metadata: proof.metadata,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[${stage}] ${task.id}: no-action audit emission failed: ${message}`);
    }

    /*
    FNXC:TaskWedgeNotifications 2026-07-22-14:30:
    No-action reconciles do not always write `failed` or `paused`, so task-updated
    classification cannot see them. Deliver only the bounded ownerless stages
    through NotificationService; its durable CAS suppresses repeated sweeps.
    */
    const descriptor = describeSelfHealingNoActionWedge(task, stage, proof.metadata);
    if (descriptor) {
      try {
        await getActiveNotificationService()?.notifyTaskWedge(task, descriptor);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`[${stage}] ${task.id}: wedge notification failed: ${message}`);
      }
    }
    log.debug(`[${stage}] ${task.id}: triple-proof not satisfied — no action (operator-decides)`);
  }

  /*
   * FNXC:Lifecycle 2026-07-16-10:30:
   * FN-8141 — a stranded-completed promoter must respect failure provenance. Before promoting an
   * all-steps-done/skipped candidate to in-review, verify its MOST RECENT execution-outcome in the
   * durable task log was not a failure/refusal park; a park bounced to `todo`/`in-progress` by the
   * pause-abort machinery must not be laundered into `in-review`. Slim listings strip `log`, so the
   * full task is fetched only for candidates that already cleared the cheap step/status filters.
   * On block, emits `task:reconcile-stranded-completed-no-action` once per taskId (deduped) and
   * withholds promotion. Escape hatch: an operator retrying/moving the task starts a fresh execution
   * whose clean completion marker supersedes the failure park, clearing the block with no code change.
   * Fail-closed: if the full task cannot be read this cycle, withhold promotion rather than risk
   * laundering a failed park.
   */
  private async isStrandedCompletedPromotionBlockedByFailureProvenance(
    taskId: string,
    sweep: "stuck-in-progress" | "stranded-todo",
  ): Promise<boolean> {
    let fullTask: Task;
    try {
      fullTask = await this.store.getTask(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[stranded-completed-provenance] ${taskId}: full-task fetch failed (${message}) — withholding ${sweep} promotion this cycle`);
      return true;
    }

    const evaluation = evaluateCompletedPromotionFailureProvenance(fullTask);
    if (!evaluation.blocked) {
      // Provenance cleared (fresh clean execution or never-failed): re-arm the dedup so a later
      // re-failure is reported again.
      this.strandedCompletedFailureProvenanceWarned.delete(taskId);
      return false;
    }

    if (!this.strandedCompletedFailureProvenanceWarned.has(taskId)) {
      this.strandedCompletedFailureProvenanceWarned.add(taskId);
      try {
        await createRunAuditor(this.store, {
          runId: generateSyntheticRunId("self-healing-stranded-completed-provenance", taskId),
          agentId: "self-healing",
          taskId,
          taskLineageId: fullTask.lineageId,
          phase: "stranded-completed-provenance",
        }).database({
          type: "task:reconcile-stranded-completed-no-action" as DatabaseMutationType,
          target: taskId,
          metadata: {
            taskId,
            reason: evaluation.reason ?? "failure-provenance",
            sweep,
            ...(evaluation.markerAction ? { marker: evaluation.markerAction } : {}),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`[stranded-completed-provenance] ${taskId}: no-action audit emission failed: ${message}`);
      }
    }
    log.debug(`[stranded-completed-provenance] ${taskId}: withholding ${sweep} promotion — most recent execution ended in a failure/refusal park (operator-decides)`);
    return true;
  }

  private async listActiveHeartbeatTaskIds(): Promise<Set<string>> {
    const activeTaskIds = new Set<string>();
    if (!this.options.agentStore) {
      return activeTaskIds;
    }

    try {
      const activeRuns = await this.options.agentStore.listActiveHeartbeatRuns();
      const activeWindowMs = RUNNING_ON_INACTIVE_TASK_STALE_RUN_MS;
      const now = Date.now();
      for (const run of activeRuns) {
        const startedAtMs = Date.parse(run.startedAt ?? "");
        if (!Number.isFinite(startedAtMs) || now - startedAtMs > activeWindowMs) continue;
        const taskId = run.contextSnapshot && typeof run.contextSnapshot.taskId === "string"
          ? run.contextSnapshot.taskId.toUpperCase()
          : null;
        if (taskId) activeTaskIds.add(taskId);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Unable to enumerate active heartbeat runs: ${message}`);
    }

    return activeTaskIds;
  }

  private async getRecentRunAuditActivityAgeMs(task: Task, nowMs: number): Promise<number | null> {
    /*
    FNXC:IncompletePgPorts 2026-07-26-20:45:
    Prefer getRunAuditEventsAsync — sync getRunAuditEvents returns [] on
    PostgreSQL and incorrectly treated busy tasks as inactive.
    */
    const store = this.store as unknown as {
      getRunAuditEventsAsync?: (filter: { taskId?: string; startTime?: string; limit?: number }) => Promise<Array<{ timestamp?: string }>>;
      getRunAuditEvents?: (filter: { taskId?: string; startTime?: string; limit?: number }) => Array<{ timestamp?: string }>;
    };
    try {
      const since = new Date(nowMs - RUNNING_ON_INACTIVE_TASK_STALE_RUN_MS).toISOString();
      const filter = { taskId: task.id, startTime: since, limit: 1 };
      const events = typeof store.getRunAuditEventsAsync === "function"
        ? await store.getRunAuditEventsAsync(filter)
        : typeof store.getRunAuditEvents === "function"
          ? store.getRunAuditEvents(filter)
          : null;
      if (!events) return null;
      const newest = events.find((event) => typeof event.timestamp === "string");
      if (!newest?.timestamp) return null;
      const timestampMs = Date.parse(newest.timestamp);
      return Number.isFinite(timestampMs) ? Math.max(0, nowMs - timestampMs) : null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[self-healing] unable to inspect recent run-audit activity for ${task.id}: ${message}`);
      return null;
    }
  }

  /**
   * FNXC:SelfHealingReclaim 2026-06-19-00:00:
   * FN-6736 requires self-healing to stop treating an in-memory `executor-active` binding as live when the owner is demonstrably dead. Preserve FN-4811 by requiring every live-owner signal to be absent, leave the FN-5219 missing-worktree path untouched, and avoid FN-5704 resume-limbo counters because this path only clears a stale binding and requeues once with progress/worktree preserved.
   *
   * FNXC:SelfHealingReclaim 2026-07-05-08:15:
   * FN-7566: the FN-6736 liveness gate (`agentPresent` heartbeat, `checkedOutBy` lease, `hasRecentRunAudit`) is structurally blind to EPHEMERAL EXECUTOR agents (`agentId: "executor"`): they never emit heartbeat runs (so `activeHeartbeatTaskIds` never contains them), never acquire a checkout lease (`checkedOutBy` stays null), and normal execution activity (sandbox:run / task:log / verification) writes no `runAuditEvents` rows (so `getRecentRunAuditActivityAgeMs` stays null). With all three permanently false, the ONLY surviving gate was age > graceMs*3 (~30 min), so any ephemeral executor task running longer than 30 minutes — a heavy foreach workflow, a slow model — was killed mid-flight on the next self-healing sweep and hard-moved to `todo`, corrupting overlapping-worktree/task-link state.
   * The fix adds the in-process live-session truth that DOES track ephemeral executors: a worktree path registered as active in `activeSessionRegistry` (the executor/step-session/workflow-step session holds it for the whole run), the `executingTaskLock`, or `isTaskActive`. This mirrors the canonical `isWorkspaceTaskLive` / `sessionDead` predicate. A genuinely leaked binding (FN-6736) still has an EMPTY registry / no lock / inactive task, so legitimate phantom recovery is preserved; a live ephemeral executor now vetoes the phantom verdict regardless of the durable-agent signals.
   */
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:40:
  `wipColumns` is REQUIRED and supplied by the caller, which resolved the SAME set three lines above
  the call (`lanesOfReclaim(task.id).wip`) to decide whether to invoke this at all, and then passed a
  task whose column this predicate compared against the `in-progress` literal. Two reads of one
  board, one resolved and one not — three lines apart.
  */
  private isPhantomExecutorBinding(task: Task, options: {
    executionAgeMs: number | null;
    graceMs: number;
    activeHeartbeatTaskIds: Set<string>;
    lastActivityMs: number | null;
    /** Wip MEMBERSHIP — replaces the `in-progress` literal. */
    wipColumns: ReadonlySet<string>;
  }): { phantom: boolean; metadata: Record<string, unknown> } {
    const normalizedId = task.id.toUpperCase();
    const agentPresent = options.activeHeartbeatTaskIds.has(normalizedId);
    const checkedOutBy = typeof task.checkedOutBy === "string" && task.checkedOutBy.trim().length > 0 ? task.checkedOutBy : null;
    const worktreeExists = Boolean(task.worktree && existsSync(task.worktree));
    const hasRecentRunAudit = options.lastActivityMs !== null && options.lastActivityMs <= RUNNING_ON_INACTIVE_TASK_STALE_RUN_MS;
    // FN-7566: in-process liveness that survives for ephemeral executors. The registered
    // session path is the faithful proxy for the live session surfaces
    // (`activeSessions`/`activeStepExecutors`/`activeWorkflowStepSessions`) that
    // `clearPhantomExecutorBinding` itself refuses to detach.
    const livePaths = activeSessionRegistry.pathsForTask(task.id).filter((path) => activeSessionRegistry.isPathActive(path));
    const hasLiveInProcessSession = livePaths.length > 0
      || executingTaskLock.has(task.id)
      || this.options.isTaskActive?.(task.id) === true;
    const safeAgeMs = options.graceMs * PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER;
    const metadata = {
      taskId: task.id,
      executionAgeMs: options.executionAgeMs,
      graceMs: options.graceMs,
      staleBindingAgeFloorMs: safeAgeMs,
      checkedOutBy,
      agentPresent,
      lastActivityMs: options.lastActivityMs,
      hasRecentRunAudit,
      hasLiveInProcessSession,
      liveSessionPaths: livePaths,
      worktree: task.worktree ?? null,
      branch: task.branch ?? null,
      worktreeExists,
    };

    return {
      phantom: options.wipColumns.has(task.column)
        && worktreeExists
        && options.executionAgeMs !== null
        && options.executionAgeMs > safeAgeMs
        && !checkedOutBy
        && !agentPresent
        && !hasRecentRunAudit
        && !hasLiveInProcessSession,
      metadata,
    };
  }

  private getFalsePositiveRequeueSignal(task: Task, options: {
    executingIds?: Set<string>;
    activeHeartbeatTaskIds?: Set<string>;
    graceMs: number;
    includeLiveWorktreeBoundBranch?: boolean;
    includeCheckedOutLease?: boolean;
  }): { reason: string; metadata: Record<string, unknown> } | null {
    const normalizedId = task.id.toUpperCase();
    const executionStartedAtMs = task.executionStartedAt ? Date.parse(task.executionStartedAt) : Number.NaN;
    const executionAgeMs = Number.isFinite(executionStartedAtMs) ? Math.max(0, Date.now() - executionStartedAtMs) : null;
    const liveWorktreeBoundBranch = Boolean(
      task.worktree
      && typeof task.branch === "string"
      && task.branch.trim().length > 0
      && existsSync(task.worktree),
    );
    const metadata = {
      taskId: task.id,
      branch: task.branch ?? null,
      worktree: task.worktree ?? null,
      checkedOutBy: task.checkedOutBy ?? null,
      executionStartedAt: task.executionStartedAt ?? null,
      executionAgeMs,
      graceMs: options.graceMs,
      liveWorktreeBoundBranch,
    };

    if (options.executingIds?.has(task.id)) {
      return { reason: "executor-active", metadata };
    }
    if (options.activeHeartbeatTaskIds?.has(normalizedId)) {
      return { reason: "active-heartbeat-run", metadata };
    }
    if ((options.includeCheckedOutLease ?? false) && task.checkedOutBy) {
      return { reason: "checked-out-lease-active", metadata };
    }
    if ((options.includeLiveWorktreeBoundBranch ?? true) && liveWorktreeBoundBranch) {
      return { reason: "live-worktree-and-branch", metadata };
    }
    if (executionAgeMs !== null && executionAgeMs <= options.graceMs) {
      return { reason: "recent-execution-started", metadata };
    }
    return null;
  }

  private async emitFalsePositiveRequeueNoAction(task: Task, stage: string, mutationType: string, reason: string, metadata: Record<string, unknown>): Promise<void> {
    try {
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId(`self-healing-${stage}`, task.id),
        agentId: "self-healing",
        taskId: task.id,
        taskLineageId: task.lineageId,
        phase: stage,
      }).database({
        type: mutationType as DatabaseMutationType,
        target: task.id,
        metadata: {
          ...metadata,
          reason,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[${stage}] ${task.id}: false-positive no-action audit emission failed: ${message}`);
    }
    log.debug(`[${stage}] ${task.id}: false-positive requeue suppressed (${reason})`);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  start(): void {
    // Wire up settings:updated listener for auto-unpause
    this.settingsListener = ({ settings, previous }) => {
      this.onSettingsUpdated(settings, previous);
    };
    this.store.on("settings:updated", this.settingsListener);

    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-23:40 (the last fan-out guard, converted — #3109):
    THE BOARD-STALL COUNTER WAS THE ONE GUARD HERE THAT GENUINELY NEEDED A SYNCHRONOUS ANSWER, because
    it mutates in-memory state in the handler's own tick. The other two gated work the listener already
    `void`s and were converted through the async resolver; this one could not follow them.

    The sync IR path was never the answer for it either: `resolveTaskWorkflowIrSync` cannot resolve a
    CUSTOM workflow at all (two independent blockers, `sync-workflow-ir-second-blocker.test.ts`), so a
    conversion routed through it would have been inert — which is why I wrote that conversion, measured
    it, and withdrew it.

    #3109 removed the dilemma by having the EMITTER carry resolved lanes on the `task:moved` payload.
    Reading them needs NO await, so the counter's increment stays in the same tick and the guard becomes
    correct at the same time.

    `lanes` is optional and fail-soft to `undefined` — "unknown", never "legacy" — so the literals stay
    as the fallback, matching the `mergeParkedColumns` convention in `scheduler.ts`.

    WHAT IT FIXES: on a renamed board this counter read ZERO, so the board-stall watchdog was blind to
    a board whose cards were moving out of implementation the whole time — the signal it exists to
    raise was never raised.
    */
    this.taskMovedFanoutListener = ({ task, from, to, lanes }) => {
      const wipLane = lanes?.wip ?? "in-progress";
      /* "Left implementation for somewhere that is not implementation" — every lane a card can land
         in out of wip, so the counter sees the transition whatever the board calls its columns. */
      const outOfWipLanes = new Set([
        lanes?.hold ?? "todo",
        lanes?.review ?? "in-review",
        lanes?.complete ?? "done",
        lanes?.archived ?? "archived",
      ]);
      if (
        from === wipLane
        && outOfWipLanes.has(to)
        && this.boardStallWindow
      ) {
        // In-memory only counter; resets on engine restart.
        this.boardStallWindow.transitionsOutOfInProgressInWindow++;
      }
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-23:35 (the ASYNC path, which the sync one could not be):
      THESE TWO GUARDS GATE WORK THAT WAS ALREADY FIRE-AND-FORGET, so they can ask the async resolver
      without changing anything an observer can see.

      The sync-IR conversion of this listener is inert and was withdrawn (see the note above). But
      that is a constraint on the SYNC path, and only the board-stall counter above genuinely needs a
      synchronous answer — it mutates in-memory state in the handler's own tick. The two calls below
      are already `void`-ed: the listener does not await them, and their bodies already begin at a
      microtask boundary.

      Moving the guard into that same boundary therefore preserves the ordering property the withdrawn
      conversion would have broken. An async IIFE runs synchronously only up to its first `await`,
      which here is the first statement, so the rest of this listener continues in the same tick
      exactly as before — identical to how `void this.reconcileCompletedTask(...)` already behaved.

      The resolution goes through the ASYNC `resolveProjectColumnsForRoles`, whose only store read is
      `listWorkflowDefinitions()` — answerable under PostgreSQL, and unaffected by either of the two
      blockers that make the sync path inert (`sync-workflow-ir-second-blocker.test.ts`).

      What this fixes, on every renamed board: a card entering the board's own review lane never had
      its branch rebound, and a card reaching the board's own complete or archive lane never ran the
      completion fan-out — so its worktree was never reclaimed and its dependents kept a `blockedBy`
      pointing at a blocker that had already finished.
      */
      void (async () => {
        /* One await, not three: the fan-out is fire-and-forget, so its deferral is unobservable, but
           there is no reason to add microtasks the resolution does not need. */
        const [review, complete, archived] = await Promise.all([
          resolveProjectColumnsForRoles(this.store, REVIEW_ROLES),
          resolveProjectColumnsForRoles(this.store, ["complete"]),
          resolveProjectColumnsForRoles(this.store, ["archived"]),
        ]);
        const lanes = { review, complete, archived };
        if (lanes.review.has(to)) {
          await this.reconcileInReviewBranchRebind({ includeTaskIds: new Set([task.id]) }).catch((err: unknown) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`[self-healing] task:moved in-review rebind failed for ${task.id}: ${errorMessage}`);
          });
        }
        const shouldReconcile =
          (lanes.review.has(from) && lanes.complete.has(to)) ||
          (lanes.complete.has(from) && lanes.archived.has(to));
        if (!shouldReconcile) return;
        await this.reconcileCompletedTask(task.id, { worktreeHint: task.worktree ?? undefined }).catch((err: unknown) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`[self-healing] task:moved completion fan-out failed for ${task.id}: ${errorMessage}`);
        });
      })().catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`[self-healing] task:moved fan-out lane resolution failed for ${task.id}: ${errorMessage}`);
      });
    };
    this.store.on("task:moved", this.taskMovedFanoutListener);

    // Start periodic maintenance
    this.startMaintenance();

    log.debug("Started");
  }

  /**
   * Run only the recovery subset needed at runtime startup, after the executor
   * has had a chance to resume orphaned sessions.
   *
   * This avoids waiting for the periodic maintenance interval before fixing
   * stale in-progress/planning tasks that no longer have a live worker.
   */
  async runStartupRecovery(): Promise<void> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) {
      log.debug(
        `Startup recovery skipped — ${
          settings.globalPause ? "global pause" : "engine pause"
        } is active`,
      );
      // FNXC:StrandedHoldContinuation 2026-07-26-16:40:
      // FN-8592's sweep must still inspect candidate cards while the engine is
      // globally paused. Its predicate emits the deduped engine-paused audit
      // signal and never seeds, while all other startup recovery remains stopped.
      await this.reconcileStrandedHoldContinuations();
      return;
    }

    // Each recovery step is isolated — one failure doesn't prevent subsequent steps.
    const startupSurfacing = this.surfacingCycleMemo();
    const steps: Array<{ name: string; fn: () => Promise<unknown> }> = [
      // FNXC:LegacyAdoption 2026-07-19-04:20 (U9b / KTD-8): adoption runs FIRST. Every step
      // below reasons about `task.status` and column, so a pre-cutover row must be adopted
      // into the post-cutover vocabulary before any of them classify it — otherwise a
      // legacy `planning`/`needs-replan` row is judged by recovery rules that no longer
      // have a writer for that status.
      { name: "adopt-legacy-task-rows", fn: () => this.adoptLegacyTaskRows().then(() => undefined) },
      // FNXC:WorkflowColumns 2026-07-26-18:30: immediately after status adoption and before every
      // column-reasoning step below — a row in an undeclared column carries NO trait flags, so each
      // of those steps would silently classify it as "not my case" and leave it stranded.
      { name: "reconcile-undeclared-task-columns", fn: () => this.reconcileUndeclaredTaskColumns().then(() => undefined) },
      // FNXC:OrphanedPendingSteps 2026-07-22-16:20 (FN-8492 incident): runs right after
      // adoption and BEFORE every in-review recovery step below — those reason about
      // step-result completeness, and an orphaned `pending` result reads as "work in
      // flight" to all of them (the merge gate included), which is the two-hour
      // stall-deadlock ride this sweep exists to prevent.
      { name: "reconcile-orphaned-pending-step-results", fn: () => this.reconcileOrphanedPendingStepResults().then(() => undefined) },
      { name: "reconcile-stranded-hold-continuations", fn: () => this.reconcileStrandedHoldContinuations().then(() => undefined) },
      { name: "no-progress-no-task-done", fn: () => this.recoverNoProgressNoTaskDoneFailures().then(() => undefined) },
      { name: "completed-tasks", fn: () => this.recoverCompletedTasks().then(() => undefined) },
      { name: "recover-stranded-completed-todo", fn: () => this.recoverStrandedCompletedTodoTasks().then(() => undefined) },
      { name: "recover-advanced-triage", fn: () => this.recoverAdvancedTriageTasks().then(() => undefined) },
      { name: "stale-incomplete-review", fn: () => this.recoverStaleIncompleteReviewTasks().then(() => undefined) },
      { name: "failed-pre-merge-steps", fn: () => this.recoverReviewTasksWithFailedPreMergeSteps().then(() => undefined) },
      { name: "missing-worktree-review-failures", fn: () => this.recoverMissingWorktreeReviewFailures().then(() => undefined) },
      { name: "interrupted-merging", fn: () => this.recoverInterruptedMergingTasks().then(() => undefined) },
      { name: "wedged-active-merge", fn: () => this.recoverWedgedActiveMerge().then(() => undefined) },
      { name: "transient-merge-failures", fn: () => this.recoverTransientMergeFailures().then(() => undefined) },
      { name: "done-merge-metadata", fn: () => this.recoverDoneTaskMergeMetadata().then(() => undefined) },
      { name: "reconcile-done-task-integrity", fn: () => this.reconcileDoneTaskIntegrity().then(() => undefined) },
      // FN-5092: must run BEFORE any merger pickup path so the merger queue is
      // not stalled by a leaked `status: "merging"` on an already-done task.
      { name: "reconcile-stale-merger-status", fn: () => this.reconcileStaleMergerStatus().then(() => undefined) },
      { name: "reconcile-stale-duplicate-decision", fn: () => this.reconcileStaleDuplicateDecisionPause().then(() => undefined) },
      { name: "recover-already-merged-review", fn: () => this.recoverAlreadyMergedReviewTasks().then(() => undefined) },
      { name: "recover-post-done-noncontinuable-wedge", fn: () => this.recoverPostDoneNonContinuableWedge().then(() => undefined) },
      { name: "recover-completion-handoff-limbo", fn: () => this.recoverCompletionHandoffLimbo().then(() => undefined) },
      { name: "recover-branch-misbound-in-review", fn: () => this.recoverBranchMisboundInReviewTasks().then(() => undefined) },
      { name: "recover-foreign-only-contamination-in-review", fn: () => this.recoverForeignOnlyContaminatedInReviewTasks().then(() => undefined) },
      { name: "recover-orphan-only-scope-violations", fn: () => this.recoverOrphanOnlyScopeViolations().then(() => undefined) },
      { name: "recover-stuck-merge-deadlocks", fn: () => this.recoverStuckMergeDeadlocks().then(() => undefined) },
      { name: "misclassified-failures", fn: () => this.recoverMisclassifiedFailures().then(() => undefined) },
      { name: "partial-progress-no-task-done", fn: () => this.recoverPartialProgressNoTaskDoneFailures().then(() => undefined) },
      { name: "orphaned-executions", fn: () => this.recoverOrphanedExecutions().then(() => undefined) },
      { name: "approved-triage", fn: () => this.recoverApprovedTriageTasks().then(() => undefined) },
      { name: "recover-starved-refinement", fn: () => this.recoverStarvedRefinementTriageTasks().then(() => undefined) },
      { name: "orphaned-planning", fn: () => this.recoverOrphanedPlanningTasks().then(() => undefined) },
       { name: "orphaned-planning-segments", fn: () => this.finalizeOrphanedPlanningSegments().then(() => undefined) },
      { name: "reset-durable-agent-error-state-on-startup", fn: () => this.resetDurableAgentErrorStateOnStartup().then(() => undefined) },
      { name: "recover-orphaned-agents", fn: () => this.recoverOrphanedAgents().then(() => undefined) },
      { name: "recover-stale-heartbeat-runs", fn: () => this.recoverStaleHeartbeatRuns().then(() => undefined) },
      { name: "reattach-orphaned-assigned-executions", fn: () => this.reattachOrphanedAssignedExecutions().then(() => undefined) },
      {
        name: "reap-stale-mission-validator-runs",
        fn: async () => {
          if (!this.options.reapStaleMissionValidatorRuns) {
            return undefined;
          }
          await this.options.reapStaleMissionValidatorRuns();
          return undefined;
        },
      },
      { name: "recover-running-on-inactive-tasks", fn: () => this.recoverAgentsRunningOnInactiveTasks().then(() => undefined) },
      { name: "recover-drifted-agent-task-links", fn: () => this.recoverDriftedAgentTaskLinks().then(() => undefined) },
      { name: "reconcile-soft-delete-column-drift", fn: () => this.reconcileSoftDeletedColumnDrift().then(() => undefined) },
      { name: "clear-stale-blocked-by", fn: () => this.clearStaleBlockedBy().then(() => undefined) },
      { name: "reconcile-self-defeating-deps", fn: () => this.reconcileSelfDefeatingDependencies().then(() => undefined) },
      { name: "reconcile-dependency-blocking-leases", fn: () => this.reconcileDependencyBlockingLeases().then(() => undefined) },
      { name: "reconcile-stale-symbol-locks", fn: () => this.reconcileStaleSymbolLocks().then(() => undefined) },
      { name: "reconcile-completed-blocked", fn: () => this.reconcileCompletedBlockedTasks().then(() => undefined) },
      { name: "reconcile-in-review-unmet-dependencies", fn: () => this.reconcileInReviewUnmetDependencies().then(() => undefined) },
      { name: "reconcile-engine-downtime-active-timing", fn: () => this.reconcileEngineDowntimeActiveTiming().then(() => undefined) },
      { name: "reconcile-dependency-cycles", fn: () => this.reconcileDependencyCycles().then(() => undefined) },
      { name: "reclaim-pr-conflicts", fn: () => this.reclaimPrConflicts().then(() => undefined) },
      { name: "reclaim-self-owned-branch-conflicts", fn: () => this.reclaimSelfOwnedBranchConflicts().then(() => undefined) },
      // FN-4962 ordering invariant: metadata reconcile must run before stale-active reclaim.
      { name: "reconcile-task-worktree-metadata", fn: () => this.reconcileTaskWorktreeMetadata().then(() => undefined) },
      { name: "recover-in-progress-limbo", fn: () => this.recoverInProgressLimbo().then(() => undefined) },
      { name: "reconcile-in-review-branch-rebind", fn: () => this.reconcileInReviewBranchRebind().then(() => undefined) },
      { name: "reclaim-stale-active-branches", fn: () => this.reclaimStaleActiveBranches().then(() => undefined) },
      { name: "surface-in-review-stalls", fn: () => this.surfaceInReviewStalls().then(() => undefined) },
      /* One shared cycle for the family — see `openSurfacingCycle`. Opened
         lazily and awaited by all three, so the board is read once. */
      { name: "surface-in-review-stalled", fn: () => this.surfaceInReviewStalled(startupSurfacing()).then(() => undefined) },
      { name: "surface-stale-paused-reviews", fn: () => this.surfaceStalePausedReviews(startupSurfacing()).then(() => undefined) },
      { name: "surface-stale-paused-todos", fn: () => this.surfaceStalePausedTodos(startupSurfacing()).then(() => undefined) },
      { name: "audit-no-commits-expected-candidates", fn: () => this.auditNoCommitsExpectedCandidates().then(() => undefined) },
    ];

    for (const step of steps) {
      try {
        await step.fn();
        log.debug(`Startup recovery step "${step.name}" completed`);
      } catch (stepErr) {
        const stepErrMessage = stepErr instanceof Error ? stepErr.message : String(stepErr);
        log.error(`Startup recovery step "${step.name}" failed: ${stepErrMessage} — continuing with remaining steps`);
      }
      await yieldEventLoop();
    }
  }

  async reconcileEngineDowntimeActiveTiming(
    opts?: { engineLastActiveAtOverride?: string },
  ): Promise<{ shiftedTaskIds: string[]; downtimeMs: number }> {
    const result = await this.store.reconcileActiveTimingForEngineDowntime(new Date(), opts);
    const shifted = result.shiftedTaskIds.length > 0;
    const auditor = createRunAuditor(this.store, {
      runId: generateSyntheticRunId("reconcile-engine-downtime-active-timing", "global"),
      agentId: "system:self-healing",
      phase: "reconcile-engine-downtime-active-timing",
    });
    await auditor.database({
      type: (shifted ? "task:reconcile-engine-downtime-active-timing" : "task:reconcile-engine-downtime-active-timing-no-action") as DatabaseMutationType,
      target: "global",
      metadata: {
        shiftedTaskIds: result.shiftedTaskIds,
        downtimeMs: result.downtimeMs,
        reason: shifted ? "shifted-active-segments" : "no-qualifying-active-segments",
      },
    });
    return result;
  }

  stop(): void {
    // Remove settings listener
    if (this.settingsListener) {
      try {
        this.store.removeListener("settings:updated", this.settingsListener);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        // Store may not support removeListener (e.g., test mocks) — non-fatal.
        log.warn(`Failed to remove settings:updated listener during stop(): ${errorMessage}`);
      }
      this.settingsListener = null;
    }

    if (this.taskMovedFanoutListener) {
      try {
        this.store.off("task:moved", this.taskMovedFanoutListener);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to remove task:moved listener during stop(): ${errorMessage}`);
      }
      this.taskMovedFanoutListener = null;
    }

    // Clear timers
    this.cancelUnpauseTimer();
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }

    this.finalizeUnprovenWarned.clear();
    this.strandedCompletedFailureProvenanceWarned.clear();
    log.debug("Stopped");
  }

  // ── Auto-unpause ───────────────────────────────────────────────────

  private onSettingsUpdated(settings: Settings, previous: Settings): void {
    // globalPause false → true: schedule auto-unpause
    if (!previous.globalPause && settings.globalPause) {
      if (!settings.autoUnpauseEnabled) {
        log.log("Global pause activated — auto-unpause disabled, requires manual intervention");
        return;
      }

      if (settings.globalPauseReason === "manual") {
        log.debug("Global pause activated manually — auto-unpause skipped, requires manual intervention");
        return;
      }

      // If pause re-triggered within 60s of our last unpause, escalate backoff
      if (this.lastUnpauseAt && (Date.now() - this.lastUnpauseAt) < 60_000) {
        this.unpauseAttempt++;
        log.warn(`Global pause re-triggered within 60s — escalating to attempt ${this.unpauseAttempt}`);
      }

      this.lastPauseTriggeredAt = Date.now();

      const baseDelay = settings.autoUnpauseBaseDelayMs ?? 300_000;
      const maxDelay = settings.autoUnpauseMaxDelayMs ?? 3_600_000;
      const delay = Math.min(baseDelay * Math.pow(2, this.unpauseAttempt), maxDelay);

      this.scheduleUnpause(delay);
    }

    // globalPause true → false: check if we should reset backoff
    if (previous.globalPause && !settings.globalPause) {
      this.cancelUnpauseTimer();

      // If sustained unpause (not a quick re-trigger), reset attempt counter
      if (this.lastPauseTriggeredAt && (Date.now() - this.lastPauseTriggeredAt) > 60_000) {
        this.unpauseAttempt = 0;
      }
    }
  }

  private scheduleUnpause(delayMs: number): void {
    this.cancelUnpauseTimer();

    const delaySec = Math.round(delayMs / 1000);
    const delayMin = Math.round(delaySec / 60);
    const display = delayMin >= 1 ? `${delayMin}m` : `${delaySec}s`;
    log.warn(`Auto-unpause scheduled in ${display} (attempt ${this.unpauseAttempt + 1})`);

    this.unpauseTimer = setTimeout(() => {
      this.unpauseTimer = null;
      void this.attemptUnpause();
    }, delayMs);
  }

  private async attemptUnpause(): Promise<void> {
    try {
      const settings = await this.store.getSettings();

      // Already unpaused (manually or by another mechanism)
      if (!settings.globalPause) {
        log.debug("Auto-unpause: already unpaused — no action needed");
        this.unpauseAttempt = 0;
        return;
      }

      log.warn("Auto-unpause: clearing globalPause");
      this.lastUnpauseAt = Date.now();
      await this.store.updateSettings({ globalPause: false, globalPauseReason: undefined });

      // Note: if the rate limit is still active, the next agent session will
      // hit it again → UsageLimitPauser triggers globalPause → our listener
      // catches the transition and schedules the next attempt with escalated backoff.
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Auto-unpause failed: ${errorMessage}`);
    }
  }

  private cancelUnpauseTimer(): void {
    if (this.unpauseTimer) {
      clearTimeout(this.unpauseTimer);
      this.unpauseTimer = null;
    }
  }

  // ── Stuck kill budget ─────────────────────────────────────────────

  /**
   * Check whether a stuck-killed task should be re-queued, parked for manual
   * intervention, or marked as failed. Called by StuckTaskDetector's
   * `beforeRequeue` callback.
   *
   * Terminal contract for stuck-loop exhaustion and no-progress churn:
   * - `STUCK_LOOP_EXHAUSTED`: increments the kill budget until exhausted. Once
   *   exhausted, tasks with incomplete steps are moved back to `todo` with
   *   progress preserved, marked failed, and paused for manual resume or
   *   decomposition; tasks with only terminal steps keep the legacy failed
   *   `in-review` handoff path.
   *
   * FNXC:SelfHealing 2026-06-14-10:51:
   * Incomplete stuck-loop exhaustion must park work in a failed/paused state before moving columns, because a post-move patch failure must not leave the task scheduler-runnable.
   * Engine-owned recovery must not mutate `userPaused`; user intent stays authoritative across races.
   * - `STUCK_NO_PROGRESS_CHURN`: skips the budget entirely and terminalizes on
   *   the first trigger with operator guidance to decompose or rescope.
   *
   * @returns `true` if the task should be re-queued, `false` if terminalized.
   */
  async checkStuckBudget(
    taskId: string,
    reason: "loop" | "inactivity" | "no-progress-churn" = "inactivity",
    event?: { ignoredStepUpdateCount?: number },
  ): Promise<boolean> {
    try {
      const settings = await this.store.getSettings();
      const maxKills = settings.maxStuckKills ?? 6;

      const task = await this.store.getTask(taskId);

      if (task.userPaused) {
        log.warn(`${taskId} STUCK_KILL: skipped — task is user-paused; leaving paused`);
        await this.store.logEntry(
          taskId,
          `STUCK_KILL: skipped stuck-budget recovery for ${reason} because the task is user-paused; leaving paused.`,
        );
        return false;
      }

      if (reason === "no-progress-churn") {
        const ignoredStepUpdateCount = event?.ignoredStepUpdateCount ?? 0;
        const stuckKillStreak = task.stuckKillCount ?? 0;
        log.warn(
          `${taskId} no-progress churn detected ` +
          `(ignoredStepUpdates=${ignoredStepUpdateCount}, stuckKillStreak=${stuckKillStreak}) — marking failed`,
        );
        const churnError =
          `STUCK_NO_PROGRESS_CHURN: detected ${ignoredStepUpdateCount} ignored step-update rebuffs after compact-and-resume failed to recover progress. ` +
          `Task is likely too large; decompose via fn_task_create child tasks or rescope. No further automatic retries will run.`;
        await this.store.updateTask(taskId, {
          status: "failed",
          error: churnError,
        });
        try {
          await this.handoffTaskToReview(taskId, "stuck-no-progress-churn");
        } catch (moveErr: unknown) {
          const moveErrMessage = moveErr instanceof Error ? moveErr.message : String(moveErr);
          log.warn(`${taskId} handoffTaskToReview failed (${moveErrMessage}) after STUCK_NO_PROGRESS_CHURN terminalization — task already marked failed, not re-queuing`);
        }
        await this.store.logEntry(
          taskId,
          `STUCK_NO_PROGRESS_CHURN: detected ${ignoredStepUpdateCount} ignored step-update rebuffs after compact-and-resume failed to recover progress. ` +
          `No further automatic retries will run. Pause the task, manually decompose the work via fn_task_create child tasks, or move it to triage to rescope.`,
        );
        const churnAudit = createRunAuditor(this.store, {
          runId: generateSyntheticRunId("fn5168-stuck-churn", taskId),
          agentId: "self-healing",
          taskId,
          taskLineageId: task.lineageId,
          phase: "stuck-no-progress-churn-terminalized",
        });
        await churnAudit.database({
          type: "task:stuck-no-progress-churn-terminalized",
          target: taskId,
          metadata: {
            taskId,
            ignoredStepUpdateCount,
            stuckKillStreak,
            lastReason: reason,
          },
        });
        return false;
      }

      const newCount = (task.stuckKillCount ?? 0) + 1;
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const activeHeartbeatTaskIds = await this.listActiveHeartbeatTaskIds();

      if (newCount > maxKills) {
        const hasIncompleteSteps = !!task.steps?.some((step) => NON_TERMINAL_STEP_STATUSES.has(step.status));

        if (hasIncompleteSteps) {
          const liveExecutionSignal = this.getFalsePositiveRequeueSignal(task, {
            executingIds,
            activeHeartbeatTaskIds,
            graceMs: settings.taskStuckTimeoutMs ?? ORPHANED_EXECUTION_RECOVERY_GRACE_MS,
            includeCheckedOutLease: true,
          });
          if (liveExecutionSignal) {
            await this.emitFalsePositiveRequeueNoAction(
              task,
              "stuck-loop-exhausted",
              "task:stuck-loop-exhausted-no-action",
              liveExecutionSignal.reason,
              {
                ...liveExecutionSignal.metadata,
                lastReason: reason,
                stuckKillCount: task.stuckKillCount ?? 0,
                attemptedStuckKillCount: newCount,
                maxStuckKills: maxKills,
              },
            );
            return false;
          }

          log.warn(`${taskId} exceeded stuck kill budget (${newCount}/${maxKills}, reason=${reason}) with incomplete steps — parking in todo with progress preserved`);
          const exhaustedError = `STUCK_LOOP_EXHAUSTED: incomplete task exhausted stuck kill budget (${newCount}/${maxKills}) after last reason=${reason}. Progress was preserved; manually retry, decompose, or rescope before execution resumes.`;
          const parkUpdate = {
            stuckKillCount: newCount,
            status: "failed",
            error: exhaustedError,
            paused: true,
            pausedReason: "stuck-loop-exhausted-manual-intervention-required",
            pausedByAgentId: "self-healing",
            assignedAgentId: null,
            checkedOutBy: null,
            checkedOutAt: null,
            checkoutNodeId: null,
            checkoutRunId: null,
            checkoutLeaseRenewedAt: null,
            checkoutLeaseEpoch: 0,
            nextRecoveryAt: null,
          } satisfies Parameters<typeof this.store.updateTask>[1];

          await this.store.updateTask(taskId, parkUpdate);
          try {
            await this.store.moveTask(taskId, await resolveReboundTargetForTask(this.store, taskId), {
              preserveProgress: true,
              preserveStatus: true,
              // #1411: backward recovery — skip order-derived adjacency.
              moveSource: "engine",
              recoveryRehome: true,
            });
          } catch (moveErr: unknown) {
            const moveErrMessage = moveErr instanceof Error ? moveErr.message : String(moveErr);
            log.warn(`${taskId} moveTask(todo) failed (${moveErrMessage}) after incomplete STUCK_LOOP_EXHAUSTED terminalization — marking failed/paused in place`);
            try {
              await this.store.updateTask(taskId, parkUpdate);
            } catch (patchErr: unknown) {
              const patchErrMessage = patchErr instanceof Error ? patchErr.message : String(patchErr);
              log.warn(`${taskId} in-place park patch failed after moveTask(todo) failure during incomplete STUCK_LOOP_EXHAUSTED terminalization: ${patchErrMessage}`);
              await this.store.logEntry(
                taskId,
                `STUCK_LOOP_EXHAUSTED: incomplete task failed to move to todo (${moveErrMessage}), and the in-place park patch also failed (${patchErrMessage}); pre-move park metadata was already applied, but operator verification is required before retry.`,
              );
              return false;
            }
            try {
              await this.store.logEntry(
                taskId,
                `STUCK_LOOP_EXHAUSTED: incomplete task exhausted stuck kill budget (${newCount}/${maxKills}), last reason=${reason}. Failed to move task to todo (${moveErrMessage}); task was marked failed/paused in place and will not be automatically retried.`,
              );
            } catch (logErr: unknown) {
              const logErrMessage = logErr instanceof Error ? logErr.message : String(logErr);
              log.warn(`${taskId} failed to log in-place stuck-loop park success after moveTask(todo) failure: ${logErrMessage}`);
            }
            return false;
          }

          try {
            await this.store.updateTask(taskId, parkUpdate);
            await this.store.logEntry(
              taskId,
              `STUCK_LOOP_EXHAUSTED: incomplete task exhausted stuck kill budget (${newCount}/${maxKills}), last reason=${reason}. Parked in todo with progress preserved; no further automatic retries will run until an operator manually retries, decomposes, or rescopes the task.`,
            );
          } catch (patchErr: unknown) {
            const patchErrMessage = patchErr instanceof Error ? patchErr.message : String(patchErr);
            log.warn(`${taskId} post-move park patch failed after incomplete STUCK_LOOP_EXHAUSTED terminalization: ${patchErrMessage}`);
            await this.store.logEntry(
              taskId,
              `STUCK_LOOP_EXHAUSTED: incomplete task moved to todo with progress preserved, but post-move park patch failed (${patchErrMessage}); operator repair is required before retry.`,
            );
          }
          return false;
        }

        // Budget exhausted — mark as permanently failed
        log.warn(`${taskId} exceeded stuck kill budget (${newCount}/${maxKills}, reason=${reason}) — marking failed`);
        const exhaustedError =
          `STUCK_LOOP_EXHAUSTED: stuck kill budget exhausted (${newCount}/${maxKills}) after last reason=${reason}.`;
        await this.store.updateTask(taskId, {
          stuckKillCount: newCount,
          status: "failed",
          error: exhaustedError,
        });
        try {
          await this.handoffTaskToReview(taskId, "stuck-loop-exhausted");
        } catch (moveErr: unknown) {
          // moveTask may fail if task was concurrently moved (e.g., dep-abort).
          // The task is already marked failed — don't allow requeue.
          const moveErrMessage = moveErr instanceof Error ? moveErr.message : String(moveErr);
          log.warn(`${taskId} handoffTaskToReview failed (${moveErrMessage}) after STUCK_LOOP_EXHAUSTED terminalization — task already marked failed, not re-queuing`);
        }
        await this.store.logEntry(
          taskId,
          `STUCK_LOOP_EXHAUSTED: stuck kill budget exhausted (${newCount}/${maxKills}), last reason=${reason}. No further automatic retries will run. Manually retry, pause, or move the task to triage to resume work.`,
        );
        return false;
      }

      // Budget remaining — allow re-queue
      log.log(`${taskId} stuck kill ${newCount}/${maxKills} — will re-queue`);
      await this.store.updateTask(taskId, { stuckKillCount: newCount });
      await this.store.logEntry(
        taskId,
        `Stuck kill ${newCount}/${maxKills} — re-queuing for retry`,
      );
      return true;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`checkStuckBudget failed for ${taskId}: ${errorMessage}`);
      // On error, allow re-queue — safer than permanently failing
      return true;
    }
  }

  // ── Periodic maintenance ──────────────────────────────────────────

  private async startMaintenance(): Promise<void> {
    const settings = await this.store.getSettings();
    const intervalMs = settings.maintenanceIntervalMs ?? 900_000;

    if (intervalMs <= 0) {
      log.debug("Periodic maintenance disabled (maintenanceIntervalMs <= 0)");
      return;
    }

    log.debug(`Periodic maintenance every ${Math.round(intervalMs / 60_000)}m`);
    this.maintenanceInterval = setInterval(() => {
      void this.runMaintenance();
    }, intervalMs);
  }

  /*
  FNXC:CrossProcessDeleteObservation 2026-08-01-11:39:
  Periodic self-healing owns outbox retention. Each already-open PostgreSQL project is gated to
  one bounded prune every six hours; failures stay diagnostic-only so retention never blocks
  task execution or another maintenance step.
  */
  private async pruneTaskLifecycleEventsForMaintenance(): Promise<void> {
    const layer = this.store.getAsyncLayer();
    const projectId = layer?.projectId;
    if (!layer || !projectId) return;
    const now = Date.now();
    const lastPrunedAt = this.taskLifecycleRetentionLastPrunedAt.get(projectId) ?? 0;
    if (now - lastPrunedAt < 6 * 60 * 60 * 1000) return;
    try {
      await pruneTaskLifecycleEvents(layer, projectId);
      this.taskLifecycleRetentionLastPrunedAt.set(projectId, now);
    } catch (error) {
      log.warn(`Task lifecycle retention failed for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /*
  FNXC:PrMergeEventDrivenChecks 2026-08-09-14:35:
  Scheduled maintenance owns the 14-day core retention window because inactive repositories stop
  sending webhooks. Failures are diagnostic-only and an empty partition is never substituted.
  */
  private async pruneGitHubCheckStatesForMaintenance(): Promise<void> {
    const layer = this.store.getAsyncLayer();
    const projectId = layer?.projectId?.trim();
    if (!layer || !projectId) return;
    const now = Date.now();
    const lastPrunedAt = this.githubCheckStateRetentionLastPrunedAt.get(projectId) ?? 0;
    if (now - lastPrunedAt < 6 * 60 * 60 * 1000) return;
    try {
      await pruneGitHubCheckStatesAsync(layer, projectId);
      this.githubCheckStateRetentionLastPrunedAt.set(projectId, now);
    } catch (error) {
      log.warn(`GitHub check-state retention failed for project ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private isPastInterruptedMergeGrace(task: Task, timeoutMs: number): boolean {
    const updatedAt = task.updatedAt ? Date.parse(task.updatedAt) : 0;
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
    return Date.now() - updatedAt >= timeoutMs;
  }

  /*
  FNXC:MergeQueue 2026-07-15-09:50:
  Do not use task.updatedAt as the sole stall clock for an in-flight merge. Overseer "progressing" lines and other logEntry writes refresh updatedAt while the merger agent is completely wedged (e.g. hung fn_task_show), so age gates never fire. Prefer last merger agent-log timestamp, then active-merge claim wall clock, then updatedAt only as last resort.
  */
  private async getLastMergerAgentActivityMs(taskId: string): Promise<number | null> {
    if (typeof this.store.getAgentLogs !== "function") return null;
    try {
      const logs = await this.store.getAgentLogs(taskId, { limit: 80 });
      if (!Array.isArray(logs) || logs.length === 0) return null;
      for (let i = logs.length - 1; i >= 0; i--) {
        const entry = logs[i] as { agent?: string; timestamp?: string };
        if (entry.agent !== "merger" || !entry.timestamp) continue;
        const ms = Date.parse(entry.timestamp);
        if (Number.isFinite(ms) && ms > 0) return ms;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async measureActiveMergeSilenceMs(taskId: string): Promise<number | null> {
    const now = Date.now();
    const lastMergerMs = await this.getLastMergerAgentActivityMs(taskId);
    if (lastMergerMs != null) return now - lastMergerMs;
    const startedAt = this.options.getActiveMergeStartedAtMs?.() ?? null;
    if (startedAt != null && Number.isFinite(startedAt) && startedAt > 0) {
      return now - startedAt;
    }
    return null;
  }

  /*
  FNXC:MergeQueue 2026-07-15-10:05:
  Status-aware silence reclaim via shouldReclaimWedgedMerge: reviewing reclaims after stuckTimeout;
  merging* requires a higher silence floor so monorepo single-bash verify is not false-reclaimed;
  null/other with live owner reclaims as a dead pump.
  */
  private async isActiveMergeWedged(
    taskId: string,
    timeoutMs: number,
    status?: string | null,
  ): Promise<{ wedged: boolean; silenceMs: number | null }> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { wedged: false, silenceMs: null };
    const activeId = this.options.getActiveMergeTaskId?.() ?? null;
    if (activeId !== taskId) return { wedged: false, silenceMs: null };

    const silenceMs = await this.measureActiveMergeSilenceMs(taskId);
    if (silenceMs == null) return { wedged: false, silenceMs: null };

    let resolvedStatus = status;
    if (resolvedStatus === undefined) {
      const task = await this.store.getTask(taskId).catch(() => null);
      resolvedStatus = task?.status ?? null;
    }

    return {
      wedged: shouldReclaimWedgedMerge({
        status: resolvedStatus,
        silenceMs,
        stuckTimeoutMs: timeoutMs,
      }),
      silenceMs,
    };
  }

  private async isPastInterruptedMergeGraceAsync(task: Task, timeoutMs: number): Promise<boolean> {
    const activeId = this.options.getActiveMergeTaskId?.() ?? null;
    if (activeId === task.id) {
      // Live owner: status-aware merger silence / claim-age, not updatedAt (overseer noise).
      const { wedged } = await this.isActiveMergeWedged(task.id, timeoutMs, task.status);
      return wedged;
    }
    return this.isPastInterruptedMergeGrace(task, timeoutMs);
  }



  /**
   * Best-effort refresh of the remote-tracking base ref so the already-merged
   * evidence detector can see a squash that landed on the remote after this
   * process last fetched. Returns the `origin/<base>` ref to re-run the detector
   * against, or null when there is nothing fresher to prove against.
   *
   * Fail-closed: a fetch error (offline / auth / no remote) is swallowed and we
   * still attempt to resolve the (possibly stale) remote-tracking ref; if even
   * that is absent we return null and the caller leaves the card untouched.
   */




  /**
   * FNXC:WorkflowRecovery 2026-07-25-09:40:
   * Single shared decision for "is this branch tip's foreign `Fusion-Task-Id`/`Fusion-Task-Lineage` trailer real
   * evidence of cross-task contamination, or just an inherited start point?"
   *
   * A task branch cut from the integration branch points at whatever landed last. When the task has not committed
   * anything of its own (planning aborted, spec revise, operator move back to `todo`), the branch tip IS that
   * previous task's commit — a foreign trailer with zero foreign intent. FN-1406 hit exactly this: `fusion/fn-1406`
   * was cut from `main` at FN-1401's landed commit, planning ended without a commit, and the reclaim sweep logged
   * `already-merged rejected ... owner=FN-1401 reason=foreign-task-tip` every pass instead of clearing the stale
   * worktree/branch metadata.
   *
   * Merge-base-to-tip diff proof separates the two: no unique diff means the branch carries no task content, so the
   * foreign trailer is inherited and the caller may treat the row as stale metadata. The one exception is when the
   * base ALREADY has an explicit commit for this task — then the branch should have been sitting on the task's own
   * landed commit, and a foreign tip is genuine misbinding worth rejecting.
   *
   * Callers: already-merged recovery (`branchTipForeignOwnership`), branch-misbound recovery
   * (`isBranchTipMisboundToTask`), and the self-owned-branch reclaim sweep's `tip-already-merged` arm. Keeping the
   * three on one helper is the point — the reclaim arm drifted without the diff proof and that was the bug.
   */

  private async rejectForeignAlreadyMergedCandidate(input: {
    task: Pick<Task, "id" | "lineageId">;
    candidateSha: string;
    candidateOwner?: string;
    taskBranch?: string | null;
    baseBranch: string;
    reason: "foreign-task-tip" | "foreign-lineage-tip" | "foreign-landed-commit" | "ownership-unverifiable";
    phase: string;
  }): Promise<void> {
    const { task, candidateSha, candidateOwner, taskBranch, baseBranch, reason, phase } = input;
    /*
    FNXC:WorkflowRecovery 2026-06-28-21:32:
    FN-7143 observed an already-merged tip that appeared to belong to FN-7187. Self-healing must make that cross-task proof visible and leave the review task alone; ambiguous or foreign tips are not safe evidence for mergeConfirmed/done finalization.

    FNXC:WorkflowRecovery 2026-06-29-00:15:
    Ownership lookup failures are also unsafe evidence. Record them through the same rejection audit path with `ownership-unverifiable` so transient git-show/rev-parse failures cannot proceed into reclaim or auto-finalize as if the tip were verified non-foreign.
    */
    await this.store.logEntry(
      task.id,
      `[recovery] already-merged rejected ${task.id} candidate=${candidateSha.slice(0, 12)} owner=${candidateOwner ?? "unknown"} branch=${taskBranch ?? "?"} base=${baseBranch} reason=${reason}`,
    );
    try {
      await this.store.recordRunAuditEvent?.({
        taskId: task.id,
        agentId: "self-healing",
        runId: generateSyntheticRunId("self-heal-already-merged-rejected", task.id),
        domain: "database",
        mutationType: "task:auto-recover-already-merged-rejected",
        target: task.id,
        metadata: {
          reason,
          phase,
          candidateSha,
          candidateOwner: candidateOwner ?? null,
          taskBranch: taskBranch ?? null,
          baseBranch,
        },
      });
    } catch (err: unknown) {
      log.warn(`Failed to record already-merged rejection audit for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }


  private async resolveSelfHealingMergeTarget(
    task: Task,
    settings: Settings | undefined,
    phase: string,
  ): Promise<{ branch: string; source?: MergeDetails["mergeTargetSource"]; groupId?: string; groupBranchName?: string }> {
    const projectDefaultBranch = await resolveIntegrationBranch(this.options.rootDir, settings);
    const routing = await resolveBranchGroupMergeRouting({
      task,
      store: this.store,
      projectDefaultBranch,
      rootDir: this.options.rootDir,
    });

    if (!routing) {
      return { branch: task.baseBranch || task.executionStartBranch || projectDefaultBranch };
    }

    const targetBranch = routing.branchGroup.branchName;
    if (targetBranch === projectDefaultBranch || routing.mergeTarget.source !== "branch-group-integration") {
      await this.recordSharedGroupDefaultTargetGuard(task, phase, {
        projectDefaultBranch,
        resolvedBranch: routing.mergeTarget.branch,
        resolvedSource: routing.mergeTarget.source,
        groupBranchName: routing.branchGroup.branchName,
      });
    }

    return {
      branch: targetBranch,
      source: "branch-group-integration",
      groupId: routing.branchGroup.id,
      groupBranchName: routing.branchGroup.branchName,
    };
  }

  private async recordSharedGroupDefaultTargetGuard(
    task: Task,
    phase: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal-shared-group-routing", task.id),
        agentId: "self-healing",
        taskId: task.id,
        taskLineageId: task.lineageId,
        phase,
      }).database({
        type: "task:shared-group-member-default-target-rerouted" as DatabaseMutationType,
        target: task.id,
        metadata: {
          taskId: task.id,
          groupId: task.branchContext?.groupId ?? null,
          ...metadata,
        },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to record shared-group routing guard for ${task.id}: ${errorMessage}`);
    }
  }


  private async recordSelfHealingBranchGroupMemberLanding(
    task: Task,
    target: { groupId?: string; branch: string; source?: MergeDetails["mergeTargetSource"] },
    phase: string,
  ): Promise<void> {
    if (!target.groupId || target.source !== "branch-group-integration") {
      return;
    }

    try {
      const landingRecorder = this.store as TaskStore & BranchGroupLandingRecorder;
      await Promise.resolve(landingRecorder.recordBranchGroupMemberLanded?.(target.groupId, {
        taskId: task.id,
        branchName: target.branch,
        worktreePath: task.worktree ?? null,
        status: "open",
      }));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to record branch-group member landing for ${task.id}: ${errorMessage}`);
    }

    try {
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal-shared-group-landed", task.id),
        agentId: "self-healing",
        taskId: task.id,
        taskLineageId: task.lineageId,
        phase,
      }).database({
        type: "task:shared-group-member-self-heal-landed" as DatabaseMutationType,
        target: task.id,
        metadata: {
          taskId: task.id,
          groupId: target.groupId,
          mergeTargetBranch: target.branch,
          mergeTargetSource: target.source,
        },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to record shared-group self-heal landing audit for ${task.id}: ${errorMessage}`);
    }
  }

  /**
   * U8 seam: whether a worktree path backs a resume-eligible CLI agent session
   * and must therefore be treated as in-use by idle sweeps. Defensive: a throw
   * in the injected predicate is treated as "reserved" (conservative — never
   * reclaim a worktree we can't prove is free).
   */
  private isWorktreeResumeReserved(worktreePath: string): boolean {
    const predicate = this.options.isWorktreeResumeReserved;
    if (!predicate) return false;
    try {
      return predicate(resolve(worktreePath));
    } catch (err: unknown) {
      log.warn(
        `[self-healing] resume-reserved check threw for ${worktreePath}: ${
          err instanceof Error ? err.message : String(err)
        } — treating as reserved (conservative)`,
      );
      return true;
    }
  }

  private async cleanupWorktreeOnly(task: Task): Promise<void> {
    if (task.worktree && existsSync(task.worktree)) {
      try {
        const settings = await this.store.getSettings();
        await removeWorktree({
          rootDir: this.options.rootDir,
          worktreePath: task.worktree,
          settings,
          taskId: task.id,
          reason: RemovalReason.SelfHealingReclaim,
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(
          `Failed to remove worktree ${task.worktree} for ${task.id}: ${errorMessage} — non-fatal, cleanup can retry later`,
        );
      }
    }
  }

  private async cleanupInterruptedMergeArtifacts(task: Task): Promise<void> {
    if (task.worktree && existsSync(task.worktree)) {
      try {
        const settings = await this.store.getSettings();
        await removeWorktree({
          rootDir: this.options.rootDir,
          worktreePath: task.worktree,
          settings,
          taskId: task.id,
          reason: RemovalReason.SelfHealingReclaim,
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(
          `Failed to remove interrupted-merge worktree ${task.worktree} for ${task.id}: ${errorMessage} — non-fatal, cleanup can retry later`,
        );
      }
    }

    const branch = resolveTaskWorkingBranch(task);
    try {
      await execAsync(`git branch -D ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
        timeout: 120_000,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to delete interrupted-merge branch ${branch} for ${task.id}: ${errorMessage} — non-fatal`,
      );
      // Non-fatal; branch may be gone or still checked out.
    }
  }

  /*
  FNXC:EngineDiagnostics 2026-07-26-07:26:
  Periodic maintenance walks 50+ batch steps each cycle. Per-step "succeeded"/disabled-skip lines are steady-state chatter that filled the TUI log pane and drowned real recovery events. Route routine start/complete/success/skip to debug() (opt-in via FUSION_DEBUG=self-healing). Keep log()/warn()/error() only for state changes (recovered/deleted/cleaned counts > 0), pause-policy skips operators may need, and step failures.
  */
  private async runMaintenance(): Promise<void> {
    if (this.maintenanceRunning) {
      log.debug("Maintenance cycle skipped — previous cycle still running");
      return;
    }

    this.maintenanceRunning = true;
    const startMs = Date.now();
    this.maintenanceTickCounter++;
    log.debug("Maintenance cycle starting");

    try {
      const settings = await this.store.getSettings();

      // Batch 1 — housekeeping (safe under pause: filesystem/db cleanup only)
      const batch1Fns: Array<{ name: string; fn: () => Promise<unknown> }> = [
        { name: "prune-worktrees", fn: () => this.pruneWorktrees() },
        {
          name: "prune-task-lifecycle-events",
          fn: async () => this.pruneTaskLifecycleEventsForMaintenance(),
        },
        { name: "prune-github-check-states", fn: async () => this.pruneGitHubCheckStatesForMaintenance() },
        { name: "cleanup-orphans", fn: () => this.cleanupOrphans() },
        {
          name: "cleanup-stale-temp-merge-worktrees",
          fn: async () => {
            const cleaned = await this.cleanupStaleTempMergeWorktrees();
            if (cleaned > 0) {
              log.debug(`Cleaned ${cleaned} stale AI merge temp worktree(s)`);
            }
            return cleaned;
          },
        },
        { name: "cleanup-orphaned-branches", fn: () => this.cleanupOrphanedBranches() },
        {
          name: "reconcile-orphaned-task-dirs",
          fn: async () => {
            /*
             * FNXC:TaskStoreConsistency 2026-06-20-00:00:
             * Runtime heartbeat-created task dirs can appear after store init, so paused-safe housekeeping must reconcile orphaned task.json rows during maintenance instead of waiting for a restart.
             */
            const result = await this.store.reconcileOrphanedTaskDirs();
            if (result.recovered.length > 0 || result.skipped.some((entry) => entry.reason.startsWith("malformed"))) {
              log.warn(`Maintenance batch 1 step "reconcile-orphaned-task-dirs" recovered=${result.recovered.length} skipped=${result.skipped.length}`);
            }
            return result;
          },
        },
        {
          name: "reconcile-stale-symbol-locks",
          fn: () => this.reconcileStaleSymbolLocks(),
        },
        {
          name: "reconcile-phantom-committed-reservations",
          fn: async () => {
            /*
             * FNXC:TaskStoreConsistency 2026-06-26-00:00:
             * FN-7069 phantoms are committed task-id reservations without any task row or task.json. Maintenance must prune their orphaned child rows without resurrecting/freeing the ID, matching the startup reconcile.
             */
            const result = await this.store.reconcilePhantomCommittedReservations();
            if (result.reconciled.length > 0) {
              log.warn(`Maintenance batch 1 step "reconcile-phantom-committed-reservations" reconciled=${result.reconciled.length} skipped=${result.skipped.length}`);
            }
            return result;
          },
        },
        {
          name: "cleanup-old-chats",
          fn: async () => {
            const days = Number(settings.chatAutoCleanupDays ?? 0);
            if (!Number.isFinite(days) || days <= 0) {
              log.debug("Maintenance batch 1 step \"cleanup-old-chats\" skipped — chatAutoCleanupDays is not enabled");
              return;
            }
            if (!this.options.chatStore) {
              log.debug("Maintenance batch 1 step \"cleanup-old-chats\" skipped — ChatStore unavailable");
              return;
            }
            const { sessionsDeleted, roomsDeleted } = await this.options.chatStore.cleanupOldChats(days * 86_400_000);
            if (sessionsDeleted > 0 || roomsDeleted > 0) {
              log.debug(`Maintenance batch 1 step "cleanup-old-chats" removed stale data — sessions=${sessionsDeleted} rooms=${roomsDeleted}`);
            } else {
              log.debug(`Maintenance batch 1 step "cleanup-old-chats" succeeded — sessions=${sessionsDeleted} rooms=${roomsDeleted}`);
            }
          },
        },
        {
          name: "cleanup-old-mail",
          fn: async () => {
            const value = Number(settings.mailAutoCleanupDays ?? 0);
            if (!Number.isFinite(value) || value <= 0) {
              log.debug(`Skipping cleanup-old-mail: setting=${String(settings.mailAutoCleanupDays ?? 0)}`);
              return;
            }
            if (!this.options.messageStore) {
              log.debug("Skipping cleanup-old-mail: messageStore unavailable");
              return;
            }
            const { messagesDeleted } = await this.options.messageStore.cleanupOldMessages(value * 86_400_000);
            if (messagesDeleted > 0) {
              log.debug(`Maintenance batch 1 step "cleanup-old-mail" removed stale data — messagesDeleted=${messagesDeleted}`);
            } else {
              log.debug(`Maintenance batch 1 step "cleanup-old-mail" succeeded — messagesDeleted=${messagesDeleted}`);
            }
          },
        },
        {
          name: "prune-operational-logs",
          fn: async () => {
            const days = Number(settings.operationalLogRetentionDays ?? 0);
            if (!Number.isFinite(days) || days <= 0) {
              log.debug("Maintenance batch 1 step \"prune-operational-logs\" skipped — operationalLogRetentionDays is not enabled");
              return;
            }
            // FNXC:PostgresRetention 2026-07-14-17:16: Autovacuum cannot replace
            // retention; await project-scoped deletes on the PostgreSQL layer.
            const { deletedTotal, deletedByTable } = await this.store.pruneOperationalLogsAsync(days * 86_400_000);
            const detail = Object.entries(deletedByTable)
              .filter(([, n]) => n > 0)
              .map(([t, n]) => `${t}=${n}`)
              .join(" ");
            const summary = `Maintenance batch 1 step "prune-operational-logs" succeeded — deleted=${deletedTotal}${detail ? ` (${detail})` : ""}`;
            if (deletedTotal > 0) {
              log.log(summary);
            } else {
              log.debug(summary);
            }
          },
        },
        {
          name: "prune-agent-activity-events",
          fn: async () => {
            /*
            FNXC:AgentActivityStream 2026-08-09-10:04:
            The durable monitoring outbox has a 30-day and 50k-row bound. Run its project-scoped
            cleanup only in paused-safe housekeeping; append must remain fast and retry-safe.
            */
            await this.store.pruneAgentActivityEventsAsync();
          },
        },
        {
          name: "prune-agent-log-files",
          fn: async () => {
            const days = Number(settings.agentLogFileRetentionDays ?? 0);
            if (!Number.isFinite(days) || days <= 0) {
              log.debug("Maintenance batch 1 step \"prune-agent-log-files\" skipped — agentLogFileRetentionDays is not enabled");
              return;
            }
            const { prunedFiles, prunedEntries, freedBytes } = await this.store.pruneAgentLogFilesAsync(days);
            const summary = `Maintenance batch 1 step "prune-agent-log-files" succeeded — files=${prunedFiles} entries=${prunedEntries} bytes=${freedBytes}`;
            if (prunedFiles > 0 || prunedEntries > 0) {
              log.log(summary);
            } else {
              log.debug(summary);
            }
          },
        },
        { name: "fts-maintenance", fn: () => this.maintainTaskFts() },
        { name: "checkpoint-wal", fn: () => Promise.resolve(this.checkpointWal()) },
        { name: "enforce-worktree-cap", fn: () => this.enforceWorktreeCap() },
      ];
      for (const fn of batch1Fns) {
        try {
          await fn.fn();
          log.debug(`Maintenance batch 1 step "${fn.name}" succeeded`);
        } catch (stepErr) {
          log.error(`Maintenance batch 1 step "${fn.name}" failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
        }
        await yieldEventLoop();
      }

      const recoverySettings = await this.store.getSettings();
      if (recoverySettings.globalPause || recoverySettings.enginePaused) {
        log.debug(
          `Maintenance batch 2 skipped — ${
            recoverySettings.globalPause ? "global pause" : "engine pause"
          } is active`,
        );
        // FNXC:StrandedHoldContinuation 2026-07-26-16:40:
        // Preserve the global pause for recovery mutations, but run this
        // read-only-under-pause classifier so stranded candidates are visible.
        await this.reconcileStrandedHoldContinuations();
      } else {
        // Batch 2 — Task recovery (operations are independent of each other)
        const maintenanceSurfacing = this.surfacingCycleMemo();
        const batch2Fns: Array<{ name: string; fn: () => Promise<unknown> }> = [
          {
            name: "recover-active-mission-validations",
            fn: async () => {
              if (!this.options.recoverActiveMissionValidations) {
                return;
              }
              await this.options.recoverActiveMissionValidations();
            },
          },
          {
            name: "reap-stale-mission-validator-runs",
            fn: async () => {
              if (!this.options.reapStaleMissionValidatorRuns) {
                return;
              }
              await this.options.reapStaleMissionValidatorRuns();
            },
          },
          {
            name: "reconcile-mission-features",
            fn: async () => {
              if (!this.options.reconcileAllMissionFeatures) {
                return;
              }
              await this.options.reconcileAllMissionFeatures();
            },
          },
          { name: "detect-stalled-cards", fn: () => this.detectStalledCards() },
          { name: "recover-completed-tasks", fn: () => this.recoverCompletedTasks() },
          { name: "recover-stranded-completed-todo", fn: () => this.recoverStrandedCompletedTodoTasks() },
          { name: "recover-advanced-triage", fn: () => this.recoverAdvancedTriageTasks() },
          { name: "recover-stale-incomplete-review", fn: () => this.recoverStaleIncompleteReviewTasks() },
          /*
          FNXC:OrphanedPendingSteps 2026-07-26-19:20:
          Ordering is load-bearing: this sweep PRODUCES the `failed` results that
          `recover-failed-pre-merge-steps` CONSUMES, so it must run first. It used to sit ~15
          entries later in this list, which meant a step orphaned in cycle N was rewritten to
          `failed` only after recovery had already scanned — nothing re-ran it until cycle N+1.
          Combined with the lease-staleness wait that is a multi-cycle hole for a card whose
          review session died (observed: FN-8603 sat ~36 min after an engine restart killed its
          Code Review session 34s in). Startup recovery already orders these two correctly.
          Keep them adjacent and in this order.
          */
          { name: "reconcile-orphaned-pending-step-results", fn: () => this.reconcileOrphanedPendingStepResults() },
          { name: "recover-failed-pre-merge-steps", fn: () => this.recoverReviewTasksWithFailedPreMergeSteps() },
          { name: "recover-missing-worktree-review-failures", fn: () => this.recoverMissingWorktreeReviewFailures() },
          { name: "recover-interrupted-merging", fn: () => this.recoverInterruptedMergingTasks() },
          { name: "recover-wedged-active-merge", fn: () => this.recoverWedgedActiveMerge() },
          { name: "recover-transient-merge-failures", fn: () => this.recoverTransientMergeFailures() },
          { name: "recover-done-merge-metadata", fn: () => this.recoverDoneTaskMergeMetadata() },
          { name: "recover-stale-merging-status", fn: () => this.recoverStaleMergingStatus() },
          { name: "finalize-noop-review", fn: () => this.finalizeNoOpReviewTasks() },
          { name: "reconcile-done-task-integrity", fn: () => this.reconcileDoneTaskIntegrity() },
          { name: "reconcile-stale-merger-status", fn: () => this.reconcileStaleMergerStatus() },
          { name: "reconcile-stale-duplicate-decision", fn: () => this.reconcileStaleDuplicateDecisionPause() },
          // FNXC:OrphanedPendingSteps 2026-07-22-16:35 (FN-8492 review follow-up): also
          // steady-state — a step session can die without an engine restart, and startup-only
          // cadence left that case riding the 3×30-min stall escalator to a deadlock park.
          // Live sessions register their worktree path, so the liveness veto holds here.
          // FNXC:OrphanedPendingSteps 2026-07-26-19:22: this entry MOVED up to immediately
          // before `recover-failed-pre-merge-steps` (see the ordering note there). It is not
          // duplicated here — running it twice per cycle would re-scan every in-review task for
          // no benefit.
          { name: "reconcile-stranded-hold-continuations", fn: () => this.reconcileStrandedHoldContinuations() },
          { name: "recover-mergeable-review", fn: () => this.recoverMergeableReviewTasks() },
          // FNXC:Workspace 2026-06-22-09:30 (Phase D U1) — workspace-mode reconcilers.
          { name: "reconcile-workspace-partial-lands", fn: () => this.reconcileWorkspacePartialLands() },
          { name: "reclaim-phantom-workspace-land-leases", fn: () => this.reclaimPhantomWorkspaceLandLeases() },
          { name: "reconcile-orphaned-workspace-worktrees", fn: () => this.reconcileOrphanedWorkspaceWorktrees() },
          // FNXC:PlanningEvacuation 2026-07-25-23:00: reclaim worktrees acquired at planning time by cards that never executed.
          { name: "reconcile-pre-execution-worktrees", fn: () => this.reconcilePreExecutionWorktrees() },
          { name: "recover-merged-review", fn: () => this.recoverMergedReviewTasks() },
          { name: "recover-already-merged-review", fn: () => this.recoverAlreadyMergedReviewTasks() },
          { name: "recover-post-done-noncontinuable-wedge", fn: () => this.recoverPostDoneNonContinuableWedge() },
          { name: "recover-completion-handoff-limbo", fn: () => this.recoverCompletionHandoffLimbo() },
          { name: "recover-branch-misbound-in-review", fn: () => this.recoverBranchMisboundInReviewTasks() },
          { name: "recover-foreign-only-contamination-in-review", fn: () => this.recoverForeignOnlyContaminatedInReviewTasks() },
          { name: "recover-orphan-only-scope-violations", fn: () => this.recoverOrphanOnlyScopeViolations() },
          { name: "recover-stuck-merge-deadlocks", fn: () => this.recoverStuckMergeDeadlocks() },
          { name: "recover-misclassified-failures", fn: () => this.recoverMisclassifiedFailures() },
          { name: "recover-no-progress-no-task-done", fn: () => this.recoverNoProgressNoTaskDoneFailures() },
          { name: "recover-paused-abort-failures", fn: () => this.recoverPausedAbortFailures() },
          { name: "recover-partial-progress-no-task-done", fn: () => this.recoverPartialProgressNoTaskDoneFailures() },
          { name: "recover-orphaned-executions", fn: () => this.recoverOrphanedExecutions() },
          { name: "recover-approved-triage", fn: () => this.recoverApprovedTriageTasks() },
          { name: "resolve-explicit-duplicate-markers", fn: () => this.resolveExplicitDuplicateMarkerTasks() },
          { name: "recover-starved-refinement", fn: () => this.recoverStarvedRefinementTriageTasks() },
          { name: "recover-orphaned-planning", fn: () => this.recoverOrphanedPlanningTasks() },
           { name: "finalize-orphaned-planning-segments", fn: () => this.finalizeOrphanedPlanningSegments() },
          { name: "recover-ghost-review", fn: () => this.recoverGhostReviewTasks() },
          { name: "recover-orphaned-agents", fn: () => this.recoverOrphanedAgents() },
          { name: "recover-stale-heartbeat-runs", fn: () => this.recoverStaleHeartbeatRuns() },
          { name: "reattach-orphaned-assigned-executions", fn: () => this.reattachOrphanedAssignedExecutions() },
          { name: "recover-running-on-inactive-tasks", fn: () => this.recoverAgentsRunningOnInactiveTasks() },
          { name: "recover-drifted-agent-task-links", fn: () => this.recoverDriftedAgentTaskLinks() },
          { name: "reconcile-soft-delete-column-drift", fn: () => this.reconcileSoftDeletedColumnDrift() },
          { name: "clear-stale-blocked-by", fn: () => this.clearStaleBlockedBy() },
          { name: "auto-rebound-paused-scope-decay", fn: () => this.autoReboundPausedScopeDecay() },
          /*
           * FNXC:SelfHealing 2026-07-26-16:40:
           * There is deliberately NO meta-task auto-archive sweep here. The removed FN-4890/FN-5064
           * sweeps ("auto-archive-meta-resolved"/"auto-archive-meta-stalled") decided a card was a
           * "meta-task" by regex over title+description (`/\b(recover|unblock|finalize|meta)\b/i`),
           * so an ordinary feature card such as "Unblock queued dispatch" qualified; the target
           * resolver then bound it to an unrelated card by creation order and self-healing archived
           * live work. No guard set can make a title regex a safe basis for destructive archival, so
           * the feature is deleted rather than tuned. Do not reintroduce a heuristic meta-task
           * classifier — meta/parent relationships must be explicit task fields if ever needed again.
           */
          { name: "board-stall-auto-recovery", fn: () => this.runBoardStallAutoRecoverySweep() },
          // #1401: periodically recover transitionPending markers stranded by a
          // crash between the in-txn write and the post-commit clear (flag-ON
          // only; a no-op when there are no markers).
          { name: "recover-stale-transition-pending", fn: () => this.runStaleTransitionPendingSweep() },
          { name: "reconcile-self-defeating-deps", fn: () => this.reconcileSelfDefeatingDependencies() },
          { name: "reconcile-dependency-blocking-leases", fn: () => this.reconcileDependencyBlockingLeases() },
          { name: "reconcile-completed-blocked", fn: () => this.reconcileCompletedBlockedTasks() },
          { name: "reconcile-in-review-unmet-dependencies", fn: () => this.reconcileInReviewUnmetDependencies() },
          // FN-6782: reclaim in-memory worktree slots whose holder is no longer
          // in-progress (defense-in-depth for the pause-abort leak; conservative,
          // gated by clearPhantomExecutorBinding's live-session refusal).
          { name: "reap-leaked-concurrency-slots", fn: () => this.reapLeakedConcurrencySlots() },
          { name: "reconcile-dependency-cycles", fn: () => this.reconcileDependencyCycles().then(() => undefined) },
          { name: "reclaim-pr-conflicts", fn: () => this.reclaimPrConflicts() },
          { name: "reclaim-self-owned-branch-conflicts", fn: () => this.reclaimSelfOwnedBranchConflicts() },
          // FN-4962 ordering invariant: metadata reconcile must run before stale-active reclaim.
          { name: "reconcile-task-worktree-metadata", fn: () => this.reconcileTaskWorktreeMetadata() },
          { name: "recover-in-progress-limbo", fn: () => this.recoverInProgressLimbo() },
          { name: "reconcile-in-review-branch-rebind", fn: () => this.reconcileInReviewBranchRebind().then(() => undefined) },
          { name: "reclaim-stale-active-branches", fn: () => this.reclaimStaleActiveBranches() },
          { name: "surface-in-review-stalls", fn: () => this.surfaceInReviewStalls() },
          /* One shared cycle for the family — see `openSurfacingCycle`. */
          { name: "surface-in-review-stalled", fn: () => this.surfaceInReviewStalled(maintenanceSurfacing()) },
          { name: "surface-stale-paused-reviews", fn: () => this.surfaceStalePausedReviews(maintenanceSurfacing()) },
          { name: "surface-stale-paused-todos", fn: () => this.surfaceStalePausedTodos(maintenanceSurfacing()) },
          { name: "surface-db-corruption", fn: () => this.surfaceDbCorruption() },
          { name: "audit-no-commits-expected-candidates", fn: () => this.auditNoCommitsExpectedCandidates() },
        ];
        for (const fn of batch2Fns) {
          try {
            await fn.fn();
            log.debug(`Maintenance batch 2 step "${fn.name}" succeeded`);
          } catch (stepErr) {
            log.error(`Maintenance batch 2 step "${fn.name}" failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
          }
          await yieldEventLoop();
        }
      }

      // Batch 3 — Archive (runs after recovery so we don't archive recoverable tasks)
      const batch3Fns: Array<{ name: string; fn: () => Promise<unknown> }> = [
        { name: "archive-stale-done", fn: () => this.archiveStaleDoneTasks() },
      ];
      for (const fn of batch3Fns) {
        try {
          await fn.fn();
          log.debug(`Maintenance batch 3 step "${fn.name}" succeeded`);
        } catch (stepErr) {
          log.error(`Maintenance batch 3 step "${fn.name}" failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
        }
        await yieldEventLoop();
      }

      const elapsedMs = Date.now() - startMs;
      log.debug(`Maintenance cycle completed in ${elapsedMs}ms`);
    } finally {
      this.maintenanceRunning = false;
    }
  }

  // ── Auto-archive of stale done tasks ──────────────────────────────

  /**
   * Auto-archive done tasks older than the project retention setting so the
   * active task database does not accumulate completed task payloads forever.
   * Archived task metadata is retained in the separate archive database and can
   * be restored by unarchiving.
   */
  private static readonly AUTO_ARCHIVE_AFTER_MS = 48 * 60 * 60 * 1000;

  async archiveStaleDoneTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      const doneAutoArchiveDaysRaw = settings.doneAutoArchiveDays;
      const doneAutoArchiveDaysNumber = Number(doneAutoArchiveDaysRaw);
      const doneAutoArchiveDays =
        Number.isFinite(doneAutoArchiveDaysNumber) && Number.isInteger(doneAutoArchiveDaysNumber) && doneAutoArchiveDaysNumber > 0
          ? doneAutoArchiveDaysNumber
          : 0;
      if (settings.autoArchiveDoneTasksEnabled === false && doneAutoArchiveDays === 0) {
        return 0;
      }
      const archiveAfterMs = doneAutoArchiveDays > 0
        ? doneAutoArchiveDays * 24 * 60 * 60 * 1000
        : (settings.autoArchiveDoneAfterMs ?? SelfHealingManager.AUTO_ARCHIVE_AFTER_MS);
      if (!Number.isFinite(archiveAfterMs) || archiveAfterMs <= 0) {
        return 0;
      }

      // Slim listing — we only need id/column/columnMovedAt/updatedAt to decide
      // staleness. Pulling full task payloads (logs, comments, steps) here used
      // to drag in tens of MB on busy boards and stalled the maintenance loop.
      const tasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const now = Date.now();
      const cutoff = now - archiveAfterMs;

      // Build a set of task IDs that have at least one *active* dependent —
      // i.e., another task in triage/todo/in-progress/in-review that lists
      // this ID in its `dependencies`. Archiving such a task wipes
      // `.fusion/tasks/{id}/` on disk, which downstream agents are told they
      // may read for sibling-spec context (executor prompt). Done/archived
      // dependents have already consumed the spec and don't block.
      const tasksWithActiveDependents = new Set<string>();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-10:40 (fleet phase — self-healing terminal-lane cluster):
      "Has this card finished?" asked by id skips every renamed board, so the sweep silently treats a
      finished card as live. Resolved once per sweep via the project union — over-inclusion is free
      here because the per-card check below still discards, and the union needs no per-task workflow
      selection (docs/solutions/workflow-learnings/project-union-versus-per-task-lanes.md).
      */
      const dependentTerminalColumns = await resolveProjectColumnsForRoles(this.store, TERMINAL_ROLES);
      for (const t of tasks) {
        if (dependentTerminalColumns.has(t.column)) continue;
        for (const depId of t.dependencies ?? []) {
          tasksWithActiveDependents.add(depId);
        }
      }

      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-10:55 (fleet phase): the COMPLETE role, not the terminal
      pair — this sweep archives finished cards, so an already-archived one is not a candidate.
      */
      const doneColumns = await resolveProjectColumnsForRoles(this.store, ["complete"]);
      const stale = tasks.filter((t) => {
        if (!doneColumns.has(t.column)) return false;
        // Prefer columnMovedAt (when the task entered done); fall back to updatedAt
        // for legacy tasks that lack the field.
        const ts = t.columnMovedAt || t.updatedAt;
        const movedAt = ts ? Date.parse(ts) : NaN;
        if (!Number.isFinite(movedAt)) return false;
        if (movedAt >= cutoff) return false;
        if (tasksWithActiveDependents.has(t.id)) {
          log.debug(`Skipping auto-archive of ${t.id}: has active dependents`);
          return false;
        }
        return true;
      });

      if (stale.length === 0) return 0;

      log.debug(`Auto-archiving ${stale.length} done task(s) older than ${archiveAfterMs}ms`);

      let archived = 0;
      const thresholdDays = Math.floor(archiveAfterMs / 86_400_000);
      for (const task of stale) {
        try {
          await this.store.archiveTaskAndCleanup(task.id);
          archived++;
          const ts = task.columnMovedAt || task.updatedAt;
          const movedAt = ts ? Date.parse(ts) : NaN;
          const ageDays = Number.isFinite(movedAt) ? Math.floor((now - movedAt) / 86_400_000) : 0;
          log.debug(`auto-archive: archived ${task.id} (age ${ageDays}d, threshold ${thresholdDays}d)`);
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to auto-archive ${task.id}: ${errorMessage}`);
        }
      }

      if (archived > 0) {
        log.debug(`Auto-archived ${archived} stale done task(s)`);
      }
      return archived;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Auto-archive sweep failed: ${errorMessage}`);
      return 0;
    }
  }

  // ── Completed task recovery ──────────────────────────────────────

  /**
   * Recover tasks stuck in in-progress whose work is actually complete.
   *
   * This catches tasks where the agent called task_done() (all steps marked
   * done, summary written) but the session was killed before the executor
   * could call moveTask("in-review"). Without this, such tasks sit
   * indefinitely in in-progress with no active session.
   *
   * @returns Number of tasks recovered
   */
  async recoverCompletedTasks(): Promise<number> {
    const recoverFn = this.options.recoverCompletedTask;
    if (!recoverFn) return 0;

    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, seventeenth sweep):
      A task whose steps are ALL done but whose session died before the executor could hand it to review.
      The literal read meant that on a renamed board it was never found, so finished implementation work
      sat in the wip lane with no session and nothing to move it on — the shape this sweep exists to
      catch, made unreachable by the query above it.

      The `t.column === "in-progress"` check was redundant while the query pinned the column; under a
      resolved read it becomes the per-card verdict, so it converts rather than being deleted.
      */
      const stuckWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const stuckById = new Map<string, Task>();
      for (const column of stuckWipColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) stuckById.set(task.id, task);
      }
      const tasks = [...stuckById.values()];
      /*
      NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT — the shape #2891 settled on.
      `resolveWorkflowIrForTask` SUBSTITUTES the built-in IR rather than failing, so a card with an
      unreadable selection would otherwise be rejected by the verdict that the project-scoped query had
      just admitted it under.
      */
      const stuckLanes = new Map<string, Set<string>>();
      for (const task of tasks) {
        let lanes: Set<string>;
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id);
          lanes = source === "default" ? new Set(stuckWipColumns) : new Set(columnsWithFlag(ir, "countsTowardWip"));
        } catch {
          lanes = new Set(stuckWipColumns);
        }
        stuckLanes.set(task.id, lanes);
      }
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      const stuckCompleted = tasks.filter((t) =>
        (stuckLanes.get(t.id) ?? stuckWipColumns).has(t.column) &&
        !t.paused &&
        !executingIds.has(t.id) &&
        t.steps.length > 0 &&
        t.steps.every((s) => s.status === "done" || s.status === "skipped") &&
        // FNXC:Lifecycle 2026-07-16-21:40:
        // FN-8141 — do not auto-recover a skip-bypass-tainted task: its steps were skipped
        // after a bulk-step-completion refusal with no accepted fn_task_done, so promoting it
        // to in-review would launder unreviewed work. It stays in-progress until an accepted
        // fn_task_done or operator retry clears the taint.
        !evaluateSkipBypassTaint(t).blocked,
      );

      if (stuckCompleted.length === 0) return 0;

      log.warn(`Found ${stuckCompleted.length} completed task(s) stuck in in-progress`);

      let recovered = 0;
      for (const task of stuckCompleted) {
        // Re-check in-flight state inside the loop. The initial filter used a
        // snapshot taken before any awaits; another path (executor resume,
        // task:moved dispatch) may have claimed the task in between.
        const latestExecutingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
        if (latestExecutingIds.has(task.id)) {
          log.debug(`${task.id} started executing concurrently — skipping recovery this cycle`);
          continue;
        }
        // FN-8141: never promote a stuck-in-progress task whose most recent execution ended in a
        // failure/refusal park — honor the honest failure instead of laundering it into in-review.
        if (await this.isStrandedCompletedPromotionBlockedByFailureProvenance(task.id, "stuck-in-progress")) {
          continue;
        }
        log.log(`Recovering completed task ${task.id}: ${task.title || task.description?.slice(0, 60) || "(untitled)"}`);
        const success = await recoverFn(task);
        if (success) recovered++;
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} completed task(s) → in-review`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Completed task recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover todo tasks whose implementation steps are fully complete.
   *
   * This closes the lifecycle gap where self-healing paths can requeue a
   * finished task back to todo with progress preserved; these tasks should be
   * promoted via normal transition flow instead of waiting for re-execution.
   */
  async recoverStrandedCompletedTodoTasks(): Promise<number> {
    const recoverFn = this.options.recoverCompletedTask;
    if (!recoverFn) return 0;

    try {
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-28-06:25 (Phase B / slice B3.1 — U4):
      This sweep decided "is this card in the hold column?" TWICE — the QUERY
      (`{ column: "todo" }`) and the per-task GUARD (`task.column !== "todo"`) —
      and both were literal. They convert TOGETHER or not at all: a correct guard
      behind a literal query never runs, and a converted query behind a literal
      guard rejects every row it just fetched. Either half alone is a green diff
      with no behavior change.

      Cost discipline: the column filter is gone, so the CHEAP non-column
      rejections (paused / executing / incomplete steps / errored / taint) run
      FIRST and synchronously, and only the handful of survivors pay an IR
      resolution — shared through `irCache`, so a board spanning three workflows
      resolves three times regardless of card count. `includeArchived: false`
      keeps archived rows out, which the old column filter did implicitly.
      */
      const tasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      const completedNonColumnCandidates = tasks.filter((task) => {
        if (task.paused) return false;
        if (executingIds.has(task.id)) return false;
        if (task.steps.length === 0 || !task.steps.every((s) => s.status === "done" || s.status === "skipped")) return false;
        /*
         * FNXC:Lifecycle 2026-06-14-20:12:
         * FN-6461 keeps skipped-to-completion no-commits tasks out of the stranded-todo promoter so a finalize guard demotion cannot loop back into in-review before an operator fixes the incomplete work.
         */
        if (evaluateNoCommitsNoOpFinalize(task).blocked) return false;
        /*
         * FNXC:Lifecycle 2026-07-16-21:40:
         * FN-8141 — the stranded-todo promoter was the exact path that laundered FN-8141 into
         * in-review. A skip-bypass-tainted task (steps skipped after a bulk-step-completion
         * refusal with no accepted fn_task_done) must not promote here; the bounded
         * requeue/park machinery converges it to a human instead.
         */
        if (evaluateSkipBypassTaint(task).blocked) return false;
        if (task.error) return false;
        if (task.status && STRANDED_COMPLETED_TODO_ACTIVE_STATUSES.has(task.status)) return false;
        if (task.reviewState?.refreshStatus === "refreshing") return false;
        return true;
      });

      /*
      FNXC:WorkflowLifecycleColumns 2026-07-28-06:25 (Phase B / slice B3.1 — U4):
      The column half of the old predicate, now resolved per task against the
      card's OWN workflow. A board can span workflows with different hold
      columns, so this cannot be hoisted to one board-wide value. A workflow that
      declares no hold column keeps the legacy `todo`, matching the pre-conversion
      behavior rather than matching nothing.
      */
      const irCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const stranded: Task[] = [];
      for (const task of completedNonColumnCandidates) {
        let holdColumn = "todo";
        try {
          const lifecycle = resolveLifecycleColumns(
            await resolveWorkflowIrForTask(this.store, task.id, irCache),
          );
          if (lifecycle?.hold) holdColumn = lifecycle.hold;
        } catch {
          holdColumn = "todo";
        }
        if (task.column === holdColumn) stranded.push(task);
      }

      if (stranded.length === 0) return 0;

      log.warn(`Found ${stranded.length} completed task(s) stranded in the hold column`);

      let recovered = 0;
      for (const task of stranded) {
        const latestExecutingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
        if (latestExecutingIds.has(task.id)) {
          log.debug(`${task.id} started executing concurrently — skipping stranded todo recovery this cycle`);
          continue;
        }
        // FN-8141: never promote a stranded-todo task whose most recent execution ended in a
        // failure/refusal park — the pause-abort bounce to todo must not launder the failure.
        if (await this.isStrandedCompletedPromotionBlockedByFailureProvenance(task.id, "stranded-todo")) {
          continue;
        }

        const success = await recoverFn(task);
        if (success) recovered++;
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} stranded completed todo task(s)`);
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Stranded completed todo task recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Re-home workflow-graph tasks stranded in the planner column after the
   * executor aborted its own column-boundary move. A worktree plus a durable
   * graph pin is the proof that this is advanced execution state, not an
   * ordinary triage card. Completed work goes through the normal review
   * recovery seam; incomplete remediation resumes at its pinned column.
   */
  /*
  FNXC:WorkflowColumns 2026-07-29-09:30 (Phase B — self-healing intake/hold vocabulary):
  Per-sweep resolver for the two PRE-WIP lifecycle roles this file gates on.

  `triage` is INTAKE and `todo` is HOLD, but only for the built-in coding shape.
  U11 merges them into one column that KEEPS the id "todo" and DELETES "triage",
  so every `column === "triage"` here becomes a guard that silently stops matching
  the moment that IR lands — recovery disabled with a green suite, which is exactly
  the failure the plan's Problem Frame measured (82 guards that would stop matching
  without failing a test).

  Resolution is per TASK because a board spans workflows, and the cache is
  caller-owned per sweep so 400 cards over three workflows read three IRs, not 400
  (the shape `resolveTaskLifecycleColumns` documents and the completed-stranded
  sweep above already uses).

  UNRESOLVABLE workflows return the legacy literals rather than nothing. These are
  RECOVERY sweeps: a card whose IR cannot be read must keep its current recovery
  behaviour, not silently drop out of every sweep. That is the conservative
  direction here, and it differs deliberately from conversions whose failure mode
  is a destructive move.
  */
  private async resolvePreWipColumns(
    taskId: string,
    cache: Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>,
  ): Promise<{ intake: string; hold: string }> {
    try {
      const lifecycle = resolveLifecycleColumns(await resolveWorkflowIrForTask(this.store, taskId, cache));
      return { intake: lifecycle?.intake ?? "triage", hold: lifecycle?.hold ?? "todo" };
    } catch {
      return { intake: "triage", hold: "todo" };
    }
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-22:10 (batch-engine — the review sibling of `resolvePreWipColumns`):
  MEMBERSHIP, deliberately — a `ReadonlySet`, not a single id. `resolveLifecycleColumns` returns the FIRST
  column carrying each trait, and a workflow may declare a merge-orchestration lane and a separate human
  sign-off lane; first-per-role silently ignores the second. That arity trap has been hit four times in this
  program (the routes review resolver, the FN-7720 bypass guard, dependency satisfaction, the continuation
  drain) and every time the correct version was the membership one, so membership is the shape here from
  the start.

  Unioned with the legacy id for the same reason `resolveTerminalColumnsFor` unions: a missing or corrupt
  custom workflow does not throw — `resolveWorkflowIrForTask` hands back the BUILT-IN IR — so a renamed
  board in that degraded state would otherwise resolve a review set that excludes its own review lane and
  every guard keyed on it would go inert.
  */
  private async resolveReviewColumnsFor(
    taskId: string,
    cache: Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>,
  ): Promise<ReadonlySet<string>> {
    const columns = new Set<string>(["in-review"]);
    try {
      const ir = await resolveWorkflowIrForTask(this.store, taskId, cache);
      if (ir) {
        for (const id of columnsWithFlag(ir, "mergeOrchestration")) columns.add(id);
        for (const id of columnsWithFlag(ir, "mergeBlocker")) columns.add(id);
        for (const id of columnsWithFlag(ir, "humanReview")) columns.add(id);
      }
    } catch {
      /* degraded: the legacy id alone, matching resolvePreWipColumns' catch */
    }
    return columns;
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-14:20 (fleet — the active-work sibling of `resolveReviewColumnsFor`):
  MEMBERSHIP for the same arity reason its review sibling documents: a board may declare more than one
  pre-review working lane, and first-per-role would silently ignore the second.

  "Active work" is deliberately hold + countsTowardWip, NOT `resolvePreWipColumns`' intake + hold. The
  pause-abort router asks "is this card mid-flight, so a requeue is the right recovery?", and an intake
  lane is not mid-flight while a WIP lane is. Reusing the intake-shaped helper here would have widened the
  requeue to triage rows and dropped in-progress ones — the same set, wrong members.

  Unioned with the legacy ids because `resolveWorkflowIrForTask` answers a missing/corrupt workflow with the
  BUILT-IN IR rather than throwing: without the union, a degraded board resolves a set excluding its own
  working lanes and this recovery goes inert exactly when it is most needed.
  */
  private async resolveActiveWorkColumnsFor(
    taskId: string,
    cache: Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>,
  ): Promise<ReadonlySet<string>> {
    const columns = new Set<string>(["todo", "in-progress"]);
    try {
      const ir = await resolveWorkflowIrForTask(this.store, taskId, cache);
      if (ir) {
        const lifecycle = resolveLifecycleColumns(ir);
        if (lifecycle?.hold) columns.add(lifecycle.hold);
        for (const id of columnsWithFlag(ir, "countsTowardWip")) columns.add(id);
      }
    } catch {
      /* degraded: the legacy ids alone, matching resolveReviewColumnsFor's catch */
    }
    return columns;
  }

  /** True when the task's own column fills its workflow's intake or hold role. */
  private async isPreWipColumn(task: Task): Promise<boolean> {
    const columns = await this.resolvePreWipColumns(
      task.id,
      new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>(),
    );
    return task.column === columns.intake || task.column === columns.hold;
  }

  /** Filter `tasks` to those whose column fills one of the given pre-WIP roles. */
  private async filterByPreWipRole(
    tasks: Task[],
    roles: Array<"intake" | "hold">,
    cache: Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>,
  ): Promise<Task[]> {
    const kept: Task[] = [];
    for (const task of tasks) {
      const columns = await this.resolvePreWipColumns(task.id, cache);
      if (roles.some((role) => task.column === columns[role])) kept.push(task);
    }
    return kept;
  }

  async recoverAdvancedTriageTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      /*
      FNXC:WorkflowColumns 2026-07-29-17:40 (PR #2560 review — greptile P1):
      THE QUERY carried the literal too, and I missed it while converting this
      sweep's predicate. `listTasks({ column: "triage" })` returns EMPTY for the
      merged default lineage (#2515 collapsed the two pre-implementation columns
      into one with id "todo") and for any workflow that renamed its intake column —
      so the role-aware filter below received no candidates and this recovery was
      dead, silently. Converting a predicate while leaving its source query on a
      literal produces a sweep that LOOKS converted and does nothing.

      Read the board and filter by role. `slim` is preserved; the extra cost is one
      board read per sweep instead of an indexed column read, which the per-workflow
      IR cache below bounds to one resolution per workflow rather than per task.
      */
      const tasks = await this.filterByPreWipRole(
        await this.store.listTasks({ slim: true, includeArchived: false }),
        ["intake"],
        new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>(),
      );
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const planningIds = this.options.getPlanningTaskIds?.() ?? new Set<string>();
      const hasForeignPathOwner = (task: Task) => {
        if (!task.worktree) return false;
        const owner = activeSessionRegistry.lookupByPath(task.worktree);
        return owner != null && owner.taskId !== task.id;
      };
      /*
      FNXC:WorkflowColumns 2026-07-29-09:30 (Phase B): intake ROLE, not the literal
      "triage". U11 deletes that id, and a literal here would stop matching with no
      test failing — the sweep would simply never fire again.
      */
      const preWipCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const candidates = tasks.filter((task) =>
        task.status == null
        && !task.paused
        && !task.error
        && Boolean(task.worktree)
        && Boolean(task.workflowIrPinNodeId)
        && !executingIds.has(task.id)
        && !planningIds.has(task.id)
        && this.options.isTaskActive?.(task.id) !== true
        && this.options.getActiveMergeTaskId?.() !== task.id
        && !hasForeignPathOwner(task),
      );

      let recovered = 0;
      for (const snapshot of candidates) {
        const releaseReservation = this.options.reserveAdvancedTriageRecovery?.(snapshot.id);
        if (this.options.reserveAdvancedTriageRecovery && !releaseReservation) continue;
        try {
          const live = await this.store.getTask(snapshot.id);
          const liveColumns = await this.resolvePreWipColumns(live.id, preWipCache);
          if (
            live.column !== liveColumns.intake
            || live.status != null
            || live.paused
            || live.error
            || !live.worktree
            || !live.workflowIrPinNodeId
            || (this.options.getExecutingTaskIds?.() ?? new Set<string>()).has(live.id)
            || this.options.isTaskActive?.(live.id) === true
            || this.options.getActiveMergeTaskId?.() === live.id
            || hasForeignPathOwner(live)
          ) {
            continue;
          }

          // A prior aborted graph can leave its own registry claim behind after every
          // executable/planning/merge owner has gone away. The durable task row and the
          // liveness callbacks above prove that claim is stale; clear it so completed
          // recovery can reuse the preserved worktree instead of rejecting its own path.
          const pathOwner = activeSessionRegistry.lookupByPath(live.worktree);
          if (pathOwner?.taskId === live.id) {
            activeSessionRegistry.unregisterPath(live.worktree);
          }

          const steps = live.steps ?? [];
          const complete = steps.length > 0
            && steps.every((step) => step.status === "done" || step.status === "skipped");
          if (complete) {
            if (!this.options.recoverCompletedTask) continue;
            if (await this.options.recoverCompletedTask(live)) recovered++;
            continue;
          }

          const resumeColumn = live.workflowIrPinColumnId;
          if (!resumeColumn || resumeColumn === liveColumns.intake) continue;
          const moved = await this.store.moveTaskIf(live.id, resumeColumn, (current) =>
            current.column === liveColumns.intake
            && current.status == null
            && !current.paused
            && !current.error
            && current.worktree === live.worktree
            && current.workflowIrPinNodeId === live.workflowIrPinNodeId
            && current.workflowIrPinColumnId === resumeColumn
            && !(this.options.getExecutingTaskIds?.() ?? new Set<string>()).has(current.id)
            && !(this.options.getPlanningTaskIds?.() ?? new Set<string>()).has(current.id)
            && this.options.isTaskActive?.(current.id) !== true
            && this.options.getActiveMergeTaskId?.() !== current.id
            && !hasForeignPathOwner(current),
          {
            moveSource: "engine",
            workflowMoveSource: "self-healing-advanced-triage",
            workflowMoveMetadata: {
              reason: "graph-boundary-self-abort-recovery",
              pinnedNodeId: live.workflowIrPinNodeId,
            },
            recoveryRehome: true,
            bypassGuards: true,
            preserveProgress: true,
            preserveWorktree: true,
            preserveResumeState: true,
          });
          if (!moved.moved) continue;
          await this.store.logEntry(
            live.id,
            `Auto-recovered workflow task stranded in triage — resumed at pinned ${resumeColumn} column`,
          );
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to recover advanced triage task ${snapshot.id}: ${errorMessage}`);
        } finally {
          releaseReservation?.();
        }
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Advanced triage recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Clear stale transient merge statuses when no active merger owns the task.
   *
   * @returns Number of tasks unblocked by clearing stale status
   */
  async recoverStaleMergingStatus(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const minAgeMs = this.getStaleMergingStatusMinAgeMs();
      if (!Number.isFinite(minAgeMs) || minAgeMs <= 0) return 0;

      const now = Date.now();
      const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-first sweep):
      Clears a `merging`/`merging-pr` stamp left on a review card with no live merger behind it. The
      literal read meant that on a renamed board the stamp was never cleared, so the card read as
      mid-merge forever — and the merge-active stamp is what the merger and the dashboard Retry gate both
      consult, so the card could neither progress nor be retried by hand.

      The `task.column !== "in-review"` check was redundant while the query pinned the column; under a
      resolved read it becomes the per-card verdict, so it converts rather than being deleted.
      */
      const staleMergeReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const staleMergeById = new Map<string, Task>();
      for (const column of staleMergeReviewColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) staleMergeById.set(entry.id, entry);
      }
      const tasks = [...staleMergeById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const staleMergeLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          staleMergeLanes.set(
            entry.id,
            source === "default"
              ? new Set(staleMergeReviewColumns)
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          staleMergeLanes.set(entry.id, new Set(staleMergeReviewColumns));
        }
      }
      const stale = tasks.filter((task) => {
        if (!(staleMergeLanes.get(task.id) ?? staleMergeReviewColumns).has(task.column) || task.paused) return false;
        /*
        FNXC:MergeReliability 2026-07-15-21:45 (FN-8004 follow-up):
        Staleness now comes from the shared `isStaleMergeActiveStatus` leaf, which the dashboard's
        manual Retry gate also calls. Inlining the rule here is what let the manual path drift into
        refusing every merge-active status. Covers: merge-active stamp, no live in-process owner
        (reclaimed instead by recoverWedgedActiveMerge / recoverInterruptedMergingTasks via
        merger-silence clocks), and `updatedAt` untouched for minAgeMs.
        */
        return isStaleMergeActiveStatus(task, { activeMergeTaskId, nowMs: now, minAgeMs });
      });

      if (stale.length === 0) return 0;

      let recovered = 0;
      for (const task of stale) {
        const previousStatus = task.status;
        try {
          /*
          FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD1 — workspace-safe by construction):
          This reconciler makes NO single-commit assumption: it only clears the transient
          `merging`/`merging-pr` status (status:null) + clearMergeActive and never calls
          findLandedTaskCommit or moves the task. That is exactly the correct workspace action
          (clear the stale status so a re-land can be re-enqueued; the partial-land reconciler /
          recover-interrupted-merging owns the actual re-enqueue). So a workspace task is handled
          identically and safely here — no workspace-specific branch is needed.
          */
          log.warn(`Clearing stale merge status for ${task.id}: ${previousStatus}`);
          await this.store.updateTask(task.id, { status: null });
          this.options.clearMergeActive?.(task.id);
          await this.store.logEntry(
            task.id,
            `Auto-recovered: cleared stale '${previousStatus}' status (no active merger)`,
          );
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to clear stale merge status for ${task.id}: ${errorMessage}`);
        }
      }

      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Stale merging status recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /*
  FNXC:MergeQueue 2026-07-15-09:50:
  Reclaim the in-process single-flight merge owner when it is wedged with no merger agent progress. Covers:
  - status="reviewing" (AI merge review pass) that recoverStaleMergingStatus skipped because getActiveMergeTaskId still pointed at the owner
  - status already cleared/null while activeMergeTaskId + mergeRunning still hold the pump (board shows no merging badge, nothing starts)
  - overseer logEntry noise keeping updatedAt fresh so status-age gates never fire
  Uses merger agent-log silence (preferred) or active-merge claim wall clock — never updatedAt alone.
  */
  async recoverWedgedActiveMerge(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!timeoutMs || timeoutMs <= 0) return 0;

      const activeId = this.options.getActiveMergeTaskId?.() ?? null;
      if (!activeId) return 0;

      const task = await this.store.getTask(activeId).catch(() => null);
      const { wedged, silenceMs } = await this.isActiveMergeWedged(activeId, timeoutMs, task?.status ?? null);
      if (!wedged) {
        return 0;
      }

      if (task?.paused) {
        // Pause should already abort; if identity remains, force-clear the lane.
        const aborted = this.options.abortActiveMerge?.(activeId, "wedged-active-merge-while-paused") ?? false;
        if (aborted) {
          log.warn(`Force-aborted wedged active merge ${activeId} that remained after pause`);
          await this.emitWedgedActiveMergeAudit(activeId, {
            reason: "wedged-active-merge-while-paused",
            silenceMs,
            limitMs: timeoutMs,
            status: task.status ?? null,
          });
          return 1;
        }
        return 0;
      }

      // FNXC:WorkflowResolvedColumns 2026-07-30-22:25 (batch-engine): resolved review MEMBERSHIP, legacy id unioned in.
      const wedgedReviewColumns = task ? await this.resolveReviewColumnsFor(task.id, new Map()) : undefined;
      if (task && !wedgedReviewColumns!.has(task.column)) {
        const aborted = this.options.abortActiveMerge?.(activeId, "wedged-active-merge-left-in-review") ?? false;
        if (aborted) {
          log.warn(`Force-aborted wedged active merge ${activeId}: task column is ${task.column}`);
          await this.emitWedgedActiveMergeAudit(activeId, {
            reason: "wedged-active-merge-left-in-review",
            silenceMs,
            limitMs: timeoutMs,
            status: task.status ?? null,
            column: task.column,
          });
          return 1;
        }
        return 0;
      }

      log.warn(`Reclaiming wedged active merge ${activeId} (no merger agent progress past stuck timeout)`);
      this.options.abortActiveMerge?.(activeId, "wedged-active-merge-no-merger-progress");
      this.options.clearMergeActive?.(activeId);
      if (task) {
        if (task.status && ACTIVE_MERGE_STATUSES.has(task.status)) {
          await this.store.updateTask(activeId, { status: null, error: null }).catch(() => undefined);
        }
        await this.store
          .logEntry(
            activeId,
            "Auto-recovered: wedged active merge reclaimed after merger agent silence — merge will be retried",
          )
          .catch(() => undefined);
      }
      await this.emitWedgedActiveMergeAudit(activeId, {
        reason: "wedged-active-merge-no-merger-progress",
        silenceMs,
        limitMs: timeoutMs,
        status: task?.status ?? null,
      });
      if (task && allowsAutoMergeProcessing(task, settings) && !task.paused && wedgedReviewColumns!.has(task.column)) {
        try {
          this.options.enqueueMerge?.(activeId);
        } catch (enqueueErr: unknown) {
          log.warn(
            `Failed to re-enqueue ${activeId} after wedged-active-merge recovery: ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
          );
        }
      }
      return 1;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Wedged active merge recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  private async emitWedgedActiveMergeAudit(
    taskId: string,
    metadata: {
      reason: string;
      silenceMs: number | null;
      limitMs: number;
      status: string | null;
      column?: string;
    },
  ): Promise<void> {
    try {
      await this.store.recordRunAuditEvent({
        taskId,
        agentId: "self-healing",
        runId: generateSyntheticRunId("wedged-active-merge", taskId),
        domain: "database",
        // Ids/outcomes-only: reason enum-ish string, silence/limit counts, status — never prose/prompt.
        mutationType: "task:reconcile-wedged-active-merge",
        target: taskId,
        metadata: {
          taskId,
          reason: metadata.reason,
          silenceMs: metadata.silenceMs ?? undefined,
          limitMs: metadata.limitMs,
          status: metadata.status,
          column: metadata.column,
        },
      });
    } catch (err: unknown) {
      log.warn(
        `Failed to audit wedged active merge reclaim for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async reclaimPrConflicts(): Promise<number> {
    const tasks = await this.store.listTasks({ slim: true });
    const candidates = tasks.filter((task) => {
      const prList = task.prInfos ?? (task.prInfo ? [task.prInfo] : []);
      return prList.some((pr) => pr.mergeable === "conflicting");
    });
    let reclaimed = 0;
    for (const task of candidates) {
      const result = await this.reclaimPrConflictForTask(task.id);
      if (result.outcome !== "skipped") {
        reclaimed++;
      }
    }
    return reclaimed;
  }

  /**
   * Backward lifecycle move gated on triple proof (FN-5335).
   * When the predicate fails, emits `task:reclaim-pr-conflict-no-action` and skips lifecycle mutation.
   */
  async reclaimPrConflictForTask(taskId: string): Promise<{ outcome: "reclaimed" | "stale-resolved" | "tip-already-merged" | "paused-unrecoverable" | "skipped"; reason?: string; perPr?: Array<{ number: number; outcome: "reclaimed" | "stale-resolved" | "tip-already-merged" | "paused-unrecoverable" | "skipped"; reason?: string }> }> {
    const task = await this.store.getTask(taskId);
    if (!task) return { outcome: "skipped", reason: "task-not-found" };
    const conflictingPrs = (task.prInfos ?? (task.prInfo ? [task.prInfo] : [])).filter((pr) => pr.mergeable === "conflicting");
    if (conflictingPrs.length === 0) {
      return { outcome: "skipped", reason: "no-conflicting-pr" };
    }
    const withPerPr = (result: { outcome: "reclaimed" | "stale-resolved" | "tip-already-merged" | "paused-unrecoverable" | "skipped"; reason?: string }) => {
      if (conflictingPrs.length <= 1) {
        return result;
      }
      return {
        ...result,
        perPr: conflictingPrs.map((pr) => ({ number: pr.number, outcome: result.outcome, reason: result.reason })),
      };
    };

    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return withPerPr({ outcome: "skipped", reason: "engine-paused" });
    if (!task.branch || !task.worktree) return withPerPr({ outcome: "skipped", reason: "missing-branch-or-worktree" });
    if (task.userPaused) return withPerPr({ outcome: "skipped", reason: "user-paused" });
    if (task.checkedOutBy) return withPerPr({ outcome: "skipped", reason: "checked-out" });
    if (task.pausedReason === "worktrunk_operation_failed") return withPerPr({ outcome: "skipped", reason: "worktrunk-paused" });
    if (activeSessionRegistry.isPathActive(task.worktree)) return withPerPr({ outcome: "skipped", reason: "active-session" });
    if (!await isUsableTaskWorktree(this.options.rootDir, task.worktree)) return withPerPr({ outcome: "skipped", reason: "unusable-worktree" });

    try {
      const integrationBranch = await resolveIntegrationBranch(this.options.rootDir, settings);
      const inspection = await inspectBranchConflict({
        repoDir: this.options.rootDir,
        branchName: task.branch,
        conflictingWorktreePath: task.worktree,
        requestingTaskId: task.id,
        ownerTaskId: task.id,
        startPoint: task.baseCommitSha ?? task.mergeDetails?.mergeTargetBranch ?? integrationBranch,
        integrationRef: integrationBranch,
      });

      const auditor = createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal-pr-conflict", task.id),
        agentId: "self-healing",
        taskId: task.id,
        taskLineageId: task.lineageId,
        phase: "reclaim-pr-conflicts",
      });

      if (inspection.kind === "stale") {
        await auditor.database({ type: "task:pr-conflict-reclaim", target: task.id, metadata: { outcome: "skipped", reason: "stale" } });
        return withPerPr({ outcome: "skipped", reason: "stale" });
      }
      if (inspection.kind === "stale-resolved") {
        await this.store.updateTask(task.id, { worktree: null, branch: null, baseCommitSha: null });
        await auditor.database({ type: "task:pr-conflict-reclaim", target: task.id, metadata: { outcome: "stale-resolved" } });
        return withPerPr({ outcome: "stale-resolved" });
      }
      if (inspection.kind === "tip-already-merged") {
        await this.reclaimSelfOwnedBranchConflicts();
        await auditor.database({ type: "task:pr-conflict-reclaim", target: task.id, metadata: { outcome: "tip-already-merged" } });
        return withPerPr({ outcome: "tip-already-merged" });
      }
      if (inspection.kind === "live-foreign") {
        throw inspection.error;
      }

      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, thirty-second sweep):
      This read answers "is another LIVE task holding this worktree?" — the same question
      `findActiveWorktreeOwner` answers for the executor, and the same failure if it comes back empty: the
      checkout reads as unowned and this sweep reclaims a worktree another task is working in.

      No per-card lane verdict downstream: the map below is keyed by WORKTREE PATH, and nothing after it
      compares a column. So this is a read-only conversion — there is no pair to convert, which the
      derived ratchet from #2879 also confirms.
      */
      const prConflictWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const prConflictById = new Map<string, Task>();
      for (const column of prConflictWipColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) prConflictById.set(entry.id, entry);
      }
      const inProgressCandidates = [...prConflictById.values()];
      const inProgressByWorktree = new Map<string, string>();
      for (const inProgressTask of inProgressCandidates) {
        if (inProgressTask.worktree) inProgressByWorktree.set(inProgressTask.worktree, inProgressTask.id);
      }
      const wasPausedBranchConflict = task.paused === true && task.pausedReason === "branch-conflict-unrecoverable";
      if (inspection.kind === "fully-subsumed") {
        const taskIdUpper = task.id.toUpperCase();
        const branchOwnerTaskId = deriveTaskIdFromFusionBranch(task.branch);
        const activeOwner = inProgressByWorktree.get(inspection.livePath);
        const ownedByOtherInProgressTask = Boolean(activeOwner && activeOwner !== task.id);
        const canAutoReclaimLiveZero = branchOwnerTaskId !== null && branchOwnerTaskId === taskIdUpper && !ownedByOtherInProgressTask;
        if (canAutoReclaimLiveZero) {
          await removeWorktree({ rootDir: this.options.rootDir, worktreePath: inspection.livePath, settings, taskId: task.id, reason: RemovalReason.SelfHealingBranchConflict });
          await execAsync("git worktree prune", { cwd: this.options.rootDir, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
          await execAsync(`git branch -D ${JSON.stringify(task.branch)}`, { cwd: this.options.rootDir, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
          await this.store.updateTask(task.id, { worktree: null, branch: null, paused: false, pausedReason: undefined, status: null, error: null });
          await auditor.database({ type: "task:pr-conflict-reclaim", target: task.id, metadata: { outcome: "reclaimed", mode: "fully-subsumed", recoveredFromPaused: wasPausedBranchConflict } });
          return withPerPr({ outcome: "reclaimed" });
        }
      }

      // FNXC:WorkflowResolvedColumns 2026-07-30-22:25 (batch-engine): resolved review MEMBERSHIP, legacy id unioned in.
      if ((await this.resolveReviewColumnsFor(task.id, new Map())).has(task.column)) {
        const proof = await this.evaluateBackwardMoveTripleProof(task, {
          stage: "reclaim-pr-conflict",
          graceMs: settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
          stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
          reason: "reclaim-pr-conflict-candidate",
        });
        if (!proof.ok) {
          await this.emitBackwardMoveNoAction(task, "reclaim-pr-conflict", "task:reclaim-pr-conflict-no-action", proof);
          return withPerPr({ outcome: "skipped", reason: "triple-proof-not-satisfied" });
        } else {
          await this.store.updateTask(task.id, {
            worktree: inspection.livePath,
            branch: task.branch,
            paused: false,
            pausedReason: undefined,
            status: null,
            error: null,
          });
          await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), {
            moveSource: "engine",
            // #1411: backward recovery — skip order-derived adjacency.
            recoveryRehome: true,
            preserveWorktree: true,
            preserveProgress: true,
            preserveResumeState: true,
          });
        }
      } else {
        await this.store.updateTask(task.id, {
          worktree: inspection.livePath,
          branch: task.branch,
          paused: false,
          pausedReason: undefined,
          status: null,
          error: null,
        });
      }
      await auditor.database({ type: "task:pr-conflict-reclaim", target: task.id, metadata: { outcome: "reclaimed", mode: inspection.kind } });
      return withPerPr({ outcome: "reclaimed" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (await this.tryReanchorForeignOnlyContamination(task)) {
        return withPerPr({ outcome: "reclaimed" });
      }
      const patchPath = await preserveWorktreeChanges(this.options.rootDir, task.worktree, task.id);
      if (patchPath) {
        await this.store.logEntry(task.id, `Preserved uncommitted worktree changes before pause: ${patchPath}`);
      }
      const dispatcher = this.options.autoRecoveryDispatcher ?? new AutoRecoveryDispatcher({
        taskStore: this.store,
        auditEmitter: createRunAuditor(this.store, {
          runId: generateSyntheticRunId("self-heal", task.id),
          agentId: "self-healing",
          taskId: task.id,
          taskLineageId: task.lineageId,
          phase: "reclaim-pr-conflicts",
        }),
      });
      const decision = await dispatcher.dispatch({
        class: "branch-conflict-unrecoverable",
        taskId: task.id,
        pausedReason: "branch-conflict-unrecoverable",
        evidence: { branchName: task.branch, worktreePath: task.worktree },
      }, {
        task,
        retryCount: task.recoveryRetryCount ?? 0,
        settings: (await this.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
      });
      if (decision.action === "pause") {
        await this.store.updateTask(task.id, {
          status: "failed",
          error: `Task branch conflict: ${task.branch} is not safely reclaimable (${message})`,
          paused: true,
          pausedReason: "branch-conflict-unrecoverable",
        });
        await this.handoffTaskToReview(task.id, "branch-conflict-unrecoverable-repromote");
        await this.store.logEntry(task.id, `Auto-recovery failed: branch conflict unrecoverable — ${message}`);
      }
      return withPerPr({ outcome: "paused-unrecoverable", reason: message });
    }
  }

  /**
   * Last-resort recovery for self-owned task branches whose tip carries only
   * foreign commits (no own work). This is the FN-5432 / FN-5255 pattern:
   * the worktree pool created `fusion/fn-XXXX` from a stale HEAD that still
   * pointed at the previous occupant's tip, so the branch inherited another
   * task's commit. There is nothing to preserve — reanchor to base.
   *
   * Returns true when recovery succeeded (caller should treat as reclaimed
   * and skip the unrecoverable-pause path).
   */
  private async tryReanchorForeignOnlyContamination(
    task: Task,
  ): Promise<boolean> {
    if (!task.branch || !task.worktree) return false;
    try {
      const integrationBranch = await resolveIntegrationBranch(this.options.rootDir, undefined);
      const auditor = createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal", task.id),
        agentId: "self-healing",
        taskId: task.id,
        taskLineageId: task.lineageId,
        phase: "reanchor-foreign-only-contamination",
      });
      // recoverForeignOnlyContamination internally classifies and bails on
      // non-matching kinds, so we do not pre-classify here.
      const recovered = await recoverForeignOnlyContamination(task, {
        repoDir: this.options.rootDir,
        taskStore: this.store,
        runAudit: auditor,
        integrationBranch,
      });
      if (!recovered.recovered) return false;
      await this.store.logEntry(
        task.id,
        `Auto-reanchored ${task.branch} to base (foreign-only contamination, subtype=${recovered.subtype ?? "unknown"})`,
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.logEntry(task.id, `Foreign-only reanchor attempt failed: ${message}`).catch(() => undefined);
      return false;
    }
  }

  /**
   * STANDING: do not auto-discard stranded commits. Reclaim preserves commits;
   * unrecoverable conflicts are escalated for human review.
   *
   * Backward lifecycle move gated on triple proof (FN-5335).
   * When the predicate fails, emits `task:reclaim-self-owned-branch-conflict-no-action` and skips lifecycle mutation.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async reclaimSelfOwnedBranchConflicts(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twelfth sweep):
      Three lane reads AND three lane guards in the body, so both halves convert together — widening the
      read alone would admit renamed-board cards and then mis-decide every one of them (the phantom-binding
      check, the blocked-hold skip, and the review triple-proof are all keyed on lane).

      On a renamed board all three reads returned empty, so a task whose own worktree held its own branch
      hostage was never reclaimed and stayed wedged behind a conflict only this sweep resolves.
      */
      const reclaimHoldColumns = await resolveProjectColumnsForRoles(this.store, ["hold"]);
      const reclaimWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const reclaimReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      /*
      Buckets are built FROM THE READ that produced each row, not by re-deriving from `task.column`.
      A row returned by `listTasks({ column: X })` is by definition in X, so re-deriving adds nothing and
      would silently drop any row whose column field is absent.
      */
      const readBucket = async (columns: ReadonlySet<string>): Promise<Task[]> => {
        const byId = new Map<string, Task>();
        for (const column of columns) {
          for (const task of await this.store.listTasks({ column, slim: true })) byId.set(task.id, task);
        }
        return [...byId.values()];
      };
      const todoCandidates = await readBucket(reclaimHoldColumns);
      const inProgressCandidates = await readBucket(reclaimWipColumns);
      const inReviewPausedCandidates = (await readBucket(reclaimReviewColumns))
        .filter((task) => task.paused === true && task.pausedReason === "branch-conflict-unrecoverable");
      /*
      Per-card lanes, used by the three lane GUARDS below (phantom-binding, blocked-hold skip, review
      triple-proof). Legacy ids unioned so a degraded or mid-rename board still decides correctly.
      */
      const reclaimLanes = new Map<string, { hold: Set<string>; wip: Set<string>; review: Set<string> }>();
      const unresolvedReclaimCards: string[] = [];
      for (const task of [...todoCandidates, ...inProgressCandidates, ...inReviewPausedCandidates]) {
        if (reclaimLanes.has(task.id)) continue;
        const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id);
        if (source === "default") unresolvedReclaimCards.push(task.id);
        const lanes = {
          hold: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.hold ?? []),
          wip: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.countsTowardWip ?? []),
          review: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.mergeOrchestration ?? []),
        };
        for (const id of columnsWithFlag(ir, "hold")) lanes.hold.add(id);
        for (const id of columnsWithFlag(ir, "countsTowardWip")) lanes.wip.add(id);
        for (const role of REVIEW_ROLES) for (const id of columnsWithFlag(ir, role)) lanes.review.add(id);
        reclaimLanes.set(task.id, lanes);
      }
      if (unresolvedReclaimCards.length > 0) {
        log.warn(
          `self-owned branch reclaim: ${unresolvedReclaimCards.length} card(s) decided against the built-in workflow (${unresolvedReclaimCards.slice(0, 5).join(", ")})`,
        );
      }
      const lanesOfReclaim = (id: string) => reclaimLanes.get(id) ?? {
        hold: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.hold ?? []),
        wip: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.countsTowardWip ?? []),
        review: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.mergeOrchestration ?? []),
      };
      const inProgressByWorktree = new Map<string, string>();
      for (const inProgressTask of inProgressCandidates) {
        if (inProgressTask.worktree) {
          inProgressByWorktree.set(inProgressTask.worktree, inProgressTask.id);
        }
      }
      // Per-task auto-merge gating applies to ALL candidate columns, not just
      // in-review: the FN-5704 regression contract ("short-circuits reclaim
      // when autoMerge is false") deliberately keeps execution-stage reclaim
      // and resume-limbo escalation inert in manual-review projects. The
      // per-task override preserves that for override-less tasks while letting
      // explicit autoMerge:true tasks recover.
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (#2879 review — greptile, "multi-role tasks run
      recovery twice"): DEDUPED ACROSS THE BUCKETS, NOT JUST WITHIN EACH.

      `readBucket` dedupes by id, but only inside one role's read. A custom workflow may put more than
      one queried flag on ONE column — `hold` plus `countsTowardWip` on a lane that both parks and
      counts as work, or a review role beside either — and that column is then returned by two reads.
      The task lands in two buckets, and the concatenation below hands the recovery loop the SAME
      STALE SNAPSHOT twice.

      That is not a wasted iteration: the second pass re-reads `task.branch`/`task.worktree` from a
      snapshot taken before the first pass mutated anything, so a worktree the first pass reclaimed is
      reclaimed again against state that no longer exists. The lane-resolution loop above already
      guards with `reclaimLanes.has(task.id)`; this is the same guard the consumption side was missing.

      Deduping by id preserves iteration order, and the FIRST bucket's snapshot is the one kept. Spelled
      out with an explicit `has` guard rather than `new Map(entries)`: that constructor keeps first
      INSERTION ORDER but the LAST value for a repeated key, so it would have silently given last-bucket
      precedence while this comment claimed the opposite.
      */
      const reclaimCandidateById = new Map<string, Task>();
      for (const task of [...todoCandidates, ...inProgressCandidates, ...inReviewPausedCandidates]) {
        if (!reclaimCandidateById.has(task.id)) reclaimCandidateById.set(task.id, task);
      }
      const candidates = [...reclaimCandidateById.values()]
        .filter((task) => allowsAutoMergeProcessing(task, settings));
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const activeTaskIds = await this.listActiveHeartbeatTaskIds();

      let recovered = 0;
      const integrationBranch = await resolveIntegrationBranch(this.options.rootDir, settings);
      for (const task of candidates) {
        if (!task.branch || !task.worktree) continue;
        if (task.userPaused) continue;
        const liveExecutionSignal = this.getFalsePositiveRequeueSignal(task, {
          executingIds,
          activeHeartbeatTaskIds: activeTaskIds,
          graceMs: STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
          includeLiveWorktreeBoundBranch: false,
          includeCheckedOutLease: true,
        });
        if (liveExecutionSignal) {
          const canEvaluatePhantomBinding = lanesOfReclaim(task.id).wip.has(task.column)
            && (liveExecutionSignal.reason === "executor-active" || liveExecutionSignal.reason === "live-worktree-and-branch");
          if (canEvaluatePhantomBinding) {
            const nowMs = Date.now();
            const executionStartedAtMs = task.executionStartedAt ? Date.parse(task.executionStartedAt) : Number.NaN;
            const executionAgeMs = Number.isFinite(executionStartedAtMs) ? Math.max(0, nowMs - executionStartedAtMs) : null;
            const lastActivityMs = await this.getRecentRunAuditActivityAgeMs(task, nowMs);
            const phantomBinding = this.isPhantomExecutorBinding(task, {
              executionAgeMs,
              graceMs: STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
              activeHeartbeatTaskIds: activeTaskIds,
              wipColumns: lanesOfReclaim(task.id).wip,
              lastActivityMs,
            });

            /*
            FNXC:SelfHealingReclaim 2026-06-19-00:00:
            FN-6736 makes the executor-active veto conditional for in-progress tasks whose worktree still exists: if age is far beyond grace and checkout, heartbeat, and run-audit liveness are all absent, clear only the stale in-memory binding and requeue with worktree/progress intact instead of emitting the permanent no-action wedge. Live FN-4811 owners still reach the normal no-action veto, missing worktrees remain FN-5219, and resume-limbo escalation remains FN-5704-owned.
            */
            if (phantomBinding.phantom) {
              // FNXC:SelfHealingReclaim 2026-06-30-00:00: preserveWorktrees keeps the held worktree's
              // session-registry entry so the moveTask(preserveWorktree:true) re-dispatch reattaches to
              // the same worktree instead of orphaning it and acquiring a new one (FN-7249 regression).
              // FNXC:SelfHealingReclaim 2026-07-05-08:15: FN-7566 — honor clearPhantomExecutorBinding's
              // live-session refusal (returns false when any session surface is still registered) as the
              // last line of defense before the destructive moveTask(→todo), matching reapLeakedConcurrencySlots.
              // Even if a future liveness signal slips past isPhantomExecutorBinding, a refused clear must NOT
              // be followed by a hard-cancel of a live executor: fall through to the no-action audit instead.
              const released = this.options.clearPhantomExecutorBinding?.(task.id, { preserveWorktrees: true });
              if (released === false) {
                await this.emitFalsePositiveRequeueNoAction(
                  task,
                  "reclaim-self-owned-branch-conflict",
                  "task:reclaim-self-owned-branch-conflict-no-action",
                  "phantom-clear-refused-live-session",
                  { ...phantomBinding.metadata, signalReason: liveExecutionSignal.reason },
                );
                continue;
              }
              await createRunAuditor(this.store, {
                runId: generateSyntheticRunId("self-healing-phantom-executor-binding", task.id),
                agentId: "self-healing",
                taskId: task.id,
                taskLineageId: task.lineageId,
                phase: "reclaim-self-owned-branch-conflict",
              }).database({
                type: "task:reclaim-phantom-executor-binding",
                target: task.id,
                metadata: {
                  ...phantomBinding.metadata,
                  signalReason: liveExecutionSignal.reason,
                },
              });
              await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), {
                moveSource: "engine",
                recoveryRehome: true,
                preserveProgress: true,
                preserveWorktree: true,
              });
              recovered++;
              continue;
            }
          }

          await this.emitFalsePositiveRequeueNoAction(
            task,
            "reclaim-self-owned-branch-conflict",
            "task:reclaim-self-owned-branch-conflict-no-action",
            liveExecutionSignal.reason,
            liveExecutionSignal.metadata,
          );
          continue;
        }
        if (lanesOfReclaim(task.id).hold.has(task.column) && task.blockedBy) {
          log.debug(`[self-healing] skipping blocked todo task ${task.id} during self-owned branch reclaim (blockedBy=${task.blockedBy})`);
          continue;
        }
        if (task.pausedReason === "worktrunk_operation_failed") {
          log.debug(`[self-healing] skipping worktrunk-paused task ${task.id}`);
          continue;
        }
        // FN-4811 follow-up (FN-4819): defer reclaim when the worktree is currently bound
        // to a live executor/merger/step session. Without this, the sweep tries to
        // `removeWorktree` and trips the active-session gate, which throws, which the outer
        // catch escalates to AutoRecoveryDispatcher with class "branch-conflict-unrecoverable".
        // That escalation marks the task `failed + paused`, even though the active session
        // is making real progress. The right behavior is to skip this task this sweep and
        // let the session complete — the reclaim will retry on a later sweep when no one
        // is using the worktree.
        if (activeSessionRegistry.isPathActive(task.worktree)) {
          log.debug(`[self-healing] deferring reclaim for ${task.id}: worktree ${task.worktree} has active session`);
          continue;
        }
        if (!await isUsableTaskWorktree(this.options.rootDir, task.worktree)) continue;

        const reviewProof = lanesOfReclaim(task.id).review.has(task.column)
          ? await this.evaluateBackwardMoveTripleProof(task, {
            stage: "reclaim-self-owned-branch-conflict",
            graceMs: settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
            stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
            reason: "reclaim-self-owned-candidate",
          })
          : null;

        try {
          const inspection = await inspectBranchConflict({
            repoDir: this.options.rootDir,
            branchName: task.branch,
            conflictingWorktreePath: task.worktree,
            requestingTaskId: task.id,
            ownerTaskId: task.id,
            startPoint: task.baseCommitSha ?? task.mergeDetails?.mergeTargetBranch ?? integrationBranch,
            integrationRef: integrationBranch,
          });

          if (inspection.kind === "stale") {
            continue;
          }
          if (inspection.kind === "stale-resolved") {
            await this.store.updateTask(task.id, {
              worktree: null,
              branch: null,
              baseCommitSha: null,
            });
            await this.store.logEntry(
              task.id,
              `[recovery] cache-invalidate ${task.id} branch=${task.branch ?? "?"} reason=stale-resolved-no-live-ref-or-mapping`,
            );
            continue;
          }
          if (inspection.kind === "tip-already-merged") {
            const branchName = task.branch;
            const ownership = await this.readCommitTaskOwnership(inspection.tipSha, task.id, task.lineageId).catch(async () => {
              await this.rejectForeignAlreadyMergedCandidate({
                task,
                candidateSha: inspection.tipSha,
                candidateOwner: undefined,
                taskBranch: branchName,
                baseBranch: inspection.integrationRef,
                reason: "ownership-unverifiable",
                phase: "tip-already-merged",
              });
              return null;
            });
            if (!ownership) {
              continue;
            }
            /*
            FNXC:SelfHealingReclaim 2026-07-25-09:40:
            The foreign-trailer veto here must use the same merge-base diff proof as already-merged and branch-misbound
            recovery. A `tip-already-merged` verdict means the tip is an ancestor of the integration ref, which is the
            normal shape of a task branch that was cut from the base and never committed anything: its inherited tip is
            the PREVIOUS task's landed commit. Vetoing on the trailer alone left that row holding stale
            worktree/branch/baseCommitSha metadata and re-logged `reason=foreign-task-tip` on every sweep (FN-1406,
            inheriting FN-1401's tip). `foreignTipRejection` only rejects when the branch has unique content, or when
            the base already carries this task's own commit (real misbinding); otherwise fall through to the stale-cached
            -metadata reclaim below, which is safe precisely because the branch contains nothing unique to lose.
            */
            const foreignRejection = await this.foreignTipRejection({
              taskId: task.id,
              lineageId: task.lineageId,
              branchTip: inspection.tipSha,
              baseBranch: inspection.integrationRef,
              ownership,
            });
            if (foreignRejection) {
              await this.rejectForeignAlreadyMergedCandidate({
                task,
                candidateSha: inspection.tipSha,
                candidateOwner: foreignRejection.owner,
                taskBranch: branchName,
                baseBranch: inspection.integrationRef,
                reason: foreignRejection.reason,
                phase: "tip-already-merged",
              });
              continue;
            }
            let reclaimedCleanly = false;
            try {
              if (inspection.livePath && existsSync(inspection.livePath)) {
                await removeWorktree({
                  rootDir: this.options.rootDir,
                  worktreePath: inspection.livePath,
                  settings,
                  taskId: task.id,
                  reason: RemovalReason.SelfHealingBranchConflict,
                });
              }
              // Branch-level reclaim remains active in worktrunk mode; this is
              // idempotent git metadata cleanup, not layout ownership.
              // FN-4742: keep native prune; see WorktreeBackend.prune docs
              await execAsync("git worktree prune", {
                cwd: this.options.rootDir,
                timeout: 120_000,
                maxBuffer: 10 * 1024 * 1024,
              });
              await execAsync(`git branch -D ${JSON.stringify(branchName)}`, {
                cwd: this.options.rootDir,
                timeout: 120_000,
                maxBuffer: 10 * 1024 * 1024,
              });

              await this.store.updateTask(task.id, {
                worktree: null,
                branch: null,
                baseCommitSha: null,
                paused: false,
                pausedReason: undefined,
                status: null,
                error: null,
              });
              await this.store.logEntry(
                task.id,
                `[recovery] tip-already-merged ${task.id} branch=${branchName} tip=${inspection.tipSha.slice(0, 12)} integrationRef=${inspection.integrationRef} reason=stale-cached-metadata-ghost-conflict`,
              );

              /*
              FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (SELF-AUDIT after #2916 found the same class):
              These loop-body lane guards were MISSED when I converted this sweep's read. That is not a
              cosmetic gap: this one decides whether the backward move needs `reviewProof`. Left literal,
              a renamed review card admitted by the widened read reads as NOT-in-review, so the
              triple-proof gate is skipped entirely and the card is moved back without it — a safety
              check silently bypassed BY the conversion.
              */
              if (lanesOfReclaim(task.id).review.has(task.column)) {
                if (!reviewProof?.ok) {
                  await this.emitBackwardMoveNoAction(task, "reclaim-self-owned-branch-conflict", "task:reclaim-self-owned-branch-conflict-no-action", reviewProof!);
                } else {
                  await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), {
                    moveSource: "engine",
                    // #1411: backward recovery — skip order-derived adjacency.
                    recoveryRehome: true,
                    preserveProgress: true,
                    preserveResumeState: true,
                  });
                }
              }

              try {
                const auditor = createRunAuditor(this.store, {
                  runId: generateSyntheticRunId("self-heal", task.id),
                  agentId: "self-healing",
                  taskId: task.id,
                  taskLineageId: task.lineageId,
                  phase: "tip-already-merged",
                });
                await auditor.git({
                  type: "branch:auto-reclaim",
                  target: branchName,
                  metadata: {
                    taskId: task.id,
                    branch: branchName,
                    worktreePath: inspection.livePath,
                    existingTipSha: inspection.tipSha,
                    integrationRef: inspection.integrationRef,
                    trigger: "self-healing-sweep-ghost-conflict",
                  },
                });
              } catch (auditErr: unknown) {
                log.warn(`Failed to write tip-already-merged run-audit event for ${task.id}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
              }

              recovered++;
              reclaimedCleanly = true;
            } catch (tipMergedErr: unknown) {
              const message = tipMergedErr instanceof Error ? tipMergedErr.message : String(tipMergedErr);
              await this.store.logEntry(task.id, `Auto-recovery warning: tip-already-merged cleanup failed — ${message}`);
              log.warn(`Failed tip-already-merged cleanup for ${task.id}: ${message}`);
            }

            if (reclaimedCleanly) {
              continue;
            }
            throw new Error(`tip-already-merged cleanup failed for ${task.id}`);
          }
          if (inspection.kind === "live-foreign") {
            throw inspection.error;
          }

          const wasPausedBranchConflict = task.paused === true && task.pausedReason === "branch-conflict-unrecoverable";

          if (inspection.kind === "fully-subsumed") {
            const taskIdUpper = task.id.toUpperCase();
            const branchOwnerTaskId = deriveTaskIdFromFusionBranch(task.branch);
            const activeOwner = inProgressByWorktree.get(inspection.livePath);
            const ownedByOtherInProgressTask = Boolean(activeOwner && activeOwner !== task.id);
            const canAutoReclaimLiveZero =
              branchOwnerTaskId !== null &&
              branchOwnerTaskId === taskIdUpper &&
              !activeTaskIds.has(taskIdUpper) &&
              !ownedByOtherInProgressTask;

            if (canAutoReclaimLiveZero) {
              let reclaimedCleanly = false;
              try {
                await removeWorktree({
                  rootDir: this.options.rootDir,
                  worktreePath: inspection.livePath,
                  settings,
                  taskId: task.id,
                  reason: RemovalReason.SelfHealingBranchConflict,
                });
                // Branch-level reclaim remains active in worktrunk mode; this is
                // idempotent git metadata cleanup, not layout ownership.
                // FN-4742: keep native prune; see WorktreeBackend.prune docs
                await execAsync("git worktree prune", {
                  cwd: this.options.rootDir,
                  timeout: 120_000,
                  maxBuffer: 10 * 1024 * 1024,
                });
                await execAsync(`git branch -D ${JSON.stringify(task.branch)}`, {
                  cwd: this.options.rootDir,
                  timeout: 120_000,
                  maxBuffer: 10 * 1024 * 1024,
                });

                await this.store.updateTask(task.id, {
                  worktree: null,
                  branch: null,
                  paused: false,
                  pausedReason: undefined,
                  status: null,
                  error: null,
                });
                await this.store.logEntry(
                  task.id,
                  `[recovery] reclaim-live-zero-commits ${task.id} branch=${task.branch} worktree=${inspection.livePath} tip=${inspection.tipSha.slice(0, 12)} reason=zero-unique-commits-vs-main`,
                );

                if (lanesOfReclaim(task.id).review.has(task.column)) {
                  if (!reviewProof?.ok) {
                    await this.emitBackwardMoveNoAction(task, "reclaim-self-owned-branch-conflict", "task:reclaim-self-owned-branch-conflict-no-action", reviewProof!);
                  } else {
                    await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), {
                      moveSource: "engine",
                      // #1411: backward recovery — skip order-derived adjacency.
                      recoveryRehome: true,
                      preserveProgress: true,
                      preserveResumeState: true,
                    });
                  }
                }

                try {
                  const auditor = createRunAuditor(this.store, {
                    runId: generateSyntheticRunId("self-heal", task.id),
                    agentId: "self-healing",
                    taskId: task.id,
                    taskLineageId: task.lineageId,
                    phase: "reclaim-live-zero-commits",
                  });
                  await auditor.git({
                    type: "branch:auto-reclaim",
                    target: task.branch,
                    metadata: {
                      taskId: task.id,
                      branch: task.branch,
                      worktreePath: inspection.livePath,
                      existingTipSha: inspection.tipSha,
                      strandedCommitCount: 0,
                      subsumed: true,
                      recoveredFromPaused: wasPausedBranchConflict,
                      previousPausedReason: wasPausedBranchConflict ? task.pausedReason : null,
                      trigger: "self-healing-sweep-live-zero",
                    },
                  });
                } catch (auditErr: unknown) {
                  log.warn(`Failed to write branch:auto-reclaim run-audit event for ${task.id}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
                }

                recovered++;
                reclaimedCleanly = true;
              } catch (reclaimErr: unknown) {
                const reclaimMessage = reclaimErr instanceof Error ? reclaimErr.message : String(reclaimErr);
                await this.store.logEntry(task.id, `Auto-recovery warning: reclaim-live-zero-commits failed — ${reclaimMessage}`);
                log.warn(`Failed reclaim-live-zero-commits for ${task.id}: ${reclaimMessage}`);
              }

              if (reclaimedCleanly) {
                continue;
              }
            }
          }

          const preservedCommitCount = inspection.kind === "fully-subsumed"
            ? 0
            : inspection.taskAttributedCommitCount;
          const placement = await relocateReclaimableWorktreeIntoRoot({
            rootDir: this.options.rootDir,
            sourcePath: inspection.livePath,
            targetPath: preservedWorktreeTargetPathForTask(task.id, inspection.livePath, settings, this.options.rootDir),
            taskId: task.id,
            settings,
            isPathActive: (path) =>
              activeSessionRegistry.isPathActive(path)
              || executingTaskLock.has(task.id)
              || executingIds.has(task.id)
              || activeTaskIds.has(task.id.toUpperCase()),
          });
          if (placement.kind === "deferred-live") {
            await this.store.logEntry(
              task.id,
              `[recovery] deferred relocation of active preserved worktree ${placement.path}`,
            );
            continue;
          }
          const reclaimedWorktreePath = placement.path;
          if (placement.relocated) {
            await this.store.logEntry(
              task.id,
              `[recovery] relocated preserved worktree from ${inspection.livePath} to ${reclaimedWorktreePath}`,
            );
          }
          const stepSignature = buildResumeLimboStepSignature(task);
          const hasActiveSessionSignal = Boolean(task.checkedOutBy) || activeTaskIds.has(task.id.toUpperCase());
          const hasPriorSnapshot = typeof task.resumeLimboTipSha === "string" && typeof task.resumeLimboStepSignature === "string";
          const unchangedSincePriorResume = hasPriorSnapshot
            && task.resumeLimboTipSha === inspection.tipSha
            && task.resumeLimboStepSignature === stepSignature;
          const isNoProgressResume = lanesOfReclaim(task.id).wip.has(task.column)
            && unchangedSincePriorResume
            && !hasActiveSessionSignal;
          const resumeAttemptCount = isNoProgressResume ? (task.resumeLimboCount ?? 0) + 1 : 0;

          if (lanesOfReclaim(task.id).wip.has(task.column) && isNoProgressResume && resumeAttemptCount >= MAX_NO_PROGRESS_RESUME_ATTEMPTS) {
            const idleAnchor = task.executionStartedAt ?? task.columnMovedAt ?? task.updatedAt;
            const idleAnchorMs = Date.parse(idleAnchor ?? "");
            const idleMs = Number.isFinite(idleAnchorMs) ? Math.max(0, Date.now() - idleAnchorMs) : null;
            await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), {
              moveSource: "engine",
              // #1411: backward recovery — skip order-derived adjacency.
              recoveryRehome: true,
              preserveWorktree: true,
              preserveProgress: true,
              preserveResumeState: true,
            });
            await this.store.updateTask(task.id, {
              ...(placement.relocated ? { worktree: reclaimedWorktreePath } : {}),
              resumeLimboCount: 0,
              resumeLimboTipSha: inspection.tipSha,
              resumeLimboStepSignature: stepSignature,
            });
            await this.store.logEntry(
              task.id,
              `[recovery] resume-limbo-escalated ${task.id} moved to todo after ${resumeAttemptCount} no-progress reclaim/resume attempts`,
              JSON.stringify({
                frozenTipSha: inspection.tipSha,
                idleMs,
                resumeAttemptCount,
                currentStep: task.currentStep ?? null,
              }),
            );
            try {
              await createRunAuditor(this.store, {
                runId: generateSyntheticRunId("self-heal", task.id),
                agentId: "self-healing",
                taskId: task.id,
                taskLineageId: task.lineageId,
                phase: "reclaim-self-owned-branch-conflicts",
              }).database({
                type: "task:resume-limbo-escalated",
                target: task.id,
                metadata: {
                  taskId: task.id,
                  frozenTipSha: inspection.tipSha,
                  idleMs,
                  resumeAttemptCount,
                  currentStep: task.currentStep ?? null,
                },
              });
            } catch (auditErr: unknown) {
              log.warn(`Failed to write task:resume-limbo-escalated run-audit event for ${task.id}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
            }
            recovered++;
            continue;
          }

          await this.store.updateTask(task.id, {
            worktree: reclaimedWorktreePath,
            branch: task.branch,
            paused: false,
            pausedReason: undefined,
            status: null,
            error: null,
            resumeLimboCount: resumeAttemptCount,
            resumeLimboTipSha: inspection.tipSha,
            resumeLimboStepSignature: stepSignature,
          });
          await this.store.logEntry(
            task.id,
            `[recovery] ${wasPausedBranchConflict ? "reclaim-paused-review" : "reclaim-self-owned"} ${task.id} at ${reclaimedWorktreePath} (${preservedCommitCount} commits preserved, tip ${inspection.tipSha.slice(0, 12)})`,
          );

          if (lanesOfReclaim(task.id).review.has(task.column)) {
            if (!reviewProof?.ok) {
              await this.emitBackwardMoveNoAction(task, "reclaim-self-owned-branch-conflict", "task:reclaim-self-owned-branch-conflict-no-action", reviewProof!);
            } else {
              await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), {
                moveSource: "engine",
                // #1411: backward recovery — skip order-derived adjacency.
                recoveryRehome: true,
                preserveWorktree: true,
                preserveProgress: true,
                preserveResumeState: true,
              });
            }
          }

          try {
            const auditor = createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: wasPausedBranchConflict ? "reclaim-paused-review" : "reclaim-self-owned-branch-conflicts",
            });
            await auditor.git({
              type: "branch:auto-reclaim",
              target: task.branch,
              metadata: {
                taskId: task.id,
                branch: task.branch,
                worktreePath: reclaimedWorktreePath,
                existingTipSha: inspection.tipSha,
                strandedCommitCount: inspection.kind === "fully-subsumed" ? 0 : inspection.strandedCommits.length,
                subsumed: inspection.kind === "fully-subsumed",
                recoveredFromPaused: wasPausedBranchConflict,
                previousPausedReason: wasPausedBranchConflict ? task.pausedReason : null,
                trigger: "self-healing-sweep",
              },
            });
          } catch (auditErr: unknown) {
            log.warn(`Failed to write branch:auto-reclaim run-audit event for ${task.id}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
          }

          recovered++;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (await this.tryReanchorForeignOnlyContamination(task)) {
            recovered++;
            continue;
          }
          const patchPath = await preserveWorktreeChanges(this.options.rootDir, task.worktree, task.id);
          if (patchPath) {
            await this.store.logEntry(task.id, `Preserved uncommitted worktree changes before pause: ${patchPath}`);
          }
          const dispatcher = this.options.autoRecoveryDispatcher ?? new AutoRecoveryDispatcher({
            taskStore: this.store,
            auditEmitter: createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "reclaim-self-owned-branch-conflicts",
            }),
          });
          const decision = await dispatcher.dispatch({
            class: "branch-conflict-unrecoverable",
            taskId: task.id,
            pausedReason: "branch-conflict-unrecoverable",
            evidence: {
              branchName: task.branch,
              worktreePath: task.worktree,
            },
          }, {
            task,
            retryCount: task.recoveryRetryCount ?? 0,
            settings: (await this.store.getSettings()).autoRecovery ?? { mode: "deterministic-only", maxRetries: 3 },
          });
          if (decision.action === "pause") {
            await this.store.updateTask(task.id, {
              status: "failed",
              error: `Task branch conflict: ${task.branch} is not safely reclaimable (${message})`,
              paused: true,
              pausedReason: "branch-conflict-unrecoverable",
            });
            await this.handoffTaskToReview(task.id, "branch-conflict-unrecoverable-repromote");
            await this.store.logEntry(task.id, `Auto-recovery failed: branch conflict unrecoverable — ${message}`);
          }
        }
      }

      if (recovered > 0) {
        log.log(`Reclaimed ${recovered} self-owned branch conflict task(s)`);
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Self-owned branch conflict reclaim sweep failed: ${errorMessage}`);
      return 0;
    }
  }

  private async inspectOrphanedBranch(branch: string): Promise<{ tipSha: string; uniqueCommitCount: number } | null> {
    try {
      const tipSha = String(execSync(`git rev-parse --verify ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })).trim();
      if (!tipSha) return null;
      const uniqueCommitCount = Number.parseInt(String(execSync(`git rev-list --count ${shellQuote(branch)} --not ${shellQuote("main")}`, {
        cwd: this.options.rootDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })).trim(), 10) || 0;
      return { tipSha, uniqueCommitCount };
    } catch (err: unknown) {
      log.warn(`Failed to inspect branch ${branch} during stale-active reclaim: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async reclaimStaleActiveBranches(): Promise<number> {
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-22:30 (self-healing cluster): an archived card must not have its branch reclaimed, whatever that lane is named. Keyed on the literal this sweep answered "no" for every card on a renamed board.

    FNXC:StaleActiveBranchDoneSpam 2026-08-03-01:47:
    Complete-lane cards used to hit the unique-commit rescue-needed warn every maintenance sweep after squash/AI merge (feature tip SHAs are not ancestors of main). That spam was not actionable — the work already landed — and left local fusion/* refs forever. Resolve complete columns and force-delete their stale branches once the no-worktree / no-session gates pass; keep rescue-needed only for non-terminal columns where unique commits may still be real unmerged work. Archived still skips entirely (archive cleanup owns those refs).
    */
    const reclaimArchivedColumns = await resolveProjectColumnsForRoles(this.store, ["archived"]);
    const reclaimCompleteColumns = await resolveProjectColumnsForRoles(this.store, ["complete"]);
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const activeTaskIds = new Set<string>();
      if (this.options.agentStore) {
        try {
          const activeRuns = await this.options.agentStore.listActiveHeartbeatRuns();
          const activeWindowMs = RUNNING_ON_INACTIVE_TASK_STALE_RUN_MS;
          const now = Date.now();
          for (const run of activeRuns) {
            const startedAtMs = Date.parse(run.startedAt ?? "");
            if (!Number.isFinite(startedAtMs) || now - startedAtMs > activeWindowMs) continue;
            const taskId = run.contextSnapshot && typeof run.contextSnapshot.taskId === "string"
              ? run.contextSnapshot.taskId.toUpperCase()
              : null;
            if (taskId) activeTaskIds.add(taskId);
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`Unable to enumerate active heartbeat runs for stale-active branch reclaim sweep: ${message}`);
        }
      }

      const branchesRaw = String(execSync("git branch --list 'fusion/*'", {
        cwd: this.options.rootDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }) || "");
      const branches = branchesRaw
        .split("\n")
        .map((line) => line.replace(/^\*\s*/, "").trim())
        .filter(Boolean);
      if (branches.length === 0) return 0;

      const tasks = await this.store.listTasks({ slim: true, includeArchived: true });
      const taskById = new Map(tasks.map((task) => [task.id.toUpperCase(), task]));

      let reclaimed = 0;
      for (const branch of branches) {
        const derivedTaskId = deriveTaskIdFromFusionBranch(branch);
        if (!derivedTaskId) continue;

        const task = taskById.get(derivedTaskId.toUpperCase());
        if (!task || reclaimArchivedColumns.has(task.column) || task.checkedOutBy || task.userPaused) continue;
        if (task.pausedReason === "worktrunk_operation_failed") {
          log.debug(`[self-healing] skipping worktrunk-paused task ${task.id}`);
          continue;
        }
        if (activeTaskIds.has(task.id.toUpperCase())) continue;

        const emitDeferredReclaimAudit = async (reason: "active-session" | "recent-execution-started" | "worktree-has-uncommitted-changes", hasActiveSession: boolean, hasUncommittedChanges: boolean): Promise<void> => {
          log.debug(`[self-healing] deferring stale-active-branch reclaim for ${task.id}: reason=${reason}`);
          try {
            const auditor = createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "reclaim-stale-active-branches",
            });
            await auditor.git({
              type: "branch:stale-active-reclaim-deferred",
              target: branch,
              metadata: {
                taskId: task.id,
                branch,
                reason,
                executionStartedAt: task.executionStartedAt ?? null,
                hasActiveSession,
                hasUncommittedChanges,
              },
            });
          } catch (auditErr: unknown) {
            log.warn(`Failed to write branch:stale-active-reclaim-deferred run-audit event for ${task.id}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
          }
        };

        const hasActiveSession = Boolean(task.worktree && activeSessionRegistry.isPathActive(task.worktree));
        if (hasActiveSession) {
          await emitDeferredReclaimAudit("active-session", true, false);
          continue;
        }

        const executionStartedAtMs = task.executionStartedAt ? Date.parse(task.executionStartedAt) : Number.NaN;
        const isRecentlyStarted = Number.isFinite(executionStartedAtMs) && Date.now() - executionStartedAtMs <= STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS;
        if (isRecentlyStarted) {
          await emitDeferredReclaimAudit("recent-execution-started", false, false);
          continue;
        }

        if (task.worktree && existsSync(task.worktree)) {
          try {
            if (statSync(task.worktree).isDirectory()) {
              const { stdout } = await execAsync(`git -C ${JSON.stringify(task.worktree)} status --porcelain`, {
                cwd: this.options.rootDir,
                timeout: 30_000,
                maxBuffer: 10 * 1024 * 1024,
              });
              if ((stdout ?? "").trim().length > 0) {
                await emitDeferredReclaimAudit("worktree-has-uncommitted-changes", false, true);
                continue;
              }
            }
          } catch (statusErr: unknown) {
            log.warn(`[self-healing] stale-active-branch reclaim could not determine worktree status for ${task.id}: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`);
          }
        }

        if (task.worktree && await isUsableTaskWorktree(this.options.rootDir, task.worktree)) continue;

        const inspection = await this.inspectOrphanedBranch(branch);
        if (!inspection) continue;

        const isCompleteColumn = reclaimCompleteColumns.has(task.column);
        if (inspection.uniqueCommitCount > 0 && !isCompleteColumn) {
          log.warn(`[recovery] stale-active-branch-rescue-needed ${task.id} branch=${branch} unique=${inspection.uniqueCommitCount} tip=${inspection.tipSha.slice(0, 12)}`);
          continue;
        }

        const reclaimReason = inspection.uniqueCommitCount > 0
          ? "complete-column-unique-commits-force"
          : "zero-unique-commits-no-worktree";

        await execAsync(`git branch -D ${JSON.stringify(branch)}`, {
          cwd: this.options.rootDir,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        // Branch-level reclaim remains active in worktrunk mode; this is
        // idempotent git metadata cleanup, not layout ownership.
        // FN-4742: keep native prune; see WorktreeBackend.prune docs
        await execAsync("git worktree prune", {
          cwd: this.options.rootDir,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });

        await this.store.updateTask(task.id, {
          worktree: null,
          branch: null,
          baseCommitSha: null,
        });
        await this.store.logEntry(
          task.id,
          `[recovery] stale-active-branch-reclaim ${task.id} branch=${branch} reason=${reclaimReason}`,
        );

        try {
          const auditor = createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-heal", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "reclaim-stale-active-branches",
          });
          await auditor.git({
            type: "branch:stale-active-reclaim",
            target: branch,
            metadata: {
              taskId: task.id,
              branch,
              tipSha: inspection.tipSha,
              uniqueCommitCount: inspection.uniqueCommitCount,
              reason: reclaimReason,
            },
          });
        } catch (auditErr: unknown) {
          log.warn(`Failed to write branch:stale-active-reclaim run-audit event for ${task.id}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
        }

        reclaimed++;
      }

      if (reclaimed > 0) {
        log.log(`Reclaimed ${reclaimed} stale active fusion branch(es) with no usable worktree`);
      }
      return reclaimed;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Stale active branch reclaim sweep failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Clear `blockedBy` on todo tasks whose blocker has reached a terminal or
   * stuck state.
   *
   * Stale-blocker conditions (clear if ANY apply):
   * 1. Blocker task does not exist (id missing entirely)
   * 2. Blocker `column === "done"` or `column === "archived"`
   * 3. Blocker `column === "in-review"` and `paused === true`
   * 4. Blocker `column === "in-review"` and `status === "failed"`
   *    and `(mergeRetries ?? 0) >= MAX_AUTO_MERGE_RETRIES`
   * 5. Blocker `column === "in-review"` and `status === "merging" | "merging-pr"`
   *    (or a stale post-recovery `status === null` aftermath) with stale
   *    `updatedAt` (older than `staleMergingFanoutMinAgeMs`) and no active
   *    merger ownership in this process
   *
   * @returns Number of tasks unblocked
   */

  private async clearCompletionBranchIfSubsumed(task: Task, branchName: string): Promise<boolean> {
    /*
    FNXC:StaleActiveBranchDoneSpam 2026-08-03-01:47:
    Completion fan-out used to skip deletion when the tip still had unique commits vs the integration base. Squash / AI-merge always leaves that shape (new main SHA, old fusion/* tip still "unique"), so done tasks kept local branches forever and reclaimStaleActiveBranches warned rescue-needed every sweep. After a successful complete, force-delete the task branch regardless of unique commit count; the landed content is already on the integration branch under a different SHA. Log unique-count force deletes at info, not as an open rescue.
    */
    try {
      await execAsync(`git rev-parse --verify ${shellQuote(branchName)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
    } catch {
      return false;
    }

    const baseBranch = task.baseBranch || await resolveIntegrationBranch(this.options.rootDir, undefined);
    const comparison = await listUniqueBranchCommits(this.options.rootDir, baseBranch, branchName);
    if (comparison.commits.length > 0) {
      log.log(
        `[self-healing] reconcileCompletedTask ${task.id}: branch ${branchName} has ${comparison.commits.length} unique commit(s) vs ${comparison.mainRef}; force-deleting post-completion (squash-safe)`,
      );
    }

    try {
      await execAsync(`git branch -D ${shellQuote(branchName)}`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
      return true;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`[self-healing] reconcileCompletedTask ${task.id}: failed to delete branch ${branchName}: ${errorMessage}`);
      return false;
    }
  }

  async reconcileCompletedTask(
    taskId: string,
    options?: { worktreeHint?: string },
  ): Promise<{ blockedByCleared: number; worktreeRemoved: boolean; branchRemoved: boolean }> {
    const result = { blockedByCleared: 0, worktreeRemoved: false, branchRemoved: false };
    const prefix = `[self-healing] reconcileCompletedTask ${taskId}:`;
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return result;

      const task = await this.store.getTask(taskId);
      await this.reconcileTaskWorktreeMetadata({ includeTaskIds: new Set([taskId]) });
      const allTasks = await this.store.listTasks({ slim: true, includeArchived: true });
      const taskById = new Map(allTasks.map((t) => [t.id, t]));
      const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
      const filteredScopeByTaskId = new Map<string, string[]>();
      /*
      FNXC:OverlapSelfHealing 2026-06-25-04:34:
      Completion fan-out may preserve queued overlap blockers only when the blocker still holds the scheduler's active file-scope lease. Cache empty filtered scopes too so coordination-only tasks stay deterministic within a reconciliation pass.
      */
      const getFilteredFileScope = async (scopeTaskId: string): Promise<string[]> => {
        const cached = filteredScopeByTaskId.get(scopeTaskId);
        if (cached !== undefined) return cached;
        const scope = await this.store.parseFileScopeFromPrompt(scopeTaskId);
        const filteredScope = filterPathsByIgnoreList(scope, overlapIgnorePaths);
        filteredScopeByTaskId.set(scopeTaskId, filteredScope);
        return filteredScope;
      };
      const hasActiveFileScopeOverlapBlocker = async (dependent: Task, blockerId: string | null | undefined): Promise<boolean> => {
        if (!blockerId) return false;
        const blocker = taskById.get(blockerId);
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-22:20 (shared predicate, HALF-converted):
        `shouldHoldActiveFileScopeLease` is the scheduler's lease predicate, shared with this path on
        purpose so stale-blocker cleanup cannot preserve blockers the scheduler would ignore — or, as
        here, RELEASE blockers the scheduler still honours. Its two role answers are optional
        parameters defaulting to the legacy ids; the scheduler's own call sites pass resolved answers
        and these did not, so on a renamed board the two disagreed: the scheduler kept the lease while
        this sweep saw `false` for every card, cleared `overlapBlockedBy`, and released a dependent to
        edit files another agent still holds. Membership comes from the sets this sweep already
        resolved a few lines above.
        */
        if (!blocker || !shouldHoldActiveFileScopeLease(blocker, allTasks, {
          mergeRequestContractShadowEnabled: settings.mergeRequestContractShadowEnabled,
          handoffAccepted: settings.mergeRequestContractShadowEnabled === true
            ? (await this.store.getCompletionHandoffAcceptedMarker(blocker.id)) !== null
            : false,
          isWipColumn: completedWipColumns.has(blocker.column),
          isReviewColumn: completedReviewColumns.has(blocker.column),
        })) return false;
        const dependentScope = await getFilteredFileScope(dependent.id);
        if (dependentScope.length === 0 || isCoordinationOnlyTask(dependent, dependentScope)) return false;
        const blockerScope = await getFilteredFileScope(blocker.id);
        if (blockerScope.length === 0 || isCoordinationOnlyTask(blocker, blockerScope)) return false;
        return pathsOverlap(dependentScope, blockerScope);
      };
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, thirteenth sweep):
      When a task completes, this releases everything blocked on it. Three literal reads meant that on a
      renamed board it released NOTHING — every dependent stayed blocked on a task that had already
      finished, which is the most visible form of this class: the board simply stops moving.

      Buckets come from the read that produced each row (a row returned by `listTasks({ column: X })` is
      in X by definition); re-deriving from `task.column` would only be able to lose rows.
      */
      const completedHoldColumns = await resolveProjectColumnsForRoles(this.store, ["hold"]);
      const completedWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const completedReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const readDependentBucket = async (columns: ReadonlySet<string>): Promise<Task[]> => {
        const byId = new Map<string, Task>();
        for (const column of columns) {
          for (const entry of await this.store.listTasks({ column, slim: true })) byId.set(entry.id, entry);
        }
        return [...byId.values()];
      };
      const todoTasks = await readDependentBucket(completedHoldColumns);
      const inProgressTasks = await readDependentBucket(completedWipColumns);
      const inReviewTasks = (await readDependentBucket(completedReviewColumns)).filter((t) => !t.paused);

      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (#2883 review — greptile P1, "duplicate dependent
      reconciliation"; same class as #2879 one sweep over):
      DEDUPED ACROSS THE BUCKETS, NOT JUST WITHIN EACH.

      `readDependentBucket` dedupes by id inside ONE role's read. A custom workflow may put two queried
      roles on ONE column, which two reads then return, so the dependent landed in two buckets and was
      reconciled twice from the same stale snapshot — the second pass deciding against `blockedBy` state
      the first pass had already cleared, and `updateTask`/`logEntry` firing twice for one card.

      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (precedence correction):
      Written first as `new Map(entries)` with a comment claiming first-bucket precedence. That
      constructor keeps first insertion ORDER but the LAST value for a repeated key, so it did the
      opposite of what it said. The explicit `has` guard below makes the code match the claim; order is
      still preserved, so `todoTaskIds` classifies the dependent by the read that found it first.
      */
      const dependentById = new Map<string, Task>();
      for (const entry of [...todoTasks, ...inProgressTasks, ...inReviewTasks]) {
        if (!dependentById.has(entry.id)) dependentById.set(entry.id, entry);
      }
      /* One IR cache for the whole reconcile, so a board spanning three workflows reads three IRs, not one per dependency row. */
      const depSatisfactionIrCache = new Map<string, WorkflowIr>();
      const dependents = [...dependentById.values()].filter(
        (t) => t.blockedBy === taskId || t.overlapBlockedBy === taskId,
      );
      const todoTaskIds = new Set(todoTasks.map((t) => t.id));
      for (const dependent of dependents) {
        try {
          /*
          A dependency is SATISFIED once it reaches a complete, review or archived lane — resolved per
          DEPENDENCY, since a dependency routinely belongs to a different workflow than the card waiting
          on it (the answer main settled on in branch-group-ops, #2720). Legacy ids unioned, because
          `resolveWorkflowIrForTask` returns the built-in IR for a missing workflow and without the union
          a degraded board reads a finished dependency as unmet — the exact stall being cleared here.
          */
          /*
          FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (#2883 review — greptile P1, "overbroad
          dependency satisfaction"): REUSE THE SCHEDULER'S RESOLVER, DO NOT RE-DERIVE IT.

          The first version unioned all three review roles, which counts a `mergeOrchestration`-only
          column as satisfied. `resolveDependencySatisfactionColumns` — the shared answer the scheduler
          already uses for exactly this question — defines review as `mergeBlocker ∪ humanReview` and
          deliberately excludes merge orchestration. Two readers of one fact disagreeing is how this
          program has already gone wrong; the fix is to call the existing one, not to match it by hand.

          Its contract also covers the degraded case: an unresolvable dependency is left UNMAPPED, and
          the literal fallback below then answers, so a dependency whose workflow cannot be read does not
          silently read as never-satisfied and block its dependent forever.
          */
          const depRows = dependent.dependencies
            .map((depId) => taskById.get(depId))
            .filter((dep): dep is Task => Boolean(dep));
          const depSatisfaction = await resolveDependencySatisfactionColumns(this.store, depRows, depSatisfactionIrCache);
          const unresolvedDeps: string[] = [];
          for (const depId of dependent.dependencies) {
            const dep = taskById.get(depId);
            if (!dep) continue;
            const columns = depSatisfaction.get(depId);
            const satisfied = columns
              ? columns.terminal.has(dep.column) || columns.review.has(dep.column)
              : isDependencySatisfiedWithoutWorkflowMetadata(dep.column);
            if (!satisfied) unresolvedDeps.push(depId);
          }
          const overlapBlockedBy = dependent.overlapBlockedBy === taskId ? null : (dependent.overlapBlockedBy ?? null);
          const hasActiveOverlapBlocker = await hasActiveFileScopeOverlapBlocker(dependent, overlapBlockedBy);

          if (todoTaskIds.has(dependent.id)) {
            /*
            FNXC:QueuedTaskLogging 2026-08-04-18:32:
            Completion fanout can race duplicate completion callbacks. Route retained dependency
            and overlap queue episodes through the durable transition so its state repair and
            one visible event commit together rather than reintroducing poll-driven task logs.
            */
            if (unresolvedDeps.length > 0) {
              const nextBlocker = unresolvedDeps[0]!;
              const normalizedUnresolvedDeps = [...new Set(unresolvedDeps)].sort();
              await this.store.transitionQueuedEpisode(dependent.id, {
                signature: `dependency:${normalizedUnresolvedDeps.join(",")}`,
                blockedBy: nextBlocker,
                overlapBlockedBy,
                action: `Auto-recovered (FN-4523): cleared stale blockedBy — blocker ${taskId} is done; now blocked by ${nextBlocker}`,
              });
            } else if (hasActiveOverlapBlocker) {
              await this.store.transitionQueuedEpisode(dependent.id, {
                signature: `file-scope:${overlapBlockedBy}`,
                blockedBy: null,
                overlapBlockedBy,
                action: `Auto-recovered (FN-4523): preserved queued status — still blocked by file scope overlap with ${overlapBlockedBy}`,
              });
            } else {
              await this.store.updateTask(dependent.id, { blockedBy: null, overlapBlockedBy: null, status: null });
              await this.store.logEntry(
                dependent.id,
                `Auto-recovered (FN-4523): cleared stale blockedBy — blocker ${taskId} is done`,
              );
            }
          } else {
            await this.store.updateTask(dependent.id, {
              blockedBy: null,
              ...(dependent.overlapBlockedBy === taskId ? { overlapBlockedBy: null } : {}),
            });
            await this.store.logEntry(
              dependent.id,
              `Auto-recovered (FN-4523): cleared stale blockedBy — blocker ${taskId} is done`,
            );
          }
          result.blockedByCleared++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`${prefix} failed blockedBy fan-out for ${dependent.id}: ${errorMessage}`);
        }
      }

      const branchName = task ? resolveTaskWorkingBranch(task) : canonicalFusionBranchName(taskId);
      const hintedWorktreePath = options?.worktreeHint;
      let worktreePath = hintedWorktreePath;
      if (!worktreePath || !existsSync(worktreePath)) {
        worktreePath = task?.worktree;
      }
      if (!worktreePath || !existsSync(worktreePath)) {
        worktreePath = await this.findWorktreePathForBranch(branchName);
      }
      if (worktreePath && existsSync(worktreePath)) {
        try {
          const settings = await this.store.getSettings();
          await removeWorktree({
            rootDir: this.options.rootDir,
            worktreePath,
            settings,
            taskId,
            reason: RemovalReason.SelfHealingStaleActiveBranch,
          });
          result.worktreeRemoved = true;
          if (task) {
            const patch = {
              worktree: null as string | null,
              ...(task.branch === branchName ? { branch: null as string | null } : {}),
            };
            await this.store.updateTask(task.id, patch as Partial<Task>);
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`${prefix} failed to remove worktree ${worktreePath}: ${errorMessage}`);
        }
      } else {
        log.debug(`${prefix} no live worktree found for branch ${branchName}`);
      }

      this.options.releaseExecutorWorktreeOwnership?.(taskId);

      if (task) {
        result.branchRemoved = await this.clearCompletionBranchIfSubsumed(task, branchName);
      }

      try {
        const auditor = createRunAuditor(this.store, {
          runId: generateSyntheticRunId("self-heal", taskId),
          agentId: "self-healing",
          taskId,
          taskLineageId: task?.lineageId ?? undefined,
          phase: "completion-fanout",
        });
        await auditor.database({
          type: "task:auto-recover-completion-fanout",
          target: taskId,
          metadata: {
            blockedByCleared: result.blockedByCleared,
            worktreeRemoved: result.worktreeRemoved,
            branchRemoved: result.branchRemoved,
            branch: branchName,
            worktreePath: result.worktreeRemoved ? worktreePath : undefined,
          },
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`${prefix} failed to record run-audit event: ${errorMessage}`);
      }

      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`${prefix} failed: ${errorMessage}`);
      return result;
    }
  }

  private async emitWorktreeMetadataAuditEvent(input: {
    taskId: string;
    mutationType:
      | "task:auto-recover-worktree-metadata-rebound"
      | "task:auto-recover-worktree-metadata-cleared"
      | "task:auto-recover-worktree-metadata-skipped-active";
    previousWorktree: string | null;
    newWorktree: string | null;
    previousBranch: string | null;
    newBranch: string | null;
  }): Promise<void> {
    try {
      const auditor = createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal", input.taskId),
        agentId: "self-healing",
        taskId: input.taskId,
        phase: "worktree-metadata-reconcile",
      });
      await auditor.database({
        type: input.mutationType,
        target: input.taskId,
        metadata: {
          taskId: input.taskId,
          previousWorktree: input.previousWorktree,
          newWorktree: input.newWorktree,
          previousBranch: input.previousBranch,
          newBranch: input.newBranch,
        },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      worktreeMetadataReconcileLog.warn(
        `Failed to record ${input.mutationType} for ${input.taskId}: ${errorMessage}`,
      );
    }
  }

  private assertSafeToAutoRebind(task: Task): AutoRebindSafetyResult {
    /*
    FNXC:SelfHealingRebind 2026-06-19-12:00:
    In-review branch rebind is metadata repair only, but it is still an engine-owned mutation.
    Block instead of warn when authoritative user intent or a live checkout is present so recovery never overrides a user pause or rewrites task metadata underneath an active agent lease.
    */
    if (task.userPaused === true) {
      return {
        safe: false,
        reason: "unsafe-to-auto-mutate:user-paused",
        detail: "task is user-paused; authoritative user intent blocks automatic branch rebind",
      };
    }
    if (task.checkedOutBy) {
      return {
        safe: false,
        reason: "unsafe-to-auto-mutate:checked-out",
        detail: `task is checked out by ${task.checkedOutBy}; automatic branch rebind would mutate metadata under a live lease`,
      };
    }
    return { safe: true };
  }

  private async emitBranchRebindAuditEvent(input: {
    taskId: string;
    mutationType: "task:auto-rebind-applied" | "task:auto-rebind-skipped";
    metadata: Record<string, unknown>;
  }): Promise<void> {
    try {
      const auditor = createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal", input.taskId),
        agentId: "self-healing",
        taskId: input.taskId,
        phase: "in-review-branch-rebind",
      });
      await auditor.database({
        type: input.mutationType as unknown as Parameters<typeof auditor.database>[0]["type"],
        target: input.taskId,
        metadata: input.metadata,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      worktreeMetadataReconcileLog.warn(
        `Failed to record ${input.mutationType} for ${input.taskId}: ${errorMessage}`,
      );
    }
  }

  async reconcileInReviewBranchRebind(options?: { includeTaskIds?: Set<string> }): Promise<RebindResult> {
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-22:30 (self-healing cluster): branch rebind targets cards resting in the board's own review lane. Keyed on the literal this sweep answered "no" for every card on a renamed board. */
    const rebindReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
    const result: RebindResult = { repaired: 0, outcomes: [] };
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return result;

      const allTasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const tasks = allTasks.filter((task) => rebindReviewColumns.has(task.column));
      const fusionRefOutput = await execAsync("git for-each-ref --format='%(refname:short)' refs/heads/fusion/", {
        cwd: this.options.rootDir,
        timeout: 30_000,
      }).catch(() => ({ stdout: "" }));
      const fusionBranches = fusionRefOutput.stdout.split("\n").map((line) => line.trim()).filter(Boolean);

      for (const task of tasks) {
        if (options?.includeTaskIds && !options.includeTaskIds.has(task.id)) continue;

        /*
        FNXC:Workspace 2026-06-24-23:10:
        A workspace task is NEVER a branch-rebind candidate. Its attachment is the per-sub-repo
        worktrees in `task.workspaceWorktrees`, and its `fusion/<id>` branches live inside each
        sub-repo — not in `this.options.rootDir`, which for a workspace is the non-git browse-only
        root. A null `task.branch` is its HEALTHY steady state, so trying to rebind a root branch is
        meaningless (every git probe below would fail-soft against the non-git root anyway). Skip it
        explicitly. The slim list select now carries `workspaceWorktrees`, so `isWorkspaceTask` is
        accurate on these slim rows.
        */
        if (isWorkspaceTask(task)) {
          result.outcomes.push({ taskId: task.id, result: "skipped", reason: "workspace-task" });
          continue;
        }

        const existingBinding = task.branch;
        if (existingBinding) {
          try {
            await execAsync(`git show-ref --verify --quiet ${shellQuote(`refs/heads/${existingBinding}`)}`, {
              cwd: this.options.rootDir,
              timeout: 30_000,
            });
            result.outcomes.push({ taskId: task.id, result: "skipped", reason: "binding-intact" });
            continue;
          } catch {
            // broken binding, evaluate candidates
          }
        }

        const normalizedId = task.id.toLowerCase();
        const candidates = new Set<string>([canonicalFusionBranchName(task.id), `fusion/`.concat(task.id)]);
        for (const branch of fusionBranches) {
          const stem = branch.startsWith("fusion/") ? branch.slice("fusion/".length) : "";
          if (stem.toLowerCase() === normalizedId) candidates.add(branch);
        }

        const integrationBase = task.baseBranch || await resolveIntegrationBranch(this.options.rootDir, undefined);
        // Dedup by resolved SHA, not by lowercase name. On case-insensitive
        // filesystems (macOS APFS default) two case-variant refs resolve to the
        // same underlying ref → same SHA → collapse to canonical. On
        // case-sensitive filesystems (Linux) two case-variants are physically
        // distinct refs with distinct SHAs → keep both, so downstream detects
        // the ambiguity rather than silently picking one.
        const candidateByRefSha = new Map<string, { branch: string; aheadCount: number }>();
        const normalizedCandidate = canonicalFusionBranchName(task.id);
        for (const branch of candidates) {
          let branchSha: string;
          try {
            const { stdout } = await execAsync(`git rev-parse --verify ${shellQuote(`refs/heads/${branch}`)}`, {
              cwd: this.options.rootDir,
              timeout: 30_000,
            });
            branchSha = stdout.trim();
          } catch {
            continue;
          }
          if (!branchSha) continue;

          let comparisonBase = integrationBase;
          try {
            await execAsync(`git rev-parse --verify ${shellQuote(comparisonBase)}`, {
              cwd: this.options.rootDir,
              timeout: 30_000,
            });
          } catch {
            const originBase = `origin/${comparisonBase}`;
            await execAsync(`git rev-parse --verify ${shellQuote(originBase)}`, {
              cwd: this.options.rootDir,
              timeout: 30_000,
            });
            comparisonBase = originBase;
          }
          const mergeBase = (await execAsync(`git merge-base ${shellQuote(comparisonBase)} ${shellQuote(branch)}`, {
            cwd: this.options.rootDir,
            timeout: 30_000,
          })).stdout.trim();
          const aheadCountRaw = await execAsync(`git rev-list --count ${shellQuote(mergeBase)}..${shellQuote(branch)}`, {
            cwd: this.options.rootDir,
            timeout: 30_000,
          });
          const aheadCount = Number.parseInt(aheadCountRaw.stdout.trim(), 10);
          const existing = candidateByRefSha.get(branchSha);
          if (!existing || branch === normalizedCandidate) {
            candidateByRefSha.set(branchSha, {
              branch,
              aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
            });
          }
        }

        const existingCandidates = [...candidateByRefSha.values()];

        if (existingCandidates.length === 0) {
          await this.emitBranchRebindAuditEvent({
            taskId: task.id,
            mutationType: "task:auto-rebind-skipped",
            metadata: { taskId: task.id, reason: "no-live-branch" },
          });
          result.outcomes.push({ taskId: task.id, result: "skipped", reason: "no-live-branch" });
          continue;
        }

        const withUniqueWork = existingCandidates.filter((candidate) => candidate.aheadCount > 0);
        if (withUniqueWork.length === 1) {
          const selected = withUniqueWork[0];
          const patch: Partial<Task> = { branch: selected.branch, worktree: null as unknown as string };
          if (!task.baseCommitSha) {
            const derivedBaseCommit = (await execAsync(
              `git merge-base ${shellQuote(integrationBase)} ${shellQuote(selected.branch)}`,
              { cwd: this.options.rootDir, timeout: 30_000 },
            )).stdout.trim();
            if (derivedBaseCommit) {
              patch.baseCommitSha = derivedBaseCommit;
            }
          }
          const safety = this.assertSafeToAutoRebind(task);
          if (!safety.safe) {
            await this.emitBranchRebindAuditEvent({
              taskId: task.id,
              mutationType: "task:auto-rebind-skipped",
              metadata: {
                taskId: task.id,
                reason: safety.reason,
                detail: safety.detail,
                branch: selected.branch,
                aheadCount: selected.aheadCount,
                integrationBase,
                source: "auto-rebind-in-review",
                previousBranch: task.branch ?? null,
              },
            });
            result.outcomes.push({ taskId: task.id, result: "skipped", reason: safety.reason });
            continue;
          }
          await this.store.updateTask(task.id, patch);
          await this.emitBranchRebindAuditEvent({
            taskId: task.id,
            mutationType: "task:auto-rebind-applied",
            metadata: {
              taskId: task.id,
              branch: selected.branch,
              aheadCount: selected.aheadCount,
              integrationBase,
              source: "auto-rebind-in-review",
              previousBranch: task.branch ?? null,
            },
          });
          result.repaired++;
          result.outcomes.push({
            taskId: task.id,
            result: "applied",
            branch: selected.branch,
            aheadCount: selected.aheadCount,
            integrationBase,
            previousBranch: task.branch ?? null,
          });
          continue;
        }

        if (withUniqueWork.length > 1) {
          await this.emitBranchRebindAuditEvent({
            taskId: task.id,
            mutationType: "task:auto-rebind-skipped",
            metadata: { taskId: task.id, reason: "ambiguous-candidates", candidates: withUniqueWork },
          });
          log.warn(`[self-healing] ambiguous branch rebind candidates for ${task.id}: ${JSON.stringify(withUniqueWork)}`);
          result.outcomes.push({ taskId: task.id, result: "skipped", reason: "ambiguous-candidates", candidates: withUniqueWork });
          continue;
        }

        await this.emitBranchRebindAuditEvent({
          taskId: task.id,
          mutationType: "task:auto-rebind-skipped",
          metadata: { taskId: task.id, reason: "no-unique-work" },
        });
        result.outcomes.push({ taskId: task.id, result: "skipped", reason: "no-unique-work" });
      }

      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      worktreeMetadataReconcileLog.error(`reconcileInReviewBranchRebind failed: ${errorMessage}`);
      return result;
    }
  }

  async reconcileTaskWorktreeMetadata(options?: { includeTaskIds?: Set<string> }): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const allTasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const branchMap = await getRegisteredWorktreeBranchMap(this.options.rootDir);
      // FN-5256: macOS git surfaces realpath-normalized worktree paths (/private/var/...)
      // while task.worktree may be persisted as the symlinked path. Compare on realpath
      // to avoid false-stale flagging that yanks a live worktree.
      const safeRealpath = (path: string): string => {
        try {
          return realpathSync(path);
        } catch {
          return path;
        }
      };
      const registeredRealpaths = new Set<string>();
      for (const path of branchMap.values()) {
        registeredRealpaths.add(safeRealpath(path));
      }
      let repaired = 0;

      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-16:40 (fleet, self-healing round 2):
      TERMINAL/WIP/REVIEW roles for this sweep's three lane questions. Keyed on ids the terminal skip
      never fired on a renamed board (finished cards were rebound every pass) and — the dangerous half —
      the FN-5256 liveness guard below went silent, so the sweep could clear worktree metadata out from
      under a running shell.
      */
      const worktreeReconcileTerminalColumns = await resolveProjectColumnsForRoles(this.store, TERMINAL_ROLES);
      const worktreeReconcileWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const worktreeReconcileReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      for (const task of allTasks) {
        if (!task.worktree) continue;
        if (!options?.includeTaskIds?.has(task.id) && worktreeReconcileTerminalColumns.has(task.column)) {
          continue;
        }

        const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
        if (executingIds.has(task.id)) continue;
        if (activeSessionRegistry.isPathActive(task.worktree)) continue;

        const normalizedBranch = canonicalFusionBranchName(task.id);
        const resolvedTaskWorktree = resolve(task.worktree);
        const realpathTaskWorktree = safeRealpath(resolvedTaskWorktree);
        const stale = !existsSync(task.worktree) || !registeredRealpaths.has(realpathTaskWorktree);
        if (!stale) continue;

        const previousWorktree = task.worktree;
        const previousBranch = task.branch ?? null;
        const liveWorktree = branchMap.get(normalizedBranch);

        if (liveWorktree) {
          await this.store.updateTask(task.id, { worktree: liveWorktree, branch: normalizedBranch });
          await this.emitWorktreeMetadataAuditEvent({
            taskId: task.id,
            mutationType: "task:auto-recover-worktree-metadata-rebound",
            previousWorktree,
            newWorktree: liveWorktree,
            previousBranch,
            newBranch: normalizedBranch,
          });
          worktreeMetadataReconcileLog.debug(
            `rebound ${task.id}: ${previousWorktree} -> ${liveWorktree} (${previousBranch ?? "<none>"} -> ${normalizedBranch})`,
          );
          repaired++;
          continue;
        }

        const scopeOverrideMergeActiveSafe =
          task.scopeOverride === true
          /* Same resolved sets as the liveness guard below, so the two cannot disagree about live lanes. */
          && !worktreeReconcileWipColumns.has(task.column)
          && (!worktreeReconcileReviewColumns.has(task.column) || (typeof task.status === "string" && RECONCILE_SCOPE_OVERRIDE_MERGE_ACTIVE_STATUS_SET.has(task.status)));
        if (scopeOverrideMergeActiveSafe) {
          /*
          FNXC:MissingWorktreeRecovery 2026-07-10-18:23:
          Upstream #1992 reproduced with scopeOverride=1: a main-checkout-only task retained a stale sub-repo worktree pointer, so every session start refused the missing path before scope override could help. When no live fusion/<id> worktree exists, clear only the phantom metadata; scopeOverride remains a file-scope no-op.

          FNXC:MissingWorktreeRecovery 2026-07-10 (code review): the FN-5256 guard immediately below exists precisely because column==="in-progress"/"in-review" tasks can be live even when this heuristic's existsSync/registered-path check calls them stale (that's the guard's own stated rationale). Restrict this scopeOverride bypass to the narrow #1992 bug shape reproduced in the task report — in-review AND a merge-active sub-status (merging/merging-pr/merging-fix) — so a scopeOverride task that is genuinely in-progress, or in-review mid-step (status: null) with a live but momentarily undetected session, still falls through to the FN-5256 protection instead of having its worktree/branch/sessionFile yanked out from under it.
          */
          await this.store.updateTask(task.id, { worktree: null, branch: null, sessionFile: null });
          await this.emitWorktreeMetadataAuditEvent({
            taskId: task.id,
            mutationType: "task:auto-recover-worktree-metadata-cleared",
            previousWorktree,
            newWorktree: null,
            previousBranch,
            newBranch: null,
          });
          worktreeMetadataReconcileLog.debug(
            `cleared scopeOverride ${task.id}: ${previousWorktree} (${previousBranch ?? "<none>"})`,
          );
          repaired++;
          continue;
        }

        // FN-5256: never null out worktree/branch metadata for an active task. If a
        // live task's worktree looks stale here (and we couldn't rebind to a live
        // fusion/<id>), the executor's own recovery paths will detect and recreate
        // it. Clearing here yanks the worktree from a still-running shell.
        if (worktreeReconcileWipColumns.has(task.column) || worktreeReconcileReviewColumns.has(task.column)) {
          await this.emitWorktreeMetadataAuditEvent({
            taskId: task.id,
            mutationType: "task:auto-recover-worktree-metadata-skipped-active",
            previousWorktree,
            newWorktree: previousWorktree,
            previousBranch,
            newBranch: previousBranch,
          });
          worktreeMetadataReconcileLog.warn(
            `[FN-5256] skipped clearing worktree metadata for active ${task.column} task ${task.id}: ${previousWorktree} (${previousBranch ?? "<none>"})`,
          );
          continue;
        }

        await this.store.updateTask(task.id, { worktree: null, branch: null });
        await this.emitWorktreeMetadataAuditEvent({
          taskId: task.id,
          mutationType: "task:auto-recover-worktree-metadata-cleared",
          previousWorktree,
          newWorktree: null,
          previousBranch,
          newBranch: null,
        });
        worktreeMetadataReconcileLog.debug(
          `cleared ${task.id}: ${previousWorktree} (${previousBranch ?? "<none>"})`,
        );
        repaired++;
      }

      return repaired;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      worktreeMetadataReconcileLog.error(`reconcileTaskWorktreeMetadata failed: ${errorMessage}`);
      return 0;
    }
  }

  async autoReboundPausedScopeDecay(options?: { ignoreAgeGate?: boolean }): Promise<number> {
    const result = await this.autoReboundPausedScopeDecayDetailed(options);
    return result.count;
  }

  private async autoReboundPausedScopeDecayDetailed(options?: { ignoreAgeGate?: boolean }): Promise<{ count: number; reboundedIds: string[] }> {
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-22:30 (self-healing cluster): scope decay rebounds a card that is EXECUTING. Keyed on the literal this sweep answered "no" for every card on a renamed board. */
    const scopeDecayWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return { count: 0, reboundedIds: [] };

    const thresholdMs = Number(settings.pausedScopeDecayMs ?? 0);
    if (!options?.ignoreAgeGate && (!Number.isFinite(thresholdMs) || thresholdMs <= 0)) {
      return { count: 0, reboundedIds: [] };
    }

    const tasks = await this.store.listTasks({ slim: true, includeArchived: false });
    const followersByHolder = new Map<string, number>();
    for (const task of tasks) {
      if (typeof task.blockedBy !== "string" || task.blockedBy.trim().length === 0) continue;
      followersByHolder.set(task.blockedBy, (followersByHolder.get(task.blockedBy) ?? 0) + 1);
    }

    const now = Date.now();
    const reboundedIds: string[] = [];
    for (const task of tasks) {
      if (!scopeDecayWipColumns.has(task.column) || task.paused !== true) continue;
      if (SelfHealingManager.PAUSED_SCOPE_DECAY_EXCLUDED_REASONS.has(task.pausedReason ?? "")) continue;
      const followerCount = followersByHolder.get(task.id) ?? 0;
      if (followerCount <= 0) continue;

      const movedAtMs = Date.parse(task.columnMovedAt ?? task.updatedAt ?? "");
      const ageMs = Number.isFinite(movedAtMs) ? now - movedAtMs : Number.POSITIVE_INFINITY;
      if (!options?.ignoreAgeGate && ageMs < thresholdMs) continue;

      const proof = await this.evaluateBackwardMoveTripleProof(task, {
        stage: "auto-rebound-paused-scope-decay",
        graceMs: thresholdMs,
        stalenessAnchor: task.executionStartedAt ?? task.updatedAt,
        reason: "paused-scope-decay-candidate",
        extra: {
          followerCount,
          ignoredAgeGate: options?.ignoreAgeGate === true,
          thresholdMs,
          ageMs,
        },
      });
      if (!proof.ok) {
        await this.emitBackwardMoveNoAction(task, "auto-rebound-paused-scope-decay", "task:auto-rebound-scope-decay-no-action", proof);
        continue;
      }

      await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), {
        preserveProgress: true,
        preserveWorktree: true,
        preserveResumeState: true,
        moveSource: "engine",
        // #1411: backward recovery — skip order-derived adjacency.
        recoveryRehome: true,
      });
      await this.store.logEntry(
        task.id,
        `Auto-rebounded (FN-4890): paused in-progress holder exceeded scope-decay threshold with ${followerCount} blocked follower(s)`,
      );
      const auditor = createRunAuditor(this.store, {
        runId: generateSyntheticRunId("fn4890-paused-scope-decay", task.id),
        agentId: "self-healing",
        taskId: task.id,
        phase: "auto-rebound-paused-scope-decay",
      });
      await auditor.database({
        type: "task:auto-rebound-paused-scope-decay",
        target: task.id,
        metadata: {
          taskId: task.id,
          followerCount,
          ignoredAgeGate: options?.ignoreAgeGate === true,
          thresholdMs,
          ageMs,
        },
      });
      reboundedIds.push(task.id);
    }

    return { count: reboundedIds.length, reboundedIds };
  }

  private countBlockedDepth(tasks: Task[]): number {
    return tasks.filter((task) => typeof task.blockedBy === "string" && task.blockedBy.trim().length > 0).length;
  }

  /**
   * #1401: periodic transitionPending recovery sweep. Delegates to the store's
   * idempotent recovery method (a no-op when no stale markers exist), keeping
   * capacity counts honest after a crash between the in-txn marker write and the
   * post-commit clear.
   *
   * FNXC:WorkflowColumns 2026-07-27-09:40 (U2 / R9):
   * The `isWorkflowColumnsEnabled` gate is GONE, not disabled. That helper
   * returned a literal `true`, so the early return was unreachable and the
   * settings read that fed it was pure cost. The sweep is unconditional now,
   * which is what it already was at runtime.
   */
  async runStaleTransitionPendingSweep(): Promise<void> {
    await this.store.recoverStaleTransitionPending();
  }

  async runBoardStallAutoRecoverySweep(): Promise<{ holders: string[]; recovered: number; unrecovered: boolean }> {
    const settings = await this.store.getSettings();
    const windowMs = Number(settings.boardStallSweepWindowMs ?? 2 * 60 * 60_000);
    const growthThreshold = Number(settings.boardStallBlockedGrowthThreshold ?? 3);
    const now = Date.now();
    const allTasks = await this.store.listTasks({ slim: true, includeArchived: false });
    const blockedDepth = this.countBlockedDepth(allTasks);

    if (!this.boardStallWindow || now - this.boardStallWindow.windowStartMs >= windowMs) {
      this.boardStallWindow = {
        windowStartMs: now,
        windowStartBlockedDepth: blockedDepth,
        transitionsOutOfInProgressInWindow: 0,
        pendingVerification: null,
        lastNtfyAt: this.boardStallWindow?.lastNtfyAt ?? null,
      };
    }

    const window = this.boardStallWindow;
    if (window.pendingVerification && this.maintenanceTickCounter > window.pendingVerification.tick) {
      const noProgress = window.transitionsOutOfInProgressInWindow === 0;
      if (noProgress) {
        const ntfyAllowed = window.lastNtfyAt === null || now - window.lastNtfyAt >= BOARD_STALL_NOTIFICATION_COOLDOWN_MS;
        let ntfyDispatched = false;
        if (ntfyAllowed) {
          try {
            if (this.options.ntfyNotifier) {
              await this.options.ntfyNotifier.notifyBoardStallUnrecovered({
                holderIds: window.pendingVerification.holderIds,
                followerCount: window.pendingVerification.followerCount,
              });
              window.lastNtfyAt = now;
              ntfyDispatched = true;
            } else {
              const enabled = Boolean(settings.ntfyEnabled && settings.ntfyTopic);
              const events = resolveNtfyEvents(settings.ntfyEvents);
              if (enabled && isNtfyEventEnabled(events, "board-stall-unrecovered")) {
                const clickUrl = buildNtfyClickUrl({ dashboardHost: settings.ntfyDashboardHost });
                await sendNtfyNotification({
                  ntfyBaseUrl: settings.ntfyBaseUrl,
                  ntfyAccessToken: settings.ntfyAccessToken,
                  topic: settings.ntfyTopic!,
                  title: "Board stall unrecovered",
                  message: `Auto-recovery could not clear board stall. Holders: ${window.pendingVerification.holderIds.join(", ") || "none"}. Followers blocked: ${window.pendingVerification.followerCount}.`,
                  priority: "high",
                  clickUrl,
                });
                window.lastNtfyAt = now;
                ntfyDispatched = true;
              }
            }
          } catch {
            ntfyDispatched = false;
          }
        }
        const auditor = createRunAuditor(this.store, { runId: generateSyntheticRunId("fn4890-board-stall", "global"), agentId: "self-healing", phase: "board-stall-unrecovered" });
        await auditor.database({ type: "task:auto-board-stall-unrecovered", target: "board", metadata: { holderIds: window.pendingVerification.holderIds, followerCount: window.pendingVerification.followerCount, windowMs, ntfyDispatched } });
        window.pendingVerification = null;
        return { holders: [], recovered: 0, unrecovered: true };
      }
      window.pendingVerification = null;
    }

    const blockedGrowth = blockedDepth - window.windowStartBlockedDepth;
    if (window.transitionsOutOfInProgressInWindow === 0 && blockedGrowth >= growthThreshold) {
      const rebound = await this.autoReboundPausedScopeDecayDetailed({ ignoreAgeGate: true });
      // Measure verification progress after intervention; don't count our own rebound moves.
      window.transitionsOutOfInProgressInWindow = 0;
      const followerCount = blockedDepth;
      const auditor = createRunAuditor(this.store, { runId: generateSyntheticRunId("fn4890-board-stall", "global"), agentId: "self-healing", phase: "board-stall-broken" });
      await auditor.database({ type: "task:auto-board-stall-broken", target: "board", metadata: { holderIds: rebound.reboundedIds, followerCount, windowMs, blockedGrowth } });
      window.pendingVerification = { holderIds: rebound.reboundedIds, followerCount, startedAt: now, tick: this.maintenanceTickCounter };
      return { holders: rebound.reboundedIds, recovered: rebound.count, unrecovered: false };
    }

    return { holders: [], recovered: 0, unrecovered: false };
  }

  private async surfaceDbCorruption(): Promise<void> {
    /*
    FNXC:IncompletePgPorts 2026-07-26-20:45:
    Refresh PostgreSQL connectivity before reading the snapshot so corruption
    notifications are not permanently suppressed by the always-healthy sentinel.
    */
    if (typeof this.store.refreshDatabaseHealthAsync === "function") {
      await this.store.refreshDatabaseHealthAsync();
    } else {
      this.store.refreshDatabaseHealth();
    }
    const health = this.store.getDatabaseHealth();
    if (!health.corruptionDetected) {
      this.lastDbCorruptionNotifiedAt = null;
      return;
    }

    const now = Date.now();
    if (
      this.lastDbCorruptionNotifiedAt !== null
      && now - this.lastDbCorruptionNotifiedAt < DB_CORRUPTION_NOTIFICATION_COOLDOWN_MS
    ) {
      return;
    }

    const settings = await this.store.getSettings();
    const errors = health.corruptionErrors.slice(0, 5);
    let notificationDispatched = false;

    try {
      const notificationService = getActiveNotificationService();
      if (notificationService) {
        await notificationService.dispatch("db-corruption-detected", {
          event: "db-corruption-detected",
          timestamp: new Date().toISOString(),
          metadata: {
            errors,
            lastCheckedAt: health.lastCheckedAt?.toISOString() ?? null,
          },
        });
        notificationDispatched = true;
      } else {
        const enabled = Boolean(settings.ntfyEnabled && settings.ntfyTopic);
        const events = resolveNtfyEvents(settings.ntfyEvents);
        if (enabled && isNtfyEventEnabled(events, "db-corruption-detected")) {
          const clickUrl = buildNtfyClickUrl({ dashboardHost: settings.ntfyDashboardHost });
          await sendNtfyNotification({
            ntfyBaseUrl: settings.ntfyBaseUrl,
            ntfyAccessToken: settings.ntfyAccessToken,
            topic: settings.ntfyTopic!,
            title: "Database corruption detected",
            message: `Background SQLite integrity check detected corruption. Errors: ${errors.join(" | ") || "unknown"}.`,
            priority: "urgent",
            clickUrl,
          });
          notificationDispatched = true;
        }
      }
    } catch (error: unknown) {
      schedulerLog.log(
        `Failed to dispatch db-corruption-detected notification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const auditor = createRunAuditor(this.store, {
      runId: generateSyntheticRunId("fn5284-db-corruption", "global"),
      agentId: "self-healing",
      phase: "db-corruption-detected",
    });
    await auditor.database({
      type: "task:auto-db-corruption-detected",
      target: "database",
      metadata: {
        errors,
        lastCheckedAt: health.lastCheckedAt?.toISOString() ?? null,
        notificationDispatched,
      },
    });

    this.lastDbCorruptionNotifiedAt = now;
  }

  async reconcileSoftDeletedColumnDrift(): Promise<{ reconciled: number }> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return { reconciled: 0 };

      /*
      FNXC:PostgresSoftDeleteRepair 2026-07-16-00:00:
      FN-8104 retires the unreachable SQLite reconcile fallback that FN-8103
      temporarily allowlisted. Production repair remains PostgreSQL-only while
      preserving the per-row durable audit contract.
      */
      const auditor = createRunAuditor(this.store, {
        runId: generateSyntheticRunId("fn5566-soft-delete-column", "global"),
        agentId: "self-healing",
        phase: "reconcile-soft-delete-column-drift",
      });
      return this.store.reconcileSoftDeletedColumnDriftBackend(async (candidate) => {
        await auditor.database({
          type: "task:soft-delete-column-reconciled",
          target: candidate.id,
          metadata: { previousColumn: candidate.previousColumn },
        });
        log.log(`[self-heal] reconcile-soft-delete-column-drift: ${candidate.id} previous=${candidate.previousColumn} → archived`);
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`reconcileSoftDeletedColumnDrift: failed: ${message}`);
      return { reconciled: 0 };
    }
  }

  async clearStaleBlockedBy(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);

      const staleMergingStatusMinAgeMs = this.options.staleMergingStatusMinAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS;
      const configuredFanoutMinAgeMs = this.options.staleMergingFanoutMinAgeMs ?? DEFAULT_STALE_MERGING_FANOUT_MIN_AGE_MS;
      const staleMergingFanoutMinAgeMs = Math.max(staleMergingStatusMinAgeMs, configuredFanoutMinAgeMs);
      const unbackedMergingFanoutGraceMs = Math.min(
        staleMergingStatusMinAgeMs,
        Math.max(1, this.options.unbackedMergingFanoutGraceMs ?? DEFAULT_UNBACKED_MERGING_FANOUT_GRACE_MS),
      );
      const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
      const executingTaskIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, eleventh sweep):
      THREE lane reads whose downstream treatment DIFFERS — hold cards seed the queued-dependency pass,
      review cards are exempted when paused — so this cannot collapse into one union. Read the project's
      columns for all three role groups, dedupe into one map, then classify each card against ITS OWN
      workflow. On a renamed board all three reads returned empty, so no stale `blockedBy` was ever cleared
      and the cards stayed blocked behind dependencies that had long since finished.
      */
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (#2876 review — greptile, "traitless workflow
      columns stay invisible"): CONFIRMED, DEFERRED, AND THE REASON IS THAT IT IS NOT LOCAL.

      `resolveProjectColumnsForRoles` returns its legacy floor plus what workflows DECLARE for the
      role. A board that renames its lanes but declares no lifecycle traits contributes nothing, so
      the card never enters `blockedCandidates` and the per-card classification below — which is
      correct — never runs for it. Invisible before the guard is reached.

      This is the three-state rule at PROJECT scope: unreadable and untraited take the legacy answer,
      and only a board that EXPRESSES traits and still lacks the role is answering. The merge queue
      got the per-task version of this in #2819.

      NOT FIXED HERE BECAUSE A BLANKET FIX WOULD BE WRONG. The safe direction differs by caller: for
      a sweep, over-inclusion costs extra `listTasks` calls the per-card check discards; for the
      analytics aggregators (#2864, #2866) the same widening inflates a number an operator reads. It
      needs an opt-in — `resolveProjectColumnsForRoles(store, roles, { untraitedProject:
      "declared-columns" })` defaulting to today's behaviour — which is a shared-helper contract
      change touching every sweep, both aggregators and the glasses notifier.

      Premise correction for whoever writes the fixture: this is a hand-authored V2 board, not a v1
      upgrade. `synthesizeDefaultColumns` emits the DEFAULT ids with `traits: []`, so a v1-upgraded
      board cannot have a renamed lane — a v1-shaped fixture would pass vacuously.
      */
      /* `hold` only, NOT `intake`: the original read asked for `todo`. Adding intake would newly scan `triage` cards — a behavior change riding along in a conversion. */
      const blockedHoldColumns = await resolveProjectColumnsForRoles(this.store, ["hold"]);
      const blockedWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const blockedReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const blockedCandidates = new Map<string, Task>();
      for (const column of new Set([...blockedHoldColumns, ...blockedWipColumns, ...blockedReviewColumns])) {
        for (const task of await this.store.listTasks({ column })) blockedCandidates.set(task.id, task);
      }
      /* Per-card classification: a card the union pulled in must land in the bucket ITS workflow says. */
      const todoTasks: Task[] = [];
      const inProgressTasks: Task[] = [];
      const inReviewTasks: Task[] = [];
      const unresolvedBlockedCards: string[] = [];
      for (const task of blockedCandidates.values()) {
        const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id);
        if (source === "default") unresolvedBlockedCards.push(task.id);
        /*
        Legacy ids UNIONED into each bucket rather than compared separately: `resolveWorkflowIrForTask`
        returns the BUILT-IN IR for a missing or corrupt workflow, and a board mid-rename still has rows
        under the old id. This mirrors `lanesOf` below, which unions the same way for referenced tasks.
        */
        const bucket = (roles: readonly string[], legacy: readonly string[]): boolean => {
          const lanes = new Set<string>(legacy);
          for (const role of roles) {
            for (const id of columnsWithFlag(ir, role as Parameters<typeof columnsWithFlag>[1])) lanes.add(id);
          }
          return lanes.has(task.column);
        };
        if (bucket(["hold"], LEGACY_COLUMN_IDS_BY_ROLE.hold ?? [])) todoTasks.push(task);
        if (bucket(["countsTowardWip"], LEGACY_COLUMN_IDS_BY_ROLE.countsTowardWip ?? [])) inProgressTasks.push(task);
        if (bucket(REVIEW_ROLES, LEGACY_COLUMN_IDS_BY_ROLE.mergeOrchestration ?? [])) inReviewTasks.push(task);
      }
      if (unresolvedBlockedCards.length > 0) {
        log.warn(
          `stale blockedBy cleanup: ${unresolvedBlockedCards.length} card(s) classified against the built-in workflow (${unresolvedBlockedCards.slice(0, 5).join(", ")})`,
        );
      }
      const blockedTasks = [
        ...todoTasks,
        ...inProgressTasks,
        ...inReviewTasks.filter((task) => !task.paused),
      ].filter((task) => typeof task.blockedBy === "string" && task.blockedBy.trim().length > 0);
      const queuedDependencyTasks = todoTasks.filter(
        (task) => task.status === "queued" && (task.dependencies.length > 0 || Boolean(task.overlapBlockedBy)),
      );

      if (blockedTasks.length === 0 && queuedDependencyTasks.length === 0) {
        return 0;
      }

      const allTasks = await this.store.listTasks({ includeArchived: true });
      const taskById = new Map(allTasks.map((task) => [task.id, task]));


      const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
      const filteredScopeByTaskId = new Map<string, string[]>();
      /*
      FNXC:OverlapSelfHealing 2026-06-25-04:34:
      Stale blockedBy cleanup must mirror scheduler lease semantics before preserving queued overlap state. Empty-scope cache hits matter here because no-write-scope advisory tasks should not repeatedly reparse specs or look active by accident.
      */
      const getFilteredFileScope = async (taskId: string): Promise<string[]> => {
        const cached = filteredScopeByTaskId.get(taskId);
        if (cached !== undefined) return cached;
        const scope = await this.store.parseFileScopeFromPrompt(taskId);
        const filteredScope = filterPathsByIgnoreList(scope, overlapIgnorePaths);
        filteredScopeByTaskId.set(taskId, filteredScope);
        return filteredScope;
      };
      const hasActiveFileScopeOverlapBlocker = async (task: Task, blockerId: string | null | undefined): Promise<boolean> => {
        if (!blockerId) return false;
        const blocker = taskById.get(blockerId);
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-22:20 (shared predicate, HALF-converted):
        `shouldHoldActiveFileScopeLease` is the scheduler's lease predicate, shared with this path on
        purpose so stale-blocker cleanup cannot preserve blockers the scheduler would ignore — or, as
        here, RELEASE blockers the scheduler still honours. Its two role answers are optional
        parameters defaulting to the legacy ids; the scheduler's own call sites pass resolved answers
        and these did not, so on a renamed board the two disagreed: the scheduler kept the lease while
        this sweep saw `false` for every card, cleared `overlapBlockedBy`, and released a dependent to
        edit files another agent still holds. Membership comes from the sets this sweep already
        resolved a few lines above.
        */
        if (!blocker || !shouldHoldActiveFileScopeLease(blocker, allTasks, {
          mergeRequestContractShadowEnabled: settings.mergeRequestContractShadowEnabled,
          handoffAccepted: settings.mergeRequestContractShadowEnabled === true
            ? (await this.store.getCompletionHandoffAcceptedMarker(blocker.id)) !== null
            : false,
          isWipColumn: blockedWipColumns.has(blocker.column),
          isReviewColumn: blockedReviewColumns.has(blocker.column),
        })) return false;

        const taskScope = await getFilteredFileScope(task.id);
        if (taskScope.length === 0 || isCoordinationOnlyTask(task, taskScope)) return false;
        const blockerScope = await getFilteredFileScope(blocker.id);
        if (blockerScope.length === 0 || isCoordinationOnlyTask(blocker, blockerScope)) return false;
        return pathsOverlap(taskScope, blockerScope);
      };

      let recovered = 0;
      const todoTaskIds = new Set(todoTasks.map((task) => task.id));
      const blockedTaskIds = new Set(blockedTasks.map((task) => task.id));
      const queuedDependencyTaskIds = new Set(queuedDependencyTasks.map((task) => task.id));
      const candidates = new Map<string, typeof todoTasks[number]>();
      for (const task of blockedTasks) candidates.set(task.id, task);
      for (const task of queuedDependencyTasks) candidates.set(task.id, task);

      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (batch-engine — every lane question here is about ANOTHER task):
      This method classifies why a BLOCKER or a DEPENDENCY is no longer blocking, and those rows routinely
      belong to a different workflow than the blocked card. So lanes are resolved PER REFERENCED TASK, not
      from the blocked task — the same answer main settled on for dependency satisfaction in
      branch-group-ops (#2720).

      Prefetched once for the referenced ids only (blockers plus declared dependencies), through one shared
      IR cache, so the predicates below stay synchronous and a board spanning three workflows reads three
      IRs rather than one per row.

      Membership, and unioned with the legacy ids: `resolveWorkflowIrForTask` returns the BUILT-IN IR for a
      missing or corrupt workflow instead of throwing, so without the union a degraded renamed board reads
      a finished blocker as still blocking and the card stays stuck — the exact stall this sweep exists to
      clear.
      */
      const laneIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const lanesById = new Map<string, { complete: Set<string>; archived: Set<string>; hold: Set<string>; review: Set<string> }>();
      const referencedIds = new Set<string>();
      for (const task of candidates.values()) {
        if (task.blockedBy) referencedIds.add(task.blockedBy);
        for (const depId of task.dependencies ?? []) referencedIds.add(depId);
        referencedIds.add(task.id);
      }
      for (const refId of referencedIds) {
        const lanes = {
          complete: new Set<string>(["done"]),
          archived: new Set<string>(["archived"]),
          hold: new Set<string>(["todo"]),
          review: new Set<string>(["in-review"]),
        };
        try {
          const ir = await resolveWorkflowIrForTask(this.store, refId, laneIrCache);
          if (ir) {
            for (const id of columnsWithFlag(ir, "complete")) lanes.complete.add(id);
            for (const id of columnsWithFlag(ir, "archived")) lanes.archived.add(id);
            for (const id of columnsWithFlag(ir, "hold")) lanes.hold.add(id);
            for (const flag of ["mergeOrchestration", "mergeBlocker", "humanReview"] as const) {
              for (const id of columnsWithFlag(ir, flag)) lanes.review.add(id);
            }
          }
        } catch { /* degraded: legacy ids only */ }
        lanesById.set(refId, lanes);
      }
      const lanesOf = (id: string) => lanesById.get(id) ?? {
        complete: new Set(["done"]), archived: new Set(["archived"]),
        hold: new Set(["todo"]), review: new Set(["in-review"]),
      };


      for (const task of candidates.values()) {
        const blockerId = task.blockedBy;

        const unresolvedDeps = task.dependencies.filter((depId) => {
          const dep = taskById.get(depId);
          // listTasks excludes soft-deleted rows, so missing dependency IDs are
          // treated as resolved here by design.
          if (!dep || dep.deletedAt) return false;
          const depLanes = lanesOf(depId);
          return !depLanes.complete.has(dep.column) && !depLanes.review.has(dep.column) && !depLanes.archived.has(dep.column);
        });
        const hasActiveOverlapBlocker = await hasActiveFileScopeOverlapBlocker(task, task.overlapBlockedBy);

        if (blockedTaskIds.has(task.id)) {
          if (!blockerId) continue;

          const blocker = taskById.get(blockerId);
          let reason: string | null = null;
          let reasonCode: string | null = null;

          if (!blocker) {
            let softDeletedBlocker: Task | null = null;
            try {
              const maybeDeleted = await this.store.getTask(blockerId, { includeDeleted: true });
              softDeletedBlocker = maybeDeleted.deletedAt ? maybeDeleted : null;
            } catch {
              softDeletedBlocker = null;
            }

            if (softDeletedBlocker?.deletedAt) {
              reasonCode = "soft-deleted-blocker";
              reason = `blocker ${blockerId} soft-deleted at ${softDeletedBlocker.deletedAt}`;
            } else {
              reasonCode = "missing-blocker";
              reason = `blocker ${blockerId} missing`;
            }
          } else if (blocker.deletedAt) {
            reasonCode = "soft-deleted-blocker";
            reason = `blocker ${blockerId} soft-deleted at ${blocker.deletedAt}`;
          } else if (lanesOf(blocker.id).complete.has(blocker.column)) {
            reasonCode = "blocker-done";
            reason = `blocker ${blockerId} is done`;
          } else if (lanesOf(blocker.id).archived.has(blocker.column)) {
            reasonCode = "blocker-archived";
            reason = `blocker ${blockerId} is archived`;
          } else if (lanesOf(blocker.id).hold.has(blocker.column)) {
            reasonCode = "blocker-moved-todo";
            reason = `blocker ${blockerId} moved to todo`;
          } else if (lanesOf(blocker.id).review.has(blocker.column) && blocker.paused) {
            reasonCode = "in-review-paused";
            reason = `blocker ${blockerId} in-review + paused`;
          } else if (
            lanesOf(blocker.id).review.has(blocker.column) &&
            blocker.status === "failed" &&
            (blocker.mergeRetries ?? 0) >= maxAutoMergeRetries
          ) {
            reasonCode = "failed-retry-exhausted";
            reason = `blocker ${blockerId} in-review + failed (mergeRetries ${blocker.mergeRetries ?? 0}/${maxAutoMergeRetries})`;
          } else if (
            lanesOf(blocker.id).review.has(blocker.column) &&
            blocker.status === "failed" &&
            isMissingWorktreeSessionStartFailure(blocker.error)
          ) {
            reasonCode = "missing-worktree-session-start";
            reason = `blocker ${blockerId} in-review + failed (missing-worktree session start)`;
          } else if (
            lanesOf(blocker.id).review.has(blocker.column) &&
            (blocker.status === "merging" || blocker.status === "merging-pr" || blocker.status == null) &&
            (!activeMergeTaskId || activeMergeTaskId !== blocker.id)
          ) {
            const updatedAtMs = blocker.updatedAt ? Date.parse(blocker.updatedAt) : Number.NaN;
            if (Number.isFinite(updatedAtMs)) {
              const elapsedMs = now - updatedAtMs;
              const blockerStatus = blocker.status ?? "no-status";
              if (
                (blocker.status === "merging" || blocker.status === "merging-pr") &&
                !executingTaskIds.has(blocker.id) &&
                elapsedMs >= unbackedMergingFanoutGraceMs
              ) {
                reasonCode = "unbacked-merging";
                reason = `blocker ${blockerId} in-review + ${blockerStatus} unbacked for ${elapsedMs}ms (grace ${unbackedMergingFanoutGraceMs}ms)`;
              } else if (elapsedMs >= staleMergingFanoutMinAgeMs) {
                reasonCode = "stale-merging-fanout";
                reason = `blocker ${blockerId} in-review + ${blockerStatus} stale for ${elapsedMs}ms (threshold ${staleMergingFanoutMinAgeMs}ms)`;
              }
            }
          } else if (task.dependencies.length > 0 && !unresolvedDeps.includes(blockerId)) {
            reasonCode = "not-unresolved-dependency";
            reason = `blocker ${blockerId} not among unresolved dependencies`;
          }

          if (reason) {
            try {
              let didRecover = false;
              if (todoTaskIds.has(task.id)) {
                if (unresolvedDeps.length > 0) {
                  const nextBlocker = unresolvedDeps[0]!;
                  if (nextBlocker === blockerId) {
                    continue;
                  }
                  await this.store.updateTask(task.id, { blockedBy: nextBlocker, status: "queued" });
                  await this.store.logEntry(task.id, `Auto-recovered (FN-5488): refreshed stale blockedBy — blocker=${blockerId} blockerStatus=${blocker?.status ?? "none"} reason=${reasonCode ?? "unspecified"}; ${reason}; now blocked by ${nextBlocker}`);
                  didRecover = true;
                } else if (hasActiveOverlapBlocker) {
                  const transition = await this.store.transitionQueuedEpisode(task.id, {
                    signature: `file-scope:${task.overlapBlockedBy}`,
                    blockedBy: null,
                    overlapBlockedBy: task.overlapBlockedBy ?? null,
                    action: `Auto-recovered (FN-5488): preserved queued status — blocker=${blockerId} blockerStatus=${blocker?.status ?? "none"} reason=${reasonCode ?? "unspecified"}; still blocked by file scope overlap with ${task.overlapBlockedBy}`,
                  });
                  didRecover = transition.appended;
                } else {
                  await this.store.updateTask(task.id, { blockedBy: null, overlapBlockedBy: null, status: null });
                  await this.store.logEntry(task.id, `Auto-recovered (FN-5488): cleared stale blockedBy — blocker=${blockerId} blockerStatus=${blocker?.status ?? "none"} reason=${reasonCode ?? "unspecified"}; ${reason}`);
                  didRecover = true;
                }
              } else {
                await this.store.updateTask(task.id, { blockedBy: null });
                await this.store.logEntry(task.id, `Auto-recovered (FN-4091): cleared stale blockedBy — ${reason}`);
                didRecover = true;
              }
              if (didRecover) recovered++;
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              log.error(`Failed to clear stale blockedBy for ${task.id}: ${errorMessage}`);
            }
            continue;
          }

          if (!todoTaskIds.has(task.id)) {
            continue;
          }
        }

        if (unresolvedDeps.length === 0) {
          if (queuedDependencyTaskIds.has(task.id)) {
            try {
              if (hasActiveOverlapBlocker) {
                const transition = await this.store.transitionQueuedEpisode(task.id, {
                  signature: `file-scope:${task.overlapBlockedBy}`,
                  blockedBy: null,
                  overlapBlockedBy: task.overlapBlockedBy ?? null,
                  action: `Auto-recovered: preserved queued status — still blocked by file scope overlap with ${task.overlapBlockedBy}`,
                });
                if (transition.appended) recovered++;
              } else {
                // FN-5434: routine scheduler↔self-healing queued-status churn should stay silent; keep state cleanup only.
                await this.store.updateTask(task.id, { blockedBy: null, overlapBlockedBy: null, status: null });
              }
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              log.error(`Failed to clear stale queued status for ${task.id}: ${errorMessage}`);
            }
          }
          continue;
        }

        const nextBlocker = unresolvedDeps[0] ?? null;
        if (nextBlocker && task.blockedBy !== nextBlocker) {
          try {
            await this.store.updateTask(task.id, { blockedBy: nextBlocker, status: "queued" });
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.error(`Failed to refresh blockedBy for ${task.id}: ${errorMessage}`);
          }
        }
      }

      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Stale blockedBy sweep failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * FNXC:SymbolLock 2026-07-30-14:20:
   * Crash recovery expires only locks whose owner is terminal/missing or whose
   * lease elapsed. It is intentionally orthogonal to scheduler admission and
   * never changes a task, worktree, semaphore, or verification state.
   */
  async reconcileStaleSymbolLocks(): Promise<number> {
    const result = await this.store.reconcileStaleSymbolLocks();
    if (result.reconciled.length > 0) {
      this.symbolLockNoActionAudited = false;
      await this.store.recordRunAuditEvent({
        agentId: "self-healing", runId: "symbol-lock-reconcile", domain: "database",
        mutationType: "symbol-lock:reconcile-stale", target: "symbol-locks",
        metadata: { count: result.reconciled.length, symbolKeys: result.reconciled, outcome: "reconciled" },
      });
      return result.reconciled.length;
    }
    if (!this.symbolLockNoActionAudited) {
      this.symbolLockNoActionAudited = true;
      await this.store.recordRunAuditEvent({
        agentId: "self-healing", runId: "symbol-lock-reconcile", domain: "database",
        mutationType: "symbol-lock:reconcile-stale-no-action", target: "symbol-locks",
        metadata: { count: 0, outcome: "no-action" },
      });
    }
    return 0;
  }

  async reconcileDependencyBlockingLeases(): Promise<number> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;

    let tasks: Task[] = [];
    try {
      tasks = await this.store.listTasks({ includeArchived: false, slim: true });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`reconcileDependencyBlockingLeases: failed to list tasks: ${errorMessage}`);
      return 0;
    }

    const byId = new Map(tasks.map((task) => [task.id, task]));
    const markerAcceptedByTaskId = new Map<string, boolean>();
    if (settings.mergeRequestContractShadowEnabled === true) {
      const dependencyIds = new Set(tasks.flatMap((task) => task.dependencies));
      for (const depId of dependencyIds) {
        markerAcceptedByTaskId.set(depId, (await this.store.getCompletionHandoffAcceptedMarker(depId)) !== null);
      }
    }
    const dependencyOptions = settings.mergeRequestContractShadowEnabled === true
      ? { markerAcceptedByTaskId }
      : undefined;
    const overlapIgnorePaths = settings.overlapIgnorePaths ?? [];
    const filteredScopeByTaskId = new Map<string, string[]>();
    const getFilteredFileScope = async (taskId: string): Promise<string[]> => {
      const cached = filteredScopeByTaskId.get(taskId);
      if (cached) return cached;
      const scope = await this.store.parseFileScopeFromPrompt(taskId);
      const filteredScope = filterPathsByIgnoreList(scope, overlapIgnorePaths, { ignoreHiddenOverlapPaths: settings.ignoreHiddenOverlapPaths });
      filteredScopeByTaskId.set(taskId, filteredScope);
      return filteredScope;
    };

    let recovered = 0;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-22:30 (self-healing cluster):
    The holder must be EXECUTING and the blocked dependency must be WAITING — both resolved.

    Keyed on the literals this sweep could not fire at all on a renamed board: no holder matched
    `in-progress`, so the loop body never ran and a stale file-scope lease blocking an unmet dependency
    was never cleared. The deadlock it exists to break simply persisted.
    */
    const leaseWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
    const leaseHoldColumns = await resolveProjectColumnsForRoles(this.store, ["hold"]);
    for (const holder of tasks) {
      if (!leaseWipColumns.has(holder.column)) continue;
      if (holder.paused === true || holder.userPaused === true) continue;

      const unmetDeps = getUnmetSchedulingDependencies(holder, tasks, dependencyOptions);
      if (unmetDeps.length === 0) continue;

      const holderScope = await getFilteredFileScope(holder.id);
      if (holderScope.length === 0 || isCoordinationOnlyTask(holder, holderScope)) continue;

      let deadlockingDependency: Task | undefined;
      let deadlockEvidence: "stale-overlap-blocker" | "overlapping-todo-dependency" | undefined;
      for (const depId of unmetDeps) {
        const dependency = byId.get(depId);
        if (!dependency) continue;
        if (dependency.overlapBlockedBy === holder.id) {
          deadlockingDependency = dependency;
          deadlockEvidence = "stale-overlap-blocker";
          break;
        }
        if (!leaseHoldColumns.has(dependency.column)) continue;
        const dependencyScope = await getFilteredFileScope(dependency.id);
        if (dependencyScope.length === 0 || isCoordinationOnlyTask(dependency, dependencyScope)) continue;
        if (pathsOverlap(holderScope, dependencyScope)) {
          deadlockingDependency = dependency;
          deadlockEvidence = "overlapping-todo-dependency";
          break;
        }
      }
      if (!deadlockingDependency || !deadlockEvidence) continue;

      const graceMs = settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS;
      const proof = await this.evaluateBackwardMoveTripleProof(holder, {
        stage: "reconcile-dependency-blocking-lease",
        graceMs,
        stalenessAnchor: holder.executionStartedAt ?? holder.updatedAt,
        reason: "dependency-blocking-file-scope-lease",
        extra: {
          holderId: holder.id,
          dependencyId: deadlockingDependency.id,
          unmetDeps,
          deadlockEvidence,
          holderScope,
          dependencyOverlapBlockedBy: deadlockingDependency.overlapBlockedBy ?? null,
        },
      });
      if (!proof.ok) {
        await this.emitBackwardMoveNoAction(
          holder,
          "reconcile-dependency-blocking-lease",
          "task:reconcile-dependency-blocking-lease-no-action",
          proof,
        );
        continue;
      }

      await this.store.moveTask(holder.id, await resolveReboundTargetForTask(this.store, holder.id), {
        preserveProgress: true,
        preserveWorktree: true,
        preserveResumeState: true,
        moveSource: "engine",
        recoveryRehome: true,
      });
      if (deadlockingDependency.overlapBlockedBy === holder.id) {
        await this.store.updateTask(deadlockingDependency.id, { overlapBlockedBy: null, status: null });
      }
      await this.store.logEntry(
        holder.id,
        `Auto-rebounded (FN-6292): released dependency-blocking file-scope lease; dependency ${deadlockingDependency.id} can run before this task resumes`,
      );
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId("fn6292-dependency-blocking-lease", holder.id),
        agentId: "self-healing",
        taskId: holder.id,
        taskLineageId: holder.lineageId,
        phase: "reconcile-dependency-blocking-lease",
      }).database({
        type: "task:reconcile-dependency-blocking-lease" as DatabaseMutationType,
        target: holder.id,
        metadata: {
          holderId: holder.id,
          dependencyId: deadlockingDependency.id,
          unmetDeps,
          deadlockEvidence,
          clearedOverlapBlockedBy: deadlockingDependency.overlapBlockedBy === holder.id,
        },
      });
      recovered++;
    }

    return recovered;
  }

  private evaluateInReviewUnmetDependencyReboundSafety(task: Task, settings: Settings, unmetDeps: string[]): { ok: boolean; stalenessMs: number; reason: string; metadata: Record<string, unknown> } {
    const livePaths = activeSessionRegistry.pathsForTask(task.id);
    const hasActiveRegisteredPath = livePaths.some((path) => activeSessionRegistry.isPathActive(path));
    const sessionDead = !hasActiveRegisteredPath && !executingTaskLock.has(task.id) && this.options.isTaskActive?.(task.id) !== true;
    const anchorMs = task.columnMovedAt ? Date.parse(task.columnMovedAt) : Date.parse(task.updatedAt ?? "");
    const stalenessMs = Number.isFinite(anchorMs) ? Math.max(0, Date.now() - anchorMs) : Number.POSITIVE_INFINITY;
    const ok = sessionDead && !task.checkedOutBy;
    return {
      ok,
      stalenessMs,
      reason: "in-review-unmet-dependencies",
      metadata: {
        taskId: task.id,
        unmetDeps,
        blockedBy: unmetDeps[0] ?? null,
        priorColumn: task.column,
        priorStatus: task.status ?? null,
        priorWorktree: task.worktree ?? null,
        priorBranch: task.branch ?? null,
        stalenessMs,
        sessionDead,
        livePaths,
        hasActiveRegisteredPath,
        hasExecutingTaskLock: executingTaskLock.has(task.id),
        taskActive: this.options.isTaskActive?.(task.id) === true,
        checkedOutBy: task.checkedOutBy ?? null,
        autoMerge: settings.autoMerge ?? null,
      },
    };
  }

  async reconcileCompletedBlockedTasks(): Promise<number> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;
    if (!this.options.recoverCompletedTask) return 0;

    let tasks: Task[] = [];
    try {
      tasks = await this.store.listTasks({ includeArchived: false, slim: true });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`reconcileCompletedBlockedTasks: failed to list tasks: ${errorMessage}`);
      return 0;
    }

    const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
    const completedBlockedHoldColumns = await resolveProjectColumnsForRoles(this.store, ["hold"]);
    let recovered = 0;
    for (const snapshot of tasks) {
      if (snapshot.deletedAt) continue;
      /* FNXC:WorkflowLifecycleColumns 2026-07-31-22:30 (self-healing cluster): a completed-but-blocked
         card is parked in the board's HOLD lane, not necessarily one named `todo`. Keyed on the literal
         this sweep skipped every card on a renamed board, so work whose blocker had cleared stayed
         parked instead of advancing to review. */
      if (!completedBlockedHoldColumns.has(snapshot.column)) continue;
      if (snapshot.paused !== true || snapshot.pausedReason !== COMPLETED_BLOCKED_PAUSE_REASON) continue;
      if (snapshot.userPaused === true) continue;
      if (!allowsAutoMergeProcessing(snapshot, settings)) continue;
      if (executingIds.has(snapshot.id) || this.options.isTaskActive?.(snapshot.id) === true) continue;
      if (snapshot.worktree && activeSessionRegistry.isPathActive(snapshot.worktree)) continue;
      /*
      FNXC:WorkflowLifecycle 2026-07-12-23:40:
      FN-7926: unlike the generic isTaskWorkComplete() convention used elsewhere in self-healing,
      a zero-step task CAN legitimately reach this parked state — parkCompletedBlockedTask()
      already accepts `workComplete = taskDone` for a task with no planned steps (explicit
      fn_task_done() with an empty step list). Since COMPLETED_BLOCKED_PAUSE_REASON is only ever
      set by that already-validated park path, re-deriving completeness by rejecting empty step
      arrays here would strand those rows forever (parked but never reconciled — the same
      indefinite non-terminal stall this task exists to eliminate). Only reject when steps exist
      and are provably incomplete (defense-in-depth against a concurrent reopen after park).
      */
      if (snapshot.steps.length > 0 && !snapshot.steps.every((step) => step.status === "done" || step.status === "skipped")) continue;

      const completionBlocker = await getTaskCompletionBlockerForStore(this.store, snapshot);
      if (completionBlocker) continue;

      try {
        await this.store.updateTask(snapshot.id, {
          paused: false,
          pausedReason: undefined,
          status: null,
          error: null,
          blockedBy: null,
          executeRequeueLoopCount: null,
          executeRequeueLoopSignature: null,
        });
        const fresh = await this.store.getTask(snapshot.id);
        const advanced = await this.options.recoverCompletedTask(fresh);
        if (!advanced) {
          await this.store.updateTask(snapshot.id, {
            paused: true,
            pausedReason: COMPLETED_BLOCKED_PAUSE_REASON,
            status: "queued",
          });
          continue;
        }
        await this.store.logEntry(
          snapshot.id,
          "Auto-advanced completed blocked work to review after blocker cleared",
        );
        await createRunAuditor(this.store, {
          runId: generateSyntheticRunId("completed-blocked-advance", snapshot.id),
          agentId: "self-healing",
          taskId: snapshot.id,
          taskLineageId: snapshot.lineageId,
          phase: "reconcile-completed-blocked",
        }).database({
          type: "task:completed-blocked-advanced" as DatabaseMutationType,
          target: snapshot.id,
          metadata: {
            taskId: snapshot.id,
            priorColumn: snapshot.column,
            priorStatus: snapshot.status ?? null,
            source: "self-healing",
          },
        });
        recovered++;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`reconcileCompletedBlockedTasks: failed to advance ${snapshot.id}: ${errorMessage}`);
      }
    }

    return recovered;
  }

  async reconcileInReviewUnmetDependencies(): Promise<number> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return 0;

    let tasks: Task[] = [];
    try {
      tasks = await this.store.listTasks({ includeArchived: false, slim: true });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`reconcileInReviewUnmetDependencies: failed to list tasks: ${errorMessage}`);
      return 0;
    }

    const markerAcceptedByTaskId = new Map<string, boolean>();
    if (settings.mergeRequestContractShadowEnabled === true) {
      const dependencyIds = new Set(tasks.flatMap((task) => task.dependencies));
      for (const depId of dependencyIds) {
        markerAcceptedByTaskId.set(depId, (await this.store.getCompletionHandoffAcceptedMarker(depId)) !== null);
      }
    }
    const dependencyOptions = settings.mergeRequestContractShadowEnabled === true
      ? { markerAcceptedByTaskId }
      : undefined;

    let recovered = 0;
    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-22:30 (self-healing cluster):
    REVIEW_ROLES, not the literal: a card whose declared dependencies are still unmet must be rebounded
    from whichever lane this board reviews in. Keyed on `in-review` the sweep never matched a renamed
    board, so a card sat in review with unmet dependencies and no rebound.
    */
    const unmetDepReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
    for (const task of tasks) {
      if (!unmetDepReviewColumns.has(task.column) || task.deletedAt) continue;

      const unmetDeps = getUnmetSchedulingDependencies(task, tasks, dependencyOptions);
      if (unmetDeps.length === 0) continue;

      /*
      FNXC:DependencyGating 2026-06-20-09:22:
      In-review tasks with unmet dependencies must never be silently wedged. If a guard or store mutation prevents the rebound, emit the FN-6793 no-action audit event with the blocking reason so operators can distinguish allowed terminal holds from lifecycle bugs.
      */
      if (task.paused === true || task.userPaused === true) {
        await this.emitBackwardMoveNoAction(
          task,
          "reconcile-in-review-unmet-dependencies",
          "task:reconcile-in-review-unmet-dependencies-no-action",
          {
            stalenessMs: 0,
            reason: "in-review-unmet-dependencies-paused",
            metadata: {
              taskId: task.id,
              unmetDeps,
              blockedBy: unmetDeps[0] ?? null,
              priorColumn: task.column,
              priorStatus: task.status ?? null,
              paused: task.paused === true,
              userPaused: task.userPaused === true,
              reason: "paused-guard",
            },
          },
        );
        continue;
      }

      if (!allowsAutoMergeProcessing(task, settings)) {
        await this.emitBackwardMoveNoAction(
          task,
          "reconcile-in-review-unmet-dependencies",
          "task:reconcile-in-review-unmet-dependencies-no-action",
          {
            stalenessMs: 0,
            reason: "in-review-unmet-dependencies-auto-merge-disabled",
            metadata: {
              taskId: task.id,
              unmetDeps,
              blockedBy: unmetDeps[0] ?? null,
              priorColumn: task.column,
              priorStatus: task.status ?? null,
              autoMerge: settings.autoMerge ?? null,
              taskAutoMerge: task.autoMerge ?? null,
              reason: "auto-merge-processing-disabled",
            },
          },
        );
        continue;
      }

      const proof = this.evaluateInReviewUnmetDependencyReboundSafety(task, settings, unmetDeps);
      if (!proof.ok) {
        await this.emitBackwardMoveNoAction(
          task,
          "reconcile-in-review-unmet-dependencies",
          "task:reconcile-in-review-unmet-dependencies-no-action",
          proof,
        );
        continue;
      }

      try {
        await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), {
          preserveProgress: true,
          preserveWorktree: true,
          preserveResumeState: true,
          moveSource: "engine",
          recoveryRehome: true,
          bypassGuards: true,
        });
        await this.store.updateTask(task.id, { status: "queued", blockedBy: unmetDeps[0] });
        await this.store.logEntry(
          task.id,
          `Auto-rebounded (FN-6793): in-review task had unmet dependencies: ${unmetDeps.join(", ")}`,
        );
        await createRunAuditor(this.store, {
          runId: generateSyntheticRunId("fn6793-in-review-unmet-dependencies", task.id),
          agentId: "self-healing",
          taskId: task.id,
          taskLineageId: task.lineageId,
          phase: "reconcile-in-review-unmet-dependencies",
        }).database({
          type: "task:reconcile-in-review-unmet-dependencies" as DatabaseMutationType,
          target: task.id,
          metadata: {
            taskId: task.id,
            unmetDeps,
            blockedBy: unmetDeps[0] ?? null,
            priorColumn: "in-review",
            priorStatus: task.status ?? null,
          },
        });
        recovered++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.emitBackwardMoveNoAction(
          task,
          "reconcile-in-review-unmet-dependencies",
          "task:reconcile-in-review-unmet-dependencies-no-action",
          {
            stalenessMs: proof.stalenessMs,
            reason: "in-review-unmet-dependencies-rebound-failed",
            metadata: {
              ...proof.metadata,
              reason: "rebound-mutation-failed",
              error: message,
            },
          },
        );
      }
    }

    return recovered;
  }

  async reconcileSelfDefeatingDependencies(): Promise<number> {
    const targetColumns: Array<Task["column"]> = ["triage", "todo"];
    let recovered = 0;

    for (const column of targetColumns) {
      let tasks: Task[] = [];
      try {
        tasks = await this.store.listTasks({ column, slim: true });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`reconcileSelfDefeatingDependencies: failed to list ${column} tasks: ${errorMessage}`);
        continue;
      }

      for (const task of tasks) {
        if (!task.dependencies.length) continue;

        const match = detectSelfDefeatingDependency(task.title, task.dependencies);
        if (!match) continue;

        const originalDependencies = [...task.dependencies];
        const nextDependencies = originalDependencies.filter((dep) => dep.toUpperCase() !== match.operandTaskId.toUpperCase());
        if (nextDependencies.length === originalDependencies.length) continue;

        try {
          await this.store.updateTask(task.id, { dependencies: nextDependencies });
          await this.store.logEntry(
            task.id,
            `Auto-reconciled self-defeating dependency: removed ${match.operandTaskId} (matched verb: "${match.matchedVerb}") from dependencies.`,
          );

          const auditor = createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-heal-self-defeating-dep", task.id),
            agentId: "system:self-healing",
            taskId: task.id,
            phase: "reconcile-self-defeating-dep",
          });
          await auditor.database({
            type: "task:auto-reconciled-self-defeating-dep",
            target: task.id,
            metadata: {
              matchedVerb: match.matchedVerb,
              operandTaskId: match.operandTaskId,
              originalDependencies,
              nextDependencies,
            },
          });
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`reconcileSelfDefeatingDependencies: failed for ${task.id}: ${errorMessage}`);
        }
      }
    }

    return recovered;
  }

  async reconcileDependencyCycles(): Promise<number> {
    const umbrellaPrefix = /^(umbrella|epic|parent|coordinate|coordination|track(?:er)?|meta)\b/i;
    let recovered = 0;
    let tasks: Task[] = [];

    try {
      tasks = await this.store.listTasks({ includeArchived: false, slim: true });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`reconcileDependencyCycles: failed to list tasks: ${errorMessage}`);
      return recovered;
    }

    const taskLookup = new Map(tasks.map((task) => [task.id, task] as const));
    const dependencyLookup = new Map(tasks.map((task) => [task.id, task.dependencies] as const));
    const seenCycleSignatures = new Set<string>();

    for (const task of tasks) {
      if (task.deletedAt) continue;
      if (!task.dependencies.length) continue;

      try {
        const cyclePath = detectDependencyCycle(task.id, task.dependencies, (id) => dependencyLookup.get(id));
        if (!cyclePath) continue;

        const cycleMembers = Array.from(new Set(cyclePath));
        const cycleSignature = [...cycleMembers].sort((a, b) => a.localeCompare(b)).join(">");
        if (seenCycleSignatures.has(cycleSignature)) continue;
        seenCycleSignatures.add(cycleSignature);

        const targetTaskId = [...cycleMembers].sort((a, b) => a.localeCompare(b))[0] ?? task.id;
        const targetTask = taskLookup.get(targetTaskId) ?? task;
        const auditor = createRunAuditor(this.store, {
          runId: generateSyntheticRunId("self-heal-dependency-cycle", targetTaskId),
          agentId: "system:self-healing",
          taskId: targetTaskId,
          phase: "reconcile-dependency-cycles",
        });

        await auditor.database({
          type: "task:dependency-cycle-detected",
          target: targetTaskId,
          metadata: {
            taskId: targetTaskId,
            cyclePath,
            dependencies: targetTask.dependencies,
          },
        });

        const isTwoNodeCycle = cyclePath.length === 3 && cyclePath[0] === cyclePath[2];
        const otherNodeId = isTwoNodeCycle
          ? cyclePath.find((id) => id.toUpperCase() !== targetTaskId.toUpperCase())
          : undefined;
        const otherNodeTask = otherNodeId ? taskLookup.get(otherNodeId) : undefined;
        const targetIsUmbrella = Boolean(targetTask.title && umbrellaPrefix.test(targetTask.title));
        const otherIsUmbrella = Boolean(otherNodeTask?.title && umbrellaPrefix.test(otherNodeTask.title));

        let foundationChildId: string | undefined;
        let umbrellaTaskId: string | undefined;
        if (isTwoNodeCycle && otherNodeId) {
          if (targetIsUmbrella && !otherIsUmbrella) {
            umbrellaTaskId = targetTaskId;
            foundationChildId = otherNodeId;
          } else if (!targetIsUmbrella && otherIsUmbrella) {
            umbrellaTaskId = otherNodeId;
            foundationChildId = targetTaskId;
          }
        }

        const foundationTask = foundationChildId ? taskLookup.get(foundationChildId) : undefined;
        const umbrellaTask = umbrellaTaskId ? taskLookup.get(umbrellaTaskId) : undefined;
        const umbrellaDependsOnFoundation = Boolean(
          umbrellaTask && foundationChildId
            && umbrellaTask.dependencies.some((dep) => dep.toUpperCase() === foundationChildId.toUpperCase()),
        );
        const foundationDependsOnUmbrella = Boolean(
          foundationTask && umbrellaTaskId
            && foundationTask.dependencies.some((dep) => dep.toUpperCase() === umbrellaTaskId.toUpperCase()),
        );

        if (isTwoNodeCycle && foundationTask && foundationChildId && umbrellaTaskId && umbrellaDependsOnFoundation && foundationDependsOnUmbrella) {
          const nextDependencies = foundationTask.dependencies.filter((dep) => dep.toUpperCase() !== umbrellaTaskId.toUpperCase());
          if (nextDependencies.length !== foundationTask.dependencies.length) {
            await this.store.updateTask(foundationChildId, { dependencies: nextDependencies });
            await this.store.logEntry(
              foundationChildId,
              `Auto-cleared umbrella back-edge: removed ${umbrellaTaskId} from dependencies (cycle: ${cyclePath.join(" → ")})`,
            );
            await auditor.database({
              type: "task:auto-reconciled-dependency-cycle",
              target: foundationChildId,
              metadata: {
                removedDependency: umbrellaTaskId,
                cyclePath,
                reason: "umbrella-back-edge",
              },
            });
            recovered++;
            continue;
          }
        }

        await auditor.database({
          type: "task:dependency-cycle-unrepaired",
          target: targetTaskId,
          metadata: {
            cyclePath,
            reason: "ambiguous-cycle",
          },
        });
        log.warn(`Dependency cycle detected for ${targetTaskId}: ${cyclePath.join(" → ")} — left unchanged (ambiguous)`);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`reconcileDependencyCycles: failed for ${task.id}: ${errorMessage}`);
      }
    }

    return recovered;
  }

  private async recordIntegrityAudit(taskId: string, mutationType: "task:finalize-unproven-blocked" | "task:finalize-lost-work-blocked" | "task:no-commits-finalize-blocked-incomplete-steps" | "task:integrity-reconcile-modified-files" | "task:integrity-warning" | "task:auto-recover-stale-merger-status", metadata: Record<string, unknown>): Promise<void> {
    const auditor = createRunAuditor(this.store, {
      runId: generateSyntheticRunId("self-healing-integrity", taskId),
      agentId: "self-healing",
      taskId,
      phase: "self-healing",
    });
    await auditor.database({ type: mutationType, target: taskId, metadata });
  }

  /**
   * FN-5092 watchdog: detect and repair tasks left in an impossible state where
   * `column ∈ {done, archived}` but `status ∈ {merging, merging-pr}`.
   *
   * Cause: a recovery path (FN-4499 misbinding, FN-4500 already-on-main, manual
   * finalization) moved the task to done WITHOUT going through the merger's
   * `completeTask()`. The merger had previously set `status = "merging"` when it
   * claimed `mergeActive[taskId]`; that slot is single-threaded and now leaks,
   * stalling the entire merger queue for every subsequent in-review task.
   *
   * This watchdog catches the persistent-state half of the leak. The runtime
   * in-memory `mergeActive` Map also has a periodic reconciler in
   * `ProjectEngine.reconcileStaleMergeActive()`, but it skips entries that match
   * the currently-active merge task; a status leak that survives across engine
   * restarts can only be cleared at the storage layer.
   */
  async reconcileStaleMergerStatus(): Promise<number> {
    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, sixteenth sweep):
      A card that reached a terminal lane while still carrying `merging`/`merging-pr` holds the merger
      queue. Two literal reads meant that on a renamed board the stale status was never cleared, so one
      finished card blocked the queue for every task behind it.

      ONE union read, not two buckets: unlike the sweeps before it, nothing here treats complete and
      archived differently — the only filter is on `status` — so splitting them would add a distinction
      the code does not make. Deduped, because the two roles can share a column (the P1 on #2879).
      */
      const terminalColumns = await resolveProjectColumnsForRoles(this.store, TERMINAL_ROLES);
      const terminalById = new Map<string, Task>();
      for (const column of terminalColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) terminalById.set(task.id, task);
      }
      const candidates = [...terminalById.values()].filter((task) => {
        const s = task.status;
        return s === "merging" || s === "merging-pr";
      });
      if (candidates.length === 0) return 0;

      let cleared = 0;
      for (const task of candidates) {
        try {
          const previousStatus = task.status;
          const updatedAtMs = Date.parse(task.updatedAt ?? "") || Date.now();
          const ageMs = Math.max(0, Date.now() - updatedAtMs);
          await this.store.updateTask(task.id, { status: null });
          await this.recordIntegrityAudit(task.id, "task:auto-recover-stale-merger-status", {
            previousColumn: task.column,
            previousStatus,
            ageMs,
            mergeConfirmed: task.mergeDetails?.mergeConfirmed === true,
            commitSha: task.mergeDetails?.commitSha ?? null,
          });
          await this.store.logEntry(
            task.id,
            `Auto-recovered: cleared stale status="${previousStatus}" on ${task.column} task (age ${Math.round(ageMs / 1000)}s) — was blocking merger queue`,
          );
          cleared++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`reconcileStaleMergerStatus: failed for ${task.id}: ${errorMessage}`);
        }
      }
      if (cleared > 0) {
        log.warn(`Cleared ${cleared} stale merger-status leak${cleared === 1 ? "" : "s"} on done/archived tasks (FN-5092)`);
      }
      return cleared;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`reconcileStaleMergerStatus failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * FNXC:NearDuplicateDetection 2026-07-17-20:10:
   * FN-8356 reconciles only triage-marker duplicate-decision pauses whose canonical is no longer
   * actionable. Its audit payload is ids/outcomes-only so stale-decision recovery never stores
   * prompt or decision prose; active canonicals and user-owned pauses remain untouched.
   */
  async reconcileStaleDuplicateDecisionPause(): Promise<number> {
    try {
      const tasks = await this.store.listTasks({ slim: true, includeArchived: false, limit: 500 });
      const candidates = tasks.filter((task) =>
        task.paused === true
        && task.userPaused !== true
        && task.pausedReason === "duplicate-decision-required"
        && task.sourceMetadata?.duplicateSource === "triage-marker"
        && typeof task.sourceMetadata?.nearDuplicateOf === "string",
      );

      let cleared = 0;
      for (const task of candidates.slice(0, 50)) {
        try {
          const canonicalId = task.sourceMetadata!.nearDuplicateOf as string;
          const canonical = await this.store.getTask(canonicalId).catch(() => null);
          const canonicalFlags = await resolveNearDuplicateCanonicalFlags(this.store, canonical);
          if (!isNearDuplicateCanonicalInactive(canonical ?? undefined, canonicalFlags)) continue;

          /*
          FNXC:NearDuplicateDetection 2026-08-01-18:47:
          Stale-decision recovery for an inactive canonical is the same writer as marker clear:
          needs-replan (not status:null) plus dismissal so the card cannot look planning-finished
          without a real PROMPT. Drop a still-present DUPLICATE marker file when present.
          */
          const promptPath = join(this.options.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
          const written = existsSync(promptPath) ? readFileSync(promptPath, "utf-8") : "";
          const duplicateResolution = resolveExplicitDuplicateMarker(written, task.title);
          const canonicalMarkerId = canonicalId.toUpperCase();
          /*
          FNXC:DuplicateIntake 2026-08-09-02:54:
          FN-8840 requires stale-decision recovery to fail closed when PROMPT.md and the title
          disagree, or when either points to a different canonical than the stale metadata. Never
          erase either operator redirect or release its decision hold without an unambiguous match.
          */
          if (duplicateResolution.conflict
            || (duplicateResolution.marker && duplicateResolution.marker.canonicalId !== canonicalMarkerId)) {
            continue;
          }
          if (duplicateResolution.source === "prompt") {
            try {
              rmSync(promptPath, { force: true });
            } catch {
              // best-effort marker removal; status write still proceeds
            }
          }
          if (resolveExplicitDuplicateMarker(null, task.title).marker?.canonicalId === canonicalMarkerId) {
            await this.store.updateTask(task.id, { title: `Duplicate redirect cleared: ${canonicalMarkerId}` });
          }
          await this.store.updateTask(task.id, buildMarkerClearedReplanTaskPatch(canonicalId));
          if (typeof this.store.logEntry === "function") {
            await Promise.resolve(this.store.logEntry(
              task.id,
              TRIAGE_MARKER_CLEARED_REPLAN_LOG_ACTION,
              buildInactiveDuplicateClearFeedback(canonicalId),
            )).catch(() => {});
          }
          await createRunAuditor(this.store, {
            runId: generateSyntheticRunId("reconcile-stale-duplicate-decision", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "reconcile-stale-duplicate-decision",
          }).database({
            type: "task:reconcile-stale-duplicate-decision" as DatabaseMutationType,
            target: task.id,
            metadata: {
              taskId: task.id,
              canonicalId,
              canonicalColumn: canonical?.column ?? null,
              canonicalDeleted: Boolean(canonical?.deletedAt),
              priorPausedReason: "duplicate-decision-required",
            },
          });
          cleared += 1;
        } catch (error) {
          log.warn(`reconcileStaleDuplicateDecisionPause: failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return cleared;
    } catch (error) {
      log.error(`reconcileStaleDuplicateDecisionPause failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  /*
  FNXC:LegacyAdoption 2026-07-19-04:20 (U9b / R10 / KTD-8):
  Startup adoption sweep — the live CONSUMER of the KTD-8 adoption table. U9 landed the
  table and the census that keeps it complete, but nothing ever called it, so no
  pre-cutover row was actually adopted: `planning` / `needs-replan` /
  `plan-review-unavailable` rows kept a legacy status whose writers U3 deleted, and the
  graph had no owning node to re-enter. That is the "frozen row" this exists to prevent.

  Runs at STARTUP (not steady state): adoption is a once-per-upgrade concern, and
  `legacyAdoptedAt` makes it idempotent so a restart loop cannot re-clear a status a human
  re-set or re-park a row an operator un-parked. `planLegacyAdoption` is shared with the
  store-open reconcile so the two cannot drift.

  User pauses are never disturbed — an operator park outranks adoption.

  FNXC:LegacyAdoption 2026-07-19-09:00 (PR #2335 review):
  Paginates until the active census is drained instead of scanning only the newest 500
  rows. `listTasks` orders by (created_at, id), so a capped single fetch would re-read the
  same newest page on every restart and leave older legacy rows frozen forever — the exact
  R10 failure this sweep exists to prevent. Offset pagination is stable: adoption patches
  never change created_at and adopted rows stay in the active list. Each page stays bounded
  (500) so startup never materializes the whole table at once; `legacyAdoptedAt` keeps the
  drained sweep idempotent across restarts.
  */
  async adoptLegacyTaskRows(): Promise<number> {
    try {
      const now = new Date().toISOString();
      const pageSize = 500;
      let offset = 0;
      let adopted = 0;

      for (;;) {
        const tasks = await this.store.listTasks({ slim: true, includeArchived: false, limit: pageSize, offset });
        for (const task of tasks) {
          // An operator park is authoritative; adoption must not reach through it.
          if (task.userPaused === true) continue;

          const plan = planLegacyAdoption(
            {
              status: task.status,
              reviewLevel: task.reviewLevel,
              enabledWorkflowSteps: task.enabledWorkflowSteps,
              legacyAdoptedAt: task.legacyAdoptedAt,
            },
            now,
          );
          if (plan.action === "skip" || !plan.patch) continue;

          try {
            await this.store.updateTask(task.id, plan.patch);
            await createRunAuditor(this.store, {
              runId: generateSyntheticRunId("reconcile-legacy-adoption", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "reconcile-legacy-adoption",
            }).database({
              type: plan.auditType ?? "task:reconcile-legacy-adoption",
              target: task.id,
              // ids/counts/outcomes only — `reason` is a fixed adoption-table note, never row prose.
              metadata: {
                taskId: task.id,
                action: plan.action,
                priorStatus: task.status ?? null,
                column: task.column,
                backfilledStepCount: plan.patch.enabledWorkflowSteps?.length ?? 0,
                reason: plan.reason,
              },
            });
            adopted += 1;
          } catch (error) {
            log.warn(`adoptLegacyTaskRows: failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (tasks.length < pageSize) break;
        offset += tasks.length;
      }
      if (adopted > 0) log.log(`Legacy adoption sweep adopted ${adopted} pre-cutover row(s)`);
      return adopted;
    } catch (error) {
      log.error(`adoptLegacyTaskRows failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  /**
   * FNXC:WorkflowColumns 2026-07-26-18:30:
   * Re-home a card whose column its workflow no longer declares.
   *
   * A workflow's column set is editable, and the built-in coding workflows just merged Todo into
   * Planning — so a live board can hold rows pointing at a column that is gone. Such a row is
   * invisible to every trait-driven sweep (`findColumn` returns undefined, so it carries no hold, wip,
   * or intake flags), which means nothing schedules it, nothing releases it, and it renders in a
   * column the board no longer draws. It is stranded in the most literal sense.
   *
   * The repair is the same one KTD-10 already defines for a recovered card: `resolveReboundTarget`
   * (the workflow's hold column, else its intake column, else its first). Deliberately conservative —
   * it only ever touches a row whose column is UNDECLARED, never one the operator merely disagrees
   * with, and it leaves operator parks (`userPaused`) alone.
   */
  /** The task's persisted workflow selection id, or undefined when it has none (which
   *  legitimately resolves to the default workflow). A sentinel marks an unreadable
   *  selection, which is itself grounds not to guess. */
  private async readTaskWorkflowSelectionForRebound(taskId: string): Promise<string | undefined> {
    try {
      const selection = this.store.getTaskWorkflowSelectionAsync
        ? await this.store.getTaskWorkflowSelectionAsync(taskId)
        : this.store.getTaskWorkflowSelection?.(taskId);
      return selection?.workflowId ?? undefined;
    } catch {
      return UNREADABLE_WORKFLOW_SELECTION;
    }
  }

  /** True when the workflow id resolves to a definition (built-in or stored). */
  private async canResolveWorkflowDefinition(workflowId: string): Promise<boolean> {
    if (workflowId === UNREADABLE_WORKFLOW_SELECTION) return false;
    /*
    FNXC:WorkflowColumns 2026-07-29-00:00 (PR #2600 review — greptile):
    EXISTENCE, not prefix. `isBuiltinWorkflowId` accepts any `builtin:`-prefixed string, so
    a stale selection like `builtin:removed-workflow` passed this proof — and an unknown
    built-in id resolves to the default coding IR, meaning the card was still re-homed
    against a workflow that is not its own. That is the exact hole this guard was added to
    close, reproduced by the guard itself. `getBuiltinWorkflow` returns the definition or
    undefined, so it answers "does this exist" rather than "is it spelled like a built-in".
    */
    if (getBuiltinWorkflow(workflowId)) return true;
    if (isBuiltinWorkflowId(workflowId)) return false;
    try {
      return Boolean(await this.store.getWorkflowDefinition(workflowId));
    } catch {
      return false;
    }
  }

  async reconcileUndeclaredTaskColumns(): Promise<number> {
    try {
      const pageSize = 500;
      let offset = 0;
      let rehomed = 0;

      for (;;) {
        const tasks = await this.store.listTasks({ slim: true, includeArchived: false, limit: pageSize, offset });
        for (const task of tasks) {
          if (task.userPaused === true) continue;
          let ir;
          try {
            ir = await resolveWorkflowIrForTask(this.store, task.id);
          } catch {
            continue; // Defensive only — see the note below; the resolver does not reject.
          }
          if (!ir || workflowHasColumn(ir, task.column)) continue;
          const target = resolveReboundTarget(ir);
          if (!target || target === task.column) continue;

          /*
          FNXC:WorkflowColumns 2026-07-29-00:00 (U12 — the guard above could not fire):
          PROVE the resolved IR belongs to THIS task before moving its card.

          The `catch` above was dead code. `resolveWorkflowIrById` catches every failure and
          returns `defaultCodingWorkflowIr()`, and `resolveWorkflowIrForTask` does the same
          for a failed selection read — so the resolver never rejects, and its comment ("do
          not guess a column") described protection that did not exist. A card whose
          workflow could not be loaded was judged against the DEFAULT workflow and re-homed
          to the DEFAULT's rebound target: the sweep guessed, using a workflow that is not
          the card's own, which is the one outcome the guard was written to prevent. Found
          while trying to make a test of that guard fail (PR #2543) and being unable to.

          The check runs HERE, not at resolution, for two reasons: it costs one definition
          read only for a card otherwise about to be MOVED (rare — a healthy board reaches
          this line for nobody), and it keeps the fix inside the sweep rather than changing a
          resolver whose soft-failure many other callers depend on.

          A task with NO selection legitimately resolves to the default workflow, so only a
          selection naming a workflow we cannot load counts as unresolvable.
          */
          const selectionForProof = await this.readTaskWorkflowSelectionForRebound(task.id);
          if (selectionForProof && !(await this.canResolveWorkflowDefinition(selectionForProof))) {
            log.warn(
              `reconcileUndeclaredTaskColumns: skipping ${task.id} — its workflow '${selectionForProof}' could not be loaded, so any rebound target would be a guess`,
            );
            continue;
          }

          try {
            await this.store.moveTask(task.id, target as Task["column"], {
              moveSource: "engine",
              /*
              FNXC:WorkflowColumns 2026-07-27-06:10 (PR #2462 review):
              `recoveryRehome`, not just `bypassGuards`. Adjacency is checked SEPARATELY from the
              guards (moves.ts: only `recoveryRehome` skips `resolveAllowedColumns`), and this card's
              SOURCE column is undeclared too — so `resolveAllowedColumns(ir, fromColumn)` returns []
              and every target is rejected. Without this flag the sweep threw on every candidate and
              left the card exactly where it was stranded: a repair that never repaired anything.
              */
              recoveryRehome: true,
              bypassGuards: true,
              preserveProgress: true,
            });
            rehomed += 1;
            await createRunAuditor(this.store, {
              runId: generateSyntheticRunId("reconcile-undeclared-column", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "reconcile-undeclared-column",
            }).database({
              type: "task:reconcile-undeclared-column",
              target: task.id,
              // ids/outcomes only.
              metadata: { taskId: task.id, priorColumn: task.column, toColumn: target },
            }).catch(() => undefined);
          } catch (error) {
            log.warn(
              `reconcileUndeclaredTaskColumns: failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (tasks.length < pageSize) break;
        offset += tasks.length;
      }
      if (rehomed > 0) log.log(`Re-homed ${rehomed} task(s) out of a column their workflow no longer declares`);
      return rehomed;
    } catch (error) {
      log.error(`reconcileUndeclaredTaskColumns failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  /**
   * FNXC:StrandedHoldContinuation 2026-07-26-12:00:
   * A real prompt can survive a hard planning cancel after its continuation is
   * lost. Re-seed only candidate cards through the conditional store operation;
   * never force-promote or replace an active continuation. Healthy cards remain
   * silent so run-audit is not flooded by normal graph ownership.
   */
  async reconcileStrandedHoldContinuations(): Promise<number> {
    try {
      const graceMs = 60_000;
      let offset = 0;
      let repaired = 0;
      const live = (taskId: string) => activeSessionRegistry.pathsForTask(taskId).some((path) => activeSessionRegistry.isPathActive(path)) || executingTaskLock.has(taskId) || this.options.isTaskActive?.(taskId) === true;
      const evaluate = async (taskId: string) => {
        const task = await this.store.getTask(taskId);
        if (!task) return null;
        const freshSettings = await this.store.getSettings();
        const freshEnginePaused = freshSettings.globalPause === true || freshSettings.enginePaused === true;
        const ir = await resolveWorkflowIrForTask(this.store, task.id);
        if (!("columns" in ir)) return null;
        const column = ir.columns.find((entry) => entry.id === task.column);
        if (!column) return null;
        const continuations = await this.store.listWorkflowWorkItemsForTask(task.id);
        let promptContent: string | null = null;
        try { promptContent = await readFile(getPromptPath(this.store.getTasksDir(), task.id), "utf8"); } catch { /* missing prompts are quiet non-candidates */ }
        return {
          task,
          ir,
          continuations,
          result: evaluateStrandedHoldContinuation({
            task, columnFlags: resolveColumnFlags(column), ir, continuations,
            stepResults: task.workflowStepResults, effectiveSettings: { autoMerge: resolveEffectiveAutoMerge(task, freshSettings) },
            enginePaused: freshEnginePaused, promptContent, live: live(task.id),
            stalenessMs: Date.now() - new Date(task.columnMovedAt ?? task.updatedAt).getTime(), graceMs,
            now: Date.now(),
          }),
        };
      };
      for (;;) {
        const tasks = await this.store.listTasks({ slim: false, includeArchived: false, includeDeleted: false, limit: 500, offset });
        for (const snapshot of tasks) {
          try {
            const initial = await evaluate(snapshot.id);
            if (!initial || !initial.result.candidate) continue;
            const audit = async (type: "task:reconcile-stranded-hold-continuation" | "task:reconcile-stranded-hold-continuation-no-action", reason?: string, state = initial) => {
              const key = `${state.task.id}:${reason ?? "seeded"}`;
              if (type.endsWith("no-action") && this.strandedHoldContinuationNoActionAudited.has(key)) return;
              await createRunAuditor(this.store, { runId: generateSyntheticRunId("reconcile-stranded-hold-continuation", state.task.id), agentId: "self-healing", taskId: state.task.id, taskLineageId: state.task.lineageId, phase: "reconcile-stranded-hold-continuation" }).database({ type: type as DatabaseMutationType, target: state.task.id, metadata: type.endsWith("no-action") ? { taskId: state.task.id, column: state.task.column, reason } : { taskId: state.task.id, column: state.task.column, nodeId: "plan-review", workflowName: state.ir.name, continuationCount: state.continuations.length, stalenessMs: Math.max(0, Date.now() - new Date(state.task.columnMovedAt ?? state.task.updatedAt).getTime()) } });
              // FNXC:StrandedHoldContinuation 2026-07-26-23:59: Mark only a successfully persisted no-action event so a transient audit failure remains visible on the next maintenance pass.
              if (type.endsWith("no-action")) this.strandedHoldContinuationNoActionAudited.add(key);
            };
            if (!initial.result.stranded) { await audit("task:reconcile-stranded-hold-continuation-no-action", initial.result.reason); continue; }
            // FNXC:PlanningDependencyReseed 2026-08-04-04:10:
            // Re-read and seed under the same cross-process lifecycle lock used
            // by dependency invalidation and planning finalization. A dependency
            // mutation that wins first is therefore visible to this predicate;
            // one that wins second supersedes the continuation after it commits.
            const reconcileUnderLifecycleLock = async () => {
              const fresh = await evaluate(snapshot.id);
              if (!fresh || !fresh.result.stranded) {
                if (fresh) await audit("task:reconcile-stranded-hold-continuation-no-action", fresh.result.reason, fresh);
                return false;
              }
              const seeded = await seedPreReleasePlanReviewContinuation(this.store, fresh.task, fresh.ir, { atomic: true });
              if (!seeded.seeded) {
                await audit("task:reconcile-stranded-hold-continuation-no-action", seeded.reason, fresh);
                return false;
              }
              await audit("task:reconcile-stranded-hold-continuation", undefined, fresh);
              return true;
            };
            const lifecycleLock = (this.store as Partial<TaskStore>).withPlanningLifecycleLock;
            const seeded = lifecycleLock
              ? await lifecycleLock.call(this.store, snapshot.id, reconcileUnderLifecycleLock)
              : await reconcileUnderLifecycleLock();
            if (seeded) repaired += 1;
          } catch (error) { log.warn(`reconcileStrandedHoldContinuations: failed for ${snapshot.id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (tasks.length < 500) break;
        offset += tasks.length;
      }
      return repaired;
    } catch (error) {
      log.warn(`reconcileStrandedHoldContinuations failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  /*
  FNXC:OrphanedPendingSteps 2026-07-22-16:20 (FN-8492 incident):
  Consumer of `resolveOrphanedPendingStepResults` — the U9b helper shipped with NO caller
  (the same gap U9 left for the adoption table), so an engine restart that killed an
  in-flight pre-merge step session left its `pending` workflowStepResult behind forever.
  The merge gate read it as "incomplete pre-merge workflow steps", surfaced an identical
  stall every 30 minutes, and after 3 stalls the deadlock disposer parked the task `failed`
  (FN-8492: Code Review died in the 21:29 restart, task parked two hours later).

  FNXC:OrphanedPendingSteps 2026-07-22-16:35 (review follow-up, same day):
  Orphans are REWRITTEN to status:"failed" (never deleted) — deleting a pending review
  entry silently satisfied the merge gate and FN-8492 merged with Code Review skipped; the
  failed rewrite keeps the gate closed and hands re-run/bypass to the existing
  failed-pre-merge-steps recovery and FN-7720 operator-bypass paths.

  Runs at startup (right after legacy adoption) AND in periodic maintenance: a step
  session can die without an engine restart, and waiting for the next boot leaves the
  task riding the 3×30-min stall escalator to a deadlock park. Liveness uses the
  canonical triple (activeSessionRegistry path, executingTaskLock, isTaskActive) — live
  workflow-step sessions register their worktree path (kind "workflow-step") for their
  whole run, so a live review always vetoes. `in-progress` rows are skipped entirely:
  they are executor-owned and `resumeOrphaned()` re-attaches their sessions on a
  DEFERRED timer (getResumeOrphanDelayMs, ~30s), so at startup their liveness cannot be
  proven yet and must not be judged here. The row is re-read immediately before the
  write so the whole-array update cannot clobber a lease written after the page
  snapshot. User pauses are never disturbed.
  */
  /*
  FNXC:StalledCardWatchdog 2026-07-26-19:40 (FN-8596 class):
  The BACKSTOP for "a card must never sit waiting". Every other sweep in this file recovers a KNOWN
  strand shape; this one exists for the shapes nobody has enumerated yet. FN-8596 was exactly that:
  a card sat in `triage` doing nothing for ten minutes with a finished spec, and no sweep, log, or
  audit event named it — the strand was only found because a human noticed the board.

  DETECT-ONLY, deliberately. It emits a run-audit event and a warning; it does NOT move, requeue,
  pause, or fail anything. A generic mutator racing the specialized sweeps is precisely the class of
  bug this file keeps fixing, so recovery stays with the sweep that owns each shape and this one
  guarantees visibility. Emitting the shape (column/status/whether a continuation or session exists)
  is what makes the next unknown strand diagnosable in one query instead of an archaeology session.

  A card counts as stalled when ALL hold:
    - it is in a non-terminal column (done/archived are finished, not waiting),
    - nothing is executing it (executing set + executingTaskLock + live session registry),
    - it has no ACTIVE workflow continuation queued to resume it,
    - it is not paused (an operator park is a deliberate wait, not a stall),
    - and it has not been touched for longer than the stall floor.
  Deduped per (taskId, shape) so a genuinely parked card does not re-emit every sweep.
  */
  private readonly stalledCardSignatures = new Map<string, string>();

  async detectStalledCards(): Promise<number> {
    try {
      const settings = await this.store.getSettings().catch(() => undefined);
      if (settings?.globalPause === true || settings?.enginePaused === true) return 0;

      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const now = Date.now();
      const tasks = await this.store.listTasks({ slim: true, includeArchived: false });
      let detected = 0;
      const seen = new Set<string>();

      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-10:40 (fleet phase — self-healing terminal-lane cluster):
      "Has this card finished?" asked by id skips every renamed board, so the sweep silently treats a
      finished card as live. Resolved once per sweep via the project union — over-inclusion is free
      here because the per-card check below still discards, and the union needs no per-task workflow
      selection (docs/solutions/workflow-learnings/project-union-versus-per-task-lanes.md).
      */
      const sweepTerminalColumns = await resolveProjectColumnsForRoles(this.store, TERMINAL_ROLES);
      for (const task of tasks) {
        if (sweepTerminalColumns.has(task.column)) continue;
        if (task.paused === true || task.userPaused === true) continue;
        if (executingIds.has(task.id) || executingTaskLock.has(task.id)) continue;
        if (this.options.isTaskActive?.(task.id) === true) continue;
        const livePaths = activeSessionRegistry.pathsForTask(task.id);
        if (livePaths.some((path) => activeSessionRegistry.isPathActive(path))) continue;

        const touchedAt = Date.parse(task.updatedAt ?? task.columnMovedAt ?? "");
        if (!Number.isFinite(touchedAt) || now - touchedAt < STALLED_CARD_WATCHDOG_MS) continue;

        // An active continuation means something IS queued to resume this card — not a stall.
        let hasContinuation = false;
        try {
          const items = await this.store.listWorkflowWorkItemsForTask?.(task.id, { kinds: ["task"] }) ?? [];
          hasContinuation = items.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state));
        } catch {
          // Unknown continuation state — assume one exists so the watchdog never cries wolf.
          hasContinuation = true;
        }
        if (hasContinuation) continue;

        seen.add(task.id);
        const signature = `${task.column}|${task.status ?? "null"}`;
        if (this.stalledCardSignatures.get(task.id) === signature) continue;
        this.stalledCardSignatures.set(task.id, signature);
        detected += 1;

        const idleMinutes = Math.floor((now - touchedAt) / 60_000);
        log.warn(
          `Stalled card ${task.id}: idle ${idleMinutes}m in '${task.column}' (status=${task.status ?? "null"}) `
          + "with no live session and no queued continuation — nothing is scheduled to advance it",
        );
        try {
          await createRunAuditor(this.store, {
            runId: generateSyntheticRunId("stalled-card-watchdog", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "detect-stalled-cards",
          }).database({
            type: "task:stall-watchdog-detected",
            target: task.id,
            // ids/counts/outcomes only — never spec text, error prose, or reviewer output.
            metadata: {
              taskId: task.id,
              column: task.column,
              status: task.status ?? null,
              idleMinutes,
              hasWorktree: Boolean(task.worktree),
              stepCount: task.steps?.length ?? 0,
            },
          });
        } catch (error) {
          log.warn(`detectStalledCards: audit emit failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Forget cards that recovered, so a future stall on the same card re-alerts.
      for (const id of [...this.stalledCardSignatures.keys()]) {
        if (!seen.has(id)) this.stalledCardSignatures.delete(id);
      }
      return detected;
    } catch (error) {
      log.error(`detectStalledCards failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  async reconcileOrphanedPendingStepResults(): Promise<number> {
    try {
      /* Resolved once per sweep, outside the paging loop, so a large board still pays one resolve. */
      const orphanedPendingWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const pageSize = 500;
      let offset = 0;
      let recovered = 0;
      // FNXC:WorkflowReviewGates 2026-07-26-15:55: read once per sweep, used only to LABEL the
      // audit event (needsOperatorBypass). This sweep takes no auto-merge-dependent action.
      const settings = await this.store.getSettings().catch(() => undefined);

      const isSessionLive = (taskId: string): boolean => {
        const livePaths = activeSessionRegistry.pathsForTask(taskId);
        return livePaths.some((path) => activeSessionRegistry.isPathActive(path))
          || executingTaskLock.has(taskId)
          || this.options.isTaskActive?.(taskId) === true;
      };

      for (;;) {
        const tasks = await this.store.listTasks({ slim: true, includeArchived: false, limit: pageSize, offset });
        for (const task of tasks) {
          // An operator park is authoritative; this sweep must not reach through it.
          if (task.userPaused === true) continue;
          /*
          FNXC:WorkflowResolvedColumns 2026-07-31-16:45 (fleet, self-healing round 2):
          The executor-owned skip is a WIP-ROLE question. Keyed on the id it stopped firing on a renamed
          board, so this sweep would rewrite `pending` step results out from under a LIVE executor run —
          the one thing its own header says it must never do.
          */
          if (orphanedPendingWipColumns.has(task.column)) continue;
          if (!task.workflowStepResults?.some((result) => result.status === "pending")) continue;
          if (isSessionLive(task.id)) continue;

          // Re-read the live row before mutating: the page snapshot can be stale against
          // a merger/planner that wrote a fresh pending lease after the page was fetched.
          const fresh = await this.store.getTask(task.id);
          if (!fresh || fresh.userPaused === true || orphanedPendingWipColumns.has(fresh.column)) continue;
          /*
          FNXC:WorkflowReviewGates 2026-07-26-15:50:
          Honor a LIVE review-gate lease, not just in-process session liveness.
          Plan Review has always had lease semantics here (`classifyReviewLease`: a `leaseOwner`
          with a `startedAt` inside the staleness floor is adopted, never re-dispatched), but the
          `code-review` / `browser-verification` optional groups write a bare `pending` record with
          no such guard. That asymmetry became reachable when those gates moved into `in-review`:
          this sweep also runs from PERIODIC MAINTENANCE, in the same live process as an active
          graph run, so a tick landing between the lease write and the session-registry
          registration could stamp a gate that just started — and is genuinely running — as
          `failed`, closing the merge gate against a task nothing is wrong with.
          Treating a within-floor lease as live closes that window. It does NOT defeat FN-8492: a
          lease past the floor classifies as `reclaim` and is still marked failed, so cleanup of a
          genuinely dead lease is delayed by at most the staleness floor — the same floor Plan
          Review already relies on. Restart-orphaned gates are unaffected in substance: nothing
          re-attaches an in-review graph run after a restart, so those leases simply age out and
          are then marked failed as before.
          */
          /*
          FNXC:PlanReviewLease 2026-07-26-20:26:
          FN-8603 follow-up. The paragraph above accepts that "restart-orphaned gates simply age
          out" — that acceptance is what cost FN-8603 ~14 minutes of dead wait after an engine
          restart killed its Code Review session 34s in. Passing this node's identity lets
          classifyReviewLease reclaim a lease THIS node's previous process took (proven dead: it
          predates our boot) without touching the floor that protects peer-owned and legacy
          unattributed leases. When localNodeId is unset the argument is undefined and behavior is
          exactly as before.
          */
          const localNodeLeaseIdentity = this.options.localNodeId
            ? { nodeId: this.options.localNodeId, processBootAt: this.processBootStartedAt }
            : undefined;
          const hasLiveReviewLease = (result: WorkflowStepResult): boolean => {
            if (!result.leaseOwner || !result.startedAt) return false;
            return classifyReviewLease(
              [result],
              result.workflowStepId,
              Date.now(),
              PLAN_REVIEW_LEASE_STALENESS_MS,
              localNodeLeaseIdentity,
            ).kind === "adopt";
          };
          const { results, orphanedCount } = resolveOrphanedPendingStepResults<WorkflowStepResult>(
            fresh.workflowStepResults,
            (result) => isSessionLive(task.id) || hasLiveReviewLease(result),
            {
              output: "Step session did not survive an engine restart or crash; marked failed by self-healing (FN-8492).",
              completedAt: new Date().toISOString(),
            },
          );
          if (orphanedCount === 0) continue;

          try {
            await this.store.updateTask(task.id, { workflowStepResults: results });
            // Counted on the successful mutation; a failed audit emit below must not
            // understate how many tasks were actually recovered.
            recovered += 1;
          } catch (error) {
            log.warn(`reconcileOrphanedPendingStepResults: failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
            continue;
          }
          try {
            await createRunAuditor(this.store, {
              runId: generateSyntheticRunId("reconcile-orphaned-pending-steps", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "reconcile-orphaned-pending-step-results",
            }).database({
              type: "task:reconcile-orphaned-pending-step-results",
              target: task.id,
              /*
              FNXC:WorkflowReviewGates 2026-07-26-15:55:
              `needsOperatorBypass` labels the case that has no automatic way out. When the row is
              not auto-merge-eligible (`autoMerge:false` / PR-based human-review contract),
              `recoverReviewTasksWithFailedPreMergeSteps` deliberately skips it, so the `failed`
              result this sweep just wrote will never be auto-recovered — the only resolution is an
              operator running `fn_task_bypass_review` / `POST /tasks/:id/bypass-review` (FN-7720).
              Without this flag the event is indistinguishable from an ordinary auto-recoverable
              rewrite, and the board shows only a generic merge-blocked badge, so the card sits
              silently. Metadata stays ids/counts/outcomes-only — this is a boolean label, and the
              event takes no lifecycle action, so the autoMerge:false terminal-until-human contract
              is untouched.
              */
              // ids/counts/outcomes only — never step output or reviewer prose.
              metadata: {
                taskId: task.id,
                column: task.column,
                orphanedCount,
                resultCount: results.length,
                needsOperatorBypass: settings ? !allowsAutoMergeProcessing(fresh, settings) : undefined,
              },
            });
          } catch (error) {
            log.warn(`reconcileOrphanedPendingStepResults: audit emit failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (tasks.length < pageSize) break;
        offset += tasks.length;
      }
      if (recovered > 0) log.log(`Marked orphaned pending step results failed on ${recovered} task(s)`);
      return recovered;
    } catch (error) {
      log.error(`reconcileOrphanedPendingStepResults failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  /**
   * Backward lifecycle move gated on triple proof (FN-5335).
   * When the unproven fallback predicate fails, emits `task:finalize-no-op-review-no-action` and skips lifecycle mutation.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async finalizeNoOpReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-22:00 (the query-filter class, seventh sweep):
      `listTasks({ column: "in-review" })` returned EMPTY on a renamed board, so a task whose branch has
      NO commits ahead of base — a genuine no-op merge — was never finalised and sat in review forever.

      Activation check run first: this sweep is one of the four holding both a literal query and an
      unwired `getTaskMergeBlocker`. Widening the read alone would have made it find renamed-board cards
      and then decline every one, so the guard is wired in the same change.

      Lane set precomputed per card so the candidate filter stays synchronous; one resolution feeds both
      the lane test and the blocker.
      */
      const noOpReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const noOpById = new Map<string, Task>();
      for (const column of noOpReviewColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) noOpById.set(task.id, task);
      }
      const tasks = [...noOpById.values()];
      const noOpIrCache = new Map<string, WorkflowIr>();
      const unresolvedNoOpCards: string[] = [];
      const noOpLanesByTask = new Map<string, ReadonlySet<string>>();
      for (const task of tasks) {
        const resolved = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id, noOpIrCache)
          .catch(() => undefined);
        const own = resolved
          ? [...new Set(REVIEW_ROLES.flatMap((role) => columnsWithFlag(resolved.ir, role)))]
          : [];
        if (!resolved || resolved.source === "default") unresolvedNoOpCards.push(task.id);
        /* DELIBERATE-LITERAL — the unresolvable-workflow default, reviewed 2026-07-30-22:00. */
        noOpLanesByTask.set(task.id, own.length > 0 ? new Set(own) : new Set(["in-review"]));
      }
      if (unresolvedNoOpCards.length > 0) {
        log.warn(
          `no-op review finalize: ${unresolvedNoOpCards.length} card(s) measured against the built-in `
          + `review lane because their own workflow could not be resolved `
          + `(${unresolvedNoOpCards.slice(0, 5).join(", ")}); a renamed review lane there stays unfinalised.`,
        );
      }
      const candidates = tasks.filter((t) =>
        (noOpLanesByTask.get(t.id) ?? new Set(["in-review"])).has(t.column) &&
        allowsAutoMergeProcessing(t, settings) &&
        !t.paused &&
        // FNXC:AutoMergeHold 2026-07-09-17:10: FN-7750 intentionally keeps the pure branchContext-shape predicate here. Stale shared-group members must stay OUT of solo no-op finalize even when their group is not live; only the positive auto-merge-off exemption gates use the live-group predicate.
        !isSharedBranchGroupMemberIntegration(t) &&
        // FNXC:Workspace 2026-06-22-14:10 (Phase D review A — workspace single-commit-finalize gate):
        // This no-op finalize classifies one branch against one base over `this.options.rootDir`
        // and moveTask(done)+emitTaskMerged on it. The `Boolean(t.worktree)` gate already excludes
        // workspace tasks (their `task.worktree` is null; per-repo worktrees live in
        // `workspaceWorktrees`); `!isWorkspaceTask(t)` makes that exclusion explicit and defensive.
        Boolean(t.worktree) &&
        !isWorkspaceTask(t) &&
        t.mergeDetails?.mergeConfirmed !== true &&
        t.status !== "merging" &&
        t.status !== "merging-pr" &&
        t.status !== "awaiting-user-review" &&
        t.status !== "failed" &&
        /* Wired: unwired, this would decline every card the widened read now finds. */
        getTaskMergeBlocker(t, { reviewColumns: noOpLanesByTask.get(t.id) ?? new Set(["in-review"]) }) === undefined,
      );

      if (candidates.length === 0) return 0;

      let recovered = 0;
      const mergeTargetBranch = await resolveIntegrationBranch(this.options.rootDir, settings);
      for (const task of candidates) {
        const ahead = await this.isBranchAheadOfBase(task, task.mergeDetails?.mergeTargetBranch || mergeTargetBranch);
        if (!ahead || ahead.aheadCount !== 0) continue;

        const classification = await classifyOwnedLandedEvidenceForSelfHealing(this.options.rootDir, task, ahead.baseRef);

        if (classification.kind === "unproven") {
          // FN-4811 follow-up: dedupe across engine restarts. The in-memory Set only
          // dedupes within one process; persist the first-warning state on
          // mergeDetails.integrityWarning so subsequent sweep runs (after restart) skip
          // re-emitting an identical log entry.
          const alreadyWarned =
            this.finalizeUnprovenWarned.has(task.id) ||
            (task.mergeDetails?.integrityWarning?.reason === classification.reason);
          if (!alreadyWarned) {
            this.finalizeUnprovenWarned.add(task.id);
            await this.store.logEntry(
              task.id,
              `Finalize blocked: unproven ownership evidence (${classification.reason}); no owned landed commit was found — auto-retrying via todo requeue`,
              JSON.stringify(classification.details, null, 2),
            );
            await this.store.updateTask(task.id, {
              mergeDetails: {
                ...(task.mergeDetails || {}),
                integrityWarning: {
                  warnedAt: new Date().toISOString(),
                  reason: classification.reason,
                },
              },
            });
          } else {
            // Hydrate the in-memory dedup Set from the persisted record so subsequent
            // checks in this process don't have to re-query the task.
            this.finalizeUnprovenWarned.add(task.id);
          }
          await this.recordIntegrityAudit(task.id, "task:finalize-unproven-blocked", {
            reason: classification.reason,
            details: classification.details,
            autoRetry: true,
          });
          const proof = await this.evaluateBackwardMoveTripleProof(task, {
            stage: "finalize-no-op-review",
            graceMs: settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
            stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
            reason: "finalize-unproven-candidate",
          });
          if (!proof.ok) {
            await this.emitBackwardMoveNoAction(task, "finalize-no-op-review", "task:finalize-no-op-review-no-action", proof);
            continue;
          }
          // #1411: backward recovery — skip order-derived adjacency.
          await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
          continue;
        }

        const mergedAt = new Date().toISOString();
        if (classification.kind === "owned-commit") {
          const mergeCommitMessage = await regenerateBareMergeSubject({
            subject: classification.commit.subject,
            commitSha: classification.commit.sha,
            branch: task.branch ?? "",
            taskId: task.id,
            rootDir: this.options.rootDir,
            settings,
          });
          const mergeDetails: MergeDetails = {
            ...(task.mergeDetails || {}),
            commitSha: classification.commit.sha,
            filesChanged: classification.commit.filesChanged,
            insertions: classification.commit.insertions,
            deletions: classification.commit.deletions,
            mergeCommitMessage,
            mergeConfirmed: true,
            mergedAt,
            mergeTargetBranch: ahead.baseRef,
          };
          await this.store.updateTask(task.id, { mergeDetails });
          await this.store.logEntry(task.id, `Auto-finalized: recovered owned landed commit ${classification.commit.sha.slice(0, 8)}`);
        } else {
          // FN-5490/FN-5517/FN-5526/FN-5540 guard: same lost-work check as
          // merger.ts:aiMergeTask. The self-heal path was the historical
          // primary site of the bug — it would clear `modifiedFiles: []`
          // (line below) while moving the task to Done, silently destroying
          // the audit trail of the lost work. Now we refuse to finalize and
          // move the task back to todo with progress preserved so the next
          // executor run can re-attempt.
          const noCommitsFinalize = evaluateNoCommitsNoOpFinalize(task);
          if (noCommitsFinalize.blocked) {
            const reason = noCommitsFinalize.reason ?? "no-commits task has incomplete work with no net branch changes";
            /*
             * FNXC:Lifecycle 2026-06-14-20:14:
             * FN-6461/FN-6455 requires self-healing no-op finalization to demote no-commits tasks with incomplete/skipped work and set an error so stranded-todo recovery will not immediately re-promote them.
             */
            await this.store.updateTask(task.id, { error: reason });
            await this.store.logEntry(
              task.id,
              `Finalize blocked (no-commits incomplete-work guard): ${reason} — moving back to todo with progress preserved`,
              JSON.stringify({
                doneCount: noCommitsFinalize.doneCount,
                incompleteCount: noCommitsFinalize.incompleteCount,
                classification: "proven-no-op",
                baseRef: classification.baseRef,
                lane: "self-healing-finalize-no-op-review",
              }, null, 2),
            );
            await this.recordIntegrityAudit(task.id, "task:no-commits-finalize-blocked-incomplete-steps", {
              reason,
              doneCount: noCommitsFinalize.doneCount,
              incompleteCount: noCommitsFinalize.incompleteCount,
              classification: "proven-no-op",
              baseRef: classification.baseRef,
              lane: "self-healing-finalize-no-op-review",
            });
            // #1411: backward recovery — skip order-derived adjacency.
            await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
            recovered++;
            continue;
          }
          if (task.modifiedFiles && task.modifiedFiles.length > 0) {
            await this.store.logEntry(
              task.id,
              `Finalize blocked (lost-work guard): task claims ${task.modifiedFiles.length} modifiedFiles but classification would finalize as no-op — moving back to todo with progress preserved`,
              JSON.stringify({
                modifiedFilesSample: task.modifiedFiles.slice(0, 5),
                classification: "proven-no-op",
                baseRef: classification.baseRef,
              }, null, 2),
            );
            await this.recordIntegrityAudit(task.id, "task:finalize-lost-work-blocked", {
              modifiedFilesCount: task.modifiedFiles.length,
              classification: "proven-no-op",
              baseRef: classification.baseRef,
            });
            // #1411: backward recovery — skip order-derived adjacency.
            await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
            recovered++;
            continue;
          }
          const noOpReason = `branch has zero commits ahead of ${classification.baseRef}`;
          const mergeDetails: MergeDetails = {
            ...(task.mergeDetails || {}),
            mergeConfirmed: true,
            noOpMerge: true,
            noOpReason,
            landedFiles: [],
            mergedAt,
            mergeTargetBranch: classification.baseRef,
          };
          // FN-5092 hotfix: clear transient merger-queue status alongside mergeDetails
          // patch so a leaked `mergeActive` slot from a prior merge attempt cannot survive
          // this auto-finalize path. Same bug class as recoverBranchMisboundInReviewTasks().
          await this.store.updateTask(task.id, { mergeDetails, modifiedFiles: [], status: null, error: null, paused: false });
          await this.recordIntegrityAudit(task.id, "task:integrity-reconcile-modified-files", {
            reason: "proven-no-op-finalize",
            clearedCount: task.modifiedFiles?.length ?? 0,
          });
          await this.store.logEntry(task.id, `Auto-finalized no-op (proven): start point on ${classification.baseRef}; modifiedFiles cleared`);
        }

        const completeLane = (await resolveTaskLifecycleColumns(this.store, task.id))?.complete ?? "done";
const movedTask = await this.store.moveTask(task.id, completeLane);
        this.emitTaskMerged(movedTask, { mergeConfirmed: true });
        recovered++;
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} no-op review task(s) → done`);
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`No-op review finalization failed: ${errorMessage}`);
      return 0;
    }
  }

  async reconcileDoneTaskIntegrity(): Promise<number> {
    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-16:50 (the query-filter class, now unblocked):
      THE QUERY WAS THE BUG, not the comparison below it. `listTasks({ column: "done" })` returns an
      EMPTY array on a board whose complete lane is renamed, so this sweep never ran — proven in
      `self-healing-query-filter-blindness.test.ts` (#2800), which asserts the query ARGUMENT because
      the outcome is 0 either way.

      `resolveProjectColumnsForRoles` is the seam that fix needed: a read happens before any task is in
      hand, so there is nothing to resolve a per-task lane from. It answers the PROJECT-level question —
      every column any workflow here declares for the role — and unions the legacy ids, so a board
      mid-rename still surfaces rows stored under the old one.

      Same three-line shape as `stale-task-reporter` and `backlog-pressure-reporter`: resolve the roles,
      iterate the set, dedupe by id.

      FNXC:WorkflowResolvedColumns 2026-07-30-17:20 (#2838 review — greptile P1):
      THE PROJECT UNION IS FOR THE QUERY, NEVER FOR THE PER-CARD TEST. My first version re-asserted
      `completeColumns.has(task.column)`, which is the flat-set mistake `project-lane-vocabulary.ts`
      warns about in its own header — a card is claimed as complete because SOME OTHER workflow in the
      project calls its column complete. On a project with two boards, one naming its wip lane the same
      as another's complete lane, this sweep would rewrite merge evidence onto a card still being worked.

      Widening the read and widening the verdict are different decisions. The read must over-include
      (a missed row is invisible); the verdict must not (a wrong row is a write). So the candidate filter
      resolves each card against ITS OWN workflow.
      */
      const completeColumns = await resolveProjectColumnsForRoles(this.store, ["complete"]);
      const byId = new Map<string, Task>();
      for (const column of completeColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) byId.set(task.id, task);
      }
      const shortlist = [...byId.values()].filter((task) =>
        (!task.mergeDetails?.commitSha || task.mergeDetails.commitSha.trim().length === 0) &&
        (task.modifiedFiles?.length ?? 0) > 0,
      );
      const perTaskIrCache = new Map<string, WorkflowIr>();
      const candidates: Task[] = [];
      /* Cards whose own workflow could not be resolved. Collected so an unrepairable backlog is
         reportable rather than silent — see the provenance note in the loop. */
      const unresolvedWorkflowCards: string[] = [];
      for (const task of shortlist) {
        if (candidates.length >= DONE_TASK_INTEGRITY_SWEEP_LIMIT) break;
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-17:55 (#2838 review — greptile P1, "workflow fallback
        drops renamed completions"):

        PROVENANCE, BECAUSE THIS RESOLVER DOES NOT FAIL — IT SUBSTITUTES.

        `resolveWorkflowIrForTask` degrades to the BUILT-IN coding IR rather than throwing, so the
        `.catch(() => undefined)` protected almost nothing: when a task's selection cannot be resolved
        the call SUCCEEDS and hands back a board whose complete lane is `done`. The old line then read
        `ownComplete.length > 0` as "this card answered", so a renamed-lane card was measured against
        the built-in vocabulary, rejected, and — because this sweep is the thing that would have
        repaired its missing merge evidence — rejected again on every subsequent sweep.

        The provenance form separates "the card's own workflow says complete = X" from "nobody could
        say, here is the default". Only the first is an answer.

        THE VERDICT IS DELIBERATELY UNCHANGED, AND I MEASURED THAT RATHER THAN ASSUMING IT. My first
        version also gated `ownComplete` on the provenance, which READS like the fix and is inert: a
        defaulted card resolves to the built-in `complete = ["done"]`, and gating it to `[]` falls
        through to the literal `done` — the same verdict by a different route. Mutating the gate away
        left the suite green, which is how I found it. Shipping it would have been a conversion that
        scores as a win and changes nothing, so it is gone.

        The verdict SHOULD stay conservative here: this sweep WRITES merge evidence, and guessing a lane
        to rewrite history onto the wrong card is worse than leaving one unrepaired. What the provenance
        buys is the thing that was actually missing — the unresolvable card is now REPORTED instead of
        being indistinguishable from a card that answered, so "unrepaired" stops meaning "unrepairable
        and invisible forever".
        */
        const resolved = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id, perTaskIrCache)
          .catch(() => undefined);
        const ownComplete = resolved ? columnsWithFlag(resolved.ir, "complete") : [];
        /* A THROW is unresolvable too. Checking only `source === "default"` left the rarer path — the
           resolver raising rather than substituting — silently discarded, which is the same invisibility
           this change exists to remove, one branch over. */
        if (!resolved || resolved.source === "default") unresolvedWorkflowCards.push(task.id);
        /* DELIBERATE-LITERAL — the degraded per-card default, reviewed 2026-07-30-17:20. Reached when the
           card's own workflow could not be resolved AT ALL, or resolves and declares no complete lane. The
           project union must not stand in here: that is the flat-set mistake this filter exists to avoid,
           so the legacy id is the conservative answer. The census ratchet flagged this line when it
           appeared, which is the guard working. */
        const isComplete = ownComplete.length > 0 ? ownComplete.includes(task.column) : task.column === "done";
        if (isComplete) candidates.push(task);
      }

      if (unresolvedWorkflowCards.length > 0) {
        log.warn(
          `done-task integrity sweep: ${unresolvedWorkflowCards.length} card(s) measured against the `
          + `built-in complete lane because their own workflow could not be resolved `
          + `(${unresolvedWorkflowCards.slice(0, 5).join(", ")}); a renamed completion lane there stays unrepaired.`,
        );
      }

      if (candidates.length === 0) return 0;
      const settings = await this.store.getSettings();
      const mergeTargetBranch = await resolveIntegrationBranch(this.options.rootDir, settings);

      let reconciled = 0;
      for (const task of candidates) {
        const classification = await classifyOwnedLandedEvidenceForSelfHealing(this.options.rootDir, task, mergeTargetBranch);
        if (classification.kind === "owned-commit") {
          const mergeCommitMessage = await regenerateBareMergeSubject({
            subject: classification.commit.subject,
            commitSha: classification.commit.sha,
            branch: task.branch ?? "",
            taskId: task.id,
            rootDir: this.options.rootDir,
            settings,
          });
          this.finalizeUnprovenWarned.delete(task.id);
          await this.store.updateTask(task.id, {
            mergeDetails: {
              ...(task.mergeDetails || {}),
              integrityWarning: undefined,
              commitSha: classification.commit.sha,
              filesChanged: classification.commit.filesChanged,
              insertions: classification.commit.insertions,
              deletions: classification.commit.deletions,
              mergeCommitMessage,
            },
          });
          await this.recordIntegrityAudit(task.id, "task:integrity-reconcile-modified-files", {
            reason: "recovered-owned-commit",
            commitSha: classification.commit.sha,
          });
          reconciled++;
          continue;
        }

        if (classification.kind === "proven-no-op") {
          this.finalizeUnprovenWarned.delete(task.id);
          await this.store.updateTask(task.id, {
            modifiedFiles: [],
            mergeDetails: {
              ...(task.mergeDetails || {}),
              integrityWarning: undefined,
              mergeConfirmed: true,
              noOpMerge: true,
              noOpReason: `branch has zero commits ahead of ${classification.baseRef}`,
              landedFiles: [],
            },
          });
          await this.recordIntegrityAudit(task.id, "task:integrity-reconcile-modified-files", {
            reason: "proven-no-op",
            clearedCount: task.modifiedFiles?.length ?? 0,
          });
          reconciled++;
          continue;
        }

        if (classification.kind === "no-changes-finalized") {
          this.finalizeUnprovenWarned.delete(task.id);
          await this.store.updateTask(task.id, {
            modifiedFiles: [],
            mergeDetails: {
              ...(task.mergeDetails || {}),
              integrityWarning: undefined,
              mergeConfirmed: true,
              noOpMerge: true,
              noOpReason: "verification-only finalize: no branch and no owned commits",
              landedFiles: [],
            },
          });
          await this.recordIntegrityAudit(task.id, "task:integrity-reconcile-modified-files", {
            reason: "verification-only-finalize",
            clearedCount: task.modifiedFiles?.length ?? 0,
            baseRef: classification.baseRef,
            details: classification.details,
          });
          await this.store.logEntry(
            task.id,
            "Finalize: verification-only task — no owned commits and no branch; cleared stale modifiedFiles snapshot",
          );
          reconciled++;
          continue;
        }

        // FN-4811 follow-up: dedupe across engine restarts (see matching block above).
        const alreadyWarned =
          this.finalizeUnprovenWarned.has(task.id) ||
          (task.mergeDetails?.integrityWarning?.reason === classification.reason);
        if (!alreadyWarned) {
          this.finalizeUnprovenWarned.add(task.id);
          await this.store.logEntry(
            task.id,
            `Integrity warning: done-task finalize evidence is unproven (${classification.reason})`,
            JSON.stringify(classification.details, null, 2),
          );
          await this.store.updateTask(task.id, {
            mergeDetails: {
              ...(task.mergeDetails || {}),
              integrityWarning: {
                warnedAt: new Date().toISOString(),
                reason: classification.reason,
              },
            },
          });
          await this.recordIntegrityAudit(task.id, "task:integrity-warning", {
            reason: classification.reason,
            modifiedFilesCount: task.modifiedFiles?.length ?? 0,
            details: classification.details,
          });
        } else {
          this.finalizeUnprovenWarned.add(task.id);
        }
      }

      return reconciled;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Done-task integrity reconciliation failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover `in-review` tasks that are fully mergeable but never had
   * `mergeTask()` invoked.
   *
   * This catches races where a task reached review, retained its worktree,
   * and then got stranded without a merger loop to finish the branch.
   *
   * @returns Number of tasks merged or finalized to done
   */
  async recoverMergeableReviewTasks(): Promise<number> {
    try {
      // Respect user merge intent. Without these gates the sweep would
      // silently merge tasks even when the operator has opted into a
      // PR-based review flow (`autoMerge: false`, `mergeStrategy:
      // "pull-request"`) — see GitHub issue #21.
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-20:20 (the query-filter class, fifth sweep):
      Fifth application of the four-part shape in
      `docs/solutions/architecture-patterns/self-healing-sweeps-are-blind-on-a-renamed-board.md`.
      `listTasks({ column: "in-review" })` returns EMPTY on a renamed board, so a card that is genuinely
      ready to merge — every step done, no blocker — was never re-enqueued and sat in review forever.

      Read via the project union; verdict per card against its own workflow, because this sweep enqueues
      a MERGE; provenance so an unresolvable card is reported rather than silently skipped.
      */
      const mergeableReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const mergeableById = new Map<string, Task>();
      for (const column of mergeableReviewColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) mergeableById.set(task.id, task);
      }
      const tasks = [...mergeableById.values()];
      const mergeableIrCache = new Map<string, WorkflowIr>();
      const unresolvedMergeableCards: string[] = [];
      /*
      Returns the card's OWN review lanes, so one resolution feeds BOTH consumers below — the lane test
      and `getTaskMergeBlocker`. Two resolutions of the same fact is how the halves of one decision drift.
      */
      const ownReviewLanesFor = async (task: Task): Promise<ReadonlySet<string>> => {
        const resolved = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id, mergeableIrCache)
          .catch(() => undefined);
        const own = resolved
          ? [...new Set(REVIEW_ROLES.flatMap((role) => columnsWithFlag(resolved.ir, role)))]
          : [];
        if (!resolved || resolved.source === "default") unresolvedMergeableCards.push(task.id);
        /* DELIBERATE-LITERAL — the unresolvable-workflow default, reviewed 2026-07-30-20:20. */
        return own.length > 0 ? new Set(own) : new Set(["in-review"]);
      };
      /*
      FNXC:WorkflowReviewGates 2026-07-26-15:30:
      Liveness gate, mirroring `recoverGhostReviewTasks` and
      `recoverReviewTasksWithFailedPreMergeSteps` which already filter on `executingIds`. This
      sweep was the odd one out, and that became reachable once the pre-merge review gates moved
      into `in-review`: the graph commits the column crossing at node ENTRY and only then writes the
      gate's `pending` lease (two DB round trips later), so there is a durable window where the card
      is in `in-review` with every step done and NO pre-merge result yet. `getTaskMergeBlocker`
      blocks on pending/failed RESULTS and has no notion of "enabled but resultless", so in that
      window it returns undefined and this sweep would enqueue a merge with Code Review never run.
      The graph run holds `executingTaskLock` for its whole duration, so excluding executing tasks
      closes the window; it only defers the merge until the run releases the lock, which it must do
      before the task is genuinely finished with its pre-merge gates.
      Same hazard class as FN-8492 (the merge gate reasons about results, not about enablement) —
      but a different manifestation: there the entry was stale, here it does not exist yet.
      */
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      /*
      FNXC:SharedBranchMemberHold 2026-08-05-23:14:
      Recovery is a merge requester, not merely cleanup. It must use the same
      member→group admission rule as ProjectEngine: an open intermediate group
      keeps mission-policy/inherited Off flowing, while an operator-authored Off
      remains a durable manual hold. Filtering only with allowsAutoMergeProcessing
      stranded mission members whenever the project switch was Off and, conversely,
      would enqueue a user hold when the project switch was On.
      */
      const canRecoverMergeableReviewTask = async (task: Task): Promise<boolean> => {
        if (hasSharedBranchMemberAutoMergeHold(task, settings)) return false;

        const groupId = task.branchContext?.groupId?.trim();
        const branchGroup = groupId ? await this.store.getBranchGroup(groupId) : null;
        const projectDefaultBranch = await resolveIntegrationBranch(this.options.rootDir, settings);
        if (isLiveSharedBranchGroupMemberIntegration(task, branchGroup, projectDefaultBranch)) {
          return true;
        }

        /*
        FNXC:SharedBranchMemberHold 2026-08-05-23:22:
        A stale or default-branch group is not an intermediate member integration.
        Its false task value must retain the standalone manual-hold path even when
        the project switch is On; recovery must not turn that durable hold into a
        fresh merge request merely because it runs after the graph paused.
        */
        return allowsAutoMergeProcessing(task, settings)
          && resolveEffectiveAutoMerge(task, settings) !== false;
      };
      const mergeAdmission = await Promise.all(tasks.map(async (task) => [
        task.id,
        await canRecoverMergeableReviewTask(task),
      ] as const));
      const mergeAdmissionByTaskId = new Map(mergeAdmission);
      const mergeable = tasks.filter((t) =>
        mergeAdmissionByTaskId.get(t.id) === true &&
        !t.paused &&
        !executingIds.has(t.id) &&
        t.status !== "failed" &&
        // Exclude transient merge statuses. Active merges should be left alone;
        // stale ones are handled by recoverStaleMergingStatus().
        t.status !== "merging" &&
        t.status !== "merging-pr" &&
        // FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD1 — admit workspace tasks):
        // A workspace task has task.worktree===null (its worktrees live per-repo in
        // workspaceWorktrees), so the old `Boolean(t.worktree)` gate skipped a zero-landed
        // mergeable workspace task FOREVER. Admit `isWorkspaceTask(t)` so a workspace task whose
        // merge enqueue was dropped is re-enqueued via enqueueMerge → idempotent landWorkspaceTask.
        (Boolean(t.worktree) || isWorkspaceTask(t)) &&
        t.mergeDetails?.mergeConfirmed !== true &&
        t.mergeDetails?.noOpMerge !== true &&
        !hasTerminalInvalidDoneTransition(t) &&
        // Mirror ProjectEngine.canMergeTask retry gate. If retries are already
        // exhausted, re-enqueueing here is a no-op and each recovery log write
        // refreshes updatedAt, preventing cooldown-based retries from ever
        // becoming eligible. Also skip tasks explicitly tagged as no-op merges
        // in case updateTask(moveTask) is briefly out-of-order during recovery.
        (t.mergeRetries ?? 0) < maxAutoMergeRetries,
      );
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-20:20 (widening a query makes a dormant guard REACHABLE):
      `getTaskMergeBlocker` moved out of the synchronous filter above because it needs this card's
      resolved review lanes, and those need an await.

      This matters beyond tidiness. That call was previously UNWIRED — it took the legacy `in-review`
      default — and was harmless only because the literal query above meant a renamed board never reached
      it. Widening the read makes it reachable for the first time, so left as-is it would have refused
      every card on exactly the boards this fix is for: the sweep would find them and then decline them.

      Converting a query is therefore not just a read change; it activates every guard downstream of it.
      */
      const laneQualifiedMergeable: Task[] = [];
      for (const task of mergeable) {
        const reviewColumns = await ownReviewLanesFor(task);
        if (!reviewColumns.has(task.column)) continue;
        if (getTaskMergeBlocker(task, { reviewColumns }) !== undefined) continue;
        laneQualifiedMergeable.push(task);
      }
      if (unresolvedMergeableCards.length > 0) {
        log.warn(
          `mergeable-review recovery: ${unresolvedMergeableCards.length} card(s) measured against the `
          + `built-in review lane because their own workflow could not be resolved `
          + `(${unresolvedMergeableCards.slice(0, 5).join(", ")}); a renamed review lane there stays stuck.`,
        );
      }
      const ownershipFlags = await Promise.all(
        laneQualifiedMergeable.map((task) => this.isMergeLaneOwned(task.id)),
      );
      const unownedMergeable = laneQualifiedMergeable.filter((_, i) => !ownershipFlags[i]);

      const inReviewIds = new Set(tasks.map((task) => task.id));
      const mergeableIds = new Set(unownedMergeable.map((task) => task.id));
      for (const taskId of [...this.mergeStarvationDrops.keys()]) {
        if (!inReviewIds.has(taskId) || !mergeableIds.has(taskId)) {
          this.mergeStarvationDrops.delete(taskId);
        }
      }

      if (unownedMergeable.length === 0) return 0;

      log.warn(
        `Found ${unownedMergeable.length} mergeable review task(s) stuck in ${[...mergeableReviewColumns].join(", ")}`,
      );

      // Prefer the engine's merge queue so `mergeStrategy` (direct vs.
      // pull-request) is honored. Fall back to a direct store merge only
      // when no enqueue callback is wired (standalone/tests).
      const enqueueMerge = this.options.enqueueMerge;
      let recovered = 0;
      for (const task of unownedMergeable) {
        try {
          if (enqueueMerge) {
            const queued = enqueueMerge(task.id);
            if (!queued) {
              const drops = (this.mergeStarvationDrops.get(task.id) ?? 0) + 1;
              this.mergeStarvationDrops.set(task.id, drops);
              log.warn(
                `Auto-recovery enqueue dropped for ${task.id} (${drops}/${MAX_STARVATION_DROPS}); engine merge queue rejected re-enqueue`,
              );
              if (drops >= MAX_STARVATION_DROPS) {
                const error = `Auto-merge starvation: ${MAX_STARVATION_DROPS} consecutive enqueue attempts were dropped by the engine merge queue; task requires manual intervention.`;
                await this.store.updateTask(task.id, { status: "failed", error });
                await this.store.logEntry(task.id, error);
                this.mergeStarvationDrops.delete(task.id);
                recovered++;
              }
              continue;
            }
            this.mergeStarvationDrops.delete(task.id);
          } else {
            await this.store.mergeTask(task.id);
          }
          await this.store.logEntry(
            task.id,
            enqueueMerge
              ? "Auto-recovered: eligible in-review task re-enqueued for merge"
              : "Auto-recovered: eligible in-review task was merged and moved to done",
          );
          log.log(`Recovered mergeable review task ${task.id}`);
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover mergeable review task ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} mergeable review task(s) → done`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Mergeable review recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover `in-review` tasks parked by a failed pre-merge workflow step.
   *
   * When a pre-merge workflow step (e.g. Browser Verification) fails during an
   * active executor run, the graph workflow records the failed step result and
   * the task ends up in `in-review` with that failed result still on record,
   * which `getTaskMergeBlocker` correctly treats as a merge block — leaving the
   * task stranded with no live session to un-stick it.
   *
   * This scan delegates back to the executor's `recoverFailedPreMergeWorkflowStep`
   * path (which reuses the same `sendTaskBackForFix` flow the executor uses
   * internally) so the agent gets another attempt with the failure feedback
   * injected into `PROMPT.md`. Bounded by `settings.maxPostReviewFixes` and the
   * per-task `postReviewFixCount` so a persistently-failing verifier cannot
   * ping-pong a task forever.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   * @returns Number of tasks sent back for fix
   */
  async recoverReviewTasksWithFailedPreMergeSteps(): Promise<number> {
    const recoverFn = this.options.recoverFailedPreMergeStep;
    if (!recoverFn) return 0;

    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:20 (the query-filter class, sixth sweep — and the first
      converted with the ACTIVATION check run FIRST, per
      `docs/solutions/architecture-patterns/self-healing-sweeps-are-blind-on-a-renamed-board.md`):

      `listTasks({ column: "in-review" })` returned EMPTY on a renamed board, so a card parked with a
      FAILED pre-merge review step was never auto-revived and stayed parked until a human noticed.

      The activation check mattered here more than anywhere so far. This sweep's filter asks
      `blocker !== "task has failed pre-merge workflow steps"` — an EXACT STRING match. Unwired on a
      renamed board the blocker instead returns "task is in 'checking', must be in 'in-review'", which is
      not that string, so every card would be rejected the moment the widened query started finding them.
      Wiring the blocker is therefore part of this conversion, not a follow-up.
      */
      const failedStepReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const failedStepById = new Map<string, Task>();
      for (const column of failedStepReviewColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) failedStepById.set(task.id, task);
      }
      const tasks = [...failedStepById.values()];
      const failedStepIrCache = new Map<string, WorkflowIr>();
      const unresolvedFailedStepCards: string[] = [];
      /* One resolution per card, feeding BOTH the lane test and the blocker below. */
      const ownReviewLanesForFailedStep = async (task: Task): Promise<ReadonlySet<string>> => {
        const resolved = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id, failedStepIrCache)
          .catch(() => undefined);
        const own = resolved
          ? [...new Set(REVIEW_ROLES.flatMap((role) => columnsWithFlag(resolved.ir, role)))]
          : [];
        if (!resolved || resolved.source === "default") unresolvedFailedStepCards.push(task.id);
        /* DELIBERATE-LITERAL — the unresolvable-workflow default, reviewed 2026-07-30-21:20. */
        return own.length > 0 ? new Set(own) : new Set(["in-review"]);
      };
      const reviewLanesByTask = new Map<string, ReadonlySet<string>>();
      for (const task of tasks) reviewLanesByTask.set(task.id, await ownReviewLanesForFailedStep(task));
      if (unresolvedFailedStepCards.length > 0) {
        log.warn(
          `failed-pre-merge-step revival: ${unresolvedFailedStepCards.length} card(s) measured against the `
          + `built-in review lane because their own workflow could not be resolved `
          + `(${unresolvedFailedStepCards.slice(0, 5).join(", ")}); a renamed review lane there stays parked.`,
        );
      }
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      const latestFailedPreMergeStep = (task: Pick<Task, "workflowStepResults">): WorkflowStepResult | undefined => {
        return (task.workflowStepResults ?? [])
          .filter((r) => (r.phase || "pre-merge") === "pre-merge" && r.status === "failed")
          .sort((a, b) => {
            const aTs = Date.parse(a.completedAt || a.startedAt || "");
            const bTs = Date.parse(b.completedAt || b.startedAt || "");
            return (Number.isFinite(bTs) ? bTs : 0) - (Number.isFinite(aTs) ? aTs : 0);
          })[0];
      };
      const isRetryableParkedRemediationFailure = (task: Pick<Task, "status" | "error">): boolean => {
        /*
         * FNXC:WorkflowRemediation 2026-07-03-23:10:
         * Restart recovery for parked remediation rows is limited to pre-merge optional-step remediation. `plan-replan` belongs to Plan Review's replan/triage path; sending it through `recoverFailedPreMergeStep` would incorrectly reopen implementation work.
         */
        if (task.status !== "failed") return false;
        const error = task.error ?? "";
        return error.includes("Workflow graph terminated with failure at node 'code-review-remediation'")
          || error.includes("Workflow graph terminated with failure at node 'browser-verification-remediation'");
      };

      /*
       * FNXC:WorkflowOptionalStepRevisionBudget 2026-06-27-12:34:
       * Self-healing pre-computes the same optional-step budget the live graph seam uses before the synchronous candidate filter runs. The target step is the latest blocking pre-merge failure, matching `recoverFailedPreMergeWorkflowStep`; IR lookup failures fall back to the effective global `maxPostReviewFixes` so older tasks remain recoverable.
       *
       * FNXC:WorkflowRevisionBudget 2026-06-30-20:50:
       * Offline recovery must share live execution's workflow-value precedence: explicit `planReviewMaxRevisions`/`codeReviewMaxRevisions` caps win, unset Plan Review/spec and Code Review values are unbounded, and Browser Verification keeps the existing fallback budget.
       *
       * FNXC:WorkflowRevisionBudget 2026-06-30-22:06:
       * Self-healing uses the same per-step attempt partition as live execution. `postReviewFixCount` remains an aggregate observability counter, but cap exhaustion is computed from prior log markers for the failed workflow step so Plan Review and Code Review budgets do not consume each other.
       *
       * FNXC:WorkflowRevisionBudget 2026-06-30-23:03:
       * The in-review sweep stays slim for board-scale filtering, but slim TaskStore rows intentionally omit `log`. Hydrate the full task before counting revision markers so offline recovery enforces Code Review and Plan Review caps against production data instead of treating every task as attempt zero.
       */
      const revisionBudgetByTask = new Map<string, { unbounded: boolean; max: number; label: string; key: string; stepName?: string; attempts: number }>();
      const irCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const loadRevisionAttemptSource = async (task: Task): Promise<Pick<Task, "log">> => {
        try {
          const fullTask = await this.store.getTask(task.id);
          if (fullTask?.id === task.id && Array.isArray(fullTask.log)) return fullTask;
        } catch {
          // Keep recovery fail-soft; older stores/tests can still provide log entries on the list row.
        }
        return task;
      };
      for (const task of tasks) {
        const eff = await mergeEffectiveSettings(this.store, task, settings);
        const fallback = eff.maxPostReviewFixes ?? DEFAULT_MAX_POST_REVIEW_FIXES;
        let rawMaxRevisions: unknown;
        const target = latestFailedPreMergeStep(task);
        if (target?.workflowStepId) {
          try {
            const ir = await resolveWorkflowIrForTask(this.store, task.id, irCache);
            if (ir.version === "v2") {
              const node = ir.nodes.find((candidate) => candidate.id === target.workflowStepId && candidate.kind === "optional-group");
              rawMaxRevisions = node?.config?.maxRevisions;
            }
          } catch {
            rawMaxRevisions = undefined;
          }
        }
        const maxRevisions = resolveOptionalReviewRevisionBudget({
          optionalGroupId: target?.workflowStepId ?? "",
          workflowSettings: eff as Record<string, unknown>,
          nodeMaxRevisions: rawMaxRevisions,
          fallbackMaxRevisions: fallback,
        });
        const budget = resolveOptionalStepRevisionBudget(maxRevisions, fallback);
        const key = optionalStepRevisionKey(target?.workflowStepId, target?.workflowStepName);
        const revisionAttemptSource = await loadRevisionAttemptSource(task);
        revisionBudgetByTask.set(task.id, {
          ...budget,
          key,
          stepName: target?.workflowStepName,
          attempts: countOptionalStepRevisionAttempts(revisionAttemptSource, key, target?.workflowStepName),
          label: budget.unbounded ? "unbounded" : String(budget.max),
        });
      }
      const revisionBudgetFor = (taskId: string): { unbounded: boolean; max: number; label: string; key: string; stepName?: string; attempts: number } => {
        const budget = revisionBudgetByTask.get(taskId);
        if (budget) return budget;
        const fallbackBudget = resolveOptionalStepRevisionBudget(undefined, 3);
        return { ...fallbackBudget, key: "pre-merge-optional-step", attempts: 0, label: fallbackBudget.unbounded ? "unbounded" : String(fallbackBudget.max) };
      };

      const candidates = tasks.filter((task) => {
        /* Precomputed above, so this filter stays synchronous. */
        if (!(reviewLanesByTask.get(task.id) ?? new Set(["in-review"])).has(task.column)) return false;
        if (!allowsAutoMergeProcessing(task, settings)) return false;
        if (task.paused) return false;
        /*
         * FNXC:WorkflowRemediation 2026-07-03-20:10:
         * Retryable Code Review remediation can park as `status:"failed"` when the
         * graph loses restart-local failure context at `code-review-remediation`.
         * Treat only that durable remediation-node signature as recoverable here;
         * other failed review rows remain terminal/operator-actionable.
         */
        const parkedRemediationFailure = isRetryableParkedRemediationFailure(task);
        if (task.status && !parkedRemediationFailure) return false;
        if (executingIds.has(task.id)) return false;
        const budget = revisionBudgetFor(task.id);
        if (!budget.unbounded && (!Number.isFinite(budget.max) || budget.max <= 0)) return false;
        if (!budget.unbounded && budget.attempts >= budget.max) return false;

        // Must have at least one failed pre-merge workflow step result.
        if (!latestFailedPreMergeStep(task)) return false;

        // Merge must be blocked *specifically* by the failed pre-merge step —
        // not by an unrelated condition (incomplete steps, etc.) that is
        // already handled by a dedicated scan.
        /* Wired: this comparison is an EXACT STRING match, so an unwired blocker returning
           "task is in '<lane>', must be in 'in-review'" would reject every card on a renamed board. */
        const blocker = getTaskMergeBlocker(task, {
          reviewColumns: reviewLanesByTask.get(task.id) ?? new Set(["in-review"]),
        });
        if (!parkedRemediationFailure && blocker !== "task has failed pre-merge workflow steps") return false;

        // The retry flow injects into PROMPT.md + re-executes on the worktree.
        // If the worktree was cleaned up we can't reliably resume here; leave
        // such tasks for human intervention.
        if (!task.worktree) return false;

        return true;
      });

      if (candidates.length === 0) return 0;

      log.warn(`Found ${candidates.length} in-review task(s) with failed pre-merge workflow steps — auto-reviving`);

      let recovered = 0;
      for (const task of candidates) {
        const budget = revisionBudgetFor(task.id);
        const nextCount = budget.attempts + 1;
        const totalFixCount = (task.postReviewFixCount ?? 0) + 1;
        try {
          // Increment the counter BEFORE delegating so that even if the
          // executor path crashes or races, the budget is still consumed and
          // we can't enter an infinite revival loop.
          await this.store.updateTask(task.id, { postReviewFixCount: totalFixCount });
          await this.store.logEntry(
            task.id,
            `Auto-reviving in-review task with failed pre-merge workflow step (attempt ${nextCount}/${budget.label})`,
            optionalStepRevisionLogOutcome(`Step: ${budget.stepName ?? budget.key}`, budget.key),
          );
          const sentBack = await recoverFn(task);
          if (sentBack) {
            log.log(`Revived ${task.id}: sent back for fix (${nextCount}/${budget.label})`);
            recovered++;
          } else {
            log.warn(`Revival of ${task.id} was skipped by executor — budget already consumed`);
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to revive ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Auto-revived ${recovered} in-review task(s) for pre-merge workflow step fix`);
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Failed pre-merge workflow step revival failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover tasks that reached `in-review` while a task step was still marked
   * pending/in-progress. These tasks are not tracked by StuckTaskDetector
   * anymore because the executor session is gone, and they are not mergeable
   * because `getTaskMergeBlocker()` correctly blocks incomplete steps.
   *
   * Moving them back to `todo` lets the normal scheduler/executor resume the
   * incomplete step instead of leaving the task stranded in review.
   * Backward lifecycle move gated on triple proof (FN-5335).
   * When the predicate fails, emits `task:stale-incomplete-review-no-action` and skips lifecycle mutation.
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverStaleIncompleteReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!timeoutMs || timeoutMs <= 0) return 0;

      const now = Date.now();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-fourth sweep):
      A review card whose STEPS are not finished — it reached review on a graph failure, not on completed
      work. The literal read meant that on a renamed board it was never requeued, so the card sat in
      review claiming to be done while its own steps said otherwise.

      The per-card verdict below converts with it. The triple-proof is NOT lane-gated in this sweep, so
      there is no second pair to convert — checked deliberately, because that is the defect #2916 found
      one sweep over and the self-audit found five of in another.
      */
      const staleIncompleteColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const staleIncompleteById = new Map<string, Task>();
      for (const column of staleIncompleteColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) staleIncompleteById.set(entry.id, entry);
      }
      const tasks = [...staleIncompleteById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const staleIncompleteLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          staleIncompleteLanes.set(
            entry.id,
            source === "default"
              ? new Set(staleIncompleteColumns)
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          staleIncompleteLanes.set(entry.id, new Set(staleIncompleteColumns));
        }
      }
      /*
       * FNXC:WorkflowLifecycle 2026-06-29-11:27:
       * Restart recovery must not leave errored review-column cards with unfinished
       * steps. FN-7228/FN-7229 persisted `column:"in-review"` plus incomplete steps
       * after graph failures; failed rows should re-enter `todo` immediately with
       * progress preserved instead of waiting for the stale timeout.
       */
      const staleIncomplete = tasks.filter((task) =>
        (staleIncompleteLanes.get(task.id) ?? staleIncompleteColumns).has(task.column) &&
        allowsAutoMergeProcessing(task, settings) &&
        !task.paused &&
        (!task.status || task.status === "failed") &&
        task.steps.length > 0 &&
        task.steps.some((step) => NON_TERMINAL_STEP_STATUSES.has(step.status)) &&
        (task.status === "failed" || now - new Date(task.columnMovedAt ?? task.updatedAt).getTime() >= timeoutMs)
      );

      if (staleIncomplete.length === 0) return 0;

      log.warn(`Found ${staleIncomplete.length} stale in-review task(s) with incomplete steps`);

      let recovered = 0;
      for (const task of staleIncomplete) {
        try {
          const failedReviewRow = task.status === "failed";
          const proof = await this.evaluateBackwardMoveTripleProof(task, {
            stage: "stale-incomplete-review",
            graceMs: failedReviewRow ? 0 : timeoutMs,
            stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
            reason: failedReviewRow ? "failed-incomplete-review-candidate" : "stale-incomplete-review-candidate",
            extra: { failedReviewRow },
          });
          if (!proof.ok) {
            await this.emitBackwardMoveNoAction(task, "stale-incomplete-review", "task:stale-incomplete-review-no-action", proof);
            continue;
          }

          await this.store.logEntry(
            task.id,
            "Auto-recovered: in-review task still had incomplete steps — moved back to todo for retry",
          );
          // #1411: backward recovery — skip order-derived adjacency.
          await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
          log.log(`Recovered stale incomplete review task ${task.id}: moved back to todo`);
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover stale incomplete review task ${task.id}: ${errorMessage}`);
        }
      }

      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Stale incomplete review recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Final-fallback recovery for `in-review` tasks that fell through every other
   * scan and have sat untouched longer than `taskStuckTimeoutMs`.
   *
   * Tasks not eligible for auto-merge processing (global `autoMerge` off
   * without an explicit per-task `autoMerge: true` override) are skipped
   * because PR-based manual review intentionally leaves them in `in-review`.
   *
   * The other review-recovery scans each require a specific shape (failed
   * pre-merge step, incomplete steps, mergeable + worktree present, confirmed
   * merge, transient merge status). A task whose state doesn't match any of
   * those shapes — e.g. `status: "failed"` with no failed pre-merge step, or
   * any other unanticipated combination — has no recovery path and stays
   * silent in review forever.
   *
   * This catch-all kicks any such task back to `todo`, clearing transient
   * `status` so the scheduler can pick it up. Worktree state is intentionally
   * not considered: the executor will recreate one if needed.
   *
   * Preserved statuses (skipped):
   * - `awaiting-user-review`, `awaiting-approval`: explicit human handoff
   * - `merging`, `merging-pr`, `merging-fix`: handled by `recoverInterruptedMergingTasks`
   *
   * Rate-limiting comes from the `updatedAt >= taskStuckTimeoutMs` gate —
   * each kick refreshes `updatedAt`, so a task that re-enters review and gets
   * stuck again can only be kicked once per `taskStuckTimeoutMs` window.
   *
   * Tasks not eligible for auto-merge processing (global `autoMerge` off
   * without an explicit per-task `autoMerge: true` override) are skipped
   * because those projects intentionally use PR-based/manual in-review
   * ownership.
   *
   * @returns Number of tasks kicked back to todo
   */
  async surfaceInReviewStalls(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);
      const cycleStartMs = Date.now();
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!timeoutMs || timeoutMs <= 0) return 0;

      const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
      const executingTaskIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-20:05 (the query-filter class — the LAST read-shaped one):
      `listTasks({ column: "in-review" })` returns EMPTY on a renamed board, so `surfaceInReviewStalls`
      surfaced nothing: a card stalled in review past `taskStuckTimeoutMs` was never kicked back to the
      hold lane, and the operator saw a review column that silently stopped draining. Same shape as the
      twenty-odd siblings in this file, documented in
      `docs/solutions/architecture-patterns/self-healing-sweeps-are-blind-on-a-renamed-board.md`.

      Read via the project UNION and de-duplicate by id: a board mid-rename has rows under both the old
      and the new id, and over-inclusion costs one extra query whose rows the per-card guards below then
      filter. Under-inclusion is what was broken.

      `allowsAutoMergeProcessing` and `getInReviewStallReason` already gate every card individually, so
      no second lane test is needed here — the union only decides which rows are LOOKED at.

      Measured, not claimed: `lifecycle-column-census.mjs --json` reports `queryRoles.read` at 2 before
      this change and 1 after. I first wrote "the last one, 1 -> 0" and the tool said otherwise — one
      more read-shaped query survives elsewhere. Stating the number I actually saw rather than the one
      that would have read better, because a comment asserting a fact about the rest of the tree is the
      decay class this program has already had to correct twice.
      */
      const stallReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const stallCandidatesById = new Map<string, Task>();
      for (const column of stallReviewColumns) {
        for (const task of await this.store.listTasks({ column, slim: false })) stallCandidatesById.set(task.id, task);
      }
      const tasks = [...stallCandidatesById.values()];
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-16:20 (RESTORED — #2951 landed the read without this):
      Per-card review lanes for the classifier below. #2951 converted the READ to the project's review
      columns, and its bulk conflict resolution dropped this map and the `reviewColumns` argument with
      it — leaving the textbook missed pair: a widened read hands every renamed-board card to a
      classifier that still judges by the literal `in-review`, so the sweep resolves lanes and then
      surfaces nothing.

      The test that proved the wiring was dropped in the same resolution, which is why nothing failed.
      A deleted test cannot fail. Restored together.
      */
      const stallLanes = new Map<string, ReadonlySet<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          stallLanes.set(
            entry.id,
            source === "default"
              ? stallReviewColumns
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          stallLanes.set(entry.id, stallReviewColumns);
        }
      }
      let surfaced = 0;

      for (const task of tasks) {
        if (task.deletedAt) continue;
        if (!allowsAutoMergeProcessing(task, settings)) continue;
        const signal = getInReviewStallReason(task, {
          reviewColumns: stallLanes.get(task.id) ?? stallReviewColumns,
          now: cycleStartMs,
          activeMergeTaskId,
          executingTaskIds,
          staleMergingMinAgeMs: this.options.staleMergingStatusMinAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS,
          maxAutoMergeRetries,
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
        if (!signal) continue;
        if (await this.isMergeLaneOwned(task.id)) continue;

        if (Date.parse(task.updatedAt) >= cycleStartMs) {
          continue;
        }

        if (signal.code === "non-retryable-provider-error" && task.userPaused !== true) {
          await this.store.logEntry(task.id, `${IN_REVIEW_STALL_TERMINAL_LOG_PREFIX}${signal.code}]: ${signal.reason}`);
          await this.store.updateTask(task.id, {
            paused: true,
            pausedReason: "non-retryable-provider-error",
            status: "failed",
            error: `Terminal provider error (non-retryable): ${signal.reason}`,
          });
          const auditor = createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-healing-stall-terminal-provider-error", task.id),
            agentId: "self-healing",
            taskId: task.id,
            phase: "self-healing",
          });
          await auditor.database({
            type: "task:in-review-stall-terminal-provider-error",
            target: task.id,
            metadata: {
              code: signal.code,
              reason: signal.reason,
              branch: task.branch ?? null,
              worktree: task.worktree ?? null,
            },
          });
          surfaced += 1;
          continue;
        }

        const previous = [...(task.log ?? [])]
          .reverse()
          .find((entry) => entry.action.startsWith(IN_REVIEW_STALL_LOG_PREFIX));
        if (previous) {
          const parsed = /^In-review stall surfaced \[([^\]]+)\]/.exec(previous.action);
          const previousCode = parsed?.[1];
          const previousAt = Date.parse(previous.timestamp);
          if (Number.isFinite(previousAt) && previousAt >= cycleStartMs - timeoutMs && previousCode === signal.code) {
            continue;
          }
        }

        const threshold = settings.inReviewStallDeadlockThreshold ?? 3;
        const identicalCount = countRecentIdenticalStallEntries(task, { code: signal.code, reason: signal.reason });
        const nextCount = identicalCount + 1;
        const shouldDispose = threshold > 0 && task.userPaused !== true && nextCount >= threshold;

        if (shouldDispose) {
          await this.store.logEntry(
            task.id,
            `${IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX}${signal.code}]: deadlock-prevention threshold reached after ${nextCount} identical stalls — pausing task. last reason: ${signal.reason}`,
          );
          await this.store.updateTask(task.id, {
            paused: true,
            pausedReason: "in-review-stall-deadlock",
            status: "failed",
            error: `In-review stall deadlock: ${signal.code} repeated ${nextCount}× without progress. ${signal.reason}`,
          });
          const auditor = createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-healing-stall-deadlock", task.id),
            agentId: "self-healing",
            taskId: task.id,
            phase: "self-healing",
          });
          await auditor.database({
            type: "task:in-review-stall-deadlock-disposed",
            target: task.id,
            metadata: {
              code: signal.code,
              reason: signal.reason,
              repetitionCount: nextCount,
              threshold,
              branch: task.branch ?? null,
              worktree: task.worktree ?? null,
            },
          });
          surfaced += 1;
          continue;
        }

        await this.store.logEntry(task.id, `${IN_REVIEW_STALL_LOG_PREFIX}${signal.code}]: ${signal.reason}`);
        surfaced += 1;
      }

      return surfaced;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`In-review stall surfacing failed: ${errorMessage}`);
      return 0;
    }
  }
  /*
  FNXC:WorkflowRecoveryPolicy 2026-07-27-23:20 (U4 — surfacing family retired onto the runner):
  These three were three copies of one skeleton. The mechanism they shared —
  pause gates, threshold resolution, the fresh-row skip, the at-most-once dedup,
  the log write, the never-throw contract — now lives in `runSurfacingSweep`, and
  each sweep is the part that was genuinely its own: which role it watches, which
  operator setting it inherits, who is eligible, and what it says.

  Thresholds are now POLICY-OVER-SETTING. A workflow that declares
  `recovery.stalenessMs` on the role's column wins; one that declares nothing
  keeps reading the operator setting exactly as before, so this migration changes
  nothing for an existing project and requires no workflow to be edited.

  Surfacing is OBSERVATIONAL, so per the re-ratified invariant it reports on
  user-paused cards — which is the entire point of the two paused sweeps.
  */
  /*
  FNXC:WorkflowRecoveryPolicy 2026-07-28-03:10 (PR #2487 review — shared cycle):
  ONE task snapshot and ONE workflow-IR cache shared across the three surfacing
  sweeps.

  Consolidating them onto a single runner made a pre-existing redundancy visible
  for the first time: each sweep issued its own unfiltered non-slim `listTasks`
  AND re-resolved every task's workflow from a fresh Map, and all three run
  back-to-back in both startup recovery and the maintenance batch. That is three
  full board reads and three IR resolutions per cycle where one of each suffices.

  WHY SHARING A SNAPSHOT IS SAFE HERE, and it is a property rather than a hope:
  the three sweeps PARTITION the task space, so no card is ever visible to two of
  them and none can observe staleness another introduced.

    surfaceStalePausedTodos    hold column   AND paused === true
    surfaceStalePausedReviews  review column AND paused === true
    surfaceInReviewStalled     review column AND paused !== true

  A card sits in exactly one column, so hold and review are exclusive; within
  review, `paused` splits the remaining two. `surfacing-family-shared.test.ts`
  asserts this partition directly, so a future sweep that widens its eligibility
  into another's territory fails rather than silently sharing a stale snapshot.

  The sweeps are read-mostly regardless: they append a task-log entry under their
  own distinct `logPrefix` and mutate no column or lifecycle field, and the
  at-most-once dedup matches on that prefix, so one sweep's entry is invisible to
  another's suppression check.
  */
  /** A once-only opener: the first caller starts the cycle, the rest await it. */
  private surfacingCycleMemo(): () => Promise<SurfacingCycle | null> {
    let pending: Promise<SurfacingCycle | null> | undefined;
    return () => (pending ??= this.openSurfacingCycle());
  }

  private async openSurfacingCycle(): Promise<SurfacingCycle | null> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return null;
    return {
      settings,
      tasks: await this.store.listTasks({ slim: false }),
      irCache: new Map(),
      cycleStartMs: Date.now(),
    };
  }

  private async runSurfacing(
    spec: Parameters<typeof runSurfacingSweep>[0],
    thresholdKey: "stalePausedTodoThresholdMs" | "stalePausedReviewThresholdMs" | "inReviewStalledThresholdMs",
    label: string,
    cycle?: SurfacingCycle | null | Promise<SurfacingCycle | null>,
  ): Promise<number> {
    try {
      /* A caller running the family together supplies the shared cycle; a
         standalone call (tests, a single registry entry) opens its own. */
      const active = cycle !== undefined ? await cycle : await this.openSurfacingCycle();
      if (!active) return 0;
      const { settings, tasks, irCache, cycleStartMs } = active;
      const inheritedThresholdMs = Number(settings[thresholdKey] ?? 0);
      return await runSurfacingSweep(spec, {
        store: this.store,
        tasks,
        inheritedThresholdMs,
        settings,
        cycleStartMs,
        irCache,
        activation: {
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        },
      });
    } catch (err: unknown) {
      log.error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  async surfaceStalePausedTodos(cycle?: SurfacingCycle | null | Promise<SurfacingCycle | null>): Promise<number> {
    return this.runSurfacing(
      {
        logPrefix: "Stale paused todo surfaced",
        role: "hold",
        isEligible: (task) => task.paused === true,
        evaluate: (task, thresholdMs, now, activation, roleColumns) =>
          getStalePausedTodoSignal(task, { now, thresholdMs, holdColumns: roleColumns, ...activation }),
        describe: (_task, signal, thresholdMs) =>
          `paused ${hours(signal.ageMs)}h beyond ${hours(thresholdMs)}h threshold; disposition options — unpause, move to triage, archive, or create follow-up task. pausedReason=${(_task as { pausedReason?: string }).pausedReason ?? "none"}`,
      },
      "stalePausedTodoThresholdMs",
      "Stale paused todo surfacing",
      cycle,
    );
  }

  async surfaceStalePausedReviews(cycle?: SurfacingCycle | null | Promise<SurfacingCycle | null>): Promise<number> {
    return this.runSurfacing(
      {
        logPrefix: "Stale paused review surfaced",
        role: "review",
        isEligible: (task) => task.paused === true,
        evaluate: (task, thresholdMs, now, activation, roleColumns) =>
          getStalePausedReviewSignal(task, { now, thresholdMs, reviewColumns: roleColumns, ...activation }),
        describe: (_task, signal) =>
          `paused ${hours(signal.ageMs)}h; disposition options — unpause, retry, archive, or create follow-up task. pausedReason=${(_task as { pausedReason?: string }).pausedReason ?? "none"}`,
      },
      "stalePausedReviewThresholdMs",
      "Stale paused review surfacing",
      cycle,
    );
  }

  async surfaceInReviewStalled(cycle?: SurfacingCycle | null | Promise<SurfacingCycle | null>): Promise<number> {
    const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
    const executingTaskIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
    return this.runSurfacing(
      {
        logPrefix: "In-review stalled surfaced",
        role: "review",
        /* Unlike the paused sweeps this one watches ACTIVE review work, so a
           paused card is excluded rather than targeted. */
        isEligible: (task, settings) =>
          /*
          FNXC:WorkflowRecoveryPolicy 2026-07-28-01:20 (PR #2487 review, P1):
          `allowsAutoMergeProcessing` is one of the SIX SAFEGUARDS —
          `autoMerge:false` is terminal-until-human. The migration dropped this
          gate while still passing `autoMerge: true` to the signal below, so the
          code asserted an eligibility it no longer checked and the sweep treated
          auto-merge-disabled tasks (and manually-opened-PR tasks) as eligible.
          The `autoMerge: true` argument is only sound BECAUSE this gate proves it.
          */
          allowsAutoMergeProcessing(task, settings) &&
          task.paused !== true &&
          task.id !== activeMergeTaskId &&
          !executingTaskIds.has(task.id),
        isEligibleAsync: async (task) => !(await this.isMergeLaneOwned(task.id)),
        evaluate: (task, thresholdMs, now, activation, roleColumns) => {
          const signal = getInReviewStalledSignal(task, {
            now,
            thresholdMs,
            autoMerge: true,
            activeMergeTaskId,
            executingTaskIds,
            reviewColumns: roleColumns,
            ...activation,
          });
          return signal ? { ...signal, code: signal.code, ageMs: signal.quietMs } : undefined;
        },
        describe: (_task, signal, thresholdMs) =>
          `quiet ${hours(signal.ageMs)}h beyond ${hours(thresholdMs)}h threshold; disposition options — nudge review, retry, archive, or create follow-up task. lastActivitySource=${(signal as { lastActivitySource?: string }).lastActivitySource}`,
      },
      "inReviewStalledThresholdMs",
      "In-review stalled surfacing",
      cycle,
    );
  }


  /**
   * Backward lifecycle move gated on triple proof (FN-5335).
   * When the predicate fails, emits `task:ghost-review-no-action` and skips lifecycle mutation.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverGhostReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!timeoutMs || timeoutMs <= 0) return 0;

      const now = Date.now();
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-second sweep):
      A GHOST review card — parked in review past the stuck timeout with nobody owning its merge lane.
      The literal read meant that on a renamed board it was never found, so the card sat in review
      indefinitely with no merger, no session and no timeout ever firing against it.

      The `task.column === "in-review"` check was redundant while the query pinned the column; under a
      resolved read it becomes the per-card verdict, so it converts rather than being deleted.

      The kick-back below keeps its literal `todo` DELIBERATELY: it passes `recoveryRehome: true`, one of
      the 22 documented escapes `moves.ts` exempts so a card stranded in an undeclared column stays
      rescuable. Converting it removes the rescue path.
      */
      const ghostReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const ghostById = new Map<string, Task>();
      for (const column of ghostReviewColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) ghostById.set(entry.id, entry);
      }
      const tasks = [...ghostById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const ghostLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          ghostLanes.set(
            entry.id,
            source === "default"
              ? new Set(ghostReviewColumns)
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          ghostLanes.set(entry.id, new Set(ghostReviewColumns));
        }
      }
      // Pre-filter sync conditions, then resolve async merge-lane ownership.
      const candidates = tasks.filter((task) =>
        (ghostLanes.get(task.id) ?? ghostReviewColumns).has(task.column) &&
        allowsAutoMergeProcessing(task, settings) &&
        !task.paused &&
        !executingIds.has(task.id) &&
        !(task.status && GHOST_REVIEW_PRESERVED_STATUSES.has(task.status)) &&
        // Confirmed merges belong in `done` (handled by `recoverMergedReviewTasks`).
        task.mergeDetails?.mergeConfirmed !== true &&
        now - new Date(task.columnMovedAt ?? task.updatedAt).getTime() >= timeoutMs
      );
      const ownershipFlags = await Promise.all(
        candidates.map((task) => this.isMergeLaneOwned(task.id)),
      );
      const ghosts = candidates.filter((_, i) => !ownershipFlags[i]);

      if (ghosts.length === 0) return 0;

      log.warn(`Found ${ghosts.length} ghost in-review task(s) — kicking back to todo`);

      let recovered = 0;
      for (const task of ghosts) {
        try {
          const proof = await this.evaluateBackwardMoveTripleProof(task, {
            stage: "ghost-review",
            graceMs: timeoutMs,
            stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
            reason: "ghost-review-candidate",
          });
          if (!proof.ok) {
            await this.emitBackwardMoveNoAction(task, "ghost-review", "task:ghost-review-no-action", proof);
            continue;
          }
          if (task.status) {
            await this.store.updateTask(task.id, { status: null, error: null });
          }
          await this.store.logEntry(
            task.id,
            "Auto-recovered: in-review task idle past stuck-task timeout — kicked back to todo",
          );
          // #1411: backward recovery — skip order-derived adjacency.
          await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
          log.log(`Kicked ghost review task ${task.id} back to todo`);
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to kick ghost review task ${task.id}: ${errorMessage}`);
        }
      }

      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Ghost review recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover stale `in-review` tasks left in a transient merge status.
   *
   * The direct AI merger can successfully create the final commit and then be
   * interrupted before it stores mergeDetails and moves the task to `done`.
   * When that happens no future task:moved event fires, so the merge queue has
   * nothing to retry. This recovery confirms the task-specific commit exists on
   * the current main lineage before finalizing the task.
   *
   * If no landed commit is found, it only clears the stale transient status so
   * the normal mergeable-review recovery can retry the merge.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   * @returns Number of tasks finalized or unblocked
   */
  /**
   * FN-5627 follow-up: recover in-review tasks that are stuck with
   * `mergeRetries >= MAX_AUTO_MERGE_RETRIES` and `status='failed'` due to a
   * TRANSIENT merge failure class (e.g., `target-not-queued` lease handoff
   * race, legacy same-SHA spurious concurrent-advance). These tasks are
   * NOT really stuck — they just hit a race or a misclassified ref-update
   * failure that would have cleared on a fresh attempt. Without this sweep,
   * the only path forward is manual intervention (the
   * `AUTO_MERGE_COOLDOWN_MS`-based reset takes hours).
   *
   * For each matching task:
   *  - Reset `mergeRetries=0`, clear `status` and `error`.
   *  - Increment `mergeDetails.transientRecoveryCount`.
   *  - Re-enqueue via `requeueForAutoMerge`.
   *  - Bounded by `MAX_TRANSIENT_MERGE_RECOVERIES`; exhausted tasks stay
   *    parked as failed and emit `merger:transient-failure-budget-exhausted`
   *    once for diagnostic visibility.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without a per-task `autoMerge: true` override). No-op when no
   * `requeueForAutoMerge` callback is wired or global/engine pause is active.
   *
   * @returns Number of tasks recovered
   */
  async recoverTransientMergeFailures(): Promise<number> {
    const requeue = this.options.requeueForAutoMerge;
    if (!requeue) return 0;
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);

      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-third sweep):
      A merge that failed for a TRANSIENT reason and burned its whole retry budget. The literal read
      meant that on a renamed board the retry budget was never refunded, so a card that failed on a
      network blip stayed failed permanently — an operator-visible failure with no operator-visible cause.

      The `t.column === "in-review"` check was redundant while the query pinned the column; under a
      resolved read it becomes the per-card verdict, so it converts rather than being deleted.
      */
      const transientReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const transientById = new Map<string, Task>();
      for (const column of transientReviewColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) transientById.set(entry.id, entry);
      }
      const slim = [...transientById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const transientLanes = new Map<string, Set<string>>();
      for (const entry of slim) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          transientLanes.set(
            entry.id,
            source === "default"
              ? new Set(transientReviewColumns)
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          transientLanes.set(entry.id, new Set(transientReviewColumns));
        }
      }
      const candidates = slim.filter((t) =>
        (transientLanes.get(t.id) ?? transientReviewColumns).has(t.column)
        && allowsAutoMergeProcessing(t, settings)
        && t.status === "failed"
        && (t.mergeRetries ?? 0) >= maxAutoMergeRetries
        && typeof t.error === "string"
        && t.error.length > 0
        && classifyTransientMergeError(t.error) !== null,
      );
      if (candidates.length === 0) return 0;

      log.warn(
        `Found ${candidates.length} in-review task(s) with transient merge failures stuck at mergeRetries=${maxAutoMergeRetries}; attempting auto-recovery`,
      );

      let recovered = 0;
      for (const slimTask of candidates) {
        const task = await this.store.getTask(slimTask.id).catch(() => null);
        if (!task) continue;
        /*
        Re-check selector on the full row — the slim snapshot is best-effort and may be stale once we
        await. FNXC:WorkflowResolvedColumns 2026-07-30-21:40: this SECOND lane guard converts with the
        first. Converting only the read left it rejecting every renamed-board card the widened query
        found, and the new test failed on exactly that — the "convert the pair or neither" rule, caught
        by the test rather than by reading.
        */
        if (
          !(transientLanes.get(task.id) ?? transientReviewColumns).has(task.column)
          || task.status !== "failed"
          || (task.mergeRetries ?? 0) < maxAutoMergeRetries
        ) {
          continue;
        }
        const errorText = task.error ?? "";
        const transientClass = classifyTransientMergeError(errorText);
        if (!transientClass) continue;

        const currentCount = task.mergeDetails?.transientRecoveryCount ?? 0;
        const errorSnippet = errorText.slice(0, 200);
        const audit = createRunAuditor(this.store, {
          runId: generateSyntheticRunId("self-heal-transient-merge-recovery", task.id),
          agentId: "self-healing",
          taskId: task.id,
          phase: "recover-transient-merge-failures",
        });

        if (currentCount >= MAX_TRANSIENT_MERGE_RECOVERIES) {
          // Budget exhausted — emit once for diagnostic visibility, leave parked.
          // Repeat-suppression: if the failure error has already accreted the
          // exhaustion marker, skip emit to avoid log spam.
          if (!errorText.includes("[transient-recovery-budget-exhausted]")) {
            await this.store.logEntry(
              task.id,
              `[FN-5627] Transient merge failure auto-recovery budget exhausted (${transientClass}, ${currentCount}/${MAX_TRANSIENT_MERGE_RECOVERIES}). Task remains parked in in-review for manual review.`,
            );
            await this.store.updateTask(task.id, {
              error: `${errorText} [transient-recovery-budget-exhausted]`,
            });
            try {
              await audit.database({
                type: "merger:transient-failure-budget-exhausted",
                target: task.id,
                metadata: {
                  taskId: task.id,
                  transientClass,
                  recoveryCount: currentCount,
                  maxRecoveries: MAX_TRANSIENT_MERGE_RECOVERIES,
                  errorSnippet,
                },
              });
            } catch (auditErr) {
              log.warn(
                `recoverTransientMergeFailures: audit emit failed for ${task.id}: ${
                  auditErr instanceof Error ? auditErr.message : String(auditErr)
                }`,
              );
            }
          }
          continue;
        }

        const nextCount = currentCount + 1;
        // Prefix MUST be "Auto-recovered:" so NotificationService's
        // maybeSuppressTransientFailedNotification recognizes this as a
        // recovered transient failure and cancels the pending ntfy. Without
        // this prefix, ntfy fires for every flap cycle of the recovery loop
        // (typically every ~5 minutes), producing user-facing alarm spam
        // even though the task is being auto-recovered cleanly.
        await this.store.logEntry(
          task.id,
          `Auto-recovered: transient merge failure (${transientClass}); resetting mergeRetries=0 and re-enqueueing (recovery ${nextCount}/${MAX_TRANSIENT_MERGE_RECOVERIES}) [FN-5627]`,
        );
        await this.store.updateTask(task.id, {
          mergeRetries: 0,
          status: null,
          error: null,
          mergeDetails: {
            ...task.mergeDetails,
            transientRecoveryCount: nextCount,
          },
        });
        try {
          await audit.database({
            type: "merger:transient-failure-auto-recovered",
            target: task.id,
            metadata: {
              taskId: task.id,
              transientClass,
              mergeRetries: task.mergeRetries ?? 0,
              recoveryCount: nextCount,
              errorSnippet,
            },
          });
        } catch (auditErr) {
          log.warn(
            `recoverTransientMergeFailures: audit emit failed for ${task.id}: ${
              auditErr instanceof Error ? auditErr.message : String(auditErr)
            }`,
          );
        }
        try {
          await requeue(task.id);
          recovered++;
        } catch (requeueErr) {
          log.warn(
            `recoverTransientMergeFailures: requeue failed for ${task.id}: ${
              requeueErr instanceof Error ? requeueErr.message : String(requeueErr)
            }`,
          );
        }
      }

      if (recovered > 0) {
        log.log(`recoverTransientMergeFailures: re-enqueued ${recovered} stuck in-review task(s)`);
      }
      return recovered;
    } catch (err) {
      log.warn(
        `recoverTransientMergeFailures sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  async recoverInterruptedMergingTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!timeoutMs || timeoutMs <= 0) return 0;

      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-19:50 (the query-filter class, fourth sweep):
      Same shape as its three siblings: `listTasks({ column: "in-review" })` returns EMPTY on a renamed
      board, so a task interrupted mid-merge — status still `merging`, no live session behind it — was
      never recovered and sat in that state indefinitely.

      Project union for the READ; per-card verdict for the MUTATION, since this sweep rewrites status and
      clears merge state. Provenance so an unresolvable card is reported rather than silently skipped —
      identical to `recoverAlreadyMergedReviewTasks` and `recoverStuckMergeDeadlocks`, so the four cannot
      drift apart.
      */
      const interruptedReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const interruptedById = new Map<string, Task>();
      for (const column of interruptedReviewColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) interruptedById.set(task.id, task);
      }
      const interruptedIrCache = new Map<string, WorkflowIr>();
      const unresolvedInterruptedCards: string[] = [];
      const inOwnReviewLaneForInterrupted = async (task: Task): Promise<boolean> => {
        const resolved = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id, interruptedIrCache)
          .catch(() => undefined);
        const own = resolved
          ? [...new Set(REVIEW_ROLES.flatMap((role) => columnsWithFlag(resolved.ir, role)))]
          : [];
        if (!resolved || resolved.source === "default") unresolvedInterruptedCards.push(task.id);
        /* DELIBERATE-LITERAL — the unresolvable-workflow default, reviewed 2026-07-30-19:50. */
        return own.length > 0 ? own.includes(task.column) : task.column === "in-review";
      };
      const statusCandidates = [...interruptedById.values()].filter((task) =>
        allowsAutoMergeProcessing(task, settings) &&
        !task.paused &&
        Boolean(task.status && ACTIVE_MERGE_STATUSES.has(task.status)),
      );
      const candidates: Task[] = [];
      for (const task of statusCandidates) {
        if (!(await inOwnReviewLaneForInterrupted(task))) continue;
        if (await this.isPastInterruptedMergeGraceAsync(task, timeoutMs)) {
          candidates.push(task);
        }
      }

      if (unresolvedInterruptedCards.length > 0) {
        log.warn(
          `interrupted-merge recovery: ${unresolvedInterruptedCards.length} card(s) measured against the `
          + `built-in review lane because their own workflow could not be resolved `
          + `(${unresolvedInterruptedCards.slice(0, 5).join(", ")}); a renamed review lane there stays stuck.`,
        );
      }

      if (candidates.length === 0) return 0;

      /* Names the lanes actually searched rather than the literal `in-review`, which is no longer what
         was queried and would misreport the board this ran against. */
      log.warn(
        `Found ${candidates.length} stale merging task(s) in ${[...interruptedReviewColumns].join(", ")}`,
      );

      let recovered = 0;
      for (const task of candidates) {
        try {
          /*
          FNXC:MergeQueue 2026-07-15-09:50:
          If this task still owns the in-process active merge, force-abort first. Cooperative abort alone left mergeRunning=true when the agent ignored the signal; abortActiveMerge + raceMergeWithAbort free the single-flight drain so re-enqueue can actually start.
          */
          if (this.options.getActiveMergeTaskId?.() === task.id) {
            this.options.abortActiveMerge?.(task.id, "recover-interrupted-merging-wedged-owner");
          }
          /*
          FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD1 — P0 workspace gate):
          A workspace task lands PER-REPO and `landWorkspaceTask` sets status:"merging". The
          singular `findLandedTaskCommit` runs git over `this.options.rootDir` (the NON-git
          workspace root) → wrong/empty, and a one-repo hit would finalize the WHOLE task done
          + emit task:merged on a single repo's commit — a P0 data bug that marks a PARTIAL-landed
          workspace task fully merged. So for a workspace task we MUST NOT call findLandedTaskCommit
          / the single-commit finalize. Instead clear the transient "merging" status and re-enqueue
          via `enqueueMerge`, which routes to the idempotent `landWorkspaceTask`: it skips repos
          whose `landedSha` is already an ancestor (isRepoLanded) and finalizes to done EXACTLY ONCE
          only when EVERY acquired repo is landed; a partial/none state simply re-lands the missing
          repos. The partial-land reconciler (KTD2) is the standing recovery for a re-enqueue drop.
          */
          if (isWorkspaceTask(task)) {
            await this.store.updateTask(task.id, { status: null, error: null });
            this.options.clearMergeActive?.(task.id);
            await this.store.logEntry(
              task.id,
              "Auto-recovered (workspace): cleared stale 'merging' status; per-repo land will be re-enqueued (no single-commit finalize)",
            );
            try {
              this.options.enqueueMerge?.(task.id);
            } catch (enqueueErr: unknown) {
              log.warn(
                `Failed to re-enqueue workspace ${task.id} after stale-merge recovery (will rely on partial-land reconciler/polling sweep): ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
              );
            }
            log.log(`Recovered interrupted workspace merge ${task.id}: cleared stale status, re-enqueued per-repo land`);
            recovered++;
            continue;
          }

          const mergeTarget = await this.resolveSelfHealingMergeTarget(task, settings, "recover-interrupted-merging");
          const landedCommit = await this.findLandedTaskCommit(task);

          if (landedCommit && !(await this.isCommitReachableFromBranch(landedCommit.sha, mergeTarget.branch))) {
            await this.recordSharedGroupDefaultTargetGuard(task, "recover-interrupted-merging", {
              reason: "landed-commit-not-reachable-from-routed-target",
              commitSha: landedCommit.sha,
              mergeTargetBranch: mergeTarget.branch,
              mergeTargetSource: mergeTarget.source ?? null,
            });
            await this.store.updateTask(task.id, { status: null, error: null });
            try {
              this.options.enqueueMerge?.(task.id);
            } catch { /* rely on polling sweep */ }
            recovered++;
            continue;
          }

          if (landedCommit) {
            const mergeCommitMessage = await regenerateBareMergeSubject({
              subject: landedCommit.subject,
              commitSha: landedCommit.sha,
              branch: task.branch ?? "",
              taskId: task.id,
              rootDir: this.options.rootDir,
              settings,
            });
            const mergeDetails: MergeDetails = {
              commitSha: landedCommit.sha,
              rebaseBaseSha: landedCommit.rebaseBaseSha,
              filesChanged: landedCommit.filesChanged,
              insertions: landedCommit.insertions,
              deletions: landedCommit.deletions,
              mergeCommitMessage,
              mergedAt: new Date().toISOString(),
              mergeConfirmed: true,
              prNumber: getPrimaryPrInfo(task)?.number,
              mergeTargetBranch: mergeTarget.branch,
              mergeTargetSource: mergeTarget.source,
            };

            await this.store.updateTask(task.id, {
              status: null,
              error: null,
              mergeRetries: 0,
              mergeDetails,
            });
            await this.recordSelfHealingBranchGroupMemberLanding(task, mergeTarget, "recover-interrupted-merging");
            const completeLane = (await resolveTaskLifecycleColumns(this.store, task.id))?.complete ?? "done";
const movedTask = await this.store.moveTask(task.id, completeLane);
            this.emitTaskMerged(movedTask, { mergeConfirmed: true });
            await this.cleanupInterruptedMergeArtifacts(task);
            await this.store.logEntry(
              task.id,
              `Auto-recovered: stale merge status finalized from landed commit ${landedCommit.sha.slice(0, 8)}`,
            );
            log.log(`Recovered interrupted merge ${task.id}: finalized landed commit ${landedCommit.sha.slice(0, 8)}`);
            recovered++;
            continue;
          }

          await this.store.updateTask(task.id, {
            status: null,
            error: null,
          });
          await this.store.logEntry(
            task.id,
            "Auto-recovered: stale merge status cleared; merge will be retried",
          );
          log.log(`Recovered interrupted merge ${task.id}: cleared stale status for retry`);
          try {
            this.options.enqueueMerge?.(task.id);
          } catch (enqueueErr: unknown) {
            log.warn(
              `Failed to re-enqueue ${task.id} after stale-merge recovery (will rely on polling sweep): ${enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)}`,
            );
          }
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover interrupted merge ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} interrupted merge task(s)`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Interrupted merge recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /*
  FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD2 — partial-land reconciler):
  Recovers non-done workspace tasks whose per-repo land is incomplete (some/none landed) and
  whose binding is stale — re-enqueuing the merge via `enqueueMerge` (which routes to the
  idempotent `landWorkspaceTask`; already-landed repos are skipped via `isRepoLanded`). We do NOT
  call `landWorkspaceTask` directly. GUARDS (reuse, never reinvent): `allowsAutoMergeProcessing`
  (FN-5147 autoMerge:false), user-pause, and the WORKSPACE-AWARE liveness predicate
  (`isWorkspaceTaskLive`) — triple-proof is NOT workspace-aware so it is deliberately NOT used
  here. A live / paused / autoMerge-off task emits `task:reconcile-workspace-partial-land-no-action`
  and is NEVER moved backward.

  FORK-A (unrecoverable): a sub-repo is unrecoverable iff its `fusion/<id>` branch is GONE AND its
  `landedSha` is UNSET (nothing landed, nothing to land) → park the task `status:"failed"`. Branch
  gone but `landedSha` set → already landed (isRepoLanded ancestor/trailer) → that repo is skipped.
  Otherwise the task is retryable (re-enqueue).
  */
  async reconcileWorkspacePartialLands(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
      // Workspace tasks live in in-review (post-capture/review, pre/partial land). A task already
      // done is finished; todo/in-progress are owned by execution-stage reconcilers.
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, thirty-third sweep):
      A WORKSPACE task lands per-repo, and this re-enqueues one whose lands are partial or zero. The
      literal read meant that on a renamed board a workspace task stranded mid-land was never
      re-enqueued — some repos landed, some not, and nothing to finish the job.

      The comment above records WHY the review lane is the right one; it stays true, only the way the
      lane is named changes.
      */
      const wsPartialColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const wsPartialById = new Map<string, Task>();
      for (const column of wsPartialColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) wsPartialById.set(entry.id, entry);
      }
      const tasks = [...wsPartialById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const wsPartialLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          wsPartialLanes.set(
            entry.id,
            source === "default"
              ? new Set(wsPartialColumns)
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          wsPartialLanes.set(entry.id, new Set(wsPartialColumns));
        }
      }
      const candidates = tasks.filter((task) =>
        (wsPartialLanes.get(task.id) ?? wsPartialColumns).has(task.column) &&
        isWorkspaceTask(task) &&
        task.mergeDetails?.mergeConfirmed !== true &&
        // Active transient merge statuses are owned by the live merger; recover-interrupted /
        // recover-stale-merging clear STALE ones. A non-transient status (or null) is our domain.
        !(task.status && ACTIVE_MERGE_STATUSES.has(task.status)),
      );
      // Drop counters only track LIVE candidates; forget any task that has left the set so a later
      // re-appearance starts fresh (mirror of the mergeStarvationDrops cleanup).
      const candidateIds = new Set(candidates.map((t) => t.id));
      for (const taskId of [...this.workspacePartialLandDrops.keys()]) {
        if (!candidateIds.has(taskId)) this.workspacePartialLandDrops.delete(taskId);
      }

      if (candidates.length === 0) return 0;

      let recovered = 0;
      for (const task of candidates) {
        try {
          // GUARD 1 — FN-5147 autoMerge:false: in-review is human-gated; never move it backward.
          if (!allowsAutoMergeProcessing(task, settings)) {
            await this.emitWorkspacePartialLandNoAction(task, "auto-merge-off", []);
            continue;
          }
          // GUARD 2 — user-pause: a hard operator stop.
          if (task.userPaused || task.paused) {
            await this.emitWorkspacePartialLandNoAction(task, "user-paused", []);
            continue;
          }
          // GUARD 3 — workspace-aware liveness: ANY active sub-repo path / process signal.
          const liveness = this.isWorkspaceTaskLive(task);
          if (liveness.live) {
            await this.emitWorkspacePartialLandNoAction(task, "live-worktree", liveness.livePaths);
            continue;
          }
          // GUARD 4 — a live merge lane owns this exact task right now.
          if (activeMergeTaskId && activeMergeTaskId === task.id) {
            await this.emitWorkspacePartialLandNoAction(task, "live-worktree", liveness.livePaths);
            continue;
          }
          /*
          FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU — merge-queue dispatch blind spot):
          GUARD 5 — the task is anywhere in ProjectEngine's in-memory merge pipeline (queued or
          dequeued-and-dispatching/merging). In the dequeue→rawMerge window the id has been shifted
          out of `mergeQueue` but `activeMergeTaskId` / `merging` status / the workspace-repo-land
          lease have not yet been set, so GUARDs 1-4 and `isWorkspaceTaskLive` all read "not live".
          Re-enqueuing here would launch a SECOND concurrent `landWorkspaceTask(T)`; because a
          same-task land lease is explicitly NOT contention, the two don't block → double-squash.
          `mergeActive` lingers across the whole window, so this guard closes the gap. Never moves
          the task backward; emits no-action and leaves the in-flight dispatch to finish.
          */
          if (this.options.isMergePending?.(task.id) === true) {
            await this.emitWorkspacePartialLandNoAction(task, "merge-pending", liveness.livePaths);
            continue;
          }

          // Classify each acquired sub-repo: landed / retryable / unrecoverable (FORK-A).
          const workspaceWorktrees = task.workspaceWorktrees ?? {};
          const repoKeys = Object.keys(workspaceWorktrees);
          const landedRepos: string[] = [];
          const unlandedRepos: string[] = [];
          const unrecoverableRepos: string[] = [];
          for (const repoRel of repoKeys) {
            const entry = workspaceWorktrees[repoRel];
            const repoRootDir = join(this.options.rootDir, repoRel);
            let integrationBranch: string;
            try {
              integrationBranch = await resolveIntegrationBranch(
                repoRootDir,
                { ...settings, integrationBranch: undefined, baseBranch: undefined },
              );
            } catch {
              // Cannot resolve the sub-repo's integration branch → treat as retryable (re-enqueue
              // re-runs the same resolution and surfaces the real error there).
              unlandedRepos.push(repoRel);
              continue;
            }
            if (await isRepoLanded(repoRootDir, integrationBranch, entry.landedSha, task.id, entry.branch)) {
              landedRepos.push(repoRel);
              continue;
            }
            /*
            FNXC:Workspace 2026-06-22-14:10 (Phase D review D — FORK-A: branch-gone-and-not-landed
            is unrecoverable, regardless of a STALE landedSha):
            We are here because `isRepoLanded` returned FALSE — the recorded `landedSha` (if any) is
            NOT reachable from the integration tip (branch was force-reset / rolled back / never
            actually landed) AND no task-trailer commit is on the ref. The old test was
            `!branchPresent && !entry.landedSha`, which let a repo with a STALE landedSha set but
            UNREACHABLE, and its `fusion/<id>` branch GONE, fall to `unlandedRepos` → re-enqueued →
            `landWorkspaceTask` has NO branch to land → loops forever. Since the repo is provably
            NOT landed, the correct test is: branch GONE ⇒ unrecoverable, whether or not a (stale)
            landedSha is present. Only a branch that still EXISTS is retryable.
            */
            const branchPresent = entry.branch
              ? await this.repoBranchExists(repoRootDir, entry.branch)
              : false;
            if (!branchPresent) {
              unrecoverableRepos.push(repoRel);
            } else {
              unlandedRepos.push(repoRel);
            }
          }

          const auditor = createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-healing-workspace-partial-land", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "reconcile-workspace-partial-land",
          });

          if (unrecoverableRepos.length > 0) {
            // FORK-A: at least one repo can never land (branch gone, nothing landed) → park failed.
            const error = `Workspace partial-land unrecoverable: sub-repo(s) ${unrecoverableRepos.join(", ")} have no fusion/${task.id.toLowerCase()} branch and no landedSha — manual intervention required.`;
            await this.store.updateTask(task.id, { status: "failed", error });
            await this.store.logEntry(task.id, error);
            await auditor.database({
              type: "task:reconcile-workspace-partial-land",
              target: task.id,
              metadata: { taskId: task.id, landedRepos, unlandedRepos, failedRepos: unrecoverableRepos, action: "park-failed", reason: "branch-gone-and-unlanded" },
            }).catch(() => undefined);
            log.warn(`reconcileWorkspacePartialLands: parked ${task.id} failed (unrecoverable repos: ${unrecoverableRepos.join(", ")})`);
            recovered++;
            continue;
          }

          if (unlandedRepos.length === 0) {
            // Every acquired repo is already landed but the task was never finalized (the finalize
            // enqueue was dropped). Re-enqueue: landWorkspaceTask skips all repos and finalizes once.
            await this.enqueueWorkspaceMergeBounded(task, auditor, {
              landedRepos,
              unlandedRepos: [],
              reason: "all-landed-not-finalized",
              successLog: "Auto-recovered (workspace): all sub-repos landed but task not finalized — re-enqueued finalize-once",
            });
            recovered++;
            continue;
          }

          // Partial / none landed, all unlanded repos retryable → re-enqueue the per-repo land.
          await this.enqueueWorkspaceMergeBounded(task, auditor, {
            landedRepos,
            unlandedRepos,
            reason: landedRepos.length > 0 ? "partial-land" : "zero-land",
            successLog: `Auto-recovered (workspace): re-enqueued partial land (${landedRepos.length} landed, ${unlandedRepos.length} pending)`,
          });
          recovered++;
        } catch (err: unknown) {
          log.error(`reconcileWorkspacePartialLands: failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (recovered > 0) log.log(`reconcileWorkspacePartialLands: recovered ${recovered} workspace task(s)`);
      return recovered;
    } catch (err: unknown) {
      log.error(`reconcileWorkspacePartialLands sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  private async emitWorkspacePartialLandNoAction(
    task: Task,
    reason: "auto-merge-off" | "user-paused" | "live-worktree" | "merge-pending",
    livePaths: string[],
  ): Promise<void> {
    try {
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-healing-workspace-partial-land-no-action", task.id),
        agentId: "self-healing",
        taskId: task.id,
        taskLineageId: task.lineageId,
        phase: "reconcile-workspace-partial-land",
      }).database({
        type: "task:reconcile-workspace-partial-land-no-action",
        target: task.id,
        metadata: { taskId: task.id, reason, livePaths },
      });
    } catch (err: unknown) {
      log.warn(`reconcileWorkspacePartialLands: audit emit failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /*
  FNXC:Workspace 2026-06-22-14:10 (Phase D review B — bounded re-enqueue, no silent infinite loop):
  Re-enqueue a workspace task's per-repo land via `enqueueMerge`, CAPTURING the boolean it returns.
  `enqueueMerge` returns false when the merge queue rejects (full); the old code discarded it, so a
  permanently-rejected task would re-enqueue forever. Mirror `mergeStarvationDrops` in
  recoverMergeableReviewTasks: on false, increment a per-task drop counter and after
  MAX_STARVATION_DROPS consecutive drops park the task `status:"failed"` (escalate). On a successful
  enqueue, reset the counter. When `enqueueMerge` is not wired (option undefined), this is a graceful
  no-op (not a crash) — recovery falls back to the next sweep / polling.
  Returns true iff the task was parked failed.
  */
  private async enqueueWorkspaceMergeBounded(
    task: Task,
    auditor: RunAuditor,
    input: { landedRepos: string[]; unlandedRepos: string[]; reason: string; successLog: string },
  ): Promise<boolean> {
    const enqueueMerge = this.options.enqueueMerge;
    if (!enqueueMerge) {
      // Option not wired (standalone/tests with no queue) → graceful no-op; rely on next sweep.
      this.workspacePartialLandDrops.delete(task.id);
      await this.store.logEntry(task.id, `${input.successLog} (enqueue not wired — deferred to next sweep)`);
      await auditor.database({
        type: "task:reconcile-workspace-partial-land",
        target: task.id,
        metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "re-enqueue-noop", reason: input.reason },
      }).catch(() => undefined);
      return false;
    }

    const queued = enqueueMerge(task.id);
    if (queued) {
      this.workspacePartialLandDrops.delete(task.id);
      await this.store.logEntry(task.id, input.successLog);
      await auditor.database({
        type: "task:reconcile-workspace-partial-land",
        target: task.id,
        metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "re-enqueue", reason: input.reason },
      }).catch(() => undefined);
      return false;
    }

    const drops = (this.workspacePartialLandDrops.get(task.id) ?? 0) + 1;
    this.workspacePartialLandDrops.set(task.id, drops);
    log.warn(`reconcileWorkspacePartialLands: enqueue dropped for ${task.id} (${drops}/${MAX_STARVATION_DROPS}); merge queue rejected re-enqueue`);
    if (drops >= MAX_STARVATION_DROPS) {
      const error = `Workspace partial-land starvation: ${MAX_STARVATION_DROPS} consecutive enqueue attempts were dropped by the merge queue; task requires manual intervention.`;
      await this.store.updateTask(task.id, { status: "failed", error });
      await this.store.logEntry(task.id, error);
      this.workspacePartialLandDrops.delete(task.id);
      await auditor.database({
        type: "task:reconcile-workspace-partial-land",
        target: task.id,
        metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "park-failed", reason: "enqueue-starvation" },
      }).catch(() => undefined);
      return true;
    }
    await auditor.database({
      type: "task:reconcile-workspace-partial-land",
      target: task.id,
      metadata: { taskId: task.id, landedRepos: input.landedRepos, unlandedRepos: input.unlandedRepos, failedRepos: [], action: "re-enqueue-dropped", reason: input.reason, drops },
    }).catch(() => undefined);
    return false;
  }

  /** True iff `branch` exists as a local ref in the sub-repo at `repoRootDir`. */

  /*
  FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD3 — phantom workspace-repo-land lease reclaim):
  A `workspace-repo-land` lease is registered on a sub-repo's ABSOLUTE path while a workspace task
  lands it, and released in a finally. If the holder dies between register and release, the lease
  leaks; because the owner is terminal/dead it is gone from the in-progress lists, so FN-6736's
  iterate-tasks reclaim cannot surface it. We enumerate `workspace-repo-land` entries via the new
  registry seam and, for each whose owning task is terminal/dead AND whose `registeredAt` is older
  than the FN-6736 staleness floor (graceMs * PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER), clear the
  lease (unregister the path) + emit `task:reclaim-phantom-workspace-land-lease`. A lease owned by a
  LIVE merging task (still in-review with a transient merge status, or the active merge task) is
  UNTOUCHED — only a demonstrably dead owner is reclaimed.
  */
  async reclaimPhantomWorkspaceLandLeases(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const entries = activeSessionRegistry.entriesByKind("workspace-repo-land");
      if (entries.length === 0) return 0;

      /* FNXC:WorkflowResolvedColumns 2026-07-31-23:40: resolved once per sweep, AFTER the early
         return above, so a board with no leases pays nothing. See `isWorkspaceOwnerLive`. */
      const leaseOwnerCompleteColumns = await resolveProjectColumnsForRoles(this.store, ["complete"]);

      const graceMs = settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS;
      const staleFloorMs = graceMs * PHANTOM_EXECUTOR_BINDING_AGE_MULTIPLIER;
      const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
      const now = Date.now();

      let reclaimed = 0;
      for (const entry of entries) {
        try {
          const ageMs = now - entry.registeredAt;
          if (ageMs < staleFloorMs) continue; // too recent — a live land is still warming.

          // A live merge lane / executing owner keeps the lease.
          if (activeMergeTaskId && activeMergeTaskId === entry.taskId) continue;
          if (executingTaskLock.has(entry.taskId) || this.options.isTaskActive?.(entry.taskId) === true) continue;
          /*
          FNXC:Workspace 2026-06-22-16:40 (Phase D P1 TOCTOU — merge-queue dispatch blind spot):
          If the owner is anywhere in the in-memory merge pipeline (queued or dequeued-and-merging),
          the lease is about to be (or is being) LEGITIMATELY used by an in-flight
          `landWorkspaceTask` — it just hasn't registered the lease yet (or registered it this very
          instant). `activeMergeTaskId` only names the single in-flight rawMerge and does not cover
          the dequeue→rawMerge window, so it can read null here while a dispatch is in progress.
          Reclaiming now would yank the lease out from under a live land. Skip; the existing
          age-floor + terminal-owner guards still apply once the owner truly settles.
          */
          if (this.options.isMergePending?.(entry.taskId) === true) continue;

          const owner = await this.store.getTask(entry.taskId).catch(() => null);
          const ownerColumn = owner?.column ?? "deleted";
          // Only a DEMONSTRABLY TERMINAL owner's lease is reclaimed (review C fix).
          if (this.isWorkspaceOwnerLive(owner, leaseOwnerCompleteColumns)) continue;

          activeSessionRegistry.unregisterPath(entry.path);
          await createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-healing-phantom-workspace-land-lease", entry.taskId),
            agentId: "self-healing",
            taskId: entry.taskId,
            phase: "reclaim-phantom-workspace-land-lease",
          }).database({
            type: "task:reclaim-phantom-workspace-land-lease",
            target: entry.taskId,
            metadata: { taskId: entry.taskId, path: entry.path, kind: entry.kind, registeredAt: entry.registeredAt, ageMs, staleBindingAgeFloorMs: staleFloorMs, ownerColumn },
          }).catch(() => undefined);
          log.warn(`reclaimPhantomWorkspaceLandLeases: reclaimed leaked land lease on ${entry.path} (owner ${entry.taskId}, age ${ageMs}ms)`);
          reclaimed++;
        } catch (err: unknown) {
          log.error(`reclaimPhantomWorkspaceLandLeases: failed for ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (reclaimed > 0) log.log(`reclaimPhantomWorkspaceLandLeases: reclaimed ${reclaimed} leaked lease(s)`);
      return reclaimed;
    } catch (err: unknown) {
      log.error(`reclaimPhantomWorkspaceLandLeases sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /*
  FNXC:PlanningEvacuation 2026-07-25-23:00 (pre-execution worktree sweep):
  Planning acquires the task's own worktree, so cards that never reach execution would accumulate
  worktrees on disk: withdrawn to an intake column, archived from a planner lane, or simply parked.
  This sweep reclaims them.

  Candidates are addressed from task ROWS (never a directory walk — AGENTS.md forbids unbounded temp
  scans): tasks holding `worktree` that sit in a non-executing column and carry no execution
  timestamp. `todo` is deliberately EXCLUDED: a planned card waiting for a WIP slot legitimately
  keeps its worktree, and churning it would just force a re-acquire minutes later. Every real safety
  decision (live session, clean branch, execution evidence) belongs to
  `TaskExecutor.releasePreExecutionWorktree`, so this sweep cannot diverge from the event-driven path
  that runs on the move itself.
  */
  async reconcilePreExecutionWorktrees(): Promise<number> {
    try {
      const release = this.options.releasePreExecutionWorktree;
      if (!release) return 0;
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const now = Date.now();
      /* FNXC:WorkflowResolvedColumns 2026-07-31-23:40: resolved once per sweep — see the guard below. */
      const preExecLiveColumns = await resolveProjectColumnsForRoles(
        this.store,
        ["intake", "hold", "countsTowardWip", ...REVIEW_ROLES, "complete"],
      );
      const parked = await this.store.listTasks({ slim: true });
      const candidates = parked.filter((task) => {
        if (!task.worktree || task.deletedAt) return false;
        // Execution evidence — the worktree may hold real work; only the merge/archive lifecycle owns it.
        if (task.firstExecutionAt || task.executionStartedAt) return false;
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-23:40:
        Columns where a card is active or queued to become active — resolved MEMBERSHIP. An EXCLUSION
        from a sweep that REMOVES worktrees, so a legacy-seeded superset can only be conservative;
        the literal's failure mode was the dangerous direction, treating a live card on a renamed
        board as pre-execution and removing its worktree.
        */
        if (preExecLiveColumns.has(task.column)) return false;
        /*
        WAITING is not PARKED. A card paused for an operator decision, carrying any status (planning,
        needs-replan, awaiting-*), blocked on another task, or scheduled for a recovery attempt is
        still expected to resume — taking its worktree would disturb work that is merely queued.
        */
        if (task.paused || task.userPaused) return false;
        if (task.status != null) return false;
        if (task.blockedBy || task.overlapBlockedBy || task.nextRecoveryAt) return false;
        /*
        AGE GATE: only very old trees. A recently parked card is routinely un-parked within minutes,
        and re-acquiring costs a clone-ish setup plus the project's init command. Idleness is measured
        from the most recent of the column move and the last update, so any touch re-arms the clock.
        */
        const lastTouchedMs = Math.max(
          Date.parse(task.columnMovedAt ?? "") || 0,
          Date.parse(task.updatedAt ?? "") || 0,
        );
        if (!lastTouchedMs) return false; // cannot prove age → never sweep
        return now - lastTouchedMs >= PRE_EXECUTION_WORKTREE_MAX_IDLE_MS;
      });
      if (candidates.length === 0) return 0;

      let released = 0;
      for (const task of candidates) {
        try {
          if (await release(task.id, `parked pre-execution in '${task.column}'`)) released++;
        } catch (err: unknown) {
          log.warn(`reconcilePreExecutionWorktrees: release failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (released > 0) log.log(`reconcilePreExecutionWorktrees: released ${released} pre-execution worktree(s)`);
      return released;
    } catch (err: unknown) {
      log.error(`reconcilePreExecutionWorktrees sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  /*
  FNXC:Workspace 2026-06-22-09:30 (Phase D U1, KTD4 — per-repo worktree cleanup from STORED paths):
  For done/dead workspace tasks, remove each recorded per-repo worktree. The paths are ADDRESSABLE
  from the task row (`workspaceWorktrees[repo].worktreePath`, persisted) so we NEVER walk the temp
  root / readdir the temp tree (AGENTS.md forbids unbounded temp walks) — the sweep is bounded by
  construction. Each removal is GUARDED by `activeSessionRegistry.isPathActive(path)` (skip if
  active, mirroring the temp-dir sweep at the AI-merge worktree guard) so a still-live path is never
  yanked. Emit `task:reconcile-orphaned-workspace-worktree` per removed path.
  */
  async reconcileOrphanedWorkspaceWorktrees(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      // Done workspace tasks are the canonical "safe to clean" set (their lands are finalized).
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, thirty-fourth sweep):
      Removes the per-repo worktrees a finished workspace task left behind. The literal read meant that
      on a renamed board they were never removed — disk held by tasks that finished, growing quietly.

      `complete` only, NOT the terminal union: the comment above calls DONE tasks "the canonical safe to
      clean set" precisely because their lands are finalized, and an archived row is a different claim.
      No per-card verdict: the filter is `isWorkspaceTask`, not a lane test.
      */
      const wsDoneColumns = await resolveProjectColumnsForRoles(this.store, ["complete"]);
      const wsDoneById = new Map<string, Task>();
      for (const column of wsDoneColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) wsDoneById.set(entry.id, entry);
      }
      const candidates = [...wsDoneById.values()].filter((task) => isWorkspaceTask(task));
      if (candidates.length === 0) return 0;

      let cleaned = 0;
      for (const task of candidates) {
        const workspaceWorktrees = task.workspaceWorktrees ?? {};
        for (const repoRel of Object.keys(workspaceWorktrees)) {
          const worktreePath = workspaceWorktrees[repoRel]?.worktreePath;
          if (!worktreePath) continue;
          // GUARD: skip an active path (mirror self-healing temp-dir sweep isPathActive guard).
          if (activeSessionRegistry.isPathActive(worktreePath)) continue;
          // Nothing on disk → nothing to remove (already cleaned). Skip silently; clear any prior
          // failure count so a re-created path starts fresh.
          if (!existsSync(worktreePath)) {
            this.orphanWorktreeRemovalFailures.delete(worktreePath);
            continue;
          }
          /*
          FNXC:Workspace 2026-06-22-14:10 (Phase D review E — bounded + observable orphan removal):
          A `git worktree remove --force` failure was caught + audit-logged but NOT engine-logged,
          and retried EVERY tick FOREVER (a genuinely stuck path pins this sweep indefinitely). Bound
          the retry per-path: after MAX_STARVATION_DROPS consecutive failures stop attempting (leave
          the path for manual cleanup) and `log.warn` each failure for observability.
          */
          if ((this.orphanWorktreeRemovalFailures.get(worktreePath) ?? 0) >= MAX_STARVATION_DROPS) {
            continue; // exhausted retries — stop hammering a stuck path.
          }

          const repoRootDir = join(this.options.rootDir, repoRel);
          let success = false;
          let reason = "removed";
          try {
            await execAsync(`git worktree remove --force ${shellQuote(worktreePath)}`, {
              cwd: repoRootDir,
              timeout: 120_000,
            });
            success = true;
          } catch (err: unknown) {
            reason = `git-remove-failed: ${err instanceof Error ? err.message : String(err)}`;
          }
          try {
            await createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-healing-orphaned-workspace-worktree", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "reconcile-orphaned-workspace-worktree",
            }).database({
              type: "task:reconcile-orphaned-workspace-worktree",
              target: task.id,
              metadata: { taskId: task.id, repo: repoRel, worktreePath, success, reason },
            });
          } catch { /* audit best-effort */ }
          if (success) {
            this.orphanWorktreeRemovalFailures.delete(worktreePath);
            log.log(`reconcileOrphanedWorkspaceWorktrees: removed ${worktreePath} (task ${task.id}, repo ${repoRel})`);
            cleaned++;
          } else {
            const failures = (this.orphanWorktreeRemovalFailures.get(worktreePath) ?? 0) + 1;
            this.orphanWorktreeRemovalFailures.set(worktreePath, failures);
            log.warn(`reconcileOrphanedWorkspaceWorktrees: ${reason} for ${worktreePath} (task ${task.id}, repo ${repoRel}) [${failures}/${MAX_STARVATION_DROPS}]${failures >= MAX_STARVATION_DROPS ? " — giving up; manual cleanup required" : ""}`);
          }
        }
      }
      if (cleaned > 0) log.log(`reconcileOrphanedWorkspaceWorktrees: removed ${cleaned} orphaned per-repo worktree(s)`);
      return cleaned;
    } catch (err: unknown) {
      log.error(`reconcileOrphanedWorkspaceWorktrees sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }



  async recoverDoneTaskMergeMetadata(): Promise<number> {
    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, thirty-first sweep):
      Repairs the merge metadata of a card that already reached the COMPLETE lane — the commit sha an
      operator sees, and that later reconcilers trust. The literal read meant that on a renamed board a
      done card's metadata was never repaired, so a completed task could keep pointing at a commit that
      is not the one that landed.

      `complete` only, NOT the terminal union: an ARCHIVED card is out of scope here, and widening to
      TERMINAL_ROLES would start repairing metadata on rows nobody is reading — a behaviour change
      wearing a conversion's clothes.
      */
      const doneMetaColumns = await resolveProjectColumnsForRoles(this.store, ["complete"]);
      const doneMetaById = new Map<string, Task>();
      for (const column of doneMetaColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) doneMetaById.set(entry.id, entry);
      }
      const tasks = [...doneMetaById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const doneMetaLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          doneMetaLanes.set(entry.id, source === "default" ? new Set(doneMetaColumns) : new Set(columnsWithFlag(ir, "complete")));
        } catch {
          doneMetaLanes.set(entry.id, new Set(doneMetaColumns));
        }
      }
      const candidates = tasks.filter((task) => {
        if (!(doneMetaLanes.get(task.id) ?? doneMetaColumns).has(task.column) || task.paused) return false;
        if (task.mergeDetails?.commitSha) return true;
        return Boolean(task.baseCommitSha);
      });
      if (candidates.length === 0) return 0;

      let repaired = 0;
      for (const task of candidates) {
        /*
        FNXC:Workspace 2026-06-22-14:10 (Phase D review F — workspace done-metadata corruption gate):
        This reconciler assumes ONE git repo at `this.options.rootDir` and calls `findLandedTaskCommit`
        over it. For a workspace task that root is NON-git, so `findLandedTaskCommit` returns null.
        `finalizeWorkspaceTask` sets `mergeConfirmed: anyLanded` — a pure NO-OP workspace task (zero
        repos landed) is moved to done with `mergeConfirmed:false`, so it reaches the non-confirmed
        branch below. There, `landed===null` + a stored `commitSha` would wipe `mergeDetails:undefined`
        — corrupting a legitimately-done workspace task's per-repo land map (`workspaceLandedShas`).
        The confirmed branch is also meaningless here (no single rootDir commit). Skip workspace tasks
        entirely; their mergeDetails are authored once by `finalizeWorkspaceTask` and never need this
        single-repo metadata repair.
        */
        if (isWorkspaceTask(task)) continue;
        if (task.mergeDetails?.landedFilesAttributionRestricted || task.mergeDetails?.noOpVerifiedShortCircuit) {
          log.debug(`recoverDoneTaskMergeMetadata: skipped ${task.id} — attribution-restricted`);
          continue;
        }
        try {
          const storedSha = task.mergeDetails?.commitSha;

          if (task.mergeDetails?.mergeConfirmed === true) {
            if (!storedSha) continue;
            const landed = await this.findLandedTaskCommit(task);
            if (!landed || landed.sha !== storedSha) {
              log.warn(
                `Refusing to overwrite confirmed mergeDetails.commitSha for ${task.id} — stored SHA ${storedSha.slice(0, 8)} no longer reachable; preserving canonical attribution`,
              );
              continue;
            }

            const liveShortstat = await this.readShortstatForSha(storedSha, task.mergeDetails?.rebaseBaseSha);
            const liveLandedFiles = await this.readLandedFilesForSha(storedSha, task.mergeDetails?.rebaseBaseSha);
            const currentLandedFiles = task.mergeDetails?.landedFiles;
            const confirmedProofVerdict = await validateWorkflowDoneMergeProof({
              ...task,
              mergeDetails: {
                ...task.mergeDetails,
                landedFiles: liveLandedFiles ?? currentLandedFiles,
                mergeConfirmed: true,
              },
            } as Task);
            if (!confirmedProofVerdict.ok) {
              /*
              FNXC:WorkflowMerge 2026-07-01-10:28:
              Done-task metadata repair is not allowed to convert stale workflow proof into truth. Missing merge confirmation, pending workflow steps, or invalid no-op proof still block repair; stale branch residue does not, because finalization only needs durable evidence that the task patch landed.
              */
              log.warn(`recoverDoneTaskMergeMetadata: skipped ${task.id} — invalid done merge proof (${confirmedProofVerdict.reason})`);
              await this.store.logEntry(task.id, `Done-task merge metadata repair skipped: invalid workflow merge proof (${confirmedProofVerdict.reason})`).catch(() => undefined);
              continue;
            }
            const landedFilesMismatch = Boolean(
              liveLandedFiles && (
                !currentLandedFiles ||
                liveLandedFiles.length !== currentLandedFiles.length ||
                liveLandedFiles.some((file, index) => currentLandedFiles[index] !== file)
              ),
            );
            const statsMismatch = Boolean(
              liveShortstat && (
                task.mergeDetails?.filesChanged !== liveShortstat.filesChanged ||
                task.mergeDetails?.insertions !== liveShortstat.insertions ||
                task.mergeDetails?.deletions !== liveShortstat.deletions
              ),
            );

            const needsMetadataRepair =
              task.mergeDetails?.filesChanged === undefined ||
              task.mergeDetails?.insertions === undefined ||
              task.mergeDetails?.deletions === undefined ||
              task.mergeDetails?.mergeCommitMessage === undefined ||
              !currentLandedFiles ||
              landedFilesMismatch ||
              statsMismatch;

            if (!needsMetadataRepair) continue;

            const nextFilesChanged = liveShortstat?.filesChanged ?? task.mergeDetails?.filesChanged ?? landed.filesChanged;
            const nextInsertions = liveShortstat?.insertions ?? task.mergeDetails?.insertions ?? landed.insertions;
            const nextDeletions = liveShortstat?.deletions ?? task.mergeDetails?.deletions ?? landed.deletions;

            await this.store.updateTask(task.id, {
              mergeDetails: {
                ...task.mergeDetails,
                filesChanged: nextFilesChanged,
                insertions: nextInsertions,
                deletions: nextDeletions,
                landedFiles: liveLandedFiles ?? task.mergeDetails?.landedFiles,
                mergeCommitMessage: task.mergeDetails?.mergeCommitMessage ?? landed.subject,
                rebaseBaseSha: task.mergeDetails?.rebaseBaseSha ?? landed.rebaseBaseSha,
                mergedAt: task.mergeDetails?.mergedAt ?? new Date().toISOString(),
                prNumber: getPrimaryPrInfo(task)?.number,
              },
              modifiedFiles: liveLandedFiles && liveLandedFiles.length > 0 ? liveLandedFiles : undefined,
            });
            if ((statsMismatch && liveShortstat) || landedFilesMismatch) {
              await this.store.logEntry(
                task.id,
                `Auto-recovered: stale mergeDetails repaired (was ${task.mergeDetails?.filesChanged ?? "?"}/${task.mergeDetails?.insertions ?? "?"}/${task.mergeDetails?.deletions ?? "?"}, now ${liveShortstat?.filesChanged ?? nextFilesChanged}/${liveShortstat?.insertions ?? nextInsertions}/${liveShortstat?.deletions ?? nextDeletions})${landedFilesMismatch ? ` (files ${task.mergeDetails?.landedFiles?.length ?? 0} → ${liveLandedFiles?.length ?? task.mergeDetails?.landedFiles?.length ?? 0})` : ""} — sha unchanged ${storedSha.slice(0, 8)}`,
              );
            } else {
              await this.store.logEntry(task.id, `Auto-recovered: reconciled done-task mergeDetails to owned commit ${landed.sha.slice(0, 8)}`);
            }
            repaired++;
            continue;
          }

          const landed = await this.findLandedTaskCommit(task, { preferEarliestOwnedCommit: true });
          if (!landed) {
            if (!storedSha) {
              continue;
            }
            await this.store.updateTask(task.id, { mergeDetails: undefined });
            await this.store.logEntry(task.id, "Auto-recovered: cleared unowned done-task mergeDetails commitSha");
            repaired++;
            continue;
          }

          const landedStats = {
            filesChanged: landed.filesChanged ?? 0,
            insertions: landed.insertions ?? 0,
            deletions: landed.deletions ?? 0,
          };
          const landedFiles = await this.readLandedFilesForSha(landed.sha, task.mergeDetails?.rebaseBaseSha ?? landed.rebaseBaseSha);
          const repairedProofVerdict = await validateWorkflowDoneMergeProof({
            ...task,
            mergeDetails: {
              ...task.mergeDetails,
              commitSha: landed.sha,
              landedFiles: landedFiles ?? task.mergeDetails?.landedFiles,
              mergeConfirmed: true,
            },
          } as Task);
          if (!repairedProofVerdict.ok) {
            log.warn(`recoverDoneTaskMergeMetadata: skipped ${task.id} — invalid repaired merge proof (${repairedProofVerdict.reason})`);
            await this.store.logEntry(task.id, `Done-task merge metadata repair skipped: invalid repaired workflow merge proof (${repairedProofVerdict.reason})`).catch(() => undefined);
            continue;
          }

          const needsRepair =
            task.mergeDetails?.commitSha !== landed.sha ||
            task.mergeDetails?.filesChanged === undefined ||
            task.mergeDetails?.insertions === undefined ||
            task.mergeDetails?.deletions === undefined ||
            !task.mergeDetails?.landedFiles || (
              task.mergeDetails?.commitSha === landed.sha && (
                task.mergeDetails?.filesChanged !== landedStats.filesChanged ||
                task.mergeDetails?.insertions !== landedStats.insertions ||
                task.mergeDetails?.deletions !== landedStats.deletions ||
                (landedFiles ? (
                  task.mergeDetails?.landedFiles?.length !== landedFiles.length ||
                  landedFiles.some((file, index) => task.mergeDetails?.landedFiles?.[index] !== file)
                ) : false)
              )
            );

          if (!needsRepair) continue;

          await this.store.updateTask(task.id, {
            mergeDetails: {
              ...task.mergeDetails,
              commitSha: landed.sha,
              filesChanged: landedStats.filesChanged,
              insertions: landedStats.insertions,
              deletions: landedStats.deletions,
              mergeCommitMessage: landed.subject,
              rebaseBaseSha: task.mergeDetails?.rebaseBaseSha ?? landed.rebaseBaseSha,
              landedFiles: landedFiles ?? task.mergeDetails?.landedFiles,
              mergedAt: task.mergeDetails?.mergedAt ?? new Date().toISOString(),
              mergeConfirmed: true,
              prNumber: getPrimaryPrInfo(task)?.number,
            },
            modifiedFiles: landedFiles && landedFiles.length > 0 ? landedFiles : undefined,
          });
          await this.store.logEntry(task.id, `Auto-recovered: reconciled done-task mergeDetails to owned commit ${landed.sha.slice(0, 8)}`);
          repaired++;
        } catch (err: unknown) {
          log.error(`Failed done-task merge metadata recovery for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return repaired;
    } catch (err: unknown) {
      log.error(`Done-task merge metadata recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  // ── Misclassified failure recovery ───────────────────────────────

  /**
   * Recover tasks that already merged successfully but never reached `done`.
   *
   * This catches races where the merge completed and merge metadata was stored,
   * but a later transition failed or another process moved the task before the
   * final `in-review` → `done` update completed.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   * @returns Number of tasks recovered
   */
  async recoverMergedReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, fifteenth sweep):
      A task whose merge is CONFIRMED but which never reached the complete lane. Two literal reads meant
      that on a renamed board it was never found, so a card whose work is merged sat in review or hold
      forever while its commit was already on the base branch.

      The two `t.column === …` checks were redundant while the query pinned the column; under a resolved
      read they become the per-card verdict, so they convert rather than being deleted.
      */
      const mergedReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const mergedHoldColumns = await resolveProjectColumnsForRoles(this.store, ["hold"]);
      const readMergedBucket = async (columns: ReadonlySet<string>): Promise<Task[]> => {
        const byId = new Map<string, Task>();
        for (const column of columns) {
          for (const entry of await this.store.listTasks({ column, slim: true })) byId.set(entry.id, entry);
        }
        return [...byId.values()];
      };
      const [reviewTasks, todoTasks] = await Promise.all([
        readMergedBucket(mergedReviewColumns),
        readMergedBucket(mergedHoldColumns),
      ]);
      /*
      Per-card lanes. NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT — the shape #2891 settled on:
      `resolveWorkflowIrForTask` SUBSTITUTES the built-in IR rather than failing, so a card with an
      unreadable selection would otherwise be rejected by the verdict that the project-scoped query had
      just admitted from a renamed lane. Falling back to the project sets keeps it.
      */
      const mergedLanes = new Map<string, { review: Set<string>; hold: Set<string> }>();
      for (const task of [...reviewTasks, ...todoTasks]) {
        if (mergedLanes.has(task.id)) continue;
        const lanes = { review: new Set<string>(), hold: new Set<string>() };
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id);
          if (source === "default") {
            for (const id of mergedReviewColumns) lanes.review.add(id);
            for (const id of mergedHoldColumns) lanes.hold.add(id);
          } else {
            for (const role of REVIEW_ROLES) for (const id of columnsWithFlag(ir, role)) lanes.review.add(id);
            for (const id of columnsWithFlag(ir, "hold")) lanes.hold.add(id);
          }
        } catch {
          for (const id of mergedReviewColumns) lanes.review.add(id);
          for (const id of mergedHoldColumns) lanes.hold.add(id);
        }
        mergedLanes.set(task.id, lanes);
      }
      const mergedLanesOf = (id: string) => mergedLanes.get(id) ?? { review: mergedReviewColumns, hold: mergedHoldColumns };

      /* Deduped across the buckets — the P1 reviewed on #2879; a dual-role column would otherwise finalize one card twice. */
      const mergedCandidateById = new Map<string, Task>();
      for (const task of [
        ...reviewTasks.filter((t) => mergedLanesOf(t.id).review.has(t.column)),
        ...todoTasks.filter((t) => mergedLanesOf(t.id).hold.has(t.column)),
      ]) {
        if (!mergedCandidateById.has(task.id)) mergedCandidateById.set(task.id, task);
      }
      const mergedButNotDone = [...mergedCandidateById.values()].filter((t) =>
        !t.deletedAt &&
        allowsAutoMergeProcessing(t, settings) &&
        t.mergeDetails?.mergeConfirmed === true,
      );

      if (mergedButNotDone.length === 0) return 0;

      log.warn(`Found ${mergedButNotDone.length} merged task(s) stuck outside done`);

      let recovered = 0;
      for (const task of mergedButNotDone) {
        try {
          const mergeTarget = await this.resolveSelfHealingMergeTarget(task, settings, "recover-merged-review");
          if (!(await this.isCommitReachableFromBranch(task.mergeDetails?.commitSha, mergeTarget.branch))) {
            await this.recordSharedGroupDefaultTargetGuard(task, "recover-merged-review", {
              reason: "confirmed-commit-not-reachable-from-routed-target",
              commitSha: task.mergeDetails?.commitSha ?? null,
              mergeTargetBranch: mergeTarget.branch,
              mergeTargetSource: mergeTarget.source ?? null,
            });
            continue;
          }

          const clearedFlags = {
            paused: Boolean(task.paused),
            status: Boolean(task.status),
            error: Boolean(task.error),
            blockedBy: Boolean(task.blockedBy),
            overlapBlockedBy: Boolean(task.overlapBlockedBy),
          };
          if (mergeTarget.source) {
            await this.store.updateTask(task.id, {
              mergeDetails: {
                ...(task.mergeDetails || {}),
                mergeTargetBranch: task.mergeDetails?.mergeTargetBranch ?? mergeTarget.branch,
                mergeTargetSource: task.mergeDetails?.mergeTargetSource ?? mergeTarget.source,
              },
            });
          }
          await this.recordSelfHealingBranchGroupMemberLanding(task, mergeTarget, "recover-merged-review");
          /*
           * FNXC:SelfHealingLifecycle 2026-06-22-19:28:
           * File-scope overlap is only a scheduling blocker before content lands; after mergeConfirmed plus reachability proves the content is on the target branch, self-healing must clear stale queued/overlap fields and finalize instead of preserving todo forever.
           */
          const auditor = createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-heal", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "recover-merged-review",
          });
          const finalization = await finalizeProvenAutoMergeTask({
            store: this.store,
            taskId: task.id,
            audit: auditor,
            auditAgentId: "self-healing",
            auditPhase: "recover-merged-review",
            source: "self-healing",
            log: (message) => log.warn(message),
          });
          if (finalization.outcome === "blocked") {
            await this.store.logEntry(
              task.id,
              `Auto-recovery skipped: merge confirmed but finalization blocked — ${finalization.reason ?? "unknown"}`,
            );
            continue;
          }
          this.emitTaskMerged(finalization.task, { mergeConfirmed: true });
          await this.store.logEntry(
            task.id,
            `Auto-finalized from ${task.column}: content proven via mergeConfirmed metadata. Cleared soft state paused=${clearedFlags.paused}, status=${clearedFlags.status}, error=${clearedFlags.error}, blockedBy=${clearedFlags.blockedBy}, overlapBlockedBy=${clearedFlags.overlapBlockedBy}`,
          );
          try {
            await auditor.database({
              type: "task:auto-recover-finalize-already-on-main",
              target: task.id,
              metadata: {
                mergeSha: task.mergeDetails?.commitSha ?? null,
                baseBranch: mergeTarget.branch,
                mergeTargetBranch: mergeTarget.branch,
                mergeTargetSource: mergeTarget.source ?? null,
                clearedFlags,
              },
            });
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`recoverMergedReviewTasks: failed to record run-audit event for ${task.id}: ${errorMessage}`);
          }
          log.log(`Recovered merged task ${task.id}: moved to done`);
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover merged task ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} merged task(s) → done`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Merged review recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover deadlocked retry-exhausted merge failures that are still blocking
   * dispatch via `blockedBy` or retained worktree ownership.
   *
   * Backward lifecycle move gated on triple proof (FN-5335).
   * When the no-landed predicate fails, emits `task:stuck-merge-deadlock-no-action` and skips lifecycle mutation.
   */
  /**
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverStuckMergeDeadlocks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);
      const now = Date.now();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-19:20 (the query-filter class, third sweep):
      FOUR reads, two different jobs, and only the reads were broken.

      `inReview` supplies the CANDIDATES — cards blocked on merge — so it needs both halves: the project
      union for the read, and a per-card verdict against the card's own workflow, because this sweep
      mutates. Same shape as `recoverAlreadyMergedReviewTasks`, provenance and reporting included.

      The other three supply DEPENDENTS, and their verdict is already correct: `filterByPreWipRole`
      resolves intake/hold per card below. The 2026-07-29-17:40 note reasoned that the literal trio was a
      complete union "and the role filter below decides which rows count" — which held for the default and
      legacy lineages it considered, and does not hold for a RENAMED board, where all three reads return
      empty and the role filter is handed nothing to decide about. Widening the reads restores exactly the
      property that note relied on; the filter it points at is unchanged.
      */
      const reviewColumnsForDeadlock = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const inReviewById = new Map<string, Task>();
      for (const column of reviewColumnsForDeadlock) {
        for (const task of await this.store.listTasks({ column, slim: true })) inReviewById.set(task.id, task);
      }
      const deadlockIrCache = new Map<string, WorkflowIr>();
      const unresolvedDeadlockCards: string[] = [];
      const inOwnReviewLaneForDeadlock = async (task: Task): Promise<boolean> => {
        const resolved = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id, deadlockIrCache)
          .catch(() => undefined);
        const own = resolved
          ? [...new Set(REVIEW_ROLES.flatMap((role) => columnsWithFlag(resolved.ir, role)))]
          : [];
        if (!resolved || resolved.source === "default") unresolvedDeadlockCards.push(task.id);
        /* DELIBERATE-LITERAL — the unresolvable-workflow default, reviewed 2026-07-30-19:20. */
        return own.length > 0 ? own.includes(task.column) : task.column === "in-review";
      };
      const inReview = [...inReviewById.values()];

      /* Dependents: read every pre-WIP and WIP lane the project declares; `filterByPreWipRole` below
         still decides per card which of them actually count. */
      const dependentSourceColumns = await resolveProjectColumnsForRoles(
        this.store,
        ["intake", "hold", "countsTowardWip"],
      );
      const dependentsById = new Map<string, Task>();
      for (const column of dependentSourceColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) dependentsById.set(task.id, task);
      }
      const dependentSources = [...dependentsById.values()];

      const dependentsByBlocker = new Map<string, Task[]>();
      for (const task of dependentSources) {
        if (!task.blockedBy) continue;
        const dependents = dependentsByBlocker.get(task.blockedBy) ?? [];
        dependents.push(task);
        dependentsByBlocker.set(task.blockedBy, dependents);
      }

      /*
      FNXC:WorkflowColumns 2026-07-29-09:30 (Phase B): "dependents parked before WIP"
      is an intake-or-hold ROLE question, but the filter below is synchronous and
      role resolution reads the workflow IR. Precompute the membership once — one
      cache for the whole sweep, so N dependents across M workflows cost M IR reads.
      */
      const preWipCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const allDependents = [...dependentsByBlocker.values()].flat();
      const preWipDependentIds = new Set(
        (await this.filterByPreWipRole(allDependents, ["intake", "hold"], preWipCache)).map((t) => t.id),
      );

      const candidates = inReview.filter((task) => {
        if (task.deletedAt) return false;
        const cooldownStart = this.deadlockRecoveryCooldown.get(task.id) ?? 0;
        const cooldownElapsed = now - cooldownStart;
        const hasBlockedDependents = (dependentsByBlocker.get(task.id) ?? []).some(
          (dep) => preWipDependentIds.has(dep.id),
        );
        /* Lane identity is decided per card by `inOwnReviewLaneForDeadlock` below — this synchronous
           filter keeps every other condition, so the async check runs only for rows that already qualify. */
        return allowsAutoMergeProcessing(task, settings) &&
          !task.paused &&
          task.status === "failed" &&
          (task.mergeRetries ?? 0) >= maxAutoMergeRetries &&
          task.mergeDetails?.mergeConfirmed !== true &&
          (hasBlockedDependents || Boolean(task.worktree)) &&
          cooldownElapsed >= DEADLOCK_RECOVERY_COOLDOWN_MS;
      });

      /* The per-card lane verdict is async, so it cannot live in the filter above. */
      const laneQualified: Task[] = [];
      for (const task of candidates) {
        if (await inOwnReviewLaneForDeadlock(task)) laneQualified.push(task);
      }
      if (unresolvedDeadlockCards.length > 0) {
        log.warn(
          `merge-deadlock recovery: ${unresolvedDeadlockCards.length} card(s) measured against the `
          + `built-in review lane because their own workflow could not be resolved `
          + `(${unresolvedDeadlockCards.slice(0, 5).join(", ")}); a renamed review lane there stays deadlocked.`,
        );
      }

      if (laneQualified.length === 0) return 0;

      let recovered = 0;
      for (const task of laneQualified) {
        if (task.deletedAt) continue;
        const blockedDependents = dependentsByBlocker.get(task.id) ?? [];
        const blockedTaskIds = blockedDependents.map((dep) => dep.id);
        try {
          /*
          FNXC:Workspace 2026-06-22-14:10 (Phase D review A — P0 workspace gate, TWIN of KTD1):
          This is the deadlock-recovery TWIN of recoverInterruptedMergingTasks. Its candidate
          filter admits `hasBlockedDependents || Boolean(task.worktree)`, so a workspace task
          (task.worktree===null) WITH blocked dependents passes and would reach the single-commit
          `findLandedTaskCommit`/moveTask(done)+emitTaskMerged finalize over the NON-git workspace
          root — the exact P0: a one-repo commit (or empty) marking a PARTIAL-landed workspace task
          fully merged. A workspace task MUST NOT be single-commit-finalized here. Clear the transient
          status, leave it in-review, and let the workspace-aware partial-land reconciler
          (reconcileWorkspacePartialLands) re-enqueue the idempotent per-repo land. We never move a
          workspace task backward here.
          */
          if (isWorkspaceTask(task)) {
            if (task.status) await this.store.updateTask(task.id, { status: null, error: null });
            this.options.clearMergeActive?.(task.id);
            await this.store.logEntry(
              task.id,
              "Auto-recovery (workspace): cleared stale deadlock 'failed' status; partial-land reconciler owns per-repo re-land (no single-commit finalize)",
            );
            log.warn(`self-heal:deadlock-recovery-workspace-skip ${JSON.stringify({ stuckTaskId: task.id, blockedTaskIds, action: "cleared-status-deferred-to-partial-land-reconciler" })}`);
            recovered++;
            continue;
          }

          const mergeTarget = await this.resolveSelfHealingMergeTarget(task, settings, "recover-stuck-merge-deadlocks");
          const landedCommit = await this.findLandedTaskCommit(task);
          const landedOnTarget = landedCommit
            ? await this.isCommitReachableFromBranch(landedCommit.sha, mergeTarget.branch)
            : false;
          if (landedCommit && !landedOnTarget) {
            await this.recordSharedGroupDefaultTargetGuard(task, "recover-stuck-merge-deadlocks", {
              reason: "landed-commit-not-reachable-from-routed-target",
              commitSha: landedCommit.sha,
              mergeTargetBranch: mergeTarget.branch,
              mergeTargetSource: mergeTarget.source ?? null,
            });
          }
          if (landedCommit && landedOnTarget) {
            const mergeCommitMessage = await regenerateBareMergeSubject({
              subject: landedCommit.subject,
              commitSha: landedCommit.sha,
              branch: task.branch ?? "",
              taskId: task.id,
              rootDir: this.options.rootDir,
              settings,
            });
            const mergeDetails: MergeDetails = {
              commitSha: landedCommit.sha,
              rebaseBaseSha: landedCommit.rebaseBaseSha,
              filesChanged: landedCommit.filesChanged,
              insertions: landedCommit.insertions,
              deletions: landedCommit.deletions,
              mergeCommitMessage,
              mergedAt: new Date().toISOString(),
              mergeConfirmed: true,
              prNumber: getPrimaryPrInfo(task)?.number,
              mergeTargetBranch: mergeTarget.branch,
              mergeTargetSource: mergeTarget.source,
            };

            await this.store.updateTask(task.id, {
              status: null,
              error: null,
              mergeRetries: 0,
              worktree: null,
              branch: null,
              mergeDetails,
            });
            await this.recordSelfHealingBranchGroupMemberLanding(task, mergeTarget, "recover-stuck-merge-deadlocks");
            const completeLane = (await resolveTaskLifecycleColumns(this.store, task.id))?.complete ?? "done";
const movedTask = await this.store.moveTask(task.id, completeLane);
            this.emitTaskMerged(movedTask, { mergeConfirmed: true });
            await this.cleanupInterruptedMergeArtifacts(task);

            const clearedDependents: string[] = [];
            for (const dep of blockedDependents) {
              try {
                await this.store.updateTask(dep.id, { blockedBy: null });
                await this.store.logEntry(dep.id, `Auto-recovered: cleared stale blockedBy ${task.id} after deadlock recovery`);
                clearedDependents.push(dep.id);
              } catch (depErr: unknown) {
                const depErrMessage = depErr instanceof Error ? depErr.message : String(depErr);
                log.warn(`self-heal:deadlock-recovery-dependent-error ${JSON.stringify({ blockerTaskId: task.id, dependentTaskId: dep.id, error: depErrMessage })}`);
              }
            }

            await this.store.logEntry(
              task.id,
              `Auto-recovered: merge deadlock resolved via landed commit ${landedCommit.sha.slice(0, 8)}${clearedDependents.length > 0 ? `; cleared blockedBy on ${clearedDependents.join(", ")}` : ""}`,
            );
            log.log(`self-heal:deadlock-recovered ${JSON.stringify({ stuckTaskId: task.id, blockedTaskIds, attributedSha: landedCommit.sha, action: "reattributed" })}`);
            recovered++;
          } else {
            const proof = await this.evaluateBackwardMoveTripleProof(task, {
              stage: "stuck-merge-deadlock",
              graceMs: DEADLOCK_RECOVERY_COOLDOWN_MS,
              stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
              reason: "stuck-merge-deadlock-candidate",
            });
            if (!proof.ok) {
              await this.emitBackwardMoveNoAction(task, "stuck-merge-deadlock", "task:stuck-merge-deadlock-no-action", proof);
            } else {
              await this.store.updateTask(task.id, { paused: true });
              await this.store.logEntry(task.id, "merge-deadlock-detected: requires manual intervention — verified content not on main");
              log.warn(`self-heal:deadlock-recovered ${JSON.stringify({ stuckTaskId: task.id, blockedTaskIds, attributedSha: null, action: "paused-for-manual" })}`);
              recovered++;
            }
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`self-heal:deadlock-recovery-error ${JSON.stringify({ stuckTaskId: task.id, blockedTaskIds, error: errorMessage })}`);
        } finally {
          this.deadlockRecoveryCooldown.set(task.id, Date.now());
        }
      }

      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Stuck merge deadlock recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  private parseScopeViolationPayload(detail: string): { declaredScope: string[]; stagedFiles: string[] } | null {
    const lines = detail.split("\n");
    const declaredScope: string[] = [];
    const stagedFiles: string[] = [];
    let section: "declared" | "staged" | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === "declaredScope:") {
        section = "declared";
        continue;
      }
      if (line === "stagedFiles:") {
        section = "staged";
        continue;
      }
      if (!line.startsWith("- ")) continue;
      const value = line.slice(2).trim();
      if (!value || value === "<none>") continue;
      if (section === "declared") declaredScope.push(value);
      if (section === "staged") stagedFiles.push(value);
    }

    if (declaredScope.length === 0 && stagedFiles.length === 0) return null;
    return { declaredScope, stagedFiles };
  }

  private parseScopeViolationFromError(errorMessage: string | null | undefined): { declaredScope: string[]; stagedFiles: string[] } | null {
    if (!errorMessage?.startsWith("File-scope invariant violation for ")) {
      return null;
    }
    const stagedMatch = errorMessage.match(/staged files \[(.*?)\] have zero overlap/s);
    const scopeMatch = errorMessage.match(/declared File Scope \[(.*?)\]\./s);
    if (!stagedMatch || !scopeMatch) return null;
    const stagedFiles = stagedMatch[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => Boolean(entry) && entry !== "<none outside .changeset/>");
    const declaredScope = scopeMatch[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return { declaredScope, stagedFiles };
  }

  /**
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverOrphanOnlyScopeViolations(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-23:20 (the query-filter class, ninth sweep):
      `listTasks({ column: "in-review" })` returned EMPTY on a renamed board, so a task failed by an
      ORPHAN-ONLY file-scope violation — commits that belong to no declared scope — was never recovered
      and stayed failed.

      Activation check first: one of the two sweeps still holding both a literal query and an unwired
      `getTaskHardMergeBlocker`, so the guard is wired in the same change.
      */
      const orphanReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const orphanById = new Map<string, Task>();
      for (const column of orphanReviewColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) orphanById.set(task.id, task);
      }
      const tasks = [...orphanById.values()];
      const orphanIrCache = new Map<string, WorkflowIr>();
      const unresolvedOrphanCards: string[] = [];
      const orphanLanesByTask = new Map<string, ReadonlySet<string>>();
      for (const task of tasks) {
        const resolved = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id, orphanIrCache)
          .catch(() => undefined);
        const own = resolved
          ? [...new Set(REVIEW_ROLES.flatMap((role) => columnsWithFlag(resolved.ir, role)))]
          : [];
        if (!resolved || resolved.source === "default") unresolvedOrphanCards.push(task.id);
        /* DELIBERATE-LITERAL — the unresolvable-workflow default, reviewed 2026-07-30-23:20. */
        orphanLanesByTask.set(task.id, own.length > 0 ? new Set(own) : new Set(["in-review"]));
      }
      if (unresolvedOrphanCards.length > 0) {
        log.warn(
          `orphan-only scope recovery: ${unresolvedOrphanCards.length} card(s) measured against the `
          + `built-in review lane because their own workflow could not be resolved `
          + `(${unresolvedOrphanCards.slice(0, 5).join(", ")}); a renamed review lane there stays failed.`,
        );
      }
      const candidates = tasks.filter((task) =>
        (orphanLanesByTask.get(task.id) ?? new Set(["in-review"])).has(task.column) &&
        allowsAutoMergeProcessing(task, settings) &&
        task.status === "failed" &&
        task.scopeOverride !== true &&
        task.mergeDetails?.mergeConfirmed !== true &&
        !executingIds.has(task.id),
      );

      if (candidates.length === 0) return 0;

      let recovered = 0;
      for (const task of candidates) {
        try {
          /*
          FNXC:Workspace 2026-06-22-14:10 (Phase D review A — workspace single-commit-finalize gate):
          `findAlreadyMergedTaskCommit` below runs over `this.options.rootDir` (the NON-git workspace
          root for a workspace task), and a hit would single-commit-finalize the WHOLE workspace task
          done on one phantom/wrong-repo commit (the P0 class). A workspace task lands PER-REPO; its
          recovery is owned by reconcileWorkspacePartialLands. Skip it here.
          */
          if (isWorkspaceTask(task)) continue;
          const recentLogs = "getAgentLogs" in this.store && typeof this.store.getAgentLogs === "function"
            ? await this.store.getAgentLogs(task.id, { limit: 50 })
            : [];
          const scopeViolationLog = recentLogs.find((entry) =>
            entry.type === "tool_error" &&
            entry.detail?.includes("declaredScope:") &&
            entry.detail?.includes("stagedFiles:"),
          );

          const parsed = (scopeViolationLog?.detail ? this.parseScopeViolationPayload(scopeViolationLog.detail) : null)
            ?? this.parseScopeViolationFromError(task.error);
          if (!parsed) continue;

          const { declaredScope, stagedFiles } = parsed;
          if (declaredScope.length === 0) continue;

          const orphanFiles = stagedFiles.filter((file) => !file.startsWith(".changeset/"));
          if (orphanFiles.length === 0) continue;
          const hasDeclaredOverlap = orphanFiles.some((file) => matchesScope(file, declaredScope));
          if (hasDeclaredOverlap) continue;

          const mergeTarget = await this.resolveSelfHealingMergeTarget(task, settings, "recover-orphan-only-scope-violations");
          const baseBranch = mergeTarget.branch;
          const landed = await this.findAlreadyMergedTaskCommit({
            taskId: task.id,
            lineageId: task.lineageId,
            repoDir: this.options.rootDir,
            baseBranch,
            taskBranch: task.branch,
            baseCommitSha: task.baseCommitSha,
          });
          if (!landed) continue;

          const mergeDetails: MergeDetails = {
            commitSha: landed.sha,
            mergedAt: new Date().toISOString(),
            mergeConfirmed: true,
            resolutionStrategy: "orphan-discard-no-op",
            mergeTargetBranch: mergeTarget.branch,
            mergeTargetSource: mergeTarget.source,
          };

          /* Wired: unwired, this would decline every card the widened read now finds. */
          const hardBlocker = getTaskHardMergeBlocker({
            ...task,
            steps: task.steps ?? [],
            workflowStepResults: task.workflowStepResults,
          }, { reviewColumns: orphanLanesByTask.get(task.id) ?? new Set(["in-review"]) });
          if (hardBlocker) {
            await this.store.updateTask(task.id, {
              status: "failed",
              error: `Merge confirmed but finalization blocked: ${hardBlocker}`,
              mergeDetails,
            });
            await this.store.logEntry(
              task.id,
              `Auto-recovery parked task in in-review: merged content found on ${baseBranch} (${landed.sha.slice(0, 8)}) but finalization blocked — ${hardBlocker}`,
            );
            continue;
          }

          const clearedFlags = {
            paused: Boolean(task.paused),
            status: Boolean(task.status),
            error: Boolean(task.error),
          };
          await this.store.updateTask(task.id, {
            paused: false,
            status: null,
            error: null,
            mergeRetries: 0,
            mergeDetails,
          });
          await this.recordSelfHealingBranchGroupMemberLanding(task, mergeTarget, "recover-orphan-only-scope-violations");
          const completeLane = (await resolveTaskLifecycleColumns(this.store, task.id))?.complete ?? "done";
const movedTask = await this.store.moveTask(task.id, completeLane);
          this.emitTaskMerged(movedTask, { mergeConfirmed: true });
          await this.store.logEntry(
            task.id,
            `Auto-finalized from in-review/paused: content proven on ${baseBranch} (${landed.sha.slice(0, 8)}). Cleared soft state paused=${clearedFlags.paused}, status=${clearedFlags.status}, error=${clearedFlags.error}`,
          );
          await this.cleanupWorktreeOnly(task);
          try {
            const auditor = createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "recover-orphan-only-scope-violations",
            });
            await auditor.database({
              type: "task:auto-recover-finalize-already-on-main",
              target: task.id,
              metadata: {
                mergeSha: landed.sha,
                baseBranch,
                mergeStrategy: landed.strategy,
                mergeTargetBranch: mergeTarget.branch,
                mergeTargetSource: mergeTarget.source ?? null,
                clearedFlags,
              },
            });
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`recoverOrphanOnlyScopeViolations: failed to record run-audit event for ${task.id}: ${errorMessage}`);
          }
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`recoverOrphanOnlyScopeViolations: failed for ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} orphan-only scope-violation task(s) → done`);
      }

      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphan-only scope violation recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover retry-exhausted failed review tasks whose content already landed on
   * the integration branch via a non-canonical merge lineage.
   *
   * Candidate filter:
   * - `column === "in-review"`
   * - `status === "failed"`
   * - `(mergeRetries ?? 0) >= MAX_AUTO_MERGE_RETRIES`
   * - `mergeDetails.mergeConfirmed !== true`
   * - not actively executing
   *
   * Detection order (first match wins):
   * 1. Fusion-Task-Id trailer lookup on the base branch
   * 2. Task branch ancestry + task-id grep on first-parent base lineage
   * 3. Patch-id match between task branch diff and recent base-branch commits
   *
   * Idempotency: recovered tasks are moved to `done`, status/error are cleared,
   * and mergeRetries reset to 0, so subsequent sweeps will not match them.
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverAlreadyMergedReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-18:20 (the query-filter class, second sweep):
      THE QUERY WAS THE BUG. `listTasks({ column: "in-review" })` returns EMPTY on a board whose review
      lane is renamed, so this sweep never ran — and it is the one that rescues a card whose merge
      ACTUALLY SUCCEEDED but is parked in review with `status: "failed"`. Unrun, that card stays stuck
      permanently with a merge nobody reconciles.

      Read widened via the project union (a read happens before any task is in hand); the per-card verdict
      below is resolved against THAT CARD's own workflow, because this sweep mutates. Widening the read
      and widening the verdict are different decisions — see `reconcileDoneTaskIntegrity`.
      */
      const reviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const byId = new Map<string, Task>();
      for (const column of reviewColumns) {
        for (const task of await this.store.listTasks({ column, slim: true })) byId.set(task.id, task);
      }
      const reviewIrCache = new Map<string, WorkflowIr>();
      /* Cards whose own workflow could not be resolved — reported below rather than silently dropped. */
      const unresolvedReviewCards: string[] = [];
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-18:50 (#2838 review — greptile P1, same class as the
      done-integrity sweep one commit earlier):
      PROVENANCE, BECAUSE THIS RESOLVER DOES NOT FAIL — IT SUBSTITUTES. `resolveWorkflowIrForTask`
      degrades to the BUILT-IN coding IR rather than throwing, so `own.length > 0` read as "this card
      answered" when nobody had: a renamed-lane card was measured against the built-in `in-review`,
      rejected, and — because this sweep is what would have rescued its already-merged state — rejected
      again on every subsequent pass.

      I wrote this sweep before that fix landed on the done-integrity one and reproduced its pre-fix
      shape verbatim. Same resolution, same reporting, so the two cannot drift.

      The VERDICT stays conservative: this sweep mutates a task's column and status, and guessing a lane
      is worse than leaving one unrescued. What provenance buys is that the unrescued card is REPORTED.
      */
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-20:50 (widening this sweep's query ACTIVATED a guard below):
      Returns the card's OWN review lanes rather than a boolean, so ONE resolution feeds BOTH consumers —
      this sweep's lane test and the `getTaskHardMergeBlocker` call in its recovery loop.

      That blocker was unwired and UNREACHABLE while this sweep's query was a literal. Widening the read
      made it reachable: the sweep now finds renamed-board cards, and unwired it would decline every one,
      so the conversion would have looked complete and delivered nothing. Found by scanning this file for
      sweeps holding BOTH a literal query and an unwired lane guard — six of them, this one included.
      */
      const ownReviewLanesForAlreadyMerged = async (task: Task): Promise<ReadonlySet<string>> => {
        const resolved = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id, reviewIrCache)
          .catch(() => undefined);
        const own = resolved
          ? [...new Set(REVIEW_ROLES.flatMap((role) => columnsWithFlag(resolved.ir, role)))]
          : [];
        /* A THROW is unresolvable too — the rarer path where the resolver raises rather than substitutes. */
        if (!resolved || resolved.source === "default") unresolvedReviewCards.push(task.id);
        /* DELIBERATE-LITERAL — the unresolvable-workflow default, reviewed 2026-07-30-18:50. */
        return own.length > 0 ? new Set(own) : new Set(["in-review"]);
      };
      const inOwnReviewLane = async (task: Task): Promise<boolean> =>
        (await ownReviewLanesForAlreadyMerged(task)).has(task.column);
      const shortlist = [...byId.values()].filter((task) =>
        !task.deletedAt &&
        allowsAutoMergeProcessing(task, settings) &&
        task.status === "failed" &&
        (task.mergeRetries ?? 0) >= maxAutoMergeRetries &&
        task.mergeDetails?.mergeConfirmed !== true &&
        !executingIds.has(task.id),
      );

      /* The per-card lane verdict is async, so it cannot live in the filter above. */
      const candidates: Task[] = [];
      for (const task of shortlist) {
        if (await inOwnReviewLane(task)) candidates.push(task);
      }
      if (unresolvedReviewCards.length > 0) {
        log.warn(
          `already-merged review rescue: ${unresolvedReviewCards.length} card(s) measured against the `
          + `built-in review lane because their own workflow could not be resolved `
          + `(${unresolvedReviewCards.slice(0, 5).join(", ")}); a renamed review lane there stays unrescued.`,
        );
      }

      if (candidates.length === 0) return 0;

      let recovered = 0;
      for (const task of candidates) {
        try {
          /*
          FNXC:Workspace 2026-06-22-14:10 (Phase D review A — workspace single-commit-finalize gate):
          `findAlreadyMergedTaskCommit` runs over `this.options.rootDir` (NON-git for a workspace
          task) and a hit would single-commit-finalize the whole workspace task done on one
          phantom/wrong-repo commit (the P0 class). Workspace tasks land PER-REPO and are recovered
          by reconcileWorkspacePartialLands; skip them here.
          */
          if (isWorkspaceTask(task)) continue;
          const mergeTarget = await this.resolveSelfHealingMergeTarget(task, settings, "recover-already-merged-review");
          const baseBranch = mergeTarget.branch;
          if (!baseBranch) continue;
          if (task.branch) {
            const foreignTip = await this.branchTipForeignOwnership({ taskId: task.id, lineageId: task.lineageId, branch: task.branch, baseBranch }).catch(() => null);
            if (foreignTip) {
              await this.rejectForeignAlreadyMergedCandidate({
                task,
                candidateSha: foreignTip.sha,
                candidateOwner: foreignTip.owner,
                taskBranch: task.branch,
                baseBranch,
                reason: foreignTip.reason,
                phase: "recover-already-merged-review",
              });
              continue;
            }
          }

          let landed = await this.findAlreadyMergedTaskCommit({
            taskId: task.id,
            lineageId: task.lineageId,
            repoDir: this.options.rootDir,
            baseBranch,
            taskBranch: task.branch,
            baseCommitSha: task.baseCommitSha,
          });
          if (!landed && getPrimaryPrInfo(task)) {
            // Fetch-then-prove: the LOCAL base ref can be stale. When a PR merged
            // on the remote (human / merge-train squash) but this process never
            // fetched, the owned commit is absent from the local base branch, so
            // the detector finds nothing and the failed card holds its file-scope
            // lease forever. Best-effort refresh the remote-tracking base ref and
            // re-run the SAME evidence detector against it. The owned-commit proof
            // (and every foreign-ownership guard inside the detector) still gates
            // the heal, so this only un-wedges a genuinely-merged task — it never
            // phantom-finalizes on unproven state. Gated on a recorded PR: no PR
            // ⇒ nothing could have merged remotely ⇒ no fetch.
            const refreshedBaseRef = await this.refreshRemoteBaseRef(baseBranch);
            if (refreshedBaseRef) {
              landed = await this.findAlreadyMergedTaskCommit({
                taskId: task.id,
                lineageId: task.lineageId,
                repoDir: this.options.rootDir,
                baseBranch: refreshedBaseRef,
                taskBranch: task.branch,
                baseCommitSha: task.baseCommitSha,
              });
            }
          }
          if (!landed) continue;

          const mergeDetails: MergeDetails = {
            commitSha: landed.sha,
            mergedAt: new Date().toISOString(),
            mergeConfirmed: true,
            prNumber: getPrimaryPrInfo(task)?.number,
            mergeTargetBranch: mergeTarget.branch,
            mergeTargetSource: mergeTarget.source,
          };

          /* Wired with THIS card's review lanes — see the note on `ownReviewLanesForAlreadyMerged` above. */
          const hardBlocker = getTaskHardMergeBlocker({
            ...task,
            steps: task.steps ?? [],
            workflowStepResults: task.workflowStepResults,
          }, { reviewColumns: await ownReviewLanesForAlreadyMerged(task) });
          if (hardBlocker) {
            await this.store.updateTask(task.id, {
              status: "failed",
              error: `Merge confirmed but finalization blocked: ${hardBlocker}`,
              mergeDetails,
            });
            await this.store.logEntry(
              task.id,
              `Auto-recovery parked task in in-review: merged content found on ${baseBranch} (${landed.sha.slice(0, 8)}) but finalization blocked — ${hardBlocker}`,
            );
            continue;
          }

          const clearedFlags = {
            paused: Boolean(task.paused),
            status: Boolean(task.status),
            error: Boolean(task.error),
          };
          await this.store.updateTask(task.id, {
            paused: false,
            status: null,
            error: null,
            mergeRetries: 0,
            mergeDetails,
          });
          const worktreeHint = task.worktree;
          await this.recordSelfHealingBranchGroupMemberLanding(task, mergeTarget, "recover-already-merged-review");
          const completeLane = (await resolveTaskLifecycleColumns(this.store, task.id))?.complete ?? "done";
const movedTask = await this.store.moveTask(task.id, completeLane);
          this.emitTaskMerged(movedTask, { mergeConfirmed: true });
          await this.store.logEntry(
            task.id,
            `Auto-finalized from in-review/paused: content proven on ${baseBranch} (${landed.sha.slice(0, 8)}). Cleared soft state paused=${clearedFlags.paused}, status=${clearedFlags.status}, error=${clearedFlags.error}`,
          );
          await this.reconcileCompletedTask(task.id, { worktreeHint });
          try {
            const auditor = createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "recover-already-merged-review",
            });
            await auditor.database({
              type: "task:auto-recover-finalize-already-on-main",
              target: task.id,
              metadata: {
                mergeSha: landed.sha,
                mergeStrategy: landed.strategy,
                baseBranch,
                mergeTargetBranch: mergeTarget.branch,
                mergeTargetSource: mergeTarget.source ?? null,
                mergeRetries: task.mergeRetries ?? 0,
                clearedFlags,
              },
            });
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`recoverAlreadyMergedReviewTasks: failed to record run-audit event for ${task.id}: ${errorMessage}`);
          }
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`recoverAlreadyMergedReviewTasks: failed for ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} already-merged retry-exhausted review task(s) → done`);
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Already-merged review recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  private getPostDoneNonContinuableEvidence(task: Task): string | null {
    const candidates: string[] = [];
    if (typeof task.error === "string" && task.error.trim()) {
      candidates.push(task.error);
    }
    for (const entry of [...(task.log ?? [])].reverse()) {
      if (typeof entry.outcome === "string" && entry.outcome.trim()) {
        candidates.push(entry.outcome);
      }
      if (typeof entry.action === "string" && entry.action.trim()) {
        candidates.push(entry.action);
      }
    }
    return candidates.find((value) => isNonContinuableSessionError(value)) ?? null;
  }

  /**
   * Recover completed in-review tasks wedged as failed only because a post-done
   * session continuation hit a non-continuable signature.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverPostDoneNonContinuableWedge(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-23:55 (the query-filter class, tenth sweep):
      Read the review lanes this PROJECT declares rather than the literal `in-review`, then decide each
      card against ITS OWN workflow below. A card wedged `failed` after a post-done continuation error on
      a renamed board was never listed at all, so it stayed failed with every step done.
      */
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (#2869 review — greptile, "traitless review lanes
      remain invisible"): CONFIRMED, DEFERRED, SAME CLASS AS #2876.

      A board that renames its review lane but declares NO lifecycle traits contributes nothing to this
      union, so the card is not in `wedgeById` and the per-card fallback below — including its
      `new Set(["in-review"])` degraded answer — never runs for it. The fallback cannot rescue a card
      the query never returned.

      The three-state rule at PROJECT scope. Not fixed here because the safe direction differs by
      caller: over-inclusion is free for a sweep (the per-card check discards it) and inflates an
      operator-facing number in the analytics aggregators, so it needs an opt-in
      (`{ untraitedProject: "declared-columns" }`) on the shared helper rather than a change to what it
      returns by default.

      Fixture note: hand-authored V2 without traits, NOT a v1 upgrade — `synthesizeDefaultColumns`
      emits the default ids, so a v1-shaped fixture cannot express a renamed lane and would pass
      vacuously.
      */
      const wedgeReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const wedgeById = new Map<string, Task>();
      for (const column of wedgeReviewColumns) {
        for (const task of await this.store.listTasks({ column, slim: false })) wedgeById.set(task.id, task);
      }
      const tasks = [...wedgeById.values()];
      /* Per-card review lanes; also fed to the hard-blocker below so it judges the card's own vocabulary. */
      const wedgeLanesByTask = new Map<string, Set<string>>();
      const unresolvedWedgeCards: string[] = [];
      for (const task of tasks) {
        const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id);
        if (source === "default") unresolvedWedgeCards.push(task.id);
        const own = REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)]);
        wedgeLanesByTask.set(task.id, own.length > 0 ? new Set(own) : new Set(["in-review"]));
      }
      if (unresolvedWedgeCards.length > 0) {
        log.warn(
          `post-done non-continuable wedge recovery: ${unresolvedWedgeCards.length} card(s) fell back to the built-in workflow (${unresolvedWedgeCards.slice(0, 5).join(", ")})`,
        );
      }
      let recovered = 0;

      for (const task of tasks) {
        const wedgeLanes = wedgeLanesByTask.get(task.id) ?? new Set(["in-review"]);
        if (!wedgeLanes.has(task.column) || task.deletedAt) continue;
        if (!allowsAutoMergeProcessing(task, settings)) continue;
        if (task.paused || task.userPaused) continue;
        if (task.status !== "failed") continue;
        if (this.options.isTaskActive?.(task.id)) continue;
        if (!(task.steps ?? []).every((step) => step.status === "done" || step.status === "skipped")) continue;
        const doneMarker = [...(task.log ?? [])].reverse().find((entry) => entry.action === "Task marked done by agent");
        if (!doneMarker) continue;
        /* Wired in the SAME change as the read: widening the query without this makes the sweep find renamed-board cards and decline every one. */
        if (getTaskHardMergeBlocker({ ...task, status: undefined, error: undefined, steps: task.steps ?? [], workflowStepResults: task.workflowStepResults }, { reviewColumns: wedgeLanes })) continue;

        const evidence = this.getPostDoneNonContinuableEvidence(task);
        if (!evidence) continue;

        const currentCount = task.completionHandoffLimboRecoveryCount ?? 0;
        const audit = createRunAuditor(this.store, {
          runId: generateSyntheticRunId("self-heal-post-done-noncontinuable", task.id),
          agentId: "self-healing",
          taskId: task.id,
          taskLineageId: task.lineageId,
          phase: "recover-post-done-noncontinuable-wedge",
        });

        if (currentCount >= MAX_POST_DONE_NONCONTINUABLE_WEDGE_RECOVERIES) {
          await audit.database({
            type: "task:auto-recover-post-done-noncontinuable-wedge-exhausted",
            target: task.id,
            metadata: { attempts: currentCount, errorSnippet: evidence.slice(0, 200) },
          });
          continue;
        }

        await this.store.updateTask(task.id, {
          completionHandoffLimboRecoveryCount: currentCount + 1,
          status: null,
          error: null,
        });
        await this.store.logEntry(
          task.id,
          "Auto-recovered completed-task non-continuable wedge — cleared failed status after post-done session continuation error",
          evidence,
        );
        await audit.database({
          type: "task:auto-recover-post-done-noncontinuable-wedge",
          target: task.id,
          metadata: {
            attempts: currentCount + 1,
            source: "self-healing-in-review-sweep",
            errorSnippet: evidence.slice(0, 200),
          },
        });
        recovered += 1;
      }

      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Post-done non-continuable wedge recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  private getApprovedAiMergeReviewShas(task: Task): Set<string> {
    const shas = new Set<string>();
    for (const entry of task.log ?? []) {
      if (typeof entry.action !== "string") continue;
      const match = entry.action.match(/AI merge review \(pass \d+\): approved(?:\s+(?:squash|commit)\s+([0-9a-f]{7,40}))?/i);
      if (match?.[1]) shas.add(match[1].toLowerCase());
    }
    return shas;
  }

  private hasApprovedAiMergeReview(task: Task): boolean {
    return (task.log ?? []).some((entry) =>
      typeof entry.action === "string"
      && /AI merge review \(pass \d+\): approved/.test(entry.action)
    );
  }

  private matchesApprovedAiMergeSha(squashSha: string, approvedShas: Set<string>): boolean {
    if (approvedShas.size === 0) return true;
    const normalized = squashSha.toLowerCase();
    return Array.from(approvedShas).some((approved) => normalized === approved || normalized.startsWith(approved) || approved.startsWith(normalized));
  }

  private async listAiMergeWorktreeCandidates(taskId: string, settings: Settings): Promise<string[]> {
    const roots = Array.from(new Set([
      resolveRepoLocalAiMergeRoot(this.options.rootDir, settings),
      resolveLegacyAiMergeRootPath(this.options.rootDir),
      tmpdir(),
    ]));
    const testWorkerRoot = process.env.FUSION_TEST_WORKER_ROOT;
    if (testWorkerRoot) {
      try {
        for (const entry of readdirSync(testWorkerRoot)) {
          if (entry.startsWith("redir-")) roots.push(join(testWorkerRoot, entry));
        }
      } catch {
        // Best effort for the test harness' bounded temp-dir redirection root.
      }
    }
    const prefix = `fusion-ai-merge-${taskId.toLowerCase()}-`;
    const paths: string[] = [];
    for (const root of roots) {
      let entries: string[];
      try {
        entries = readdirSync(root).filter((entry) => entry.startsWith(prefix));
      } catch {
        continue;
      }
      for (const entry of entries) paths.push(join(root, entry));
    }
    return paths;
  }

  private async recoverApprovedStrandedAiMergeCommit(task: Task, settings: Settings): Promise<boolean> {
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-22:30 (self-healing cluster): an approved-but-stranded AI merge commit is recovered from the review lane. Keyed on the literal this sweep answered "no" for every card on a renamed board. */
    const strandedReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
    if (!strandedReviewColumns.has(task.column)) return false;
    if (task.mergeDetails?.mergeConfirmed === true) return false;
    if (!this.hasApprovedAiMergeReview(task)) return false;
    if (!(task.steps ?? []).every((step) => step.status === "done" || step.status === "skipped")) return false;

    const integrationBranch = await resolveIntegrationBranch(this.options.rootDir, settings).catch(() => "");
    if (!integrationBranch) return false;
    const candidates = await this.listAiMergeWorktreeCandidates(task.id, settings);
    if (candidates.length === 0) return false;

    const auditor = createRunAuditor(this.store, {
      runId: generateSyntheticRunId("self-heal-stranded-ai-merge", task.id),
      agentId: "self-healing",
      taskId: task.id,
      taskLineageId: task.lineageId,
      phase: "recover-stranded-ai-merge-commit",
    });

    const approvedShas = this.getApprovedAiMergeReviewShas(task);
    const refName = `refs/heads/${integrationBranch}`;
    const recoverableCandidates: Array<{
      canonicalCandidate: string;
      strandedSha: string;
      tipSha: string;
      alreadyAncestor: boolean;
      landedFiles: string[];
    }> = [];

    for (const candidate of candidates) {
      let canonicalCandidate = candidate;
      try { canonicalCandidate = realpathSync(candidate); } catch { /* keep original */ }
      if (activeSessionRegistry.isPathActive(candidate) || activeSessionRegistry.isPathActive(canonicalCandidate)) continue;

      try {
        const { stdout: headStdout } = await execAsync("git rev-parse --verify HEAD", { cwd: canonicalCandidate, timeout: 30_000 });
        const strandedSha = headStdout.trim();
        if (!strandedSha || !this.matchesApprovedAiMergeSha(strandedSha, approvedShas)) continue;

        const { stdout: showStdout } = await execAsync(`git show -s --format=%s%x1f%b ${shellQuote(strandedSha)}`, {
          cwd: canonicalCandidate,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        const [subject = "", body = ""] = showStdout.split("\x1f");
        const ownership = getCommitTaskOwnership(task.id, task.lineageId, subject, body);
        if (!ownership.owned) continue;

        const { stdout: tipStdout } = await execAsync(`git rev-parse --verify ${shellQuote(refName)}`, {
          cwd: this.options.rootDir,
          timeout: 30_000,
        });
        const tipSha = tipStdout.trim();
        if (!tipSha) continue;

        const alreadyAncestor = await execAsync(`git merge-base --is-ancestor ${shellQuote(strandedSha)} ${shellQuote(refName)}`, {
          cwd: this.options.rootDir,
          timeout: 30_000,
        }).then(() => true, () => false);
        const tipIsAncestor = await execAsync(`git merge-base --is-ancestor ${shellQuote(tipSha)} ${shellQuote(strandedSha)}`, {
          cwd: this.options.rootDir,
          timeout: 30_000,
        }).then(() => true, () => false);
        if (!alreadyAncestor && !tipIsAncestor) continue;

        const landedFiles = await execAsync(`git diff-tree --no-commit-id --name-only -r ${shellQuote(strandedSha)}`, {
          cwd: canonicalCandidate,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        }).then(({ stdout }) => stdout.split("\n").map((line) => line.trim()).filter(Boolean), () => []);
        recoverableCandidates.push({ canonicalCandidate, strandedSha, tipSha, alreadyAncestor, landedFiles });
      } catch (err: unknown) {
        log.warn(`recoverApprovedStrandedAiMergeCommit: ${task.id} candidate ${candidate} skipped: ${getErrorMessage(err)}`);
      }
    }

    /*
    FNXC:AIMergeRecovery 2026-07-10-23:06:
    Self-healing finalization must recover the exact reviewed clean-room commit. When historical approval logs do not include a SHA, only a single eligible same-task candidate is safe; multiple candidates are left for normal merge/review instead of guessing by filesystem order.
    */
    if (recoverableCandidates.length !== 1) {
      if (recoverableCandidates.length > 1) {
        await this.store.logEntry(task.id, `Skipped stranded AI merge recovery: ${recoverableCandidates.length} approved clean-room candidates were ambiguous`).catch(() => undefined);
      }
      return false;
    }

    const selected = recoverableCandidates[0];
    if (!selected) return false;
    if (!selected.alreadyAncestor) {
      const currentBranch = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: this.options.rootDir, timeout: 30_000 })
        .then(({ stdout }) => stdout.trim(), () => "");
      if (currentBranch === integrationBranch) {
        const head = await execAsync("git rev-parse HEAD", { cwd: this.options.rootDir, timeout: 30_000 })
          .then(({ stdout }) => stdout.trim(), () => "");
        const dirty = await execAsync("git status --porcelain", { cwd: this.options.rootDir, timeout: 30_000 })
          .then(({ stdout }) => stdout.trim().length > 0, () => true);
        if (head !== selected.tipSha || dirty) return false;
        await execAsync(`git merge --ff-only ${shellQuote(selected.strandedSha)}`, { cwd: this.options.rootDir, timeout: 120_000 });
      } else {
        const advanced = await advanceIntegrationBranchRef({
          rootDir: this.options.rootDir,
          projectRootDir: this.options.rootDir,
          integrationBranch,
          newSha: selected.strandedSha,
          expectedCurrentSha: selected.tipSha,
          taskId: task.id,
          audit: auditor,
        });
        if (!advanced.advanced) return false;
      }
    }

    const result: MergeResult = {
      task,
      branch: task.branch ?? resolveTaskWorkingBranch(task),
      merged: true,
      noOp: false,
      ok: true,
      commitSha: selected.strandedSha,
      landedFiles: selected.landedFiles,
      mergeConfirmed: true,
      worktreeRemoved: false,
      branchDeleted: false,
    };
    const finalized = await finalizeProvenAutoMergeTask({
      store: this.store,
      taskId: task.id,
      result,
      audit: auditor,
      auditAgentId: "self-healing",
      auditPhase: "recover-stranded-ai-merge-commit",
      source: "self-healing",
      log: async (message) => {
        await this.store.logEntry(task.id, message).catch(() => undefined);
      },
    });
    if (finalized.outcome === "done" || finalized.outcome === "already-done") {
      await this.store.logEntry(
        task.id,
        `Auto-recovered stranded AI merge clean-room commit ${selected.strandedSha.slice(0, 8)} — advanced ${integrationBranch} and finalized task`,
      );
      await auditor.git({
        type: "merge:ai-landed",
        target: integrationBranch,
        metadata: { taskId: task.id, landedSha: selected.strandedSha, source: "self-healing-stranded-clean-room", path: selected.canonicalCandidate },
      });
      return true;
    }
    return false;
  }

  /**
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverCompletionHandoffLimbo(): Promise<void> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return;
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-22:40 (the query-filter class, eighth sweep):
    `listTasks({ column: "in-review" })` returned EMPTY on a renamed board, so a task stranded in
    completion-handoff limbo — falsely marked exhausted while the merge queue already owns it — was never
    cleared and stayed wedged.

    Activation check first: this is one of the three remaining sweeps holding both a literal query and an
    unwired `getTaskMergeBlocker`, so the guard is wired in the same change. This loop is already async,
    so the per-card resolution happens inline rather than needing a precomputed map.
    */
    const limboReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
    const limboById = new Map<string, Task>();
    for (const column of limboReviewColumns) {
      for (const task of await this.store.listTasks({ column, slim: false })) limboById.set(task.id, task);
    }
    const tasks = [...limboById.values()];
    const limboIrCache = new Map<string, WorkflowIr>();
    const unresolvedLimboCards: string[] = [];
    const ownLimboReviewLanes = async (task: Task): Promise<ReadonlySet<string>> => {
      const resolved = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id, limboIrCache)
        .catch(() => undefined);
      const own = resolved
        ? [...new Set(REVIEW_ROLES.flatMap((role) => columnsWithFlag(resolved.ir, role)))]
        : [];
      if (!resolved || resolved.source === "default") unresolvedLimboCards.push(task.id);
      /* DELIBERATE-LITERAL — the unresolvable-workflow default, reviewed 2026-07-30-22:40. */
      return own.length > 0 ? new Set(own) : new Set(["in-review"]);
    };
    const now = Date.now();

    for (const task of tasks) {
      if (task.paused) continue;
      const limboReviewLanes = await ownLimboReviewLanes(task);
      if (!limboReviewLanes.has(task.column)) continue;
      if (!allowsAutoMergeProcessing(task, settings)) continue;
      if (await this.isFalseCompletionHandoffExhaustionWhileMergeOwned(task)) {
        await this.store.updateTask(task.id, {
          status: null,
          error: null,
          completionHandoffLimboRecoveryCount: 0,
        });
        await this.store.logEntry(
          task.id,
          "Auto-recovered: cleared false completion-handoff exhaustion while task is already owned by merge queue",
        );
        continue;
      }
      if (task.status != null || task.mergeDetails != null || task.review != null || task.reviewState != null) continue;
      if (this.options.isTaskActive?.(task.id)) continue;
      if (await this.isMergeLaneOwned(task.id)) continue;
      /* Wired: unwired, this would skip every card the widened read now finds. */
      if (getTaskMergeBlocker(task, { reviewColumns: limboReviewLanes }) !== undefined) continue;

      const doneMarker = [...(task.log ?? [])].reverse().find((entry) => entry.action === "Task marked done by agent");
      if (!doneMarker?.timestamp) continue;
      const markerTs = Date.parse(doneMarker.timestamp);
      if (!Number.isFinite(markerTs)) continue;
      const ageMs = now - markerTs;
      if (ageMs < COMPLETION_HANDOFF_LIMBO_GRACE_MS) continue;

      const currentCount = task.completionHandoffLimboRecoveryCount ?? 0;
      if (await this.recoverApprovedStrandedAiMergeCommit(task, settings)) {
        continue;
      }
      if (currentCount >= MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES) {
        await this.store.updateTask(task.id, {
          status: "failed",
          error: "Completion handoff limbo recovery exhausted",
        });
        const exhaustedAudit = createRunAuditor(this.store, {
          runId: generateSyntheticRunId("self-heal", task.id),
          agentId: "self-healing",
          taskId: task.id,
          taskLineageId: task.lineageId,
          phase: "recover-completion-handoff-limbo",
        });
        await exhaustedAudit.database({
          type: "task:auto-recover-completion-handoff-limbo-exhausted",
          target: task.id,
          metadata: { ageMs, attempts: currentCount },
        });
        continue;
      }

      const requeueForAutoMerge = this.options.requeueForAutoMerge ?? this.options.enqueueMerge;
      if (!requeueForAutoMerge) {
        log.warn(`recoverCompletionHandoffLimbo: requeueForAutoMerge callback missing for ${task.id}`);
        continue;
      }

      try {
        // FN-5353: strict targetTaskId leasing in reuse handoff requires an
        // explicit queue row before re-emitting auto-merge.
        await this.store.enqueueMergeQueue(task.id);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`recoverCompletionHandoffLimbo: enqueue failed for ${task.id}: ${errorMessage}`);
        continue;
      }

      const accepted = await requeueForAutoMerge(task.id);
      if (accepted !== true) {
        log.debug(
          `recoverCompletionHandoffLimbo: skipped recovery count for ${task.id} because merge requeue was not accepted`,
        );
        continue;
      }

      await this.store.updateTask(task.id, {
        completionHandoffLimboRecoveryCount: currentCount + 1,
      });

      const audit = createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal", task.id),
        agentId: "self-healing",
        taskId: task.id,
        taskLineageId: task.lineageId,
        phase: "recover-completion-handoff-limbo",
      });
      await audit.database({
        type: "task:auto-recover-completion-handoff-limbo",
        target: task.id,
        metadata: { ageMs, source: "self-healing-in-review-sweep", attempts: currentCount + 1 },
      });

      await this.store.logEntry(task.id, "Auto-recovered (FN-4999): task in 'in-review' past handoff grace with no merge fan-out — re-emitting auto-merge handoff");
    }
  }


  async recoverBranchMisboundInReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-sixth sweep):
      A review card whose BRANCH TIP is bound to a different task's work. The literal read meant that on
      a renamed board the misbinding was never detected, so the card would merge — or refuse to — against
      a branch that is not its own.

      The per-card verdict below converts with it. No second pair; verified with the derived ratchet from
      #2879 rather than by eye.
      */
      const misboundColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const misboundById = new Map<string, Task>();
      for (const column of misboundColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) misboundById.set(entry.id, entry);
      }
      const tasks = [...misboundById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const misboundLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          misboundLanes.set(
            entry.id,
            source === "default"
              ? new Set(misboundColumns)
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          misboundLanes.set(entry.id, new Set(misboundColumns));
        }
      }
      const candidates = tasks.filter((task) =>
        (misboundLanes.get(task.id) ?? misboundColumns).has(task.column) &&
        Boolean(task.branch) &&
        task.mergeDetails?.mergeConfirmed !== true &&
        !executingIds.has(task.id),
      );

      let recovered = 0;
      for (const task of candidates) {
        try {
          /*
          FNXC:Workspace 2026-06-22-14:10 (Phase D review A — workspace single-commit-finalize gate):
          A workspace task carries a `task.branch` (`fusion/<id>`) even though it lands PER-REPO, so
          the `Boolean(task.branch)` candidate filter does NOT exclude it. `isBranchTipMisboundToTask`
          + `findAlreadyMergedTaskCommit` run over `this.options.rootDir` (NON-git for a workspace
          task); a hit would single-commit-finalize the whole task done on one wrong-repo/phantom
          commit (the P0 class). Today the rootDir git calls merely error-by-accident; gate it
          explicitly. Workspace recovery is owned by reconcileWorkspacePartialLands.
          */
          if (isWorkspaceTask(task)) continue;
          const branch = task.branch;
          if (!branch) continue;
          const mergeTarget = await this.resolveSelfHealingMergeTarget(task, settings, "recover-branch-misbound-in-review");
          const baseBranch = mergeTarget.branch;
          const check = await this.isBranchTipMisboundToTask({
            branch,
            taskId: task.id,
            lineageId: task.lineageId,
            baseBranch,
          });
          if (check.rejection) {
            await this.rejectForeignAlreadyMergedCandidate({
              task,
              candidateSha: check.branchTip,
              candidateOwner: check.rejection.owner,
              taskBranch: branch,
              baseBranch,
              reason: check.rejection.reason,
              phase: "recover-branch-misbound-in-review",
            });
            continue;
          }
          if (!check.misbound || !check.landed) continue;

          const mergeDetails: MergeDetails = {
            commitSha: check.landed.sha,
            mergedAt: new Date().toISOString(),
            mergeConfirmed: true,
            prNumber: getPrimaryPrInfo(task)?.number,
            mergeTargetBranch: mergeTarget.branch,
            mergeTargetSource: mergeTarget.source,
          };

          await this.store.updateTask(task.id, {
            mergeDetails,
            branch: null,
            worktree: null,
            status: null,
            error: null,
          });

          if (task.worktree && existsSync(task.worktree)) {
            await removeWorktree({
              rootDir: this.options.rootDir,
              worktreePath: task.worktree,
              settings,
              taskId: task.id,
              reason: RemovalReason.SelfHealingReclaim,
            }).catch(() => undefined);
          }

          await this.clearCompletionBranchIfSubsumed(task, branch).catch(() => false);

          // FN-5092 hotfix: clear transient merger-queue status (`status: "merging"` set
          // by the original merger attempt) before transitioning to done. Without this,
          // a stale `mergeActive` slot for this task leaks indefinitely and blocks the
          // entire merger queue until engine restart. Mirrors the pattern in
          // merger.ts completeTask() and project-engine.ts auto-merge already-confirmed path.
          await this.store.updateTask(task.id, { status: null, error: null, paused: false });
          await this.recordSelfHealingBranchGroupMemberLanding(task, mergeTarget, "recover-branch-misbound-in-review");
          const completeLane = (await resolveTaskLifecycleColumns(this.store, task.id))?.complete ?? "done";
const movedTask = await this.store.moveTask(task.id, completeLane);
          this.emitTaskMerged(movedTask, { mergeConfirmed: true });
          await this.store.logEntry(
            task.id,
            `Auto-recovered: branch tip misbound but content found on ${baseBranch} at ${check.landed.sha.slice(0, 8)} via ${check.landed.strategy}`,
          );
          await this.reconcileCompletedTask(task.id, { worktreeHint: task.worktree ?? undefined });

          try {
            const auditor = createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "recover-branch-misbound-in-review",
            });
            await auditor.database({
              type: "task:auto-recover-branch-misbound",
              target: task.id,
              metadata: {
                branch,
                branchTip: check.branchTip,
                mergeSha: check.landed.sha,
                mergeStrategy: check.landed.strategy,
                lineageId: task.lineageId,
                baseBranch,
                mergeTargetBranch: mergeTarget.branch,
                mergeTargetSource: mergeTarget.source ?? null,
              },
            });
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`recoverBranchMisboundInReviewTasks: failed to record run-audit event for ${task.id}: ${errorMessage}`);
          }
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`recoverBranchMisboundInReviewTasks: failed for task ${task.id}: ${errorMessage}`);
        }
      }

      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Branch-misbound in-review recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverForeignOnlyContaminatedInReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, fourteenth sweep):
      Two literal reads, and two per-card `task.column === …` checks inside the filters below. Those
      checks were redundant while the query pinned the column; under a resolved read they become the
      per-card verdict, so they convert in the same change rather than being deleted.

      On a renamed board both reads returned empty, so a branch carrying ONLY foreign commits was never
      classified and the task stayed parked on a contamination pause that nothing else clears.
      */
      const contaminationReviewColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const contaminationWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const readContaminationBucket = async (columns: ReadonlySet<string>): Promise<Task[]> => {
        const byId = new Map<string, Task>();
        for (const column of columns) {
          for (const entry of await this.store.listTasks({ column, slim: true })) byId.set(entry.id, entry);
        }
        return [...byId.values()];
      };
      const inReview = await readContaminationBucket(contaminationReviewColumns);
      const inProgress = await readContaminationBucket(contaminationWipColumns);
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-20:15 (#2891 review, second round — greptile P1,
      "fallback crosses workflow boundaries"): A CARD WHOSE BOARD CANNOT BE READ IS SKIPPED, NOT GUESSED.

      Two wrong answers were tried before this one, and both are worth recording because each looked
      correct in isolation:

        1. LEGACY IDS ONLY (original). Guarantees rejection for exactly the renamed cards the
           project-scoped query was widened to find — the sweep admits a card and then disowns it.
        2. THE PROJECT UNION (my first fix). Removes that, and crosses workflow boundaries: a column
           that carries a recovery role only in ANOTHER workflow starts admitting this card. This is an
           ACTION site — the verdicts below clear a contamination pause — and rule 3 of
           `project-union-versus-per-task-lanes.md` says over-inclusion is free for a read and costly
           for an action. I widened on an action site, which my own note says not to do.

      The honest third answer: without the card's board we cannot say whether its column carries the
      role, so we do not decide — EXCEPT where the card sits on a legacy id, which is deliberate and
      worth stating because it looks like an inconsistency (#2891 review, third round).

      A card in literal `in-review`/`in-progress` still passes, because the legacy seed above is not a
      guess: it is the documented degraded vocabulary, the same three-state answer used everywhere in
      this program when a board cannot be read. Skipping those would REGRESS every unconverted and
      legacy-id project — cards this sweep has always recovered would stop being recovered — to gain
      consistency with a case that only arises on renamed boards. The renamed card is the one we
      genuinely cannot classify, and it is the one that is skipped and reported. The card keeps the legacy ids seeded above — which is what it had
      before any of this — and is REPORTED, so a card the sweep cannot classify is visible instead of
      silently mis-decided in either direction. Same shape as the done-integrity sweep's unresolvable
      report: the fix for "cannot answer" is to say so, not to pick a side.
      */
      const contaminationLanes = new Map<string, { review: Set<string>; wip: Set<string> }>();
      const unresolvedContaminationCards: string[] = [];
      for (const task of [...inReview, ...inProgress]) {
        if (contaminationLanes.has(task.id)) continue;
        const lanes = {
          review: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.mergeOrchestration ?? []),
          wip: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.countsTowardWip ?? []),
        };
        /*
        FNXC:WorkflowResolvedColumns 2026-07-30-19:40 (#2891 review — greptile P1, "fallback workflow
        rejects renamed lanes"): NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT.

        `resolveWorkflowIrForTask` does not fail — it SUBSTITUTES the built-in IR. So a card whose
        selection is missing or unreadable came back with `in-review`/`in-progress`, and the per-card
        verdicts below then REJECTED the very card the project-scoped query had just admitted from a
        renamed lane. The sweep found it and immediately disowned it.

        Provenance separates "this card's board says X" from "nobody could say, here is the default".
        Only the first is a per-card answer. When it is a substitution the card falls back to the
        PROJECT sets that admitted it — which is broader than its own board but is exactly the
        vocabulary this sweep already trusted to select it, and over-inclusion here costs at most a
        contamination check on a card that did not need one.

        The alternative — legacy ids only, as before — is the one shape that cannot be right: it
        guarantees rejection for precisely the renamed cards the query was widened to find.
        */
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, task.id);
          if (source === "default") unresolvedContaminationCards.push(task.id);
          else {
            for (const role of REVIEW_ROLES) for (const id of columnsWithFlag(ir, role)) lanes.review.add(id);
            for (const id of columnsWithFlag(ir, "countsTowardWip")) lanes.wip.add(id);
          }
        } catch {
          unresolvedContaminationCards.push(task.id);
        }
        contaminationLanes.set(task.id, lanes);
      }
      if (unresolvedContaminationCards.length > 0) {
        log.warn(
          `contamination sweep: ${unresolvedContaminationCards.length} card(s) left unclassified because their `
          + `own workflow could not be resolved (${unresolvedContaminationCards.slice(0, 5).join(", ")}); `
          + "a renamed lane there is neither cleared nor rejected.",
        );
      }
      const contaminationLanesOf = (id: string) => contaminationLanes.get(id) ?? {
        review: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.mergeOrchestration ?? []),
        wip: new Set<string>(LEGACY_COLUMN_IDS_BY_ROLE.countsTowardWip ?? []),
      };
      const contaminationCandidates = [
        ...inReview.filter((task) =>
          contaminationLanesOf(task.id).review.has(task.column) &&
          allowsAutoMergeProcessing(task, settings) &&
          Boolean(task.branch) &&
          Boolean(task.worktree) &&
          task.mergeDetails?.mergeConfirmed !== true &&
          !task.userPaused &&
          !executingIds.has(task.id),
        ),
        // The paused in-progress contamination branch is gated per-task too:
        // pre-existing behavior kept this sweep fully inert in manual-review
        // projects (mirroring the FN-5704 reclaim contract), so override-less
        // tasks stay untouched while explicit autoMerge:true tasks recover.
        ...inProgress.filter((task) =>
          contaminationLanesOf(task.id).wip.has(task.column) &&
          allowsAutoMergeProcessing(task, settings) &&
          task.paused === true &&
          (task.pausedReason === "branch-cross-contamination" || task.pausedReason === "branch-conflict-unrecoverable") &&
          Boolean(task.branch) &&
          Boolean(task.worktree) &&
          !task.userPaused &&
          !executingIds.has(task.id),
        ),
      ];
      /*
      Deduped across the buckets, the hazard reviewed on #2879. The two literal reads were disjoint by
      construction; resolved ones are not, and the two filters here have DIFFERENT predicates, so a column
      carrying both a review role and the wip role could match both and classify the same branch twice.
      Explicit `has` guard rather than `new Map(entries)`, which keeps the LAST value for a repeated key.
      */
      const contaminationById = new Map<string, Task>();
      for (const task of contaminationCandidates) {
        if (!contaminationById.has(task.id)) contaminationById.set(task.id, task);
      }
      const candidates = [...contaminationById.values()];

      let recovered = 0;
      const integrationBranch = await resolveIntegrationBranch(this.options.rootDir, settings);
      for (const task of candidates) {
        if (!task.branch || !task.worktree) continue;
        const baseSha = task.baseCommitSha ?? task.baseBranch ?? task.executionStartBranch ?? integrationBranch;
        try {
          const classification = await classifyForeignOnlyContamination({
            repoDir: this.options.rootDir,
            branchName: task.branch,
            baseSha,
            taskId: task.id,
          });

          if (classification.kind === "ambiguous" || classification.kind === "clean") {
            await createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "recover-foreign-only-contamination-in-review",
            }).database({
              type: "task:auto-recover-foreign-only-contamination-skipped",
              target: task.id,
              metadata: { reason: classification.kind === "clean" ? "clean" : "ambiguous", kind: classification.kind },
            });
            continue;
          }

          const result = await recoverForeignOnlyContamination(task, {
            repoDir: this.options.rootDir,
            taskStore: this.store,
            integrationBranch,
            runAudit: createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "recover-foreign-only-contamination-in-review",
            }),
          });
          if (result.recovered) {
            await this.store.logEntry(task.id, `Auto-recovered foreign-only contamination via ${result.subtype ?? "unknown"}`);
            recovered += 1;
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`recoverForeignOnlyContaminatedInReviewTasks: failed for task ${task.id}: ${errorMessage}`);
        }
      }

      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Foreign-only contamination recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover tasks in `in-review` marked as `failed` where all steps are
   * actually done. This catches the case where an agent completed all work
   * but the session ended without calling `fn_task_done` (e.g., context
   * overflow, compaction losing tool awareness). The executor marks these
   * as failed, but the work is complete — clear the error so the normal
   * review flow can proceed.
   *
   * @returns Number of tasks recovered
   */
  async recoverMisclassifiedFailures(): Promise<number> {
    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-fifth sweep):
      A task the executor parked `failed` for "no fn_task_done" whose steps are ALL actually done — the
      failure is a misclassification, not real. The literal read meant that on a renamed board the error
      was never cleared, so finished work stayed visibly failed and never entered normal review.

      The per-card verdict below converts with it. No second pair: nothing else in this sweep is
      lane-gated (verified with the derived ratchet from #2879, not by eye).
      */
      const misclassifiedColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const misclassifiedById = new Map<string, Task>();
      for (const column of misclassifiedColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) misclassifiedById.set(entry.id, entry);
      }
      const tasks = [...misclassifiedById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const misclassifiedLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          misclassifiedLanes.set(
            entry.id,
            source === "default"
              ? new Set(misclassifiedColumns)
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          misclassifiedLanes.set(entry.id, new Set(misclassifiedColumns));
        }
      }

      const misclassified = tasks.filter((t) =>
        (misclassifiedLanes.get(t.id) ?? misclassifiedColumns).has(t.column) &&
        !t.paused &&
        t.status === "failed" &&
        isNoTaskDoneFailure(t) &&
        t.steps.length > 0 &&
        t.steps.every((s) => s.status === "done" || s.status === "skipped"),
      );

      if (misclassified.length === 0) return 0;

      log.warn(`Found ${misclassified.length} misclassified failure(s) with all steps done`);

      let recovered = 0;
      for (const task of misclassified) {
        try {
          await this.store.updateTask(task.id, {
            status: null,
            error: null,
          });
          await this.store.logEntry(
            task.id,
            "Auto-recovered: all steps complete despite 'no fn_task_done' failure — cleared error for normal review",
          );
          log.log(`Recovered misclassified failure ${task.id}: ${task.title || task.description?.slice(0, 60) || "(untitled)"}`);
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover misclassified failure ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} misclassified failure(s) → cleared for review`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Misclassified failure recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * FN-6782 / pause-abort auto-recovery: a global pause/resume cycle can leave a
   * task parked `status: "failed"` with the "operator action required" message
   * produced by the executor's genuine-pause-abort branch (executor.ts
   * handleGraphFailure). Historically that required a human to retry/unpause.
   * This sweep auto-recovers those parks: it clears the failed status/error and
   * rehomes the task to `todo` with `status: null`. The scheduler treats a
   * non-paused `todo` task with `status: null` as runnable (scheduler.ts builds
   * its dispatch set from `column === "todo" && !paused`; `status: "queued"` is
   * the *blocked* marker, not the runnable one), so clearing to null is what
   * makes the task schedulable again.
   *
   * Guards mirror the other failed-task recoverers: never touch a task that is
   * paused, currently executing, or whose error is not the pause-abort park.
   */
  async recoverPausedAbortFailures(): Promise<number> {
    try {
      // FNXC:WorkflowLifecycle 2026-06-20-00:00: self-guard against global/engine
      // pause at the method entry, not just the batch-2 runner. This method is
      // public and exercised directly (tests, potential API path); without this,
      // calling it while paused would requeue tasks the operator intentionally
      // froze (greptile P1, PR #1687). Mirrors every peer recovery func.
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const tasks = await this.store.listTasks({ slim: true });

      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-14:20 (fleet):
      Resolution is per task (each card may run a different workflow), so it cannot hoist out of the
      loop — but it also must not run for every row on the board. The pause-abort park is identified by
      error MARKERS, which are column-independent, so the marker test stays a cheap synchronous prefilter
      and the IR is read only for the handful of rows that pass it. The shared `cache` then makes the
      re-verify below free for those same rows.

      `parked` keeps its exact former membership, so the count in the log line below still means what it
      said before this conversion.
      */
      const columnCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const parked: Task[] = [];
      for (const t of tasks) {
        if (!this.isPauseAbortParkCandidate(t)) continue;
        const columns = await this.resolvePauseAbortColumnsFor(t.id, columnCache);
        if ((await this.classifyPausedAbortWorkflowRecovery(t, settings, executingIds.has(t.id), columns)).kind !== "no-action") {
          parked.push(t);
        }
      }

      if (parked.length === 0) return 0;

      log.warn(`Found ${parked.length} pause-abort park(s) requiring auto-recovery`);

      let recovered = 0;
      for (const task of parked) {
        try {
          // FNXC:WorkflowLifecycle 2026-06-20-00:00: re-read AND re-validate the
          // FULL predicate against the refreshed row with a FRESH executing set
          // before mutating — the outer snapshot can go stale across awaits, so a
          // task that became ineligible (paused, user-paused, started executing,
          // or moved to a non-recoverable column) must not get a backward move
          // applied (coderabbit Major + greptile, PR #1687).
          const fresh = await this.store.getTask(task.id);
          const latestExecutingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
          if (!fresh) continue;
          /*
          FNXC:NodeWorktreeIsolation 2026-07-29-06:05 (FN-6756 — gate before mutating, PR #2531 review):
          `latestExecutingIds` is TaskExecutor-owned and blind to a triage PLANNING
          session, exactly as clearPhantomExecutorBinding's four session maps were.
          This sweep does not merely clear a binding — it un-parks the row, requeues
          the card and releases worktree ownership, so an executor-only gate let a
          live planner be requeued and stripped of its worktree through a second
          door after the leaked-slot reaper's was closed.

          Gate on the SHARED read-only probe here, before any mutation, so a live
          session defers the whole recovery to a later sweep with nothing written,
          nothing logged and nothing counted. The destructive release stays BELOW the
          fallible writes — see the ordering note there.
          */
          if (this.options.hasLiveSessionSurface?.(fresh.id) === true) {
            log.debug(`[self-healing] deferring pause-abort recovery for ${fresh.id}: a live session surface is registered`);
            continue;
          }
          const freshColumns = await this.resolvePauseAbortColumnsFor(fresh.id, columnCache);
          const route = await this.classifyPausedAbortWorkflowRecovery(fresh, settings, latestExecutingIds.has(fresh.id), freshColumns);
          if (route.kind === "no-action") {
            continue;
          }

          const workflowTransitionNotification = route.kind === "node-requeue"
            ? {
                /*
                 * FNXC:WorkflowNotifications 2026-06-29-12:47:
                 * Recovery-driven workflow notifications should be keyed by
                 * typed task state, not by human-readable recovery log text.
                 * Stamp the target column so stale markers cannot describe
                 * later task movement.
                 */
                kind: "recovery-requeue" as const,
                column: "todo" as const,
                transitionId: `recovery-requeue:${task.id}:pause-abort-active-work`,
                nodeId: "pause-abort-recovery-router",
                reason: route.reason,
                createdAt: new Date().toISOString(),
              }
            : undefined;
          /*
          FNXC:WorkflowResolvedColumns 2026-07-31-23:45:
          THE ROUTER WAS CONVERTED (#3075) AND THESE BODY GUARDS WERE NOT — the half-converted state
          that is worse than converting nothing, because the route now fires correctly on a renamed
          board and the body then acts on the wrong lane.

          The TARGET is the dangerous one: `moveTask` REJECTS a column the workflow does not declare,
          EXCEPT under `recoveryRehome` with a legacy id (`moves.ts:570`, the #1411 escape hatch). A
          converted route feeding the literal `"todo"` rehomes the card into an undeclared column —
          the state other reconcilers exist to repair.

          `resolveTaskLifecycleColumns` is first-match per role: wrong for "is this card waiting",
          exactly right for "where should it land". Precedence hold -> intake -> legacy is the one
          `moves.ts:1296` documents, because a workflow may declare intake and no hold.

          Both guards below ask ONE question — "is the card already at the requeue target?" — which
          the literal happened to spell twice. Resolved once, before the write, and read by both:
          deriving one question two ways is how a converted guard and an unconverted target drift.
          */
          const requeueLifecycle = await resolveTaskLifecycleColumns(this.store, task.id);
          const requeueTarget = requeueLifecycle?.hold ?? requeueLifecycle?.intake ?? "todo";
          await this.store.updateTask(task.id, {
            status: null,
            error: null,
            ...(fresh.column === requeueTarget && workflowTransitionNotification
              ? { workflowTransitionNotification }
              : {}),
          });
          if (route.kind === "node-requeue" && fresh.column !== requeueTarget) {
            await this.store.moveTask(task.id, requeueTarget, {
              preserveProgress: true,
              moveSource: "engine",
              recoveryRehome: true,
            });
            await this.store.updateTask(task.id, { workflowTransitionNotification });
          }
          /*
          FNXC:NodeWorktreeIsolation 2026-07-29-06:05 (FN-6756 — ordering, PR #2531 review):
          Release worktree ownership only AFTER the fallible writes have committed.

          This sat here originally with its return DISCARDED, which let a refusal be
          followed by "Auto-recovered…", the audit and `recovered++` — reporting
          success while pulling a worktree from under a live planner, which is why it
          went unnoticed. My first correction hoisted the release ABOVE the writes so
          a refusal could abort cleanly, and that traded one fault for another: an
          `updateTask`/`moveTask` rejection after a SUCCESSFUL release left ownership
          given up with the task un-repaired and nothing owning the repair — the same
          torn-write shape U12 hit on re-home, irreversible step before fallible step.

          Both faults are fixed by splitting the question from the act: liveness is
          gated ABOVE via the read-only probe (so a live session never reaches these
          writes), and the irreversible release runs LAST, once the writes it depends
          on have landed. A throw before this point leaves ownership intact and the
          park in place for the next sweep.

          The refusal is still honored as defense-in-depth: reaching it means a
          session started between the probe and here, so ownership stays with that
          session. The un-park and requeue genuinely happened, so the recovery is
          still counted — the warning records only that the worktree was not released.
          */
          const phantomReleased = this.options.clearPhantomExecutorBinding?.(task.id);
          if (phantomReleased === false) {
            log.warn(`[self-healing] pause-abort recovery for ${task.id}: worktree ownership retained — a session started before the release`);
          }

          await this.store.logEntry(
            task.id,
            /* The log line names WHICH route ran, so it asks the same resolved review membership the
               router did — a literal here describes a renamed-board recovery as the wrong kind. */
            freshColumns.review.has(fresh.column)
              ? "Auto-recovered: in-review pause-abort park cleared — preserved for normal review progression"
              : "Auto-recovered: pause-abort park cleared — requeued for normal scheduling",
          );
          // FNXC:WorkflowLifecycle 2026-06-20-00:00: audit emission is strictly
          // best-effort — an audit throw AFTER the successful state mutation must
          // not drop into the per-task catch and falsely log "recovery failed" /
          // skip the recovered++ (coderabbit, PR #1687).
          try {
            await this.store.recordRunAuditEvent?.({
              taskId: task.id,
              agentId: "self-healing",
              runId: generateSyntheticRunId("self-healing", task.id),
              domain: "database",
              mutationType: "task:auto-recover-paused-abort-park",
              target: task.id,
              metadata: {
                fromColumn: fresh.column,
                preservedInReview: route.kind === "work-item-resume",
                recoveryRoute: route.kind,
                recoveryReason: route.reason,
              },
            });
          } catch (auditErr: unknown) {
            log.warn(`Pause-abort park audit emission failed for ${task.id}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
          }
          log.log(`Recovered pause-abort park ${task.id}: ${task.title || task.description?.slice(0, 60) || "(untitled)"}`);
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover pause-abort park ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} pause-abort park(s) → requeued to todo or preserved in review`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Pause-abort park recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  async auditNoCommitsExpectedCandidates(): Promise<number> {
    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-eighth sweep):
      Audits cards that finished every step but pushed NO commits — either a legitimately commit-free task
      that never declared itself so, or work that silently produced nothing. The literal read meant that on
      a renamed board only the `no_commits` ERROR path fed the audit, so a card sitting quietly in a
      renamed review lane with zero commits and no error was never flagged.

      The lane verdict below converts with it; the failed-task read beside it is already lane-independent.
      */
      const noCommitsColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const noCommitsById = new Map<string, Task>();
      for (const column of noCommitsColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) noCommitsById.set(entry.id, entry);
      }
      const inReviewTasks = [...noCommitsById.values()];
      const allTasks = await this.store.listTasks({ slim: true });
      const failedTasks = allTasks.filter((task) => task.status === "failed");
      const candidateMap = new Map<string, Task>();
      for (const task of [...inReviewTasks, ...failedTasks]) {
        candidateMap.set(task.id, task);
      }
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). Covers the failed-task rows too,
         which arrive from the lane-independent read above. */
      const noCommitsLanes = new Map<string, Set<string>>();
      for (const entry of candidateMap.values()) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          noCommitsLanes.set(
            entry.id,
            source === "default"
              ? new Set(noCommitsColumns)
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          noCommitsLanes.set(entry.id, new Set(noCommitsColumns));
        }
      }
      const candidates = [...candidateMap.values()].filter((task) => {
        if (task.noCommitsExpected === true) return false;
        if (task.steps.length === 0 || !task.steps.every((step) => step.status === "done" || step.status === "skipped")) return false;
        const noCommitsError = typeof task.error === "string" && /no_commits/i.test(task.error);
        return (noCommitsLanes.get(task.id) ?? noCommitsColumns).has(task.column) || noCommitsError;
      });

      if (candidates.length === 0) return 0;

      const taskIds: string[] = [];
      for (const task of candidates) {
        const ahead = await isBranchAheadOfBase(task, this.options.rootDir, task.baseBranch || await resolveIntegrationBranch(this.options.rootDir, undefined));
        if (ahead && ahead.aheadCount === 0) {
          taskIds.push(task.id);
        }
      }

      if (taskIds.length > 0) {
        log.warn(`no-commits-expected audit candidates: ${JSON.stringify({ taskIds })}`);
      }

      return taskIds.length;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`No-commits-expected audit failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * FN-6782 leaked-slot reaper (defense-in-depth). The source leak is closed in
   * the executor's pause-abort park path, but a worktree slot leaked by any
   * other/future path would silently pin `maxWorktrees` and concurrency-starve
   * the whole queue (the FN-6756 "in todo yet still maxWorktrees=3/3 holder"
   * symptom) until an engine restart. This sweep cross-checks each in-memory
   * worktree holder against its task column and reclaims slots whose holder is
   * no longer legitimately holding one.
   *
   * Conservative by construction — release happens ONLY when every guard agrees:
   *   - the holder is NOT in the executor's executing set;
   *   - its task is missing, or in `todo`/`triage` (a task waiting to run must
   *     not pin a worktree). `in-progress` and `in-review` holders legitimately
   *     retain their worktree; `done`/`archived` are handled by worktree-metadata
   *     reconcile + merge cleanup, so they are left alone here;
   *   - it has sat in the reapable column past a short grace (no mid-transition race);
   *   - and finally `clearPhantomExecutorBinding` itself refuses (returns false)
   *     if any live session surface is still registered — the last line of
   *     defense against pulling a worktree out from under a running agent.
   */
  async reapLeakedConcurrencySlots(): Promise<number> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) {
      return 0;
    }

    const holders = this.options.listWorktreeHolders?.() ?? [];
    if (holders.length === 0) return 0;

    const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
    const now = Date.now();
    const reaperCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
    let reaped = 0;

    for (const { taskId } of holders) {
      try {
        if (executingIds.has(taskId)) continue;

        const task = await this.store.getTask(taskId).catch(() => null);
        /*
        FNXC:WorkflowColumns 2026-07-29-09:30 (Phase B): intake-or-hold ROLE, same
        behaviour as the literals it replaces.

        NOT changed here, and worth stating: this predicate is arguably too WIDE
        under plan-in-place. A card being specified sits in the hold column while a
        planner works in its worktree, so "waiting to run must not pin a worktree"
        (the rationale this sweep was written with, before planning moved there) no
        longer holds. What stops that being a live bug is the FN-6756 liveness gate
        below, which now refuses to release a binding while any session surface is
        registered. Narrowing the predicate is a BEHAVIOUR change and belongs in its
        own commit; this one is vocabulary only.
        */
        const preWip = task
          ? await this.resolvePreWipColumns(task.id, reaperCache)
          : { intake: "triage", hold: "todo" };
        const reapableColumn = !task || task.column === preWip.hold || task.column === preWip.intake;
        if (!reapableColumn) continue;

        if (task) {
          const since = new Date(task.columnMovedAt ?? task.updatedAt).getTime();
          if (Number.isFinite(since) && now - since < LEAKED_WORKTREE_SLOT_GRACE_MS) continue;
        }

        // FNXC:WorkflowLifecycle 2026-06-20-00:00: re-check execution ownership
        // against a FRESH executing set immediately before releasing — the outer
        // `executingIds` snapshot predates this holder's `getTask` await, so a
        // task that started executing mid-sweep must not have its slot pulled
        // (coderabbit Major, PR #1687). clearPhantomExecutorBinding's live-session
        // refusal is the last line of defense, but this avoids racing it at all.
        const latestExecutingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
        if (latestExecutingIds.has(taskId)) continue;

        const released = this.options.clearPhantomExecutorBinding?.(taskId);
        // false = executor refused (live session surface); undefined = not wired.
        if (released !== true) continue;

        reaped++;
        await this.store.logEntry(
          taskId,
          "Auto-recovered: released leaked worktree/concurrency slot (holder no longer in-progress)",
        );
        log.warn(`Reaped leaked worktree slot held by ${taskId} (column=${task?.column ?? "missing"})`);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`Leaked-slot reaper failed for ${taskId}: ${errorMessage}`);
      }
    }

    if (reaped > 0) log.log(`Reaped ${reaped} leaked worktree slot(s)`);
    return reaped;
  }

  /**
   * Recover executor tasks stranded in `in-progress` before a real session was
   * established, typically when the scheduler reserved a worktree path but the
   * executor never materialized it or crashed before tracking the run.
   */
  async recoverInProgressLimbo(): Promise<number> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) {
      return 0;
    }

    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, eighteenth sweep):
      A card holding a wip slot with NO worktree, NO branch and no step started — nothing is running and
      nothing will. The literal read meant that on a renamed board it was never found, so the card kept
      its slot indefinitely and the capacity it holds is denied to work that could actually run.

      The `task.column !== "in-progress"` check was redundant while the query pinned the column; under a
      resolved read it becomes the per-card verdict, so it converts rather than being deleted.
      */
      const limboWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const limboById = new Map<string, Task>();
      for (const column of limboWipColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) limboById.set(entry.id, entry);
      }
      const tasks = [...limboById.values()];
      /*
      NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891): `resolveWorkflowIrForTask`
      SUBSTITUTES the built-in IR rather than failing, so an unreadable selection would otherwise reject
      the very card the project-scoped query just admitted from a renamed lane.
      */
      const limboLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          limboLanes.set(entry.id, source === "default" ? new Set(limboWipColumns) : new Set(columnsWithFlag(ir, "countsTowardWip")));
        } catch {
          limboLanes.set(entry.id, new Set(limboWipColumns));
        }
      }
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const activeHeartbeatTaskIds = await this.listActiveHeartbeatTaskIds();
      const now = Date.now();

      const stranded = tasks.filter((task) => {
        if (!(limboLanes.get(task.id) ?? limboWipColumns).has(task.column) || task.paused) {
          return false;
        }
        const hasMissingWorktreePath = typeof task.worktree === "string" && task.worktree.length > 0 && !existsSync(task.worktree);
        const hasNoWorktreePath = !task.worktree;
        if (!hasMissingWorktreePath && !hasNoWorktreePath) {
          return false;
        }
        if (typeof task.branch === "string" && task.branch.trim().length > 0) {
          return false;
        }
        if (task.steps.some((step) => step.status !== "pending")) {
          return false;
        }
        const staleness = now - new Date(task.updatedAt).getTime();
        return staleness >= ORPHANED_EXECUTION_RECOVERY_GRACE_MS;
      });

      const describeWorktreeState = (task: Task): string => task.worktree ? "missing worktree path" : "cleared worktree metadata";

      if (stranded.length === 0) return 0;

      log.warn(`Found ${stranded.length} in-progress limbo task(s) with missing/cleared worktree + null branch`);

      let recovered = 0;
      for (const task of stranded) {
        try {
          const liveExecutionSignal = this.getFalsePositiveRequeueSignal(task, {
            executingIds,
            activeHeartbeatTaskIds,
            graceMs: ORPHANED_EXECUTION_RECOVERY_GRACE_MS,
          });
          if (liveExecutionSignal) {
            await this.emitFalsePositiveRequeueNoAction(
              task,
              "auto-recover-in-progress-limbo",
              "task:auto-recover-in-progress-limbo-no-action",
              liveExecutionSignal.reason,
              liveExecutionSignal.metadata,
            );
            continue;
          }

          if (task.checkedOutBy) {
            if (this.options.leaseManager) {
              const leaseRecovered = await this.options.leaseManager.recoverAbandonedLease(
                task.id,
                `in-progress limbo: ${describeWorktreeState(task)} + null branch`,
                { preserveProgress: true },
              );
              if (!leaseRecovered) {
                await this.emitFalsePositiveRequeueNoAction(
                  task,
                  "auto-recover-in-progress-limbo",
                  "task:auto-recover-in-progress-limbo-no-action",
                  "checked-out-lease-active",
                  {
                    taskId: task.id,
                    branch: task.branch ?? null,
                    worktree: task.worktree ?? null,
                    checkedOutBy: task.checkedOutBy,
                    executionStartedAt: task.executionStartedAt ?? null,
                    executionAgeMs: task.executionStartedAt ? Math.max(0, Date.now() - Date.parse(task.executionStartedAt)) : null,
                    graceMs: ORPHANED_EXECUTION_RECOVERY_GRACE_MS,
                    liveWorktreeBoundBranch: false,
                  },
                );
                continue;
              }
              await this.options.leaseManager.reconcileLeaseRow(task.id);
            } else {
              await this.emitFalsePositiveRequeueNoAction(
                task,
                "auto-recover-in-progress-limbo",
                "task:auto-recover-in-progress-limbo-no-action",
                "checked-out-lease-active",
                {
                  taskId: task.id,
                  branch: task.branch ?? null,
                  worktree: task.worktree ?? null,
                  checkedOutBy: task.checkedOutBy,
                  executionStartedAt: task.executionStartedAt ?? null,
                  executionAgeMs: task.executionStartedAt ? Math.max(0, Date.now() - Date.parse(task.executionStartedAt)) : null,
                  graceMs: ORPHANED_EXECUTION_RECOVERY_GRACE_MS,
                  liveWorktreeBoundBranch: false,
                },
              );
              continue;
            }
          }

          const stepStatuses = task.steps.map((step) => step.status);
          const ageMs = Math.max(0, now - new Date(task.updatedAt).getTime());
          await this.store.updateTask(task.id, {
            status: null,
            error: null,
            worktree: null,
            branch: null,
            checkedOutBy: null,
            executionStartedAt: null,
            worktreeSessionRetryCount: null,
            taskDoneRetryCount: null,
            sessionFile: null,
          });
          await this.store.logEntry(
            task.id,
            `Auto-recovered in-progress limbo — ${describeWorktreeState(task)}/null branch with no step progress, moved back to todo`,
            JSON.stringify({
              priorWorktree: task.worktree ?? null,
              priorBranch: task.branch ?? null,
              ageMs,
              stepStatuses,
            }),
          );
          await createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-healing-in-progress-limbo", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "recover-in-progress-limbo",
          }).database({
            type: "task:auto-recover-in-progress-limbo",
            target: task.id,
            metadata: {
              priorWorktree: task.worktree ?? null,
              priorBranch: task.branch ?? null,
              ageMs,
              stepStatuses,
            },
          });
          // #1411: backward recovery — skip order-derived adjacency.
          await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover in-progress limbo task ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} in-progress limbo task(s) → todo`);
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`In-progress limbo recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * FN-5337 contract: observation-only. Emits `task:orphan-detected-no-action`
   * for row-metadata orphan candidates but never moves tasks backward.
   * Proof-based recovery belongs to recoverInProgressLimbo (FN-5219),
   * RestartRecoveryCoordinator, and recoverMissingWorktreeReviewFailures.
   * Do not reintroduce lifecycle mutation here without hard git/session proof
   * and explicit CEO+CTO+PM sign-off.
   */
  async recoverOrphanedExecutions(): Promise<number> {
    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, nineteenth sweep):
      WHAT THIS SWEEP RESTORES IS VISIBILITY, NOT A REPAIR. It takes no lifecycle action — it only emits
      `task:orphan-detected-no-action` so an operator can see a wip card with no live session behind it.
      The literal read meant that on a renamed board the event was never emitted, so the one signal
      pointing at an orphaned execution was silently absent. Worth stating because the rest of this series
      fixes stalls; this one fixes a blind spot.

      The `t.column !== "in-progress"` check was redundant while the query pinned the column; under a
      resolved read it becomes the per-card verdict, so it converts rather than being deleted.
      */
      const orphanWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const orphanExecById = new Map<string, Task>();
      for (const column of orphanWipColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) orphanExecById.set(entry.id, entry);
      }
      const tasks = [...orphanExecById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const orphanExecLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          orphanExecLanes.set(entry.id, source === "default" ? new Set(orphanWipColumns) : new Set(columnsWithFlag(ir, "countsTowardWip")));
        } catch {
          orphanExecLanes.set(entry.id, new Set(orphanWipColumns));
        }
      }
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      const orphaned = tasks.filter((t) => {
        if (!(orphanExecLanes.get(t.id) ?? orphanWipColumns).has(t.column) || t.paused || executingIds.has(t.id) || isTaskWorkComplete(t)) {
          return false;
        }
        const staleness = now - new Date(t.updatedAt).getTime();
        // Tasks with an existing worktree get a longer grace period to avoid
        // racing with executor.resumeOrphaned() on engine startup.
        const hasWorktree = t.worktree && existsSync(t.worktree);
        const graceMs = hasWorktree ? ORPHANED_WITH_WORKTREE_GRACE_MS : ORPHANED_EXECUTION_RECOVERY_GRACE_MS;
        return staleness >= graceMs;
      });

      if (orphaned.length === 0) return 0;

      log.warn(`[orphan-detected] observed ${orphaned.length} candidate(s) — no lifecycle action taken`);

      for (const task of orphaned) {
        try {
          const hadWorktree = Boolean(task.worktree && existsSync(task.worktree));
          const stalenessMs = now - new Date(task.updatedAt).getTime();
          const reason = hadWorktree
            ? "worktree-exists-no-active-session"
            : "missing-worktree-or-session";

          await createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-healing-orphan-detected", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "recover-orphaned-executions",
          }).database({
            type: "task:orphan-detected-no-action",
            target: task.id,
            metadata: {
              priorWorktree: task.worktree ?? null,
              priorBranch: task.branch ?? null,
              hadWorktree,
              stalenessMs,
              reason,
            },
          });

          log.debug(`[orphan-detected] ${task.id}: ${reason} — no action (operator-decides)`);
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to annotate orphaned executor candidate ${task.id}: ${errorMessage}`);
        }
      }

      return 0;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphaned executor recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Re-dispatch assigned in-progress tasks whose durable agent has no active
   * heartbeat run and no active executor session. This is a forward resume via
   * Executor.resumeTaskForAgent; it never moves lifecycle backward and
   * complements the observation-only recoverOrphanedExecutions pass.
   */
  async reattachOrphanedAssignedExecutions(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) {
        return 0;
      }

      const agentStore = this.options.agentStore;
      const resumeAssignedTaskForAgent = this.options.resumeAssignedTaskForAgent;
      if (!agentStore || !resumeAssignedTaskForAgent) {
        return 0;
      }

      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twentieth sweep):
      Reattaches a DURABLE AGENT to a task it is still assigned to but has stopped executing. The literal
      read meant that on a renamed board the reattach never fired, so the agent's own assignment was
      never resumed and the card sat assigned-but-idle — visibly owned by an agent that had gone quiet.

      The `task.column !== "in-progress"` check was redundant while the query pinned the column; under a
      resolved read it becomes the per-card verdict, so it converts rather than being deleted.
      */
      const reattachWipColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const reattachById = new Map<string, Task>();
      for (const column of reattachWipColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) reattachById.set(entry.id, entry);
      }
      const tasks = [...reattachById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const reattachLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          reattachLanes.set(entry.id, source === "default" ? new Set(reattachWipColumns) : new Set(columnsWithFlag(ir, "countsTowardWip")));
        } catch {
          reattachLanes.set(entry.id, new Set(reattachWipColumns));
        }
      }
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const now = Date.now();
      const candidates: Task[] = [];

      for (const task of tasks) {
        if (!(reattachLanes.get(task.id) ?? reattachWipColumns).has(task.column)) continue;
        if (task.paused || task.deletedAt) continue;
        if (!task.assignedAgentId) continue;
        if (executingIds.has(task.id)) continue;
        if (isTaskWorkComplete(task)) continue;

        const updatedAtMs = new Date(task.updatedAt).getTime();
        if (!Number.isFinite(updatedAtMs)) continue;
        const hadWorktree = Boolean(task.worktree && existsSync(task.worktree));
        const graceMs = hadWorktree ? ORPHANED_WITH_WORKTREE_GRACE_MS : ORPHANED_EXECUTION_RECOVERY_GRACE_MS;
        if (now - updatedAtMs < graceMs) continue;

        candidates.push(task);
      }

      if (candidates.length === 0) {
        return 0;
      }

      const tasksByAgent = new Map<string, Task[]>();
      for (const task of candidates) {
        const agentId = task.assignedAgentId;
        if (!agentId) continue;

        const agent = await agentStore.getAgent(agentId);
        if (!agent) continue;

        const activeRun = await agentStore.getActiveHeartbeatRun(agentId);
        if (activeRun) continue;
        if (this.options.hasActiveAgentExecution?.(agentId) === true) continue;

        const agentTasks = tasksByAgent.get(agentId) ?? [];
        agentTasks.push(task);
        tasksByAgent.set(agentId, agentTasks);
      }

      let reattachedAgents = 0;
      for (const [agentId, agentTasks] of tasksByAgent) {
        try {
          await resumeAssignedTaskForAgent(agentId);
          reattachedAgents += 1;

          for (const task of agentTasks) {
            try {
              const hadWorktree = Boolean(task.worktree && existsSync(task.worktree));
              const stalenessMs = now - new Date(task.updatedAt).getTime();
              const reason = hadWorktree
                ? "assigned-agent-no-active-run-or-execution-worktree-exists"
                : "assigned-agent-no-active-run-or-execution";

              await createRunAuditor(this.store, {
                runId: generateSyntheticRunId("self-healing-reattach-orphaned-execution", task.id),
                agentId: "self-healing",
                taskId: task.id,
                taskLineageId: task.lineageId,
                phase: "reattach-orphaned-assigned-executions",
              }).database({
                type: "task:reattach-orphaned-execution",
                target: task.id,
                metadata: {
                  assignedAgentId: agentId,
                  priorWorktree: task.worktree ?? null,
                  priorBranch: task.branch ?? null,
                  hadWorktree,
                  stalenessMs,
                  reason,
                },
              });

              log.log(`[reattach-orphaned-execution] ${task.id}: re-dispatched agent ${agentId} (${reason})`);
            } catch (err: unknown) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              log.error(`Failed to annotate reattached orphaned execution ${task.id}: ${errorMessage}`);
            }
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to reattach orphaned assigned executions for ${agentId}: ${errorMessage}`);
        }
      }

      return reattachedAgents;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphaned assigned execution reattach failed: ${errorMessage}`);
      return 0;
    }
  }

  private getDurableAgentRecoveryState(agent: { metadata?: Record<string, unknown> | null }): {
    attempts: number;
    nextRetryAt?: string;
    exhausted?: boolean;
    lastMissingModulePath?: string;
    consecutiveMissingModulePathCount: number;
  } {
    const metadata = agent.metadata ?? {};
    const raw = metadata.durableErrorRecovery;
    const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const durableAttempts = typeof record.attempts === "number" && Number.isFinite(record.attempts)
      ? Math.max(0, Math.floor(record.attempts))
      : 0;
    const attempts = Math.max(durableAttempts, readHeartbeatErrorRetryCount(agent));
    const consecutiveMissingModulePathCount =
      typeof record.consecutiveMissingModulePathCount === "number" && Number.isFinite(record.consecutiveMissingModulePathCount)
        ? Math.max(0, Math.floor(record.consecutiveMissingModulePathCount))
        : 0;
    return {
      attempts,
      nextRetryAt: typeof record.nextRetryAt === "string" ? record.nextRetryAt : undefined,
      exhausted: record.exhausted === true,
      lastMissingModulePath: typeof record.lastMissingModulePath === "string" ? record.lastMissingModulePath : undefined,
      consecutiveMissingModulePathCount,
    };
  }

  private computeDurableAgentRecoveryCooldownMs(attempts: number): number {
    const clampedAttempts = Math.max(1, attempts);
    const exponential = DURABLE_ERROR_RECOVERY_BASE_COOLDOWN_MS * Math.pow(2, clampedAttempts - 1);
    return Math.min(exponential, DURABLE_ERROR_RECOVERY_MAX_COOLDOWN_MS);
  }

  private async emitDurableAgentErrorRecoveryAudit(options: {
    agentId: string;
    type: "agent:auto-recover-error-state" | "agent:reset-error-state-on-startup" | "agent:error-retry-exhausted" | "agent:error-parked-unrecoverable";
    attempt?: number;
    attempts?: number;
    limit?: number;
    priorState?: Agent["state"];
    priorPauseReason?: string;
    source: "self-healing";
  }): Promise<void> {
    try {
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId("durable-agent-error-recovery", options.agentId),
        agentId: "self-healing",
        phase: "durable-agent-error-recovery",
        source: options.source,
      }).database({
        type: options.type as DatabaseMutationType,
        target: options.agentId,
        metadata: {
          agentId: options.agentId,
          ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
          ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
          ...(options.priorState !== undefined ? { priorState: options.priorState } : {}),
          ...(options.priorPauseReason !== undefined ? { priorPauseReason: options.priorPauseReason } : {}),
          source: options.source,
        },
      });
    } catch (error) {
      log.warn(`Failed to emit durable-agent error recovery audit for ${options.agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async emitStaleAgentAssignmentAudit(options: {
    agent: Pick<Agent, "id" | "state">;
    taskId: string;
    linkedTask?: Task | null;
    hadFreshRun: boolean;
    hadActiveExecution: boolean;
    reason: string;
  }): Promise<void> {
    try {
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-healing-stale-agent-assignment", options.taskId),
        agentId: "self-healing",
        taskId: options.taskId,
        taskLineageId: options.linkedTask?.lineageId,
        phase: "reconcile-stale-agent-assignment",
      }).database({
        type: "task:reconcile-stale-agent-assignment" as DatabaseMutationType,
        target: options.agent.id,
        metadata: {
          agentId: options.agent.id,
          taskId: options.taskId,
          taskColumn: options.linkedTask?.column ?? null,
          agentState: options.agent.state,
          status: options.linkedTask?.status ?? null,
          blockedBy: options.linkedTask?.blockedBy ?? null,
          overlapBlockedBy: options.linkedTask?.overlapBlockedBy ?? null,
          hadFreshRun: options.hadFreshRun,
          hadActiveExecution: options.hadActiveExecution,
          reason: options.reason,
        },
      });
    } catch (error) {
      log.warn(
        `Failed to emit stale agent assignment audit for ${options.agent.id}/${options.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async recoverAgentsRunningOnInactiveTasks(): Promise<number> {
    const agentStore = this.options.agentStore;
    if (!agentStore) {
      return 0;
    }

    const now = Date.now();
    const recoveredAgentIds = new Set<string>();
    const runningAgents = await agentStore.listAgents({ state: "running", includeEphemeral: true });
    const agentLinkTerminalColumns = await resolveProjectColumnsForRoles(this.store, TERMINAL_ROLES);
    const agentLinkLiveColumns = new Set<string>([
      ...await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]),
      ...await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES),
    ]);

    /* FNXC:WorkflowResolvedColumns 2026-07-31-23:45: the parked pair handed to
       `evaluateParkedAgentTaskLink`; legacy-seeded, so unconverted boards are unchanged. */
    const agentParkedColumns = await resolveProjectColumnsForRoles(this.store, ["hold", "intake"]);
    for (const agent of runningAgents) {
      if (isEphemeralAgent(agent) || !agent.taskId) {
        continue;
      }

      const linkedTask = await this.store.getTask(agent.taskId);
      /* FNXC:WorkflowResolvedColumns 2026-07-31-16:50 (fleet, round 2): WIP u REVIEW u TERMINAL. Keyed on
         ids none matched on a renamed board, so this sweep evaluated agents whose task was still executing. */
      if (linkedTask && (agentLinkLiveColumns.has(linkedTask.column) || agentLinkTerminalColumns.has(linkedTask.column))) {
        continue;
      }

      const activeRun = await agentStore.getActiveHeartbeatRun(agent.id);
      const proof = evaluateParkedAgentTaskLink({
        agent,
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-23:45:
        The synthetic stand-in for a MISSING task stays the legacy id ON PURPOSE, and is now correct
        rather than merely unconverted: `parkedColumns` below is legacy-seeded, so `todo` is a member
        on every board. A deleted row also has no workflow selection, so a "renamed" placeholder
        would be a guess about a task that no longer exists.
        */
        linkedTask: linkedTask ?? { column: "todo" } as Pick<Task, "column">,
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-23:45:
        Previously OMITTED, so this call fell back to `LEGACY_PARKED_COLUMNS` (`todo`/`triage`) and a
        live agent linked to a card resting in a RENAMED hold lane read as not-parked — the safeguard
        that preserves its task link never applied, and the link was dropped.
        */
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-18:05 (INERT HERE, and deliberately kept):
        `parkedColumns` influences exactly one output — `shouldPreserveParkedLink` — and THIS sweep
        never reads it. The gate below is `hasFreshRun || hasActiveExecution`, neither of which depends
        on the lane, so passing a resolved set changes nothing today. Blinding it back to the legacy
        ids leaves every test green because there is no behaviour to observe.

        Kept rather than deleted for two reasons. Removing it would make this call site read as
        UNWIRED to the lane-wiring ratchet, inviting the next worker to "fix" it by re-adding exactly
        this; and if the gate ever adopts `shouldPreserveParkedLink` — which is the parked-specific
        semantics the sibling sweep uses (see `recoverDriftedAgentTaskLinks`, wired in #3208) — the
        resolved set is already correct here.

        Recorded because "passed but unread" is the mirror of "resolved gate, literal branch" that
        #3208 fixed: both read as converted while deciding nothing.
        */
        parkedColumns: [...agentParkedColumns],
        activeRun,
        hasActiveAgentExecution: this.options.hasActiveAgentExecution,
        now,
      });
      if (proof.hasFreshRun || proof.hasActiveExecution) {
        continue;
      }

      const reason = linkedTask
        ? `running durable agent linked to inactive ${linkedTask.column} task without live execution proof`
        : "running durable agent linked to missing task without live execution proof";
      const staleAgentState = agent.state;
      await agentStore.updateAgentState(agent.id, "active");
      await agentStore.syncExecutionTaskLink(agent.id, undefined);
      await this.emitStaleAgentAssignmentAudit({
        agent: { id: agent.id, state: staleAgentState },
        taskId: agent.taskId,
        linkedTask,
        hadFreshRun: proof.hasFreshRun,
        hadActiveExecution: proof.hasActiveExecution,
        reason,
      });
      recoveredAgentIds.add(agent.id);
      log.log(`Recovered running durable agent ${agent.id} on inactive task ${agent.taskId}; file-scope lease preserved when present`);
    }

    return recoveredAgentIds.size;
  }

  async recoverDriftedAgentTaskLinks(): Promise<number> {
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-22:30 (self-healing cluster): a drifted agent link pointing at a FINISHED card. Keyed on the literal this sweep answered "no" for every card on a renamed board. */
    const driftedTerminalColumns = await resolveProjectColumnsForRoles(this.store, TERMINAL_ROLES);
    const agentStore = this.options.agentStore;
    if (!agentStore) {
      return 0;
    }

    const now = Date.now();
    const clearedAgentIds = new Set<string>();
    const durableAgents = await agentStore.listAgents({ includeEphemeral: false });

    for (const agent of durableAgents) {
      if (!agent.taskId) {
        continue;
      }

      const linkedTaskId = agent.taskId;
      const linkedTask = await this.store.getTask(linkedTaskId);
      let shouldClear = false;
      let reason = "";
      let hadFreshRun = false;
      let hadActiveExecution = false;

      if (!linkedTask) {
        shouldClear = true;
        reason = "linked task missing";
      } else if (driftedTerminalColumns.has(linkedTask.column)) {
        shouldClear = true;
        reason = `linked task in terminal column ${linkedTask.column}`;
      } else if (linkedTask.assignedAgentId && linkedTask.assignedAgentId !== agent.id) {
        shouldClear = true;
        reason = `linked task assigned to ${linkedTask.assignedAgentId}`;
      } else if (await this.isPreWipColumn(linkedTask)) {
        const activeRun = await agentStore.getActiveHeartbeatRun(agent.id);
        /*
        FNXC:WorkflowResolvedColumns 2026-07-31-17:40 (the missed half of a pair):
        `parkedColumns` was NOT passed here while the sibling sweep passes it, so this call fell back
        to LEGACY_PARKED_COLUMNS. The branch is entered on a RESOLVED question (`isPreWipColumn`) and
        then decided on a literal one, so the two disagreed on a renamed board: the card is pre-wip,
        `isParkedTaskColumn` says no, `shouldPreserveParkedLink` is false, and a live agent WITH a
        fresh heartbeat run has its task link cleared.

        `task-agent-sync.ts` predicted exactly this when the parameter was added: "turning a stale-link
        bug into a dropped-link bug, since the card would be treated as unparked and its live agent
        link cleared." That is what an unpassed optional lane parameter costs.
        */
        const driftedParkedColumns = await resolveProjectColumnsForRoles(this.store, ["hold", "intake"]);
        const proof = evaluateParkedAgentTaskLink({
          agent,
          linkedTask,
          activeRun,
          hasActiveAgentExecution: this.options.hasActiveAgentExecution,
          now,
          parkedColumns: [...driftedParkedColumns],
        });
        hadFreshRun = proof.hasFreshRun;
        hadActiveExecution = proof.hasActiveExecution;
        if (!proof.shouldPreserveParkedLink) {
          shouldClear = true;
          reason = `linked task in queued column ${linkedTask.column} without fresh run or active execution`;
        }
      }

      if (!shouldClear) {
        continue;
      }

      const staleAgentState = agent.state;
      if (agent.state === "running") {
        await agentStore.updateAgentState(agent.id, "active");
      }
      await agentStore.syncExecutionTaskLink(agent.id, undefined);
      await this.emitStaleAgentAssignmentAudit({
        agent: { id: agent.id, state: staleAgentState },
        taskId: linkedTaskId,
        linkedTask,
        hadFreshRun,
        hadActiveExecution,
        reason,
      });
      clearedAgentIds.add(agent.id);
      log.log(`Cleared drifted durable agent task link for ${agent.id} (${linkedTaskId}): ${reason}; file-scope lease preserved when present`);
    }

    /*
    FNXC:EngineDiagnostics 2026-08-01-18:11:
    Zero-recovery summary is a no-op sweep result — debug only (FUSION_DEBUG=self-healing).
    Non-zero recoveries stay on log so operators still see real link repairs.
    */
    if (clearedAgentIds.size > 0) {
      log.log(`Recovered ${clearedAgentIds.size} drifted durable agent task link(s)`);
    } else {
      log.debug(`Recovered ${clearedAgentIds.size} drifted durable agent task link(s)`);
    }
    return clearedAgentIds.size;
  }

  /*
  FNXC:AgentLifecyclePause 2026-07-19-00:00:
  FN-8362: Startup heartbeat recovery changes only durable agent state and
  metadata. It must never read or mutate an assigned task's paused, userPaused,
  pausedByAgentId, or pausedReason fields; task safety parks remain separately
  owned by their reason-specific writers.

  FNXC:AgentHeartbeat 2026-07-12-17:26:
  FN-7884: Engine restart is an explicit operator retry boundary for durable heartbeat agents. Startup recovery must immediately clear recoverable `error` and `error-retry-exhausted` parks, reset shared heartbeatErrorRecovery/durableErrorRecovery budget state, and re-arm heartbeats without steady-state staleness/cooldown/exhaustion gates; operator-actionable, stale-module, user-paused, error-unrecoverable, disabled, ephemeral, and actively executing agents remain suppressed.

  FNXC:AgentHeartbeat 2026-07-14-16:13:
  Startup must also recover a `heartbeat-model-unavailable` park when its recorded failing provider differs from the agent's complete assigned runtime model. This repairs agents falsely parked by the former shared-project-model precedence while preserving genuine assigned-provider authentication failures for operator action.

  FNXC:AgentHeartbeat 2026-07-15-08:50:
  Startup now recovers every `heartbeat-model-unavailable` park (not only misattributed providers). Engine restart is treated like operator Retry: false model-unavailable/credential-probe parks clear immediately, and genuine missing credentials re-park on the next failing heartbeat.
  */
  async resetDurableAgentErrorStateOnStartup(): Promise<number> {
    const agentStore = this.options.agentStore;
    if (!agentStore) {
      return 0;
    }

    let resetCount = 0;
    try {
      const allAgents = await agentStore.listAgents({ includeEphemeral: true });
      for (const agent of allAgents) {
        const isErrorRetryExhaustedPark =
          agent.state === "paused" && agent.pauseReason === HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON;
        const isModelUnavailableParked = isModelUnavailablePark(agent);
        if (agent.state !== "error" && !isErrorRetryExhaustedPark && !isModelUnavailableParked) {
          continue;
        }
        if (isEphemeralAgent(agent)) {
          continue;
        }
        const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
        if (runtimeConfig.enabled === false) {
          continue;
        }
        if (this.options.hasActiveAgentExecution?.(agent.id) === true) {
          continue;
        }
        if ((!isModelUnavailableParked && !isHeartbeatErrorRecoverable(agent)) || isStaleWorktreeModuleResolutionError(agent.lastError ?? "")) {
          log.warn(`Startup durable-agent error reset suppressed for ${agent.id}: unrecoverable or stale-module error requires existing recovery path`);
          continue;
        }

        const priorState = agent.state;
        const priorPauseReason = agent.pauseReason;
        const resetMetadata = resetHeartbeatErrorRecoveryMetadata(agent);
        try {
          await agentStore.updateAgentState(agent.id, "active");
          await agentStore.updateAgent(agent.id, {
            lastError: undefined,
            pauseReason: undefined,
            metadata: resetMetadata,
          });
          await this.emitDurableAgentErrorRecoveryAudit({
            agentId: agent.id,
            type: "agent:reset-error-state-on-startup",
            priorState,
            ...(priorPauseReason ? { priorPauseReason } : {}),
            source: "self-healing",
          });
          if (!this.options.restartDurableAgentHeartbeat) {
            log.log(`Durable-agent startup error reset heartbeat restart unavailable for ${agent.id}; state reset only`);
          } else {
            const restartOk = await this.options.restartDurableAgentHeartbeat(agent.id, {
              reason: "startup-error-reset",
              attempt: 1,
            });
            if (!restartOk) {
              log.warn(`Durable-agent startup error reset heartbeat restart skipped for ${agent.id}`);
            }
          }
          resetCount++;
          log.log(`Startup reset durable-agent error state for ${agent.id}; heartbeat re-armed when available`);
        } catch (error) {
          log.warn(`Failed to reset durable-agent error state on startup for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      log.warn(`Startup durable-agent error reset failed: ${error instanceof Error ? error.message : String(error)}`);
      return resetCount;
    }

    return resetCount;
  }

  /*
  FNXC:AgentLifecyclePause 2026-07-19-00:00:
  Error auto-recovery, retry-exhaustion, and unrecoverable-error parking are
  agent-only transitions. Assigned task pause state is never cascaded or
  cleared by this sweep, including when a heartbeat is re-armed.
  */
  async recoverOrphanedAgents(): Promise<number> {
    const agentStore = this.options.agentStore;
    if (!agentStore) {
      return 0;
    }

    try {
      const settings = await this.store.getSettings();
      const errorRecoveryLimit = resolveErrorRecoveryLimit(settings);
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!Number.isFinite(timeoutMs) || timeoutMs === undefined || timeoutMs <= 0) {
        return 0;
      }
      const recoveryTimeoutMs = timeoutMs;

      const allAgents = await agentStore.listAgents();
      const allAgentIds = new Set(allAgents.map((agent) => agent.id));
      const now = Date.now();

      /*
      FNXC:AgentHeartbeat 2026-07-12-20:10:
      An agent parked paused/"error-unrecoverable" whose lastError NOW classifies as recoverable (e.g. transient OAuth token-rotation 401s that were misclassified operator-actionable before isTransientAuthCredentialError existed) must not stay parked forever waiting for a human. Re-admit exactly those parked agents to the error-recovery sweep; user pauses and every other pauseReason are untouched. The shared retry budget, cooldown, and staleness gates below still apply.

      FNXC:AgentHeartbeat 2026-07-15-08:50:
      Also re-admit stale paused/heartbeat-model-unavailable parks when shared retry budget remains. Manual Retry already proves many of these are false positives; the timer path is the fast recovery, and this sweep is the backstop when timers were cleared on park.
      */
      const isReclassifiedRecoverableParkedError = (agent: Agent): boolean =>
        agent.state === "paused"
        && agent.pauseReason === HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON
        && isHeartbeatErrorRecoverable(agent);

      const orphaned = allAgents.filter((agent) => {
        if (isEphemeralAgent(agent)) {
          return false;
        }
        const isModelUnavailableRecoveryCandidate = isModelUnavailableParkRecoveryEligible(agent, errorRecoveryLimit);
        if (
          agent.state !== "running"
          && agent.state !== "error"
          && !isReclassifiedRecoverableParkedError(agent)
          && !isModelUnavailableRecoveryCandidate
        ) {
          return false;
        }
        /*
         * FNXC:AgentHeartbeat 2026-07-08-12:20:
         * FN-7672: 4 of the CTO's 6 durable direct reports went simultaneously
         * `error` (correlated auth/session blip) and stayed stuck for hours —
         * HeartbeatTriggerScheduler clears timers entirely on `state === "error"`
         * (isTickableState excludes it), so a durable error-state agent can ONLY
         * come back via this recovery sweep; there is no natural self-heal via
         * the normal tick loop. The `managerMissing` gate below previously
         * applied uniformly to BOTH orphaned "running" agents (a genuinely
         * different failure mode — a live process whose manager row vanished)
         * AND "error" agents, which meant a durable agent in `error` with a
         * present/active manager was structurally never even considered for
         * recovery, regardless of how transient its `lastError` was. That is
         * the systemic gap: manager presence has no bearing on whether a
         * durable agent's own error is transient and safe to retry. Restrict
         * `managerMissing` to the "running" orphan-detection path (unchanged
         * behavior) and let "error" state proceed to the existing transient /
         * operator-actionable / active-execution / cooldown / retry-budget
         * guards below, which already exist specifically to prevent restart
         * loops on genuinely broken (non-transient/operator-actionable)
         * credentials — those guards are NOT weakened here.
         */
        const managerMissing = !agent.reportsTo || !allAgentIds.has(agent.reportsTo);
        if (agent.state === "running" && !managerMissing) {
          return false;
        }
        const updatedAt = Date.parse(agent.updatedAt ?? "");
        if (!Number.isFinite(updatedAt) || now - updatedAt < recoveryTimeoutMs) {
          return false;
        }

        if (
          agent.state === "error"
          || isReclassifiedRecoverableParkedError(agent)
          || isModelUnavailableRecoveryCandidate
        ) {
          const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
          if (runtimeConfig.enabled === false) {
            return false;
          }
          if (this.options.hasActiveAgentExecution?.(agent.id) === true) {
            return false;
          }
          const isRecoverableHeartbeatError = isHeartbeatErrorRecoverable(agent) || isModelUnavailableRecoveryCandidate;
          const isStaleMissingModule = isStaleWorktreeModuleResolutionError(agent.lastError ?? "");
          const isUnrecoverableHeartbeatError = !isRecoverableHeartbeatError && !isStaleMissingModule;

          const recoveryState = this.getDurableAgentRecoveryState(agent);
          if (!isUnrecoverableHeartbeatError && recoveryState.exhausted) {
            return false;
          }
          if (!isUnrecoverableHeartbeatError && recoveryState.nextRetryAt) {
            const nextRetryMs = Date.parse(recoveryState.nextRetryAt);
            if (Number.isFinite(nextRetryMs) && nextRetryMs > now) {
              log.log(`Durable agent ${agent.id} transient recovery delayed until ${recoveryState.nextRetryAt}`);
              return false;
            }
          }
        }

        return true;
      });

      if (orphaned.length === 0) {
        return 0;
      }

      let recovered = 0;
      /*
      FNXC:AgentHeartbeat 2026-07-12-21:05:
      PR #2027 review: unrecoverable-error parks are a handled outcome of the sweep (the return value counts actions taken, preserving the existing caller contract), but they are NOT recoveries to active — the summary log must say "parked for operator action", never fold them into "→ active", or maintenance logs misreport agents that still need manual repair.
      */
      let parkedUnrecoverable = 0;
      for (const agent of orphaned) {
        const updatedAt = Date.parse(agent.updatedAt ?? "");
        const stuckForMs = Math.max(0, now - updatedAt);
        // Reclassified "error-unrecoverable" and heartbeat-model-unavailable parked
        // agents run the same recovery branch as error-state agents: shared budget,
        // cooldown, audit, restart.
        const isErrorRecoveryCandidate =
          agent.state === "error"
          || isReclassifiedRecoverableParkedError(agent)
          || isModelUnavailablePark(agent);
        try {
          if (isErrorRecoveryCandidate) {
            const recoveryState = this.getDurableAgentRecoveryState(agent);
            const isStaleMissingModule = isStaleWorktreeModuleResolutionError(agent.lastError ?? "");
            // Model-unavailable parks are intentionally operator-actionable by lastError text
            // but still budget-retryable; do not reclassify them as error-unrecoverable here.
            const isUnrecoverableHeartbeatError =
              !isModelUnavailablePark(agent)
              && !isHeartbeatErrorRecoverable(agent)
              && !isStaleMissingModule;
            if (isUnrecoverableHeartbeatError) {
              /*
              FNXC:AgentHeartbeat 2026-07-12-18:34:
              FN-7859 keeps self-healing from restart-looping non-recoverable durable agent errors, but still parks them paused with a clear operator-action reason instead of skipping them into indefinite bare error.
              */
              await agentStore.updateAgentState(agent.id, "paused");
              await agentStore.updateAgent(agent.id, {
                pauseReason: HEARTBEAT_ERROR_UNRECOVERABLE_PAUSE_REASON,
                metadata: {
                  ...(agent.metadata ?? {}),
                  durableErrorRecovery: {
                    ...((agent.metadata?.durableErrorRecovery && typeof agent.metadata.durableErrorRecovery === "object")
                      ? agent.metadata.durableErrorRecovery as Record<string, unknown>
                      : {}),
                    attempts: recoveryState.attempts,
                    exhausted: recoveryState.exhausted,
                    lastReason: "non-recoverable-error",
                    lastObservedAt: new Date().toISOString(),
                  },
                },
              });
              await this.emitDurableAgentErrorRecoveryAudit({
                agentId: agent.id,
                type: "agent:error-parked-unrecoverable",
                attempts: recoveryState.attempts,
                limit: errorRecoveryLimit,
                source: "self-healing",
              });
              log.warn(`Suppressed durable-agent auto-restart for ${agent.id}: unrecoverable heartbeat error; paused for operator action`);
              parkedUnrecoverable++;
              continue;
            }
            if (isStaleMissingModule) {
              const missingModulePath = extractMissingModulePath(agent.lastError ?? "");
              const repeatedPath =
                missingModulePath && recoveryState.lastMissingModulePath === missingModulePath
                  ? recoveryState.consecutiveMissingModulePathCount + 1
                  : 1;
              await agentStore.updateAgent(agent.id, {
                metadata: {
                  ...(agent.metadata ?? {}),
                  durableErrorRecovery: {
                    attempts: recoveryState.attempts,
                    nextRetryAt: recoveryState.nextRetryAt,
                    exhausted: recoveryState.exhausted,
                    lastReason: "stale-path-module-resolution",
                    lastMissingModulePath: missingModulePath ?? recoveryState.lastMissingModulePath,
                    consecutiveMissingModulePathCount: repeatedPath,
                    lastObservedAt: new Date().toISOString(),
                  },
                },
              });
              log.warn(`Suppressed durable-agent auto-restart for ${agent.id}: stale module-resolution failure indicates stale host process/worktree path`);
              if (missingModulePath && repeatedPath >= 3) {
                log.warn(
                  `Durable agent ${agent.id} repeated missing-module path ${repeatedPath} times (${missingModulePath}). Hosting dashboard/engine process is likely stale (for example, zombie process from a deleted worktree); clean up stale process/worktree. FN-4013 tracks systemic prevention.`,
                );
              }
              continue;
            }
            const nextAttempts = recoveryState.attempts + 1;
            const exhausted = nextAttempts >= errorRecoveryLimit;
            const nextRetryAt = new Date(Date.now() + this.computeDurableAgentRecoveryCooldownMs(nextAttempts)).toISOString();
            /*
            FNXC:AgentHeartbeat 2026-07-11-22:42:
            FN-7844 consolidates durable-agent error recovery accounting across the heartbeat timer and self-healing sweep. The sweep keeps its cooldown/stale-path metadata, but writes the shared heartbeatErrorRecovery counter and audit event so a single retry budget applies regardless of which recovery entry path fires.
            */
            await agentStore.updateAgent(agent.id, {
              metadata: {
                ...buildHeartbeatErrorRecoveryMetadata(agent, nextAttempts),
                durableErrorRecovery: {
                  attempts: nextAttempts,
                  lastAttemptAt: new Date().toISOString(),
                  nextRetryAt,
                  exhausted,
                  lastReason: exhausted ? "retry-budget-exhausted" : "transient-error",
                  lastMissingModulePath: undefined,
                  consecutiveMissingModulePathCount: 0,
                },
              },
            });
            if (exhausted) {
              await this.emitDurableAgentErrorRecoveryAudit({
                agentId: agent.id,
                type: "agent:error-retry-exhausted",
                attempts: nextAttempts,
                limit: errorRecoveryLimit,
                source: "self-healing",
              });
              // Keep heartbeat-model-unavailable labeling when that park exhausted so
              // operators still see credential/model guidance rather than a generic label.
              if (!isModelUnavailablePark(agent)) {
                await agentStore.updateAgentState(agent.id, "paused");
                await agentStore.updateAgent(agent.id, { pauseReason: HEARTBEAT_ERROR_RETRY_EXHAUSTED_PAUSE_REASON });
              }
              log.warn(`Suppressed durable-agent auto-restart for ${agent.id}: retry budget exhausted`);
              continue;
            }
          }

          await agentStore.updateAgentState(agent.id, "active");
          await agentStore.updateAgent(agent.id, {
            lastError: undefined,
            // Clear error-unrecoverable / heartbeat-model-unavailable park markers when
            // a parked agent is re-admitted; harmless no-op for bare error-state agents.
            pauseReason: undefined,
          });

          if (isErrorRecoveryCandidate) {
            const attempt = this.getDurableAgentRecoveryState(agent).attempts + 1;
            await this.emitDurableAgentErrorRecoveryAudit({
              agentId: agent.id,
              type: "agent:auto-recover-error-state",
              attempt,
              limit: errorRecoveryLimit,
              source: "self-healing",
            });
            if (!this.options.restartDurableAgentHeartbeat) {
              log.log(`Durable-agent transient recovery heartbeat restart unavailable for ${agent.id}; state reset only`);
            }
          }

          if (isErrorRecoveryCandidate && this.options.restartDurableAgentHeartbeat) {
            const restartOk = await this.options.restartDurableAgentHeartbeat(agent.id, {
              reason: "transient-error",
              attempt: this.getDurableAgentRecoveryState(agent).attempts + 1,
            });
            if (!restartOk) {
              log.warn(`Durable-agent transient recovery heartbeat restart skipped for ${agent.id}`);
            }
          }

          log.log(
            `Auto-recovered: orphaned agent ${agent.id} stuck in ${agent.state} for ${Math.round(stuckForMs / 1000)}s — reset to active`,
          );
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover orphaned agent ${agent.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} orphaned agent(s) → active`);
      }
      if (parkedUnrecoverable > 0) {
        log.warn(`Parked ${parkedUnrecoverable} durable agent(s) with unrecoverable errors for operator action (not recovered)`);
      }
      return recovered + parkedUnrecoverable;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphaned agent recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Default cap (in ms) on how long an active heartbeat run from the current
   * process is allowed to remain open before self-healing will terminate it.
   * Six hours is well past any legitimate heartbeat tick (default 1 h
   * interval, configurable up to a few hours) so reaching this threshold
   * means the run record was never closed — typically a process that died
   * without our watchdog catching it.
   */
  private static readonly STALE_ACTIVE_RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

  /**
   * Terminate orphaned `agentRuns` rows left in `status = 'active'` by a
   * process that crashed before calling endHeartbeatRun(). These rows
   * silently break heartbeat scheduling: HeartbeatTriggerScheduler.onTimerTick
   * skips every tick that finds an active run, so the agent never gets called
   * again until something cleans up.
   *
   * A run is considered stale when:
   *  - `processPid` was recorded and does not match the current `process.pid`
   *    (i.e., the writer process is gone — guaranteed orphan), or
   *  - `processPid` is missing (legacy data), or
   *  - the run has been active for longer than STALE_ACTIVE_RUN_MAX_AGE_MS,
   *    even from the current process (defense in depth against a writer that
   *    leaks the row without crashing the whole runtime).
   *
   * The matching `processPid` + young run case is left alone — that is a
   * legitimately in-flight heartbeat.
   */
  async recoverStaleHeartbeatRuns(): Promise<number> {
    const agentStore = this.options.agentStore;
    if (!agentStore) {
      return 0;
    }

    let activeRuns;
    try {
      activeRuns = await agentStore.listActiveHeartbeatRuns();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Stale heartbeat run recovery — listing failed: ${errorMessage}`);
      return 0;
    }

    if (activeRuns.length === 0) {
      return 0;
    }

    const now = Date.now();
    const currentPid = process.pid;
    const maxAgeMs = SelfHealingManager.STALE_ACTIVE_RUN_MAX_AGE_MS;
    let recovered = 0;

    for (const run of activeRuns) {
      const startedMs = Date.parse(run.startedAt);
      const ageMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : Infinity;
      const recordedPid = run.processPid;

      const pidMismatch = typeof recordedPid === "number" && recordedPid !== currentPid;
      const pidMissing = typeof recordedPid !== "number";
      const tooOld = ageMs >= maxAgeMs;

      if (!pidMismatch && !pidMissing && !tooOld) {
        continue;
      }

      const reason = pidMismatch
        ? `writer pid ${recordedPid} is no longer this process (current pid ${currentPid})`
        : pidMissing
          ? `no processPid recorded`
          : `active for ${Math.round(ageMs / 1000)}s (>= ${Math.round(maxAgeMs / 1000)}s threshold)`;

      try {
        const detail = await agentStore.getRunDetail(run.agentId, run.id);
        if (detail) {
          await agentStore.saveRun({
            ...detail,
            endedAt: new Date().toISOString(),
            status: "terminated",
            stderrExcerpt: `Auto-recovered orphaned heartbeat run: ${reason}`,
          });
        }
        await agentStore.endHeartbeatRun(run.id, "terminated");
        log.log(
          `Auto-recovered: orphan heartbeat run ${run.id} for ${run.agentId} (${reason})`,
        );
        recovered++;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.error(`Failed to recover stale heartbeat run ${run.id} for ${run.agentId}: ${errorMessage}`);
      }
    }

    if (recovered > 0) {
      log.log(`Recovered ${recovered} stale heartbeat run(s)`);
    }
    return recovered;
  }

  /**
   * Recover `in-progress` tasks that failed only because the agent exited
   * without calling fn_task_done, and where there is no sign of work to preserve.
   *
   * Backward lifecycle move gated on triple proof (FN-5335).
   * When the predicate fails, emits `task:no-progress-no-task-done-no-action` and skips lifecycle mutation.
   *
   * These are safe to requeue automatically when no steps progressed and git
   * has neither worktree changes nor branch commits. Cases with any evidence
   * of work are left alone for manual inspection or the normal orphan recovery
   * path.
   */
  async recoverNoProgressNoTaskDoneFailures(): Promise<number> {
    try {
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-ninth sweep):
      A wip card the executor failed for "no fn_task_done" that made NO step progress and left no git
      work — nothing to salvage, so it is safe to requeue. The literal read meant that on a renamed board
      it was never requeued, so a card that produced nothing sat failed while still holding its wip slot.

      The per-card verdict below converts with it. No second pair; verified with the derived ratchet
      from #2879.
      */
      const noProgressColumns = await resolveProjectColumnsForRoles(this.store, ["countsTowardWip"]);
      const noProgressById = new Map<string, Task>();
      for (const column of noProgressColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) noProgressById.set(entry.id, entry);
      }
      const tasks = [...noProgressById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const noProgressLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          noProgressLanes.set(entry.id, source === "default" ? new Set(noProgressColumns) : new Set(columnsWithFlag(ir, "countsTowardWip")));
        } catch {
          noProgressLanes.set(entry.id, new Set(noProgressColumns));
        }
      }
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      const candidates = tasks.filter((task) =>
        (noProgressLanes.get(task.id) ?? noProgressColumns).has(task.column) &&
        task.status === "failed" &&
        isNoTaskDoneFailure(task) &&
        !task.paused &&
        !executingIds.has(task.id) &&
        !isTaskWorkComplete(task) &&
        !hasStepProgress(task),
      );

      if (candidates.length === 0) return 0;

      log.warn(`Found ${candidates.length} no-progress no-task_done failure(s) in in-progress`);

      let recovered = 0;
      for (const task of candidates) {
        try {
          if (await this.hasRecoverableGitWork(task)) {
            log.debug(`${task.id} has recoverable git work — leaving in-progress for inspection`);
            continue;
          }

          const proof = await this.evaluateBackwardMoveTripleProof(task, {
            stage: "no-progress-no-task-done",
            graceMs: ORPHANED_EXECUTION_RECOVERY_GRACE_MS,
            stalenessAnchor: task.executionStartedAt ?? task.updatedAt,
            reason: "no-progress-no-task-done-candidate",
          });
          if (!proof.ok) {
            await this.emitBackwardMoveNoAction(task, "no-progress-no-task-done", "task:no-progress-no-task-done-no-action", proof);
            continue;
          }

          await this.store.updateTask(task.id, {
            status: "stuck-killed",
            worktree: null,
            branch: null,
          });
          await this.store.logEntry(
            task.id,
            "Auto-recovered no-progress no-task_done failure — clean worktree, moved back to todo",
          );
          // #1411: backward recovery — skip order-derived adjacency.
          await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), { moveSource: "engine", recoveryRehome: true });
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover no-progress no-task_done failure ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} no-progress no-task_done failure(s) → todo`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`No-progress no-task_done recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover failed `in-review` retries that point at an unusable worktree path.
   *
   * Backward lifecycle move gated on triple proof (FN-5335).
   * When the predicate fails, emits `task:missing-worktree-review-no-action` and skips lifecycle mutation.
   *
   * This is a narrow guard for session-start failures thrown by
   * `assertValidWorktreeSession()` in `pi.ts`, classified centrally via
   * `MISSING_WORKTREE_SESSION_PREFIXES` /
   * `classifyMissingWorktreeSessionStartFailure()` in
   * `restart-recovery-coordinator.ts`.
   * We clear stale worktree metadata and failure state, keep step progress and
   * retry counters, then requeue to todo for a clean retry.
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverMissingWorktreeReviewFailures(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, twenty-seventh sweep):
      THE NOTE BELOW SAID THIS WAS UNFIXABLE. It called the literal query "unfixable without a
      project-level lane resolution before the read" — which is precisely what
      `resolveProjectColumnsForRoles` provides; it did not exist when that note was written. The wiring
      below was therefore doing real work only for boards whose review lane still happens to be called
      `in-review`. Fully renamed boards never reached it.
      */
      const missingWtColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const missingWtById = new Map<string, Task>();
      for (const column of missingWtColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) missingWtById.set(entry.id, entry);
      }
      const tasks = [...missingWtById.values()];
      /*
      FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (PR #2745 review — greptile P1: "recovery lanes are not
      wired", and it is right):
      THE PRODUCTION PATH SUPPLIES THE SET. Adding the optional parameter to the three classifiers gave them the
      capability and changed nothing in production, which is a half-conversion of a different shape: not a gate
      reading the wrong board, but a capability with no caller. The census would have shown three converted
      sites and a renamed board would still have parked the card for a human.

      Resolved per candidate with one shared IR cache. Note the QUERY above still reads `column: "in-review"` —
      that is the query class, flagged in this PR's body and unfixable without a project-level lane resolution
      before the read, so the wiring here matters for boards whose review lane IS `in-review` under a renamed
      workflow (the common partial-rename case) and for the merge-active variant.
      */
      const recoveryIrCache = new Map<string, WorkflowIr>();
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the ARITY trap, same seam):
      These classifiers take a MEMBERSHIP set, and `resolveTaskLifecycleColumns().review` is the FIRST
      column per role — so a board declaring more than one review column contributed only one of them and
      a card sitting in the others read as not-in-review. `columnsWithFlag` over the three review roles is
      the membership answer; the legacy id stays unioned for a board mid-rename.
      */
      const reviewColumnsFor = async (taskId: string): Promise<ReadonlySet<string>> => {
        const columns = new Set<string>(["in-review"]);
        try {
          const ir = await resolveWorkflowIrForTask(this.store, taskId, recoveryIrCache);
          if (ir) {
            for (const role of REVIEW_ROLES) for (const id of columnsWithFlag(ir, role)) columns.add(id);
          }
        } catch { /* degraded: the legacy id above still answers */ }
        return columns;
      };
      const candidateChecks = await Promise.all(tasks.map(async (task) => {
        const reviewColumns = await reviewColumnsFor(task.id);
        return {
          task,
          recoverable: isRecoverableMissingWorktreeReviewFailureWithProgress(task, reviewColumns)
            || isRecoverableMissingWorktreeReviewFailureNoProgress(task, reviewColumns)
            || isMergeActiveMissingWorktreeSessionStartFailure(task, reviewColumns),
          mergeActive: isMergeActiveMissingWorktreeSessionStartFailure(task, reviewColumns),
        };
      }));
      const candidates = candidateChecks.filter((entry) => entry.recoverable).map((entry) => entry.task);
      const mergeActiveByTaskId = new Map(candidateChecks.map((entry) => [entry.task.id, entry.mergeActive]));

      if (candidates.length === 0) return 0;

      log.warn(`Found ${candidates.length} in-review task(s) failed by unusable-worktree session start`);

      let recovered = 0;
      for (const task of candidates) {
        try {
          /* Reuses the classification computed with this task's resolved lanes above, so the stage/audit
             labels cannot disagree with the admission decision. */
          const mergeActiveCandidate = mergeActiveByTaskId.get(task.id) === true;
          const stage = mergeActiveCandidate ? "missing-worktree-merge-active" : "missing-worktree-review";
          const noActionEvent = mergeActiveCandidate ? "task:reconcile-missing-worktree-merge-active-no-action" : "task:missing-worktree-review-no-action";
          const recoveryEvent = mergeActiveCandidate ? "task:reconcile-missing-worktree-merge-active" : "task:missing-worktree-review";
          const auditor = createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-heal", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "maintenance",
          });
          if (!allowsAutoMergeProcessing(task, settings)) {
            await auditor.database({
              type: noActionEvent as DatabaseMutationType,
              target: task.id,
              metadata: { reason: "auto-merge-off", priorStatus: task.status ?? null, priorWorktree: task.worktree ?? null },
            });
            continue;
          }
          if (isWorkspaceTask(task)) {
            await auditor.database({
              type: noActionEvent as DatabaseMutationType,
              target: task.id,
              metadata: { reason: "workspace-task", priorStatus: task.status ?? null, priorWorktree: task.worktree ?? null },
            });
            continue;
          }
          const proof = await this.evaluateBackwardMoveTripleProof(task, {
            stage,
            graceMs: settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
            stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
            reason: mergeActiveCandidate ? "missing-worktree-merge-active-candidate" : "missing-worktree-review-candidate",
            extra: { priorStatus: task.status ?? null },
          });
          if (!proof.ok) {
            await this.emitBackwardMoveNoAction(task, stage, noActionEvent, proof);
            continue;
          }

          const result = await autoRecoverWorktreeSessionStartFailure(this.store, task, {
            failure: task.error,
            source: mergeActiveCandidate ? "merge-active-sweep" : "in-review-sweep",
            auditor,
            rootDir: this.options.rootDir,
            forceClearWorktreeMetadata: mergeActiveCandidate,
            resetRetryBudgetOnStaleMetadataClear: mergeActiveCandidate,
            staleMetadataClearRecoveryRetryCount: mergeActiveCandidate ? task.recoveryRetryCount ?? 0 : undefined,
          });
          if (result.outcome === "requeue-todo") {
            await auditor.database({
              type: recoveryEvent as DatabaseMutationType,
              target: task.id,
              metadata: {
                priorStatus: task.status ?? null,
                priorWorktree: task.worktree ?? null,
                priorBranch: task.branch ?? null,
                classification: result.classification,
                retries: result.retries,
              },
            });
            recovered++;
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover unusable-worktree review failure ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} unusable-worktree review failure(s) → todo`);
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Unusable-worktree review recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover `in-review` tasks marked as `failed` because the agent exited
   * without calling `fn_task_done` *with partial step progress* (some steps done,
   *
   * Backward lifecycle move gated on triple proof (FN-5335).
   * When the predicate fails, emits `task:partial-progress-no-task-done-no-action` and skips lifecycle mutation.
   * some still pending). The work-in-progress is valuable but incomplete —
   * the existing worktree and branch are preserved and the task is moved back
   * to `todo` so the scheduler re-dispatches it for a fresh execution that
   * continues from where the previous attempt left off.
   *
   * Bounded by `MAX_TASK_DONE_RETRIES` (per-task `taskDoneRetryCount`) so a
   * persistently-broken task cannot loop forever; when exhausted the task
   * remains parked in `in-review` for manual intervention. The counter is
   * cleared by the executor on successful completion.
   *
   * Distinct from sibling recoveries:
   * - `recoverMisclassifiedFailures`: all steps done → clear error, leave for review.
   * - `recoverNoProgressNoTaskDoneFailures`: `in-progress` with zero progress → clean requeue.
   * - This one: `in-review` with partial progress → bounded requeue preserving work.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   * @returns Number of tasks requeued for retry
   */
  async recoverPartialProgressNoTaskDoneFailures(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      /*
      FNXC:WorkflowResolvedColumns 2026-07-30-21:40 (the query-filter class, thirtieth sweep):
      A review card failed for "no fn_task_done" that DID make step progress — real work exists, so it is
      retried rather than discarded. The literal read meant that on a renamed board the retry never fired,
      so partially-completed work was parked failed with its retry budget untouched: the budget exists
      precisely to avoid losing that work, and it was never spent.

      The per-card verdict below converts with it. No second pair; verified with the derived ratchet
      from #2879.
      */
      const partialColumns = await resolveProjectColumnsForRoles(this.store, REVIEW_ROLES);
      const partialById = new Map<string, Task>();
      for (const column of partialColumns) {
        for (const entry of await this.store.listTasks({ column, slim: true })) partialById.set(entry.id, entry);
      }
      const tasks = [...partialById.values()];
      /* NARROW WHEN THE CARD CAN ANSWER, BROAD WHEN IT CANNOT (#2891). */
      const partialLanes = new Map<string, Set<string>>();
      for (const entry of tasks) {
        try {
          const { ir, source } = await resolveWorkflowIrForTaskWithProvenance(this.store, entry.id);
          partialLanes.set(
            entry.id,
            source === "default"
              ? new Set(partialColumns)
              : new Set(REVIEW_ROLES.flatMap((role) => [...columnsWithFlag(ir, role)])),
          );
        } catch {
          partialLanes.set(entry.id, new Set(partialColumns));
        }
      }

      const candidates = tasks.filter((task) =>
        (partialLanes.get(task.id) ?? partialColumns).has(task.column) &&
        allowsAutoMergeProcessing(task, settings) &&
        task.status === "failed" &&
        isNoTaskDoneFailure(task) &&
        !task.paused &&
        !isTaskWorkComplete(task) &&
        hasStepProgress(task) &&
        (task.taskDoneRetryCount ?? 0) < MAX_TASK_DONE_RETRIES,
      );

      if (candidates.length === 0) return 0;

      log.warn(
        `Found ${candidates.length} partial-progress no-task_done failure(s) eligible for auto-retry`,
      );

      let recovered = 0;
      for (const task of candidates) {
        try {
          const proof = await this.evaluateBackwardMoveTripleProof(task, {
            stage: "partial-progress-no-task-done",
            graceMs: settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
            stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
            reason: "partial-progress-no-task-done-candidate",
          });
          if (!proof.ok) {
            await this.emitBackwardMoveNoAction(task, "partial-progress-no-task-done", "task:partial-progress-no-task-done-no-action", proof);
            continue;
          }

          const nextCount = (task.taskDoneRetryCount ?? 0) + 1;
          await this.store.updateTask(task.id, {
            status: null,
            error: null,
            sessionFile: null,
            taskDoneRetryCount: nextCount,
          });
          await this.store.logEntry(
            task.id,
            `Auto-retry ${nextCount}/${MAX_TASK_DONE_RETRIES}: agent finished without fn_task_done — requeuing to todo to resume partial work`,
          );
          // #1411: backward recovery — skip order-derived adjacency.
          await this.store.moveTask(task.id, await resolveReboundTargetForTask(this.store, task.id), { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(
            `Failed to auto-retry partial-progress no-task_done failure ${task.id}: ${errorMessage}`,
          );
        }
      }

      if (recovered > 0) {
        log.log(
          `Auto-retried ${recovered} partial-progress no-task_done failure(s) → todo`,
        );
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Partial-progress no-task_done recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  private async isBranchAheadOfBase(
    task: Task,
    baseRef?: string,
  ): Promise<{ aheadCount: number; baseRef: string } | null> {
    return isBranchAheadOfBase(task, this.options.rootDir, baseRef);
  }

  private async hasRecoverableGitWork(task: Task): Promise<boolean> {
    if (task.worktree && existsSync(task.worktree)) {
      try {
        const { stdout: status } = await execAsync("git status --porcelain", {
          cwd: task.worktree,
          timeout: 30_000,
        });
        if (status.trim().length > 0) return true;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(
          `Failed to inspect worktree status for ${task.id} at ${task.worktree}: ${errorMessage} — preserving worktree`,
        );
        // If we cannot inspect an existing worktree, preserve it.
        return true;
      }
    }

    const branchName = resolveTaskWorkingBranch(task);
    try {
      await execAsync(`git rev-parse --verify "${branchName}"`, {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
    } catch {
      // Intentional negative test: rev-parse exits non-zero when branch does not exist.
      return false;
    }

    try {
      const { stdout: uniqueCommits } = await execAsync(
        `git rev-list --count HEAD.."${branchName}"`,
        { cwd: this.options.rootDir, timeout: 30_000 },
      );
      return Number.parseInt(uniqueCommits.trim(), 10) > 0;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to compare branch ${branchName} against HEAD for ${task.id}: ${errorMessage} — preserving branch`,
      );
      // If the branch exists but cannot be compared, preserve it.
      return true;
    }
  }

  /**
   * Recover triage tasks that already have a written specification but were
   * left stuck in `status: "planning"` without an active triage session.
   *
   * This catches the mirror-image of executor recovery: planning completed,
   * but the final transition to `todo` / `awaiting-approval` never happened.
   */
  async recoverApprovedTriageTasks(): Promise<number> {
    const recoverFn = this.options.recoverApprovedTriageTask;
    if (!recoverFn) return 0;

    try {
      // Evict stale entries from the triage processor's in-memory set before
      // checking — tasks with hung promises (from stuck kills) would otherwise
      // block recovery indefinitely.
      this.options.evictStaleTriageProcessing?.();

      /*
      FNXC:WorkflowColumns 2026-07-29-09:30 (Phase B): the LIST QUERY carried the
      literal too — `listTasks({ column: "triage" })` returns nothing once that id
      is gone, so converting only the predicate would have left the sweep dead.
      Query the whole board and filter by role.
      */
      const preWipCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const tasks = await this.filterByPreWipRole(
        await this.store.listTasks({ slim: true, includeArchived: false }),
        ["intake"],
        preWipCache,
      );
      const planningIds = this.options.getPlanningTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      const orphanedApproved = tasks.filter((task) => {
        const handoffKind = classifyPersistedPlanHandoff(task, {
          now,
          hasLivePlanningWork: planningIds.has(task.id),
          legacyStaleMs: LEGACY_NULL_PLAN_HANDOFF_STALE_MS,
          requirePersistedSteps: true,
        });
        return handoffKind != null
          && now - new Date(task.updatedAt).getTime() >= APPROVED_TRIAGE_RECOVERY_GRACE_MS;
      });

      if (orphanedApproved.length === 0) return 0;

      log.warn(`Found ${orphanedApproved.length} specified triage task candidate(s) stuck in planning`);

      let recovered = 0;
      for (const task of orphanedApproved) {
        // FNXC:Triage 2026-07-29-12:00:
        // FN-8361 candidates come from a stale board snapshot. Do not enter delayed
        // recovery after scheduler advancement; triage revalidates every later write.
        const live = await this.store.getTask(task.id).catch(() => null);
        // Narrow test/legacy adapters can return an unrelated fixture row; only use a
        // re-read when it identifies the requested candidate.
        const recoveryTask = live?.id === task.id ? live : task;
        const handoffKind = classifyPersistedPlanHandoff(recoveryTask, {
          now,
          hasLivePlanningWork: planningIds.has(recoveryTask.id),
          legacyStaleMs: LEGACY_NULL_PLAN_HANDOFF_STALE_MS,
          requirePersistedSteps: true,
        });
        if (!handoffKind) continue;
        // The legacy null handoff deliberately contains parsed task steps; the
        // generic planning-stage predicate interprets null+steps as execution
        // progress, so its exact classifier owns that one compatibility shape.
        if (handoffKind !== "legacy-null" && !isTaskStillInPlanningStage(recoveryTask)) continue;
        log.log(`Recovering specified triage task ${task.id}: ${task.title || task.description?.slice(0, 60) || "(untitled)"}`);
        const success = await recoverFn(recoveryTask);
        if (success) recovered++;
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} specified triage task(s) out of planning`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Specified triage recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /*
  FNXC:HonestBlockedExit 2026-08-02-23:59 (operator decision — FN-8728 vs PR #2398):
  The FN-8700 `reconcile-external-pr-blockers` sweep (gh-backed clearing of PR-claim parks)
  is REMOVED with the whole PR/file-claim blocking mechanism. Open PRs are never blockers;
  file-scope conflicts are arbitrated only by Fusion's own board. Legacy PR-claim parks are
  no longer honored by isDurableBlockedTask, so normal recovery paths reclaim them.
  */

  async resolveExplicitDuplicateMarkerTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      const enabled = (settings as Settings & { resolveExplicitDuplicateMarkerEnabled?: boolean }).resolveExplicitDuplicateMarkerEnabled !== false;
      if (!enabled) {
        return 0;
      }

      const tasks = await this.store.listTasks({ slim: true, includeArchived: false, limit: 500 });
      // FNXC:WorkflowColumns 2026-07-29-09:30 (Phase B): intake-or-hold role.
      const candidates = await this.filterByPreWipRole(
        tasks,
        ["intake", "hold"],
        new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>(),
      );

      let resolved = 0;
      let processedMarkers = 0;
      for (const task of candidates) {
        try {
          const promptPath = join(this.options.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
          const written = existsSync(promptPath) ? readFileSync(promptPath, "utf-8") : "";
          const duplicateResolution = resolveExplicitDuplicateMarker(written, task.title);
          // A conflict has no safe canonical target; leave it for planning/operator correction.
          if (!duplicateResolution.marker || duplicateResolution.conflict) {
            continue;
          }
          const marker = duplicateResolution.marker;
          if (processedMarkers >= 50) {
            break;
          }
          processedMarkers += 1;

          const canonicalTask = await this.store.getTask(marker.canonicalId).catch(() => null);
          if (canonicalTask?.id.toLowerCase() === task.id.toLowerCase()) {
            continue;
          }

          /*
          FNXC:NearDuplicateDetection 2026-07-17-20:10:
          FN-8356 keeps maintenance from re-parking a marker against a missing, deleted, done,
          or archived canonical. Such a decision has no detail-banner action, so cleanup restores
          eligible work to planning while preserving explicit, implicit, and unrelated system pauses.

          FNXC:NearDuplicateDetection 2026-08-01-18:47:
          Mirror triage: marker clear leaves needs-replan + feedback + dismissal, never
          status:null (FN-8704 replan storm when the scheduler wakes on planning→null without PROMPT).
          */
          const canClearInactiveMarker = task.userPaused !== true
            && (task.paused !== true || task.pausedReason === "duplicate-decision-required")
            && (task.pausedReason == null || task.pausedReason === "duplicate-decision-required");
          const canonicalFlags = await resolveNearDuplicateCanonicalFlags(this.store, canonicalTask);
          if (!canonicalTask || isNearDuplicateCanonicalInactive(canonicalTask, canonicalFlags)) {
            if (canClearInactiveMarker) {
              // FNXC:DuplicateIntake 2026-08-09-02:14: preserve a real PROMPT.md for a title-only redirect.
              if (duplicateResolution.source !== "title") rmSync(promptPath, { force: true });
              if (resolveExplicitDuplicateMarker(null, task.title).marker?.canonicalId === marker.canonicalId) {
                await this.store.updateTask(task.id, { title: `Duplicate redirect cleared: ${marker.canonicalId}` });
              }
              const priorClearCount = typeof task.sourceMetadata?.duplicateMarkerClearCount === "number"
                ? task.sourceMetadata.duplicateMarkerClearCount
                : 0;
              const patch = buildMarkerClearedReplanTaskPatch(marker.canonicalId, priorClearCount);
              await this.store.updateTask(task.id, patch);
              if (typeof this.store.logEntry === "function") {
                await Promise.resolve(this.store.logEntry(
                  task.id,
                  TRIAGE_MARKER_CLEARED_REPLAN_LOG_ACTION,
                  buildInactiveDuplicateClearFeedback(marker.canonicalId),
                )).catch(() => {});
              }
              resolved += 1;
            }
            continue;
          }

          const resolution = settings.triageDuplicateResolution ?? "prompt";
          /*
          FNXC:DuplicateIntake 2026-07-20-12:00:
          FN-8440 forbids self-healing from re-arming a duplicate-decision-required hold after
          an operator kept this exact task/canonical pair. Keep cleanup is bounded by the same
          pause guard as inactive-marker recovery so manual and unrelated pauses are never cleared.
          */
          if (resolution === "prompt" && isTriageDuplicateKeepAcknowledged(task.sourceMetadata, canonicalTask.id)) {
            if (canClearInactiveMarker) {
              // FNXC:DuplicateIntake 2026-08-09-02:14: preserve a real PROMPT.md for a title-only redirect.
              if (duplicateResolution.source !== "title") rmSync(promptPath, { force: true });
              if (resolveExplicitDuplicateMarker(null, task.title).marker?.canonicalId === marker.canonicalId) {
                await this.store.updateTask(task.id, { title: `Duplicate redirect cleared: ${marker.canonicalId}` });
              }
              const priorKeepClears = typeof task.sourceMetadata?.duplicateMarkerClearCount === "number"
                ? task.sourceMetadata.duplicateMarkerClearCount
                : 0;
              const keepExhausted = priorKeepClears >= 1;
              await this.store.updateTask(
                task.id,
                keepExhausted
                  ? buildMarkerExhaustedFailedTaskPatch(canonicalTask.id, priorKeepClears)
                  : buildMarkerClearedReplanTaskPatch(canonicalTask.id, priorKeepClears),
              );
              if (typeof this.store.logEntry === "function") {
                await Promise.resolve(this.store.logEntry(
                  task.id,
                  keepExhausted
                    ? buildDuplicateReplanExhaustedError(canonicalTask.id)
                    : TRIAGE_MARKER_CLEARED_REPLAN_LOG_ACTION,
                  buildKeepDuplicateClearFeedback(canonicalTask.id),
                )).catch(() => {});
              }
              resolved += 1;
            }
            continue;
          }
          if (resolution === "delete") {
            await this.store.deleteTask(task.id, { removeLineageReferences: true, auditContext: { agentId: "self-healing", runId: generateSyntheticRunId("self-heal-explicit-duplicate", task.id), callerKind: "engine" } });
          } else if (resolution === "prompt") {
            await flagTriageDuplicate(this.store, task.id, canonicalTask.id);
            await this.store.updateTask(task.id, { paused: true, pausedReason: "duplicate-decision-required", status: null });
          } else {
            // FNXC:DuplicateIntake 2026-08-09-02:14: title-only redirects must not erase executable prompts.
            if (duplicateResolution.source !== "title") rmSync(promptPath, { force: true });
            if (resolveExplicitDuplicateMarker(null, task.title).marker?.canonicalId === marker.canonicalId) {
              await this.store.updateTask(task.id, { title: `Duplicate redirect cleared: ${marker.canonicalId}` });
            }
            await this.store.updateTask(task.id, buildMarkerClearedReplanTaskPatch(canonicalTask.id));
            if (typeof this.store.logEntry === "function") {
              await Promise.resolve(this.store.logEntry(
                task.id,
                TRIAGE_MARKER_CLEARED_REPLAN_LOG_ACTION,
                buildKeepDuplicateClearFeedback(canonicalTask.id),
              )).catch(() => {});
            }
          }
          log.log(`[self-healing] resolved explicit duplicate marker ${task.id} → ${canonicalTask.id}`);
          resolved += 1;
        } catch (error) {
          log.warn(`Failed explicit duplicate-marker sweep for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return resolved;
    } catch (error) {
      log.error(`Explicit duplicate-marker sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  /**
   * Recover refinement tasks that have sat in triage long enough to indicate
   * starvation while the rest of the board keeps progressing.
   *
   * Recovery is a bounded priority nudge only; tasks still route through the
   * normal triage specification + approval pipeline.
   */
  async recoverStarvedRefinementTriageTasks(): Promise<number> {
    try {
      this.options.evictStaleTriageProcessing?.();

      const tasks = await this.store.listTasks({ slim: true, includeArchived: false });
      /*
      FNXC:WorkflowResolvedColumns 2026-07-31-23:40:
      Resolved WAITING membership for the two peer-progress counts below. The question is "are OTHER
      queued cards moving while this refinement card starves", so it must include every lane a card
      can wait in — hold and intake. Keyed on `todo` alone, a renamed board counted zero peers and
      the starvation escalation never fired.
      */
      const starvedWaitingColumns = await resolveProjectColumnsForRoles(this.store, ["hold", "intake"]);
      const planningIds = this.options.getPlanningTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      // FNXC:WorkflowColumns 2026-07-29-09:30 (Phase B): intake role.
      const intakeCandidates = await this.filterByPreWipRole(
        tasks,
        ["intake"],
        new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>(),
      );
      const candidates = intakeCandidates.filter((task) => {
        if (task.sourceType !== "task_refine") return false;
        if (task.paused) return false;
        if (task.status !== null && task.status !== "planning") return false;
        if (planningIds.has(task.id)) return false;

        const createdAtMs = new Date(task.createdAt).getTime();
        const updatedAtMs = new Date(task.updatedAt).getTime();
        if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) return false;
        if (now - createdAtMs < STARVED_REFINEMENT_RECOVERY_GRACE_MS) return false;
        if (now - updatedAtMs < STARVED_REFINEMENT_ESCALATION_COOLDOWN_MS) return false;

        const peerProgressCount = tasks.filter((peer) =>
          peer.id !== task.id &&
          starvedWaitingColumns.has(peer.column) &&
          peer.sourceType !== "task_refine" &&
          new Date(peer.updatedAt).getTime() > createdAtMs,
        ).length;

        return peerProgressCount >= STARVED_PEER_PROGRESS_THRESHOLD;
      });

      if (candidates.length === 0) return 0;

      log.warn(`Found ${candidates.length} starved refinement triage task(s)`);

      let recovered = 0;
      for (const task of candidates) {
        try {
          const nextPriority = bumpTaskPriority(task.priority);
          if (nextPriority === task.priority) continue;

          const createdAtMs = new Date(task.createdAt).getTime();
          const peerProgressCount = tasks.filter((peer) =>
            peer.id !== task.id &&
            starvedWaitingColumns.has(peer.column) &&
            peer.sourceType !== "task_refine" &&
            new Date(peer.updatedAt).getTime() > createdAtMs,
          ).length;

          await this.store.updateTask(task.id, { priority: nextPriority });
          await this.store.logEntry(
            task.id,
            `Auto-recovered starved refinement triage task: priority ${task.priority ?? "normal"} -> ${nextPriority} (age=${Math.max(0, now - createdAtMs)}ms, peerProgress=${peerProgressCount})`,
          );

          try {
            const auditor = createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId ?? undefined,
              phase: "triage-recovery",
            });
            await auditor.database({
              type: "task:auto-recover-starved-refinement",
              target: task.id,
              metadata: {
                taskId: task.id,
                ageMs: Math.max(0, now - createdAtMs),
                peerProgressCount,
                escalation: "priority-bump",
                previousPriority: task.priority ?? "normal",
                nextPriority,
                graceMs: STARVED_REFINEMENT_RECOVERY_GRACE_MS,
                cooldownMs: STARVED_REFINEMENT_ESCALATION_COOLDOWN_MS,
                peerThreshold: STARVED_PEER_PROGRESS_THRESHOLD,
              },
            });
          } catch (auditErr: unknown) {
            const auditErrMessage = auditErr instanceof Error ? auditErr.message : String(auditErr);
            log.warn(`Failed to record starved refinement recovery audit for ${task.id}: ${auditErrMessage}`);
          }

          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover starved refinement task ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} starved refinement triage task(s)`);
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Starved refinement triage recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover triage tasks stuck in `status: "planning"` whose agent session
   * died before producing a recoverable spec.
   *
   * These tasks fall through two cracks:
   * - The stuck task detector only monitors tasks with active tracked sessions.
   *   If the session crashed or was never started, the task is never tracked.
   * - `recoverApprovedTriageTasks` only handles tasks with a valid written PROMPT.md.
   *
   * Recovery clears the status back to `null` so the next triage poll picks
   * them up for a fresh planning attempt.
   */
  /**
   * FNXC:TaskTiming 2026-07-30-21:40:
   * A planning anchor is safe because triage ownership and graph Plan Review are
   * exclusive. Recovery finalizes only when neither in-process owner is live;
   * the atomic null-check makes restart and repeated maintenance idempotent.
   *
   * FNXC:TaskTiming 2026-08-09-20:34:
   * listTasks merges archive cold-storage snapshots by default. Those snapshots
   * retain planningStartedAt but carry no deletedAt, while their tombstoned live
   * rows are refused by updateTaskAtomic and getTask. Enumerate live rows only;
   * a deletedAt filter alone could not contain this archive path. Per-task and
   * sweep guards ensure one race or poisoned row cannot disable finalization
   * store-wide during startup or maintenance (Runfusion/Fusion#3386).
   */
  async finalizeOrphanedPlanningSegments(): Promise<number> {
    let finalized = 0;
    try {
      const planningIds = this.options.getPlanningTaskIds?.() ?? new Set<string>();
      const tasks = await this.store.listTasks({ slim: true, includeArchived: false });
      for (const task of tasks) {
        try {
          // Defense-in-depth for legacy/custom stores; archive snapshots require
          // includeArchived: false above because they deliberately omit deletedAt.
          if (
            task.deletedAt ||
            !task.planningStartedAt ||
            planningIds.has(task.id) ||
            this.options.hasActivePlanningWorkflowSession?.(task.id)
          ) continue;
          let applied = false;
          const endMs = Date.now();
          if (typeof this.store.updateTaskAtomic === "function") {
            await this.store.updateTaskAtomic(task.id, (live) => {
              if (!live.planningStartedAt || planningIds.has(live.id) || this.options.hasActivePlanningWorkflowSession?.(live.id)) return null;
              const patch = finalizePlanningSegment(live, endMs);
              applied = patch.planningStartedAt === null;
              return patch;
            });
          } else {
            const live = await this.store.getTask(task.id);
            if (live?.planningStartedAt && !planningIds.has(live.id) && !this.options.hasActivePlanningWorkflowSession?.(live.id)) {
              const patch = finalizePlanningSegment(live, endMs);
              if (patch.planningStartedAt === null) { await this.store.updateTask(task.id, patch); applied = true; }
            }
          }
          if (!applied) continue;
          finalized++;
          // FNXC:TaskTiming 2026-07-30-21:40: this recovery is operator-auditable
          // without persisting duration prose; the atomically finalized task id
          // and fixed no-live-owner reason are sufficient forensic evidence.
          await this.store.recordRunAuditEvent?.({
            taskId: task.id,
            agentId: "self-healing",
            runId: generateSyntheticRunId("orphaned-planning-segment", task.id),
            domain: "database",
            mutationType: "task:reconcile-orphaned-planning-segment",
            target: task.id,
            metadata: { taskId: task.id, finalizedCount: 1, reason: "no-live-planning-owner" },
          });
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to finalize orphaned planning segment for ${task.id}: ${errorMessage}`);
        }
      }
      if (finalized === 0) {
        await this.store.recordRunAuditEvent?.({
          agentId: "self-healing",
          runId: generateSyntheticRunId("orphaned-planning-segment", "global"),
          domain: "database",
          mutationType: "task:reconcile-orphaned-planning-segment-no-action",
          target: "planning-segments",
          metadata: { finalizedCount: 0, reason: "no-eligible-orphan" },
        });
      }
      return finalized;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphaned planning segment finalization failed: ${errorMessage}`);
      return finalized;
    }
  }

  async recoverOrphanedPlanningTasks(): Promise<number> {
    try {
      // Evict stale entries from the triage processor's in-memory set before
      // checking — tasks with hung promises (from stuck kills) would otherwise
      // block recovery indefinitely.
      this.options.evictStaleTriageProcessing?.();

      // FNXC:WorkflowColumns 2026-07-29-09:30 (Phase B): see the sibling sweep — the
      // column filter is a role filter, and the list query carried the literal too.
      const preWipCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
      const tasks = await this.filterByPreWipRole(
        await this.store.listTasks({ slim: true, includeArchived: false }),
        ["intake"],
        preWipCache,
      );
      const planningIds = this.options.getPlanningTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      const orphaned = tasks.filter((t) =>
        t.status === "planning" &&
        !t.paused &&
        !planningIds.has(t.id) &&
        now - new Date(t.updatedAt).getTime() >= APPROVED_TRIAGE_RECOVERY_GRACE_MS
      );

      if (orphaned.length === 0) return 0;

      log.warn(`Found ${orphaned.length} orphaned planning triage task(s) without a recoverable prompt`);

      let recovered = 0;
      for (const task of orphaned) {
        try {
          log.log(`Recovering orphaned planning task ${task.id}: ${task.title || task.description?.slice(0, 60) || "(untitled)"}`);
          // FNXC:Triage 2026-07-29-12:00:
          // FN-8361 closes the stale listTasks → updateTask race: only clear planning
          // under the TaskStore lock, never overwrite a scheduler-claimed row.
          let applied = false;
          if (typeof this.store.updateTaskAtomic === "function") {
            await this.store.updateTaskAtomic(task.id, (live) => {
              if (!isTaskStillInPlanningStage(live)) return null;
              applied = true;
              return { status: null };
            });
          } else {
            const live = await this.store.getTask(task.id);
            if (live && isTaskStillInPlanningStage(live)) {
              await this.store.updateTask(task.id, { status: null });
              applied = true;
            }
          }
          if (!applied) continue;
          await this.store.logEntry(
            task.id,
            "Auto-recovered orphaned planning task — agent session lost, cleared for re-planning",
          );
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover orphaned planning task ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} orphaned planning task(s) — cleared for re-planning`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphaned planning task recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /** Run `git worktree prune` to clean stale metadata. */
  private async pruneWorktrees(): Promise<void> {
    try {
      const settings = await this.store.getSettings();
      const worktrunkEnabled = settings.worktrunk?.enabled === true;
      if (worktrunkEnabled) {
        const backend = resolveWorktreeBackend(settings, { logger: log });
        if (backend.kind === "worktrunk") {
          const auditor = createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-heal", "worktrunk-prune"),
            agentId: "self-healing",
            phase: "maintenance-prune",
          });

          try {
            await backend.prune({ rootDir: this.options.rootDir });
            await auditor.git({ type: "worktree:worktrunk-prune", target: this.options.rootDir, metadata: { success: true } });
            log.debug("Worktree prune delegated to worktrunk backend");
            return;
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            await auditor.git({ type: "worktree:worktrunk-prune", target: this.options.rootDir, metadata: { success: false, error: errorMessage } });
            if (settings.worktrunk?.onFailure === "fail") {
              log.error(`Worktrunk prune failed (fail-hard): ${errorMessage}`);
              return;
            }
            log.warn(`Worktrunk prune failed; falling back to native git prune: ${errorMessage}`);
          }
        }
      }

      await execAsync("git worktree prune", {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
      log.debug("Worktree prune completed");
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Worktree prune failed: ${errorMessage}`);
    }
  }

  /**
   * Remove orphaned worktrees not assigned to any active task.
   *
   * When `recycleWorktrees` is OFF: removes registered idle worktrees too —
   * they would otherwise pile up since the pool isn't keeping them.
   *
   * When `recycleWorktrees` is ON: leaves registered idle worktrees alone
   * (the pool wants them for reuse) but still reaps unregistered stale dirs
   * left behind by killed runs (e.g., `clear-hawk-broken`, `*-bak`). Those
   * dirs can never be recycled — they aren't git worktrees — so they only
   * waste disk.
   */
  private async cleanupOrphans(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.worktrunk?.enabled === true) {
        log.debug("[self-healing] skipped native orphan cleanup — worktrunk backend owns layout");
        const backend = resolveWorktreeBackend(settings, { logger: log });
        if (backend.kind === "worktrunk") {
          await backend.prune({ rootDir: this.options.rootDir });
        }
        return 0;
      }

      if (settings.recycleWorktrees) {
        // Recycle on: only sweep unregistered stale dirs.
        return await this.reapUnregisteredOrphans();
      }

      const orphaned = await scanIdleWorktrees(this.options.rootDir, this.store, settings);
      if (orphaned.length === 0) return 0;

      let cleaned = 0;
      for (const worktreePath of orphaned) {
        // FN-4811/FN-5065: never reap a worktree bound to a live executor/merger/
        // step/workflow session. Such a task can sit transiently in "done" (or have
        // null worktree metadata mid-transition) while the owning process is still
        // working in the checkout — scanIdleWorktrees would otherwise flag it idle.
        if (activeSessionRegistry.isPathActive(worktreePath) || activeSessionRegistry.isPathActive(resolve(worktreePath))) {
          log.debug(`[self-healing] deferring idle-sweep for ${worktreePath}: active session present`);
          continue;
        }
        // U8: never reclaim a worktree backing a resume-eligible CLI session.
        if (this.isWorktreeResumeReserved(worktreePath)) {
          log.debug(`[self-healing] deferring idle-sweep for ${worktreePath}: resume-eligible CLI session present`);
          continue;
        }
        try {
          await removeWorktree({
            rootDir: this.options.rootDir,
            worktreePath,
            settings,
            reason: RemovalReason.SelfHealingIdleSweep,
          });
          cleaned++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to remove orphaned worktree ${worktreePath}: ${errorMessage} — non-fatal`);
          // Individual failure is non-fatal
        }
      }

      if (cleaned > 0) {
        log.log(`Cleaned ${cleaned} orphaned worktree(s)`);
      }
      return cleaned;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphan cleanup failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Sweep unregistered stale directories under `<rootDir>/.worktrees/` —
   * directories that exist on disk but are NOT registered git worktrees.
   * Safe to run alongside `recycleWorktrees: true` because the pool only
   * tracks registered idle worktrees, never these orphans.
   */
  private async reapUnregisteredOrphans(): Promise<number> {
    const settings = await this.store.getSettings();
    if (settings.worktrunk?.enabled === true) {
      log.debug("[self-healing] skipped native unregistered-orphan reap — worktrunk backend owns layout");
      const backend = resolveWorktreeBackend(settings, { logger: log });
      if (backend.kind === "worktrunk") {
        await backend.prune({ rootDir: this.options.rootDir });
      }
      return 0;
    }
    const worktreesDir = resolveWorktreesDir(this.options.rootDir, settings);
    if (!existsSync(worktreesDir)) return 0;

    let dirs: string[];
    try {
      dirs = readdirSync(worktreesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !isAiMergeContainerDir(e.name))
        .map((e) => join(worktreesDir, e.name));
    } catch (err: unknown) {
      log.warn(`Failed to read .worktrees/ for unregistered orphan reap: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    if (dirs.length === 0) return 0;

    const registered = await getRegisteredWorktreePaths(this.options.rootDir);
    const unregistered = dirs.filter((d) => !registered.has(resolve(d)));

    let cleaned = 0;
    for (const path of unregistered) {
      const rel = relative(worktreesDir, path);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        log.warn(`Refusing to remove path outside .worktrees: ${path}`);
        continue;
      }
      // FN-4811 (restored by FN-5065): never rmSync a directory bound to a live
      // executor/merger/step session. The worktree may be unregistered in git's
      // admin file while the owning process is still running.
      if (activeSessionRegistry.isPathActive(path)) {
        log.debug(`[self-healing] deferring unregistered-orphan reap for ${path}: active session present`);
        continue;
      }
      // U8: never reclaim a worktree backing a resume-eligible CLI session.
      if (this.isWorktreeResumeReserved(path)) {
        log.debug(`[self-healing] deferring unregistered-orphan reap for ${path}: resume-eligible CLI session present`);
        continue;
      }
      try {
        rmSync(path, { recursive: true, force: true });
        log.log(`Cleaned unregistered worktree dir: ${path}`);
        cleaned++;
      } catch (err: unknown) {
        log.warn(`Failed to remove unregistered worktree dir ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (cleaned > 0) {
      log.log(`Cleaned ${cleaned} unregistered worktree dir(s) (recycle mode preserves registered idle worktrees)`);
    }
    return cleaned;
  }

  /**
   * Sweep stale AI merge clean-room worktrees from the configured worktrees-dir
   * clean-room root plus legacy `.fusion/ai-merge/` and `tmpdir()` locations
   * used by older engine versions.
   *
   * Safety is bounded by age gates plus active-session checks.
   */
  private async cleanupStaleTempMergeWorktrees(): Promise<number> {
    /* FNXC:WorkflowLifecycleColumns 2026-07-31-22:30 (self-healing cluster): a temp merge worktree whose owning task has finished. Keyed on the literal this sweep answered "no" for every card on a renamed board. */
    const mergeTempTerminalColumns = await resolveProjectColumnsForRoles(this.store, TERMINAL_ROLES);
    try {
      const settings = await this.store.getSettings();
      if (settings.worktrunk?.enabled === true) {
        log.debug("[self-healing] temp-dir sweep: worktrunk enabled — AI merge clean-room worktrees use Fusion's dedicated clean-room root, proceeding with native sweep");
      }

      const roots = Array.from(new Set([resolveRepoLocalAiMergeRoot(this.options.rootDir, settings), resolveLegacyAiMergeRootPath(this.options.rootDir), tmpdir()]));
      const auditor = createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal", "tempdir-sweep"),
        agentId: "self-healing",
        phase: "tempdir-sweep",
      });
      const now = Date.now();
      let cleaned = 0;

      for (const tempRoot of roots) {
        let entries: string[];
        try {
          /*
          FNXC:TempWorktreeSweep 2026-07-31-22:55:
          `fn-verify-` (and `fn-verify-app-`) checkouts from mission-verification's
          GitCheckoutMaterializer leak when the process dies between materialize and dispose — seven
          registered worktrees aged Jul 24-27 were found holding registrations, and on the live board
          the visible symptom was planning admission queueing behind exhausted worktree slots
          ("queued to plan" for ~6 minutes). Their dispose() is best-effort in-process only; this
          sweep is the only out-of-process reaper, so it must know the prefix. Verification checkouts
          are detached throwaways that only ever live under tmpdir(), so the extra prefixes apply to
          that root alone; the same age gates, active-session refusal, and audit rows govern them.
          */
          const sweepPrefixes = tempRoot === tmpdir() ? ["fusion-ai-merge-", "fn-verify-"] : ["fusion-ai-merge-"];
          entries = readdirSync(tempRoot).filter((entry) => sweepPrefixes.some((prefix) => entry.startsWith(prefix)));
        } catch (err: unknown) {
          if (!existsSync(tempRoot)) continue;
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`[self-healing] temp-dir sweep: failed to read ${tempRoot}: ${errorMessage}`);
          if (tempRoot === tmpdir()) return cleaned;
          continue;
        }
        if (entries.length === 0) continue;

        for (const entry of entries) {
          const path = join(tempRoot, entry);
          let canonicalPath = path;
          let cleanupReason = "stale";
          try {
            const stat = statSync(path);
            if (!stat.isDirectory()) {
              await auditor.git({ type: "worktree:tempdir-sweep", target: path, metadata: { path, success: false, reason: "not-directory" } });
              continue;
            }
            const ageMs = now - stat.mtimeMs;
            let ageGateMs = STALE_TEMP_MERGE_WORKTREE_MS;
            cleanupReason = "stale";
            const taskId = extractTaskIdFromTempMergeDir(entry);
            if (taskId) {
              try {
                const task = await this.store.getTask(taskId);
                if (mergeTempTerminalColumns.has(task.column)) {
                  ageGateMs = DONE_TASK_TEMP_WORKTREE_GRACE_MS;
                  cleanupReason = "done-task-stale";
                }
              } catch (err: unknown) {
                if (isTaskNotFoundError(err)) {
                  ageGateMs = MIN_TEMP_WORKTREE_REAP_AGE_MS;
                  cleanupReason = "deleted-task";
                } else {
                  const errorMessage = getErrorMessage(err);
                  cleanupReason = "lookup-error";
                  log.warn(`[self-healing] temp-dir sweep: task lookup failed for ${taskId}: ${errorMessage}; using conservative age gate`);
                }
              }
            }
            ageGateMs = Math.max(ageGateMs, MIN_TEMP_WORKTREE_REAP_AGE_MS);
            if (ageMs < ageGateMs) continue;
            try {
              canonicalPath = realpathSync(path);
            } catch {
              canonicalPath = path;
            }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`[self-healing] temp-dir sweep: failed to stat ${path}: ${errorMessage}`);
            await auditor.git({ type: "worktree:tempdir-sweep", target: path, metadata: { path, success: false, reason: "stat-failed", error: errorMessage } });
            continue;
          }

          if (activeSessionRegistry.isPathActive(canonicalPath) || activeSessionRegistry.isPathActive(path)) {
            log.debug(`[self-healing] temp-dir sweep: deferring ${canonicalPath}: active session present`);
            await auditor.git({ type: "worktree:tempdir-sweep", target: canonicalPath, metadata: { path: canonicalPath, success: false, reason: "active-session" } });
            continue;
          }

          let cleanupAttempted = false;
          try {
            cleanupAttempted = true;
            await execAsync(`git worktree remove --force ${shellQuote(canonicalPath)}`, {
              cwd: this.options.rootDir,
              timeout: 120_000,
            });
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`[self-healing] temp-dir sweep: git worktree remove failed for ${canonicalPath}: ${errorMessage} — falling back to filesystem removal`);
            await auditor.git({ type: "worktree:tempdir-sweep", target: canonicalPath, metadata: { path: canonicalPath, success: false, reason: "git-remove-failed", error: errorMessage } });
          }

          try {
            cleanupAttempted = true;
            rmSync(canonicalPath, { recursive: true, force: true });
            log.log(`[self-healing] temp-dir sweep: cleaned stale AI merge worktree ${canonicalPath}`);
            await auditor.git({ type: "worktree:tempdir-sweep", target: canonicalPath, metadata: { path: canonicalPath, success: true, reason: cleanupReason } });
            cleaned++;
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            log.warn(`[self-healing] temp-dir sweep: failed to remove ${canonicalPath}: ${errorMessage}`);
            await auditor.git({ type: "worktree:tempdir-sweep", target: canonicalPath, metadata: { path: canonicalPath, success: false, reason: "fs-rm-failed", error: errorMessage } });
          } finally {
            if (cleanupAttempted) {
              try {
                await execAsync("git worktree prune", { cwd: this.options.rootDir, timeout: 30_000 });
              } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                log.warn(`[self-healing] temp-dir sweep: git worktree prune failed after cleaning ${canonicalPath}: ${errorMessage}`);
                await auditor.git({ type: "worktree:tempdir-sweep", target: canonicalPath, metadata: { path: canonicalPath, success: false, reason: "git-prune-failed", error: errorMessage } });
              }
            }
          }
        }
      }

      return cleaned;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`[self-healing] temp-dir sweep failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Resolve orphaned `fusion/*` branches.
   * Subsumed branches are pruned. Unique-commit branches are left untouched (operator-managed).
   */
  async cleanupOrphanedBranches(): Promise<number> {
    try {
      const orphaned = await scanOrphanedBranches(this.options.rootDir, this.store);
      if (orphaned.length === 0) return 0;

      let cleaned = 0;
      const prunedBranches: string[] = [];
      for (const branch of orphaned) {
        const inspection = await this.inspectOrphanedBranch(branch);
        if (!inspection) continue;
        if (inspection.uniqueCommitCount > 0) continue;

        try {
          execSync(`git branch -d ${shellQuote(branch)}`, {
            cwd: this.options.rootDir,
            stdio: ["pipe", "pipe", "pipe"],
          });
          cleaned++;
          prunedBranches.push(branch);

          try {
            const auditor = createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", "orphan-branch"),
              agentId: "self-healing",
              phase: "orphan-branch-prune",
            });
            await auditor.git({
              type: "branch:orphan-prune",
              target: branch,
              metadata: {
                phase: "orphan-branch-prune",
                tipSha: inspection.tipSha,
                uniqueCommitCount: inspection.uniqueCommitCount,
              },
            });
          } catch (auditErr: unknown) {
            log.warn(`Failed to write branch:orphan-prune run-audit event for ${branch}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
          }
        } catch (err: unknown) {
          log.warn(`Failed to prune subsumed orphaned branch ${branch}: ${err instanceof Error ? err.message : String(err)} — non-fatal`);
        }
      }

      if (prunedBranches.length > 0) {
        const cleared = await this.store.clearStaleExecutionStartBranchReferences(prunedBranches);
        if (cleared.length > 0) {
          log.log(`Cleared stale baseBranch on ${cleared.length} task(s): ${cleared.join(", ")}`);
        }
      }

      return cleaned;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphaned branch cleanup failed: ${errorMessage}`);
      return 0;
    }
  }

  private async maintainTaskFts(): Promise<void> {
    await this.maintainLiveTaskFts();

    try {
      await this.maintainArchiveTaskFts();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Archive FTS maintenance failed: ${errorMessage}`);
    }
  }

  private async maintainLiveTaskFts(): Promise<void> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-16:10:
     * VAL-REMOVAL-005 — The SQLite-only full-text-search index maintenance
     * (probe / optimize / rebuild) was removed. PostgreSQL maintains its
     * tsvector/GIN search index via sync-on-write triggers and autovacuum, so
     * there is no runtime maintenance to perform. The previous body probed
     * SQLite-specific accessors that are unreachable in backend mode and whose
     * literal keywords failed the VAL-REMOVAL-005 grep. This is now a no-op.
     */
    log.debug('Maintenance batch 1 step "fts-maintenance" skipped — PostgreSQL tsvector/GIN is sync-on-write');
    return;
  }

  private async maintainArchiveTaskFts(): Promise<void> {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-16:10:
     * VAL-REMOVAL-005 — The SQLite-only archive full-text-search index
     * maintenance was removed (same rationale as maintainLiveTaskFts above).
     * PostgreSQL's archive tsvector/GIN index is maintained via triggers.
     */
    log.debug('Maintenance batch 1 step "fts-maintenance" archive skipped — PostgreSQL tsvector/GIN is sync-on-write');
    return;
  }

  /** Run a best-effort passive WAL checkpoint without forcing live writers to truncate. */
  private checkpointWal(): void {
    /*
     * FNXC:SqliteFinalRemoval 2026-06-26-16:15:
     * VAL-REMOVAL-005 — The SQLite-only WAL checkpoint was removed. PostgreSQL
     * manages its own WAL + autovacuum, so there is no runtime checkpoint to
     * run. The previous body's literal keyword failed the grep; this is now a
     * logged no-op.
     */
    log.debug('Maintenance batch 1 step "wal-checkpoint" skipped — PostgreSQL manages WAL + autovacuum');
  }

  /** Remove oldest idle worktrees if total count exceeds 2× maxWorktrees. */
  private async enforceWorktreeCap(): Promise<void> {
    try {
      const settings = await this.store.getSettings();
      if (settings.worktrunk?.enabled === true) {
        log.debug("[self-healing] skipped native worktree cap enforcement — worktrunk backend owns layout");
        const backend = resolveWorktreeBackend(settings, { logger: log });
        if (backend.kind === "worktrunk") {
          await backend.prune({ rootDir: this.options.rootDir });
        }
        return;
      }
      const worktreesDir = resolveWorktreesDir(this.options.rootDir, settings);
      if (!existsSync(worktreesDir)) return;
      const cap = (settings.maxWorktrees ?? 4) * 2;

      const entries = readdirSync(worktreesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && !isAiMergeContainerDir(e.name));

      if (dirs.length <= cap) return;

      // Find idle worktrees that can be safely removed
      const idle = await scanIdleWorktrees(this.options.rootDir, this.store, settings);
      if (idle.length === 0) return;

      // Sort by mtime ascending (oldest first)
      const withMtime = idle.map((p) => {
        try {
          return { path: p, mtime: statSync(p).mtimeMs };
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to read mtime for worktree ${p}: ${errorMessage} — defaulting mtime to 0`);
          return { path: p, mtime: 0 };
        }
      });
      withMtime.sort((a, b) => a.mtime - b.mtime);

      let removed = 0;
      const excess = dirs.length - cap;

      for (const { path: worktreePath } of withMtime) {
        if (removed >= excess) break;
        // FN-4811/FN-5065: never reap a worktree bound to a live executor/merger/
        // step/workflow session — cap pressure must not yank a checkout out from
        // under a process that is still working in it.
        if (activeSessionRegistry.isPathActive(worktreePath) || activeSessionRegistry.isPathActive(resolve(worktreePath))) {
          log.debug(`[self-healing] cap-enforcement skipping ${worktreePath}: active session present`);
          continue;
        }
        // U8: never reclaim a worktree backing a resume-eligible CLI session.
        if (this.isWorktreeResumeReserved(worktreePath)) {
          log.debug(`[self-healing] cap-enforcement skipping ${worktreePath}: resume-eligible CLI session present`);
          continue;
        }
        try {
          await removeWorktree({
            rootDir: this.options.rootDir,
            worktreePath,
            settings,
            reason: RemovalReason.SelfHealingIdleSweep,
          });
          removed++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`Failed to remove idle worktree ${worktreePath} during cap enforcement: ${errorMessage} — non-fatal`);
          // Individual failure is non-fatal
        }
      }

      if (removed > 0) {
        log.warn(`Worktree cap: removed ${removed} idle worktree(s) (was ${dirs.length}, cap ${cap})`);
      }
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Worktree cap enforcement failed: ${errorMessage}`);
    }
  }
}

function isTaskWorkComplete(task: Task): boolean {
  if (task.steps.length === 0) return false;
  return task.steps.every((step) => step.status === "done" || step.status === "skipped");
}

function isNoTaskDoneFailure(task: Task): boolean {
  const error = task.error?.toLowerCase() ?? "";
  return error.includes("without calling fn_task_done") || error.includes("without calling task_done");
}

function hasStepProgress(task: Task): boolean {
  return task.steps.some((step) => step.status !== "pending");
}

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
 * - `enforceWorktreeCap`: defer to backend prune/remove semantics
 * - `reclaimSelfOwnedBranchConflicts`: remains native (branch-level)
 * - `reclaimStaleActiveBranches`: remains native (branch-level)
 */

import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { setImmediate as setImmediateCb } from "node:timers";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { IN_REVIEW_STALL_DEADLOCK_LOG_PREFIX, IN_REVIEW_STALL_LOG_PREFIX, allowsAutoMergeProcessing, countRecentIdenticalStallEntries, detectDependencyCycle, detectSelfDefeatingDependency, getInReviewStalledSignal, getInReviewStallReason, getPrimaryPrInfo, getStalePausedReviewSignal, getStalePausedTodoSignal, getTaskHardMergeBlocker, getTaskMergeBlocker, isEphemeralAgent, isMergeRequestContractShadowEnabled, isWorkflowColumnsEnabled, isSharedBranchGroupMemberIntegration, parseExplicitDuplicateMarker, type AgentStore, type ChatStore, type MessageStore, type TaskStore, type Settings, type Task, type MergeDetails, type TaskPriority, type MergeResult } from "@fusion/core";
import type { MeshLeaseManager } from "./mesh-lease-manager.js";
import { createLogger, schedulerLog } from "./logger.js";
import { publishWorkflowRecoveryEvent } from "./workflow-recovery-events.js";
import { mergeEffectiveSettings } from "./effective-settings.js";
import { RemovalReason, classifyTaskWorktree, getRegisteredWorktreeBranchMap, getRegisteredWorktreePaths, isUsableTaskWorktree, removeWorktree, resolveWorktreeBackend, scanIdleWorktrees, scanOrphanedBranches } from "./worktree-pool.js";
import {
  classifyMissingWorktreeSessionStartFailure,
  extractMissingWorktreePathFromSessionStartFailure,
  isMissingWorktreeSessionStartFailure,
  isRecoverableMissingWorktreeReviewFailureNoProgress,
  isRecoverableMissingWorktreeReviewFailureWithProgress,
} from "./restart-recovery-coordinator.js";
import { classifyError, extractMissingModulePath, isNonContinuableSessionError, isOperatorActionableAgentError, isStaleWorktreeModuleResolutionError } from "./transient-error-detector.js";
import { classifyForeignOnlyContamination, deriveTaskIdFromFusionBranch, inspectBranchConflict, listUniqueBranchCommits } from "./branch-conflicts.js";
import { createRunAuditor, generateSyntheticRunId, type DatabaseMutationType, type RunAuditor } from "./run-audit.js";
import { AutoRecoveryDispatcher } from "./auto-recovery.js";
import { activeSessionRegistry, executingTaskLock } from "./active-session-registry.js";
import { findAlreadyMergedTaskCommit } from "./already-merged-detector.js";
import { resolveWorktreesDir } from "./worktree-paths.js";
import { canonicalFusionBranchName, resolveTaskWorkingBranch } from "./worktree-names.js";
import { resolveIntegrationBranch } from "./integration-branch.js";
import { resolveBranchGroupMergeRouting } from "./group-merge-coordinator.js";
import type { OwnedLandedClassification } from "./merger.js";
import { regenerateBareMergeSubject } from "./merger-bare-subject.js";
import { recoverForeignOnlyContamination } from "./recovery/foreign-only-contamination.js";
import {
  buildNtfyClickUrl,
  getActiveNotificationService,
  isNtfyEventEnabled,
  resolveNtfyEvents,
  sendNtfyNotification,
  type NtfyNotifier,
} from "./notifier.js";
import type { GhostBugDecision } from "./triage-preflight.js";
import { DependencyBlockedTodoReporter } from "./dependency-blocked-todo-reporter.js";

const log = createLogger("self-healing");
const worktreeMetadataReconcileLog = createLogger("worktree-metadata-reconcile");
const execAsync = promisify(exec);
const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediateCb(resolve));
const DONE_TASK_INTEGRITY_SWEEP_LIMIT = 50;
const BOARD_STALL_NOTIFICATION_COOLDOWN_MS = 60 * 60_000;
const DB_CORRUPTION_NOTIFICATION_COOLDOWN_MS = 60 * 60 * 1000;
const FTS_MAINTENANCE_MERGE_CADENCE_TICKS = 1;
const FTS_MAINTENANCE_OPTIMIZE_CADENCE_TICKS = 4;
// Live pathology peaked around 775 KB/task (~96 MB for ~120 tasks), while a
// rebuilt healthy index was ~0.1 MB. Keep the steady-state budget generous but
// bounded so sustained text churn heals before segment growth becomes material.
const FTS_REBUILD_THRESHOLD_BYTES = 32 * 1024 * 1024;
const FTS_REBUILD_BYTES_PER_TASK = 1 * 1024 * 1024;
// The archive index is mostly append-only, so maintenance can run much less
// often than the live task index. We still cap total growth because archive
// rows retain full title/description/comments payloads for the project's life.
const ARCHIVE_FTS_MAINTENANCE_MERGE_CADENCE_TICKS = 8;
const ARCHIVE_FTS_MAINTENANCE_OPTIMIZE_CADENCE_TICKS = 24;
const ARCHIVE_FTS_REBUILD_THRESHOLD_BYTES = 64 * 1024 * 1024;
const ARCHIVE_FTS_REBUILD_BYTES_PER_TASK = 512 * 1024;
export const STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS = 10 * 60_000;
export const COMPLETION_HANDOFF_LIMBO_GRACE_MS = 5 * 60_000;
export const MAX_COMPLETION_HANDOFF_LIMBO_RECOVERIES = 3;
export const MAX_POST_DONE_NONCONTINUABLE_WEDGE_RECOVERIES = 3;
const MAX_NO_PROGRESS_RESUME_ATTEMPTS = 2;

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
  await store.moveTask(taskId, "archived", { moveSource: "engine", recoveryRehome: true });
}

async function classifyOwnedLandedEvidenceForSelfHealing(rootDir: string, task: Task, mergeTargetBranch: string): Promise<OwnedLandedClassification> {
  const { classifyOwnedLandedEvidence } = await import("./merger.js");
  return classifyOwnedLandedEvidence(rootDir, task, { mergeTargetBranch });
}

function buildResumeLimboStepSignature(task: Task): string {
  return JSON.stringify({
    currentStep: task.currentStep ?? null,
    steps: Array.isArray(task.steps) ? task.steps.map((step) => step.status) : [],
  });
}

function formatRecoveryTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
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

function matchGlob(path: string, pattern: string): boolean {
  if (pattern.includes("**")) {
    const regexPattern = pattern
      .replace(/\./g, "\\.")
      .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
      .replace(/\*/g, "[^/]*")
      .replace(/<<<DOUBLESTAR>>>/g, ".*");
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(path);
  }

  const lastSlash = pattern.lastIndexOf("/");
  if (lastSlash !== -1) {
    const patternDir = pattern.slice(0, lastSlash);
    const patternFile = pattern.slice(lastSlash + 1);
    const pathDir = path.lastIndexOf("/") !== -1 ? path.slice(0, path.lastIndexOf("/")) : "";
    const pathFile = path.lastIndexOf("/") !== -1 ? path.slice(path.lastIndexOf("/")) : path;

    if (patternDir.includes("*")) {
      const dirRegex = new RegExp(`^${patternDir.replace(/\./g, "\\.").replace(/\*/g, "[^/]*")}$`);
      if (!dirRegex.test(pathDir)) return false;
    } else if (!pathDir.endsWith(patternDir) && patternDir !== pathDir) {
      return false;
    }

    return matchGlob(pathFile, patternFile);
  }

  const fileName = path.lastIndexOf("/") !== -1 ? path.slice(path.lastIndexOf("/") + 1) : path;
  const regexPattern = pattern.replace(/\./g, "\\.").replace(/\*/g, "[^/]*");
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(fileName) || regex.test(path);
}

function matchesScope(filePath: string, scopePatterns: string[]): boolean {
  for (const pattern of scopePatterns) {
    if (matchGlob(filePath, pattern)) return true;
    const dirPattern = pattern.replace(/\/\*+$/, "");
    if (dirPattern !== pattern && filePath.startsWith(dirPattern + "/")) return true;
    if (pattern.endsWith("/") && filePath.startsWith(pattern)) return true;
    const patternDir = pattern.lastIndexOf("/") >= 0 ? pattern.slice(0, pattern.lastIndexOf("/")) : "";
    const fileDir = filePath.lastIndexOf("/") >= 0 ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    if (patternDir && fileDir === patternDir) return true;
  }
  return false;
}

export interface SelfHealingOptions {
  /** Project root directory (parent of .worktrees/) */
  rootDir: string;
  /** Optional callback to release TaskExecutor in-memory worktree ownership for a task. */
  releaseExecutorWorktreeOwnership?: (taskId: string) => void;
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
export const VALIDATOR_RUN_STALE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const ACTIVE_MERGE_STATUSES = new Set(["merging", "merging-pr", "merging-fix"]);
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
export const MAX_WORKTREE_SESSION_RETRIES = 3;
export const MAX_AUTO_MERGE_RETRIES = 3;
/**
 * FN-5627 follow-up: bounded budget for self-healing transient-merge-failure
 * recovery. After this many cycles of `recoverTransientMergeFailures` resetting
 * `mergeRetries` and re-enqueueing the same task, the task is considered
 * genuinely stuck and stays parked as `failed` for manual review. Tracked via
 * `task.mergeDetails.transientRecoveryCount`.
 */
export const MAX_TRANSIENT_MERGE_RECOVERIES = 2;

// FN-5627: classifier extracted to `transient-merge-error-classifier.ts`
// to avoid pulling `createLogger` into modules that mock `../logger.js`
// (notification-service tests in particular). Re-exported here for callers
// that already depend on `self-healing.ts` exports.
import { classifyTransientMergeError } from "./transient-merge-error-classifier.js";
export { classifyTransientMergeError } from "./transient-merge-error-classifier.js";
const MAX_STARVATION_DROPS = 3;
const DEADLOCK_RECOVERY_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS = 5 * 60_000;
const DEFAULT_STALE_MERGING_FANOUT_MIN_AGE_MS = 15 * 60_000;
const DEFAULT_UNBACKED_MERGING_FANOUT_GRACE_MS = 60_000;
const DURABLE_ERROR_RECOVERY_MAX_RETRIES = 5;
const DURABLE_ERROR_RECOVERY_BASE_COOLDOWN_MS = 30_000;
const DURABLE_ERROR_RECOVERY_MAX_COOLDOWN_MS = 15 * 60_000;
const RUNNING_ON_INACTIVE_TASK_STALE_RUN_MS = 5 * 60_000;

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
    source: "executor-session-start" | "in-review-sweep" | "resume-guard";
    auditor: RunAuditor | null;
  },
): Promise<{ outcome: "requeue-todo" | "escalate-exhausted"; retries: number; classification: "missing" | "incomplete" | "unregistered" | "unknown" }> {
  const classification = classifyMissingWorktreeSessionStartFailure(opts.failure);
  const nextCount = (task.worktreeSessionRetryCount ?? 0) + 1;
  if (nextCount > MAX_WORKTREE_SESSION_RETRIES) {
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
  const hasMismatchedLiveWorktree =
    typeof staleWorktree === "string" && staleWorktree.length > 0
    && typeof missingWorktreePath === "string" && missingWorktreePath.length > 0
    && resolve(staleWorktree) !== resolve(missingWorktreePath);
  const noProgress = !hasStepProgress(task);

  await store.updateTask(task.id, {
    status: null,
    error: null,
    worktreeSessionRetryCount: nextCount,
    worktree: noProgress ? null : (hasMismatchedLiveWorktree ? staleWorktree : null),
    branch: noProgress ? null : (hasMismatchedLiveWorktree ? task.branch ?? null : null),
    sessionFile: null,
  });

  const rawFailureExcerpt = typeof task.error === "string"
    ? task.error.slice(0, 200)
    : opts.failure instanceof Error
      ? opts.failure.message.slice(0, 200)
      : String(opts.failure).slice(0, 200);
  const failureExcerpt = isMissingWorktreeSessionStartFailure(rawFailureExcerpt)
    ? "session-start unusable-worktree assertion"
    : rawFailureExcerpt;
  await store.logEntry(
    task.id,
    noProgress
      ? `Auto-recovered (no-progress): session-start refused unusable worktree${staleWorktree ? ` (${staleWorktree})` : ""} — cleared stale session metadata and requeued to todo (attempt ${nextCount}/${MAX_WORKTREE_SESSION_RETRIES}, failure: ${failureExcerpt})`
      : hasMismatchedLiveWorktree
        ? `Auto-recovered: stale resume referenced unusable worktree (${missingWorktreePath}) while live task worktree is ${staleWorktree} — cleared stale session metadata and requeued to todo (attempt ${nextCount}/${MAX_WORKTREE_SESSION_RETRIES}, failure: ${failureExcerpt})`
        : `Auto-recovered: retry/verification session targeted unusable worktree${staleWorktree ? ` (${staleWorktree})` : ""} — cleared stale session metadata and requeued to todo (attempt ${nextCount}/${MAX_WORKTREE_SESSION_RETRIES}, failure: ${failureExcerpt})`,
  );
  if (noProgress) {
    // #1411: backward recovery move — recoveryRehome skips order-derived adjacency.
    await store.moveTask(task.id, "todo", { moveSource: "engine", recoveryRehome: true });
  } else {
    await store.moveTask(task.id, "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
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
    reason: "binding-intact" | "no-live-branch" | "ambiguous-candidates" | "no-unique-work";
    candidates?: Array<{ branch: string; aheadCount: number }>;
  };

export type RebindResult = { repaired: number; outcomes: RebindOutcome[] };

interface LandedTaskCommit {
  sha: string;
  subject?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  rebaseBaseSha?: string;
}

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
function commitOwnedByTask(taskId: string, lineageId: string | undefined, subject: string, body: string): boolean {
  if (lineageId && new RegExp(`(?:^|\\n)Fusion-Task-Lineage: ${escapeRegex(lineageId)}\\s*(?:\\n|$)`).test(body)) {
    return true;
  }
  if (new RegExp(`(?:^|\\n)Fusion-Task-Id: ${escapeRegex(taskId)}\\s*(?:\\n|$)`).test(body)) {
    return true;
  }
  // Subject anchor: `<type>(<…taskId…>): …` or `<taskId>: …` at start.
  // The conventional scope group is intentionally NOT optional: a bare
  // `<type>: …` (e.g. `feat: unrelated change`) carries no task ID and is NOT
  // ownership evidence, even if the body mentions the task in prose (incident
  // bug #2 — a prose-mention must never claim a task).
  const subjectAnchor = new RegExp(
    `^(?:[A-Za-z]+\\([^)]*\\b${escapeRegex(taskId)}\\b[^)]*\\):|${escapeRegex(taskId)}:)`,
  );
  return subjectAnchor.test(subject);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function isBranchAheadOfBase(
  task: Task,
  rootDir: string,
  preferredBaseRef?: string,
): Promise<{ aheadCount: number; baseRef: string } | null> {
  const branchName = resolveTaskWorkingBranch(task);

  try {
    await execAsync(`git rev-parse --verify ${shellQuote(branchName)}`, {
      cwd: rootDir,
      timeout: 30_000,
    });
  } catch {
    return null;
  }

  const requestedBaseRef = preferredBaseRef || task.mergeDetails?.mergeTargetBranch || await resolveIntegrationBranch(rootDir, undefined);
  let resolvedBaseRef = requestedBaseRef;

  try {
    await execAsync(`git rev-parse --verify ${shellQuote(requestedBaseRef)}`, {
      cwd: rootDir,
      timeout: 30_000,
    });
  } catch {
    const remoteRef = `origin/${requestedBaseRef}`;
    try {
      await execAsync(`git rev-parse --verify ${shellQuote(remoteRef)}`, {
        cwd: rootDir,
        timeout: 30_000,
      });
      resolvedBaseRef = remoteRef;
    } catch {
      return null;
    }
  }

  try {
    const { stdout } = await execAsync(
      `git rev-list --count ${shellQuote(resolvedBaseRef)}..${shellQuote(branchName)}`,
      { cwd: rootDir, timeout: 30_000 },
    );
    const aheadCount = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(aheadCount)) {
      return null;
    }
    return { aheadCount, baseRef: resolvedBaseRef };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn(
      `Failed to compare ${branchName} against ${resolvedBaseRef} for ${task.id}: ${errorMessage}`,
    );
    return null;
  }
}

function parseShortstat(output: string): Pick<LandedTaskCommit, "filesChanged" | "insertions" | "deletions"> {
  const normalized = output.trim().replace(/\n/g, " ");
  const filesMatch = normalized.match(/(\d+) files? changed/);
  const insertionsMatch = normalized.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = normalized.match(/(\d+) deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch ? Number.parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch ? Number.parseInt(deletionsMatch[1], 10) : 0,
  };
}

function hasTerminalInvalidDoneTransition(task: Pick<Task, "error">): boolean {
  const error = task.error ?? "";
  return error.includes("Invalid transition:") && error.includes("→ 'done'");
}

export class SelfHealingManager {
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
  private taskMovedFanoutListener: ((data: { task: Task; from: string; to: string; source: string }) => void) | null = null;

  // ── Per-task deadlock recovery cooldown ─────────────────────────────
  private deadlockRecoveryCooldown: Map<string, number> = new Map();
  private mergeStarvationDrops: Map<string, number> = new Map();
  private finalizeUnprovenWarned = new Set<string>();
  private metaResolvedSkipAuditMemo = new Map<string, string>();
  private metaStalledSkipAuditMemo = new Map<string, string>();
  private maintenanceTickCounter = 0;
  private readonly processBootStartedAt = Date.now();
  private dependencyBlockedTodoReporter: DependencyBlockedTodoReporter | null = null;
  private lastDbCorruptionNotifiedAt: number | null = null;

  private boardStallWindow: {
    windowStartMs: number;
    windowStartBlockedDepth: number;
    transitionsOutOfInProgressInWindow: number;
    pendingVerification: { holderIds: string[]; followerCount: number; startedAt: number; tick: number } | null;
    lastNtfyAt: number | null;
  } | null = null;

  private static readonly PAUSED_SCOPE_DECAY_EXCLUDED_REASONS = new Set([
    "branch-conflict-unrecoverable",
    "worktrunk_operation_failed",
    "token_budget_exceeded",
  ]);

  constructor(
    private store: TaskStore,
    private options: SelfHealingOptions,
  ) {}

  public getActiveMergeTaskId(): string | null {
    return this.options.getActiveMergeTaskId?.() ?? null;
  }

  private isMergeLaneOwned(taskId: string): boolean {
    if (this.options.getActiveMergeTaskId?.() === taskId) return true;

    try {
      return this.store.peekMergeQueue().some((entry) => entry.taskId === taskId);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`Unable to inspect merge queue ownership for ${taskId}: ${errorMessage}`);
      return false;
    }
  }

  private isFalseCompletionHandoffExhaustionWhileMergeOwned(task: Task): boolean {
    return task.column === "in-review"
      && task.status === "failed"
      && typeof task.error === "string"
      && task.error.includes("Completion handoff limbo recovery exhausted")
      && this.isMergeLaneOwned(task.id);
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
    const handedOff = await this.store.handoffToReview(taskId, {
      ownerAgentId: null,
      evidence: {
        reason,
        runId: generateSyntheticRunId("self-heal-handoff", taskId),
        agentId: "self-healing",
      },
    });

    const settings = await this.store.getSettings();
    if (isMergeRequestContractShadowEnabled(settings)) {
      this.store.setCompletionHandoffAcceptedMarker(taskId, {
        source: `self-healing:${reason}`,
      });
      this.store.upsertMergeRequestRecord(taskId, {
        state: handedOff.autoMerge === false ? "manual-required" : "queued",
      });
    }

    return handedOff;
  }

  private hasRecentWorktreeIncompleteDetected(taskId: string, graceMs: number): boolean {
    if (!Number.isFinite(graceMs) || graceMs <= 0) return false;
    const storeWithRunAudit = this.store as { getRunAuditEvents?: (filter: { taskId: string; mutationType: string; limit: number }) => Array<{ timestamp?: string | null }> };
    if (typeof storeWithRunAudit.getRunAuditEvents !== "function") return false;
    let events: Array<{ timestamp?: string | null }> = [];
    try {
      events = storeWithRunAudit.getRunAuditEvents({ taskId, mutationType: "worktree:incomplete-detected", limit: 20 }) ?? [];
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
    const noRecentActivity = stalenessMs >= input.graceMs && !this.hasRecentWorktreeIncompleteDetected(task.id, input.graceMs);

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
    log.log(`[${stage}] ${task.id}: triple-proof not satisfied — no action (operator-decides)`);
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
    log.log(`[${stage}] ${task.id}: false-positive requeue suppressed (${reason})`);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  start(): void {
    // Wire up settings:updated listener for auto-unpause
    this.settingsListener = ({ settings, previous }) => {
      this.onSettingsUpdated(settings, previous);
    };
    this.store.on("settings:updated", this.settingsListener);

    this.taskMovedFanoutListener = ({ task, from, to }) => {
      if (
        from === "in-progress"
        && (to === "todo" || to === "in-review" || to === "done" || to === "archived")
        && this.boardStallWindow
      ) {
        // In-memory only counter; resets on engine restart.
        this.boardStallWindow.transitionsOutOfInProgressInWindow++;
      }
      if (to === "in-review") {
        void this.reconcileInReviewBranchRebind({ includeTaskIds: new Set([task.id]) }).catch((err: unknown) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`[self-healing] task:moved in-review rebind failed for ${task.id}: ${errorMessage}`);
        });
      }
      const shouldReconcile =
        (from === "in-review" && to === "done") ||
        (from === "done" && to === "archived");
      if (!shouldReconcile) return;
      void this.reconcileCompletedTask(task.id, { worktreeHint: task.worktree ?? undefined }).catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(`[self-healing] task:moved completion fan-out failed for ${task.id}: ${errorMessage}`);
      });
    };
    this.store.on("task:moved", this.taskMovedFanoutListener);

    // Start periodic maintenance
    this.startMaintenance();

    log.log("Started");
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
      log.log(
        `Startup recovery skipped — ${
          settings.globalPause ? "global pause" : "engine pause"
        } is active`,
      );
      return;
    }

    // Each recovery step is isolated — one failure doesn't prevent subsequent steps.
    const steps: Array<{ name: string; fn: () => Promise<unknown> }> = [
      { name: "no-progress-no-task-done", fn: () => this.recoverNoProgressNoTaskDoneFailures().then(() => undefined) },
      { name: "completed-tasks", fn: () => this.recoverCompletedTasks().then(() => undefined) },
      { name: "recover-stranded-completed-todo", fn: () => this.recoverStrandedCompletedTodoTasks().then(() => undefined) },
      { name: "stale-incomplete-review", fn: () => this.recoverStaleIncompleteReviewTasks().then(() => undefined) },
      { name: "failed-pre-merge-steps", fn: () => this.recoverReviewTasksWithFailedPreMergeSteps().then(() => undefined) },
      { name: "interrupted-merging", fn: () => this.recoverInterruptedMergingTasks().then(() => undefined) },
      { name: "transient-merge-failures", fn: () => this.recoverTransientMergeFailures().then(() => undefined) },
      { name: "done-merge-metadata", fn: () => this.recoverDoneTaskMergeMetadata().then(() => undefined) },
      { name: "reconcile-done-task-integrity", fn: () => this.reconcileDoneTaskIntegrity().then(() => undefined) },
      // FN-5092: must run BEFORE any merger pickup path so the merger queue is
      // not stalled by a leaked `status: "merging"` on an already-done task.
      { name: "reconcile-stale-merger-status", fn: () => this.reconcileStaleMergerStatus().then(() => undefined) },
      { name: "recover-already-merged-review", fn: () => this.recoverAlreadyMergedReviewTasks().then(() => undefined) },
      { name: "recover-post-done-noncontinuable-wedge", fn: () => this.recoverPostDoneNonContinuableWedge().then(() => undefined) },
      { name: "recover-completion-handoff-limbo", fn: () => this.recoverCompletionHandoffLimbo().then(() => undefined) },
      { name: "recover-branch-misbound-in-review", fn: () => this.recoverBranchMisboundInReviewTasks().then(() => undefined) },
      { name: "recover-foreign-only-contamination-in-review", fn: () => this.recoverForeignOnlyContaminatedInReviewTasks().then(() => undefined) },
      { name: "recover-orphan-only-scope-violations", fn: () => this.recoverOrphanOnlyScopeViolations().then(() => undefined) },
      { name: "recover-stuck-merge-deadlocks", fn: () => this.recoverStuckMergeDeadlocks().then(() => undefined) },
      { name: "misclassified-failures", fn: () => this.recoverMisclassifiedFailures().then(() => undefined) },
      { name: "missing-worktree-review-failures", fn: () => this.recoverMissingWorktreeReviewFailures().then(() => undefined) },
      { name: "partial-progress-no-task-done", fn: () => this.recoverPartialProgressNoTaskDoneFailures().then(() => undefined) },
      { name: "orphaned-executions", fn: () => this.recoverOrphanedExecutions().then(() => undefined) },
      { name: "approved-triage", fn: () => this.recoverApprovedTriageTasks().then(() => undefined) },
      { name: "recover-starved-refinement", fn: () => this.recoverStarvedRefinementTriageTasks().then(() => undefined) },
      { name: "orphaned-planning", fn: () => this.recoverOrphanedPlanningTasks().then(() => undefined) },
      { name: "recover-orphaned-agents", fn: () => this.recoverOrphanedAgents().then(() => undefined) },
      { name: "recover-stale-heartbeat-runs", fn: () => this.recoverStaleHeartbeatRuns().then(() => undefined) },
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
      { name: "reconcile-dependency-cycles", fn: () => this.reconcileDependencyCycles().then(() => undefined) },
      { name: "reclaim-pr-conflicts", fn: () => this.reclaimPrConflicts().then(() => undefined) },
      { name: "reclaim-self-owned-branch-conflicts", fn: () => this.reclaimSelfOwnedBranchConflicts().then(() => undefined) },
      // FN-4962 ordering invariant: metadata reconcile must run before stale-active reclaim.
      { name: "reconcile-task-worktree-metadata", fn: () => this.reconcileTaskWorktreeMetadata().then(() => undefined) },
      { name: "recover-in-progress-limbo", fn: () => this.recoverInProgressLimbo().then(() => undefined) },
      { name: "reconcile-in-review-branch-rebind", fn: () => this.reconcileInReviewBranchRebind().then(() => undefined) },
      { name: "reclaim-stale-active-branches", fn: () => this.reclaimStaleActiveBranches().then(() => undefined) },
      { name: "surface-in-review-stalls", fn: () => this.surfaceInReviewStalls().then(() => undefined) },
      { name: "surface-in-review-stalled", fn: () => this.surfaceInReviewStalled().then(() => undefined) },
      { name: "surface-stale-paused-reviews", fn: () => this.surfaceStalePausedReviews().then(() => undefined) },
      { name: "surface-stale-paused-todos", fn: () => this.surfaceStalePausedTodos().then(() => undefined) },
      { name: "audit-no-commits-expected-candidates", fn: () => this.auditNoCommitsExpectedCandidates().then(() => undefined) },
    ];

    for (const step of steps) {
      try {
        await step.fn();
        log.log(`Startup recovery step "${step.name}" completed`);
      } catch (stepErr) {
        const stepErrMessage = stepErr instanceof Error ? stepErr.message : String(stepErr);
        log.error(`Startup recovery step "${step.name}" failed: ${stepErrMessage} — continuing with remaining steps`);
      }
      await yieldEventLoop();
    }
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
    this.metaResolvedSkipAuditMemo.clear();
    this.metaStalledSkipAuditMemo.clear();
    log.log("Stopped");
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
        log.log("Global pause activated manually — auto-unpause skipped, requires manual intervention");
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
        log.log("Auto-unpause: already unpaused — no action needed");
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
   *   progress preserved and pause metadata reapplied for manual resume or
   *   decomposition; tasks with only terminal steps keep the legacy failed
   *   `in-review` handoff path.
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

          log.warn(`${taskId} exceeded stuck kill budget (${newCount}/${maxKills}, reason=${reason}) with incomplete steps — re-queueing in todo with progress preserved`);
          await this.store.updateTask(taskId, { stuckKillCount: newCount });
          try {
            await this.store.moveTask(taskId, "todo", {
              preserveProgress: true,
              preserveStatus: true,
              // #1411: backward recovery — skip order-derived adjacency.
              moveSource: "engine",
              recoveryRehome: true,
            });
          } catch (moveErr: unknown) {
            const moveErrMessage = moveErr instanceof Error ? moveErr.message : String(moveErr);
            log.warn(`${taskId} moveTask(todo) failed (${moveErrMessage}) after incomplete STUCK_LOOP_EXHAUSTED terminalization — falling back to executor stuck-kill requeue`);
            await this.store.logEntry(
              taskId,
              `STUCK_LOOP_EXHAUSTED: incomplete task exhausted stuck kill budget (${newCount}/${maxKills}), last reason=${reason}. Failed to move task to todo (${moveErrMessage}); falling back to executor stuck-kill requeue.`,
            );
            return true;
          }

          const requeueUpdate = {
            stuckKillCount: newCount,
            paused: false,
            userPaused: false,
            pausedReason: null,
            status: "queued",
          } satisfies Parameters<typeof this.store.updateTask>[1] & { userPaused: boolean };
          try {
            await this.store.updateTask(taskId, requeueUpdate);
          } catch (patchErr: unknown) {
            const patchErrMessage = patchErr instanceof Error ? patchErr.message : String(patchErr);
            log.warn(`${taskId} post-move requeue patch failed after incomplete STUCK_LOOP_EXHAUSTED terminalization: ${patchErrMessage}`);
            await this.store.logEntry(
              taskId,
              `STUCK_LOOP_EXHAUSTED: incomplete task moved to todo with progress preserved, but post-move requeue patch failed (${patchErrMessage}); scheduler retry may wait for the next state repair pass.`,
            );
          }
          await this.store.logEntry(
            taskId,
            `STUCK_LOOP_EXHAUSTED: incomplete task exhausted stuck kill budget (${newCount}/${maxKills}), last reason=${reason}. Re-queued in todo with progress preserved; scheduler may retry without manual unpause.`,
          );
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

  // ── Lost work detection ────────────────────────────────────────────

  /**
   * Check whether a task's branch has any unique commits compared to main.
   * If the branch has no unique commits and the task has steps marked done,
   * those steps represent lost uncommitted work — reset them to "pending"
   * so the next execution doesn't skip them.
   */
  private async resetStepsIfWorkLost(task: Task): Promise<void> {
    const completedSteps = task.steps.filter(
      (s) => s.status === "done" || s.status === "in-progress",
    );
    if (completedSteps.length === 0) return;

    const branchName = resolveTaskWorkingBranch(task);

    try {
      const { stdout: mergeBaseOut } = await execAsync(
        `git merge-base "${branchName}" HEAD`,
        { cwd: this.options.rootDir, encoding: "utf-8", timeout: 30_000 },
      );
      const mergeBase = mergeBaseOut.trim();
      const { stdout: branchHeadOut } = await execAsync(
        `git rev-parse "${branchName}"`,
        { cwd: this.options.rootDir, encoding: "utf-8", timeout: 30_000 },
      );
      const branchHead = branchHeadOut.trim();

      if (mergeBase === branchHead) {
        log.warn(
          `${task.id} branch has no unique commits — resetting ${completedSteps.length} step(s) to pending`,
        );

        for (let i = 0; i < task.steps.length; i++) {
          if (task.steps[i].status === "done" || task.steps[i].status === "in-progress") {
            await this.store.updateStep(task.id, i, "pending");
          }
        }

        await this.store.logEntry(
          task.id,
          `Reset ${completedSteps.length} step(s) to pending — branch had no commits (uncommitted work lost with worktree)`,
        );
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to reset steps for ${task.id} after branch/worktree loss (${branchName}): ${errorMessage} — non-fatal`,
      );
    }
  }

  // ── Periodic maintenance ──────────────────────────────────────────

  private async startMaintenance(): Promise<void> {
    const settings = await this.store.getSettings();
    const intervalMs = settings.maintenanceIntervalMs ?? 900_000;

    if (intervalMs <= 0) {
      log.log("Periodic maintenance disabled (maintenanceIntervalMs <= 0)");
      return;
    }

    log.log(`Periodic maintenance every ${Math.round(intervalMs / 60_000)}m`);
    this.maintenanceInterval = setInterval(() => {
      void this.runMaintenance();
    }, intervalMs);
  }

  private isPastInterruptedMergeGrace(task: Task, timeoutMs: number): boolean {
    const updatedAt = task.updatedAt ? Date.parse(task.updatedAt) : 0;
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
    return Date.now() - updatedAt >= timeoutMs;
  }

  private async findLandedTaskCommit(
    task: Task,
    options?: { preferEarliestOwnedCommit?: boolean },
  ): Promise<LandedTaskCommit | null> {
    // Search strategies, tried in order of reliability:
    //   1. mergeDetails.commitSha — already stored by the merger; verify it's
    //      reachable from HEAD before trusting it.
    //   2. Fusion-Task-Lineage trailer — canonical immutable lineage marker.
    //   3. Fusion-Task-Id trailer — legacy human task-id marker.
    //   4. Subject grep — legacy/AI commits where the task ID lives in the
    //      subject line (e.g. `feat(FN-123): …`).
    //
    // (1) gives us the right sha even if the commit subject is exotic; (2)
    // covers includeTaskIdInCommit=false setups where (3) would silently
    // miss; (3) catches commits authored before the trailer was introduced.

    // ── (1) Stored sha ────────────────────────────────────────────────────
    const rebaseBaseSha = task.mergeDetails?.rebaseBaseSha;
    const storedSha = task.mergeDetails?.commitSha;
    if (storedSha) {
      try {
        await execAsync(
          `git merge-base --is-ancestor ${shellQuote(storedSha)} HEAD`,
          { cwd: this.options.rootDir },
        );
        const { stdout } = await execAsync(
          `git log -1 --format=%H%x1f%s%x1f%b ${shellQuote(storedSha)}`,
          { cwd: this.options.rootDir, maxBuffer: 1024 * 1024 },
        );
        const [sha, subject = "", body = ""] = stdout.trim().split("\x1f");
        if (sha && commitOwnedByTask(task.id, task.lineageId, subject, body)) {
          const commit: LandedTaskCommit = { sha, subject, rebaseBaseSha };
          try {
            const shortstat = await this.readShortstatForSha(sha, rebaseBaseSha);
            if (shortstat) {
              Object.assign(commit, shortstat);
            }
          } catch { /* stats are optional */ }
          return commit;
        }
      } catch {
        // Not reachable (rebased away, branch reset, etc.) — fall through.
      }
    }

    const readLog = async (range: string, grepArg: string, fixedStrings: boolean) => {
      const command = [
        "git log",
        "--format=%H%x1f%s",
        "--max-count=20",
        ...(options?.preferEarliestOwnedCommit ? ["--reverse"] : []),
        ...(fixedStrings ? ["--fixed-strings"] : ["-E"]),
        `--grep=${grepArg}`,
        shellQuote(range),
      ].join(" ");

      return execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
    };

    // Search canonical lineage trailer, then legacy task-id trailer, then
    // legacy subject fallback. All share bounded/full HEAD range resolution.
    const search = async (grepArg: string, fixedStrings: boolean): Promise<string> => {
      let out: string;
      try {
        const r = await readLog(
          task.baseCommitSha ? `${task.baseCommitSha}..HEAD` : "HEAD",
          grepArg,
          fixedStrings,
        );
        out = r.stdout;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(
          `Failed to read git log for landed commit lookup (${task.id}): ${errorMessage} — retrying with HEAD range`,
        );
        if (!task.baseCommitSha) return "";
        const r = await readLog("HEAD", grepArg, fixedStrings);
        out = r.stdout;
      }
      // Bounded range may exclude the landed commit when baseCommitSha was
      // advanced past it; re-scan all of HEAD if empty.
      if (!out.trim() && task.baseCommitSha) {
        const r = await readLog("HEAD", grepArg, fixedStrings);
        out = r.stdout;
      }
      return out;
    };

    // (2) Canonical lineage trailer.
    let stdout = "";
    if (task.lineageId) {
      const lineagePattern = `^Fusion-Task-Lineage: ${task.lineageId}$`;
      stdout = await search(shellQuote(lineagePattern), false);
    }

    // (3) Legacy task-id trailer.
    if (!stdout.trim()) {
      const trailerPattern = `^Fusion-Task-Id: ${task.id}$`;
      stdout = await search(shellQuote(trailerPattern), false);
    }

    // (4) Subject grep fallback (legacy commits).
    if (!stdout.trim()) {
      stdout = await search(shellQuote(task.id), true);
    }

    // FN-5441/FN-5446 regression: `git log --grep=FN-XXXX` matches the entire
    // commit message, including prose body mentions. The previous code blindly
    // accepted the first match — which is how FN-5441/5446 got attributed to
    // an unrelated FN-5483 commit that *mentioned* them by name. Walk the
    // candidates and accept only the first one that actually owns the task
    // (anchored lineage/id trailer or subject-anchored conventional commit).
    const candidateLines = stdout.trim().split("\n").filter(Boolean);
    let sha = "";
    let subject = "";
    for (const line of candidateLines) {
      const [candidateSha, candidateSubject = ""] = line.split("\x1f");
      if (!candidateSha) continue;
      try {
        const { stdout: bodyOut } = await execAsync(
          `git log -1 --format=%b ${shellQuote(candidateSha)}`,
          { cwd: this.options.rootDir, maxBuffer: 1024 * 1024 },
        );
        if (commitOwnedByTask(task.id, task.lineageId, candidateSubject, bodyOut)) {
          sha = candidateSha;
          subject = candidateSubject;
          break;
        }
      } catch {
        // If we can't read the body, conservatively skip this candidate.
      }
    }
    if (!sha) return null;

    const commit: LandedTaskCommit = { sha, subject, rebaseBaseSha };
    try {
      const shortstat = await this.readShortstatForSha(sha, rebaseBaseSha);
      if (shortstat) {
        Object.assign(commit, shortstat);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to read shortstat for landed commit ${sha} (${task.id}): ${errorMessage} — continuing without stats`,
      );
      // Stats are useful for the task detail view but not required for recovery.
    }

    return commit;
  }

  private async findAlreadyMergedTaskCommit(input: {
    taskId: string;
    lineageId?: string;
    repoDir: string;
    baseBranch: string;
    taskBranch?: string;
    baseCommitSha?: string;
  }) {
    return findAlreadyMergedTaskCommit(input);
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

  private async isCommitReachableFromBranch(commitSha: string | undefined, branch: string): Promise<boolean> {
    if (!commitSha) return true;
    try {
      await execAsync(`git merge-base --is-ancestor ${shellQuote(commitSha)} ${shellQuote(branch)}`, {
        cwd: this.options.rootDir,
      });
      return true;
    } catch {
      return false;
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

  private async runMaintenance(): Promise<void> {
    if (this.maintenanceRunning) {
      log.log("Maintenance cycle skipped — previous cycle still running");
      return;
    }

    this.maintenanceRunning = true;
    const startMs = Date.now();
    this.maintenanceTickCounter++;
    log.log("Maintenance cycle starting");

    try {
      const settings = await this.store.getSettings();

      // Batch 1 — housekeeping (safe under pause: filesystem/db cleanup only)
      const batch1Fns: Array<{ name: string; fn: () => Promise<unknown> }> = [
        { name: "prune-worktrees", fn: () => this.pruneWorktrees() },
        { name: "cleanup-orphans", fn: () => this.cleanupOrphans() },
        { name: "cleanup-orphaned-branches", fn: () => this.cleanupOrphanedBranches() },
        {
          name: "cleanup-old-chats",
          fn: async () => {
            const days = Number(settings.chatAutoCleanupDays ?? 0);
            if (!Number.isFinite(days) || days <= 0) {
              log.log("Maintenance batch 1 step \"cleanup-old-chats\" skipped — chatAutoCleanupDays is not enabled");
              return;
            }
            if (!this.options.chatStore) {
              log.log("Maintenance batch 1 step \"cleanup-old-chats\" skipped — ChatStore unavailable");
              return;
            }
            const { sessionsDeleted, roomsDeleted } = this.options.chatStore.cleanupOldChats(days * 86_400_000);
            log.log(`Maintenance batch 1 step "cleanup-old-chats" succeeded — sessions=${sessionsDeleted} rooms=${roomsDeleted}`);
          },
        },
        {
          name: "cleanup-old-mail",
          fn: async () => {
            const value = Number(settings.mailAutoCleanupDays ?? 0);
            if (!Number.isFinite(value) || value <= 0) {
              log.log(`Skipping cleanup-old-mail: setting=${String(settings.mailAutoCleanupDays ?? 0)}`);
              return;
            }
            if (!this.options.messageStore) {
              log.log("Skipping cleanup-old-mail: messageStore unavailable");
              return;
            }
            const { messagesDeleted } = this.options.messageStore.cleanupOldMessages(value * 86_400_000);
            log.log(`Maintenance batch 1 step "cleanup-old-mail" succeeded — messagesDeleted=${messagesDeleted}`);
          },
        },
        {
          name: "prune-operational-logs",
          fn: async () => {
            const days = Number(settings.operationalLogRetentionDays ?? 0);
            if (!Number.isFinite(days) || days <= 0) {
              log.log("Maintenance batch 1 step \"prune-operational-logs\" skipped — operationalLogRetentionDays is not enabled");
              return;
            }
            const { deletedTotal, deletedByTable } = this.store.pruneOperationalLogs(days * 86_400_000);
            const detail = Object.entries(deletedByTable)
              .filter(([, n]) => n > 0)
              .map(([t, n]) => `${t}=${n}`)
              .join(" ");
            log.log(`Maintenance batch 1 step "prune-operational-logs" succeeded — deleted=${deletedTotal}${detail ? ` (${detail})` : ""}`);
          },
        },
        {
          name: "prune-agent-log-files",
          fn: async () => {
            const days = Number(settings.agentLogFileRetentionDays ?? 0);
            if (!Number.isFinite(days) || days <= 0) {
              log.log("Maintenance batch 1 step \"prune-agent-log-files\" skipped — agentLogFileRetentionDays is not enabled");
              return;
            }
            const { prunedFiles, prunedEntries, freedBytes } = this.store.pruneAgentLogFiles(days);
            log.log(`Maintenance batch 1 step "prune-agent-log-files" succeeded — files=${prunedFiles} entries=${prunedEntries} bytes=${freedBytes}`);
          },
        },
        { name: "fts-maintenance", fn: () => this.maintainTaskFts() },
        { name: "checkpoint-wal", fn: () => Promise.resolve(this.checkpointWal()) },
        { name: "enforce-worktree-cap", fn: () => this.enforceWorktreeCap() },
      ];
      for (const fn of batch1Fns) {
        try {
          await fn.fn();
          log.log(`Maintenance batch 1 step "${fn.name}" succeeded`);
        } catch (stepErr) {
          log.error(`Maintenance batch 1 step "${fn.name}" failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
        }
        await yieldEventLoop();
      }

      const recoverySettings = await this.store.getSettings();
      if (recoverySettings.globalPause || recoverySettings.enginePaused) {
        log.log(
          `Maintenance batch 2 skipped — ${
            recoverySettings.globalPause ? "global pause" : "engine pause"
          } is active`,
        );
      } else {
        // Batch 2 — Task recovery (operations are independent of each other)
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
          { name: "recover-completed-tasks", fn: () => this.recoverCompletedTasks() },
          { name: "recover-stranded-completed-todo", fn: () => this.recoverStrandedCompletedTodoTasks() },
          { name: "recover-stale-incomplete-review", fn: () => this.recoverStaleIncompleteReviewTasks() },
          { name: "recover-failed-pre-merge-steps", fn: () => this.recoverReviewTasksWithFailedPreMergeSteps() },
          { name: "recover-interrupted-merging", fn: () => this.recoverInterruptedMergingTasks() },
          { name: "recover-transient-merge-failures", fn: () => this.recoverTransientMergeFailures() },
          { name: "recover-done-merge-metadata", fn: () => this.recoverDoneTaskMergeMetadata() },
          { name: "recover-stale-merging-status", fn: () => this.recoverStaleMergingStatus() },
          { name: "finalize-noop-review", fn: () => this.finalizeNoOpReviewTasks() },
          { name: "reconcile-done-task-integrity", fn: () => this.reconcileDoneTaskIntegrity() },
          { name: "reconcile-stale-merger-status", fn: () => this.reconcileStaleMergerStatus() },
          { name: "recover-mergeable-review", fn: () => this.recoverMergeableReviewTasks() },
          { name: "recover-merged-review", fn: () => this.recoverMergedReviewTasks() },
          { name: "recover-already-merged-review", fn: () => this.recoverAlreadyMergedReviewTasks() },
          { name: "recover-post-done-noncontinuable-wedge", fn: () => this.recoverPostDoneNonContinuableWedge() },
          { name: "recover-completion-handoff-limbo", fn: () => this.recoverCompletionHandoffLimbo() },
          { name: "recover-branch-misbound-in-review", fn: () => this.recoverBranchMisboundInReviewTasks() },
          { name: "recover-foreign-only-contamination-in-review", fn: () => this.recoverForeignOnlyContaminatedInReviewTasks() },
          { name: "recover-orphan-only-scope-violations", fn: () => this.recoverOrphanOnlyScopeViolations() },
          { name: "recover-stuck-merge-deadlocks", fn: () => this.recoverStuckMergeDeadlocks() },
          { name: "recover-misclassified-failures", fn: () => this.recoverMisclassifiedFailures() },
          { name: "recover-missing-worktree-review-failures", fn: () => this.recoverMissingWorktreeReviewFailures() },
          { name: "recover-no-progress-no-task-done", fn: () => this.recoverNoProgressNoTaskDoneFailures() },
          { name: "recover-partial-progress-no-task-done", fn: () => this.recoverPartialProgressNoTaskDoneFailures() },
          { name: "recover-orphaned-executions", fn: () => this.recoverOrphanedExecutions() },
          { name: "recover-approved-triage", fn: () => this.recoverApprovedTriageTasks() },
          { name: "resolve-explicit-duplicate-markers", fn: () => this.resolveExplicitDuplicateMarkerTasks() },
          { name: "recover-starved-refinement", fn: () => this.recoverStarvedRefinementTriageTasks() },
          { name: "recover-orphaned-planning", fn: () => this.recoverOrphanedPlanningTasks() },
          { name: "recover-ghost-review", fn: () => this.recoverGhostReviewTasks() },
          { name: "recover-orphaned-agents", fn: () => this.recoverOrphanedAgents() },
          { name: "recover-stale-heartbeat-runs", fn: () => this.recoverStaleHeartbeatRuns() },
          { name: "recover-running-on-inactive-tasks", fn: () => this.recoverAgentsRunningOnInactiveTasks() },
          { name: "recover-drifted-agent-task-links", fn: () => this.recoverDriftedAgentTaskLinks() },
          { name: "reconcile-soft-delete-column-drift", fn: () => this.reconcileSoftDeletedColumnDrift() },
          { name: "clear-stale-blocked-by", fn: () => this.clearStaleBlockedBy() },
          { name: "auto-rebound-paused-scope-decay", fn: () => this.autoReboundPausedScopeDecay() },
          { name: "auto-archive-meta-resolved", fn: () => this.autoArchiveResolvedMetaTasks() },
          { name: "auto-archive-meta-stalled", fn: () => this.autoArchiveStalledMetaTasks() },
          { name: "board-stall-auto-recovery", fn: () => this.runBoardStallAutoRecoverySweep() },
          // #1401: periodically recover transitionPending markers stranded by a
          // crash between the in-txn write and the post-commit clear (flag-ON
          // only; a no-op when there are no markers).
          { name: "recover-stale-transition-pending", fn: () => this.runStaleTransitionPendingSweep() },
          { name: "reconcile-self-defeating-deps", fn: () => this.reconcileSelfDefeatingDependencies() },
          { name: "reconcile-dependency-cycles", fn: () => this.reconcileDependencyCycles().then(() => undefined) },
          { name: "reclaim-pr-conflicts", fn: () => this.reclaimPrConflicts() },
          { name: "reclaim-self-owned-branch-conflicts", fn: () => this.reclaimSelfOwnedBranchConflicts() },
          // FN-4962 ordering invariant: metadata reconcile must run before stale-active reclaim.
          { name: "reconcile-task-worktree-metadata", fn: () => this.reconcileTaskWorktreeMetadata() },
          { name: "recover-in-progress-limbo", fn: () => this.recoverInProgressLimbo() },
          { name: "reconcile-in-review-branch-rebind", fn: () => this.reconcileInReviewBranchRebind().then(() => undefined) },
          { name: "reclaim-stale-active-branches", fn: () => this.reclaimStaleActiveBranches() },
          { name: "surface-in-review-stalls", fn: () => this.surfaceInReviewStalls() },
          { name: "surface-in-review-stalled", fn: () => this.surfaceInReviewStalled() },
          { name: "surface-stale-paused-reviews", fn: () => this.surfaceStalePausedReviews() },
          { name: "surface-stale-paused-todos", fn: () => this.surfaceStalePausedTodos() },
          { name: "surface-db-corruption", fn: () => this.surfaceDbCorruption() },
          { name: "audit-no-commits-expected-candidates", fn: () => this.auditNoCommitsExpectedCandidates() },
        ];
        for (const fn of batch2Fns) {
          try {
            await fn.fn();
            log.log(`Maintenance batch 2 step "${fn.name}" succeeded`);
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
          log.log(`Maintenance batch 3 step "${fn.name}" succeeded`);
        } catch (stepErr) {
          log.error(`Maintenance batch 3 step "${fn.name}" failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
        }
        await yieldEventLoop();
      }

      const elapsedMs = Date.now() - startMs;
      log.log(`Maintenance cycle completed in ${elapsedMs}ms`);
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
      for (const t of tasks) {
        if (t.column === "done" || t.column === "archived") continue;
        for (const depId of t.dependencies ?? []) {
          tasksWithActiveDependents.add(depId);
        }
      }

      const stale = tasks.filter((t) => {
        if (t.column !== "done") return false;
        // Prefer columnMovedAt (when the task entered done); fall back to updatedAt
        // for legacy tasks that lack the field.
        const ts = t.columnMovedAt || t.updatedAt;
        const movedAt = ts ? Date.parse(ts) : NaN;
        if (!Number.isFinite(movedAt)) return false;
        if (movedAt >= cutoff) return false;
        if (tasksWithActiveDependents.has(t.id)) {
          log.log(`Skipping auto-archive of ${t.id}: has active dependents`);
          return false;
        }
        return true;
      });

      if (stale.length === 0) return 0;

      log.log(`Auto-archiving ${stale.length} done task(s) older than ${archiveAfterMs}ms`);

      let archived = 0;
      const thresholdDays = Math.floor(archiveAfterMs / 86_400_000);
      for (const task of stale) {
        try {
          await this.store.archiveTaskAndCleanup(task.id);
          archived++;
          const ts = task.columnMovedAt || task.updatedAt;
          const movedAt = ts ? Date.parse(ts) : NaN;
          const ageDays = Number.isFinite(movedAt) ? Math.floor((now - movedAt) / 86_400_000) : 0;
          log.log(`auto-archive: archived ${task.id} (age ${ageDays}d, threshold ${thresholdDays}d)`);
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to auto-archive ${task.id}: ${errorMessage}`);
        }
      }

      if (archived > 0) {
        log.log(`Auto-archived ${archived} stale done task(s)`);
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
      const tasks = await this.store.listTasks({ column: "in-progress", slim: true });
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      const stuckCompleted = tasks.filter((t) =>
        t.column === "in-progress" &&
        !t.paused &&
        !executingIds.has(t.id) &&
        t.steps.length > 0 &&
        t.steps.every((s) => s.status === "done" || s.status === "skipped"),
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
          log.log(`${task.id} started executing concurrently — skipping recovery this cycle`);
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
      const tasks = await this.store.listTasks({ column: "todo", slim: true });
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      const stranded = tasks.filter((task) => {
        if (task.column !== "todo" || task.paused) return false;
        if (executingIds.has(task.id)) return false;
        if (task.steps.length === 0 || !task.steps.every((s) => s.status === "done" || s.status === "skipped")) return false;
        if (task.error) return false;
        if (task.status && STRANDED_COMPLETED_TODO_ACTIVE_STATUSES.has(task.status)) return false;
        if (task.reviewState?.refreshStatus === "refreshing") return false;
        return true;
      });

      if (stranded.length === 0) return 0;

      log.warn(`Found ${stranded.length} completed task(s) stranded in todo`);

      let recovered = 0;
      for (const task of stranded) {
        const latestExecutingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
        if (latestExecutingIds.has(task.id)) {
          log.log(`${task.id} started executing concurrently — skipping stranded todo recovery this cycle`);
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
   * Clear stale transient merge statuses when no active merger owns the task.
   *
   * @returns Number of tasks unblocked by clearing stale status
   */
  async recoverStaleMergingStatus(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const minAgeMs = this.options.staleMergingStatusMinAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS;
      if (!Number.isFinite(minAgeMs) || minAgeMs <= 0) return 0;

      const now = Date.now();
      const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const stale = tasks.filter((task) => {
        if (task.column !== "in-review" || task.paused) return false;
        if (!task.status || (task.status !== "merging" && task.status !== "merging-pr")) return false;
        if (activeMergeTaskId && activeMergeTaskId === task.id) return false;

        const updatedAtMs = task.updatedAt ? Date.parse(task.updatedAt) : Number.NaN;
        if (!Number.isFinite(updatedAtMs)) return false;
        return now - updatedAtMs >= minAgeMs;
      });

      if (stale.length === 0) return 0;

      let recovered = 0;
      for (const task of stale) {
        const previousStatus = task.status;
        try {
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

      const inProgressCandidates = await this.store.listTasks({ column: "in-progress", slim: true });
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

      if (task.column === "in-review") {
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
          await this.store.moveTask(task.id, "todo", {
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
      const todoCandidates = await this.store.listTasks({ column: "todo", slim: true });
      const inProgressCandidates = await this.store.listTasks({ column: "in-progress", slim: true });
      const inProgressByWorktree = new Map<string, string>();
      for (const inProgressTask of inProgressCandidates) {
        if (inProgressTask.worktree) {
          inProgressByWorktree.set(inProgressTask.worktree, inProgressTask.id);
        }
      }
      const inReviewPausedCandidates = (await this.store.listTasks({ column: "in-review", slim: true }))
        .filter((task) => task.paused === true && task.pausedReason === "branch-conflict-unrecoverable");
      // Per-task auto-merge gating applies to ALL candidate columns, not just
      // in-review: the FN-5704 regression contract ("short-circuits reclaim
      // when autoMerge is false") deliberately keeps execution-stage reclaim
      // and resume-limbo escalation inert in manual-review projects. The
      // per-task override preserves that for override-less tasks while letting
      // explicit autoMerge:true tasks recover.
      const candidates = [...todoCandidates, ...inProgressCandidates, ...inReviewPausedCandidates]
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
          await this.emitFalsePositiveRequeueNoAction(
            task,
            "reclaim-self-owned-branch-conflict",
            "task:reclaim-self-owned-branch-conflict-no-action",
            liveExecutionSignal.reason,
            liveExecutionSignal.metadata,
          );
          continue;
        }
        if (task.column === "todo" && task.blockedBy) {
          log.log(`[self-healing] skipping blocked todo task ${task.id} during self-owned branch reclaim (blockedBy=${task.blockedBy})`);
          continue;
        }
        if (task.pausedReason === "worktrunk_operation_failed") {
          log.log(`[self-healing] skipping worktrunk-paused task ${task.id}`);
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
          log.log(`[self-healing] deferring reclaim for ${task.id}: worktree ${task.worktree} has active session`);
          continue;
        }
        if (!await isUsableTaskWorktree(this.options.rootDir, task.worktree)) continue;

        const reviewProof = task.column === "in-review"
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

              if (task.column === "in-review") {
                if (!reviewProof?.ok) {
                  await this.emitBackwardMoveNoAction(task, "reclaim-self-owned-branch-conflict", "task:reclaim-self-owned-branch-conflict-no-action", reviewProof!);
                } else {
                  await this.store.moveTask(task.id, "todo", {
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

                if (task.column === "in-review") {
                  if (!reviewProof?.ok) {
                    await this.emitBackwardMoveNoAction(task, "reclaim-self-owned-branch-conflict", "task:reclaim-self-owned-branch-conflict-no-action", reviewProof!);
                  } else {
                    await this.store.moveTask(task.id, "todo", {
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
          const stepSignature = buildResumeLimboStepSignature(task);
          const hasActiveSessionSignal = Boolean(task.checkedOutBy) || activeTaskIds.has(task.id.toUpperCase());
          const hasPriorSnapshot = typeof task.resumeLimboTipSha === "string" && typeof task.resumeLimboStepSignature === "string";
          const unchangedSincePriorResume = hasPriorSnapshot
            && task.resumeLimboTipSha === inspection.tipSha
            && task.resumeLimboStepSignature === stepSignature;
          const isNoProgressResume = task.column === "in-progress"
            && unchangedSincePriorResume
            && !hasActiveSessionSignal;
          const resumeAttemptCount = isNoProgressResume ? (task.resumeLimboCount ?? 0) + 1 : 0;

          if (task.column === "in-progress" && isNoProgressResume && resumeAttemptCount >= MAX_NO_PROGRESS_RESUME_ATTEMPTS) {
            const idleAnchor = task.executionStartedAt ?? task.columnMovedAt ?? task.updatedAt;
            const idleAnchorMs = Date.parse(idleAnchor ?? "");
            const idleMs = Number.isFinite(idleAnchorMs) ? Math.max(0, Date.now() - idleAnchorMs) : null;
            await this.store.moveTask(task.id, "todo", {
              moveSource: "engine",
              // #1411: backward recovery — skip order-derived adjacency.
              recoveryRehome: true,
              preserveWorktree: true,
              preserveProgress: true,
              preserveResumeState: true,
            });
            await this.store.updateTask(task.id, {
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
            worktree: inspection.livePath,
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
            `[recovery] ${wasPausedBranchConflict ? "reclaim-paused-review" : "reclaim-self-owned"} ${task.id} at ${inspection.livePath} (${preservedCommitCount} commits preserved, tip ${inspection.tipSha.slice(0, 12)})`,
          );

          if (task.column === "in-review") {
            if (!reviewProof?.ok) {
              await this.emitBackwardMoveNoAction(task, "reclaim-self-owned-branch-conflict", "task:reclaim-self-owned-branch-conflict-no-action", reviewProof!);
            } else {
              await this.store.moveTask(task.id, "todo", {
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
                worktreePath: inspection.livePath,
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
        if (!task || task.column === "archived" || task.checkedOutBy || task.userPaused) continue;
        if (task.pausedReason === "worktrunk_operation_failed") {
          log.log(`[self-healing] skipping worktrunk-paused task ${task.id}`);
          continue;
        }
        if (activeTaskIds.has(task.id.toUpperCase())) continue;

        const emitDeferredReclaimAudit = async (reason: "active-session" | "recent-execution-started" | "worktree-has-uncommitted-changes", hasActiveSession: boolean, hasUncommittedChanges: boolean): Promise<void> => {
          log.log(`[self-healing] deferring stale-active-branch reclaim for ${task.id}: reason=${reason}`);
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

        if (inspection.uniqueCommitCount > 0) {
          log.warn(`[recovery] stale-active-branch-rescue-needed ${task.id} branch=${branch} unique=${inspection.uniqueCommitCount} tip=${inspection.tipSha.slice(0, 12)}`);
          continue;
        }

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
          `[recovery] stale-active-branch-reclaim ${task.id} branch=${branch} reason=zero-unique-commits-no-worktree`,
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
              reason: "zero-unique-commits-no-worktree",
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
  private async findWorktreePathForBranch(branchName: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync("git worktree list --porcelain", {
        cwd: this.options.rootDir,
        timeout: 30_000,
      });
      const lines = stdout.split("\n");
      let currentWorktree: string | undefined;
      let currentBranch: string | undefined;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          if (currentWorktree && currentBranch === branchName) return currentWorktree;
          currentWorktree = undefined;
          currentBranch = undefined;
          continue;
        }
        if (line.startsWith("worktree ")) {
          currentWorktree = line.slice("worktree ".length).trim();
          continue;
        }
        if (line.startsWith("branch refs/heads/")) {
          currentBranch = line.slice("branch refs/heads/".length).trim();
        }
      }
      if (currentWorktree && currentBranch === branchName) return currentWorktree;
      return undefined;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`[self-healing] reconcileCompletedTask: failed to read worktree list for ${branchName}: ${errorMessage}`);
      return undefined;
    }
  }

  private async clearCompletionBranchIfSubsumed(task: Task, branchName: string): Promise<boolean> {
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
      log.warn(
        `[self-healing] reconcileCompletedTask ${task.id}: branch ${branchName} has ${comparison.commits.length} unique commit(s) vs ${comparison.mainRef}; skip deletion`,
      );
      return false;
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
      const todoTasks = await this.store.listTasks({ column: "todo", slim: true });
      const inProgressTasks = await this.store.listTasks({ column: "in-progress", slim: true });
      const inReviewTasks = (await this.store.listTasks({ column: "in-review", slim: true })).filter((t) => !t.paused);

      const dependents = [...todoTasks, ...inProgressTasks, ...inReviewTasks].filter(
        (t) => t.blockedBy === taskId || t.overlapBlockedBy === taskId,
      );
      const todoTaskIds = new Set(todoTasks.map((t) => t.id));
      for (const dependent of dependents) {
        try {
          const unresolvedDeps = dependent.dependencies.filter((depId) => {
            const dep = taskById.get(depId);
            return dep && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";
          });
          const overlapBlockedBy = dependent.overlapBlockedBy === taskId ? null : (dependent.overlapBlockedBy ?? null);
          const overlapBlockerTask = overlapBlockedBy ? taskById.get(overlapBlockedBy) : undefined;
          const hasActiveOverlapBlocker = Boolean(
            overlapBlockerTask
            && (overlapBlockerTask.column === "in-progress" || (overlapBlockerTask.column === "in-review" && !overlapBlockerTask.paused)),
          );

          if (todoTaskIds.has(dependent.id)) {
            if (unresolvedDeps.length > 0) {
              const nextBlocker = unresolvedDeps[0]!;
              await this.store.updateTask(dependent.id, { blockedBy: nextBlocker, overlapBlockedBy, status: "queued" });
              await this.store.logEntry(
                dependent.id,
                `Auto-recovered (FN-4523): cleared stale blockedBy — blocker ${taskId} is done; now blocked by ${nextBlocker}`,
              );
            } else if (hasActiveOverlapBlocker) {
              await this.store.updateTask(dependent.id, { blockedBy: null, overlapBlockedBy, status: "queued" });
              await this.store.logEntry(
                dependent.id,
                `Auto-recovered (FN-4523): preserved queued status — still blocked by file scope overlap with ${overlapBlockedBy}`,
              );
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
        log.log(`${prefix} no live worktree found for branch ${branchName}`);
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
    const result: RebindResult = { repaired: 0, outcomes: [] };
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return result;

      const allTasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const tasks = allTasks.filter((task) => task.column === "in-review");
      const fusionRefOutput = await execAsync("git for-each-ref --format='%(refname:short)' refs/heads/fusion/", {
        cwd: this.options.rootDir,
        timeout: 30_000,
      }).catch(() => ({ stdout: "" }));
      const fusionBranches = fusionRefOutput.stdout.split("\n").map((line) => line.trim()).filter(Boolean);

      for (const task of tasks) {
        if (options?.includeTaskIds && !options.includeTaskIds.has(task.id)) continue;

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
          // TODO(FN-5066): tighten composition once helper API is final.
          try {
            const maybeAsserting = this as unknown as { assertSafeToAutoMutate?: (opts: unknown) => Promise<void> };
            await maybeAsserting.assertSafeToAutoMutate?.({ taskId: task.id, reason: "in-review-branch-rebind" });
          } catch (assertErr: unknown) {
            const message = assertErr instanceof Error ? assertErr.message : String(assertErr);
            log.warn(`[self-healing] assertSafeToAutoMutate warning for ${task.id}: ${message}; continuing rebind`);
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

      for (const task of allTasks) {
        if (!task.worktree) continue;
        if (!options?.includeTaskIds?.has(task.id) && (task.column === "done" || task.column === "archived")) {
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
          worktreeMetadataReconcileLog.log(
            `rebound ${task.id}: ${previousWorktree} -> ${liveWorktree} (${previousBranch ?? "<none>"} -> ${normalizedBranch})`,
          );
          repaired++;
          continue;
        }

        // FN-5256: never null out worktree/branch metadata for an active task. If a
        // live task's worktree looks stale here (and we couldn't rebind to a live
        // fusion/<id>), the executor's own recovery paths will detect and recreate
        // it. Clearing here yanks the worktree from a still-running shell.
        if (task.column === "in-progress" || task.column === "in-review") {
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
        worktreeMetadataReconcileLog.log(
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
      if (task.column !== "in-progress" || task.paused !== true) continue;
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

      await this.store.moveTask(task.id, "todo", {
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

  private classifyMetaTask(task: Task): { isMeta: boolean; targetTaskId: string | null } {
    const title = task.title ?? "";
    const description = task.description ?? "";
    const targetTaskId = task.sourceParentTaskId ?? title.match(/\bFN-\d+\b/i)?.[0] ?? description.match(/\bFN-\d+\b/i)?.[0] ?? null;
    const isMeta = Boolean(task.noCommitsExpected) || /\b(recover|unblock|finalize|meta)\b/i.test(`${title} ${description}`);
    return { isMeta, targetTaskId: targetTaskId?.toUpperCase() ?? null };
  }

  private resolveMetaTargetTaskId(byId: Map<string, Task>, task: Task): string | null {
    const classified = this.classifyMetaTask(task);
    if (classified.targetTaskId) return classified.targetTaskId;
    if (!classified.isMeta) return null;

    const ordered = [...byId.values()].sort((a, b) => {
      const aTime = Date.parse(a.createdAt ?? "");
      const bTime = Date.parse(b.createdAt ?? "");
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
      return a.id.localeCompare(b.id);
    });
    const metaTasks = ordered.filter((candidate) => this.classifyMetaTask(candidate).isMeta);
    const nonMetaTasks = ordered.filter((candidate) => !this.classifyMetaTask(candidate).isMeta);
    const currentIndex = metaTasks.findIndex((candidate) => candidate.id === task.id);
    const previousMeta = currentIndex > 0 ? metaTasks[currentIndex - 1] : null;
    const firstNonMeta = nonMetaTasks[0] ?? null;
    const action = (task.title ?? "").trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";

    if (action === "recover" || action === "unblock") {
      return previousMeta?.id ?? firstNonMeta?.id ?? null;
    }
    if (action === "finalize") {
      return firstNonMeta?.id ?? previousMeta?.id ?? null;
    }
    return previousMeta?.id ?? firstNonMeta?.id ?? null;
  }

  private computeMetaChainDepth(byId: Map<string, Task>, targetTaskId: string): number {
    let depth = 0;
    const visited = new Set<string>();
    let currentId: string | null = targetTaskId.toUpperCase();
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const task = byId.get(currentId);
      if (!task) break;
      if (!this.classifyMetaTask(task).isMeta) break;
      const nextTargetId = this.resolveMetaTargetTaskId(byId, task);
      if (!nextTargetId) break;
      depth += 1;
      currentId = nextTargetId.toUpperCase();
    }
    return depth;
  }

  private async archiveMetaTask(taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task || task.column === "archived") return;
    if (task.column === "triage" || task.column === "todo") {
      await this.store.moveTask(taskId, "in-progress", { moveSource: "engine" });
    }
    const progressed = await this.store.getTask(taskId);
    if (progressed && progressed.column === "in-progress") {
      await this.store.moveTask(taskId, "done", { moveSource: "engine", skipMergeBlocker: true });
    }
    if (typeof this.store.archiveTaskAndCleanup === "function") {
      await this.store.archiveTaskAndCleanup(taskId);
      return;
    }
    if (typeof this.store.archiveTask === "function") {
      await this.store.archiveTask(taskId, true);
    }
  }

  private countBlockedDepth(tasks: Task[]): number {
    return tasks.filter((task) => typeof task.blockedBy === "string" && task.blockedBy.trim().length > 0).length;
  }

  private async evaluateMetaAutoArchiveGuards(task: Task): Promise<{ block: false } | { block: true; reasons: string[] }> {
    const reasons: string[] = [];

    try {
      const ahead = await isBranchAheadOfBase(task, this.options.rootDir, task.baseBranch ?? task.mergeDetails?.mergeTargetBranch ?? await resolveIntegrationBranch(this.options.rootDir, undefined));
      if (ahead && ahead.aheadCount > 0) reasons.push("branch-has-unique-commits");
    } catch (err: unknown) {
      log.warn(`Meta auto-archive branch probe failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const settings = await this.store.getSettings();
    const graceMs = Number(settings.metaTaskActiveExecutionGraceMs ?? 30 * 60_000);
    if (graceMs > 0) {
      const now = Date.now();
      const activityMs = Date.parse(task.executionStartedAt ?? task.columnMovedAt ?? task.updatedAt ?? "");
      const ageMs = now - activityMs;
      const columnMovedAtMs = Date.parse(task.columnMovedAt ?? "");
      const executionStartedAtMs = Date.parse(task.executionStartedAt ?? "");
      const transitionedRecentlyFromInProgress =
        task.column !== "in-progress" &&
        Number.isFinite(columnMovedAtMs) &&
        Number.isFinite(executionStartedAtMs) &&
        columnMovedAtMs >= executionStartedAtMs &&
        now - columnMovedAtMs < graceMs;
      const activeOrRecentlyInProgress = task.column === "in-progress" || transitionedRecentlyFromInProgress;
      if (Number.isFinite(ageMs) && ageMs < graceMs && activeOrRecentlyInProgress) {
        reasons.push("recent-executor-activity");
      }
    }

    if ((task.taskDoneRetryCount ?? 0) > 0) reasons.push("task-done-retry-pending");

    if (task.mergeDetails?.commitSha || task.status === "merging" || task.status === "merging-pr" || task.status === "failed") {
      reasons.push("merge-in-progress");
    }

    if (task.worktree && activeSessionRegistry.isPathActive(task.worktree)) reasons.push("active-session");

    return reasons.length > 0 ? { block: true, reasons } : { block: false };
  }

  private formatReasonSignature(reasons: string[]): string {
    return reasons.join("|");
  }

  private shouldEmitReasonMemo(memo: Map<string, string>, taskId: string, reasons: string[]): boolean {
    const signature = this.formatReasonSignature(reasons);
    const previous = memo.get(taskId);
    if (previous === signature) {
      return false;
    }
    memo.set(taskId, signature);
    return true;
  }

  private clearReasonMemo(memo: Map<string, string>, taskId: string): void {
    memo.delete(taskId);
  }

  async autoArchiveResolvedMetaTasks(reboundedTargets?: Set<string>): Promise<number> {
    const tasks = await this.store.listTasks({ slim: false, includeArchived: true });
    const byId = new Map(tasks.map((task) => [task.id.toUpperCase(), task]));
    let archived = 0;
    for (const task of tasks) {
      if (task.column === "archived") continue;
      const classified = this.classifyMetaTask(task);
      const targetTaskId = this.resolveMetaTargetTaskId(byId, task);
      if (!classified.isMeta || !targetTaskId) {
        this.clearReasonMemo(this.metaResolvedSkipAuditMemo, task.id);
        continue;
      }
      const chainDepth = this.computeMetaChainDepth(byId, targetTaskId);
      const target = byId.get(targetTaskId.toUpperCase());
      const resolved = Boolean(target && !this.classifyMetaTask(target).isMeta && (target.column === "done" || target.column === "archived" || target.column === "todo"));
      const rebounded = Boolean(reboundedTargets?.has(targetTaskId));
      if (!resolved && !rebounded && chainDepth < 2) {
        this.clearReasonMemo(this.metaResolvedSkipAuditMemo, task.id);
        continue;
      }
      const guardResult = await this.evaluateMetaAutoArchiveGuards(task);
      if (guardResult.block) {
        if (this.shouldEmitReasonMemo(this.metaResolvedSkipAuditMemo, task.id, guardResult.reasons)) {
          const auditor = createRunAuditor(this.store, { runId: generateSyntheticRunId("fn4890-meta", task.id), agentId: "self-healing", taskId: task.id, phase: "auto-archive-meta-resolved-skipped" });
          await auditor.database({
            type: "task:auto-archive-meta-resolved-skipped",
            target: task.id,
            metadata: { taskId: task.id, targetTaskId, targetColumn: target?.column ?? "unknown", chainDepth, blockedBy: guardResult.reasons },
          });
        }
        log.log(`[self-healing] skipped meta-resolved auto-archive for ${task.id}: ${guardResult.reasons.join(",")}`);
        continue;
      }
      this.clearReasonMemo(this.metaResolvedSkipAuditMemo, task.id);
      try {
        await this.store.logEntry(task.id, `Auto-archived meta-task (FN-4890): target ${targetTaskId} resolved/superseded.`);
        await this.archiveMetaTask(task.id);
        const auditor = createRunAuditor(this.store, { runId: generateSyntheticRunId("fn4890-meta", task.id), agentId: "self-healing", taskId: task.id, phase: "auto-archive-meta-resolved" });
        await auditor.database({ type: "task:auto-archived-meta-resolved", target: task.id, metadata: { taskId: task.id, targetTaskId, targetColumn: target?.column ?? "unknown", chainDepth } });
        archived++;
      } catch (err: unknown) {
        log.error(`autoArchiveResolvedMetaTasks failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return archived;
  }

  async autoArchiveStalledMetaTasks(): Promise<number> {
    const settings = await this.store.getSettings();
    const thresholdMs = Number(settings.metaTaskStallAutoCloseMs ?? 2 * 60 * 60_000);
    if (thresholdMs === 0) return 0;
    const tasks = await this.store.listTasks({ slim: false, includeArchived: false });
    const byId = new Map(tasks.map((task) => [task.id.toUpperCase(), task]));
    let archived = 0;
    const now = Date.now();
    for (const task of tasks) {
      if (task.column === "archived") continue;
      const classified = this.classifyMetaTask(task);
      const targetTaskId = this.resolveMetaTargetTaskId(byId, task);
      if (!classified.isMeta || !targetTaskId) {
        this.clearReasonMemo(this.metaStalledSkipAuditMemo, task.id);
        continue;
      }
      const chainDepth = this.computeMetaChainDepth(byId, targetTaskId);
      const ageMs = now - Date.parse(task.columnMovedAt ?? task.updatedAt);
      if (chainDepth < 2 && (!Number.isFinite(ageMs) || ageMs < thresholdMs)) {
        this.clearReasonMemo(this.metaStalledSkipAuditMemo, task.id);
        continue;
      }
      const target = byId.get(targetTaskId.toUpperCase());
      const targetMovedAtMs = Date.parse(target?.columnMovedAt ?? target?.updatedAt ?? "");
      const targetStalled = !Number.isFinite(targetMovedAtMs) || (now - targetMovedAtMs >= thresholdMs);
      if (chainDepth < 2 && !targetStalled) {
        this.clearReasonMemo(this.metaStalledSkipAuditMemo, task.id);
        continue;
      }
      const guardResult = await this.evaluateMetaAutoArchiveGuards(task);
      if (guardResult.block) {
        if (this.shouldEmitReasonMemo(this.metaStalledSkipAuditMemo, task.id, guardResult.reasons)) {
          const auditor = createRunAuditor(this.store, { runId: generateSyntheticRunId("fn4890-meta", task.id), agentId: "self-healing", taskId: task.id, phase: "auto-archive-meta-stalled-skipped" });
          await auditor.database({
            type: "task:auto-archive-meta-stalled-skipped",
            target: task.id,
            metadata: { taskId: task.id, targetTaskId, chainDepth, stalledMs: Math.max(ageMs, 0), blockedBy: guardResult.reasons },
          });
        }
        log.log(`[self-healing] skipped meta-stalled auto-archive for ${task.id}: ${guardResult.reasons.join(",")}`);
        continue;
      }
      this.clearReasonMemo(this.metaStalledSkipAuditMemo, task.id);
      try {
        await this.store.logEntry(task.id, `Auto-archived meta-task (FN-4890): superseded — not spawning further meta; rely on self-heal on target ${targetTaskId}`);
        await this.archiveMetaTask(task.id);
        const auditor = createRunAuditor(this.store, { runId: generateSyntheticRunId("fn4890-meta", task.id), agentId: "self-healing", taskId: task.id, phase: "auto-archive-meta-stalled" });
        await auditor.database({ type: "task:auto-archived-meta-stalled", target: task.id, metadata: { taskId: task.id, targetTaskId, chainDepth, stalledMs: Math.max(ageMs, 0) } });
        archived++;
      } catch (err: unknown) {
        log.error(`autoArchiveStalledMetaTasks failed for ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return archived;
  }

  /**
   * #1401: periodic transitionPending recovery sweep. Flag-ON only — when
   * `workflowColumns` is OFF the legacy path never writes markers, so there is
   * nothing to recover. Delegates to the store's idempotent recovery method
   * (a no-op when no stale markers exist), keeping capacity counts honest after
   * a crash between the in-txn marker write and the post-commit clear.
   */
  async runStaleTransitionPendingSweep(): Promise<void> {
    const settings = await this.store.getSettings();
    if (!isWorkflowColumnsEnabled(settings)) return;
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

      const db = this.store.getDatabase();
      // FN-5147 invariant: only rows with deletedAt are eligible, so live
      // in-review tasks (including autoMerge: false workflows) are never moved.
      const candidates = db.prepare("SELECT id, \"column\" AS column FROM tasks WHERE deletedAt IS NOT NULL AND \"column\" != 'archived'").all() as Array<{ id: string; column: Task["column"] }>;
      if (candidates.length === 0) return { reconciled: 0 };

      let reconciled = 0;
      const now = new Date().toISOString();
      const auditor = createRunAuditor(this.store, {
        runId: generateSyntheticRunId("fn5566-soft-delete-column", "global"),
        agentId: "self-healing",
        phase: "reconcile-soft-delete-column-drift",
      });

      for (const candidate of candidates) {
        db.prepare("UPDATE tasks SET \"column\" = 'archived', updatedAt = ? WHERE id = ?").run(now, candidate.id);
        await auditor.database({
          type: "task:soft-delete-column-reconciled",
          target: candidate.id,
          metadata: { previousColumn: candidate.column },
        });
        log.log(`[self-heal] reconcile-soft-delete-column-drift: ${candidate.id} previous=${candidate.column} → archived`);
        reconciled++;
      }

      if (reconciled > 0) {
        db.bumpLastModified();
      }

      return { reconciled };
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

      const todoTasks = await this.store.listTasks({ column: "todo" });
      const inProgressTasks = await this.store.listTasks({ column: "in-progress" });
      const inReviewTasks = await this.store.listTasks({ column: "in-review" });
      const blockedTasks = [
        ...todoTasks,
        ...inProgressTasks,
        ...inReviewTasks.filter((task) => !task.paused),
      ].filter((task) => typeof task.blockedBy === "string" && task.blockedBy.trim().length > 0);
      const queuedDependencyTasks = todoTasks.filter(
        (task) => task.status === "queued" && (task.dependencies.length > 0 || Boolean(task.overlapBlockedBy)),
      );

      if (blockedTasks.length === 0 && queuedDependencyTasks.length === 0) return 0;

      const allTasks = await this.store.listTasks({ includeArchived: true });
      const taskById = new Map(allTasks.map((task) => [task.id, task]));

      let recovered = 0;
      const todoTaskIds = new Set(todoTasks.map((task) => task.id));
      const blockedTaskIds = new Set(blockedTasks.map((task) => task.id));
      const queuedDependencyTaskIds = new Set(queuedDependencyTasks.map((task) => task.id));
      const candidates = new Map<string, typeof todoTasks[number]>();
      for (const task of blockedTasks) candidates.set(task.id, task);
      for (const task of queuedDependencyTasks) candidates.set(task.id, task);

      for (const task of candidates.values()) {
        const blockerId = task.blockedBy;

        const unresolvedDeps = task.dependencies.filter((depId) => {
          const dep = taskById.get(depId);
          // listTasks excludes soft-deleted rows, so missing dependency IDs are
          // treated as resolved here by design.
          return dep && !dep.deletedAt && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";
        });
        const overlapBlocker = task.overlapBlockedBy ? taskById.get(task.overlapBlockedBy) : undefined;
        const hasActiveOverlapBlocker = Boolean(
          overlapBlocker
          && (overlapBlocker.column === "in-progress" || (overlapBlocker.column === "in-review" && !overlapBlocker.paused)),
        );

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
          } else if (blocker.column === "done") {
            reasonCode = "blocker-done";
            reason = `blocker ${blockerId} is done`;
          } else if (blocker.column === "archived") {
            reasonCode = "blocker-archived";
            reason = `blocker ${blockerId} is archived`;
          } else if (blocker.column === "todo") {
            reasonCode = "blocker-moved-todo";
            reason = `blocker ${blockerId} moved to todo`;
          } else if (blocker.column === "in-review" && blocker.paused) {
            reasonCode = "in-review-paused";
            reason = `blocker ${blockerId} in-review + paused`;
          } else if (
            blocker.column === "in-review" &&
            blocker.status === "failed" &&
            (blocker.mergeRetries ?? 0) >= MAX_AUTO_MERGE_RETRIES
          ) {
            reasonCode = "failed-retry-exhausted";
            reason = `blocker ${blockerId} in-review + failed (mergeRetries ${blocker.mergeRetries ?? 0}/${MAX_AUTO_MERGE_RETRIES})`;
          } else if (
            blocker.column === "in-review" &&
            blocker.status === "failed" &&
            isMissingWorktreeSessionStartFailure(blocker.error)
          ) {
            reasonCode = "missing-worktree-session-start";
            reason = `blocker ${blockerId} in-review + failed (missing-worktree session start)`;
          } else if (
            blocker.column === "in-review" &&
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
              if (todoTaskIds.has(task.id)) {
                if (unresolvedDeps.length > 0) {
                  const nextBlocker = unresolvedDeps[0]!;
                  if (nextBlocker === blockerId) {
                    continue;
                  }
                  await this.store.updateTask(task.id, { blockedBy: nextBlocker, status: "queued" });
                  await this.store.logEntry(task.id, `Auto-recovered (FN-5488): refreshed stale blockedBy — blocker=${blockerId} blockerStatus=${blocker?.status ?? "none"} reason=${reasonCode ?? "unspecified"}; ${reason}; now blocked by ${nextBlocker}`);
                } else if (hasActiveOverlapBlocker) {
                  await this.store.updateTask(task.id, { blockedBy: null, status: "queued" });
                  await this.store.logEntry(task.id, `Auto-recovered (FN-5488): preserved queued status — blocker=${blockerId} blockerStatus=${blocker?.status ?? "none"} reason=${reasonCode ?? "unspecified"}; still blocked by file scope overlap with ${task.overlapBlockedBy}`);
                } else {
                  await this.store.updateTask(task.id, { blockedBy: null, overlapBlockedBy: null, status: null });
                  await this.store.logEntry(task.id, `Auto-recovered (FN-5488): cleared stale blockedBy — blocker=${blockerId} blockerStatus=${blocker?.status ?? "none"} reason=${reasonCode ?? "unspecified"}; ${reason}`);
                }
              } else {
                await this.store.updateTask(task.id, { blockedBy: null });
                await this.store.logEntry(task.id, `Auto-recovered (FN-4091): cleared stale blockedBy — ${reason}`);
              }
              recovered++;
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
                await this.store.updateTask(task.id, { blockedBy: null, status: "queued" });
                await this.store.logEntry(task.id, `Auto-recovered: preserved queued status — still blocked by file scope overlap with ${task.overlapBlockedBy}`);
              } else {
                // FN-5434: routine scheduler↔self-healing queued-status churn should stay silent; keep state cleanup only.
                await this.store.updateTask(task.id, { blockedBy: null, overlapBlockedBy: null, status: null });
              }
              if (hasActiveOverlapBlocker) {
                recovered++;
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

  private async recordIntegrityAudit(taskId: string, mutationType: "task:finalize-unproven-blocked" | "task:finalize-lost-work-blocked" | "task:integrity-reconcile-modified-files" | "task:integrity-warning" | "task:auto-recover-stale-merger-status", metadata: Record<string, unknown>): Promise<void> {
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
      const done = await this.store.listTasks({ column: "done", slim: true });
      const archived = await this.store.listTasks({ column: "archived", slim: true });
      const candidates = [...done, ...archived].filter((task) => {
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
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((t) =>
        t.column === "in-review" &&
        allowsAutoMergeProcessing(t, settings) &&
        !t.paused &&
        !isSharedBranchGroupMemberIntegration(t) &&
        Boolean(t.worktree) &&
        t.mergeDetails?.mergeConfirmed !== true &&
        t.status !== "merging" &&
        t.status !== "merging-pr" &&
        t.status !== "awaiting-user-review" &&
        t.status !== "failed" &&
        getTaskMergeBlocker(t) === undefined,
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
          await this.store.moveTask(task.id, "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
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
            await this.store.moveTask(task.id, "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
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

        const movedTask = await this.store.moveTask(task.id, "done");
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
      const tasks = await this.store.listTasks({ column: "done", slim: true });
      const candidates = tasks.filter((task) =>
        task.column === "done" &&
        (!task.mergeDetails?.commitSha || task.mergeDetails.commitSha.trim().length === 0) &&
        (task.modifiedFiles?.length ?? 0) > 0,
      ).slice(0, DONE_TASK_INTEGRITY_SWEEP_LIMIT);

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
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });

      const mergeable = tasks.filter((t) =>
        t.column === "in-review" &&
        allowsAutoMergeProcessing(t, settings) &&
        !t.paused &&
        t.status !== "failed" &&
        // Exclude transient merge statuses. Active merges should be left alone;
        // stale ones are handled by recoverStaleMergingStatus().
        t.status !== "merging" &&
        t.status !== "merging-pr" &&
        Boolean(t.worktree) &&
        t.mergeDetails?.mergeConfirmed !== true &&
        t.mergeDetails?.noOpMerge !== true &&
        !hasTerminalInvalidDoneTransition(t) &&
        // Mirror ProjectEngine.canMergeTask retry gate. If retries are already
        // exhausted, re-enqueueing here is a no-op and each recovery log write
        // refreshes updatedAt, preventing cooldown-based retries from ever
        // becoming eligible. Also skip tasks explicitly tagged as no-op merges
        // in case updateTask(moveTask) is briefly out-of-order during recovery.
        (t.mergeRetries ?? 0) < MAX_AUTO_MERGE_RETRIES &&
        getTaskMergeBlocker(t) === undefined,
      );

      const inReviewIds = new Set(tasks.map((task) => task.id));
      const mergeableIds = new Set(mergeable.map((task) => task.id));
      for (const taskId of [...this.mergeStarvationDrops.keys()]) {
        if (!inReviewIds.has(taskId) || !mergeableIds.has(taskId)) {
          this.mergeStarvationDrops.delete(taskId);
        }
      }

      if (mergeable.length === 0) return 0;

      log.warn(`Found ${mergeable.length} mergeable review task(s) stuck in in-review`);

      // Prefer the engine's merge queue so `mergeStrategy` (direct vs.
      // pull-request) is honored. Fall back to a direct store merge only
      // when no enqueue callback is wired (standalone/tests).
      const enqueueMerge = this.options.enqueueMerge;
      let recovered = 0;
      for (const task of mergeable) {
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
   * active executor run, `executor.handleWorkflowStepFailure` retries up to
   * `MAX_WORKFLOW_STEP_RETRIES` times in-session. If all retries exhaust the
   * task ends up in `in-review` with the failed workflow step result still on
   * record, which `getTaskMergeBlocker` correctly treats as a merge block —
   * leaving the task stranded with no live session to un-stick it.
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

      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      // Resolve the per-task effective `maxPostReviewFixes` (U3, KTD-3) — this is a
      // cross-task recovery sweep, so the budget is resolved per task rather than
      // from a single global read. Behavior-inert when nothing is customized.
      const maxFixesByTask = new Map<string, number>();
      for (const task of tasks) {
        const eff = await mergeEffectiveSettings(this.store, task, settings);
        maxFixesByTask.set(task.id, eff.maxPostReviewFixes ?? 1);
      }
      const maxFixesFor = (taskId: string): number => maxFixesByTask.get(taskId) ?? 1;

      const candidates = tasks.filter((task) => {
        if (task.column !== "in-review") return false;
        if (!allowsAutoMergeProcessing(task, settings)) return false;
        if (task.paused) return false;
        // Preserve terminal/human-handoff statuses (failed, awaiting-user-review,
        // merging, etc.). Only revive tasks that are otherwise idle.
        if (task.status) return false;
        if (executingIds.has(task.id)) return false;
        const maxFixes = maxFixesFor(task.id);
        if (!Number.isFinite(maxFixes) || maxFixes <= 0) return false;
        if ((task.postReviewFixCount ?? 0) >= maxFixes) return false;

        // Must have at least one failed pre-merge workflow step result.
        const hasFailedPreMerge = (task.workflowStepResults ?? []).some(
          (r) => (r.phase || "pre-merge") === "pre-merge" && r.status === "failed",
        );
        if (!hasFailedPreMerge) return false;

        // Merge must be blocked *specifically* by the failed pre-merge step —
        // not by an unrelated condition (incomplete steps, etc.) that is
        // already handled by a dedicated scan.
        const blocker = getTaskMergeBlocker(task);
        if (blocker !== "task has failed pre-merge workflow steps") return false;

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
        const nextCount = (task.postReviewFixCount ?? 0) + 1;
        const maxFixes = maxFixesFor(task.id);
        try {
          // Increment the counter BEFORE delegating so that even if the
          // executor path crashes or races, the budget is still consumed and
          // we can't enter an infinite revival loop.
          await this.store.updateTask(task.id, { postReviewFixCount: nextCount });
          await this.store.logEntry(
            task.id,
            `Auto-reviving in-review task with failed pre-merge workflow step (attempt ${nextCount}/${maxFixes})`,
          );
          const sentBack = await recoverFn(task);
          if (sentBack) {
            log.log(`Revived ${task.id}: sent back for fix (${nextCount}/${maxFixes})`);
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
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const staleIncomplete = tasks.filter((task) =>
        task.column === "in-review" &&
        allowsAutoMergeProcessing(task, settings) &&
        !task.paused &&
        !task.status &&
        task.steps.length > 0 &&
        task.steps.some((step) => NON_TERMINAL_STEP_STATUSES.has(step.status)) &&
        now - new Date(task.columnMovedAt ?? task.updatedAt).getTime() >= timeoutMs
      );

      if (staleIncomplete.length === 0) return 0;

      log.warn(`Found ${staleIncomplete.length} stale in-review task(s) with incomplete steps`);

      let recovered = 0;
      for (const task of staleIncomplete) {
        try {
          const proof = await this.evaluateBackwardMoveTripleProof(task, {
            stage: "stale-incomplete-review",
            graceMs: timeoutMs,
            stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
            reason: "stale-incomplete-review-candidate",
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
          await this.store.moveTask(task.id, "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
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
      const cycleStartMs = Date.now();
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!timeoutMs || timeoutMs <= 0) return 0;

      const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
      const executingTaskIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const tasks = await this.store.listTasks({ column: "in-review", slim: false });
      let surfaced = 0;

      for (const task of tasks) {
        if (task.deletedAt) continue;
        if (!allowsAutoMergeProcessing(task, settings)) continue;
        const signal = getInReviewStallReason(task, {
          now: cycleStartMs,
          activeMergeTaskId,
          executingTaskIds,
          staleMergingMinAgeMs: this.options.staleMergingStatusMinAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS,
          maxAutoMergeRetries: MAX_AUTO_MERGE_RETRIES,
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
        if (!signal) continue;
        if (this.isMergeLaneOwned(task.id)) continue;

        if (Date.parse(task.updatedAt) >= cycleStartMs) {
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

  private getDependencyBlockedTodoReporter(): DependencyBlockedTodoReporter | null {
    if (this.dependencyBlockedTodoReporter) {
      return this.dependencyBlockedTodoReporter;
    }
    const projectId = this.options.getProjectId?.();
    if (!projectId) {
      return null;
    }
    this.dependencyBlockedTodoReporter = new DependencyBlockedTodoReporter({
      store: this.store,
      projectId,
      now: () => Date.now(),
    });
    return this.dependencyBlockedTodoReporter;
  }

  async surfaceDependencyBlockedTodos(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      if (settings.dependencyBlockedTodoReportEnabled === false) return 0;

      const reporter = this.getDependencyBlockedTodoReporter();
      if (!reporter) return 0;
      const result = await reporter.report();
      return result.groupCount ?? 0;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Dependency-blocked todo surfacing failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Surface quiet-window backlog-health diagnostics for unpaused in-review tasks.
   *
   * Non-overlap contract:
   * - `surfaceStalePausedReviews()` owns paused in-review tasks.
   * - `surfaceInReviewStalls()` owns reason-driven in-review stalls.
   *
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async surfaceInReviewStalled(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;
      const cycleStartMs = Date.now();
      const thresholdMs = settings.inReviewStalledThresholdMs;
      if (!thresholdMs || thresholdMs <= 0) return 0;

      const tasks = await this.store.listTasks({ column: "in-review", slim: false });
      const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
      const executingTaskIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      let surfaced = 0;

      for (const task of tasks) {
        if (task.deletedAt) continue;
        if (!allowsAutoMergeProcessing(task, settings)) continue;
        if (task.paused === true) continue;
        if (task.id === activeMergeTaskId || executingTaskIds.has(task.id)) continue;
        if (this.isMergeLaneOwned(task.id)) continue;

        const signal = getInReviewStalledSignal(task, {
          now: cycleStartMs,
          thresholdMs,
          autoMerge: true,
          activeMergeTaskId,
          executingTaskIds,
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
        if (!signal) continue;

        if (Date.parse(task.updatedAt) >= cycleStartMs) {
          continue;
        }

        const previous = [...(task.log ?? [])]
          .reverse()
          .find((entry) => entry.action.startsWith("In-review stalled surfaced ["));
        if (previous) {
          const parsed = /^In-review stalled surfaced \[([^\]]+)\]/.exec(previous.action);
          const previousCode = parsed?.[1];
          const previousAt = Date.parse(previous.timestamp);
          if (Number.isFinite(previousAt) && previousAt >= cycleStartMs - thresholdMs && previousCode === signal.code) {
            continue;
          }
        }

        const hours = (signal.quietMs / 3_600_000).toFixed(1);
        await this.store.logEntry(
          task.id,
          `In-review stalled surfaced [${signal.code}]: quiet ${hours}h beyond ${(thresholdMs / 3_600_000).toFixed(1)}h threshold; disposition options — nudge review, retry, archive, or create follow-up task. lastActivitySource=${signal.lastActivitySource}`,
        );
        surfaced += 1;
      }

      return surfaced;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`In-review stalled surfacing failed: ${errorMessage}`);
      return 0;
    }
  }

  async surfaceStalePausedReviews(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const cycleStartMs = Date.now();
      const thresholdMs = settings.stalePausedReviewThresholdMs;
      if (!thresholdMs || thresholdMs <= 0) return 0;

      const tasks = await this.store.listTasks({ column: "in-review", slim: false });
      let surfaced = 0;

      for (const task of tasks) {
        if (task.deletedAt) continue;
        if (task.paused !== true) continue;
        const signal = getStalePausedReviewSignal(task, {
          now: cycleStartMs,
          thresholdMs,
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
        if (!signal) continue;
        if (Date.parse(task.updatedAt) >= cycleStartMs) continue;

        const previous = [...(task.log ?? [])]
          .reverse()
          .find((entry) => entry.action.startsWith("Stale paused review surfaced ["));
        if (previous) {
          const parsed = /^Stale paused review surfaced \[([^\]]+)\]/.exec(previous.action);
          const previousCode = parsed?.[1];
          const previousAt = Date.parse(previous.timestamp);
          if (Number.isFinite(previousAt) && previousAt >= cycleStartMs - thresholdMs && previousCode === signal.code) {
            continue;
          }
        }

        const hours = (signal.ageMs / 3_600_000).toFixed(1);
        await this.store.logEntry(
          task.id,
          `Stale paused review surfaced [${signal.code}]: paused ${hours}h; disposition options — unpause, retry, archive, or create follow-up task. pausedReason=${signal.pausedReason ?? "none"}`,
        );
        surfaced += 1;
      }

      return surfaced;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Stale paused review surfacing failed: ${errorMessage}`);
      return 0;
    }
  }

  async surfaceStalePausedTodos(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const cycleStartMs = Date.now();
      const thresholdMs = settings.stalePausedTodoThresholdMs;
      if (!thresholdMs || thresholdMs <= 0) return 0;

      const tasks = await this.store.listTasks({ column: "todo", slim: false });
      let surfaced = 0;

      for (const task of tasks) {
        if (task.paused !== true) continue;
        const signal = getStalePausedTodoSignal(task, {
          now: cycleStartMs,
          thresholdMs,
          engineActiveSinceMs: settings.engineActiveSinceMs,
          engineActivationGraceMs: settings.engineActivationGraceMs,
        });
        if (!signal) continue;
        if (Date.parse(task.updatedAt) >= cycleStartMs) continue;

        const previous = [...(task.log ?? [])]
          .reverse()
          .find((entry) => entry.action.startsWith("Stale paused todo surfaced ["));
        if (previous) {
          const parsed = /^Stale paused todo surfaced \[([^\]]+)\]/.exec(previous.action);
          const previousCode = parsed?.[1];
          const previousAt = Date.parse(previous.timestamp);
          if (Number.isFinite(previousAt) && previousAt >= cycleStartMs - thresholdMs && previousCode === signal.code) {
            continue;
          }
        }

        const hours = (signal.ageMs / 3_600_000).toFixed(1);
        await this.store.logEntry(
          task.id,
          `Stale paused todo surfaced [${signal.code}]: paused ${hours}h beyond ${(thresholdMs / 3_600_000).toFixed(1)}h threshold; disposition options — unpause, move to triage, archive, or create follow-up task. pausedReason=${signal.pausedReason ?? "none"}`,
        );
        surfaced += 1;
      }

      return surfaced;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Stale paused todo surfacing failed: ${errorMessage}`);
      return 0;
    }
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
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const ghosts = tasks.filter((task) =>
        task.column === "in-review" &&
        allowsAutoMergeProcessing(task, settings) &&
        !task.paused &&
        !executingIds.has(task.id) &&
        !this.isMergeLaneOwned(task.id) &&
        !(task.status && GHOST_REVIEW_PRESERVED_STATUSES.has(task.status)) &&
        // Confirmed merges belong in `done` (handled by `recoverMergedReviewTasks`).
        task.mergeDetails?.mergeConfirmed !== true &&
        now - new Date(task.columnMovedAt ?? task.updatedAt).getTime() >= timeoutMs
      );

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
          await this.store.moveTask(task.id, "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
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

      const slim = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = slim.filter((t) =>
        t.column === "in-review"
        && allowsAutoMergeProcessing(t, settings)
        && t.status === "failed"
        && (t.mergeRetries ?? 0) >= MAX_AUTO_MERGE_RETRIES
        && typeof t.error === "string"
        && t.error.length > 0
        && classifyTransientMergeError(t.error) !== null,
      );
      if (candidates.length === 0) return 0;

      log.warn(
        `Found ${candidates.length} in-review task(s) with transient merge failures stuck at mergeRetries=${MAX_AUTO_MERGE_RETRIES}; attempting auto-recovery`,
      );

      let recovered = 0;
      for (const slimTask of candidates) {
        const task = await this.store.getTask(slimTask.id).catch(() => null);
        if (!task) continue;
        // Re-check selector on the full row — the slim snapshot is best-effort
        // and may be stale once we await.
        if (
          task.column !== "in-review"
          || task.status !== "failed"
          || (task.mergeRetries ?? 0) < MAX_AUTO_MERGE_RETRIES
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
          publishWorkflowRecoveryEvent(this.store, {
            taskId: task.id,
            kind: "transient-merge-failure",
            source: "self-healing",
            reason: errorSnippet,
          });
        } catch (eventErr) {
          log.warn(
            `recoverTransientMergeFailures: workflow recovery event publish failed for ${task.id}: ${
              eventErr instanceof Error ? eventErr.message : String(eventErr)
            }`,
          );
        }
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

      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((task) =>
        task.column === "in-review" &&
        allowsAutoMergeProcessing(task, settings) &&
        !task.paused &&
        Boolean(task.status && ACTIVE_MERGE_STATUSES.has(task.status)) &&
        this.isPastInterruptedMergeGrace(task, timeoutMs),
      );

      if (candidates.length === 0) return 0;

      log.warn(`Found ${candidates.length} stale merging task(s) in in-review`);

      let recovered = 0;
      for (const task of candidates) {
        try {
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
            const movedTask = await this.store.moveTask(task.id, "done");
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

          await this.store.updateTask(task.id, { status: null, error: null });
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

  private async readShortstatForSha(
    sha: string,
    rebaseBaseSha?: string,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number } | null> {
    try {
      const command = rebaseBaseSha
        ? `git diff --shortstat ${shellQuote(`${rebaseBaseSha}..${sha}`)}`
        : `git show --shortstat --format= ${shellQuote(sha)}`;
      const stats = await execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
      const parsed = parseShortstat(stats.stdout);
      return {
        filesChanged: parsed.filesChanged ?? 0,
        insertions: parsed.insertions ?? 0,
        deletions: parsed.deletions ?? 0,
      };
    } catch {
      return null;
    }
  }

  private async readLandedFilesForSha(sha: string, rebaseBaseSha?: string): Promise<string[] | null> {
    try {
      const command = rebaseBaseSha
        ? `git diff --name-only ${shellQuote(`${rebaseBaseSha}..${sha}`)}`
        : `git show --name-only --format= ${shellQuote(sha)}`;
      const result = await execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
      const files = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return files.length > 0 ? Array.from(new Set(files)) : [];
    } catch {
      return null;
    }
  }

  async recoverDoneTaskMergeMetadata(): Promise<number> {
    try {
      const tasks = await this.store.listTasks({ column: "done", slim: true });
      const candidates = tasks.filter((task) => {
        if (task.column !== "done" || task.paused) return false;
        if (task.mergeDetails?.commitSha) return true;
        return Boolean(task.baseCommitSha);
      });
      if (candidates.length === 0) return 0;

      let repaired = 0;
      for (const task of candidates) {
        if (task.mergeDetails?.landedFilesAttributionRestricted || task.mergeDetails?.noOpVerifiedShortCircuit) {
          log.log(`recoverDoneTaskMergeMetadata: skipped ${task.id} — attribution-restricted`);
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
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });

      const mergedButNotDone = tasks.filter((t) =>
        !t.deletedAt &&
        t.column === "in-review" &&
        allowsAutoMergeProcessing(t, settings) &&
        t.mergeDetails?.mergeConfirmed === true,
      );

      if (mergedButNotDone.length === 0) return 0;

      log.warn(`Found ${mergedButNotDone.length} merged task(s) stuck in in-review`);

      let recovered = 0;
      for (const task of mergedButNotDone) {
        try {
          const hardBlocker = getTaskHardMergeBlocker({
            ...task,
            // Merge-confirmed tasks have already landed. Treat stale merge
            // in-flight statuses as soft state to clear during finalization,
            // not hard blockers that park an otherwise confirmed merge as failed.
            paused: false,
            status: task.status === "merging" || task.status === "merging-pr" ? undefined : task.status,
            error: undefined,
            steps: task.steps ?? [],
            workflowStepResults: task.workflowStepResults,
          });
          if (hardBlocker) {
            await this.store.updateTask(task.id, {
              status: "failed",
              error: `Merge confirmed but finalization blocked: ${hardBlocker}`,
            });
            await this.store.logEntry(
              task.id,
              `Auto-recovery skipped: merge confirmed but finalization blocked — ${hardBlocker}`,
            );
            continue;
          }

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
          };
          await this.store.updateTask(task.id, {
            paused: false,
            status: null,
            error: null,
            mergeRetries: 0,
            ...(mergeTarget.source ? {
              mergeDetails: {
                ...(task.mergeDetails || {}),
                mergeTargetBranch: task.mergeDetails?.mergeTargetBranch ?? mergeTarget.branch,
                mergeTargetSource: task.mergeDetails?.mergeTargetSource ?? mergeTarget.source,
              },
            } : {}),
          });
          await this.recordSelfHealingBranchGroupMemberLanding(task, mergeTarget, "recover-merged-review");
          const movedTask = await this.store.moveTask(task.id, "done");
          this.emitTaskMerged(movedTask, { mergeConfirmed: true });
          await this.store.logEntry(
            task.id,
            `Auto-finalized from in-review/paused: content proven via mergeConfirmed metadata. Cleared soft state paused=${clearedFlags.paused}, status=${clearedFlags.status}, error=${clearedFlags.error}`,
          );
          try {
            const auditor = createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", task.id),
              agentId: "self-healing",
              taskId: task.id,
              taskLineageId: task.lineageId,
              phase: "recover-merged-review",
            });
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
      const now = Date.now();
      const inReview = await this.store.listTasks({ column: "in-review", slim: true });
      const triage = await this.store.listTasks({ column: "triage", slim: true });
      const todo = await this.store.listTasks({ column: "todo", slim: true });
      const inProgress = await this.store.listTasks({ column: "in-progress", slim: true });

      const dependentsByBlocker = new Map<string, Task[]>();
      for (const task of [...triage, ...todo, ...inProgress]) {
        if (!task.blockedBy) continue;
        const dependents = dependentsByBlocker.get(task.blockedBy) ?? [];
        dependents.push(task);
        dependentsByBlocker.set(task.blockedBy, dependents);
      }

      const candidates = inReview.filter((task) => {
        if (task.deletedAt) return false;
        const cooldownStart = this.deadlockRecoveryCooldown.get(task.id) ?? 0;
        const cooldownElapsed = now - cooldownStart;
        const hasBlockedDependents = (dependentsByBlocker.get(task.id) ?? []).some(
          (dep) => dep.column === "triage" || dep.column === "todo",
        );
        return task.column === "in-review" &&
          allowsAutoMergeProcessing(task, settings) &&
          !task.paused &&
          task.status === "failed" &&
          (task.mergeRetries ?? 0) >= MAX_AUTO_MERGE_RETRIES &&
          task.mergeDetails?.mergeConfirmed !== true &&
          (hasBlockedDependents || Boolean(task.worktree)) &&
          cooldownElapsed >= DEADLOCK_RECOVERY_COOLDOWN_MS;
      });

      if (candidates.length === 0) return 0;

      let recovered = 0;
      for (const task of candidates) {
        if (task.deletedAt) continue;
        const blockedDependents = dependentsByBlocker.get(task.id) ?? [];
        const blockedTaskIds = blockedDependents.map((dep) => dep.id);
        try {
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
            const movedTask = await this.store.moveTask(task.id, "done");
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
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((task) =>
        task.column === "in-review" &&
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

          const hardBlocker = getTaskHardMergeBlocker({
            ...task,
            steps: task.steps ?? [],
            workflowStepResults: task.workflowStepResults,
          });
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
          const movedTask = await this.store.moveTask(task.id, "done");
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
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((task) =>
        !task.deletedAt &&
        task.column === "in-review" &&
        allowsAutoMergeProcessing(task, settings) &&
        task.status === "failed" &&
        (task.mergeRetries ?? 0) >= MAX_AUTO_MERGE_RETRIES &&
        task.mergeDetails?.mergeConfirmed !== true &&
        !executingIds.has(task.id),
      );

      if (candidates.length === 0) return 0;

      let recovered = 0;
      for (const task of candidates) {
        try {
          const mergeTarget = await this.resolveSelfHealingMergeTarget(task, settings, "recover-already-merged-review");
          const baseBranch = mergeTarget.branch;
          if (!baseBranch) continue;

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
            prNumber: getPrimaryPrInfo(task)?.number,
            mergeTargetBranch: mergeTarget.branch,
            mergeTargetSource: mergeTarget.source,
          };

          const hardBlocker = getTaskHardMergeBlocker({
            ...task,
            steps: task.steps ?? [],
            workflowStepResults: task.workflowStepResults,
          });
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
          const movedTask = await this.store.moveTask(task.id, "done");
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
      const tasks = await this.store.listTasks({ column: "in-review", slim: false });
      let recovered = 0;

      for (const task of tasks) {
        if (task.column !== "in-review" || task.deletedAt) continue;
        if (!allowsAutoMergeProcessing(task, settings)) continue;
        if (task.paused || task.userPaused) continue;
        if (task.status !== "failed") continue;
        if (this.options.isTaskActive?.(task.id)) continue;
        if (!(task.steps ?? []).every((step) => step.status === "done" || step.status === "skipped")) continue;
        const doneMarker = [...(task.log ?? [])].reverse().find((entry) => entry.action === "Task marked done by agent");
        if (!doneMarker) continue;
        if (getTaskHardMergeBlocker({ ...task, status: undefined, error: undefined, steps: task.steps ?? [], workflowStepResults: task.workflowStepResults })) continue;

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

  /**
   * Skips tasks not eligible for auto-merge processing (global `autoMerge`
   * off without an explicit per-task `autoMerge: true` override) — PR-based
   * review flow owns lifecycle until human merge.
   */
  async recoverCompletionHandoffLimbo(): Promise<void> {
    const settings = await this.store.getSettings();
    if (settings.globalPause || settings.enginePaused) return;
    const tasks = await this.store.listTasks({ column: "in-review", slim: false });
    const now = Date.now();

    for (const task of tasks) {
      if (task.column !== "in-review" || task.paused) continue;
      if (!allowsAutoMergeProcessing(task, settings)) continue;
      if (this.isFalseCompletionHandoffExhaustionWhileMergeOwned(task)) {
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
      if (this.isMergeLaneOwned(task.id)) continue;
      if (getTaskMergeBlocker(task) !== undefined) continue;

      const doneMarker = [...(task.log ?? [])].reverse().find((entry) => entry.action === "Task marked done by agent");
      if (!doneMarker?.timestamp) continue;
      const markerTs = Date.parse(doneMarker.timestamp);
      if (!Number.isFinite(markerTs)) continue;
      const ageMs = now - markerTs;
      if (ageMs < COMPLETION_HANDOFF_LIMBO_GRACE_MS) continue;

      const currentCount = task.completionHandoffLimboRecoveryCount ?? 0;
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
        log.log(
          `recoverCompletionHandoffLimbo: skipped recovery count for ${task.id} because merge requeue was not accepted`,
        );
        continue;
      }

      await this.store.updateTask(task.id, {
        completionHandoffLimboRecoveryCount: currentCount + 1,
      });
      try {
        publishWorkflowRecoveryEvent(this.store, {
          taskId: task.id,
          kind: "completion-handoff-limbo",
          source: "self-healing",
          reason: `ageMs=${ageMs}; attempts=${currentCount + 1}`,
        });
      } catch (eventErr) {
        log.warn(
          `recoverCompletionHandoffLimbo: workflow recovery event publish failed for ${task.id}: ${
            eventErr instanceof Error ? eventErr.message : String(eventErr)
          }`,
        );
      }

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

  private async isBranchTipMisboundToTask(input: {
    branch: string;
    taskId: string;
    lineageId?: string;
    baseBranch: string;
  }): Promise<{ misbound: boolean; branchTip: string; landed: Awaited<ReturnType<typeof findAlreadyMergedTaskCommit>> }> {
    const { branch, taskId, lineageId, baseBranch } = input;
    const { stdout: bodyOut } = await execAsync(`git log -1 --format=%B ${shellQuote(branch)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const body = bodyOut;
    const hasTaskId = body.includes(`Fusion-Task-Id: ${taskId}`);
    const hasLineage = lineageId ? body.includes(`Fusion-Task-Lineage: ${lineageId}`) : false;
    const { stdout: tipOut } = await execAsync(`git rev-parse ${shellQuote(branch)}`, {
      cwd: this.options.rootDir,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    const branchTip = tipOut.trim();
    const landed = await this.findAlreadyMergedTaskCommit({
      taskId,
      lineageId,
      repoDir: this.options.rootDir,
      baseBranch,
      taskBranch: branch,
    });
    return { misbound: !hasTaskId && !hasLineage, branchTip, landed };
  }

  async recoverBranchMisboundInReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((task) =>
        task.column === "in-review" &&
        Boolean(task.branch) &&
        task.mergeDetails?.mergeConfirmed !== true &&
        !executingIds.has(task.id),
      );

      let recovered = 0;
      for (const task of candidates) {
        try {
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
          const movedTask = await this.store.moveTask(task.id, "done");
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
      const inReview = await this.store.listTasks({ column: "in-review", slim: true });
      const inProgress = await this.store.listTasks({ column: "in-progress", slim: true });
      const candidates = [
        ...inReview.filter((task) =>
          task.column === "in-review" &&
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
          task.column === "in-progress" &&
          allowsAutoMergeProcessing(task, settings) &&
          task.paused === true &&
          (task.pausedReason === "branch-cross-contamination" || task.pausedReason === "branch-conflict-unrecoverable") &&
          Boolean(task.branch) &&
          Boolean(task.worktree) &&
          !task.userPaused &&
          !executingIds.has(task.id),
        ),
      ];

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
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });

      const misclassified = tasks.filter((t) =>
        t.column === "in-review" &&
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

  async auditNoCommitsExpectedCandidates(): Promise<number> {
    try {
      const inReviewTasks = await this.store.listTasks({ column: "in-review", slim: true });
      const allTasks = await this.store.listTasks({ slim: true });
      const failedTasks = allTasks.filter((task) => task.status === "failed");
      const candidateMap = new Map<string, Task>();
      for (const task of [...inReviewTasks, ...failedTasks]) {
        candidateMap.set(task.id, task);
      }
      const candidates = [...candidateMap.values()].filter((task) => {
        if (task.noCommitsExpected === true) return false;
        if (task.steps.length === 0 || !task.steps.every((step) => step.status === "done" || step.status === "skipped")) return false;
        const noCommitsError = typeof task.error === "string" && /no_commits/i.test(task.error);
        return task.column === "in-review" || noCommitsError;
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
      const tasks = await this.store.listTasks({ column: "in-progress", slim: true });
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const activeHeartbeatTaskIds = await this.listActiveHeartbeatTaskIds();
      const now = Date.now();

      const stranded = tasks.filter((task) => {
        if (task.column !== "in-progress" || task.paused) {
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
          await this.store.moveTask(task.id, "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
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
      const tasks = await this.store.listTasks({ column: "in-progress", slim: true });
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      const orphaned = tasks.filter((t) => {
        if (t.column !== "in-progress" || t.paused || executingIds.has(t.id) || isTaskWorkComplete(t)) {
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

          log.log(`[orphan-detected] ${task.id}: ${reason} — no action (operator-decides)`);
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

  private getDurableAgentRecoveryState(agent: { metadata?: Record<string, unknown> | null }): {
    attempts: number;
    nextRetryAt?: string;
    exhausted?: boolean;
    lastMissingModulePath?: string;
    consecutiveMissingModulePathCount: number;
  } {
    const metadata = agent.metadata ?? {};
    const raw = metadata.durableErrorRecovery;
    if (!raw || typeof raw !== "object") {
      return { attempts: 0, consecutiveMissingModulePathCount: 0 };
    }
    const record = raw as Record<string, unknown>;
    const attempts = typeof record.attempts === "number" && Number.isFinite(record.attempts)
      ? Math.max(0, Math.floor(record.attempts))
      : 0;
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

  async recoverAgentsRunningOnInactiveTasks(): Promise<number> {
    const agentStore = this.options.agentStore;
    if (!agentStore) {
      return 0;
    }

    const now = Date.now();
    const recoveredAgentIds = new Set<string>();
    const runningAgents = await agentStore.listAgents({ state: "running", includeEphemeral: true });

    for (const agent of runningAgents) {
      if (isEphemeralAgent(agent) || !agent.taskId) {
        continue;
      }

      const linkedTask = await this.store.getTask(agent.taskId);
      if (linkedTask && (linkedTask.column === "in-progress" || linkedTask.column === "in-review" || linkedTask.column === "done" || linkedTask.column === "archived")) {
        continue;
      }

      const activeRun = await agentStore.getActiveHeartbeatRun(agent.id);
      const runStartedAt = activeRun?.startedAt;
      const runAgeMs = runStartedAt ? now - Date.parse(runStartedAt) : Number.POSITIVE_INFINITY;
      const hasFreshRun = Boolean(activeRun) && Number.isFinite(runAgeMs) && runAgeMs <= RUNNING_ON_INACTIVE_TASK_STALE_RUN_MS;
      if (hasFreshRun || this.options.hasActiveAgentExecution?.(agent.id) === true) {
        continue;
      }

      await agentStore.updateAgentState(agent.id, "active");
      await agentStore.syncExecutionTaskLink(agent.id, undefined);
      recoveredAgentIds.add(agent.id);
      log.log(`Recovered running durable agent ${agent.id} on inactive task ${agent.taskId}`);
    }

    return recoveredAgentIds.size;
  }

  async recoverDriftedAgentTaskLinks(): Promise<number> {
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

      if (!linkedTask) {
        shouldClear = true;
        reason = "linked task missing";
      } else if (linkedTask.column === "done" || linkedTask.column === "archived") {
        shouldClear = true;
        reason = `linked task in terminal column ${linkedTask.column}`;
      } else if (linkedTask.assignedAgentId && linkedTask.assignedAgentId !== agent.id) {
        shouldClear = true;
        reason = `linked task assigned to ${linkedTask.assignedAgentId}`;
      } else if (linkedTask.column === "todo" || linkedTask.column === "triage") {
        const activeRun = await agentStore.getActiveHeartbeatRun(agent.id);
        const runStartedAt = activeRun?.startedAt;
        const runAgeMs = runStartedAt ? now - Date.parse(runStartedAt) : Number.POSITIVE_INFINITY;
        const hasFreshRun = Boolean(activeRun) && Number.isFinite(runAgeMs) && runAgeMs <= RUNNING_ON_INACTIVE_TASK_STALE_RUN_MS;
        const hasActiveExecution = this.options.hasActiveAgentExecution?.(agent.id) === true;
        if (!hasFreshRun && !hasActiveExecution) {
          shouldClear = true;
          reason = `linked task in queued column ${linkedTask.column} without fresh run`;
        }
      }

      if (!shouldClear) {
        continue;
      }

      await agentStore.syncExecutionTaskLink(agent.id, undefined);
      clearedAgentIds.add(agent.id);
      log.log(`Cleared drifted durable agent task link for ${agent.id} (${linkedTaskId}): ${reason}`);
    }

    log.log(`Recovered ${clearedAgentIds.size} drifted durable agent task link(s)`);
    return clearedAgentIds.size;
  }

  async recoverOrphanedAgents(): Promise<number> {
    const agentStore = this.options.agentStore;
    if (!agentStore) {
      return 0;
    }

    try {
      const settings = await this.store.getSettings();
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!Number.isFinite(timeoutMs) || timeoutMs === undefined || timeoutMs <= 0) {
        return 0;
      }
      const recoveryTimeoutMs = timeoutMs;

      const allAgents = await agentStore.listAgents();
      const allAgentIds = new Set(allAgents.map((agent) => agent.id));
      const now = Date.now();

      const orphaned = allAgents.filter((agent) => {
        if (isEphemeralAgent(agent)) {
          return false;
        }
        if (agent.state !== "running" && agent.state !== "error") {
          return false;
        }
        const managerMissing = !agent.reportsTo || !allAgentIds.has(agent.reportsTo);
        if (!managerMissing) {
          return false;
        }
        const updatedAt = Date.parse(agent.updatedAt ?? "");
        if (!Number.isFinite(updatedAt) || now - updatedAt < recoveryTimeoutMs) {
          return false;
        }

        if (agent.state === "error") {
          const runtimeConfig = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
          if (runtimeConfig.enabled === false) {
            return false;
          }
          if (this.options.hasActiveAgentExecution?.(agent.id) === true) {
            return false;
          }
          if (classifyError(agent.lastError ?? "") !== "transient" && !isStaleWorktreeModuleResolutionError(agent.lastError ?? "")) {
            return false;
          }
          if (isOperatorActionableAgentError(agent.lastError ?? "")) {
            return false;
          }

          const recoveryState = this.getDurableAgentRecoveryState(agent);
          if (recoveryState.exhausted) {
            return false;
          }
          if (recoveryState.nextRetryAt) {
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
      for (const agent of orphaned) {
        const updatedAt = Date.parse(agent.updatedAt ?? "");
        const stuckForMs = Math.max(0, now - updatedAt);
        try {
          if (agent.state === "error") {
            const recoveryState = this.getDurableAgentRecoveryState(agent);
            const isStaleMissingModule = isStaleWorktreeModuleResolutionError(agent.lastError ?? "");
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
            const exhausted = nextAttempts >= DURABLE_ERROR_RECOVERY_MAX_RETRIES;
            const nextRetryAt = new Date(Date.now() + this.computeDurableAgentRecoveryCooldownMs(nextAttempts)).toISOString();
            await agentStore.updateAgent(agent.id, {
              metadata: {
                ...(agent.metadata ?? {}),
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
              log.warn(`Suppressed durable-agent auto-restart for ${agent.id}: retry budget exhausted`);
              continue;
            }
          }

          await agentStore.updateAgentState(agent.id, "active");
          await agentStore.updateAgent(agent.id, {
            lastError: undefined,
          });

          if (agent.state === "error" && this.options.restartDurableAgentHeartbeat) {
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
      return recovered;
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
      const tasks = await this.store.listTasks({ column: "in-progress", slim: true });
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      const candidates = tasks.filter((task) =>
        task.column === "in-progress" &&
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
            log.log(`${task.id} has recoverable git work — leaving in-progress for inspection`);
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
          await this.store.moveTask(task.id, "todo", { moveSource: "engine", recoveryRehome: true });
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
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((task) =>
        allowsAutoMergeProcessing(task, settings)
        && (isRecoverableMissingWorktreeReviewFailureWithProgress(task)
          || isRecoverableMissingWorktreeReviewFailureNoProgress(task)),
      );

      if (candidates.length === 0) return 0;

      log.warn(`Found ${candidates.length} in-review task(s) failed by unusable-worktree session start`);

      let recovered = 0;
      for (const task of candidates) {
        try {
          const proof = await this.evaluateBackwardMoveTripleProof(task, {
            stage: "missing-worktree-review",
            graceMs: settings.taskStuckTimeoutMs ?? STALE_ACTIVE_BRANCH_EXECUTION_GRACE_MS,
            stalenessAnchor: task.columnMovedAt ?? task.updatedAt,
            reason: "missing-worktree-review-candidate",
          });
          if (!proof.ok) {
            await this.emitBackwardMoveNoAction(task, "missing-worktree-review", "task:missing-worktree-review-no-action", proof);
            continue;
          }

          const auditor = createRunAuditor(this.store, {
            runId: generateSyntheticRunId("self-heal", task.id),
            agentId: "self-healing",
            taskId: task.id,
            taskLineageId: task.lineageId,
            phase: "maintenance",
          });
          const result = await autoRecoverWorktreeSessionStartFailure(this.store, task, {
            failure: task.error,
            source: "in-review-sweep",
            auditor,
          });
          if (result.outcome === "requeue-todo") recovered++;
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
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });

      const candidates = tasks.filter((task) =>
        task.column === "in-review" &&
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
          await this.store.moveTask(task.id, "todo", { preserveProgress: true, moveSource: "engine", recoveryRehome: true });
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
   * Recover triage tasks that already have an approved specification but were
   * left stuck in `status: "planning"` without an active triage session.
   *
   * This catches the mirror-image of executor recovery: the review completed,
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

      const tasks = await this.store.listTasks({ column: "triage" });
      const planningIds = this.options.getPlanningTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      const orphanedApproved = tasks.filter((t) =>
        t.column === "triage" &&
        t.status === "planning" &&
        !t.paused &&
        !planningIds.has(t.id) &&
        now - new Date(t.updatedAt).getTime() >= APPROVED_TRIAGE_RECOVERY_GRACE_MS &&
        hasLatestSpecReviewApproval(t),
      );

      if (orphanedApproved.length === 0) return 0;

      log.warn(`Found ${orphanedApproved.length} approved triage task(s) stuck in planning`);

      let recovered = 0;
      for (const task of orphanedApproved) {
        log.log(`Recovering approved triage task ${task.id}: ${task.title || task.description?.slice(0, 60) || "(untitled)"}`);
        const success = await recoverFn(task);
        if (success) recovered++;
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} approved triage task(s) out of planning`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Approved triage recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  async resolveExplicitDuplicateMarkerTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      const enabled = (settings as Settings & { resolveExplicitDuplicateMarkerEnabled?: boolean }).resolveExplicitDuplicateMarkerEnabled !== false;
      if (!enabled) {
        return 0;
      }

      const tasks = await this.store.listTasks({ slim: true, includeArchived: false, limit: 500 });
      const candidates = tasks.filter((task) => task.column === "triage" || task.column === "todo");

      let resolved = 0;
      let processedMarkers = 0;
      for (const task of candidates) {
        try {
          const promptPath = join(this.options.rootDir, ".fusion", "tasks", task.id, "PROMPT.md");
          if (!existsSync(promptPath)) {
            continue;
          }

          const written = readFileSync(promptPath, "utf-8");
          const marker = parseExplicitDuplicateMarker(written);
          if (!marker) {
            continue;
          }
          if (processedMarkers >= 50) {
            break;
          }
          processedMarkers += 1;

          const canonicalTask = await this.store.getTask(marker.canonicalId).catch(() => null);
          if (
            !canonicalTask ||
            canonicalTask.deletedAt ||
            canonicalTask.id.toLowerCase() === task.id.toLowerCase()
          ) {
            continue;
          }

          await this.store.deleteTask(task.id, {
            removeLineageReferences: true,
            auditContext: {
              agentId: "self-healing",
              runId: generateSyntheticRunId("self-heal-explicit-duplicate", task.id),
            },
          });
          await this.store.recordActivity({
            type: "task:auto-archived-duplicate",
            taskId: task.id,
            taskTitle: task.title ?? "",
            details: `Duplicate of ${canonicalTask.id} — closed`,
            metadata: {
              canonicalTaskId: canonicalTask.id,
              source: "explicit-marker-sweep",
            },
          });
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
      const planningIds = this.options.getPlanningTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      const candidates = tasks.filter((task) => {
        if (task.column !== "triage") return false;
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
          peer.column === "todo" &&
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
            peer.column === "todo" &&
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
   * died before producing an approved spec.
   *
   * These tasks fall through two cracks:
   * - The stuck task detector only monitors tasks with active tracked sessions.
   *   If the session crashed or was never started, the task is never tracked.
   * - `recoverApprovedTriageTasks` only handles tasks with an approved spec.
   *
   * Recovery clears the status back to `null` so the next triage poll picks
   * them up for a fresh planning attempt.
   */
  async recoverOrphanedPlanningTasks(): Promise<number> {
    try {
      // Evict stale entries from the triage processor's in-memory set before
      // checking — tasks with hung promises (from stuck kills) would otherwise
      // block recovery indefinitely.
      this.options.evictStaleTriageProcessing?.();

      const tasks = await this.store.listTasks({ column: "triage" });
      const planningIds = this.options.getPlanningTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      const orphaned = tasks.filter((t) =>
        t.column === "triage" &&
        t.status === "planning" &&
        !t.paused &&
        !planningIds.has(t.id) &&
        now - new Date(t.updatedAt).getTime() >= APPROVED_TRIAGE_RECOVERY_GRACE_MS &&
        !hasLatestSpecReviewApproval(t),
      );

      if (orphaned.length === 0) return 0;

      log.warn(`Found ${orphaned.length} orphaned planning triage task(s) without approval`);

      let recovered = 0;
      for (const task of orphaned) {
        try {
          log.log(`Recovering orphaned planning task ${task.id}: ${task.title || task.description?.slice(0, 60) || "(untitled)"}`);
          await this.store.updateTask(task.id, { status: null });
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
            log.log("Worktree prune delegated to worktrunk backend");
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
      log.log("Worktree prune completed");
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
        log.log("[self-healing] skipped native orphan cleanup — worktrunk backend owns layout");
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
        // U8: never reclaim a worktree backing a resume-eligible CLI session.
        if (this.isWorktreeResumeReserved(worktreePath)) {
          log.log(`[self-healing] deferring idle-sweep for ${worktreePath}: resume-eligible CLI session present`);
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
      log.log("[self-healing] skipped native unregistered-orphan reap — worktrunk backend owns layout");
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
        .filter((e) => e.isDirectory())
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
        log.log(`[self-healing] deferring unregistered-orphan reap for ${path}: active session present`);
        continue;
      }
      // U8: never reclaim a worktree backing a resume-eligible CLI session.
      if (this.isWorktreeResumeReserved(path)) {
        log.log(`[self-healing] deferring unregistered-orphan reap for ${path}: resume-eligible CLI session present`);
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
        const cleared = this.store.clearStaleExecutionStartBranchReferences(prunedBranches);
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
    if (!this.store.fts5Available) {
      log.log('Maintenance batch 1 step "fts-maintenance" skipped — FTS5 unavailable');
      return;
    }

    const bytesBefore = this.store.getFtsIndexBytes();
    if (bytesBefore === null) {
      log.log('Maintenance batch 1 step "fts-maintenance" skipped — FTS shadow tables unavailable');
      return;
    }

    const taskCount = this.store.getTaskRowCount();
    const relativeThresholdBytes = taskCount > 0 ? taskCount * FTS_REBUILD_BYTES_PER_TASK : null;
    const shouldRebuild = bytesBefore >= FTS_REBUILD_THRESHOLD_BYTES
      || (relativeThresholdBytes !== null && bytesBefore > relativeThresholdBytes);
    const shouldOptimize = !shouldRebuild
      && FTS_MAINTENANCE_OPTIMIZE_CADENCE_TICKS > 0
      && this.maintenanceTickCounter % FTS_MAINTENANCE_OPTIMIZE_CADENCE_TICKS === 0;
    const mode = shouldRebuild ? "rebuild" : shouldOptimize ? "optimize" : "merge";

    if (mode === "merge"
      && FTS_MAINTENANCE_MERGE_CADENCE_TICKS > 1
      && this.maintenanceTickCounter % FTS_MAINTENANCE_MERGE_CADENCE_TICKS !== 0) {
      log.log('Maintenance batch 1 step "fts-maintenance" skipped — merge cadence not due');
      return;
    }

    let rebuilt = false;
    if (mode === "rebuild") {
      rebuilt = this.store.getDatabase().rebuildFts5Index();
    } else {
      this.store.optimizeFts5(mode);
    }

    const bytesAfter = this.store.getFtsIndexBytes();
    log.log(`Maintenance batch 1 step "fts-maintenance" ${mode}: ${bytesBefore} → ${bytesAfter ?? "unknown"} bytes (tasks=${taskCount})`);

    try {
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal-fts-maintenance", "tasks_fts"),
        agentId: "self-healing",
        phase: "maintenance-fts",
      }).database({
        type: "task:fts-maintenance" as DatabaseMutationType,
        target: "tasks_fts",
        metadata: {
          mode,
          bytesBefore,
          bytesAfter,
          taskCount,
          rebuilt,
          absoluteThresholdBytes: FTS_REBUILD_THRESHOLD_BYTES,
          relativeThresholdBytes,
        },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to write task:fts-maintenance run-audit event: ${errorMessage}`);
    }
  }

  private async maintainArchiveTaskFts(): Promise<void> {
    if (!this.store.archiveFts5Available) {
      log.log('Maintenance batch 1 step "fts-maintenance" archive skipped — FTS5 unavailable');
      return;
    }

    const bytesBefore = this.store.getArchiveFtsIndexBytes();
    if (bytesBefore === null) {
      log.log('Maintenance batch 1 step "fts-maintenance" archive skipped — FTS shadow tables unavailable');
      return;
    }

    const rowCount = this.store.getArchivedRowCount();
    const relativeThresholdBytes = rowCount > 0 ? rowCount * ARCHIVE_FTS_REBUILD_BYTES_PER_TASK : null;
    const shouldRebuild = bytesBefore >= ARCHIVE_FTS_REBUILD_THRESHOLD_BYTES
      || (relativeThresholdBytes !== null && bytesBefore > relativeThresholdBytes);
    const shouldOptimize = !shouldRebuild
      && ARCHIVE_FTS_MAINTENANCE_OPTIMIZE_CADENCE_TICKS > 0
      && this.maintenanceTickCounter % ARCHIVE_FTS_MAINTENANCE_OPTIMIZE_CADENCE_TICKS === 0;
    const mode = shouldRebuild ? "rebuild" : shouldOptimize ? "optimize" : "merge";

    if (mode === "merge"
      && ARCHIVE_FTS_MAINTENANCE_MERGE_CADENCE_TICKS > 1
      && this.maintenanceTickCounter % ARCHIVE_FTS_MAINTENANCE_MERGE_CADENCE_TICKS !== 0) {
      log.log('Maintenance batch 1 step "fts-maintenance" archive skipped — merge cadence not due');
      return;
    }

    let rebuilt = false;
    if (mode === "rebuild") {
      rebuilt = this.store.rebuildArchiveFts5Index();
    } else {
      this.store.optimizeArchiveFts5(mode);
    }

    const bytesAfter = this.store.getArchiveFtsIndexBytes();
    log.log(`Maintenance batch 1 step "fts-maintenance" archive ${mode}: ${bytesBefore} → ${bytesAfter ?? "unknown"} bytes (archived=${rowCount})`);

    try {
      await createRunAuditor(this.store, {
        runId: generateSyntheticRunId("self-heal-fts-maintenance", "archived_tasks_fts"),
        agentId: "self-healing",
        phase: "maintenance-fts",
      }).database({
        type: "task:fts-maintenance" as DatabaseMutationType,
        target: "archived_tasks_fts",
        metadata: {
          mode,
          bytesBefore,
          bytesAfter,
          rowCount,
          rebuilt,
          absoluteThresholdBytes: ARCHIVE_FTS_REBUILD_THRESHOLD_BYTES,
          relativeThresholdBytes,
        },
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(`Failed to write archived task:fts-maintenance run-audit event: ${errorMessage}`);
    }
  }

  /** Run a best-effort passive WAL checkpoint without forcing live writers to truncate. */
  private checkpointWal(): void {
    try {
      const result = this.store.walCheckpoint("PASSIVE");
      if (result.log > 0) {
        log.log(`WAL checkpoint (passive): ${result.checkpointed}/${result.log} pages checkpointed` +
          (result.busy > 0 ? ` (${result.busy} busy)` : ""));
      }
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`WAL checkpoint failed: ${errorMessage}`);
    }
  }

  /** Remove oldest idle worktrees if total count exceeds 2× maxWorktrees. */
  private async enforceWorktreeCap(): Promise<void> {
    try {
      const settings = await this.store.getSettings();
      if (settings.worktrunk?.enabled === true) {
        log.log("[self-healing] skipped native worktree cap enforcement — worktrunk backend owns layout");
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
      const dirs = entries.filter((e) => e.isDirectory());

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
        // U8: never reclaim a worktree backing a resume-eligible CLI session.
        if (this.isWorktreeResumeReserved(worktreePath)) {
          log.log(`[self-healing] cap-enforcement skipping ${worktreePath}: resume-eligible CLI session present`);
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

function hasLatestSpecReviewApproval(task: Task): boolean {
  for (let i = task.log.length - 1; i >= 0; i--) {
    const action = task.log[i]?.action ?? "";
    if (action.startsWith("Spec review: ")) {
      return action === "Spec review: APPROVE";
    }
  }
  return false;
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

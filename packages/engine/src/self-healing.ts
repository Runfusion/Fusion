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
 */

import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getInReviewStallReason, getTaskMergeBlocker, isEphemeralAgent, type AgentStore, type TaskStore, type Settings, type Task, type MergeDetails } from "@fusion/core";
import type { MeshLeaseManager } from "./mesh-lease-manager.js";
import { createLogger } from "./logger.js";
import { getRegisteredWorktreePaths, isUsableTaskWorktree, scanIdleWorktrees, scanOrphanedBranches } from "./worktree-pool.js";
import { extractMissingWorktreePathFromSessionStartFailure, isMissingWorktreeSessionStartFailure, isRecoverableMissingWorktreeReviewFailure } from "./restart-recovery-coordinator.js";
import { classifyError, extractMissingModulePath, isOperatorActionableAgentError, isStaleWorktreeModuleResolutionError } from "./transient-error-detector.js";
import { deriveTaskIdFromFusionBranch, inspectBranchConflict, listUniqueBranchCommits } from "./branch-conflicts.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";

const log = createLogger("self-healing");
const execAsync = promisify(exec);

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
  hasActiveAgentExecution?: (agentId: string) => boolean;
  restartDurableAgentHeartbeat?: (agentId: string, context: { reason: string; attempt: number }) => Promise<boolean>;
}

const APPROVED_TRIAGE_RECOVERY_GRACE_MS = 60_000;
const ORPHANED_EXECUTION_RECOVERY_GRACE_MS = 60_000;
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
const MAX_AUTO_MERGE_RETRIES = 3;
const MAX_STARVATION_DROPS = 3;
const DEADLOCK_RECOVERY_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS = 5 * 60_000;
const DEFAULT_STALE_MERGING_FANOUT_MIN_AGE_MS = 15 * 60_000;
const DURABLE_ERROR_RECOVERY_MAX_RETRIES = 5;
const DURABLE_ERROR_RECOVERY_BASE_COOLDOWN_MS = 30_000;
const DURABLE_ERROR_RECOVERY_MAX_COOLDOWN_MS = 15 * 60_000;
const RUNNING_ON_INACTIVE_TASK_STALE_RUN_MS = 5 * 60_000;
const ORPHAN_RESCUE_SUBJECT_CAP = 10;

interface OrphanBranchInspection {
  branch: string;
  tipSha: string;
  uniqueCommitCount: number;
  uniqueCommitSubjects: string[];
  derivedTaskId: string | null;
  registeredWorktreePath: string | null;
}

interface LandedTaskCommit {
  sha: string;
  subject?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

type AlreadyMergedDetectionStrategy = "trailer" | "ancestry" | "patch-id" | "tree-equal";

interface AlreadyMergedLookupInput {
  taskId: string;
  lineageId?: string;
  repoDir: string;
  baseBranch: string;
  taskBranch?: string;
  baseCommitSha?: string;
}

interface AlreadyMergedLookupResult {
  sha: string;
  strategy: AlreadyMergedDetectionStrategy;
}

function commitOwnedByTask(taskId: string, lineageId: string | undefined, subject: string, body: string): boolean {
  if (lineageId && body.includes(`Fusion-Task-Lineage: ${lineageId}`)) {
    return true;
  }
  return body.includes(`Fusion-Task-Id: ${taskId}`) || subject.includes(taskId);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function isBranchAheadOfBase(
  task: Task,
  rootDir: string,
  preferredBaseRef?: string,
): Promise<{ aheadCount: number; baseRef: string } | null> {
  const branchName = task.branch || `fusion/${task.id.toLowerCase()}`;

  try {
    await execAsync(`git rev-parse --verify ${shellQuote(branchName)}`, {
      cwd: rootDir,
      timeout: 30_000,
    });
  } catch {
    return null;
  }

  const requestedBaseRef = preferredBaseRef || task.mergeDetails?.mergeTargetBranch || "main";
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
  private orphanArchivedAcknowledged = new Set<string>();

  constructor(
    private store: TaskStore,
    private options: SelfHealingOptions,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────

  start(): void {
    // Wire up settings:updated listener for auto-unpause
    this.settingsListener = ({ settings, previous }) => {
      this.onSettingsUpdated(settings, previous);
    };
    this.store.on("settings:updated", this.settingsListener);

    this.taskMovedFanoutListener = ({ task, from, to }) => {
      const shouldReconcile =
        (from === "in-review" && to === "done") ||
        (from === "done" && to === "archived");
      if (!shouldReconcile) return;
      void this.reconcileCompletedTask(task.id).catch((err: unknown) => {
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
      { name: "done-merge-metadata", fn: () => this.recoverDoneTaskMergeMetadata().then(() => undefined) },
      { name: "recover-already-merged-review", fn: () => this.recoverAlreadyMergedReviewTasks().then(() => undefined) },
      { name: "recover-orphan-only-scope-violations", fn: () => this.recoverOrphanOnlyScopeViolations().then(() => undefined) },
      { name: "recover-stuck-merge-deadlocks", fn: () => this.recoverStuckMergeDeadlocks().then(() => undefined) },
      { name: "misclassified-failures", fn: () => this.recoverMisclassifiedFailures().then(() => undefined) },
      { name: "missing-worktree-review-failures", fn: () => this.recoverMissingWorktreeReviewFailures().then(() => undefined) },
      { name: "partial-progress-no-task-done", fn: () => this.recoverPartialProgressNoTaskDoneFailures().then(() => undefined) },
      { name: "orphaned-executions", fn: () => this.recoverOrphanedExecutions().then(() => undefined) },
      { name: "approved-triage", fn: () => this.recoverApprovedTriageTasks().then(() => undefined) },
      { name: "orphaned-planning", fn: () => this.recoverOrphanedPlanningTasks().then(() => undefined) },
      { name: "recover-orphaned-agents", fn: () => this.recoverOrphanedAgents().then(() => undefined) },
      { name: "recover-stale-heartbeat-runs", fn: () => this.recoverStaleHeartbeatRuns().then(() => undefined) },
      { name: "recover-running-on-inactive-tasks", fn: () => this.recoverAgentsRunningOnInactiveTasks().then(() => undefined) },
      { name: "recover-drifted-agent-task-links", fn: () => this.recoverDriftedAgentTaskLinks().then(() => undefined) },
      { name: "clear-stale-blocked-by", fn: () => this.clearStaleBlockedBy().then(() => undefined) },
      { name: "reclaim-self-owned-branch-conflicts", fn: () => this.reclaimSelfOwnedBranchConflicts().then(() => undefined) },
      { name: "surface-in-review-stalls", fn: () => this.surfaceInReviewStalls().then(() => undefined) },
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
   * Check whether a stuck-killed task should be re-queued or marked as failed.
   * Called by StuckTaskDetector's `beforeRequeue` callback.
   *
   * Terminal contract for stuck-loop exhaustion:
   * - Task is marked `status: "failed"` with `error` starting with
   *   `STUCK_LOOP_EXHAUSTED: ` and including kill count, max, and last reason.
   * - Task is moved to `in-review` (best-effort if move fails).
   * - Task log gets a final `STUCK_LOOP_EXHAUSTED` entry with operator guidance
   *   to manually retry, pause, or move to triage.
   *
   * @returns `true` if the task should be re-queued, `false` if budget exhausted
   *          (task has been marked as permanently failed).
   */
  async checkStuckBudget(taskId: string, reason: "loop" | "inactivity" = "inactivity"): Promise<boolean> {
    try {
      const settings = await this.store.getSettings();
      const maxKills = settings.maxStuckKills ?? 6;

      const task = await this.store.getTask(taskId);
      const newCount = (task.stuckKillCount ?? 0) + 1;

      if (newCount > maxKills) {
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
          await this.store.moveTask(taskId, "in-review");
        } catch (moveErr: unknown) {
          // moveTask may fail if task was concurrently moved (e.g., dep-abort).
          // The task is already marked failed — don't allow requeue.
          const moveErrMessage = moveErr instanceof Error ? moveErr.message : String(moveErr);
          log.warn(`${taskId} moveTask("in-review") failed (${moveErrMessage}) after STUCK_LOOP_EXHAUSTED terminalization — task already marked failed, not re-queuing`);
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

    const branchName = task.branch || `fusion/${task.id.toLowerCase()}`;

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
          const commit: LandedTaskCommit = { sha, subject };
          try {
            const stats = await execAsync(`git show --shortstat --format= ${shellQuote(sha)}`, {
              cwd: this.options.rootDir,
              maxBuffer: 1024 * 1024,
            });
            Object.assign(commit, parseShortstat(stats.stdout));
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

    const firstLine = stdout.trim().split("\n").find(Boolean);
    if (!firstLine) return null;

    const [sha, subject] = firstLine.split("\x1f");
    if (!sha) return null;

    const commit: LandedTaskCommit = { sha, subject };
    try {
      const stats = await execAsync(`git show --shortstat --format= ${shellQuote(sha)}`, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
      Object.assign(commit, parseShortstat(stats.stdout));
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to read shortstat for landed commit ${sha} (${task.id}): ${errorMessage} — continuing without stats`,
      );
      // Stats are useful for the task detail view but not required for recovery.
    }

    return commit;
  }

  private async findAlreadyMergedTaskCommit(
    input: AlreadyMergedLookupInput,
  ): Promise<AlreadyMergedLookupResult | null> {
    const { taskId, lineageId, repoDir, baseBranch, taskBranch, baseCommitSha } = input;

    try {
      if (lineageId) {
        const lineagePattern = `^Fusion-Task-Lineage: ${lineageId}$`;
        const lineageCommand = [
          "git log",
          `--grep=${shellQuote(lineagePattern)}`,
          "-E",
          "--max-count=1",
          "--format=%H",
          shellQuote(baseBranch),
        ].join(" ");
        const lineage = await execAsync(lineageCommand, {
          cwd: repoDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        const lineageSha = lineage.stdout.trim();
        if (lineageSha) {
          return { sha: lineageSha, strategy: "trailer" };
        }
      }

      const trailerPattern = `^Fusion-Task-Id: ${taskId}$`;
      const trailerCommand = [
        "git log",
        `--grep=${shellQuote(trailerPattern)}`,
        "-E",
        "--max-count=1",
        "--format=%H",
        shellQuote(baseBranch),
      ].join(" ");
      const { stdout } = await execAsync(trailerCommand, {
        cwd: repoDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const sha = stdout.trim();
      if (sha) {
        return { sha, strategy: "trailer" };
      }
    } catch {
      // Fall through to ancestry/patch-id checks.
    }

    let branchTip: string | null = null;
    const branchName = taskBranch || `fusion/${taskId.toLowerCase()}`;
    try {
      branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      execSync(`git merge-base --is-ancestor ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`, {
        cwd: repoDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const ancestryCommand = [
        "git log",
        "--first-parent",
        "--format=%H",
        `--grep=${shellQuote(taskId)}`,
        "--max-count=1",
        shellQuote(baseBranch),
      ].join(" ");
      const { stdout } = await execAsync(ancestryCommand, {
        cwd: repoDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const sha = stdout.trim();
      if (sha) {
        return { sha, strategy: "ancestry" };
      }
    } catch {
      // Fall through to patch-id checks.
    }

    try {
      if (!branchTip) {
        branchTip = execSync(`git rev-parse --verify ${shellQuote(branchName)}`, {
          cwd: repoDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      }

      let branchBase = baseCommitSha?.trim();
      if (!branchBase) {
        const { stdout: mergeBaseStdout } = await execAsync(
          `git merge-base ${shellQuote(branchTip)} ${shellQuote(baseBranch)}`,
          {
            cwd: repoDir,
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          },
        );
        branchBase = mergeBaseStdout.trim();
      }

      if (!branchBase) {
        return null;
      }

      const branchPatchIdCommand = `git diff ${shellQuote(branchBase)}..${shellQuote(branchTip)} | git patch-id`;
      const { stdout: branchPatchIdOut } = await execAsync(branchPatchIdCommand, {
        cwd: repoDir,
        shell: "/bin/sh",
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      const branchPatchIdLine = branchPatchIdOut
        .trim()
        .split("\n")
        .find((line) => line.trim().length > 0);
      const branchPatchId = branchPatchIdLine?.trim().split(/\s+/)[0];
      if (!branchPatchId) {
        return null;
      }

      const basePatchMapCommand = `git log -n 200 -p --format='%H' ${shellQuote(baseBranch)} | git patch-id`;
      const { stdout: basePatchIdsOut } = await execAsync(basePatchMapCommand, {
        cwd: repoDir,
        shell: "/bin/sh",
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });

      const basePatchMap = new Map<string, string>();
      for (const line of basePatchIdsOut.split("\n")) {
        const [patchId, sha] = line.trim().split(/\s+/);
        if (!patchId || !sha) continue;
        basePatchMap.set(patchId, sha);
      }

      const matchedSha = basePatchMap.get(branchPatchId);
      if (matchedSha) {
        return { sha: matchedSha, strategy: "patch-id" };
      }
    } catch {
      // Fall through to null when patch-id detection fails.
    }

    // Last-resort fallback: if branch and base resolve to identical trees, content is already landed
    // but attribution is weak (we cannot identify the exact landing commit), so prefer stronger
    // trailer/ancestry/patch-id matches first and use this only at the end.
    try {
      const treeBranchName = taskBranch || `fusion/${taskId.toLowerCase()}`;
      execSync(`git rev-parse --verify ${shellQuote(treeBranchName)}`, {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      const { stdout: baseTreeStdout } = await execAsync(
        `git rev-parse ${shellQuote(baseBranch)}^{tree}`,
        {
          cwd: repoDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      const { stdout: branchTreeStdout } = await execAsync(
        `git rev-parse ${shellQuote(treeBranchName)}^{tree}`,
        {
          cwd: repoDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );

      const baseTree = baseTreeStdout.trim();
      const branchTree = branchTreeStdout.trim();
      if (baseTree && branchTree && baseTree === branchTree) {
        const { stdout: baseHeadStdout } = await execAsync(`git rev-parse ${shellQuote(baseBranch)}`, {
          cwd: repoDir,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        const baseHead = baseHeadStdout.trim();
        if (baseHead) {
          return { sha: baseHead, strategy: "tree-equal" };
        }
      }
    } catch {
      // Fall through to null when tree-equality detection fails.
    }

    return null;
  }

  private async cleanupWorktreeOnly(task: Task): Promise<void> {
    if (task.worktree && existsSync(task.worktree)) {
      try {
        await execAsync(`git worktree remove ${shellQuote(task.worktree)} --force`, {
          cwd: this.options.rootDir,
          timeout: 120_000,
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
        await execAsync(`git worktree remove ${shellQuote(task.worktree)} --force`, {
          cwd: this.options.rootDir,
          timeout: 120_000,
        });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log.warn(
          `Failed to remove interrupted-merge worktree ${task.worktree} for ${task.id}: ${errorMessage} — non-fatal, cleanup can retry later`,
        );
      }
    }

    const branch = task.branch || `fusion/${task.id.toLowerCase()}`;
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
    log.log("Maintenance cycle starting");

    try {
      // Batch 1 — Git/filesystem cleanup
      const batch1Fns: Array<{ name: string; fn: () => Promise<unknown> }> = [
        { name: "prune-worktrees", fn: () => this.pruneWorktrees() },
        { name: "cleanup-orphans", fn: () => this.cleanupOrphans() },
        { name: "cleanup-orphaned-branches", fn: () => this.cleanupOrphanedBranches() },
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
          { name: "recover-completed-tasks", fn: () => this.recoverCompletedTasks() },
          { name: "recover-stranded-completed-todo", fn: () => this.recoverStrandedCompletedTodoTasks() },
          { name: "recover-stale-incomplete-review", fn: () => this.recoverStaleIncompleteReviewTasks() },
          { name: "recover-failed-pre-merge-steps", fn: () => this.recoverReviewTasksWithFailedPreMergeSteps() },
          { name: "recover-interrupted-merging", fn: () => this.recoverInterruptedMergingTasks() },
          { name: "recover-done-merge-metadata", fn: () => this.recoverDoneTaskMergeMetadata() },
          { name: "recover-stale-merging-status", fn: () => this.recoverStaleMergingStatus() },
          { name: "finalize-noop-review", fn: () => this.finalizeNoOpReviewTasks() },
          { name: "recover-mergeable-review", fn: () => this.recoverMergeableReviewTasks() },
          { name: "recover-merged-review", fn: () => this.recoverMergedReviewTasks() },
          { name: "recover-already-merged-review", fn: () => this.recoverAlreadyMergedReviewTasks() },
          { name: "recover-orphan-only-scope-violations", fn: () => this.recoverOrphanOnlyScopeViolations() },
          { name: "recover-stuck-merge-deadlocks", fn: () => this.recoverStuckMergeDeadlocks() },
          { name: "recover-misclassified-failures", fn: () => this.recoverMisclassifiedFailures() },
          { name: "recover-missing-worktree-review-failures", fn: () => this.recoverMissingWorktreeReviewFailures() },
          { name: "recover-no-progress-no-task-done", fn: () => this.recoverNoProgressNoTaskDoneFailures() },
          { name: "recover-partial-progress-no-task-done", fn: () => this.recoverPartialProgressNoTaskDoneFailures() },
          { name: "recover-orphaned-executions", fn: () => this.recoverOrphanedExecutions() },
          { name: "recover-approved-triage", fn: () => this.recoverApprovedTriageTasks() },
          { name: "recover-orphaned-planning", fn: () => this.recoverOrphanedPlanningTasks() },
          { name: "recover-ghost-review", fn: () => this.recoverGhostReviewTasks() },
          { name: "recover-orphaned-agents", fn: () => this.recoverOrphanedAgents() },
          { name: "recover-stale-heartbeat-runs", fn: () => this.recoverStaleHeartbeatRuns() },
          { name: "recover-running-on-inactive-tasks", fn: () => this.recoverAgentsRunningOnInactiveTasks() },
          { name: "recover-drifted-agent-task-links", fn: () => this.recoverDriftedAgentTaskLinks() },
          { name: "clear-stale-blocked-by", fn: () => this.clearStaleBlockedBy() },
          { name: "reclaim-self-owned-branch-conflicts", fn: () => this.reclaimSelfOwnedBranchConflicts() },
          { name: "surface-in-review-stalls", fn: () => this.surfaceInReviewStalls() },
          { name: "audit-no-commits-expected-candidates", fn: () => this.auditNoCommitsExpectedCandidates() },
        ];
        for (const fn of batch2Fns) {
          try {
            await fn.fn();
            log.log(`Maintenance batch 2 step "${fn.name}" succeeded`);
          } catch (stepErr) {
            log.error(`Maintenance batch 2 step "${fn.name}" failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
          }
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
      if (settings.autoArchiveDoneTasksEnabled === false) {
        return 0;
      }
      const archiveAfterMs = settings.autoArchiveDoneAfterMs ?? SelfHealingManager.AUTO_ARCHIVE_AFTER_MS;
      if (!Number.isFinite(archiveAfterMs) || archiveAfterMs <= 0) {
        return 0;
      }

      // Slim listing — we only need id/column/columnMovedAt/updatedAt to decide
      // staleness. Pulling full task payloads (logs, comments, steps) here used
      // to drag in tens of MB on busy boards and stalled the maintenance loop.
      const tasks = await this.store.listTasks({ slim: true, includeArchived: false });
      const cutoff = Date.now() - archiveAfterMs;

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
      for (const task of stale) {
        try {
          await this.store.archiveTaskAndCleanup(task.id);
          archived++;
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

  /**
   * STANDING: do not auto-discard stranded commits. Reclaim preserves commits;
   * unrecoverable conflicts are escalated for human review.
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
      const candidates = [...todoCandidates, ...inProgressCandidates, ...inReviewPausedCandidates];

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
          log.warn(`Unable to enumerate active heartbeat runs for self-owned branch reclaim sweep: ${message}`);
        }
      }

      let recovered = 0;
      for (const task of candidates) {
        if (task.checkedOutBy || activeTaskIds.has(task.id.toUpperCase()) || !task.branch || !task.worktree) continue;
        if (task.userPaused) continue;
        if (!await isUsableTaskWorktree(this.options.rootDir, task.worktree)) continue;

        try {
          const inspection = await inspectBranchConflict({
            repoDir: this.options.rootDir,
            branchName: task.branch,
            conflictingWorktreePath: task.worktree,
            requestingTaskId: task.id,
            ownerTaskId: task.id,
            startPoint: task.baseCommitSha ?? task.mergeDetails?.mergeTargetBranch ?? "main",
          });

          if (inspection.kind === "stale" || inspection.kind === "stale-resolved") {
            continue;
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
                await execAsync(`git worktree remove --force ${JSON.stringify(inspection.livePath)}`, {
                  cwd: this.options.rootDir,
                  timeout: 120_000,
                  maxBuffer: 10 * 1024 * 1024,
                });
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
                  await this.store.moveTask(task.id, "todo", {
                    moveSource: "engine",
                    preserveProgress: true,
                    preserveResumeState: true,
                  });
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
          await this.store.updateTask(task.id, {
            worktree: inspection.livePath,
            branch: task.branch,
            paused: false,
            pausedReason: undefined,
            status: null,
            error: null,
          });
          await this.store.logEntry(
            task.id,
            `[recovery] ${wasPausedBranchConflict ? "reclaim-paused-review" : "reclaim-self-owned"} ${task.id} at ${inspection.livePath} (${preservedCommitCount} commits preserved, tip ${inspection.tipSha.slice(0, 12)})`,
          );

          if (task.column === "in-review") {
            await this.store.moveTask(task.id, "todo", {
              moveSource: "engine",
              preserveWorktree: true,
              preserveProgress: true,
              preserveResumeState: true,
            });
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
          const patchPath = await preserveWorktreeChanges(this.options.rootDir, task.worktree, task.id);
          if (patchPath) {
            await this.store.logEntry(task.id, `Preserved uncommitted worktree changes before pause: ${patchPath}`);
          }
          await this.store.updateTask(task.id, {
            status: "failed",
            error: `Task branch conflict: ${task.branch} is not safely reclaimable (${message})`,
            paused: true,
            pausedReason: "branch-conflict-unrecoverable",
          });
          await this.store.moveTask(task.id, "in-review");
          await this.store.logEntry(task.id, `Auto-recovery failed: branch conflict unrecoverable — ${message}`);
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

    const baseBranch = task.baseBranch || "main";
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
      const allTasks = await this.store.listTasks({ slim: true, includeArchived: true });
      const taskById = new Map(allTasks.map((t) => [t.id, t]));
      const todoTasks = await this.store.listTasks({ column: "todo", slim: true });
      const inProgressTasks = await this.store.listTasks({ column: "in-progress", slim: true });
      const inReviewTasks = (await this.store.listTasks({ column: "in-review", slim: true })).filter((t) => !t.paused);

      const dependents = [...todoTasks, ...inProgressTasks, ...inReviewTasks].filter((t) => t.blockedBy === taskId);
      const todoTaskIds = new Set(todoTasks.map((t) => t.id));
      for (const dependent of dependents) {
        try {
          const unresolvedDeps = dependent.dependencies.filter((depId) => {
            const dep = taskById.get(depId);
            return dep && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";
          });
          if (todoTaskIds.has(dependent.id)) {
            if (unresolvedDeps.length > 0) {
              const nextBlocker = unresolvedDeps[0]!;
              await this.store.updateTask(dependent.id, { blockedBy: nextBlocker, status: "queued" });
              await this.store.logEntry(
                dependent.id,
                `Auto-recovered (FN-4523): cleared stale blockedBy — blocker ${taskId} is done; now blocked by ${nextBlocker}`,
              );
            } else {
              await this.store.updateTask(dependent.id, { blockedBy: null, status: null });
              await this.store.logEntry(
                dependent.id,
                `Auto-recovered (FN-4523): cleared stale blockedBy — blocker ${taskId} is done`,
              );
            }
          } else {
            await this.store.updateTask(dependent.id, { blockedBy: null });
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

      const branchName = task?.branch || `fusion/${taskId.toLowerCase()}`;
      let worktreePath = options?.worktreeHint;
      if (!worktreePath || !existsSync(worktreePath)) {
        worktreePath = await this.findWorktreePathForBranch(branchName);
      }
      if (worktreePath && existsSync(worktreePath)) {
        try {
          await execAsync(`git worktree remove --force ${shellQuote(worktreePath)}`, {
            cwd: this.options.rootDir,
            timeout: 30_000,
          });
          result.worktreeRemoved = true;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(`${prefix} failed to remove worktree ${worktreePath}: ${errorMessage}`);
        }
      } else {
        log.log(`${prefix} no live worktree found for branch ${branchName}`);
      }

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

  async clearStaleBlockedBy(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const staleMergingStatusMinAgeMs = this.options.staleMergingStatusMinAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS;
      const configuredFanoutMinAgeMs = this.options.staleMergingFanoutMinAgeMs ?? DEFAULT_STALE_MERGING_FANOUT_MIN_AGE_MS;
      const staleMergingFanoutMinAgeMs = Math.max(staleMergingStatusMinAgeMs, configuredFanoutMinAgeMs);
      const activeMergeTaskId = this.options.getActiveMergeTaskId?.() ?? null;
      const now = Date.now();

      const todoTasks = await this.store.listTasks({ column: "todo", slim: true });
      const inProgressTasks = await this.store.listTasks({ column: "in-progress", slim: true });
      const inReviewTasks = await this.store.listTasks({ column: "in-review", slim: true });
      const blockedTasks = [
        ...todoTasks,
        ...inProgressTasks,
        ...inReviewTasks.filter((task) => !task.paused),
      ].filter((task) => typeof task.blockedBy === "string" && task.blockedBy.trim().length > 0);
      const queuedDependencyTasks = todoTasks.filter(
        (task) => task.status === "queued" && task.dependencies.length > 0,
      );

      if (blockedTasks.length === 0 && queuedDependencyTasks.length === 0) return 0;

      const allTasks = await this.store.listTasks({ slim: true, includeArchived: true });
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
          return dep && dep.column !== "done" && dep.column !== "in-review" && dep.column !== "archived";
        });

        if (blockedTaskIds.has(task.id)) {
          if (!blockerId) continue;

          const blocker = taskById.get(blockerId);
          let reason: string | null = null;

          if (!blocker) {
            reason = `blocker ${blockerId} missing`;
          } else if (blocker.column === "done") {
            reason = `blocker ${blockerId} is done`;
          } else if (blocker.column === "archived") {
            reason = `blocker ${blockerId} is archived`;
          } else if (blocker.column === "in-review" && blocker.paused) {
            reason = `blocker ${blockerId} in-review + paused`;
          } else if (
            blocker.column === "in-review" &&
            blocker.status === "failed" &&
            (blocker.mergeRetries ?? 0) >= MAX_AUTO_MERGE_RETRIES
          ) {
            reason = `blocker ${blockerId} in-review + failed (mergeRetries ${blocker.mergeRetries ?? 0}/${MAX_AUTO_MERGE_RETRIES})`;
          } else if (
            blocker.column === "in-review" &&
            blocker.status === "failed" &&
            isMissingWorktreeSessionStartFailure(blocker.error)
          ) {
            reason = `blocker ${blockerId} in-review + failed (missing-worktree session start)`;
          } else if (
            blocker.column === "in-review" &&
            (blocker.status === "merging" || blocker.status === "merging-pr" || blocker.status == null) &&
            (!activeMergeTaskId || activeMergeTaskId !== blocker.id)
          ) {
            const updatedAtMs = blocker.updatedAt ? Date.parse(blocker.updatedAt) : Number.NaN;
            if (Number.isFinite(updatedAtMs)) {
              const elapsedMs = now - updatedAtMs;
              if (elapsedMs >= staleMergingFanoutMinAgeMs) {
                const blockerStatus = blocker.status ?? "no-status";
                reason = `blocker ${blockerId} in-review + ${blockerStatus} stale for ${elapsedMs}ms (threshold ${staleMergingFanoutMinAgeMs}ms)`;
              }
            }
          } else if (task.dependencies.length > 0 && !unresolvedDeps.includes(blockerId)) {
            reason = `blocker ${blockerId} not among unresolved dependencies`;
          }

          if (reason) {
            try {
              if (todoTaskIds.has(task.id)) {
                if (unresolvedDeps.length > 0) {
                  const nextBlocker = unresolvedDeps[0]!;
                  await this.store.updateTask(task.id, { blockedBy: nextBlocker, status: "queued" });
                  await this.store.logEntry(task.id, `Auto-recovered: refreshed stale blockedBy — ${reason}; now blocked by ${nextBlocker}`);
                } else {
                  await this.store.updateTask(task.id, { blockedBy: null, status: null });
                  await this.store.logEntry(task.id, `Auto-recovered: cleared stale blockedBy — ${reason}`);
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
              await this.store.updateTask(task.id, { blockedBy: null, status: null });
              await this.store.logEntry(task.id, "Auto-recovered: cleared stale queued status — all dependencies satisfied");
              recovered++;
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

  async finalizeNoOpReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (!settings.autoMerge) return 0;
      if (settings.globalPause || settings.enginePaused) return 0;

      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((t) =>
        t.column === "in-review" &&
        !t.paused &&
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
      for (const task of candidates) {
        const ahead = await this.isBranchAheadOfBase(task, task.mergeDetails?.mergeTargetBranch || "main");
        if (!ahead || ahead.aheadCount !== 0) {
          continue;
        }

        const noOpReason = `branch has zero commits ahead of ${ahead.baseRef}`;
        // Reaching in-review means executor/spec gates already passed. If there
        // are no commits ahead of base, treat this as a successful no-op merge.
        const mergeDetails: MergeDetails = {
          ...(task.mergeDetails || {}),
          mergeConfirmed: true,
          noOpMerge: true,
          noOpReason,
          mergedAt: new Date().toISOString(),
        };

        await this.store.updateTask(task.id, { mergeDetails });
        await this.store.logEntry(
          task.id,
          `Auto-finalized: ${noOpReason}; treating as no-op merge and moving to done`,
        );
        await this.store.moveTask(task.id, "done");
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
      if (!settings.autoMerge) return 0;
      if (settings.globalPause || settings.enginePaused) return 0;

      const tasks = await this.store.listTasks({ column: "in-review", slim: true });

      const mergeable = tasks.filter((t) =>
        t.column === "in-review" &&
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
   * @returns Number of tasks sent back for fix
   */
  async recoverReviewTasksWithFailedPreMergeSteps(): Promise<number> {
    const recoverFn = this.options.recoverFailedPreMergeStep;
    if (!recoverFn) return 0;

    try {
      const settings = await this.store.getSettings();
      const maxFixes = settings.maxPostReviewFixes ?? 1;
      if (!Number.isFinite(maxFixes) || maxFixes <= 0) return 0;

      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();

      const candidates = tasks.filter((task) => {
        if (task.column !== "in-review") return false;
        if (task.paused) return false;
        // Preserve terminal/human-handoff statuses (failed, awaiting-user-review,
        // merging, etc.). Only revive tasks that are otherwise idle.
        if (task.status) return false;
        if (executingIds.has(task.id)) return false;
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
   */
  async recoverStaleIncompleteReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!timeoutMs || timeoutMs <= 0) return 0;

      const now = Date.now();
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const staleIncomplete = tasks.filter((task) =>
        task.column === "in-review" &&
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
          await this.store.logEntry(
            task.id,
            "Auto-recovered: in-review task still had incomplete steps — moved back to todo for retry",
          );
          await this.store.moveTask(task.id, "todo", { preserveProgress: true });
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
        const signal = getInReviewStallReason(task, {
          now: cycleStartMs,
          activeMergeTaskId,
          executingTaskIds,
          staleMergingMinAgeMs: this.options.staleMergingStatusMinAgeMs ?? DEFAULT_STALE_MERGING_STATUS_MIN_AGE_MS,
          maxAutoMergeRetries: MAX_AUTO_MERGE_RETRIES,
        });
        if (!signal) continue;

        if (Date.parse(task.updatedAt) >= cycleStartMs) {
          continue;
        }

        const previous = [...(task.log ?? [])]
          .reverse()
          .find((entry) => entry.action.startsWith("In-review stall surfaced ["));
        if (previous) {
          const parsed = /^In-review stall surfaced \[([^\]]+)\]/.exec(previous.action);
          const previousCode = parsed?.[1];
          const previousAt = Date.parse(previous.timestamp);
          if (Number.isFinite(previousAt) && previousAt >= cycleStartMs - timeoutMs && previousCode === signal.code) {
            continue;
          }
        }

        await this.store.logEntry(task.id, `In-review stall surfaced [${signal.code}]: ${signal.reason}`);
        surfaced += 1;
      }

      return surfaced;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`In-review stall surfacing failed: ${errorMessage}`);
      return 0;
    }
  }

  async recoverGhostReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!timeoutMs || timeoutMs <= 0) return 0;
      if (settings.globalPause || settings.enginePaused) return 0;

      const now = Date.now();
      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const ghosts = tasks.filter((task) =>
        task.column === "in-review" &&
        !task.paused &&
        !executingIds.has(task.id) &&
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
          if (task.status) {
            await this.store.updateTask(task.id, { status: null, error: null });
          }
          await this.store.logEntry(
            task.id,
            "Auto-recovered: in-review task idle past stuck-task timeout — kicked back to todo",
          );
          await this.store.moveTask(task.id, "todo", { preserveProgress: true });
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
   * @returns Number of tasks finalized or unblocked
   */
  async recoverInterruptedMergingTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      const timeoutMs = settings.taskStuckTimeoutMs;
      if (!timeoutMs || timeoutMs <= 0) return 0;

      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((task) =>
        task.column === "in-review" &&
        !task.paused &&
        Boolean(task.status && ACTIVE_MERGE_STATUSES.has(task.status)) &&
        this.isPastInterruptedMergeGrace(task, timeoutMs),
      );

      if (candidates.length === 0) return 0;

      log.warn(`Found ${candidates.length} stale merging task(s) in in-review`);

      let recovered = 0;
      for (const task of candidates) {
        try {
          const landedCommit = await this.findLandedTaskCommit(task);

          if (landedCommit) {
            const mergeDetails: MergeDetails = {
              commitSha: landedCommit.sha,
              filesChanged: landedCommit.filesChanged,
              insertions: landedCommit.insertions,
              deletions: landedCommit.deletions,
              mergeCommitMessage: landedCommit.subject,
              mergedAt: new Date().toISOString(),
              mergeConfirmed: true,
              prNumber: task.prInfo?.number,
            };

            await this.store.updateTask(task.id, {
              status: null,
              error: null,
              mergeRetries: 0,
              mergeDetails,
            });
            await this.store.moveTask(task.id, "done");
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

  async recoverDoneTaskMergeMetadata(): Promise<number> {
    try {
      const tasks = await this.store.listTasks({ column: "done", slim: true });
      const candidates = tasks.filter((task) => task.column === "done" && !task.paused && Boolean(task.mergeDetails?.commitSha));
      if (candidates.length === 0) return 0;

      let repaired = 0;
      for (const task of candidates) {
        try {
          const storedSha = task.mergeDetails?.commitSha;
          if (!storedSha) continue;

          if (task.mergeDetails?.mergeConfirmed === true) {
            const landed = await this.findLandedTaskCommit(task);
            if (!landed || landed.sha !== storedSha) {
              log.warn(
                `Refusing to overwrite confirmed mergeDetails.commitSha for ${task.id} — stored SHA ${storedSha.slice(0, 8)} no longer reachable; preserving canonical attribution`,
              );
              continue;
            }

            const needsMetadataRepair =
              task.mergeDetails?.filesChanged === undefined ||
              task.mergeDetails?.insertions === undefined ||
              task.mergeDetails?.deletions === undefined ||
              task.mergeDetails?.mergeCommitMessage === undefined;

            if (!needsMetadataRepair) continue;

            await this.store.updateTask(task.id, {
              mergeDetails: {
                ...task.mergeDetails,
                filesChanged: task.mergeDetails?.filesChanged ?? landed.filesChanged,
                insertions: task.mergeDetails?.insertions ?? landed.insertions,
                deletions: task.mergeDetails?.deletions ?? landed.deletions,
                mergeCommitMessage: task.mergeDetails?.mergeCommitMessage ?? landed.subject,
                mergedAt: task.mergeDetails?.mergedAt ?? new Date().toISOString(),
                prNumber: task.prInfo?.number,
              },
            });
            await this.store.logEntry(task.id, `Auto-recovered: reconciled done-task mergeDetails to owned commit ${landed.sha.slice(0, 8)}`);
            repaired++;
            continue;
          }

          const landed = await this.findLandedTaskCommit(task, { preferEarliestOwnedCommit: true });
          if (!landed) {
            await this.store.updateTask(task.id, { mergeDetails: undefined });
            await this.store.logEntry(task.id, "Auto-recovered: cleared unowned done-task mergeDetails commitSha");
            repaired++;
            continue;
          }

          const needsRepair =
            task.mergeDetails?.commitSha !== landed.sha ||
            task.mergeDetails?.filesChanged === undefined;

          if (!needsRepair) continue;

          await this.store.updateTask(task.id, {
            mergeDetails: {
              ...task.mergeDetails,
              commitSha: landed.sha,
              filesChanged: landed.filesChanged,
              insertions: landed.insertions,
              deletions: landed.deletions,
              mergeCommitMessage: landed.subject,
              mergedAt: task.mergeDetails?.mergedAt ?? new Date().toISOString(),
              mergeConfirmed: true,
              prNumber: task.prInfo?.number,
            },
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
   * @returns Number of tasks recovered
   */
  async recoverMergedReviewTasks(): Promise<number> {
    try {
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });

      const mergedButNotDone = tasks.filter((t) =>
        t.column === "in-review" &&
        !t.paused &&
        t.mergeDetails?.mergeConfirmed === true,
      );

      if (mergedButNotDone.length === 0) return 0;

      log.warn(`Found ${mergedButNotDone.length} merged task(s) stuck in in-review`);

      let recovered = 0;
      for (const task of mergedButNotDone) {
        try {
          const blocker = getTaskMergeBlocker({
            ...task,
            status: undefined,
            error: undefined,
            steps: task.steps ?? [],
            workflowStepResults: task.workflowStepResults,
          });
          if (blocker) {
            await this.store.updateTask(task.id, {
              status: "failed",
              error: `Merge confirmed but finalization blocked: ${blocker}`,
            });
            await this.store.logEntry(
              task.id,
              `Auto-recovery skipped: merge confirmed but finalization blocked — ${blocker}`,
            );
            continue;
          }

          await this.store.updateTask(task.id, {
            status: null,
            error: null,
            mergeRetries: 0,
          });
          await this.store.moveTask(task.id, "done");
          await this.store.logEntry(
            task.id,
            "Auto-recovered: merge already confirmed — moved from in-review to done",
          );
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
        const cooldownStart = this.deadlockRecoveryCooldown.get(task.id) ?? 0;
        const cooldownElapsed = now - cooldownStart;
        const hasBlockedDependents = (dependentsByBlocker.get(task.id) ?? []).some(
          (dep) => dep.column === "triage" || dep.column === "todo",
        );
        return task.column === "in-review" &&
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
        const blockedDependents = dependentsByBlocker.get(task.id) ?? [];
        const blockedTaskIds = blockedDependents.map((dep) => dep.id);
        try {
          const landedCommit = await this.findLandedTaskCommit(task);
          if (landedCommit) {
            const mergeDetails: MergeDetails = {
              commitSha: landedCommit.sha,
              filesChanged: landedCommit.filesChanged,
              insertions: landedCommit.insertions,
              deletions: landedCommit.deletions,
              mergeCommitMessage: landedCommit.subject,
              mergedAt: new Date().toISOString(),
              mergeConfirmed: true,
              prNumber: task.prInfo?.number,
            };

            await this.store.updateTask(task.id, {
              status: null,
              error: null,
              mergeRetries: 0,
              worktree: null,
              branch: null,
              mergeDetails,
            });
            await this.store.moveTask(task.id, "done");
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
            await this.store.updateTask(task.id, { paused: true });
            await this.store.logEntry(task.id, "merge-deadlock-detected: requires manual intervention — verified content not on main");
            log.warn(`self-heal:deadlock-recovered ${JSON.stringify({ stuckTaskId: task.id, blockedTaskIds, attributedSha: null, action: "paused-for-manual" })}`);
            recovered++;
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

  async recoverOrphanOnlyScopeViolations(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((task) =>
        task.column === "in-review" &&
        !task.paused &&
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

          const baseBranch = task.baseBranch || task.executionStartBranch || "main";
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
          };

          const blocker = getTaskMergeBlocker({
            ...task,
            status: undefined,
            error: undefined,
            steps: task.steps ?? [],
            workflowStepResults: task.workflowStepResults,
          });
          if (blocker) {
            await this.store.updateTask(task.id, {
              status: "failed",
              error: `Merge confirmed but finalization blocked: ${blocker}`,
              mergeDetails,
            });
            await this.store.logEntry(
              task.id,
              `Auto-recovery parked task in in-review: merged content found on ${baseBranch} (${landed.sha.slice(0, 8)}) but finalization blocked — ${blocker}`,
            );
            continue;
          }

          await this.store.updateTask(task.id, {
            status: null,
            error: null,
            mergeRetries: 0,
            mergeDetails,
          });
          await this.store.moveTask(task.id, "done");
          await this.store.logEntry(
            task.id,
            `Auto-recovered: FileScopeViolationError treated as orphan-only — task work already on main (commit: ${landed.sha.slice(0, 8)} via ${landed.strategy}; rejected orphans: ${orphanFiles.join(", ")})`,
          );
          await this.cleanupWorktreeOnly(task);
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
   */
  async recoverAlreadyMergedReviewTasks(): Promise<number> {
    try {
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) return 0;

      const executingIds = this.options.getExecutingTaskIds?.() ?? new Set<string>();
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((task) =>
        task.column === "in-review" &&
        task.status === "failed" &&
        (task.mergeRetries ?? 0) >= MAX_AUTO_MERGE_RETRIES &&
        task.mergeDetails?.mergeConfirmed !== true &&
        !executingIds.has(task.id),
      );

      if (candidates.length === 0) return 0;

      let recovered = 0;
      for (const task of candidates) {
        try {
          const baseBranch = task.baseBranch || task.executionStartBranch || "main";
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
            prNumber: task.prInfo?.number,
          };

          const blocker = getTaskMergeBlocker({
            ...task,
            status: undefined,
            error: undefined,
            steps: task.steps ?? [],
            workflowStepResults: task.workflowStepResults,
          });
          if (blocker) {
            await this.store.updateTask(task.id, {
              status: "failed",
              error: `Merge confirmed but finalization blocked: ${blocker}`,
              mergeDetails,
            });
            await this.store.logEntry(
              task.id,
              `Auto-recovery parked task in in-review: merged content found on ${baseBranch} (${landed.sha.slice(0, 8)}) but finalization blocked — ${blocker}`,
            );
            continue;
          }

          await this.store.updateTask(task.id, {
            status: null,
            error: null,
            mergeRetries: 0,
            mergeDetails,
          });
          const worktreeHint = task.worktree;
          await this.store.moveTask(task.id, "done");
          await this.store.logEntry(
            task.id,
            `Auto-recovered: phantom-merge-guard false positive — content found on ${baseBranch} at ${landed.sha.slice(0, 8)} via ${landed.strategy}`,
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
              type: "task:auto-recover-already-merged",
              target: task.id,
              metadata: {
                mergeSha: landed.sha,
                mergeStrategy: landed.strategy,
                baseBranch,
                mergeRetries: task.mergeRetries ?? 0,
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
        const ahead = await isBranchAheadOfBase(task, this.options.rootDir, task.baseBranch || "main");
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

      log.warn(`Found ${orphaned.length} orphaned executor task(s) stuck in in-progress`);

      let recovered = 0;
      for (const task of orphaned) {
        try {
          const hadWorktree = task.worktree && existsSync(task.worktree);
          const reason = hadWorktree
            ? "worktree exists but no active session"
            : "missing worktree/session";

          if (this.options.leaseManager && task.checkedOutBy) {
            const leaseRecovered = await this.options.leaseManager.recoverAbandonedLease(
              task.id,
              `orphaned execution: ${reason}`,
              { preserveProgress: true },
            );
            if (leaseRecovered) {
              recovered++;
              continue;
            }
          }

          // Reset steps whose work was never committed before clearing the worktree
          await this.resetStepsIfWorkLost(task);

          await this.store.updateTask(task.id, {
            status: "stuck-killed",
            worktree: null,
            branch: null,
          });
          await this.store.logEntry(
            task.id,
            `Auto-recovered orphaned executor task — ${reason}, moved back to todo`,
          );
          await this.store.moveTask(task.id, "todo", { preserveProgress: true });
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover orphaned executor task ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} orphaned executor task(s) → todo`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
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

          await this.store.updateTask(task.id, {
            status: "stuck-killed",
            worktree: null,
            branch: null,
          });
          await this.store.logEntry(
            task.id,
            "Auto-recovered no-progress no-task_done failure — clean worktree, moved back to todo",
          );
          await this.store.moveTask(task.id, "todo");
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
   * Recover failed `in-review` retries that point at a missing worktree path.
   *
   * This is a narrow guard for session-start failures thrown by
   * assertValidWorktreeSession() (`Refusing to start coding agent in missing worktree:`).
   * We clear stale worktree metadata and failure state, keep step progress and
   * retry counters, then requeue to todo for a clean retry.
   */
  async recoverMissingWorktreeReviewFailures(): Promise<number> {
    try {
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });
      const candidates = tasks.filter((task) => isRecoverableMissingWorktreeReviewFailure(task));

      if (candidates.length === 0) return 0;

      log.warn(`Found ${candidates.length} in-review task(s) failed by missing-worktree session start`);

      let recovered = 0;
      for (const task of candidates) {
        try {
          const staleWorktree = task.worktree;
          const missingWorktreePath = extractMissingWorktreePathFromSessionStartFailure(task.error);
          const hasMismatchedLiveWorktree =
            typeof staleWorktree === "string" && staleWorktree.length > 0 &&
            typeof missingWorktreePath === "string" && missingWorktreePath.length > 0 &&
            resolve(staleWorktree) !== resolve(missingWorktreePath);

          await this.store.updateTask(task.id, {
            status: null,
            error: null,
            worktree: hasMismatchedLiveWorktree ? staleWorktree : null,
            branch: hasMismatchedLiveWorktree ? task.branch ?? null : null,
            sessionFile: null,
          });
          await this.store.logEntry(
            task.id,
            hasMismatchedLiveWorktree
              ? `Auto-recovered: stale resume referenced missing worktree (${missingWorktreePath}) while live task worktree is ${staleWorktree} — cleared stale session metadata and requeued to todo`
              : `Auto-recovered: retry/verification session targeted missing worktree${staleWorktree ? ` (${staleWorktree})` : ""} — cleared stale session metadata and requeued to todo`,
          );
          await this.store.moveTask(task.id, "todo", { preserveProgress: true });
          recovered++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover missing-worktree review failure ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} missing-worktree review failure(s) → todo`);
      }
      return recovered;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Missing-worktree review recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover `in-review` tasks marked as `failed` because the agent exited
   * without calling `fn_task_done` *with partial step progress* (some steps done,
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
   * @returns Number of tasks requeued for retry
   */
  async recoverPartialProgressNoTaskDoneFailures(): Promise<number> {
    try {
      const tasks = await this.store.listTasks({ column: "in-review", slim: true });

      const candidates = tasks.filter((task) =>
        task.column === "in-review" &&
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
          await this.store.moveTask(task.id, "todo", { preserveProgress: true });
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

    const branchName = task.branch || `fusion/${task.id.toLowerCase()}`;
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

      if (settings.recycleWorktrees) {
        // Recycle on: only sweep unregistered stale dirs.
        return await this.reapUnregisteredOrphans();
      }

      const orphaned = await scanIdleWorktrees(this.options.rootDir, this.store);
      if (orphaned.length === 0) return 0;

      let cleaned = 0;
      for (const worktreePath of orphaned) {
        try {
          await execAsync(`git worktree remove "${worktreePath}" --force`, {
            cwd: this.options.rootDir,
            timeout: 30_000,
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
    const worktreesDir = join(this.options.rootDir, ".worktrees");
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

  private deriveTaskIdFromFusionBranch(branch: string): string | null {
    const match = /^fusion\/(fn|kb)-(\d+)$/i.exec(branch.trim());
    if (!match) return null;
    return `${match[1].toUpperCase()}-${match[2]}`;
  }

  private async getRegisteredWorktreePathForBranch(branch: string): Promise<string | null> {
    try {
      const stdout = execSync("git worktree list --porcelain", {
        cwd: this.options.rootDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }) || "";
      const lines = stdout.split("\n");
      let currentPath: string | null = null;
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          currentPath = line.slice("worktree ".length).trim();
          continue;
        }
        if (line.startsWith("branch ")) {
          const fullRef = line.slice("branch ".length).trim();
          const branchName = fullRef.startsWith("refs/heads/") ? fullRef.slice("refs/heads/".length) : fullRef;
          if (branchName === branch && currentPath) {
            return currentPath;
          }
        }
      }
    } catch (err: unknown) {
      log.warn(`Failed to inspect registered worktree for ${branch}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  private async inspectOrphanedBranch(branch: string): Promise<OrphanBranchInspection | null> {
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

      let uniqueCommitSubjects: string[] = [];
      if (uniqueCommitCount > 0) {
        const subjectOutput = String(execSync(`git log --format=%s --max-count=${ORPHAN_RESCUE_SUBJECT_CAP} ${shellQuote(branch)} --not ${shellQuote("main")}`, {
          cwd: this.options.rootDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }));
        uniqueCommitSubjects = subjectOutput.split("\n").map((line) => line.trim()).filter(Boolean);
      }

      return {
        branch,
        tipSha,
        uniqueCommitCount,
        uniqueCommitSubjects,
        derivedTaskId: this.deriveTaskIdFromFusionBranch(branch),
        registeredWorktreePath: await this.getRegisteredWorktreePathForBranch(branch),
      };
    } catch (err: unknown) {
      log.warn(`Failed to inspect orphaned branch ${branch}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Resolve orphaned `fusion/*` branches.
   * - Subsumed branches are pruned (`git branch -d`).
   * - Unique-commit branches with missing task rows are rescued into triage tasks.
   * - Archived matching tasks are left untouched with one-time acknowledgement logging.
   */
  async cleanupOrphanedBranches(): Promise<number> {
    try {
      const orphaned = await scanOrphanedBranches(this.options.rootDir, this.store);
      if (orphaned.length === 0) return 0;

      let cleaned = 0;
      const prunedBranches: string[] = [];
      const allTasks = await this.store.listTasks({ slim: true, includeArchived: true });
      const taskById = new Map(allTasks.map((task) => [task.id.toUpperCase(), task]));

      for (const branch of orphaned) {
        const inspection = await this.inspectOrphanedBranch(branch);
        if (!inspection) continue;

        if (inspection.uniqueCommitCount <= 0) {
          try {
            execSync(`git branch -d ${shellQuote(branch)}`, {
              cwd: this.options.rootDir,
              stdio: ["pipe", "pipe", "pipe"],
            });
            prunedBranches.push(branch);
            cleaned++;
            try {
              const auditor = createRunAuditor(this.store, {
                runId: generateSyntheticRunId("self-heal", "orphan-branch"),
                agentId: "self-healing",
                phase: "orphan-branch-rescue",
              });
              await auditor.git({
                type: "branch:orphan-prune",
                target: branch,
                metadata: {
                  phase: "orphan-branch-rescue",
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
          continue;
        }

        const derivedTaskId = inspection.derivedTaskId;
        const matchedTask = derivedTaskId ? taskById.get(derivedTaskId.toUpperCase()) : undefined;
        const existingBranchTask = allTasks.find((task) => task.branch === branch);

        if (matchedTask?.column === "archived") {
          if (!this.orphanArchivedAcknowledged.has(matchedTask.id)) {
            this.orphanArchivedAcknowledged.add(matchedTask.id);
            log.warn(`[recovery] orphan-rescue-archived-skip ${matchedTask.id} branch=${branch} tip=${inspection.tipSha.slice(0, 12)} unique=${inspection.uniqueCommitCount}`);
          }
          continue;
        }

        if (!matchedTask && !existingBranchTask) {
          const summaryLines = [
            `Recovered orphaned branch: ${branch}`,
            `Tip: ${inspection.tipSha}`,
            `Unique commits vs main: ${inspection.uniqueCommitCount}`,
          ];
          if (inspection.uniqueCommitSubjects.length > 0) {
            summaryLines.push("Recent commit subjects:");
            for (const subject of inspection.uniqueCommitSubjects) {
              summaryLines.push(`- ${subject}`);
            }
          }
          const rescueTask = await this.store.createTask({
            title: `Recover orphaned branch ${branch}`,
            description: summaryLines.join("\n"),
            branch,
            column: "triage",
          });
          allTasks.push({ ...rescueTask, branch, column: "triage" } as Task);
          if (inspection.registeredWorktreePath) {
            await this.store.updateTask(rescueTask.id, { worktree: inspection.registeredWorktreePath });
          }
          await this.store.logEntry(rescueTask.id, `[recovery] orphan-rescue-created ${rescueTask.id} from ${branch} (${inspection.uniqueCommitCount} unique commits)`);

          try {
            const auditor = createRunAuditor(this.store, {
              runId: generateSyntheticRunId("self-heal", rescueTask.id),
              agentId: "self-healing",
              taskId: rescueTask.id,
              taskLineageId: rescueTask.lineageId,
              phase: "orphan-branch-rescue",
            });
            await auditor.git({
              type: "branch:orphan-rescued",
              target: branch,
              metadata: {
                phase: "orphan-branch-rescue",
                rescueTaskId: rescueTask.id,
                tipSha: inspection.tipSha,
                uniqueCommitCount: inspection.uniqueCommitCount,
                derivedTaskId: derivedTaskId ?? null,
              },
            });
          } catch (auditErr: unknown) {
            log.warn(`Failed to write branch:orphan-rescued run-audit event for ${branch}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`);
          }
        }
      }

      if (prunedBranches.length > 0) {
        const cleared = this.store.clearStaleExecutionStartBranchReferences(prunedBranches);
        if (cleared.length > 0) {
          log.log(`Cleared stale baseBranch on ${cleared.length} task(s): ${cleared.join(", ")}`);
        }
      }

      return cleaned;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphaned branch cleanup failed: ${errorMessage}`);
      return 0;
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
    const worktreesDir = join(this.options.rootDir, ".worktrees");
    if (!existsSync(worktreesDir)) return;

    try {
      const settings = await this.store.getSettings();
      const cap = (settings.maxWorktrees ?? 4) * 2;

      const entries = readdirSync(worktreesDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());

      if (dirs.length <= cap) return;

      // Find idle worktrees that can be safely removed
      const idle = await scanIdleWorktrees(this.options.rootDir, this.store);
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
        try {
          await execAsync(`git worktree remove "${worktreePath}" --force`, {
            cwd: this.options.rootDir,
            timeout: 30_000,
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

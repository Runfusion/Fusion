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

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getTaskMergeBlocker, type TaskStore, type Settings, type Task, type MergeDetails } from "@fusion/core";
import { createLogger } from "./logger.js";
import { scanIdleWorktrees, scanOrphanedBranches } from "./worktree-pool.js";

const log = createLogger("self-healing");
const execAsync = promisify(exec);

export interface SelfHealingOptions {
  /** Project root directory (parent of .worktrees/) */
  rootDir: string;
  /**
   * Callback to recover a completed task that is stuck in in-progress.
   * Called by the periodic maintenance cycle when it detects a task whose
   * work is done but was never transitioned to in-review (e.g., killed by
   * stuck detector after task_done but before moveTask).
   *
   * Should return true if the task was successfully transitioned out of
   * in-progress, false if recovery failed.
   */
  recoverCompletedTask?: (task: Task) => Promise<boolean>;
  /**
   * Returns the set of task IDs currently being executed by the executor.
   * Used to avoid recovering tasks that are actively being worked on.
   */
  getExecutingTaskIds?: () => Set<string>;
  /**
   * Recover a triage task whose spec was approved but whose final transition
   * out of `status: "specifying"` never completed.
   */
  recoverApprovedTriageTask?: (task: Task) => Promise<boolean>;
  /**
   * Returns the set of task IDs currently being specified by triage.
   * Used to avoid recovering active triage sessions.
   */
  getSpecifyingTaskIds?: () => Set<string>;
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
}

const APPROVED_TRIAGE_RECOVERY_GRACE_MS = 60_000;
const ORPHANED_EXECUTION_RECOVERY_GRACE_MS = 60_000;
const ACTIVE_MERGE_STATUSES = new Set(["merging", "merging-pr"]);
const NON_TERMINAL_STEP_STATUSES = new Set(["pending", "in-progress"]);
/**
 * Longer grace period for tasks that still have a worktree on disk.
 * This avoids racing with `executor.resumeOrphaned()` which runs on
 * engine startup and may legitimately re-execute these tasks.
 * 5 minutes is well past any startup window.
 */
const ORPHANED_WITH_WORKTREE_GRACE_MS = 300_000;

interface LandedTaskCommit {
  sha: string;
  subject?: string;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

    // Start periodic maintenance
    this.startMaintenance();

    log.log("Started");
  }

  /**
   * Run only the recovery subset needed at runtime startup, after the executor
   * has had a chance to resume orphaned sessions.
   *
   * This avoids waiting for the periodic maintenance interval before fixing
   * stale in-progress/specifying tasks that no longer have a live worker.
   */
  async runStartupRecovery(): Promise<void> {
    // Each recovery step is isolated — one failure doesn't prevent subsequent steps.
    const steps: Array<{ name: string; fn: () => Promise<unknown> }> = [
      { name: "no-progress-no-task-done", fn: () => this.recoverNoProgressNoTaskDoneFailures().then(() => undefined) },
      { name: "completed-tasks", fn: () => this.recoverCompletedTasks().then(() => undefined) },
      { name: "stale-incomplete-review", fn: () => this.recoverStaleIncompleteReviewTasks().then(() => undefined) },
      { name: "failed-pre-merge-steps", fn: () => this.recoverReviewTasksWithFailedPreMergeSteps().then(() => undefined) },
      { name: "interrupted-merging", fn: () => this.recoverInterruptedMergingTasks().then(() => undefined) },
      { name: "misclassified-failures", fn: () => this.recoverMisclassifiedFailures().then(() => undefined) },
      { name: "orphaned-executions", fn: () => this.recoverOrphanedExecutions().then(() => undefined) },
      { name: "approved-triage", fn: () => this.recoverApprovedTriageTasks().then(() => undefined) },
      { name: "orphaned-specifying", fn: () => this.recoverOrphanedSpecifyingTasks().then(() => undefined) },
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
   * @returns `true` if the task should be re-queued, `false` if budget exhausted
   *          (task has been marked as permanently failed).
   */
  async checkStuckBudget(taskId: string): Promise<boolean> {
    try {
      const settings = await this.store.getSettings();
      const maxKills = settings.maxStuckKills ?? 6;

      const task = await this.store.getTask(taskId);
      const newCount = (task.stuckKillCount ?? 0) + 1;

      if (newCount > maxKills) {
        // Budget exhausted — mark as permanently failed
        log.warn(`${taskId} exceeded stuck kill budget (${newCount}/${maxKills}) — marking failed`);
        await this.store.updateTask(taskId, {
          stuckKillCount: newCount,
          status: "failed",
          error: `Task stuck ${newCount} times — exceeded maximum of ${maxKills} stuck kills`,
        });
        try {
          await this.store.moveTask(taskId, "in-review");
        } catch (moveErr: unknown) {
          // moveTask may fail if task was concurrently moved (e.g., dep-abort).
          // The task is already marked failed — don't allow requeue.
          const moveErrMessage = moveErr instanceof Error ? moveErr.message : String(moveErr);
          log.warn(`${taskId} moveTask("in-review") failed (${moveErrMessage}) — task already marked failed, not re-queuing`);
        }
        await this.store.logEntry(
          taskId,
          `Permanently failed: agent stuck ${newCount} times (max: ${maxKills}) — moved to in-review`,
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

  private async findLandedTaskCommit(task: Task): Promise<LandedTaskCommit | null> {
    const readLog = async (range: string) => {
      const command = [
        "git log",
        "--format=%H%x1f%s",
        "--max-count=20",
        "--fixed-strings",
        `--grep=${shellQuote(task.id)}`,
        shellQuote(range),
      ].join(" ");

      return execAsync(command, {
        cwd: this.options.rootDir,
        maxBuffer: 1024 * 1024,
      });
    };

    let stdout: string;
    try {
      const result = await readLog(task.baseCommitSha ? `${task.baseCommitSha}..HEAD` : "HEAD");
      stdout = result.stdout;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.warn(
        `Failed to read git log for landed commit lookup (${task.id}): ${errorMessage} — retrying with HEAD range`,
      );
      if (!task.baseCommitSha) return null;
      const result = await readLog("HEAD");
      stdout = result.stdout;
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

      // Batch 2 — Task recovery (operations are independent of each other)
      const batch2Fns: Array<{ name: string; fn: () => Promise<unknown> }> = [
        { name: "recover-completed-tasks", fn: () => this.recoverCompletedTasks() },
        { name: "recover-stale-incomplete-review", fn: () => this.recoverStaleIncompleteReviewTasks() },
        { name: "recover-failed-pre-merge-steps", fn: () => this.recoverReviewTasksWithFailedPreMergeSteps() },
        { name: "recover-interrupted-merging", fn: () => this.recoverInterruptedMergingTasks() },
        { name: "recover-mergeable-review", fn: () => this.recoverMergeableReviewTasks() },
        { name: "recover-merged-review", fn: () => this.recoverMergedReviewTasks() },
        { name: "recover-misclassified-failures", fn: () => this.recoverMisclassifiedFailures() },
        { name: "recover-no-progress-no-task-done", fn: () => this.recoverNoProgressNoTaskDoneFailures() },
        { name: "recover-orphaned-executions", fn: () => this.recoverOrphanedExecutions() },
        { name: "recover-approved-triage", fn: () => this.recoverApprovedTriageTasks() },
        { name: "recover-orphaned-specifying", fn: () => this.recoverOrphanedSpecifyingTasks() },
      ];
      for (const fn of batch2Fns) {
        try {
          await fn.fn();
          log.log(`Maintenance batch 2 step "${fn.name}" succeeded`);
        } catch (stepErr) {
          log.error(`Maintenance batch 2 step "${fn.name}" failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
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

      const stale = tasks.filter((t) => {
        if (t.column !== "done") return false;
        // Prefer columnMovedAt (when the task entered done); fall back to updatedAt
        // for legacy tasks that lack the field.
        const ts = t.columnMovedAt || t.updatedAt;
        const movedAt = ts ? Date.parse(ts) : NaN;
        if (!Number.isFinite(movedAt)) return false;
        return movedAt < cutoff;
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
      const tasks = await this.store.listTasks({ column: "in-progress" });
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
      const tasks = await this.store.listTasks({ column: "in-review" });

      const mergeable = tasks.filter((t) =>
        t.column === "in-review" &&
        Boolean(t.worktree) &&
        t.mergeDetails?.mergeConfirmed !== true &&
        getTaskMergeBlocker(t) === undefined,
      );

      if (mergeable.length === 0) return 0;

      log.warn(`Found ${mergeable.length} mergeable review task(s) stuck in in-review`);

      let recovered = 0;
      for (const task of mergeable) {
        try {
          await this.store.mergeTask(task.id);
          await this.store.logEntry(
            task.id,
            "Auto-recovered: eligible in-review task was merged and moved to done",
          );
          log.log(`Recovered mergeable review task ${task.id}: merged to done`);
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

      const tasks = await this.store.listTasks({ column: "in-review" });
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
      const tasks = await this.store.listTasks({ column: "in-review" });
      const staleIncomplete = tasks.filter((task) =>
        task.column === "in-review" &&
        !task.paused &&
        !task.status &&
        task.steps.length > 0 &&
        task.steps.some((step) => NON_TERMINAL_STEP_STATUSES.has(step.status)) &&
        now - new Date(task.updatedAt).getTime() >= timeoutMs
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
          await this.store.moveTask(task.id, "todo");
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

      const tasks = await this.store.listTasks({ column: "in-review" });
      const candidates = tasks.filter((task) =>
        task.column === "in-review" &&
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
      const tasks = await this.store.listTasks({ column: "in-review" });

      const mergedButNotDone = tasks.filter((t) =>
        t.column === "in-review" &&
        t.mergeDetails?.mergeConfirmed === true,
      );

      if (mergedButNotDone.length === 0) return 0;

      log.warn(`Found ${mergedButNotDone.length} merged task(s) stuck in in-review`);

      let recovered = 0;
      for (const task of mergedButNotDone) {
        try {
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
   * Recover tasks in `in-review` marked as `failed` where all steps are
   * actually done. This catches the case where an agent completed all work
   * but the session ended without calling `task_done` (e.g., context
   * overflow, compaction losing tool awareness). The executor marks these
   * as failed, but the work is complete — clear the error so the normal
   * review flow can proceed.
   *
   * @returns Number of tasks recovered
   */
  async recoverMisclassifiedFailures(): Promise<number> {
    try {
      const tasks = await this.store.listTasks({ column: "in-review" });

      const misclassified = tasks.filter((t) =>
        t.column === "in-review" &&
        t.status === "failed" &&
        t.error?.includes("without calling task_done") &&
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
            "Auto-recovered: all steps complete despite 'no task_done' failure — cleared error for normal review",
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
   * Recover executor tasks stranded in `in-progress` before a real session was
   * established, typically when the scheduler reserved a worktree path but the
   * executor never materialized it or crashed before tracking the run.
   */
  async recoverOrphanedExecutions(): Promise<number> {
    try {
      const tasks = await this.store.listTasks({ column: "in-progress" });
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
          await this.store.moveTask(task.id, "todo");
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

  /**
   * Recover `in-progress` tasks that failed only because the agent exited
   * without calling task_done, and where there is no sign of work to preserve.
   *
   * These are safe to requeue automatically when no steps progressed and git
   * has neither worktree changes nor branch commits. Cases with any evidence
   * of work are left alone for manual inspection or the normal orphan recovery
   * path.
   */
  async recoverNoProgressNoTaskDoneFailures(): Promise<number> {
    try {
      const tasks = await this.store.listTasks({ column: "in-progress" });
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
   * left stuck in `status: "specifying"` without an active triage session.
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
      const specifyingIds = this.options.getSpecifyingTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      const orphanedApproved = tasks.filter((t) =>
        t.column === "triage" &&
        t.status === "specifying" &&
        !t.paused &&
        !specifyingIds.has(t.id) &&
        now - new Date(t.updatedAt).getTime() >= APPROVED_TRIAGE_RECOVERY_GRACE_MS &&
        hasLatestSpecReviewApproval(t),
      );

      if (orphanedApproved.length === 0) return 0;

      log.warn(`Found ${orphanedApproved.length} approved triage task(s) stuck in specifying`);

      let recovered = 0;
      for (const task of orphanedApproved) {
        log.log(`Recovering approved triage task ${task.id}: ${task.title || task.description?.slice(0, 60) || "(untitled)"}`);
        const success = await recoverFn(task);
        if (success) recovered++;
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} approved triage task(s) out of specifying`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Approved triage recovery failed: ${errorMessage}`);
      return 0;
    }
  }

  /**
   * Recover triage tasks stuck in `status: "specifying"` whose agent session
   * died before producing an approved spec.
   *
   * These tasks fall through two cracks:
   * - The stuck task detector only monitors tasks with active tracked sessions.
   *   If the session crashed or was never started, the task is never tracked.
   * - `recoverApprovedTriageTasks` only handles tasks with an approved spec.
   *
   * Recovery clears the status back to `null` so the next triage poll picks
   * them up for a fresh specification attempt.
   */
  async recoverOrphanedSpecifyingTasks(): Promise<number> {
    try {
      // Evict stale entries from the triage processor's in-memory set before
      // checking — tasks with hung promises (from stuck kills) would otherwise
      // block recovery indefinitely.
      this.options.evictStaleTriageProcessing?.();

      const tasks = await this.store.listTasks({ column: "triage" });
      const specifyingIds = this.options.getSpecifyingTaskIds?.() ?? new Set<string>();
      const now = Date.now();

      const orphaned = tasks.filter((t) =>
        t.column === "triage" &&
        t.status === "specifying" &&
        !t.paused &&
        !specifyingIds.has(t.id) &&
        now - new Date(t.updatedAt).getTime() >= APPROVED_TRIAGE_RECOVERY_GRACE_MS &&
        !hasLatestSpecReviewApproval(t),
      );

      if (orphaned.length === 0) return 0;

      log.warn(`Found ${orphaned.length} orphaned specifying triage task(s) without approval`);

      let recovered = 0;
      for (const task of orphaned) {
        try {
          log.log(`Recovering orphaned specifying task ${task.id}: ${task.title || task.description?.slice(0, 60) || "(untitled)"}`);
          await this.store.updateTask(task.id, { status: null });
          await this.store.logEntry(
            task.id,
            "Auto-recovered orphaned specifying task — agent session lost, cleared for re-specification",
          );
          recovered++;
        } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
          log.error(`Failed to recover orphaned specifying task ${task.id}: ${errorMessage}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} orphaned specifying task(s) — cleared for re-specification`);
      }
      return recovered;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphaned specifying task recovery failed: ${errorMessage}`);
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

  /** Remove orphaned worktrees not assigned to any active task. */
  private async cleanupOrphans(): Promise<number> {
    try {
      const orphaned = await scanIdleWorktrees(this.options.rootDir, this.store);
      if (orphaned.length === 0) return 0;

      // Only clean up if recycling is disabled — otherwise they belong in the pool
      const settings = await this.store.getSettings();
      if (settings.recycleWorktrees) {
        return 0;
      }

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
   * Remove orphaned `fusion/*` branches that are not associated with any
   * active (non-archived, non-merger-managed) task.
   *
   * For each orphaned branch:
   * 1. Try `git branch -d` (safe delete — only works if branch is fully merged)
   * 2. Fall back to `git branch -D` (force delete) if safe delete fails
   * 3. Log each cleanup action
   *
   * Individual branch deletion failures are non-fatal.
   *
   * @returns Number of branches successfully deleted
   */
  async cleanupOrphanedBranches(): Promise<number> {
    try {
      const orphaned = await scanOrphanedBranches(this.options.rootDir, this.store);
      if (orphaned.length === 0) return 0;

      let cleaned = 0;
      for (const branch of orphaned) {
        try {
          // Try safe delete first (-d requires branch to be merged)
          await execAsync(`git branch -d "${branch}"`, {
            cwd: this.options.rootDir,
            timeout: 30_000,
          });
          log.log(`Deleted branch: ${branch}`);
          cleaned++;
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          log.warn(
            `Safe delete failed for orphaned branch ${branch}: ${errorMessage} — attempting force delete`,
          );
          // Safe delete failed (not merged) — force delete
          try {
            await execAsync(`git branch -D "${branch}"`, {
              cwd: this.options.rootDir,
              timeout: 30_000,
            });
            log.log(`Force-deleted branch: ${branch}`);
            cleaned++;
          } catch (forceErr: unknown) {
            const forceErrorMessage = forceErr instanceof Error ? forceErr.message : String(forceErr);
            log.warn(`Failed to force-delete orphaned branch ${branch}: ${forceErrorMessage} — non-fatal`);
            // Individual failure is non-fatal
          }
        }
      }

      if (cleaned > 0) {
        log.log(`Cleaned ${cleaned} orphaned branch(es)`);
      }
      return cleaned;
    } catch (err: unknown) { const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Orphaned branch cleanup failed: ${errorMessage}`);
      return 0;
    }
  }

  /** Run SQLite WAL checkpoint to reclaim disk space. */
  private checkpointWal(): void {
    try {
      const result = this.store.walCheckpoint();
      if (result.log > 0) {
        log.log(`WAL checkpoint: ${result.checkpointed}/${result.log} pages checkpointed` +
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
  return task.error?.includes("without calling task_done") === true;
}

function hasStepProgress(task: Task): boolean {
  return task.steps.some((step) => step.status !== "pending");
}

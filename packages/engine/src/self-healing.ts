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

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TaskStore, Settings, Task } from "@fusion/core";
import { createLogger } from "./logger.js";
import { scanIdleWorktrees, scanOrphanedBranches } from "./worktree-pool.js";

const log = createLogger("self-healing");

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
}

const APPROVED_TRIAGE_RECOVERY_GRACE_MS = 60_000;
const ORPHANED_EXECUTION_RECOVERY_GRACE_MS = 60_000;
/**
 * Longer grace period for tasks that still have a worktree on disk.
 * This avoids racing with `executor.resumeOrphaned()` which runs on
 * engine startup and may legitimately re-execute these tasks.
 * 5 minutes is well past any startup window.
 */
const ORPHANED_WITH_WORKTREE_GRACE_MS = 300_000;

export class SelfHealingManager {
  // ── Auto-unpause state ──────────────────────────────────────────────
  private unpauseTimer: ReturnType<typeof setTimeout> | null = null;
  private unpauseAttempt = 0;
  private lastPauseTriggeredAt = 0;
  private lastUnpauseAt = 0;

  // ── Maintenance timer ───────────────────────────────────────────────
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;

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

  stop(): void {
    // Remove settings listener
    if (this.settingsListener) {
      try {
        this.store.removeListener("settings:updated", this.settingsListener);
      } catch {
        // Store may not support removeListener (e.g., test mocks)
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
      await this.store.updateSettings({ globalPause: false });

      // Note: if the rate limit is still active, the next agent session will
      // hit it again → UsageLimitPauser triggers globalPause → our listener
      // catches the transition and schedules the next attempt with escalated backoff.
    } catch (err: any) {
      log.error(`Auto-unpause failed: ${err.message}`);
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
        } catch (moveErr: any) {
          // moveTask may fail if task was concurrently moved (e.g., dep-abort).
          // The task is already marked failed — don't allow requeue.
          log.warn(`${taskId} moveTask("in-review") failed (${moveErr.message}) — task already marked failed, not re-queuing`);
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
    } catch (err: any) {
      log.error(`checkStuckBudget failed for ${taskId}: ${err.message}`);
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
      const mergeBase = execSync(
        `git merge-base "${branchName}" HEAD 2>/dev/null`,
        { cwd: this.options.rootDir, stdio: "pipe", encoding: "utf-8" },
      ).trim();
      const branchHead = execSync(
        `git rev-parse "${branchName}" 2>/dev/null`,
        { cwd: this.options.rootDir, stdio: "pipe", encoding: "utf-8" },
      ).trim();

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
    } catch {
      // Branch may not exist or git commands may fail — non-fatal
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

  private async runMaintenance(): Promise<void> {
    const startMs = Date.now();
    log.log("Maintenance cycle starting");

    try {
      await this.pruneWorktrees();
      await this.cleanupOrphans();
      await this.cleanupOrphanedBranches();
      this.checkpointWal();
      await this.enforceWorktreeCap();
      await this.recoverCompletedTasks();
      await this.recoverMisclassifiedFailures();
      await this.recoverOrphanedExecutions();
      await this.recoverApprovedTriageTasks();

      const elapsedMs = Date.now() - startMs;
      log.log(`Maintenance cycle completed in ${elapsedMs}ms`);
    } catch (err: any) {
      log.error(`Maintenance cycle failed: ${err.message}`);
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
      const tasks = await this.store.listTasks();
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
    } catch (err: any) {
      log.error(`Completed task recovery failed: ${err.message}`);
      return 0;
    }
  }

  // ── Misclassified failure recovery ───────────────────────────────

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
      const tasks = await this.store.listTasks();

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
        } catch (err: any) {
          log.error(`Failed to recover misclassified failure ${task.id}: ${err.message}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} misclassified failure(s) → cleared for review`);
      }
      return recovered;
    } catch (err: any) {
      log.error(`Misclassified failure recovery failed: ${err.message}`);
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
      const tasks = await this.store.listTasks();
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
        } catch (err: any) {
          log.error(`Failed to recover orphaned executor task ${task.id}: ${err.message}`);
        }
      }

      if (recovered > 0) {
        log.log(`Recovered ${recovered} orphaned executor task(s) → todo`);
      }
      return recovered;
    } catch (err: any) {
      log.error(`Orphaned executor recovery failed: ${err.message}`);
      return 0;
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
      const tasks = await this.store.listTasks();
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
    } catch (err: any) {
      log.error(`Approved triage recovery failed: ${err.message}`);
      return 0;
    }
  }

  /** Run `git worktree prune` to clean stale metadata. */
  private async pruneWorktrees(): Promise<void> {
    try {
      execSync("git worktree prune", {
        cwd: this.options.rootDir,
        stdio: "pipe",
        timeout: 30_000,
      });
      log.log("Worktree prune completed");
    } catch (err: any) {
      log.error(`Worktree prune failed: ${err.message}`);
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
          execSync(`git worktree remove "${worktreePath}" --force`, {
            cwd: this.options.rootDir,
            stdio: "pipe",
            timeout: 30_000,
          });
          cleaned++;
        } catch {
          // Individual failure is non-fatal
        }
      }

      if (cleaned > 0) {
        log.log(`Cleaned ${cleaned} orphaned worktree(s)`);
      }
      return cleaned;
    } catch (err: any) {
      log.error(`Orphan cleanup failed: ${err.message}`);
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
          execSync(`git branch -d "${branch}"`, {
            cwd: this.options.rootDir,
            stdio: "pipe",
            timeout: 30_000,
          });
          log.log(`Deleted branch: ${branch}`);
          cleaned++;
        } catch {
          // Safe delete failed (not merged) — force delete
          try {
            execSync(`git branch -D "${branch}"`, {
              cwd: this.options.rootDir,
              stdio: "pipe",
              timeout: 30_000,
            });
            log.log(`Force-deleted branch: ${branch}`);
            cleaned++;
          } catch {
            // Individual failure is non-fatal
          }
        }
      }

      if (cleaned > 0) {
        log.log(`Cleaned ${cleaned} orphaned branch(es)`);
      }
      return cleaned;
    } catch (err: any) {
      log.error(`Orphaned branch cleanup failed: ${err.message}`);
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
    } catch (err: any) {
      log.error(`WAL checkpoint failed: ${err.message}`);
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
        } catch {
          return { path: p, mtime: 0 };
        }
      });
      withMtime.sort((a, b) => a.mtime - b.mtime);

      let removed = 0;
      const excess = dirs.length - cap;

      for (const { path: worktreePath } of withMtime) {
        if (removed >= excess) break;
        try {
          execSync(`git worktree remove "${worktreePath}" --force`, {
            cwd: this.options.rootDir,
            stdio: "pipe",
            timeout: 30_000,
          });
          removed++;
        } catch {
          // Individual failure is non-fatal
        }
      }

      if (removed > 0) {
        log.warn(`Worktree cap: removed ${removed} idle worktree(s) (was ${dirs.length}, cap ${cap})`);
      }
    } catch (err: any) {
      log.error(`Worktree cap enforcement failed: ${err.message}`);
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

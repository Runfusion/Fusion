/**
 * Stuck Task Detector — monitors in-progress tasks for agent session stagnation.
 *
 * When a task's agent session shows no activity (no text deltas, tool calls, or
 * progress updates) for longer than the configured timeout, the detector
 * terminates the stuck session and triggers recovery (moving the task back to
 * "todo" for the scheduler to retry).
 *
 * Activity is tracked via `recordActivity(taskId)` calls from the executor's
 * agent event handlers. The detector polls at a configurable interval and
 * compares the last activity timestamp against `taskStuckTimeoutMs` from settings.
 */

import type { TaskStore, Settings } from "@fusion/core";
import { createLogger } from "./logger.js";

const stuckLog = createLogger("stuck-detector");

/** Minimal session interface — matches what TaskExecutor stores. */
export interface DisposableSession {
  dispose: () => void;
}

/** Tracked entry for a single in-progress task. */
interface TrackedTask {
  session: DisposableSession;
  lastActivity: number;
}

export interface StuckTaskDetectorOptions {
  /** Polling interval in milliseconds. Default: 30000 (30 seconds). */
  pollIntervalMs?: number;
  /** Callback invoked when a stuck task is detected and killed.
   *  The task will be moved to "todo" for retry by the detector. */
  onStuck?: (taskId: string) => void;
  /** Called before re-queuing a killed task. Return false to prevent re-queue
   *  (caller is responsible for marking the task as terminally failed).
   *  Used by SelfHealingManager to enforce stuck kill budgets. */
  beforeRequeue?: (taskId: string) => Promise<boolean>;
}

export class StuckTaskDetector {
  private tracked = new Map<string, TrackedTask>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private onStuck?: (taskId: string) => void;
  private beforeRequeue?: (taskId: string) => Promise<boolean>;

  constructor(
    private store: TaskStore,
    options: StuckTaskDetectorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.onStuck = options.onStuck;
    this.beforeRequeue = options.beforeRequeue;
  }

  /**
   * Start the polling loop that checks for stuck tasks.
   * Safe to call multiple times (no-ops if already running).
   */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      stuckLog.log("Running periodic stuck task check (polling)");
      this.checkStuckTasks().catch((err) => {
        stuckLog.error("Error checking stuck tasks:", err);
      });
    }, this.pollIntervalMs);
    stuckLog.log(`Started (poll interval: ${this.pollIntervalMs}ms)`);
  }

  /**
   * Stop the polling loop.
   * Does not untrack any tasks — just stops checking.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      stuckLog.log("Stopped");
    }
  }

  /**
   * Register an active agent session for monitoring.
   * Sets the initial activity timestamp to now.
   */
  trackTask(taskId: string, session: DisposableSession): void {
    this.tracked.set(taskId, {
      session,
      lastActivity: Date.now(),
    });
  }

  /**
   * Remove a task from monitoring.
   * Called when a task finishes (success, failure, or pause).
   */
  untrackTask(taskId: string): void {
    this.tracked.delete(taskId);
  }

  /**
   * Record a heartbeat for a task's agent session.
   * Called on text deltas, tool calls, and progress updates.
   */
  recordActivity(taskId: string): void {
    const entry = this.tracked.get(taskId);
    if (entry) {
      entry.lastActivity = Date.now();
    }
  }

  /**
   * Get the last activity timestamp for a tracked task.
   * Returns undefined if the task is not tracked.
   */
  getLastActivity(taskId: string): number | undefined {
    return this.tracked.get(taskId)?.lastActivity;
  }

  /**
   * Check whether a task is stuck (no activity for longer than timeout).
   */
  isStuck(taskId: string, timeoutMs: number): boolean {
    const entry = this.tracked.get(taskId);
    if (!entry) return false;
    return (Date.now() - entry.lastActivity) > timeoutMs;
  }

  /**
   * Terminate a stuck task's agent session and trigger recovery.
   * - Disposes the agent session
   * - Logs the stuck event to the task log
   * - Moves the task back to "todo" (preserving step progress)
   * - Invokes the onStuck callback
   */
  async killAndRetry(taskId: string, _timeoutMs: number): Promise<void> {
    const entry = this.tracked.get(taskId);
    if (!entry) return;

    const elapsedMin = Math.round((Date.now() - entry.lastActivity) / 60_000);

    stuckLog.log(`Killing stuck task ${taskId} (no activity for ~${elapsedMin} minutes)`);

    // Dispose the agent session first
    try {
      entry.session.dispose();
    } catch (err) {
      stuckLog.error(`Failed to dispose session for ${taskId}:`, err);
    }

    // Remove from tracking
    this.tracked.delete(taskId);

    // Log the event to the task log
    try {
      await this.store.logEntry(
        taskId,
        `Task terminated due to stuck agent session (no activity for ~${elapsedMin} minutes)`,
      );
    } catch (err) {
      stuckLog.error(`Failed to log stuck event for ${taskId}:`, err);
    }

    // Check stuck kill budget before re-queuing (SelfHealingManager integration).
    // If beforeRequeue returns false, the task has been marked failed — skip re-queue.
    if (this.beforeRequeue) {
      try {
        const shouldRequeue = await this.beforeRequeue(taskId);
        if (!shouldRequeue) {
          stuckLog.log(`${taskId} exceeded stuck kill budget — not re-queuing`);
          this.onStuck?.(taskId);
          return;
        }
      } catch (err) {
        stuckLog.error(`beforeRequeue check failed for ${taskId}:`, err);
        // Fall through to re-queue on error — safer than dropping the task
      }
    }

    // Set transient "stuck-killed" status, then move to "todo" for retry.
    // moveTask from "in-progress" to "todo" automatically clears status,
    // so no explicit status clear is needed after the move.
    // currentStep and step statuses are preserved so execution resumes where it left off.
    try {
      await this.store.updateTask(taskId, { status: "stuck-killed" });
      await this.store.moveTask(taskId, "todo");
      stuckLog.log(`${taskId} moved to todo for retry`);
    } catch (err) {
      stuckLog.error(`Failed to move ${taskId} to todo:`, err);
    }

    // Notify listeners
    this.onStuck?.(taskId);
  }

  /**
   * Check for stuck tasks immediately, outside the normal polling cycle.
   * Safe to call at any time — will no-op if no tasks are tracked or timeout is disabled.
   * Logs at debug level to distinguish manual checks from polling.
   */
  async checkNow(): Promise<void> {
    stuckLog.log("Running immediate stuck task check (triggered manually)");
    await this.checkStuckTasks();
  }

  /**
   * Poll all tracked tasks and kill any that have exceeded the timeout.
   * Reads `taskStuckTimeoutMs` from settings on each check so changes
   * take effect on the next poll cycle.
   */
  private async checkStuckTasks(): Promise<void> {
    if (this.tracked.size === 0) return;

    let settings: Settings;
    try {
      settings = await this.store.getSettings();
    } catch {
      return; // Can't read settings — skip this cycle
    }

    const timeoutMs = settings.taskStuckTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return; // Disabled

    const now = Date.now();
    const stuckTasks: string[] = [];

    for (const [taskId, entry] of this.tracked) {
      if ((now - entry.lastActivity) > timeoutMs) {
        stuckTasks.push(taskId);
      }
    }

    for (const taskId of stuckTasks) {
      await this.killAndRetry(taskId, timeoutMs);
    }
  }

  /** Number of currently tracked tasks (for testing). */
  get trackedCount(): number {
    return this.tracked.size;
  }
}

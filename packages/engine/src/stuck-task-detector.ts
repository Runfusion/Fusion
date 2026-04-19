/**
 * Stuck Task Detector — monitors in-progress tasks for agent session stagnation.
 *
 * The detector supports two detection modes:
 * - **Inactivity** — no activity at all for the timeout period (session appears dead)
 * - **Loop** — agent is active but making no step progress despite lots of activity
 *   (e.g., context growth causing the agent to repeat itself without advancing steps)
 *
 * Activity tracking uses two signals:
 * - `recordActivity(taskId)` — text/tool heartbeats only; increments `activitySinceProgress`
 * - `recordProgress(taskId)` — step transitions (in-progress, done, skipped); resets counters
 *
 * The detector polls at a configurable interval and compares timestamps against
 * `taskStuckTimeoutMs` from settings.
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
  /** Timestamp of the last heartbeat (text delta, tool call, etc.). */
  lastActivity: number;
  /** Timestamp of the last step progress event. */
  lastProgressAt: number;
  /** Number of activity heartbeats since the last progress event. */
  activitySinceProgress: number;
  /**
   * The canonical task ID used for all external callbacks (beforeRequeue,
   * onStuck, onLoopDetected).  In step-session mode the map key is a compound
   * string like "FN-1452-step-1"; this field always holds the bare task ID
   * ("FN-1452") so callbacks can look up the right task record.
   */
  canonicalTaskId: string;
}

/** Payload emitted when a stuck task is detected. */
export interface StuckTaskEvent {
  /** The task that was detected as stuck. */
  taskId: string;
  /** Why the task is considered stuck. */
  reason: "inactivity" | "loop";
  /** Milliseconds since the last step progress event. */
  noProgressMs: number;
  /** Milliseconds since the last activity heartbeat. */
  inactivityMs: number;
  /** Number of activity heartbeats since the last progress event. */
  activitySinceProgress: number;
  /** Whether the task should be re-queued (budget not exhausted). */
  shouldRequeue: boolean;
}

/** Minimum activity-since-progress count to classify as a loop.
 *  Prevents false positives when a task is genuinely inactive. */
const LOOP_ACTIVITY_THRESHOLD = 60;

export interface StuckTaskDetectorOptions {
  /** Polling interval in milliseconds. Default: 30000 (30 seconds). */
  pollIntervalMs?: number;
  /** Callback invoked when a stuck task is detected.
   *  The task will be moved to "todo" for retry by the detector.
   *  Receives a structured payload with detection reason and metrics. */
  onStuck?: (event: StuckTaskEvent) => void;
  /** Called before re-queuing a killed task. Return false to prevent re-queue
   *  (caller is responsible for marking the task as terminally failed).
   *  Used by SelfHealingManager to enforce stuck kill budgets. */
  beforeRequeue?: (taskId: string) => Promise<boolean>;
  /** Pre-kill callback invoked ONLY when reason is "loop".
   *  Called BEFORE session.dispose() / moveTask("todo") so the caller can
   *  attempt in-process recovery (e.g. compact-and-resume) without killing
   *  the agent session.
   *
   *  Return `true` to signal "executor accepted ownership of recovery for this
   *  run" — the detector will skip dispose/requeue and remove the task from
   *  tracking (the caller is now responsible for the task's fate).
   *  Return `false` to let the detector proceed with the normal kill/requeue path.
   *
   *  Errors in this callback fall through to the normal kill path (treated as `false`). */
  onLoopDetected?: (event: StuckTaskEvent) => Promise<boolean>;
}

export class StuckTaskDetector {
  private tracked = new Map<string, TrackedTask>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private onStuck?: (event: StuckTaskEvent) => void;
  private beforeRequeue?: (taskId: string) => Promise<boolean>;
  private onLoopDetected?: (event: StuckTaskEvent) => Promise<boolean>;

  constructor(
    private store: TaskStore,
    options: StuckTaskDetectorOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.onStuck = options.onStuck;
    this.beforeRequeue = options.beforeRequeue;
    this.onLoopDetected = options.onLoopDetected;
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
   * Sets initial timestamps and counters to now.
   *
   * @param trackingKey  The key used internally to identify this session.
   *   In step-session mode this is a compound string like "FN-1452-step-1".
   * @param session      The disposable agent session.
   * @param canonicalTaskId  The bare task ID ("FN-1452") used for all external
   *   callbacks (beforeRequeue, onStuck, onLoopDetected).  When omitted the
   *   trackingKey is used as-is (single-session mode where they are identical).
   */
  trackTask(trackingKey: string, session: DisposableSession, canonicalTaskId?: string): void {
    const now = Date.now();
    this.tracked.set(trackingKey, {
      session,
      lastActivity: now,
      lastProgressAt: now,
      activitySinceProgress: 0,
      canonicalTaskId: canonicalTaskId ?? trackingKey,
    });
    stuckLog.log(`Tracking task ${trackingKey} (canonical=${canonicalTaskId ?? trackingKey}, total tracked: ${this.tracked.size})`);
  }

  /**
   * Remove a task from monitoring.
   * Called when a task finishes (success, failure, or pause).
   *
   * Handles both direct keys and step-scoped keys:
   * - Direct key (single-session mode): removes the entry with the given ID
   * - Step-scoped keys (step-session mode): removes ALL entries for the canonical task ID
   *
   * In step-session mode, tasks are tracked with compound keys like "FN-200-step-0".
   * When the executor calls untrackTask with the bare task ID "FN-200", this method
   * cleans up all step-scoped entries for that task.
   */
  untrackTask(taskId: string): void {
    // First, try to delete the direct key (single-session mode)
    this.tracked.delete(taskId);

    // Also clean up any step-scoped entries for this task.
    // In step-session mode, entries are keyed by "taskId-step-N" but we need to
    // clean them up when given the bare task ID.
    // Pattern: "{taskId}-step-{N}" where N is a number
    const stepPrefix = `${taskId}-step-`;
    for (const key of this.tracked.keys()) {
      if (key.startsWith(stepPrefix)) {
        this.tracked.delete(key);
      }
    }
  }

  /**
   * Record a heartbeat for a task's agent session.
   * Called on text deltas and tool calls only (NOT step transitions).
   * Increments `activitySinceProgress` counter.
   *
   * In step-session mode, called with step-scoped keys (e.g., "FN-200-step-0").
   */
  recordActivity(taskId: string): void {
    const entry = this.tracked.get(taskId);
    if (entry) {
      entry.lastActivity = Date.now();
      entry.activitySinceProgress++;
      if (entry.activitySinceProgress <= 3 || entry.activitySinceProgress % 50 === 0) {
        stuckLog.log(`Activity recorded for ${taskId} (sinceProgress=${entry.activitySinceProgress})`);
      }
    }
  }

  /**
   * Record a step progress event for a task's agent session.
   * Called on step transitions (in-progress, done, skipped).
   * Resets `activitySinceProgress` to 0 and updates `lastProgressAt`.
   *
   * In step-session mode, called with the bare task ID (e.g., "FN-200").
   * This method finds entries by canonical task ID when the direct key lookup fails.
   */
  recordProgress(taskId: string): void {
    // First try direct key lookup (single-session mode)
    const entry = this.tracked.get(taskId);
    if (entry) {
      entry.lastProgressAt = Date.now();
      entry.activitySinceProgress = 0;
      return;
    }

    // Fall back to finding by canonical task ID (step-session mode).
    // In step-session mode, entries are keyed by "FN-200-step-0" but we receive "FN-200".
    for (const trackedEntry of this.tracked.values()) {
      if (trackedEntry.canonicalTaskId === taskId) {
        trackedEntry.lastProgressAt = Date.now();
        trackedEntry.activitySinceProgress = 0;
        return;
      }
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
   * Get the activity-since-progress count for a tracked task.
   * Returns undefined if the task is not tracked.
   */
  getActivitySinceProgress(taskId: string): number | undefined {
    return this.tracked.get(taskId)?.activitySinceProgress;
  }

  /**
   * Get the last progress timestamp for a tracked task.
   * Returns undefined if the task is not tracked.
   */
  getLastProgressAt(taskId: string): number | undefined {
    return this.tracked.get(taskId)?.lastProgressAt;
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
   * Classify why a task is stuck.
   * Returns null if the task is not stuck.
   */
  classifyStuckReason(taskId: string, timeoutMs: number): "inactivity" | "loop" | null {
    const entry = this.tracked.get(taskId);
    if (!entry) return null;

    const now = Date.now();
    const inactivityMs = now - entry.lastActivity;
    const noProgressMs = now - entry.lastProgressAt;

    // Check inactivity first — if there's been zero activity, it's just inactive
    if (inactivityMs >= timeoutMs) {
      return "inactivity";
    }

    // Check loop — active but not making progress, with enough activity to be a real loop
    if (noProgressMs >= timeoutMs && entry.activitySinceProgress >= LOOP_ACTIVITY_THRESHOLD) {
      return "loop";
    }

    return null;
  }

  /**
   * Terminate a stuck task's agent session and trigger recovery.
   * - Disposes the agent session
   * - Logs the stuck event to the task log
   * - Moves the task back to "todo" (preserving step progress)
   * - Invokes the onStuck callback
   */
  async killAndRetry(taskId: string, timeoutMs: number): Promise<void> {
    const entry = this.tracked.get(taskId);
    if (!entry) return;

    // In step-session mode the map key is a compound string like "FN-1452-step-1".
    // All external callbacks (beforeRequeue, onStuck, onLoopDetected) must use
    // the canonical task ID so they can look up the right task record and signal
    // the right executor entry.
    const canonicalId = entry.canonicalTaskId;

    const now = Date.now();
    const inactivityMs = now - entry.lastActivity;
    const noProgressMs = now - entry.lastProgressAt;
    const activitySinceProgress = entry.activitySinceProgress;

    // Classify the reason
    const reason = this.classifyStuckReason(taskId, timeoutMs) ?? "inactivity";

    const elapsedMin = Math.round(inactivityMs / 60_000);
    const noProgressMin = Math.round(noProgressMs / 60_000);

    stuckLog.log(
      `Killing stuck task ${taskId} (canonical=${canonicalId}, reason=${reason}, ` +
      `no progress for ~${noProgressMin}min, ` +
      `no activity for ~${elapsedMin}min, ` +
      `${activitySinceProgress} events since last progress)`,
    );

    // Log the event to the task log using the canonical task ID so it
    // appears in the correct task's log (not a phantom step-key task).
    try {
      await this.store.logEntry(
        canonicalId,
        `Task terminated due to stuck agent session (reason=${reason}, ` +
        `no progress for ~${noProgressMin}min, ` +
        `no activity for ~${elapsedMin}min, ` +
        `${activitySinceProgress} events since last progress)`,
      );
    } catch (err) {
      stuckLog.error(`Failed to log stuck event for ${canonicalId}:`, err);
    }

    // Check stuck kill budget BEFORE disposing the session so the result
    // is available to the executor's cleanup path via the event payload.
    let shouldRequeue = true;
    if (this.beforeRequeue) {
      try {
        shouldRequeue = await this.beforeRequeue(canonicalId);
        if (!shouldRequeue) {
          stuckLog.log(`${canonicalId} exceeded stuck kill budget — not re-queuing`);
        }
      } catch (err) {
        stuckLog.error(`beforeRequeue check failed for ${canonicalId}:`, err);
        // Fall through with shouldRequeue=true — safer than dropping the task
      }
    }

    // Build the event payload using the canonical task ID so executor callbacks
    // can look up the right entry in stuckAborted / activeStepExecutors.
    const event: StuckTaskEvent = {
      taskId: canonicalId,
      reason,
      noProgressMs,
      inactivityMs,
      activitySinceProgress,
      shouldRequeue,
    };

    // ── Pre-kill loop interception ──────────────────────────────────
    // When reason is "loop" and an onLoopDetected callback is registered,
    // give the caller a chance to handle recovery in-process (e.g.
    // compact-and-resume) before falling through to the kill/requeue path.
    //
    // If the callback returns true, the caller owns the task — we skip
    // dispose/requeue and just untrack.  Errors fall through to normal kill.
    if (reason === "loop" && this.onLoopDetected) {
      try {
        const handled = await this.onLoopDetected(event);
        if (handled) {
          stuckLog.log(
            `${canonicalId} loop recovery accepted by onLoopDetected callback — ` +
            `skipping kill/requeue (caller owns recovery)`,
          );
          // The caller is now responsible for the task; remove from tracking
          // so we don't double-trigger.
          this.tracked.delete(taskId);
          return;
        }
      } catch (err) {
        stuckLog.error(`onLoopDetected callback failed for ${canonicalId}:`, err);
        // Fall through to normal kill path
      }
    }

    // Notify listeners before disposing the session so executor cleanup can
    // mark the abort as intentional before the disposed session unwinds.
    this.onStuck?.(event);

    // Dispose the agent session after listeners have marked the abort.
    try {
      entry.session.dispose();
    } catch (err) {
      stuckLog.error(`Failed to dispose session for ${taskId}:`, err);
    }

    // Remove from tracking.
    // The actual moveTask("todo") is handled by the executor's catch/finally
    // block after it cleans up this.executing. This prevents a race where the
    // scheduler re-dispatches the task while the old execution is still active.
    this.tracked.delete(taskId);
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
   *
   * Detection rules:
   * - **inactivity**: `lastActivity` older than `taskStuckTimeoutMs` (no heartbeats at all)
   * - **loop**: `lastProgressAt` older than `taskStuckTimeoutMs` AND `activitySinceProgress >= 60`
   *   (agent is actively doing things but not advancing steps)
   */
  private async checkStuckTasks(): Promise<void> {
    if (this.tracked.size === 0) return;

    let settings: Settings;
    try {
      settings = await this.store.getSettings();
    } catch (err) {
      stuckLog.error("Failed to read settings — skipping stuck task detection cycle:", err);
      return; // Can't read settings — skip this cycle
    }

    const timeoutMs = settings.taskStuckTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return; // Disabled

    const stuckTasks: string[] = [];

    for (const [taskId] of this.tracked) {
      const reason = this.classifyStuckReason(taskId, timeoutMs);
      if (reason !== null) {
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

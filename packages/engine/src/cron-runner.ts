import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { TaskStore } from "@kb/core";
import type { AutomationStore } from "@kb/core";
import type { ScheduledTask, AutomationRunResult } from "@kb/core";
import { createLogger } from "./logger.js";

const execAsync = promisify(exec);
const log = createLogger("cron-runner");

/** Default execution timeout: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Maximum output buffer: 1 MB. */
const MAX_BUFFER = 1024 * 1024;
/** Maximum output string stored in result: 10 KB. */
const MAX_OUTPUT_LENGTH = 10 * 1024;
/** Default poll interval: 60 seconds. */
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
/** Minimum poll interval: 10 seconds. */
const MIN_POLL_INTERVAL_MS = 10 * 1000;

export interface CronRunnerOptions {
  /** Polling interval in milliseconds. Default: 60000 (60s). Minimum: 10000 (10s). */
  pollIntervalMs?: number;
}

/**
 * CronRunner polls the AutomationStore for due schedules and executes them.
 *
 * - Respects `globalPause` and `enginePaused` settings — skips execution when either is true.
 * - Prevents concurrent runs of the same schedule.
 * - Enforces per-schedule timeouts and output size limits.
 * - Uses a re-entrance guard like Scheduler to prevent overlapping ticks.
 */
export class CronRunner {
  private running = false;
  private ticking = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  /** Schedule IDs currently being executed — prevents concurrent runs of the same schedule. */
  private inFlight = new Set<string>();

  constructor(
    private store: TaskStore,
    private automationStore: AutomationStore,
    private options: CronRunnerOptions = {},
  ) {
    this.pollIntervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
  }

  /** Start the polling loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.log(`Started (poll every ${this.pollIntervalMs / 1000}s)`);

    // Run first tick immediately
    void this.tick();

    this.pollInterval = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  /** Stop the polling loop. Does NOT abort in-flight executions. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    log.log("Stopped");
  }

  /**
   * Single poll cycle: find due schedules and execute them.
   * Re-entrance guarded — if already ticking, the call is a no-op.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;

    try {
      // Check pause settings
      const settings = await this.store.getSettings();
      if (settings.globalPause || settings.enginePaused) {
        return;
      }

      const dueSchedules = await this.automationStore.getDueSchedules();
      if (dueSchedules.length === 0) return;

      for (const schedule of dueSchedules) {
        // Skip if already in-flight (prevents concurrent runs of same schedule)
        if (this.inFlight.has(schedule.id)) {
          log.warn(`Skipping ${schedule.name} (${schedule.id}) — still running from previous tick`);
          continue;
        }

        // Re-check pause on each schedule (may have changed mid-loop)
        const currentSettings = await this.store.getSettings();
        if (currentSettings.globalPause || currentSettings.enginePaused) {
          log.log("Pause detected mid-tick — stopping schedule execution");
          break;
        }

        await this.executeSchedule(schedule);
      }
    } catch (err) {
      log.error(`Tick error: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Execute a single schedule's command.
   * - Tracks in-flight state to prevent concurrent runs.
   * - Enforces timeout and output buffer limits.
   * - Records the run result in the automation store.
   */
  async executeSchedule(schedule: ScheduledTask): Promise<AutomationRunResult> {
    this.inFlight.add(schedule.id);
    const startedAt = new Date().toISOString();
    log.log(`Executing ${schedule.name} (${schedule.id}): ${schedule.command}`);

    let result: AutomationRunResult;

    try {
      const timeoutMs = schedule.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { stdout, stderr } = await execAsync(schedule.command, {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        shell: "/bin/sh",
      });

      const output = truncateOutput(stdout, stderr);

      result = {
        success: true,
        output,
        startedAt,
        completedAt: new Date().toISOString(),
      };

      log.log(`✓ ${schedule.name} completed (${result.output.length} bytes output)`);
    } catch (err: any) {
      const stdout = err.stdout ?? "";
      const stderr = err.stderr ?? "";
      const output = truncateOutput(stdout, stderr);
      const errorMessage = err.killed
        ? `Command timed out after ${(schedule.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
        : err.message ?? String(err);

      result = {
        success: false,
        output,
        error: errorMessage,
        startedAt,
        completedAt: new Date().toISOString(),
      };

      log.warn(`✗ ${schedule.name} failed: ${errorMessage}`);
    } finally {
      this.inFlight.delete(schedule.id);
    }

    // Record run result
    try {
      await this.automationStore.recordRun(schedule.id, result);
    } catch (recordErr) {
      log.error(`Failed to record run for ${schedule.id}: ${(recordErr as Error).message}`);
    }

    return result;
  }
}

/** Combine and truncate stdout/stderr to stay within storage limits. */
function truncateOutput(stdout: string, stderr: string): string {
  let combined = stdout;
  if (stderr) {
    // Add separator only if there's also stdout content
    combined += stdout ? "\n--- stderr ---\n" : "";
    combined += stderr;
  }
  if (combined.length > MAX_OUTPUT_LENGTH) {
    combined = combined.slice(0, MAX_OUTPUT_LENGTH) + "\n[output truncated]";
  }
  return combined;
}

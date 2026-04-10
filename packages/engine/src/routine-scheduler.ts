import type { Routine, RoutineStore, ProjectSettings } from "@fusion/core";
import { RoutineRunner } from "./routine-runner.js";
import { createLogger } from "./logger.js";

const logger = createLogger("routine-scheduler");

/**
 * Options for RoutineScheduler.
 */
export interface RoutineSchedulerOptions {
  /** The routine store */
  routineStore: RoutineStore;
  /** The routine runner */
  routineRunner: RoutineRunner;
  /** Polling interval in milliseconds */
  pollIntervalMs?: number;
  /** Get current settings (for pause checks) */
  getSettings: () => ProjectSettings;
  /** Callback when scheduler is started */
  onStart?: () => void;
  /** Callback when scheduler is stopped */
  onStop?: () => void;
}

/**
 * Minimum poll interval (30 seconds).
 */
const MIN_POLL_INTERVAL_MS = 30_000;

/**
 * Default poll interval (1 minute).
 */
const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * RoutineScheduler polls for due routines and triggers their execution.
 *
 * It handles:
 * - Polling interval with clamping
 * - Re-entrance guard (prevents overlapping polls)
 * - Pause awareness (globalPause / enginePaused)
 * - Catch-up execution before normal due execution
 * - Per-routine failure isolation
 */
export class RoutineScheduler {
  private routineStore: RoutineStore;
  private routineRunner: RoutineRunner;
  private pollIntervalMs: number;
  private getSettings: () => ProjectSettings;
  private onStart?: () => void;
  private onStop?: () => void;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private isPolling = false;

  constructor(options: RoutineSchedulerOptions) {
    this.routineStore = options.routineStore;
    this.routineRunner = options.routineRunner;
    this.getSettings = options.getSettings;
    this.onStart = options.onStart;
    this.onStop = options.onStop;

    // Clamp poll interval to minimum
    this.pollIntervalMs = Math.max(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS
    );
  }

  /**
   * Start the scheduler.
   */
  start(): void {
    if (this.isRunning) {
      logger.log("RoutineScheduler already running");
      return;
    }

    this.isRunning = true;
    logger.log(
      `RoutineScheduler started with ${this.pollIntervalMs}ms poll interval`
    );

    // Subscribe to routine store events
    this.routineStore.on("routine:created", this.handleRoutineCreated);
    this.routineStore.on("routine:updated", this.handleRoutineUpdated);
    this.routineStore.on("routine:deleted", this.handleRoutineDeleted);

    // Start polling
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);

    // Run initial poll
    void this.poll();

    this.onStart?.();
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    logger.log("RoutineScheduler stopping");

    // Clear timer
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Unsubscribe from events
    this.routineStore.off("routine:created", this.handleRoutineCreated);
    this.routineStore.off("routine:updated", this.handleRoutineUpdated);
    this.routineStore.off("routine:deleted", this.handleRoutineDeleted);

    this.onStop?.();
    logger.log("RoutineScheduler stopped");
  }

  /**
   * Check if the scheduler is running.
   */
  getStatus(): "running" | "stopped" {
    return this.isRunning ? "running" : "stopped";
  }

  /**
   * Trigger an immediate poll (for testing).
   */
  async triggerPoll(): Promise<void> {
    await this.poll();
  }

  /**
   * Poll for due routines and execute them.
   */
  private async poll(): Promise<void> {
    // Re-entrance guard
    if (this.isPolling) {
      logger.log("Poll already in progress, skipping");
      return;
    }

    this.isPolling = true;

    try {
      // Check pause state
      const settings = this.getSettings();
      if (settings.globalPause || settings.enginePaused) {
        logger.log(
          `Paused: globalPause=${settings.globalPause}, enginePaused=${settings.enginePaused}`
        );
        return;
      }

      // Get due routines
      const dueRoutines = await this.routineStore.getDueRoutines();
      logger.log(`Found ${dueRoutines.length} due routines`);

      // Process each routine
      for (const routine of dueRoutines) {
        await this.processRoutine(routine);
      }
    } catch (error) {
      logger.error(`Poll error: ${error}`);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Process a single routine, handling catch-up and normal execution.
   */
  private async processRoutine(routine: Routine): Promise<void> {
    const routineId = routine.id;

    try {
      // Skip if routine is disabled
      if (!routine.enabled) {
        logger.log(`[${routineId}] Skipped: routine is disabled`);
        return;
      }

      // Skip if already executing
      if (this.routineRunner.isExecuting(routineId)) {
        logger.log(`[${routineId}] Skipped: already executing`);
        return;
      }

      // Handle catch-up if needed
      const lastRunAt = routine.lastRunAt ?? null;
      const currentTime = new Date();
      const catchUp = this.routineRunner.determineCatchUp(
        routine,
        lastRunAt,
        currentTime
      );

      if (catchUp.shouldCatchUp && catchUp.catchUpFrom) {
        logger.log(
          `[${routineId}] Executing catch-up from ${catchUp.catchUpFrom}`
        );
        await this.routineRunner.execute(routine, {
          catchUpFrom: catchUp.catchUpFrom,
        });
      }

      // Normal execution
      if (!this.routineRunner.isExecuting(routineId)) {
        logger.log(`[${routineId}] Executing routine`);
        await this.routineRunner.execute(routine);
      }
    } catch (error) {
      // Per-routine failure isolation - don't let one failure affect others
      logger.error(`[${routineId}] Failed to process: ${error}`);
    }
  }

  /**
   * Handle routine created event.
   */
  private handleRoutineCreated = (routine: Routine): void => {
    logger.log(`[${routine.id}] Routine created, will check at next poll`);
  };

  /**
   * Handle routine updated event.
   */
  private handleRoutineUpdated = (routine: Routine): void => {
    logger.log(`[${routine.id}] Routine updated`);
  };

  /**
   * Handle routine deleted event.
   */
  private handleRoutineDeleted = (routine: Routine): void => {
    logger.log(`[${routine.id}] Routine deleted`);
  };
}

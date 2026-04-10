/**
 * RoutineScheduler — polls for due routines and triggers their execution via RoutineRunner.
 *
 * Handles:
 * - Polling interval with configurable interval
 * - Re-entrance guard (prevents overlapping polls)
 * - Pause awareness (globalPause / enginePaused)
 * - Catch-up execution before normal due execution
 * - Per-routine failure isolation
 */

import { CronExpressionParser } from "cron-parser";
import type { Routine, RoutineStore, TaskStore } from "@fusion/core";
import { RoutineRunner } from "./routine-runner.js";
import { createLogger } from "./logger.js";

const logger = createLogger("routine-scheduler");

/**
 * Options for RoutineScheduler.
 */
export interface RoutineSchedulerOptions {
  /** TaskStore for checking pause state */
  taskStore: TaskStore;
  /** RoutineStore for querying routines */
  routineStore: RoutineStore;
  /** RoutineRunner for executing routines */
  routineRunner: RoutineRunner;
  /** Polling interval in milliseconds. Default: 60000 (60s). Minimum: 10000 (10s). */
  pollIntervalMs?: number;
}

/**
 * RoutineScheduler polls for due routines and triggers their execution.
 */
export class RoutineScheduler {
  private taskStore: TaskStore;
  private routineStore: RoutineStore;
  private routineRunner: RoutineRunner;
  private pollIntervalMs: number;

  private running: boolean = false;
  private ticking: boolean = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoutineSchedulerOptions) {
    this.taskStore = options.taskStore;
    this.routineStore = options.routineStore;
    this.routineRunner = options.routineRunner;
    this.pollIntervalMs = Math.max(10000, options.pollIntervalMs ?? 60000);
  }

  /**
   * Start the scheduler.
   */
  start(): void {
    if (this.running) {
      logger.log("RoutineScheduler already running");
      return;
    }

    this.running = true;
    logger.log(`RoutineScheduler started with ${this.pollIntervalMs}ms poll interval`);

    // Run first tick immediately
    void this.tick();

    // Start polling interval
    this.pollInterval = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    logger.log("RoutineScheduler stopping");

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    logger.log("RoutineScheduler stopped");
  }

  /**
   * Check if the scheduler is active (running).
   */
  isActive(): boolean {
    return this.running;
  }

  /**
   * Process a single tick — poll for due routines and execute them.
   */
  async tick(): Promise<void> {
    // Re-entrance guard
    if (this.ticking) {
      logger.log("Tick already in progress, skipping");
      return;
    }

    this.ticking = true;

    try {
      // Check pause state
      const settings = await this.taskStore.getSettings();
      if (settings.globalPause || settings.enginePaused) {
        logger.log(
          `Paused: globalPause=${settings.globalPause}, enginePaused=${settings.enginePaused}`
        );
        return;
      }

      // Get due routines
      const dueRoutines = await this.getDueRoutines();
      if (dueRoutines.length === 0) {
        return;
      }

      logger.log(`Found ${dueRoutines.length} due routines`);

      // Process each routine
      for (const routine of dueRoutines) {
        // Re-check pause state (may have changed mid-loop)
        const currentSettings = await this.taskStore.getSettings();
        if (currentSettings.globalPause || currentSettings.enginePaused) {
          logger.log("Paused mid-loop, stopping processing");
          break;
        }

        try {
          await this.processRoutine(routine);
        } catch (err) {
          logger.error(`[${routine.id}] Failed to process: ${err}`);
          // Continue to next routine
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Process a single routine.
   */
  private async processRoutine(routine: Routine): Promise<void> {
    const routineId = routine.id;

    // Skip if disabled
    if (!routine.enabled) {
      logger.log(`[${routineId}] Skipped: routine is disabled`);
      return;
    }

    // Handle catch-up
    await this.routineRunner.handleCatchUp(routine);

    // Execute the routine
    await this.routineRunner.executeRoutine(routineId, "cron");

    // Update next run time
    if (routine.cronExpression) {
      try {
        const nextRun = CronExpressionParser.parse(routine.cronExpression).next();
        // Note: We can't update nextRunAt directly as it's derived from trigger
        // The RoutineStore handles this internally
      } catch (err) {
        logger.error(`[${routineId}] Failed to calculate next run: ${err}`);
      }
    }
  }

  /**
   * Get routines that are due for execution.
   */
  private async getDueRoutines(): Promise<Routine[]> {
    try {
      return await this.routineStore.getDueRoutines();
    } catch (err) {
      logger.error(`Failed to get due routines: ${err}`);
      return [];
    }
  }

  /**
   * Trigger a routine manually via the API.
   */
  async triggerManual(routineId: string): Promise<import("@fusion/core").RoutineExecutionResult> {
    return this.routineRunner.executeRoutine(routineId, "api");
  }

  /**
   * Trigger a routine via webhook.
   */
  async triggerWebhook(
    routineId: string,
    payload: Record<string, unknown>,
    signature?: string
  ): Promise<import("@fusion/core").RoutineExecutionResult> {
    // Load routine to validate webhook trigger type
    const routine = await this.routineStore.getRoutine(routineId);

    if (routine.trigger.type !== "webhook") {
      throw new Error(`Routine '${routineId}' does not have webhook trigger type`);
    }

    // Verify webhook signature if secret is configured
    const webhookSecret = process.env.FUSION_ROUTINE_WEBHOOK_SECRET;
    if (webhookSecret) {
      if (!signature) {
        throw new Error("Missing webhook signature");
      }
      const { createHmac, timingSafeEqual } = await import("node:crypto");
      const [algo, expectedSig] = signature.split("=");
      if (algo !== "sha256") {
        throw new Error("Invalid webhook signature algorithm");
      }
      const computed = createHmac("sha256", webhookSecret).update(JSON.stringify(payload)).digest("hex");
      const sigBuffer = Buffer.from(expectedSig, "hex");
      const computedBuffer = Buffer.from(computed, "hex");
      if (sigBuffer.length !== computedBuffer.length || !timingSafeEqual(sigBuffer, computedBuffer)) {
        throw new Error("Invalid webhook signature");
      }
    }

    return this.routineRunner.executeRoutine(routineId, "webhook", { webhookPayload: payload });
  }
}

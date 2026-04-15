/**
 * RoutineScheduler — polls for due routines and triggers their execution via RoutineRunner.
 *
 * UTILITY PATH: This component runs on the utility lane and does NOT receive the
 * task-lane semaphore. Routine execution is independent of task execution concurrency.
 *
 * Handles:
 * - Polling interval with configurable interval
 * - Re-entrance guard (prevents overlapping polls)
 * - Pause awareness (globalPause / enginePaused)
 * - Catch-up execution before normal due execution
 * - Per-routine failure isolation
 * - Scope-aware polling: "global", "project", or "all" (both scopes)
 *
 * SCOPED POLLING SEMANTICS:
 * - scope="project" (default): Only polls routines scoped to this project
 * - scope="global": Only polls global/shared routines
 * - scope="all": Polls both scopes with deterministic de-duplication by routine ID
 *
 * Each ProjectEngine instance runs with scope="project", ensuring project isolation.
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
  /**
   * Scope to poll for due routines.
   * - "project": Only poll routines scoped to this project (default)
   * - "global": Only poll global/shared routines
   * - "all": Poll both project and global scopes
   */
  scope?: "global" | "project" | "all";
}

/**
 * RoutineScheduler polls for due routines and triggers their execution.
 */
export class RoutineScheduler {
  private taskStore: TaskStore;
  private routineStore: RoutineStore;
  private routineRunner: RoutineRunner;
  private pollIntervalMs: number;
  /** Scope to poll: "global", "project", or "all". */
  private scope: "global" | "project" | "all";

  private running: boolean = false;
  private ticking: boolean = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoutineSchedulerOptions) {
    this.taskStore = options.taskStore;
    this.routineStore = options.routineStore;
    this.routineRunner = options.routineRunner;
    this.pollIntervalMs = Math.max(10000, options.pollIntervalMs ?? 60000);
    this.scope = options.scope ?? "project";
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
    logger.log(`RoutineScheduler started with ${this.pollIntervalMs}ms poll interval (scope: ${this.scope})`);

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

      // Get due routines based on configured scope
      let dueRoutines: Routine[];
      if (this.scope === "all") {
        // Poll both scopes and deduplicate by ID
        dueRoutines = await this.routineStore.getDueRoutinesAllScopes();
      } else {
        dueRoutines = await this.routineStore.getDueRoutines(this.scope);
      }

      if (dueRoutines.length === 0) {
        return;
      }

      logger.log(`Found ${dueRoutines.length} due routines (scope: ${this.scope})`);

      // Track executed routine IDs to prevent double-execution when polling all scopes
      const executedIds = new Set<string>();

      // Process each routine
      for (const routine of dueRoutines) {
        // Skip if already executed this tick (de-duplication across scopes)
        if (executedIds.has(routine.id)) {
          logger.log(`[${routine.id}] Skipped: already executed from another scope this tick`);
          continue;
        }
        executedIds.add(routine.id);

        // Log which scope this routine is from
        const routineScope = routine.scope ?? "project";
        if (routineScope !== this.scope && this.scope !== "all") {
          logger.log(`[${routine.id}] Skipped: belongs to ${routineScope} scope, not polling`);
          continue;
        }

        logger.log(`[${routine.id}] Processing [scope: ${routineScope}]`);

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
        const _nextRun = CronExpressionParser.parse(routine.cronExpression).next();
        // Note: We can't update nextRunAt directly as it's derived from trigger
        // The RoutineStore handles this internally
      } catch (err) {
        logger.error(`[${routineId}] Failed to calculate next run: ${err}`);
      }
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

/**
 * RoutineRunner — orchestrates routine execution via the heartbeat system.
 *
 * - Validates routine state before execution (enabled, has assigned agent)
 * - Enforces concurrency policies (parallel/skip/queue/replace)
 * - Handles catch-up for missed runs
 * - Triggers heartbeat execution for routines
 */

import { CronExpressionParser } from "cron-parser";
import type {
  RoutineStore,
  Routine,
  RoutineExecutionResult,
} from "@fusion/core";
import type { HeartbeatMonitor } from "./agent-heartbeat.js";
import { createLogger } from "./logger.js";

const log = createLogger("routine-runner");

/** Options for RoutineRunner constructor */
export interface RoutineRunnerOptions {
  /** RoutineStore for querying and updating routines */
  routineStore: RoutineStore;
  /** HeartbeatMonitor for triggering agent execution */
  heartbeatMonitor: HeartbeatMonitor;
  /** Project root directory */
  rootDir: string;
}

/**
 * Maximum number of catch-up executions to prevent runaway loops.
 */
const MAX_CATCH_UP_INTERVALS = 10;

/**
 * RoutineRunner orchestrates routine execution via the heartbeat system.
 *
 * Key behaviors:
 * - Enforces concurrency policies before starting executions
 * - Handles catch-up for missed runs based on catch-up policy
 * - Triggers heartbeats with routine context in the trigger detail
 */
export class RoutineRunner {
  private options: RoutineRunnerOptions;
  /** Tracks currently-running executions by routine ID */
  private inFlightExecutions: Map<string, Promise<RoutineExecutionResult>> = new Map();

  constructor(options: RoutineRunnerOptions) {
    this.options = options;
  }

  /**
   * Execute a routine by ID with a given trigger type.
   *
   * @param routineId - ID of the routine to execute
   * @param triggerType - What triggered this execution: "cron", "webhook", or "api"
   * @param context - Additional context passed to the heartbeat execution
   * @returns The execution result
   * @throws Error if routine not found or disabled
   */
  async executeRoutine(
    routineId: string,
    triggerType: "cron" | "webhook" | "api",
    context?: Record<string, unknown>,
  ): Promise<RoutineExecutionResult> {
    // 1. Load routine
    let routine: Routine;
    try {
      routine = await this.options.routineStore.getRoutine(routineId);
    } catch {
      throw new Error(`Routine '${routineId}' not found`);
    }

    // 2. Validate routine state
    if (!routine.enabled) {
      throw new Error(`Routine '${routineId}' is disabled`);
    }

    if (!routine.agentId) {
      throw new Error(`Routine '${routineId}' has no assigned agent`);
    }

    // 3. Enforce concurrency policy
    const concurrency = routine.executionPolicy ?? "queue";

    if (concurrency === "reject" && this.inFlightExecutions.has(routineId)) {
      log.log(`Routine ${routineId} rejected — already running`);
      // Return a failed result without creating an execution record
      return {
        routineId,
        success: false,
        output: "Routine rejected — already running",
        error: "Routine rejected — already running",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    // If queue, wait for existing execution
    if (concurrency === "queue" && this.inFlightExecutions.has(routineId)) {
      log.log(`Routine ${routineId} queued — waiting for existing execution`);
      const existingResult = await this.inFlightExecutions.get(routineId);
      if (existingResult) {
        await existingResult;
      }
    }

    // 4. Record execution start
    const startedAt = new Date().toISOString();

    // Set in-flight BEFORE starting execution to prevent race conditions
    const executionPromise = this.runExecution(routine, triggerType, context, startedAt);
    this.inFlightExecutions.set(routineId, executionPromise);

    try {
      await this.options.routineStore.startRoutineExecution(routineId, {
        triggeredAt: startedAt,
        invocationSource: "routine",
      });

      const result = await executionPromise;
      return result;
    } finally {
      this.inFlightExecutions.delete(routineId);
    }
  }

  /**
   * Internal execution logic for a routine.
   */
  private async runExecution(
    routine: Routine,
    triggerType: string,
    context: Record<string, unknown> | undefined,
    startedAt: string,
  ): Promise<RoutineExecutionResult> {
    const routineId = routine.id;

    try {
      // Execute via heartbeat monitor
      const run = await this.options.heartbeatMonitor.executeHeartbeat({
        agentId: routine.agentId,
        source: "routine",
        triggerDetail: `routine:${routine.id}:${triggerType}`,
        contextSnapshot: {
          routineId: routine.id,
          routineName: routine.name,
          triggerType,
          ...context,
        },
      });

      // Determine status from run
      let success = true;
      let output = "";
      let error: string | undefined;

      if (run.status === "failed" || run.status === "terminated") {
        success = false;
        error = run.stderrExcerpt || `Run ${run.status}`;
        output = error;
      } else {
        output = run.resultJson ? JSON.stringify(run.resultJson) : "Routine completed successfully";
      }

      // Complete the execution
      await this.options.routineStore.completeRoutineExecution(routineId, {
        completedAt: new Date().toISOString(),
        success,
        resultJson: run.resultJson,
        error,
      });

      return {
        routineId,
        success,
        output,
        startedAt,
        completedAt: new Date().toISOString(),
        error,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error(`Routine ${routineId} execution failed: ${errorMessage}`);

      // Record failure
      try {
        await this.options.routineStore.completeRoutineExecution(routineId, {
          completedAt: new Date().toISOString(),
          success: false,
          error: errorMessage,
        });
      } catch (persistError) {
        log.error(`[${routineId}] Failed to persist error state: ${persistError}`);
      }

      return {
        routineId,
        success: false,
        output: errorMessage,
        startedAt,
        completedAt: new Date().toISOString(),
        error: errorMessage,
      };
    }
  }

  /**
   * Handle catch-up for missed routine executions based on the catch-up policy.
   *
   * @param routine - The routine to check for catch-up
   */
  async handleCatchUp(routine: Routine): Promise<void> {
    const catchUpPolicy = routine.catchUpPolicy ?? "skip";

    if (catchUpPolicy === "skip") {
      return;
    }

    // "run_one" or "run" policy - need to catch up
    if (!routine.lastRunAt) {
      // Never run before — nothing to catch up
      return;
    }

    // Calculate missed intervals
    if (!routine.cronExpression) {
      return;
    }

    try {
      const cronExpr = CronExpressionParser.parse(routine.cronExpression, {
        currentDate: new Date(routine.lastRunAt ?? Date.now()),
      });
      const lastRun = new Date(routine.lastRunAt ?? Date.now());
      const now = new Date();

      const missedIntervals: Date[] = [];

      // Get next interval after lastRun, then iterate
      let intervalDate = new Date(cronExpr.next().toISOString() ?? Date.now());

      while (intervalDate.getTime() <= now.getTime() && missedIntervals.length < MAX_CATCH_UP_INTERVALS) {
        if (intervalDate.getTime() > lastRun.getTime()) {
          missedIntervals.push(new Date(intervalDate));
        }
        const nextIso = cronExpr.next().toISOString();
        if (!nextIso) break;
        intervalDate = new Date(nextIso);
      }

      if (missedIntervals.length === 0) {
        return;
      }

      log.log(`[${routine.id}] Running ${missedIntervals.length} catch-up executions`);

      // Execute each missed interval
      for (const missedInterval of missedIntervals) {
        try {
          await this.executeRoutine(routine.id, "cron", {
            catchUp: true,
            missedInterval: missedInterval.toISOString(),
          });
        } catch (err) {
          log.error(`[${routine.id}] Catch-up execution failed: ${err}`);
        }
      }
    } catch (err) {
      log.error(`[${routine.id}] Error calculating catch-up intervals: ${err}`);
    }
  }

  /**
   * Trigger a routine manually (via API).
   *
   * @param routineId - The ID of the routine to trigger
   * @returns The execution result
   * @throws Error if routine not found or disabled
   */
  async triggerManual(routineId: string): Promise<RoutineExecutionResult> {
    const routine = await this.options.routineStore.getRoutine(routineId);

    if (!routine.enabled) {
      throw new Error(`Routine '${routineId}' is disabled`);
    }

    return this.executeRoutine(routineId, "api");
  }

  /**
   * Trigger a routine via webhook.
   *
   * @param routineId - The ID of the routine to trigger
   * @param payload - The webhook payload
   * @param _signature - The webhook signature (verified by RoutineScheduler)
   * @returns The execution result
   * @throws Error if routine not found, not a webhook trigger, or disabled
   */
  async triggerWebhook(
    routineId: string,
    payload: Record<string, unknown>,
    _signature?: string
  ): Promise<RoutineExecutionResult> {
    const routine = await this.options.routineStore.getRoutine(routineId);

    if (routine.trigger.type !== "webhook") {
      throw new Error(
        `Routine '${routineId}' does not have webhook trigger type`
      );
    }

    if (!routine.enabled) {
      throw new Error(`Routine '${routineId}' is disabled`);
    }

    return this.executeRoutine(routineId, "webhook", { webhookPayload: payload });
  }

  /**
   * Get the number of currently-running executions.
   */
  getInFlightCount(): number {
    return this.inFlightExecutions.size;
  }

  /**
   * Check if a routine is currently being executed.
   */
  isRoutineRunning(routineId: string): boolean {
    return this.inFlightExecutions.has(routineId);
  }
}

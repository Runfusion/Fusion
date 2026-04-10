import type {
  Routine,
  RoutineStore,
  HeartbeatInvocationSource,
} from "@fusion/core";
import type { HeartbeatMonitor } from "./agent-heartbeat.js";
import { createLogger } from "./logger.js";

const logger = createLogger("routine-runner");

/**
 * Options for RoutineRunner.
 */
export interface RoutineRunnerOptions {
  /** The heartbeat monitor for executing routines */
  heartbeatMonitor: HeartbeatMonitor;
  /** The routine store for persisting execution state */
  routineStore: RoutineStore;
}

/**
 * Tracks in-flight executions per routine ID.
 */
const inFlightExecutions = new Map<string, boolean>();

/**
 * Result of a routine execution.
 */
export interface RoutineExecutionResult {
  routineId: string;
  success: boolean;
  error?: string;
  executedAt: string;
  catchUpExecution?: boolean;
}

/**
 * RoutineRunner orchestrates execution of a single routine through the heartbeat system.
 *
 * It handles:
 * - Concurrency policy enforcement (parallel/queue/reject)
 * - Catch-up policy handling for missed schedule windows
 * - Execution state persistence via RoutineStore
 */
export class RoutineRunner {
  private heartbeatMonitor: HeartbeatMonitor;
  private routineStore: RoutineStore;

  constructor(options: RoutineRunnerOptions) {
    this.heartbeatMonitor = options.heartbeatMonitor;
    this.routineStore = options.routineStore;
  }

  /**
   * Check if a routine is currently being executed.
   */
  isExecuting(routineId: string): boolean {
    return inFlightExecutions.get(routineId) === true;
  }

  /**
   * Execute a routine based on its configuration and policies.
   *
   * @param routine - The routine to execute
   * @param options.catchUpFrom - Optional timestamp to use for catch-up execution
   * @returns The result of the execution attempt
   */
  async execute(
    routine: Routine,
    options: { catchUpFrom?: string } = {}
  ): Promise<RoutineExecutionResult> {
    const { catchUpFrom } = options;
    const routineId = routine.id;

    // Check concurrency policy
    const policyResult = this.checkConcurrencyPolicy(routine);
    if (!policyResult.shouldExecute) {
      logger.log(
        `[${routineId}] Skipped by concurrency policy: ${policyResult.reason}`
      );
      return {
        routineId,
        success: true,
        executedAt: new Date().toISOString(),
        catchUpExecution: !!catchUpFrom,
        error: policyResult.reason,
      };
    }

    // Mark as in-flight
    inFlightExecutions.set(routineId, true);

    try {
      // Persist execution start
      const startedAt = new Date().toISOString();
      await this.routineStore.startRoutineExecution(routineId, {
        triggeredAt: startedAt,
        catchUpFrom,
        invocationSource: "routine",
      });

      logger.log(`[${routineId}] Starting routine execution`);

      // Execute via heartbeat monitor
      const run = await this.heartbeatMonitor.executeHeartbeat({
        agentId: routine.agentId,
        source: "routine" as HeartbeatInvocationSource,
        triggerDetail: `routine:${routineId}`,
        contextSnapshot: {
          routineId,
          catchUpFrom,
          executionPolicy: routine.executionPolicy,
          catchUpPolicy: routine.catchUpPolicy,
        },
      });

      // Handle failed/terminated runs
      if (run.status === "failed" || run.status === "terminated") {
        const error = run.stderrExcerpt || `Run ${run.status}`;
        logger.log(`[${routineId}] Execution ${run.status}: ${error}`);
        await this.routineStore.completeRoutineExecution(routineId, {
          completedAt: run.endedAt ?? new Date().toISOString(),
          success: false,
          error,
        });
        return {
          routineId,
          success: false,
          error,
          executedAt: startedAt,
          catchUpExecution: !!catchUpFrom,
        };
      }

      // Persist execution completion
      const completedAt = run.endedAt ?? new Date().toISOString();
      await this.routineStore.completeRoutineExecution(routineId, {
        completedAt,
        success: true,
        resultJson: run.resultJson,
      });

      logger.log(`[${routineId}] Routine execution completed successfully`);

      return {
        routineId,
        success: true,
        executedAt: completedAt,
        catchUpExecution: !!catchUpFrom,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.log(`[${routineId}] Routine execution failed: ${errorMessage}`);

      // Persist execution failure
      try {
        await this.routineStore.completeRoutineExecution(routineId, {
          completedAt: new Date().toISOString(),
          success: false,
          error: errorMessage,
        });
      } catch (persistError) {
        logger.error(`[${routineId}] Failed to persist error state: ${persistError}`);
      }

      return {
        routineId,
        success: false,
        error: errorMessage,
        executedAt: new Date().toISOString(),
        catchUpExecution: !!catchUpFrom,
      };
    } finally {
      // Clear in-flight flag
      inFlightExecutions.delete(routineId);
    }
  }

  /**
   * Check if a routine should be executed based on its concurrency policy.
   */
  private checkConcurrencyPolicy(
    routine: Routine
  ): { shouldExecute: boolean; reason?: string } {
    const routineId = routine.id;
    const isInFlight = this.isExecuting(routineId);

    if (isInFlight) {
      switch (routine.executionPolicy) {
        case "parallel":
          return { shouldExecute: true };

        case "reject":
          return {
            shouldExecute: false,
            reason: `Routine ${routineId} is already being executed (policy: reject)`,
          };

        case "queue":
          // Queue for later execution - return without executing
          return {
            shouldExecute: false,
            reason: `Routine ${routineId} is already being executed (policy: queue)`,
          };

        default:
          return {
            shouldExecute: false,
            reason: `Unknown execution policy for ${routineId}`,
          };
      }
    }

    return { shouldExecute: true };
  }

  /**
   * Determine if a catch-up execution should occur based on the routine's catch-up policy.
   */
  determineCatchUp(
    routine: Routine,
    lastRunAt: string | null,
    currentTime: Date
  ): { shouldCatchUp: boolean; catchUpFrom?: string } {
    if (!lastRunAt) {
      return { shouldCatchUp: false };
    }

    switch (routine.catchUpPolicy) {
      case "skip":
        return { shouldCatchUp: false };

      case "run_one":
        return { shouldCatchUp: true, catchUpFrom: lastRunAt };

      case "run": {
        const catchUpLimit = routine.catchUpLimit ?? 5;
        const lastExecuted = new Date(lastRunAt);
        const diffMs = currentTime.getTime() - lastExecuted.getTime();

        const intervalMs = this.getRoutineIntervalMs(routine);
        if (intervalMs <= 0) {
          return { shouldCatchUp: false };
        }

        const missedCount = Math.floor(diffMs / intervalMs);
        const boundedCount = Math.min(missedCount, catchUpLimit);

        if (boundedCount <= 1) {
          return { shouldCatchUp: false };
        }

        const catchUpFrom = new Date(
          lastExecuted.getTime() + intervalMs
        ).toISOString();

        logger.log(
          `[${routine.id}] Catch-up: ${boundedCount} missed executions (limit: ${catchUpLimit})`
        );

        return { shouldCatchUp: true, catchUpFrom };
      }

      default:
        return { shouldCatchUp: false };
    }
  }

  /**
   * Get the interval in milliseconds for a routine based on its cron schedule.
   */
  private getRoutineIntervalMs(routine: Routine): number {
    if (routine.trigger.type === "cron") {
      const cron = routine.trigger.cronExpression;
      if (cron.includes("* * *")) return 60_000;
      if (cron.includes("*/5")) return 5 * 60_000;
      if (cron.includes("*/10")) return 10 * 60_000;
      if (cron.includes("*/15")) return 15 * 60_000;
      if (cron.includes("*/30")) return 30 * 60_000;
      if (cron.includes("0 * *")) return 60 * 60_000;
      if (cron.includes("0 0 *")) return 24 * 60 * 60_000;
      return 5 * 60_000;
    }
    return 5 * 60_000;
  }

  /**
   * Clear the in-flight flag for a routine (for testing).
   */
  clearInFlight(routineId: string): void {
    inFlightExecutions.delete(routineId);
  }
}

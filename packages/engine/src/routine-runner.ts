/**
 * RoutineRunner — orchestrates routine execution via the heartbeat system.
 *
 * - Validates routine state before execution (enabled, has assigned agent)
 * - Enforces concurrency policies (parallel/skip/queue/replace)
 * - Handles catch-up for missed runs
 * - Triggers heartbeat execution for routines
 */

import { CronExpressionParser } from "cron-parser";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type {
  RoutineStore,
  Routine,
  RoutineExecutionResult,
  AutomationRunResult,
  AutomationStep,
  AutomationStepResult,
  Column,
  TaskCreateInput,
  TaskStore,
} from "@fusion/core";
import type { HeartbeatMonitor } from "./agent-heartbeat.js";
import type { AiPromptExecutor } from "./cron-runner.js";
import { createLogger } from "./logger.js";
import { defaultShell } from "./shell-utils.js";

const log = createLogger("routine-runner");
const execAsync = promisify(exec);
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 1024 * 1024;
const MAX_OUTPUT_LENGTH = 10 * 1024;

/** Options for RoutineRunner constructor */
export interface RoutineRunnerOptions {
  /** RoutineStore for querying and updating routines */
  routineStore: RoutineStore;
  /** HeartbeatMonitor for triggering agent execution */
  heartbeatMonitor: HeartbeatMonitor;
  /** Project root directory */
  rootDir: string;
  /** Optional task store used when routines execute schedule-style actions. */
  taskStore?: TaskStore;
  /** Optional AI prompt executor for ai-prompt action steps. */
  aiPromptExecutor?: AiPromptExecutor;
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

    if (!this.hasRoutineAction(routine) && !routine.agentId) {
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
      const actionResult = this.hasRoutineAction(routine)
        ? await this.executeRoutineAction(routine, startedAt)
        : await this.executeAgentRoutine(routine, triggerType, context);

      await this.options.routineStore.completeRoutineExecution(routineId, {
        completedAt: actionResult.completedAt,
        success: actionResult.success,
        resultJson: actionResult.success ? { output: actionResult.output } : undefined,
        output: actionResult.output,
        error: actionResult.error,
        triggerType: triggerType as RoutineExecutionResult["triggerType"],
        stepResults: actionResult.stepResults,
      });

      return {
        routineId,
        success: actionResult.success,
        output: actionResult.output,
        startedAt,
        completedAt: actionResult.completedAt,
        error: actionResult.error,
        triggerType: triggerType as RoutineExecutionResult["triggerType"],
        stepResults: actionResult.stepResults,
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

  private hasRoutineAction(routine: Routine): boolean {
    return Boolean((routine.steps && routine.steps.length > 0) || routine.command?.trim());
  }

  private async executeAgentRoutine(
    routine: Routine,
    triggerType: string,
    context: Record<string, unknown> | undefined,
  ): Promise<AutomationRunResult> {
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

    if (run.status === "failed" || run.status === "terminated") {
      const error = run.stderrExcerpt || `Run ${run.status}`;
      return {
        success: false,
        output: error,
        error,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    return {
      success: true,
      output: run.resultJson ? JSON.stringify(run.resultJson) : "Routine completed successfully",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
  }

  private async executeRoutineAction(
    routine: Routine,
    startedAt: string,
  ): Promise<AutomationRunResult> {
    if (routine.steps && routine.steps.length > 0) {
      return this.executeSteps(routine, startedAt);
    }
    return this.executeCommand(routine.command ?? "", routine.timeoutMs, startedAt);
  }

  private async executeCommand(
    command: string,
    timeoutMs: number | undefined,
    startedAt: string,
  ): Promise<AutomationRunResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        shell: defaultShell,
      });

      return {
        success: true,
        output: truncateOutput(stdout, stderr),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (err) {
      const errObj = err as Record<string, unknown>;
      const stdout = typeof errObj.stdout === "string" ? errObj.stdout : "";
      const stderr = typeof errObj.stderr === "string" ? errObj.stderr : "";
      const error = errObj.killed === true
        ? `Command timed out after ${(timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
        : (err instanceof Error ? err.message : null) ?? String(err);
      return {
        success: false,
        output: truncateOutput(stdout, stderr),
        error,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  private async executeSteps(routine: Routine, startedAt: string): Promise<AutomationRunResult> {
    const steps = routine.steps ?? [];
    const stepResults: AutomationStepResult[] = [];
    let overallSuccess = true;
    let stoppedEarly = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const result = await this.executeStep(routine, step, i);
      stepResults.push(result);

      if (!result.success) {
        overallSuccess = false;
        if (!step.continueOnFailure) {
          stoppedEarly = true;
          break;
        }
      }
    }

    const outputParts: string[] = [];
    for (const sr of stepResults) {
      outputParts.push(`=== Step ${sr.stepIndex + 1}: ${sr.stepName} (${sr.success ? "success" : "FAILED"}) ===`);
      if (sr.output) outputParts.push(sr.output);
      if (sr.error) outputParts.push(`Error: ${sr.error}`);
    }
    const failedSteps = stepResults.filter((sr) => !sr.success);

    return {
      success: overallSuccess,
      output: truncateOutput(outputParts.join("\n"), ""),
      error: failedSteps.length > 0
        ? `${failedSteps.length} step(s) failed: ${failedSteps.map((s) => s.stepName).join(", ")}${stoppedEarly ? " (execution stopped)" : ""}`
        : undefined,
      startedAt,
      completedAt: new Date().toISOString(),
      stepResults,
    };
  }

  private async executeStep(
    routine: Routine,
    step: AutomationStep,
    stepIndex: number,
  ): Promise<AutomationStepResult> {
    const startedAt = new Date().toISOString();
    const timeoutMs = step.timeoutMs ?? routine.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (step.type === "command") {
      const result = await this.executeCommand(step.command ?? "", timeoutMs, startedAt);
      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: result.success,
        output: result.output,
        error: result.error,
        startedAt,
        completedAt: result.completedAt,
      };
    }

    if (step.type === "ai-prompt") {
      if (!step.prompt?.trim()) {
        return { stepId: step.id, stepName: step.name, stepIndex, success: false, output: "", error: "AI prompt step has no prompt specified", startedAt, completedAt: new Date().toISOString() };
      }
      if (!this.options.aiPromptExecutor) {
        return { stepId: step.id, stepName: step.name, stepIndex, success: false, output: "", error: "AI execution is not configured", startedAt, completedAt: new Date().toISOString() };
      }
      try {
        const output = await Promise.race([
          this.options.aiPromptExecutor(step.prompt, step.modelProvider, step.modelId),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`AI prompt step timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
        ]);
        return { stepId: step.id, stepName: step.name, stepIndex, success: true, output: truncateOutput(output, ""), startedAt, completedAt: new Date().toISOString() };
      } catch (err) {
        return { stepId: step.id, stepName: step.name, stepIndex, success: false, output: "", error: err instanceof Error ? err.message : String(err), startedAt, completedAt: new Date().toISOString() };
      }
    }

    if (step.type === "create-task") {
      if (!this.options.taskStore) {
        return { stepId: step.id, stepName: step.name, stepIndex, success: false, output: "", error: "Task creation is not configured", startedAt, completedAt: new Date().toISOString() };
      }
      if (!step.taskDescription?.trim()) {
        return { stepId: step.id, stepName: step.name, stepIndex, success: false, output: "", error: "Create-task step has no task description specified", startedAt, completedAt: new Date().toISOString() };
      }

      const taskInput: TaskCreateInput = {
        title: step.taskTitle?.trim() || undefined,
        description: step.taskDescription.trim(),
        column: (step.taskColumn as Column) || "triage",
        modelProvider: step.modelProvider?.trim() || undefined,
        modelId: step.modelId?.trim() || undefined,
      };
      try {
        const task = await this.options.taskStore.createTask(taskInput);
        return { stepId: step.id, stepName: step.name, stepIndex, success: true, output: `Created task ${task.id}: ${task.title || task.description.slice(0, 80)}`, startedAt, completedAt: new Date().toISOString() };
      } catch (err) {
        return { stepId: step.id, stepName: step.name, stepIndex, success: false, output: "", error: err instanceof Error ? err.message : String(err), startedAt, completedAt: new Date().toISOString() };
      }
    }

    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex,
      success: false,
      output: "",
      error: `Unknown step type: "${String((step as unknown as Record<string, unknown>).type)}"`,
      startedAt,
      completedAt: new Date().toISOString(),
    };
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

function truncateOutput(stdout: string, stderr: string): string {
  let output = stdout;
  if (stderr) {
    output += stdout ? "\n--- stderr ---\n" : "";
    output += stderr;
  }
  if (output.length > MAX_OUTPUT_LENGTH) {
    return `${output.slice(0, MAX_OUTPUT_LENGTH)}\n[output truncated]`;
  }
  return output;
}

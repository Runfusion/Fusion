/**
 * RoutineRunner — orchestrates routine execution via the heartbeat system.
 *
 * - Validates routine state before execution (enabled, has assigned agent)
 * - Enforces concurrency policies (parallel/skip/queue/replace)
 * - Handles catch-up for missed runs
 * - Triggers heartbeat execution for routines
 */

import { CronExpressionParser } from "cron-parser";
import { isInProcessBackupCommand, isInProcessMemoryBackupCommand } from "./cron-runner.js";
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
import type { AiPromptExecutor, AiPromptLiveCallbacks } from "./cron-runner.js";
import { createLogger } from "./logger.js";
import { defaultShell } from "./shell-utils.js";
import { resolveSandboxBackend } from "./sandbox/index.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";
import type { EngineRunContext, RunAuditor } from "./run-audit.js";
import type { SandboxBackend } from "./sandbox/types.js";

const log = createLogger("routine-runner");
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER = 1024 * 1024;
const MAX_OUTPUT_LENGTH = 10 * 1024;


/** Options for RoutineRunner constructor */
/*
FNXC:AutomationLiveOutput 2026-06-26-00:00:
Routine manual triggers share the automation live-output contract. Thread optional callbacks through the runner so routes can stream step boundaries, AI text/tool events, and final output without changing scheduled/background execution behavior.
*/
export type RoutineLiveRunCallbacks = AiPromptLiveCallbacks & {
  onStep?: (data: Record<string, unknown>) => void;
};

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
    liveCallbacks?: RoutineLiveRunCallbacks,
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
    const executionPromise = this.runExecution(routine, triggerType, context, startedAt, liveCallbacks);
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
    liveCallbacks?: RoutineLiveRunCallbacks,
  ): Promise<RoutineExecutionResult> {
    const routineId = routine.id;

    try {
      const actionResult = this.hasRoutineAction(routine)
        ? await this.executeRoutineAction(routine, startedAt, liveCallbacks)
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
    liveCallbacks?: RoutineLiveRunCallbacks,
  ): Promise<AutomationRunResult> {
    if (routine.steps && routine.steps.length > 0) {
      return this.executeSteps(routine, startedAt, liveCallbacks);
    }
    liveCallbacks?.onStep?.({ stepIndex: 0, stepId: "command", stepName: routine.name, stepType: "command", status: "started" });
    const result = await this.executeCommand(routine, routine.command ?? "", routine.timeoutMs, startedAt);
    liveCallbacks?.onStep?.({ stepIndex: 0, stepId: "command", stepName: routine.name, stepType: "command", status: "completed", success: result.success, error: result.error });
    if (result.output) liveCallbacks?.onText?.(result.output);
    return result;
  }

  private getRoutineCommandAuditor(routine: Routine): RunAuditor | undefined {
    if (!this.options.taskStore) {
      return undefined;
    }

    // FN-4689: close FN-4640 follow-up by wiring routine command sandbox execution through RunAuditor.
    const engineRunContext: EngineRunContext = {
      runId: generateSyntheticRunId("routine", routine.id),
      agentId: routine.agentId ?? "routine-runner",
      phase: "routine-execute",
      source: "routine",
    };

    return createRunAuditor(this.options.taskStore, engineRunContext);
  }

  private async executeCommand(
    routine: Routine,
    command: string,
    timeoutMs: number | undefined,
    startedAt: string,
  ): Promise<AutomationRunResult> {
    // Intercept the auto-backup command so it runs in-process via the engine's
    // existing TaskStore instead of shelling out to a globally-installed
    // fusion binary (which may be older than the running engine and re-create
    // the nested `.fusion/.fusion/` directory). Mirrors cron-runner.ts.
    if (isInProcessBackupCommand(command) && this.options.taskStore) {
      try {
        const { runBackupCommand } = await import("@fusion/core");
        const fusionDir = this.options.taskStore.getFusionDir();
        const settings = await this.options.taskStore.getSettings();
        const result = await runBackupCommand(fusionDir, settings);
        const output = truncateOutput(result.output ?? "", "");
        return {
          success: result.success,
          output,
          error: result.success ? undefined : formatInProcessBackupError(output, fusionDir),
          startedAt,
          completedAt: new Date().toISOString(),
        };
      } catch (err) {
        const message = formatInProcessBackupError(err, this.options.taskStore.getFusionDir());
        return {
          success: false,
          output: "",
          error: message,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }
    }

    if (isInProcessMemoryBackupCommand(command) && this.options.taskStore) {
      try {
        const { runMemoryBackupCommand } = await import("@fusion/core");
        const fusionDir = this.options.taskStore.getFusionDir();
        const settings = await this.options.taskStore.getSettings();
        const result = await runMemoryBackupCommand(fusionDir, settings);
        return {
          success: result.success,
          output: truncateOutput(result.output ?? "", ""),
          error: result.success ? undefined : result.output,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          output: "",
          error: message,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }
    }

    const auditor = this.getRoutineCommandAuditor(routine);
    const backend: SandboxBackend = auditor
      ? resolveSandboxBackend({ auditor })
      : resolveSandboxBackend();
    await backend.prepare({ allowNetwork: true });
    const result = await backend.run(command, {
      cwd: this.options.rootDir,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      shell: defaultShell,
    });

    if (result.exitCode === 0 && !result.signal && !result.timedOut && !result.bufferExceeded && !result.spawnError) {
      return {
        success: true,
        output: truncateOutput(result.stdout, result.stderr),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    const error = result.timedOut
      ? `Command timed out after ${(timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
      : result.spawnError?.message ?? "Command failed";
    return {
      success: false,
      output: truncateOutput(result.stdout, result.stderr),
      error,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private async executeSteps(routine: Routine, startedAt: string, liveCallbacks?: RoutineLiveRunCallbacks): Promise<AutomationRunResult> {
    const steps = routine.steps ?? [];
    const stepResults: AutomationStepResult[] = [];
    let overallSuccess = true;
    let stoppedEarly = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      liveCallbacks?.onStep?.({ stepIndex: i, stepId: step.id, stepName: step.name, stepType: step.type, status: "started" });
      const result = await this.executeStep(routine, step, i, liveCallbacks);
      liveCallbacks?.onStep?.({ stepIndex: i, stepId: step.id, stepName: step.name, stepType: step.type, status: "completed", success: result.success, error: result.error });
      if (step.type !== "ai-prompt" && result.output) liveCallbacks?.onText?.(result.output);
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
    liveCallbacks?: RoutineLiveRunCallbacks,
  ): Promise<AutomationStepResult> {
    const startedAt = new Date().toISOString();
    const timeoutMs = step.timeoutMs ?? routine.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (step.type === "command") {
      const result = await this.executeCommand(routine, step.command ?? "", timeoutMs, startedAt);
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
        /*
        FNXC:Automations 2026-07-12-20:30:
        Routine AI-prompt steps share the CronRunner AiPromptExecutor seam. Pass the persisted per-step thinking level before live callbacks so explicit reasoning effort applies and omitted/blank values inherit defaults.
        */
        const output = await Promise.race([
          this.options.aiPromptExecutor(step.prompt, step.modelProvider, step.modelId, step.allowedTools, step.thinkingLevel?.trim() || undefined, liveCallbacks),
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

      /*
      FNXC:Automations 2026-07-12-20:30:
      Routine create-task steps map their persisted thinking level onto the spawned task. Blank values remain undefined to keep the task's normal thinking-level inheritance.
      */
      const taskInput: TaskCreateInput = {
        title: step.taskTitle?.trim() || undefined,
        description: step.taskDescription.trim(),
        column: (step.taskColumn as Column) || "triage",
        modelProvider: step.modelProvider?.trim() || undefined,
        modelId: step.modelId?.trim() || undefined,
        thinkingLevel: (step.thinkingLevel?.trim() || undefined) as TaskCreateInput["thinkingLevel"],
        source: {
          sourceType: "automation",
          sourceMetadata: { routineId: routine.id, stepId: step.id },
        },
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
  async triggerManual(routineId: string, liveCallbacks?: RoutineLiveRunCallbacks): Promise<RoutineExecutionResult> {
    const routine = await this.options.routineStore.getRoutine(routineId);

    if (!routine.enabled) {
      throw new Error(`Routine '${routineId}' is disabled`);
    }

    return this.executeRoutine(routineId, "api", undefined, liveCallbacks);
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

/*
FNXC:DatabaseBackup 2026-06-26-12:00:
Routine-runner in-process backups persist AutomationRunResult.error directly to lastRunResult. Normalize empty or opaque failures here so Database Backup cards always show a DB-qualified cause.
*/
function formatInProcessBackupError(err: unknown, fusionDir: string): string {
  const message = err instanceof Error ? err.message.trim() : String(err ?? "").trim();
  const cause = message || "unknown error";
  if (cause.includes("project DB") || cause.includes("central DB")) {
    return cause;
  }
  return `project PostgreSQL run backup command failed; project state: ${fusionDir}; cause: ${cause}`;
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

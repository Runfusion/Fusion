import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { TaskStore } from "@fusion/core";
import type { AutomationStore } from "@fusion/core";
import type { ScheduledTask, AutomationRunResult, AutomationStep, AutomationStepResult, Column, TaskCreateInput } from "@fusion/core";
import { createLogger } from "./logger.js";
import { defaultShell } from "./shell-utils.js";

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

/**
 * Function type for executing AI prompts.
 * Injected into CronRunner to decouple it from agent session creation.
 */
export type AiPromptExecutor = (
  prompt: string,
  modelProvider?: string,
  modelId?: string,
) => Promise<string>;

export interface CronRunnerOptions {
  /** Polling interval in milliseconds. Default: 60000 (60s). Minimum: 10000 (10s). */
  pollIntervalMs?: number;
  /** Optional AI prompt executor. When not provided, ai-prompt steps return a configuration error. */
  aiPromptExecutor?: AiPromptExecutor;
  /**
   * Optional post-run callback invoked after schedule execution and run recording.
   *
   * Called as a best-effort side effect — callback errors are logged but do not
   * alter the returned `AutomationRunResult` or flip successful runs to failed.
   * This keeps post-processing isolated from the core execution contract.
   *
   * The callback receives:
   * - `schedule`: The schedule that was executed
   * - `result`: The `AutomationRunResult` from execution (success/failure)
   *
   * Use this for schedule-specific processing such as:
   * - Persisting memory insight extraction results
   * - Updating external systems based on automation output
   * - Triggering downstream side effects
   */
  onScheduleRunProcessed?: (
    schedule: ScheduledTask,
    result: AutomationRunResult,
  ) => void | Promise<void>;
  /**
   * Scope to poll for due schedules.
   * - "project": Only poll schedules scoped to this project (default)
   * - "global": Only poll global/shared schedules
   * - "all": Poll both project and global scopes
   *
   * When polling "all", the runner executes schedules from both scopes but
   * deduplicates by schedule ID to prevent double-execution.
   */
  scope?: "global" | "project" | "all";
}

/**
 * CronRunner polls the AutomationStore for due schedules and executes them.
 *
 * UTILITY PATH: This component runs on the utility lane and does NOT receive the
 * task-lane semaphore. Automation execution is independent of task execution concurrency.
 *
 * - Respects `globalPause` and `enginePaused` settings — skips execution when either is true.
 * - Prevents concurrent runs of the same schedule.
 * - Enforces per-schedule timeouts and output size limits.
 * - Uses a re-entrance guard like Scheduler to prevent overlapping ticks.
 * - Supports scope-aware polling: "global", "project", or "all" (both scopes).
 *
 * SCOPED POLLING SEMANTICS:
 * - scope="project" (default): Only polls schedules scoped to this project
 * - scope="global": Only polls global/shared schedules (e.g., memory insight extraction)
 * - scope="all": Polls both scopes with deterministic de-duplication by schedule ID
 *
 * Each ProjectEngine instance runs with scope="project", ensuring project isolation.
 * A separate global engine (FN-1714) runs with scope="global" for shared schedules.
 */
export class CronRunner {
  private running = false;
  private ticking = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private aiPromptExecutor?: AiPromptExecutor;
  private onScheduleRunProcessed?: CronRunnerOptions["onScheduleRunProcessed"];
  /** Schedule IDs currently being executed — prevents concurrent runs of the same schedule. */
  private inFlight = new Set<string>();
  /** Scope to poll: "global", "project", or "all" (both scopes). */
  private scope: "global" | "project" | "all";

  constructor(
    private store: TaskStore,
    private automationStore: AutomationStore,
    private options: CronRunnerOptions = {},
  ) {
    this.pollIntervalMs = Math.max(
      MIN_POLL_INTERVAL_MS,
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    this.aiPromptExecutor = options.aiPromptExecutor;
    this.onScheduleRunProcessed = options.onScheduleRunProcessed;
    this.scope = options.scope ?? "project";
  }

  /** Start the polling loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.log(`Started (poll every ${this.pollIntervalMs / 1000}s, scope: ${this.scope})`);

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

      // Get due schedules based on configured scope
      let dueSchedules: ScheduledTask[];
      if (this.scope === "all") {
        // Poll both scopes and deduplicate by ID
        dueSchedules = await this.automationStore.getDueSchedulesAllScopes();
      } else {
        dueSchedules = await this.automationStore.getDueSchedules(this.scope);
      }

      if (dueSchedules.length === 0) return;

      // Track executed schedule IDs to prevent double-execution when polling all scopes
      const executedIds = new Set<string>();

      for (const schedule of dueSchedules) {
        // Skip if already in-flight (prevents concurrent runs of same schedule)
        if (this.inFlight.has(schedule.id)) {
          log.warn(`Skipping ${schedule.name} (${schedule.id}) — still running from previous tick`);
          continue;
        }

        // Skip if already executed this tick (de-duplication across scopes)
        if (executedIds.has(schedule.id)) {
          log.log(`Skipping ${schedule.name} (${schedule.id}) — already executed from another scope this tick`);
          continue;
        }
        executedIds.add(schedule.id);

        // Log which scope this schedule is from
        const scheduleScope = schedule.scope ?? "project";
        if (scheduleScope !== this.scope && this.scope !== "all") {
          log.log(`Skipping ${schedule.name} (${schedule.id}) — belongs to ${scheduleScope} scope, not polling`);
          continue;
        }

        log.log(`Executing ${schedule.name} (${schedule.id}) [scope: ${scheduleScope}]`);

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
   * Execute a single schedule.
   *
   * - **Legacy mode**: When `steps` is undefined/empty, execute `command` directly.
   * - **Step mode**: When `steps` is present, execute steps sequentially.
   *
   * Tracks in-flight state to prevent concurrent runs.
   * Records the run result in the automation store.
   */
  async executeSchedule(schedule: ScheduledTask): Promise<AutomationRunResult> {
    this.inFlight.add(schedule.id);
    const startedAt = new Date().toISOString();

    let result: AutomationRunResult;

    try {
      if (schedule.steps && schedule.steps.length > 0) {
        result = await this.executeSteps(schedule, startedAt);
      } else {
        result = await this.executeLegacyCommand(schedule, startedAt);
      }
    } finally {
      this.inFlight.delete(schedule.id);
    }

    // Record run result
    try {
      await this.automationStore.recordRun(schedule.id, result);
    } catch (recordErr) {
      log.error(`Failed to record run for ${schedule.id}: ${(recordErr as Error).message}`);
    }

    // Invoke post-run callback (best-effort side effect)
    // Errors here do not alter the returned result or flip success/failure
    if (this.onScheduleRunProcessed) {
      try {
        await this.onScheduleRunProcessed(schedule, result);
      } catch (callbackErr) {
        log.error(
          `Post-run callback failed for ${schedule.name} (${schedule.id}): ${(callbackErr as Error).message}`,
        );
      }
    }

    return result;
  }

  /**
   * Execute a legacy single-command schedule.
   */
  private async executeLegacyCommand(
    schedule: ScheduledTask,
    startedAt: string,
  ): Promise<AutomationRunResult> {
    log.log(`Executing ${schedule.name} (${schedule.id}): ${schedule.command}`);

    try {
      const timeoutMs = schedule.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { stdout, stderr } = await execAsync(schedule.command, {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        shell: defaultShell,
      });

      const output = truncateOutput(stdout, stderr);
      log.log(`✓ ${schedule.name} completed (${output.length} bytes output)`);

      return {
        success: true,
        output,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      const stdout = err.stdout ?? "";
      const stderr = err.stderr ?? "";
      const output = truncateOutput(stdout, stderr);
      const errorMessage = err.killed
        ? `Command timed out after ${(schedule.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
        : err.message ?? String(err);

      log.warn(`✗ ${schedule.name} failed: ${errorMessage}`);

      return {
        success: false,
        output,
        error: errorMessage,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Execute multiple steps sequentially.
   * Aggregates per-step results into an overall AutomationRunResult.
   */
  private async executeSteps(
    schedule: ScheduledTask,
    startedAt: string,
  ): Promise<AutomationRunResult> {
    const steps = schedule.steps!;
    log.log(`Executing ${schedule.name} (${schedule.id}): ${steps.length} steps`);

    const stepResults: AutomationStepResult[] = [];
    let overallSuccess = true;
    let stoppedEarly = false;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      log.log(`  Step ${i + 1}/${steps.length}: ${step.name} (${step.type})`);

      const stepResult = await this.executeStep(schedule, step, i);
      stepResults.push(stepResult);

      if (!stepResult.success) {
        overallSuccess = false;
        if (!step.continueOnFailure) {
          log.warn(`  Step "${step.name}" failed — stopping execution`);
          stoppedEarly = true;
          break;
        }
        log.warn(`  Step "${step.name}" failed — continuing (continueOnFailure=true)`);
      } else {
        log.log(`  ✓ Step "${step.name}" completed`);
      }
    }

    // Aggregate output from all steps
    const outputParts: string[] = [];
    for (const sr of stepResults) {
      outputParts.push(`=== Step ${sr.stepIndex + 1}: ${sr.stepName} (${sr.success ? "success" : "FAILED"}) ===`);
      if (sr.output) outputParts.push(sr.output);
      if (sr.error) outputParts.push(`Error: ${sr.error}`);
    }
    const output = truncateOutput(outputParts.join("\n"), "");

    // Build error summary
    const failedSteps = stepResults.filter((sr) => !sr.success);
    const error = failedSteps.length > 0
      ? `${failedSteps.length} step(s) failed: ${failedSteps.map((s) => s.stepName).join(", ")}${stoppedEarly ? " (execution stopped)" : ""}`
      : undefined;

    const status = overallSuccess ? "✓" : "✗";
    log.log(`${status} ${schedule.name}: ${stepResults.length}/${steps.length} steps executed, ${failedSteps.length} failed`);

    return {
      success: overallSuccess,
      output,
      error,
      startedAt,
      completedAt: new Date().toISOString(),
      stepResults,
    };
  }

  /**
   * Execute a single automation step.
   */
  async executeStep(
    schedule: ScheduledTask,
    step: AutomationStep,
    stepIndex: number,
  ): Promise<AutomationStepResult> {
    const stepStartedAt = new Date().toISOString();
    const timeoutMs = step.timeoutMs ?? schedule.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (step.type === "command") {
      return this.executeCommandStep(step, stepIndex, timeoutMs, stepStartedAt);
    } else if (step.type === "ai-prompt") {
      return this.executeAiPromptStep(step, stepIndex, timeoutMs, stepStartedAt);
    } else if (step.type === "create-task") {
      return this.executeCreateTaskStep(step, stepIndex, stepStartedAt);
    }

    // Unknown step type
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex,
      success: false,
      output: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: `Unknown step type: "${(step as any).type}"`,
      startedAt: stepStartedAt,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Execute a command step using shell execution.
   */
  private async executeCommandStep(
    step: AutomationStep,
    stepIndex: number,
    timeoutMs: number,
    startedAt: string,
  ): Promise<AutomationStepResult> {
    if (!step.command?.trim()) {
      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: false,
        output: "",
        error: "Command step has no command specified",
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    try {
      const { stdout, stderr } = await execAsync(step.command, {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        shell: defaultShell,
      });

      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: true,
        output: truncateOutput(stdout, stderr),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      const stdout = err.stdout ?? "";
      const stderr = err.stderr ?? "";
      const errorMessage = err.killed
        ? `Command timed out after ${timeoutMs / 1000}s`
        : err.message ?? String(err);

      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: false,
        output: truncateOutput(stdout, stderr),
        error: errorMessage,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Execute an AI prompt step.
   * Uses the injected aiPromptExecutor to create an agent session and run the prompt.
   * When no executor is configured, returns a configuration error.
   */
  private async executeAiPromptStep(
    step: AutomationStep,
    stepIndex: number,
    timeoutMs: number,
    startedAt: string,
  ): Promise<AutomationStepResult> {
    if (!step.prompt?.trim()) {
      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: false,
        output: "",
        error: "AI prompt step has no prompt specified",
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    // Check if AI execution is configured
    if (!this.aiPromptExecutor) {
      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: false,
        output: "",
        error: "AI execution is not configured — no aiPromptExecutor provided to CronRunner",
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    // Resolve model: step override → settings default
    const settings = await this.store.getSettings();
    const modelProvider = step.modelProvider?.trim() || settings.defaultProvider;
    const modelId = step.modelId?.trim() || settings.defaultModelId;

    const model = modelProvider && modelId
      ? `${modelProvider}/${modelId}`
      : "default";
    log.log(`    AI prompt step "${step.name}" using model: ${model}`);
    log.log(`    Prompt: ${step.prompt.slice(0, 100)}${step.prompt.length > 100 ? "…" : ""}`);

    try {
      // Race between executor and timeout
      const resultPromise = this.aiPromptExecutor(step.prompt, modelProvider, modelId);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`AI prompt step timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      });

      const response = await Promise.race([resultPromise, timeoutPromise]);

      const output = response.length > MAX_OUTPUT_LENGTH
        ? response.slice(0, MAX_OUTPUT_LENGTH) + "\n[output truncated]"
        : response;

      log.log(`    ✓ AI prompt step "${step.name}" completed (${response.length} chars)`);

      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: true,
        output,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      const errorMessage = err.message ?? String(err);
      log.warn(`    ✗ AI prompt step "${step.name}" failed: ${errorMessage}`);

      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: false,
        output: "",
        error: errorMessage,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Execute a create-task step.
   * Creates a new task in the task board using the configured fields.
   */
  private async executeCreateTaskStep(
    step: AutomationStep,
    stepIndex: number,
    startedAt: string,
  ): Promise<AutomationStepResult> {
    // Validate that taskDescription is present and non-empty
    if (!step.taskDescription?.trim()) {
      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: false,
        output: "",
        error: "Create-task step has no task description specified",
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    // Build TaskCreateInput from step fields
    const taskInput: TaskCreateInput = {
      title: step.taskTitle?.trim() || undefined,
      description: step.taskDescription.trim(),
      column: (step.taskColumn as Column) || "triage",
      modelProvider: step.modelProvider?.trim() || undefined,
      modelId: step.modelId?.trim() || undefined,
    };

    try {
      const task = await this.store.createTask(taskInput);

      const output = `Created task ${task.id}: ${task.title || task.description.slice(0, 80)}`;
      log.log(`    ✓ Create-task step "${step.name}" created task ${task.id}`);

      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: true,
        output,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (err) {
      const errorMessage = (err as Error).message ?? String(err);
      log.warn(`    ✗ Create-task step "${step.name}" failed: ${errorMessage}`);

      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: false,
        output: "",
        error: errorMessage,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }
}

const AI_AUTOMATION_SYSTEM_PROMPT = [
  "You are an AI automation agent executing a scheduled task.",
  "You have read-only access to the project files.",
  "Execute the prompt precisely and return concise, structured results.",
  "When analyzing code or data, provide actionable summaries.",
].join("\n");

/**
 * Create an AiPromptExecutor that uses createFnAgent for real AI execution.
 *
 * Each call creates a fresh agent session, runs the prompt, collects the
 * text response, and disposes the session.
 *
 * @param cwd — Project root directory (file access scope for the agent).
 * @returns An AiPromptExecutor function suitable for CronRunnerOptions.
 */
export async function createAiPromptExecutor(cwd: string): Promise<AiPromptExecutor> {
  // We import lazily to keep the factory self-contained and to avoid
  // pulling pi.ts into the module graph when AI execution isn't used.
  const { createFnAgent, promptWithFallback } = await import("./pi.js");
  const disposeLog = createLogger("cron-runner");

  return async (prompt: string, modelProvider?: string, modelId?: string): Promise<string> => {
    let responseText = "";

    const { session } = await createFnAgent({
      cwd,
      systemPrompt: AI_AUTOMATION_SYSTEM_PROMPT,
      tools: "readonly",
      defaultProvider: modelProvider,
      defaultModelId: modelId,
      onText: (delta: string) => {
        responseText += delta;
      },
    });

    try {
      await promptWithFallback(session, prompt);
      return responseText;
    } finally {
      try {
        session.dispose();
      } catch (err) {
        disposeLog.warn(`Session disposal failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
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

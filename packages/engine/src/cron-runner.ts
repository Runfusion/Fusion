import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { TaskStore } from "@kb/core";
import type { AutomationStore } from "@kb/core";
import type { ScheduledTask, AutomationRunResult, AutomationStep, AutomationStepResult } from "@kb/core";
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
        shell: "/bin/sh",
      });

      const output = truncateOutput(stdout, stderr);
      log.log(`✓ ${schedule.name} completed (${output.length} bytes output)`);

      return {
        success: true,
        output,
        startedAt,
        completedAt: new Date().toISOString(),
      };
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
    }

    // Unknown step type
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex,
      success: false,
      output: "",
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
        shell: "/bin/sh",
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
   * In a full implementation, this would create an agent session and run the prompt.
   * For now, we log the prompt and model selection and return a placeholder result.
   */
  private async executeAiPromptStep(
    step: AutomationStep,
    stepIndex: number,
    _timeoutMs: number,
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

    const model = step.modelProvider && step.modelId
      ? `${step.modelProvider}/${step.modelId}`
      : "default";
    log.log(`    AI prompt step "${step.name}" using model: ${model}`);
    log.log(`    Prompt: ${step.prompt.slice(0, 100)}${step.prompt.length > 100 ? "…" : ""}`);

    // TODO: Integrate with actual agent session for AI prompt execution
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex,
      success: true,
      output: `[AI prompt step — model: ${model}]\nPrompt: ${step.prompt}\n\n(AI execution not yet implemented — prompt recorded for future integration)`,
      startedAt,
      completedAt: new Date().toISOString(),
    };
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

import { exec } from "node:child_process";

import {
  resolveExecutionSettingsModel,
  runScheduledEvalBatch,
  resolveTaskEvaluationSettings,
  isEvalsExperimentalEnabled,
  type TaskStore,
  type AutomationStore,
  type ScheduledTask,
  type AutomationRunResult,
  type AutomationStep,
  type AutomationStepResult,
  type Column,
  type TaskCreateInput,
  type TaskDetail,
} from "@fusion/core";
import { createLogger } from "./logger.js";
import { defaultShell } from "./shell-utils.js";
import { createFnAgent, promptWithFallback } from "./pi.js";
import { HybridEvaluatorService } from "./evaluator.js";
import { buildSessionSkillContextSync } from "./session-skill-context.js";
import { resolveMcpServersForStore } from "./mcp-resolution.js";

const log = createLogger("cron-runner");

function execCommand(command: string, options: Parameters<typeof exec>[1]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      const stdoutText = typeof stdout === "string" ? stdout : String(stdout ?? "");
      const stderrText = typeof stderr === "string" ? stderr : String(stderr ?? "");
      if (error) {
        const errWithOutput = error as Error & { stdout?: string; stderr?: string };
        errWithOutput.stdout = stdoutText;
        errWithOutput.stderr = stderrText;
        reject(errWithOutput);
        return;
      }
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

/**
 * Recognize commands that the auto-backup feature schedules — specifically
 * the `backup --create` form that the engine itself writes via
 * `syncBackupAutomation`. Other backup subcommands (`--list`, `--cleanup`,
 * `--restore <file>`) are intentionally NOT intercepted because the
 * in-process replacement only performs a create+cleanup; intercepting them
 * would silently execute the wrong operation.
 *
 * The matcher tokenizes the command so it can:
 *   - accept any of the canonical invocations (`fn`, `fusion`,
 *     `runfusion`/`runfusion.ai`, `@runfusion/fusion`), with or without an
 *     `npx` prefix and any combination of npx flags (e.g. `-y`, `--yes`,
 *     `-p <pkg>`), so `npx -y runfusion.ai backup --create` is covered;
 *   - reject commands carrying shell continuations after `--create`
 *     (`&&`, `||`, `|`, `;`, `>`, `<`, backticks, `$()`, etc.) — these
 *     embed user-authored side effects that the in-process path cannot
 *     replicate, so we let them shell out to keep the side effects intact.
 *
 * Commands that shell out instead reach whatever fusion binary is on
 * PATH, which may be older than the running process and still carry the
 * pluginStore-rootDir bug that creates a stray `.fusion/.fusion/`
 * directory. Intercepting the canonical `--create` form keeps the
 * auto-backup self-contained inside the running engine.
 */
const FUSION_BINARY_TOKENS = new Set([
  "fn",
  "fusion",
  "runfusion",
  "runfusion.ai",
  "@runfusion/fusion",
]);

/**
 * Characters that introduce shell continuations, redirections, or
 * substitutions. Their presence anywhere in the command means the
 * scheduler author wired in additional side effects we cannot honour
 * by simply running the in-process backup, so we decline interception.
 */
const SHELL_METACHARACTERS_REGEX = /[&|;<>`$()]/;

export function isInProcessBackupCommand(command: string | undefined): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Refuse any command that embeds a shell continuation / redirection /
  // substitution. These tokens carry intent we cannot mirror in-process.
  if (SHELL_METACHARACTERS_REGEX.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/).map((tok) => tok.toLowerCase());
  let cursor = 0;

  // Optional `npx` prefix, with any number of npx flags (e.g. `-y`,
  // `--yes`, `-p <pkg>`, `--package=<pkg>`). Stop consuming once we hit
  // the package name token.
  if (tokens[cursor] === "npx") {
    cursor += 1;
    while (cursor < tokens.length) {
      const tok = tokens[cursor];
      if (tok === undefined || !tok.startsWith("-")) break;
      // `-p <pkg>` consumes the next token as a value; same for the
      // rare `--package <pkg>` form. The `--package=<pkg>` and `-y`
      // forms don't take a separate argument.
      const takesValue = (tok === "-p" || tok === "--package")
        && cursor + 1 < tokens.length
        && tokens[cursor + 1] !== undefined
        && !tokens[cursor + 1]!.startsWith("-");
      cursor += takesValue ? 2 : 1;
    }
  }

  // Required: a fusion binary token.
  const binary = tokens[cursor];
  if (!binary || !FUSION_BINARY_TOKENS.has(binary)) return false;
  cursor += 1;

  // Required: literal `backup` then `--create`.
  if (tokens[cursor] !== "backup") return false;
  cursor += 1;
  if (tokens[cursor] !== "--create") return false;
  cursor += 1;

  // Anything left over must look like additional `--flag` style options.
  // Reject bare argument tokens — they suggest a different subcommand or
  // user-authored payload we should not silently swallow.
  for (; cursor < tokens.length; cursor += 1) {
    const tok = tokens[cursor];
    if (!tok) continue;
    if (!tok.startsWith("-")) return false;
  }

  return true;
}

export function isInProcessMemoryBackupCommand(command: string | undefined): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (SHELL_METACHARACTERS_REGEX.test(trimmed)) return false;

  const tokens = trimmed.split(/\s+/).map((tok) => tok.toLowerCase());
  let cursor = 0;

  if (tokens[cursor] === "npx") {
    cursor += 1;
    while (cursor < tokens.length) {
      const tok = tokens[cursor];
      if (tok === undefined || !tok.startsWith("-")) break;
      const takesValue = (tok === "-p" || tok === "--package")
        && cursor + 1 < tokens.length
        && tokens[cursor + 1] !== undefined
        && !tokens[cursor + 1]!.startsWith("-");
      cursor += takesValue ? 2 : 1;
    }
  }

  const binary = tokens[cursor];
  if (!binary || !FUSION_BINARY_TOKENS.has(binary)) return false;
  cursor += 1;

  if (tokens[cursor] !== "memory-backup") return false;
  cursor += 1;
  if (tokens[cursor] !== "--create") return false;
  cursor += 1;

  for (; cursor < tokens.length; cursor += 1) {
    const tok = tokens[cursor];
    if (!tok) continue;
    if (!tok.startsWith("-")) return false;
  }

  return true;
}

export function isInProcessScheduledEvalCommand(command: string | undefined): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  if (!trimmed || SHELL_METACHARACTERS_REGEX.test(trimmed)) return false;
  const tokens = trimmed.split(/\s+/).map((tok) => tok.toLowerCase());
  return tokens.length >= 3
    && FUSION_BINARY_TOKENS.has(tokens[0] ?? "")
    && tokens[1] === "eval"
    && tokens[2] === "--scheduled-batch"
    && tokens.slice(3).every((tok) => tok.startsWith("-"));
}

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
export type AiPromptLiveCallbacks = {
  onText?: (delta: string) => void;
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
};

export type AiPromptExecutor = (
  prompt: string,
  modelProvider?: string,
  modelId?: string,
  allowedTools?: string[],
  liveCallbacks?: AiPromptLiveCallbacks,
) => Promise<string>;

export interface CronRunnerOptions {
  /** Project working directory used for in-process evaluator sessions */
  workingDirectory?: string;
  /** Project id for scheduled eval batch persistence */
  projectId?: string;
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

        // Re-check pause on each schedule (may have changed mid-loop)
        const currentSettings = await this.store.getSettings();
        if (currentSettings.globalPause || currentSettings.enginePaused) {
          log.log("Pause detected mid-tick — stopping schedule execution");
          break;
        }

        if (!schedule.nextRunAt) {
          log.warn(`Skipping ${schedule.name} (${schedule.id}) — missing nextRunAt for due claim`);
          continue;
        }

        /*
         * FNXC:Automations 2026-06-27-00:00:
         * Cron execution must claim the due window in SQLite before running so two runner instances, overlapping project/all pollers, or separate engine processes cannot execute the same still-due row. The in-memory inFlight guard remains useful within one process but is not the cross-process authority.
         */
        const claimed = await this.automationStore.claimDueSchedule(schedule.id, schedule.nextRunAt);
        if (!claimed) {
          log.log(`Skipping ${schedule.name} (${schedule.id}) — claim lost to another poller`);
          continue;
        }

        log.log(`Executing ${schedule.name} (${schedule.id}) [scope: ${scheduleScope}]`);
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

    // Intercept the auto-backup command: shelling out to `npx runfusion.ai`
    // (or `fn backup`) launches whichever globally-installed fusion binary is
    // on PATH, which may be older than the running process and re-introduce
    // bugs we have already patched here. Running the backup in-process via
    // the engine's already-open TaskStore is also faster (no node startup,
    // no engine initialization) and uses identical logic.
    if (isInProcessBackupCommand(schedule.command)) {
      return this.executeBackupInProcess(schedule, startedAt);
    }

    if (isInProcessMemoryBackupCommand(schedule.command)) {
      return this.executeMemoryBackupInProcess(schedule, startedAt);
    }

    if (isInProcessScheduledEvalCommand(schedule.command)) {
      return this.executeScheduledEvalInProcess(schedule, startedAt);
    }

    try {
      const timeoutMs = schedule.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const { stdout, stderr } = await execCommand(schedule.command, {
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
   * Run an auto-backup schedule in-process via the engine's open TaskStore,
   * bypassing the shell-out that would otherwise invoke an outdated fusion
   * binary on PATH. See `isInProcessBackupCommand` for the matching contract.
   */
  private async executeBackupInProcess(
    schedule: ScheduledTask,
    startedAt: string,
  ): Promise<AutomationRunResult> {
    const action = await this.runBackupActionInProcess();
    if (action.success) {
      log.log(`✓ ${schedule.name} completed in-process`);
    } else {
      log.warn(`✗ ${schedule.name} in-process backup ${action.error ? `threw: ${action.error}` : `reported failure: ${action.output}`}`);
    }
    return {
      success: action.success,
      output: action.output,
      error: action.error,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private async executeMemoryBackupInProcess(
    schedule: ScheduledTask,
    startedAt: string,
  ): Promise<AutomationRunResult> {
    const action = await this.runMemoryBackupActionInProcess();
    if (action.success) {
      log.log(`✓ ${schedule.name} completed in-process`);
    } else {
      log.warn(`✗ ${schedule.name} in-process memory backup ${action.error ? `threw: ${action.error}` : `reported failure: ${action.output}`}`);
    }
    return {
      success: action.success,
      output: action.output,
      error: action.error,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  /**
   * Shared in-process backup execution used by both the legacy-command path
   * and the command-step path. Returns the success/output/error tuple in
   * a shape that callers can wrap into either a run or a step result.
   */
  private async executeScheduledEvalInProcess(
    schedule: ScheduledTask,
    startedAt: string,
  ): Promise<AutomationRunResult> {
    const settings = await this.store.getSettings();
    if (!isEvalsExperimentalEnabled(settings)) {
      return {
        success: false,
        output: "evals-experimental-disabled",
        error: "Evals experimental feature is disabled",
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
    const evalSettings = resolveTaskEvaluationSettings(settings);
    const evaluator = new HybridEvaluatorService({ cwd: this.options.workingDirectory ?? process.cwd(), store: this.store });

    const result = await runScheduledEvalBatch({
      store: this.store,
      projectId: this.options.projectId ?? "default-project",
      startedAt,
      evaluator: async ({ task, run }) => {
        const taskDetail = await this.store.getTask(task.id);
        if (!taskDetail) {
          throw new Error(`Task not found for evaluation: ${task.id}`);
        }
        return evaluator.evaluateTask(taskDetail as TaskDetail, { runId: run.id, startedAt: run.startedAt ?? startedAt }, settings, {
          provider: evalSettings.taskEvaluationProvider,
          modelId: evalSettings.taskEvaluationModelId,
        });
      },
    });

    return {
      success: result.status === "completed",
      output: JSON.stringify(result),
      error: result.status === "failed" ? "Scheduled eval batch failed" : undefined,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  private async runBackupActionInProcess(): Promise<{
    success: boolean;
    output: string;
    error: string | undefined;
  }> {
    try {
      const { runBackupCommand } = await import("@fusion/core");
      const fusionDir = this.store.getFusionDir();
      const settings = await this.store.getSettings();
      const result = await runBackupCommand(fusionDir, settings);
      const output = truncateOutput(result.output ?? "", "");
      return {
        success: result.success,
        output,
        error: result.success ? undefined : formatInProcessBackupError(output, fusionDir),
      };
    } catch (err) {
      const message = formatInProcessBackupError(err, this.store.getFusionDir());
      return { success: false, output: "", error: message };
    }
  }

  private async runMemoryBackupActionInProcess(): Promise<{
    success: boolean;
    output: string;
    error: string | undefined;
  }> {
    try {
      const { runMemoryBackupCommand } = await import("@fusion/core");
      const fusionDir = this.store.getFusionDir();
      const settings = await this.store.getSettings();
      const result = await runMemoryBackupCommand(fusionDir, settings);
      return {
        success: result.success,
        output: truncateOutput(result.output ?? "", ""),
        error: result.success ? undefined : result.output,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
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
      return this.executeCreateTaskStep(step, stepIndex, stepStartedAt, schedule.id);
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

    // Step-based automations can also carry the auto-backup command. Mirror
    // the legacy-command interception so step-form schedules don't fall back
    // to spawning a stale `runfusion.ai` binary.
    if (isInProcessBackupCommand(step.command)) {
      const action = await this.runBackupActionInProcess();
      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: action.success,
        output: action.output,
        error: action.error,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    if (isInProcessMemoryBackupCommand(step.command)) {
      const action = await this.runMemoryBackupActionInProcess();
      return {
        stepId: step.id,
        stepName: step.name,
        stepIndex,
        success: action.success,
        output: action.output,
        error: action.error,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    try {
      const { stdout, stderr } = await execCommand(step.command, {
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

    // Resolve model: step override → project execution lane → global execution lane → project default override → global default
    // FNXC:ModelResolution 2026-06-25-12:00: FN-7039 requires scheduled AI-prompt automation steps to use execution-lane settings before default settings because these steps have no task/runtime model context.
    const settings = await this.store.getSettings();
    const defaultModel = resolveExecutionSettingsModel(settings);
    const modelProvider = step.modelProvider?.trim() || defaultModel.provider;
    const modelId = step.modelId?.trim() || defaultModel.modelId;

    const model = modelProvider && modelId
      ? `${modelProvider}/${modelId}`
      : "default";
    log.log(`    AI prompt step "${step.name}" using model: ${model}`);
    log.log(`    Prompt: ${step.prompt.slice(0, 100)}${step.prompt.length > 100 ? "…" : ""}`);

    try {
      // Race between executor and timeout
      const resultPromise = this.aiPromptExecutor(step.prompt, modelProvider, modelId, step.allowedTools);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`AI prompt step timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      });

      const response = await Promise.race([resultPromise, timeoutPromise]);

      const responseText = String(response ?? "");
      const output = responseText.length > MAX_OUTPUT_LENGTH
        ? responseText.slice(0, MAX_OUTPUT_LENGTH) + "\n[output truncated]"
        : responseText;

      log.log(`    ✓ AI prompt step "${step.name}" completed (${responseText.length} chars)`);

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
    scheduleId: string,
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
      source: {
        sourceType: "cron",
        sourceMetadata: { scheduleId, stepId: step.id },
      },
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
  "You may use the coding tools selected for this automation step; follow any tool restrictions exactly.",
  "Execute the prompt precisely and return concise, structured results.",
  "When analyzing code or data, provide actionable summaries.",
  "Structure outputs with clear sections: Summary, Findings, Recommended Actions, and Risks/Unknowns when applicable.",
  "Actionable summaries must include concrete next steps, affected areas, and impact level.",
  "If errors occur (missing files, command failures, ambiguous input), report them clearly with probable cause and what was attempted.",
  "If no notable findings exist, state that explicitly and keep output brief rather than inventing issues.",
].join("\n");

/**
 * Create an AiPromptExecutor that uses createFnAgent for real AI execution.
 *
 * Each call creates a fresh agent session, runs the prompt, collects the
 * text response, and disposes the session.
 *
 * @param cwd — Project root directory (file access scope for the agent).
 * @param store — Optional task store used to resolve configured MCP servers for scheduled agent work.
 * @returns An AiPromptExecutor function suitable for CronRunnerOptions.
 */
export async function createAiPromptExecutor(cwd: string, store?: TaskStore): Promise<AiPromptExecutor> {
  const disposeLog = createLogger("cron-runner");

  return async (prompt: string, modelProvider?: string, modelId?: string, allowedTools?: string[], liveCallbacks?: AiPromptLiveCallbacks): Promise<string> => {
    let responseText = "";
    const skillContext = buildSessionSkillContextSync(null, "executor", cwd, undefined);

    /*
    FNXC:CronAutomationSkills 2026-06-17-19:33:
    Scheduled AI automation is an agent-acting lane; even without a plugin runner in this seam, it must request executor fallback skills and tolerate the degraded no-plugin path.

    FNXC:McpConfig 2026-06-26-00:00:
    Scheduled AI automations are coding-agent work surfaces. ProjectEngine passes the TaskStore so configured MCP servers are forwarded; lightweight in-process runtime callers may omit the store and keep the pre-existing empty-MCP behavior.
    */
    const mcpServers = store ? (await resolveMcpServersForStore(store)).servers : undefined;
    const { session } = await createFnAgent({
      cwd,
      systemPrompt: AI_AUTOMATION_SYSTEM_PROMPT,
      tools: "coding",
      toolsAllowlist: allowedTools,
      ...(skillContext.skillSelectionContext ? { skillSelection: skillContext.skillSelectionContext } : {}),
      defaultProvider: modelProvider,
      defaultModelId: modelId,
      mcpServers,
      onText: (delta: string) => {
        responseText += delta;
        liveCallbacks?.onText?.(delta);
      },
      onToolStart: liveCallbacks?.onToolStart,
      onToolEnd: liveCallbacks?.onToolEnd,
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

/*
FNXC:DatabaseBackup 2026-06-26-12:00:
Cron-runner in-process backups feed automation run history and step errors. Normalize empty thrown values and empty command output before they become operator-visible Database Backup failures.

FNXC:DatabaseBackup 2026-07-04-00:00:
FN-7537: exported (was module-private) so the dashboard's manual automation/schedule run path
(packages/dashboard/src/routes.ts executeSingleCommand) can format in-process backup failures with the
same message shape cron/routine-runner already use, instead of diverging on manual runs.
*/
export function formatInProcessBackupError(err: unknown, fusionDir: string): string {
  const message = err instanceof Error ? err.message.trim() : String(err ?? "").trim();
  const cause = message || "unknown error";
  if (cause.includes("project DB") || cause.includes("central DB")) {
    return cause;
  }
  return `project DB run backup command failed; source: ${fusionDir}/fusion.db; cause: ${cause}`;
}

/** Combine and truncate stdout/stderr to stay within storage limits. */
function truncateOutput(stdout: string | null | undefined, stderr: string | null | undefined): string {
  const out = stdout ?? "";
  const err = stderr ?? "";
  let combined = out;
  if (err) {
    // Add separator only if there's also stdout content
    combined += out ? "\n--- stderr ---\n" : "";
    combined += err;
  }
  if (combined.length > MAX_OUTPUT_LENGTH) {
    combined = combined.slice(0, MAX_OUTPUT_LENGTH) + "\n[output truncated]";
  }
  return combined;
}

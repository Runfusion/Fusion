import type { TaskStore } from "@fusion/core";
import { AUTOMATION_SELECTABLE_TOOLS, THINKING_LEVELS, resolveExecutionSettingsModel } from "@fusion/core";
import { createFnAgent as engineCreateFnAgentForRefine, promptWithFallback as enginePromptWithFallback, resolveMcpServersForStore, isInProcessBackupCommand, isInProcessMemoryBackupCommand, formatInProcessBackupError } from "@fusion/engine";
import { ApiError } from "../api-error.js";
import { AUTOMATION_MAX_BUFFER, AUTOMATION_MAX_OUTPUT, DEFAULT_AUTOMATION_TIMEOUT_MS, MANUAL_RUN_AI_SYSTEM_PROMPT, type AutomationLiveRunCallbacks } from "./automation-live-run.js";

/**
 * Validate an array of automation steps.
 * Returns an error string if invalid, or null if valid.
 */
export function validateAutomationSteps(steps: unknown[]): string | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as Record<string, unknown>;
    if (!step.id || typeof step.id !== "string") {
      return `Step ${i + 1}: id is required`;
    }
    if (!step.type || (step.type !== "command" && step.type !== "ai-prompt" && step.type !== "create-task")) {
      return `Step ${i + 1}: type must be "command", "ai-prompt", or "create-task"`;
    }
    if (!step.name || typeof step.name !== "string" || !step.name.trim()) {
      return `Step ${i + 1}: name is required`;
    }
    if (step.type === "command") {
      if (!step.command || typeof step.command !== "string" || !step.command.trim()) {
        return `Step ${i + 1}: command is required for command steps`;
      }
    }
    if (step.type === "ai-prompt") {
      if (!step.prompt || typeof step.prompt !== "string" || !step.prompt.trim()) {
        return `Step ${i + 1}: prompt is required for ai-prompt steps`;
      }
      if (step.allowedTools !== undefined) {
        if (!Array.isArray(step.allowedTools)) {
          return `Step ${i + 1}: allowedTools must be an array when provided`;
        }
        const selectableTools = new Set(AUTOMATION_SELECTABLE_TOOLS.map((tool) => tool.toLowerCase()));
        for (const tool of step.allowedTools) {
          if (typeof tool !== "string" || !selectableTools.has(tool.trim().toLowerCase())) {
            return `Step ${i + 1}: allowedTools contains unknown tool "${String(tool)}"`;
          }
        }
      }
    }
    if (step.type === "create-task") {
      if (!step.taskDescription || typeof step.taskDescription !== "string" || !step.taskDescription.trim()) {
        return `Step ${i + 1}: taskDescription is required for create-task steps`;
      }
    }
    // Validate model fields are both present or both absent
    const hasProvider = step.modelProvider && typeof step.modelProvider === "string";
    const hasModelId = step.modelId && typeof step.modelId === "string";
    if ((hasProvider && !hasModelId) || (!hasProvider && hasModelId)) {
      return `Step ${i + 1}: modelProvider and modelId must both be present or both absent`;
    }
    /*
    FNXC:Automations 2026-07-12-19:14:
    Schedule and routine AI-capable steps can persist an optional reasoning-effort override. Validate it against the central THINKING_LEVELS set so routes accept omission/inherit plus known levels and reject drift before JSON step storage.
    */
    if (step.thinkingLevel !== undefined) {
      if (typeof step.thinkingLevel !== "string" || !THINKING_LEVELS.includes(step.thinkingLevel as (typeof THINKING_LEVELS)[number])) {
        return `Step ${i + 1}: thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`;
      }
    }
  }
  return null;
}

/**
 * Execute a single shell command (used by manual run endpoint).
 *
 * FNXC:DatabaseBackup 2026-07-04-00:00:
 * FN-7537: the dashboard's manual automation/schedule run path (legacy single-command schedules and
 * `command`-type steps in `executeScheduleSteps`) previously always shelled the command out via `exec()`,
 * unlike the scheduler (`CronRunner`) and routine runner (`RoutineRunner.executeCommand`), which both
 * intercept the auto-backup command and run it in-process via the engine's already-open `TaskStore`. On
 * hosts without a global `fn`/`runfusion.ai` binary on PATH this made a manual "Database Backup" run fail
 * while the identical cron-triggered run succeeded. Mirror the cron/routine-runner interception here so a
 * manual run behaves identically: when a `taskStore` is available and the command matches
 * `isInProcessBackupCommand`/`isInProcessMemoryBackupCommand`, run the backup in-process instead of
 * shelling out, using the same `formatInProcessBackupError` message shape on failure (parity with FN-7095).
 */
export async function executeSingleCommand(
  command: string,
  timeoutMs: number | undefined,
  startedAt: string,
  taskStore?: TaskStore,
): Promise<import("@fusion/core").AutomationRunResult> {
  if (taskStore && isInProcessBackupCommand(command)) {
    const fusionDir = taskStore.getFusionDir();
    try {
      const { runBackupCommand, resolveGlobalBackupRoot } = await import("@fusion/core");
      const settings = await taskStore.getSettings();
      const result = await runBackupCommand(resolveGlobalBackupRoot(taskStore), settings);
      const output = truncateAutomationOutput(result.output ?? "", "");
      return {
        success: result.success,
        output,
        error: result.success ? undefined : formatInProcessBackupError(output, fusionDir),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: formatInProcessBackupError(err, fusionDir),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  if (taskStore && isInProcessMemoryBackupCommand(command)) {
    const fusionDir = taskStore.getFusionDir();
    try {
      const { runMemoryBackupCommand } = await import("@fusion/core");
      const settings = await taskStore.getSettings();
      const result = await runMemoryBackupCommand(fusionDir, settings);
      return {
        success: result.success,
        output: truncateAutomationOutput(result.output ?? "", ""),
        error: result.success ? undefined : result.output,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsyncFn = promisify(exec);

  const isWindows = process.platform === "win32";

  try {
    const { stdout, stderr } = await execAsyncFn(command, {
      timeout: timeoutMs ?? DEFAULT_AUTOMATION_TIMEOUT_MS,
      maxBuffer: AUTOMATION_MAX_BUFFER,
      shell: isWindows ? "cmd.exe" : "/bin/sh",
    });

    return {
      success: true,
      output: truncateAutomationOutput(stdout, stderr),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }
    const execErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean };

    return {
      success: false,
      output: truncateAutomationOutput(execErr.stdout ?? "", execErr.stderr ?? ""),
      error: execErr.killed
        ? `Command timed out after ${(timeoutMs ?? DEFAULT_AUTOMATION_TIMEOUT_MS) / 1000}s`
        : (err instanceof Error ? err.message : String(err)),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

function truncateAutomationOutput(stdout: string, stderr: string): string {
  let output = stdout;
  if (stderr) output += stdout ? `\n--- stderr ---\n${stderr}` : stderr;
  return output.length > AUTOMATION_MAX_OUTPUT ? `${output.slice(0, AUTOMATION_MAX_OUTPUT)}\n[output truncated]` : output;
}

export async function resolveManualAiPromptMcpServers(taskStore: TaskStore) {
  return (await resolveMcpServersForStore(taskStore)).servers;
}

async function executeAiPromptStep(
  step: import("@fusion/core").AutomationStep,
  timeoutMs: number,
  startedAt: string,
  taskStore: TaskStore,
  liveCallbacks?: AutomationLiveRunCallbacks,
  getCreateFnAgent: () => typeof import("@fusion/engine").createFnAgent | undefined = () => engineCreateFnAgentForRefine,
): Promise<import("@fusion/core").AutomationStepResult> {
  if (!step.prompt?.trim()) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: "AI prompt step has no prompt specified",
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  const createFnAgent = getCreateFnAgent();
  const promptWithFallback = enginePromptWithFallback;
  if (!createFnAgent) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: "AI agent not available",
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  const settings = await taskStore.getSettings();
  // Resolve model: step override → project execution lane → global execution lane → project default override → global default
  // FNXC:ModelResolution 2026-06-25-12:00: FN-7039 requires manual AI-prompt workflow runs to use execution-lane settings before default settings because these runs have no task/runtime model context.
  const defaultModel = resolveExecutionSettingsModel(settings);
  const modelProvider = step.modelProvider?.trim() || defaultModel.provider;
  const modelId = step.modelId?.trim() || defaultModel.modelId;
  let responseText = "";
  /*
   * FNXC:McpConfig 2026-06-26-00:00:
   * Manual AI-prompt workflow runs are operator-triggered coding-agent sessions, so they must receive the task-store resolved MCP set just like task executor lanes. Do not log resolved MCP payloads because env/header values may contain materialized secrets.
   *
   * FNXC:Automations 2026-07-12-20:30:
   * Manual/inline automation AI runs bypass CronRunner's executor seam, so they must pass the persisted step thinking level directly as createFnAgent.defaultThinkingLevel. Undefined or blank values preserve inherited defaults.
   */
  const mcpServers = await resolveManualAiPromptMcpServers(taskStore);
  const defaultThinkingLevel = step.thinkingLevel?.trim() || undefined;

  const { session } = await createFnAgent({
    cwd: process.cwd(),
    systemPrompt: MANUAL_RUN_AI_SYSTEM_PROMPT,
    tools: "coding",
    toolsAllowlist: step.allowedTools,
    defaultProvider: modelProvider,
    defaultModelId: modelId,
    defaultThinkingLevel,
    mcpServers,
    onText: (delta: string) => {
      responseText += delta;
      liveCallbacks?.onText?.(delta);
    },
    onToolStart: liveCallbacks?.onToolStart,
    onToolEnd: liveCallbacks?.onToolEnd,
  });

  try {
    const promptPromise = promptWithFallback(session, step.prompt);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`AI prompt step timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });

    await Promise.race([promptPromise, timeoutPromise]);

    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: true,
      output: responseText.length > AUTOMATION_MAX_OUTPUT
        ? responseText.slice(0, AUTOMATION_MAX_OUTPUT) + "\n[output truncated]"
        : responseText,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } finally {
    try {
      session.dispose();
    } catch {
      // best-effort cleanup
    }
  }
}

async function executeCreateTaskStep(
  step: import("@fusion/core").AutomationStep,
  startedAt: string,
  taskStore: TaskStore,
): Promise<import("@fusion/core").AutomationStepResult> {
  if (!step.taskDescription?.trim()) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: "Create-task step has no task description specified",
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  try {
    /*
    FNXC:Automations 2026-07-12-20:30:
    Manual/inline create-task automation runs map the persisted step thinking level onto the created task so manual execution matches scheduled and routine behavior.
    */
    const task = await taskStore.createTask({
      title: step.taskTitle?.trim() || undefined,
      description: step.taskDescription.trim(),
      column: (step.taskColumn as import("@fusion/core").Column) || "triage",
      modelProvider: step.modelProvider?.trim() || undefined,
      modelId: step.modelId?.trim() || undefined,
      thinkingLevel: (step.thinkingLevel?.trim() || undefined) as import("@fusion/core").TaskCreateInput["thinkingLevel"],
      source: {
        sourceType: "workflow_step",
        sourceMetadata: { stepId: step.id },
      },
    });
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: true,
      output: `Created task ${task.id}: ${task.title || task.description.slice(0, 80)}`,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (err: unknown) {
    return {
      stepId: step.id,
      stepName: step.name,
      stepIndex: 0,
      success: false,
      output: "",
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * Execute all steps in a multi-step schedule (used by manual run endpoint).
 */
export async function executeScheduleSteps(
  schedule: import("@fusion/core").ScheduledTask,
  startedAt: string,
  taskStore: TaskStore,
  liveCallbacks?: AutomationLiveRunCallbacks,
  getCreateFnAgent: () => typeof import("@fusion/engine").createFnAgent | undefined = () => engineCreateFnAgentForRefine,
): Promise<import("@fusion/core").AutomationRunResult> {
  const steps = schedule.steps!;
  const stepResults: import("@fusion/core").AutomationStepResult[] = [];
  let overallSuccess = true;
  let stoppedEarly = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepStartedAt = new Date().toISOString();
    const timeoutMs = step.timeoutMs ?? schedule.timeoutMs ?? DEFAULT_AUTOMATION_TIMEOUT_MS;

    let stepResult: import("@fusion/core").AutomationStepResult;
    liveCallbacks?.onStep?.({ stepIndex: i, stepId: step.id, stepName: step.name, stepType: step.type, status: "started" });

    if (step.type === "command") {
      const cmdResult = await executeSingleCommand(step.command ?? "", timeoutMs, stepStartedAt, taskStore);
      stepResult = {
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        success: cmdResult.success,
        output: cmdResult.output,
        error: cmdResult.error,
        startedAt: stepStartedAt,
        completedAt: cmdResult.completedAt,
      };
    } else if (step.type === "ai-prompt") {
      stepResult = await executeAiPromptStep(step, timeoutMs, stepStartedAt, taskStore, liveCallbacks, getCreateFnAgent);
      stepResult.stepIndex = i;
    } else if (step.type === "create-task") {
      stepResult = await executeCreateTaskStep(step, stepStartedAt, taskStore);
      stepResult.stepIndex = i;
    } else {
      stepResult = {
        stepId: step.id,
        stepName: step.name,
        stepIndex: i,
        success: false,
        output: "",
        error: `Unknown step type: "${step.type}"`,
        startedAt: stepStartedAt,
        completedAt: new Date().toISOString(),
      };
    }

    stepResults.push(stepResult);
    liveCallbacks?.onStep?.({ stepIndex: i, stepId: step.id, stepName: step.name, stepType: step.type, status: "completed", success: stepResult.success, error: stepResult.error });
    if (step.type !== "ai-prompt" && stepResult.output) {
      liveCallbacks?.onText?.(stepResult.output);
    }

    if (!stepResult.success) {
      overallSuccess = false;
      if (!step.continueOnFailure) {
        stoppedEarly = true;
        break;
      }
    }
  }

  // Aggregate output
  const outputParts: string[] = [];
  for (const sr of stepResults) {
    outputParts.push(`=== Step ${sr.stepIndex + 1}: ${sr.stepName} (${sr.success ? "success" : "FAILED"}) ===`);
    if (sr.output) outputParts.push(sr.output);
    if (sr.error) outputParts.push(`Error: ${sr.error}`);
  }
  let output = outputParts.join("\n");
  if (output.length > AUTOMATION_MAX_OUTPUT) {
    output = output.slice(0, AUTOMATION_MAX_OUTPUT) + "\n[output truncated]";
  }

  const failedSteps = stepResults.filter((sr) => !sr.success);
  const error = failedSteps.length > 0
    ? `${failedSteps.length} step(s) failed: ${failedSteps.map((s) => s.stepName).join(", ")}${stoppedEarly ? " (execution stopped)" : ""}`
    : undefined;

  return {
    success: overallSuccess,
    output,
    error,
    startedAt,
    completedAt: new Date().toISOString(),
    stepResults,
  };
}

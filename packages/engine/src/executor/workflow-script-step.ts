/**
 * FNXC:CodeOrganization 2026-08-03-17:05:
 * executeScriptWorkflowStep peeled from TaskExecutor (U4 Slice B / step-session edge).
 * Resolves settings.scripts[scriptName] and runs via runConfiguredCommand in the task worktree.
 */
import type { RunCommandResult, Settings, Task, TaskStore, WorkflowStep } from "@fusion/core";
import { executorLog } from "../logger.js";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import {
  configuredCommandErrorMessage,
  truncateWorkflowScriptOutput,
} from "./configured-command.js";
import { createConfiguredCommandAbortError } from "./task-predicates.js";

export type RunConfiguredCommandFn = (
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
  auditor?: RunAuditor,
  signal?: AbortSignal,
) => Promise<RunCommandResult>;

export type ScriptWorkflowStepDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  registerConfiguredCommandController: (taskId: string, controller: AbortController) => void;
  unregisterConfiguredCommandController: (taskId: string, controller: AbortController) => void;
  runConfiguredCommand: RunConfiguredCommandFn;
};

export async function executeScriptWorkflowStep(
  deps: ScriptWorkflowStepDeps,
  task: Task,
  workflowStep: WorkflowStep,
  worktreePath: string,
  settings: Settings,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const scriptName = workflowStep.scriptName!.trim();
  const scriptCommand = settings.scripts?.[scriptName];

  if (!scriptCommand) {
    const available = settings.scripts ? Object.keys(settings.scripts).join(", ") : "none";
    const msg = `Script '${scriptName}' not found in project settings. Available scripts: ${available}`;
    await deps.store.logEntry(task.id, msg);
    return { success: false, error: msg };
  }

  executorLog.log(`${task.id}: workflow step '${workflowStep.name}' executing script '${scriptName}': ${scriptCommand}`);
  await deps.store.logEntry(task.id, `Workflow step '${workflowStep.name}' executing script '${scriptName}': ${scriptCommand}`);

  const scriptAbortController = new AbortController();
  deps.registerConfiguredCommandController(task.id, scriptAbortController);
  try {
    const scriptResult = await deps.runConfiguredCommand(
      scriptCommand,
      worktreePath,
      120_000,
      extraEnv,
      createRunAuditor(deps.store, {
        runId: deps.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("exec-script", task.id),
        agentId: deps.getRunContextFor(task.id)?.agentId ?? (task.assignedAgentId ?? "executor"),
        taskId: task.id,
        phase: "execute",
      }),
      scriptAbortController.signal,
    );
    if (scriptAbortController.signal.aborted) {
      throw createConfiguredCommandAbortError(task.id, scriptCommand);
    }
    if (scriptResult.spawnError || scriptResult.timedOut || scriptResult.exitCode !== 0) {
      return { success: false, error: configuredCommandErrorMessage(scriptResult) };
    }
    return { success: true, output: `Script '${scriptName}' completed successfully` };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    const execError = err instanceof Error ? err : new Error(String(err));
    const stderr = "stderr" in execError && typeof (execError as { stderr?: unknown }).stderr === "string"
      ? (execError as { stderr: string }).stderr.trim()
      : "";
    const stdout = "stdout" in execError && typeof (execError as { stdout?: unknown }).stdout === "string"
      ? (execError as { stdout: string }).stdout.trim()
      : "";
    const exitCode = "code" in execError
      ? (execError as { code?: unknown }).code
      : ("status" in execError ? (execError as { status?: unknown }).status : undefined);
    const parts: string[] = [];
    if (exitCode !== undefined) parts.push(`Exit code: ${exitCode}`);
    if (stdout) parts.push(`stdout: ${truncateWorkflowScriptOutput(stdout)}`);
    if (stderr) parts.push(`stderr: ${truncateWorkflowScriptOutput(stderr)}`);
    if (!parts.length) parts.push(execError.message || "Unknown error");
    return { success: false, error: parts.join("\n") };
  } finally {
    deps.unregisterConfiguredCommandController(task.id, scriptAbortController);
  }
}

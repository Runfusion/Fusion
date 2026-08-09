/**
 * FNXC:CodeOrganization 2026-08-03-12:10:
 * runRawCliCommand peeled from TaskExecutor (U4).
 * Execute an approved CLI command in a task worktree for a workflow node.
 */
import type { TaskDetail, TaskStore, RunCommandResult } from "@fusion/core";
import { executorLog } from "../logger.js";
import { createRunAuditor, generateSyntheticRunId, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import { configuredCommandErrorMessage } from "./configured-command.js";
import { createConfiguredCommandAbortError } from "./task-predicates.js";

export type RunRawCliCommandDeps = {
  store: TaskStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  registerConfiguredCommandController: (taskId: string, controller: AbortController) => void;
  unregisterConfiguredCommandController: (taskId: string, controller: AbortController) => void;
  runConfiguredCommand: (
    command: string,
    cwd: string,
    timeoutMs: number,
    extraEnv?: NodeJS.ProcessEnv,
    auditor?: RunAuditor,
    signal?: AbortSignal,
  ) => Promise<RunCommandResult>;
};

export async function runRawCliCommand(
  deps: RunRawCliCommandDeps,
  task: TaskDetail,
  label: string,
  command: string,
  worktreePath: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<{ success: boolean; output?: string; error?: string }> {
  executorLog.log(`${task.id}: workflow node '${label}' executing approved CLI command: ${command}`);
  await deps.store.logEntry(task.id, `Workflow node '${label}' executing CLI command: ${command}`, undefined, deps.getRunContextFor(task.id));
  const abort = new AbortController();
  deps.registerConfiguredCommandController(task.id, abort);
  try {
    const result = await deps.runConfiguredCommand(
      command,
      worktreePath,
      120_000,
      extraEnv,
      createRunAuditor(deps.store, {
        runId: deps.getRunContextFor(task.id)?.runId ?? generateSyntheticRunId("exec-cli", task.id),
        agentId: deps.getRunContextFor(task.id)?.agentId ?? (task.assignedAgentId ?? "executor"),
        taskId: task.id,
        phase: "execute",
      }),
      abort.signal,
    );
    if (abort.signal.aborted) throw createConfiguredCommandAbortError(task.id, command);
    if (result.spawnError || result.timedOut || result.exitCode !== 0) {
      return { success: false, error: configuredCommandErrorMessage(result) };
    }
    return { success: true, output: `CLI command completed successfully` };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    deps.unregisterConfiguredCommandController(task.id, abort);
  }
}

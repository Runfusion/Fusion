/**
 * FNXC:CodeOrganization 2026-08-03-12:10:
 * ensureGraphCustomNodeWorktree peeled from TaskExecutor (U4).
 *
 * FNXC:WorkflowExecution 2026-06-29-08:21:
 * Custom graph nodes can be the first executable node in a workflow. If such a node is coding/script-capable, acquire the same task worktree the legacy executor would have acquired instead of failing with `no-worktree-for-write-node`.
 *
 * FNXC:EngineDiagnostics 2026-08-03-05:54:
 * Per-node worktree acquisition is expected graph plumbing once the task has a worktree.
 */
import type { Settings, Task, TaskDetail, TaskStore } from "@fusion/core";
import { loadWorkspaceConfig, type RunCommandResult } from "@fusion/core";
import { executorLog } from "../logger.js";
import { generateSyntheticRunId, createRunAuditor, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { captureBaseCommitSha } from "./worktree-git-refs.js";
import { createConfiguredCommandAbortError } from "./task-predicates.js";
import type { WorktreePool } from "../worktree/worktree-pool.js";

export type EnsureGraphCustomNodeWorktreeDeps = {
  store: TaskStore;
  rootDir: string;
  getWorkspaceConfig: () => Awaited<ReturnType<typeof loadWorkspaceConfig>> | undefined;
  setWorkspaceConfig: (config: Awaited<ReturnType<typeof loadWorkspaceConfig>>) => void;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  pool?: WorktreePool;
  secretsStore?: Parameters<typeof acquireTaskWorktree>[0]["secretsStore"];
  createWorktree: (
    branch: string,
    path: string,
    taskId: string,
    startPoint?: string,
    allowSiblingBranchRename?: boolean,
  ) => Promise<{ path: string; branch: string }>;
  runConfiguredCommand: (
    command: string,
    cwd: string,
    timeoutMs: number,
    extraEnv?: NodeJS.ProcessEnv,
    auditor?: RunAuditor,
    signal?: AbortSignal,
  ) => Promise<RunCommandResult>;
  addActiveWorktree: (taskId: string, path: string) => void;
  onStart?: (task: Task, worktreePath: string) => void;
  registerConfiguredCommandController: (taskId: string, controller: AbortController) => void;
  unregisterConfiguredCommandController: (taskId: string, controller: AbortController) => void;
};

export async function ensureGraphCustomNodeWorktree(
  deps: EnsureGraphCustomNodeWorktreeDeps,
  task: TaskDetail,
  settings: Settings,
  nodeId: string,
  refreshStaleBase = false,
): Promise<TaskDetail> {
  let workspaceConfig = deps.getWorkspaceConfig();
  if (workspaceConfig === undefined) {
    workspaceConfig = await loadWorkspaceConfig(deps.rootDir);
    deps.setWorkspaceConfig(workspaceConfig);
  }
  if (workspaceConfig && (workspaceConfig.repos.length ?? 0) > 0) {
    return task;
  }

  const syntheticRunId = generateSyntheticRunId("workflow-node-worktree", task.id);
  const audit = createRunAuditor(deps.store, {
    runId: syntheticRunId,
    agentId: task.assignedAgentId ?? "executor",
    taskId: task.id,
    phase: "execute",
  });
  const commandAbortController = new AbortController();
  deps.registerConfiguredCommandController(task.id, commandAbortController);
  try {
    await deps.store.logEntry(
      task.id,
      `Workflow node '${nodeId}' requires a task worktree — acquiring worktree before node execution`,
      undefined,
      deps.getRunContextFor(task.id),
    );
    const acquisition = await acquireTaskWorktree({
      task,
      rootDir: deps.rootDir,
      store: deps.store,
      settings,
      pool: deps.pool,
      logger: executorLog,
      audit,
      runContext: deps.getRunContextFor(task.id),
      runInitCommand: true,
      createWorktree: deps.createWorktree,
      runConfiguredCommand: (command, cwd, timeoutMs, env) =>
        deps.runConfiguredCommand(
          command,
          cwd,
          timeoutMs,
          env,
          audit,
          commandAbortController.signal,
        ).then((result) => {
          if (commandAbortController.signal.aborted) {
            throw createConfiguredCommandAbortError(task.id, command);
          }
          return result;
        }),
      taskEnv: process.env,
      secretsStore: deps.secretsStore,
      refreshStaleBase,
    });
    deps.addActiveWorktree(task.id, acquisition.worktreePath);
    if (!acquisition.isResume) {
      await captureBaseCommitSha(deps.store, task, acquisition.worktreePath, audit, { isResume: false });
    }
    deps.onStart?.(task, acquisition.worktreePath);
    executorLog.debug(`${task.id}: workflow node '${nodeId}' acquired worktree at ${acquisition.worktreePath}`);
    return await deps.store.getTask(task.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.store.logEntry(
      task.id,
      `Workflow node '${nodeId}' failed to acquire task worktree: ${message}`,
      undefined,
      deps.getRunContextFor(task.id),
    );
    throw error;
  } finally {
    deps.unregisterConfiguredCommandController(task.id, commandAbortController);
  }
}

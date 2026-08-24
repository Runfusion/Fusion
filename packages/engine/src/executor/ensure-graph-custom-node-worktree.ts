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
import { type RunCommandResult, type WorkspaceConfig } from "@fusion/core";
import { executorLog } from "../logger.js";
import { generateSyntheticRunId, createRunAuditor, type EngineRunContext, type RunAuditor } from "../util/run-audit.js";
import { acquireTaskWorktree, acquireWorkspaceTaskWorktrees } from "../worktree/worktree-acquisition.js";
import { captureBaseCommitSha } from "./worktree-git-refs.js";
import { runContextForTotal } from "./run-context-for.js";
import { createConfiguredCommandAbortError } from "./task-predicates.js";
import type { WorktreePool } from "../worktree/worktree-pool.js";
import { resolveWorkspaceConfigOnce } from "./workspace-config-resolver.js";

export type EnsureGraphCustomNodeWorktreeDeps = {
  store: TaskStore;
  rootDir: string;
  workspaceConfigOwner: object;
  getWorkspaceConfig: () => WorkspaceConfig | null | undefined;
  setWorkspaceConfig: (config: WorkspaceConfig | null) => void;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
  runContextFor: (taskId: string, fallbackAgentId?: string | null) => import("@fusion/core").RunMutationContext;
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
  const workspaceConfig = await resolveWorkspaceConfigOnce(deps);

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
      deps.runContextFor(task.id),
    );

    /*
    FNXC:WorkspaceWorktree 2026-08-22-22:42:
    FN-158 acquires only the planner-confirmed repository scope. Callers reach
    this seam solely for write-capable nodes; read-only planning never creates a
    branch, lease, or worktree before it can declare its scope.
    */
    if (workspaceConfig) {
      if (task.repositoryScope?.state !== "confirmed") {
        throw new Error("Workspace acquisition requires a confirmed ## Repository Scope");
      }
      const workspace = await acquireWorkspaceTaskWorktrees({
        workspaceConfig,
        workspaceRootDir: deps.rootDir,
        repoRelPaths: task.repositoryScope.repositories,
        task,
        store: deps.store,
        settings,
        logger: executorLog,
        secretsStore: deps.secretsStore,
        audit,
        runContext: deps.getRunContextFor(task.id),
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
        addActiveWorktree: deps.addActiveWorktree,
      });
      deps.onStart?.(workspace.task, workspace.taskWorktreeDir);
      executorLog.debug(`${task.id}: workflow node '${nodeId}' using workspace task directory ${workspace.taskWorktreeDir}`);
      return { ...task, ...workspace.task } as TaskDetail;
    }

    const acquisition = await acquireTaskWorktree({
      task,
      rootDir: deps.rootDir,
      store: deps.store,
      settings,
      pool: deps.pool,
      logger: executorLog,
      audit,
      runContext: deps.runContextFor(task.id),
      runInitCommand: true,
      createWorktree: deps.createWorktree,
      createWorktreeBackendKind: "native",
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
      // FNXC:Identity 2026-08-14-05:32: attribute the base-SHA write to the graph node's run,
      // matching every other store write in this function.
      await captureBaseCommitSha(
        deps.store,
        task,
        acquisition.worktreePath,
        audit,
        { isResume: false },
        runContextForTotal(deps.getRunContextFor, task.id),
      );
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
      deps.runContextFor(task.id),
    );
    throw error;
  } finally {
    deps.unregisterConfiguredCommandController(task.id, commandAbortController);
  }
}

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
import type { WorktreePool } from "../worktree/worktree-pool.js";
import { createConfiguredCommandAbortError } from "./task-predicates.js";
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
    /*
    FNXC:WorkspaceWorktree 2026-08-29-06:59:
    Workspace membership is decided once by workspace.json. Planning, read-only gates, and
    implementation all acquire the complete configured set into this task directory; the short
    per-repository lease protects only `git worktree add`, not the task's private checkout lifetime.
    */
    if (workspaceConfig) {
      await deps.store.logEntry(
        task.id,
        `Workflow node '${nodeId}' acquiring workspace checkouts for ${workspaceConfig.repos.length} configured repository(ies)`,
        undefined,
        deps.runContextFor(task.id),
      );
      const workspace = await acquireWorkspaceTaskWorktrees({
        workspaceConfig,
        workspaceRootDir: deps.rootDir,
        task,
        store: deps.store,
        settings,
        logger: executorLog,
        secretsStore: deps.secretsStore,
        audit,
        runContext: deps.runContextFor(task.id),
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
        refreshStaleBase,
      });
      deps.onStart?.(workspace.task, workspace.taskWorktreeDir);
      executorLog.debug(`${task.id}: workflow node '${nodeId}' using workspace task directory ${workspace.taskWorktreeDir}`);
      return { ...task, ...workspace.task } as TaskDetail;
    }

    await deps.store.logEntry(
      task.id,
      `Workflow node '${nodeId}' requires a task worktree — acquiring worktree before node execution`,
      undefined,
      deps.runContextFor(task.id),
    );
    const acquisition = await acquireTaskWorktree({
      task,
      rootDir: deps.rootDir,
      store: deps.store,
      settings,
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
      /*
      FNXC:Identity 2026-09-04-04:46:
      Custom-node worktree capture is outside the implementation node, so the partial
      `getRunContextFor` map is empty and would persist `executor`/`unknown`. Use the total
      carrier so the graph-node actor and run id survive onto `baseCommitSha`.
      */
      await captureBaseCommitSha(
        deps.store,
        task,
        acquisition.worktreePath,
        audit,
        { isResume: false },
        deps.runContextFor(task.id),
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

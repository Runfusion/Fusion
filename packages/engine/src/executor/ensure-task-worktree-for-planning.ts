/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * ensureTaskWorktreeForPlanning peeled from TaskExecutor (U4).
 *
 * Acquires a task-owned planning worktree in both single-repository and workspace mode.
 *
 * FNXC:NodeWorktreeIsolation 2026-08-29-06:59:
 * Workspace planners now own a private task directory containing every configured child checkout.
 * This is at least as strong as the retired shared-root read-only boundary: concurrent planners
 * cannot edit each other's tree and no planner ever falls back to the operator checkout.
 */
import { existsSync } from "node:fs";
import type { Settings, TaskDetail, TaskStore, WorkspaceConfig } from "@fusion/core";
import { resolveWorkspaceTaskWorktreeDir } from "@fusion/core";
import { executorLog, formatError } from "../logger.js";
import { resolveWorkspaceConfigOnce } from "./workspace-config-resolver.js";

export type EnsureTaskWorktreeForPlanningDeps = {
  store: TaskStore;
  rootDir: string;
  /** Mutable holder so lazy load updates TaskExecutor.workspaceConfig. */
  workspaceConfigOwner: object;
  getWorkspaceConfig: () => WorkspaceConfig | null | undefined;
  setWorkspaceConfig: (cfg: WorkspaceConfig | null) => void;
  ensureGraphCustomNodeWorktree: (
    task: TaskDetail,
    settings: Settings,
    nodeId: string,
    refreshStaleBase?: boolean,
  ) => Promise<TaskDetail>;
};

export async function ensureTaskWorktreeForPlanning(
  deps: EnsureTaskWorktreeForPlanningDeps,
  taskId: string,
): Promise<string | null> {
  let workspaceMode = false;
  try {
    const workspaceConfig = await resolveWorkspaceConfigOnce(deps);
    workspaceMode = Boolean(workspaceConfig && (workspaceConfig.repos.length ?? 0) > 0);

    const live = await deps.store.getTask(taskId);
    if (!workspaceMode && live.worktree && existsSync(live.worktree)) return live.worktree;

    const settings = await deps.store.getSettings();
    const acquisitionTask = live.worktree
      ? ({ ...live, worktree: undefined, sessionFile: undefined } as TaskDetail)
      : live;
    const acquired = await deps.ensureGraphCustomNodeWorktree(acquisitionTask, settings, "planning");
    if (workspaceMode) {
      if (!Object.keys(acquired.workspaceWorktrees ?? {}).length) {
        throw new Error(`Workspace planning could not acquire configured task worktrees for ${taskId}`);
      }
      return resolveWorkspaceTaskWorktreeDir(deps.rootDir, settings, taskId);
    }
    return acquired.worktree || null;
  } catch (error) {
    if (workspaceMode) {
      executorLog.error(`${taskId}: workspace planning cannot establish private task worktrees: ${formatError(error)}`);
      throw error;
    }
    executorLog.warn(`${taskId}: could not acquire a planning worktree — planning falls back to the repo root: ${formatError(error)}`);
    return null;
  }
}

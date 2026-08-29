/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * ensureTaskWorktreeForPlanning peeled from TaskExecutor (U4).
 *
 * Acquires a planning worktree when none exists for a single-repository task. Workspace planning
 * returns the workspace root under a declared read-only boundary and acquires nothing.
 *
 * FNXC:NodeWorktreeIsolation 2026-08-22-22:46:
 * FN-158 replaces the workspace planning checkout with a read-only-root boundary. That removes
 * write tools from the shared checkout entirely, so concurrent planners cannot collide; Plan Review
 * and execution re-check freshness after scoped acquisition. Single-repository scope is known at
 * creation and continues to acquire immediately under the same "acquire when scope is known" rule.
 */
import { existsSync } from "node:fs";
import type { Settings, TaskDetail, TaskStore, WorkspaceConfig } from "@fusion/core";
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
    if (workspaceMode) {
      if (!existsSync(deps.rootDir)) {
        throw new Error(`Workspace root is missing for planning: ${deps.rootDir}`);
      }
      return deps.rootDir;
    }

    if (live.worktree && existsSync(live.worktree)) return live.worktree;

    const settings = await deps.store.getSettings();
    const acquisitionTask = live.worktree
      ? ({ ...live, worktree: undefined, sessionFile: undefined } as TaskDetail)
      : live;
    const acquired = await deps.ensureGraphCustomNodeWorktree(acquisitionTask, settings, "planning");
    return acquired.worktree || null;
  } catch (error) {
    if (workspaceMode) {
      executorLog.error(`${taskId}: workspace planning cannot establish its read-only workspace root: ${formatError(error)}`);
      throw error;
    }
    executorLog.warn(`${taskId}: could not acquire a planning worktree — planning falls back to the repo root: ${formatError(error)}`);
    return null;
  }
}

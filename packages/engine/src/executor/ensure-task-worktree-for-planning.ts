/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * ensureTaskWorktreeForPlanning peeled from TaskExecutor (U4).
 *
 * Acquires a planning worktree when none exists (non-workspace). Fail-soft: planning falls
 * back to the repo root on acquisition failure.
 */
import { existsSync } from "node:fs";
import type { Settings, TaskDetail, TaskStore, WorkspaceConfig } from "@fusion/core";
import { loadWorkspaceConfig } from "@fusion/core";
import { executorLog, formatError } from "../logger.js";

export type EnsureTaskWorktreeForPlanningDeps = {
  store: TaskStore;
  rootDir: string;
  /** Mutable holder so lazy load updates TaskExecutor.workspaceConfig. */
  getWorkspaceConfig: () => WorkspaceConfig | null | undefined;
  setWorkspaceConfig: (cfg: WorkspaceConfig | null) => void;
  ensureGraphCustomNodeWorktree: (
    task: TaskDetail,
    settings: Settings,
    nodeId: string,
    refreshStaleBase?: boolean,
  ) => Promise<{ worktree?: string }>;
};

export async function ensureTaskWorktreeForPlanning(
  deps: EnsureTaskWorktreeForPlanningDeps,
  taskId: string,
): Promise<string | null> {
  try {
    if (deps.getWorkspaceConfig() === undefined) {
      deps.setWorkspaceConfig(await loadWorkspaceConfig(deps.rootDir));
    }
    const workspaceConfig = deps.getWorkspaceConfig();
    if (workspaceConfig && (workspaceConfig.repos.length ?? 0) > 0) return null;

    const live = await deps.store.getTask(taskId);
    if (live.worktree && existsSync(live.worktree)) return live.worktree;

    const settings = await deps.store.getSettings();
    const acquisitionTask = live.worktree
      ? ({ ...live, worktree: undefined, sessionFile: undefined } as TaskDetail)
      : live;
    const acquired = await deps.ensureGraphCustomNodeWorktree(acquisitionTask, settings, "planning");
    return acquired.worktree || null;
  } catch (error) {
    executorLog.warn(`${taskId}: could not acquire a planning worktree — planning falls back to the repo root: ${formatError(error)}`);
    return null;
  }
}

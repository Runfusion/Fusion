/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * ensureTaskWorktreeForPlanning peeled from TaskExecutor (U4).
 *
 * Acquires a planning worktree when none exists (non-workspace). Fail-soft: planning falls
 * back to the repo root on acquisition failure.
 *
 * FNXC:NodeWorktreeIsolation 2026-07-25-22:10 (planning acquires the task worktree):
 * Public seam for the planning/triage lane. Specification runs a CODING-tool session; pointing it at
 * the shared main checkout meant every planning agent had write tools in the operator's tree and every
 * concurrent planner shared one path. Acquire the task's own worktree up front and let the whole
 * lifecycle — planning, Plan Review, implementation, code review — reuse that single worktree.
 * Returns null (caller falls back to the root, unchanged behavior) when the project is a workspace, or
 * when acquisition fails: planning must never be blocked by a worktree problem.
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

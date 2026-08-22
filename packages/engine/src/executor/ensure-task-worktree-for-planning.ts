/**
 * FNXC:CodeOrganization 2026-08-03-17:30:
 * ensureTaskWorktreeForPlanning peeled from TaskExecutor (U4).
 *
 * Acquires a planning worktree when none exists for a single-repository task. Workspace planning
 * acquires the declared sub-repository set and returns its deterministic coordinator worktree.
 *
 * FNXC:NodeWorktreeIsolation 2026-07-25-22:10 (planning acquires the task worktree):
 * Public seam for the planning/triage lane. Specification runs a CODING-tool session; pointing it at
 * the shared main checkout meant every planning agent had write tools in the operator's tree and every
 * concurrent planner shared one path. Acquire the task's own worktree up front and let the whole
 * lifecycle — planning, Plan Review, implementation, code review — reuse that single worktree.
 * Single-repository acquisition remains fail-soft for planning. A configured workspace is fail-closed
 * instead: returning null would route the planner to the non-Git workspace root.
 */
import { existsSync } from "node:fs";
import type { Settings, TaskDetail, TaskStore, WorkspaceConfig } from "@fusion/core";
import { executorLog, formatError } from "../logger.js";
import { resolveWorkspaceConfigOnce } from "./workspace-config-resolver.js";
import { normalizeRepoRelPath } from "../worktree/workspace-paths.js";

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
      const settings = await deps.store.getSettings();
      const acquired = await deps.ensureGraphCustomNodeWorktree(live, settings, "planning");
      /*
      FNXC:WorkspaceRootRouting 2026-08-19-12:53:
      Planning must choose only from declared repository entries. Stale workspace metadata can contain a
      root key such as `.`; allowing it into the sort can route the planner back to the workspace root.
      */
      const declaredRepos = new Set(workspaceConfig?.repos.map(normalizeRepoRelPath));
      const coordinator = Object.entries(acquired.workspaceWorktrees ?? {})
        .filter(([repoRelPath]) => declaredRepos.has(normalizeRepoRelPath(repoRelPath)))
        .sort(([left], [right]) => normalizeRepoRelPath(left).localeCompare(normalizeRepoRelPath(right)))
        .map(([, entry]) => entry?.worktreePath)
        .find((path): path is string => typeof path === "string" && path.length > 0);
      if (!coordinator) {
        throw new Error(`Workspace task ${taskId} has no acquired declared-repository worktree for planning`);
      }
      return coordinator;
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
      executorLog.error(`${taskId}: workspace planning could not acquire a declared-repository worktree: ${formatError(error)}`);
      throw error;
    }
    executorLog.warn(`${taskId}: could not acquire a planning worktree — planning falls back to the repo root: ${formatError(error)}`);
    return null;
  }
}

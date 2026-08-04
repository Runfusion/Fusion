/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * hasLiveSessionSurface peeled from TaskExecutor (U4).
 *
 * FNXC:NodeWorktreeIsolation 2026-07-29-06:05 (FN-6756 — one liveness predicate, PR #2531 review):
 * READ-ONLY liveness probe (maps + activeSessionRegistry paths). Same expression as clearPhantomExecutorBinding's guard.
 */
import { hasLiveTaskSessionSurface, type HasLiveTaskSessionSurfaceDeps } from "./has-live-task-session-surface.js";

export type HasLiveSessionSurfaceDeps = HasLiveTaskSessionSurfaceDeps & {
  pathsForTask: (taskId: string) => readonly string[];
};

export function hasLiveSessionSurface(
  deps: HasLiveSessionSurfaceDeps,
  taskId: string,
): boolean {
  return hasLiveTaskSessionSurface(deps, taskId)
    || deps.pathsForTask(taskId).length > 0;
}

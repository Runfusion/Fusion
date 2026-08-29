/**
 * FNXC:CodeOrganization 2026-08-03-14:20:
 * Worktree ownership/liveness helpers peeled from TaskExecutor (U4 Slice B).
 * activeWorktrees and store are injected so the pure cluster stays free of class state.
 */
import type { TaskStore } from "@fusion/core";
import { columnsWithFlag, resolveWorkflowIrForTask } from "@fusion/core";
import { findWorktreeUser } from "../merger.js";
import { activeSessionRegistry, executingTaskLock } from "../agents/active-session-registry.js";
import { executorLog } from "../logger.js";

export type ActiveWorktreesMap = Map<string, Set<string>>;

/**
 * FNXC:Workspace 2026-06-21-12:00: KTD2 — membership across the task's worktree set.
 */
export function hasActiveWorktreeBinding(
  activeWorktrees: ActiveWorktreesMap,
  taskId: string,
  worktreePath: string,
): boolean {
  const paths = activeWorktrees.get(taskId);
  return paths ? paths.has(worktreePath) : false;
}

/**
 * Determine if we should generate a new worktree name instead of cleaning up.
 * Returns true if the conflicting worktree is used by an active task.
 */
export async function shouldGenerateNewWorktreeName(
  activeWorktrees: ActiveWorktreesMap,
  store: TaskStore,
  conflictPath: string,
  currentTaskId: string,
): Promise<boolean> {
  // FNXC:Workspace 2026-06-21-12:00: KTD2 — a task may hold N worktree paths; the conflict check is membership across the set, not equality on a single path.
  for (const [taskId, worktreePaths] of activeWorktrees) {
    if (taskId !== currentTaskId && worktreePaths.has(conflictPath)) {
      return true;
    }
  }

  // Check if another non-done task uses this worktree
  const otherUser = await findWorktreeUser(store, conflictPath, currentTaskId);
  return otherUser !== null;
}

/**
 * FN-4811: Determine whether `worktreePath` is currently bound to an active executor or
 * merger session. If so, removing it would pull the rug out from under a live agent,
 * producing the FN-4781/FN-4804 symptoms (worktree disappears mid-task, two parallel runs,
 * cross-task contamination). Returns the task ID currently using the worktree, or null if
 * the worktree is safe to remove.
 *
 * Liveness sources, in order:
 *  1. In-memory `activeWorktrees` map (per-executor session tracking).
 *  2. DB-level: any non-done, non-paused, in-progress task with `task.worktree === path`.
 *
 * The requesting task is excluded from the check because `cleanupConflictingWorktree` is
 * only called for worktrees the requesting task is trying to displace.
 */
export async function findActiveWorktreeOwner(
  activeWorktrees: ActiveWorktreesMap,
  store: TaskStore,
  worktreePath: string,
  requestingTaskId: string,
): Promise<string | null> {
  // FNXC:Workspace 2026-06-21-12:00: KTD2 — membership across the task's worktree set (a workspace task holds N).
  for (const [taskId, paths] of activeWorktrees) {
    if (taskId !== requestingTaskId && paths.has(worktreePath)) {
      return taskId;
    }
  }
  try {
    const tasks = await store.listTasks({ slim: true, includeArchived: false });
    /*
    FNXC:WorkflowResolvedColumns 2026-07-30-16:40 (executor):
    "Who else is actively working in this worktree?" is the WIP role, not the id. NOT the query-filter
    class — this listTasks call passes no `column`. On a renamed board the check matched nobody, so the
    worktree read as unowned and a second task could be handed a checkout already in use.

    Resolved per CANDIDATE task, one IR cache for the scan, and only for rows that could still match.
    */
    const ownerIrCache = new Map<string, Awaited<ReturnType<typeof resolveWorkflowIrForTask>>>();
    for (const t of tasks) {
      if (t.id === requestingTaskId) continue;
      const wipColumns = new Set<string>(["in-progress"]);
      try {
        const ir = await resolveWorkflowIrForTask(store, t.id, ownerIrCache);
        if (ir) {
          const resolved = columnsWithFlag(ir, "countsTowardWip");
          if (resolved.length > 0) { wipColumns.clear(); for (const id of resolved) wipColumns.add(id); }
        }
      } catch { /* degraded: legacy id only */ }
      if (!wipColumns.has(t.column)) continue;
      if (t.paused === true) continue;
      if (t.worktree === worktreePath) return t.id;
      // FNXC:Workspace 2026-06-22-09:00: workspace tasks hold their worktrees in
      // task.workspaceWorktrees, not the singular task.worktree column. The DB liveness
      // fallback must check those per-sub-repo paths too — otherwise a conflict against a
      // sub-repo worktree owned by an in-progress workspace task is missed, especially
      // before its in-memory activeWorktrees entry is (re)registered after restart.
      const wsEntries = t.workspaceWorktrees;
      if (wsEntries && Object.values(wsEntries).some((entry) => entry.worktreePath === worktreePath)) {
        return t.id;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    executorLog.warn(`findActiveWorktreeOwner: DB liveness check failed for ${worktreePath}: ${msg}`);
  }
  return null;
}

export async function isLiveCleanupRefusal(
  activeWorktrees: ActiveWorktreesMap,
  store: TaskStore,
  worktreePath: string,
  taskId: string,
): Promise<boolean> {
  const activeOwner = await findActiveWorktreeOwner(activeWorktrees, store, worktreePath, taskId);
  if (activeOwner !== null) return true;

  const activeRecord = activeSessionRegistry.lookupByPath(worktreePath);
  if (!activeRecord) return false;
  if (activeRecord.taskId !== taskId) return true;
  return executingTaskLock.has(taskId) || hasActiveWorktreeBinding(activeWorktrees, taskId, worktreePath);
}

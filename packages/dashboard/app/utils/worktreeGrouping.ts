import type { Task } from "@fusion/core";
import { getPathBasename } from "./pathDisplay";
import { isHoldColumnRole } from "@fusion/core";

export interface WorktreeGroupData {
  label: string;
  activeTasks: Task[];
  queuedTasks: Task[];
}

/**
 * Extract a clean display name from a worktree path.
 * e.g. ".worktrees/FN-001" → "FN-001", "/path/to/fn/fn-001" → "fn-001"
 */
export function getWorktreeLabel(worktreePath: string): string {
  return getPathBasename(worktreePath) || worktreePath;
}

/**
 * Topological sort of tasks by dependency order.
 * Mirrors resolveDependencyOrder from @fusion/core but inlined to avoid
 * build alias issues (Vite aliases @fusion/core to types.ts only).
 */
function resolveDependencyOrder(tasks: Task[]): string[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) return;
    visiting.add(id);
    const task = taskMap.get(id);
    if (task) {
      for (const depId of task.dependencies || []) {
        if (taskMap.has(depId)) visit(depId);
      }
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  }

  for (const task of tasks) visit(task.id);
  return ordered;
}

/**
 * Group in-progress tasks by worktree and collect queued todo tasks
 * as visual previews in the "Up Next" group.
 *
 * Queued tasks (eligible "todo" tasks whose dependencies are all satisfied)
 * are always placed in the "Up Next" group — they are never distributed
 * to worktree-specific groups since they have no worktree assignment yet.
 * The number of queued tasks shown is capped at `maxConcurrent`.
 */
export function groupByWorktree(
  inProgressTasks: Task[],
  allTasks: Task[],
  maxConcurrent: number,
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  The ids of every column on the board carrying the HOLD trait, when the caller resolved
  them. A SET rather than one column's flags because this helper scans `allTasks`: it must
  recognise the hold lane of any workflow represented on the board, which is the reason the
  earlier note said there was no seam here. Board has that information; Lane does not, and
  omitting it keeps the documented legacy-id fallback.
  */
  holdColumnIds?: ReadonlySet<string>,
): WorktreeGroupData[] {
  // Separate assigned vs unassigned in-progress tasks
  const assigned = inProgressTasks.filter((t) => t.worktree);
  const unassigned = inProgressTasks.filter((t) => !t.worktree);

  // Group assigned tasks by worktree
  const worktreeMap = new Map<string, Task[]>();
  for (const task of assigned) {
    const key = task.worktree!;
    const list = worktreeMap.get(key) || [];
    list.push(task);
    worktreeMap.set(key, list);
  }

  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  The filter wants "cards waiting for capacity" — the HOLD role, resolved from the board's
  columns rather than the id `todo`.

  THE BUG THIS CLOSES, measured rather than assumed: on the default board the id and the
  role coincide (U11 gave `todo` the hold trait), so this looked healthy. On a board whose
  hold column is renamed the filter matched NOTHING, so the worktree view showed no upcoming
  work at all and read as idle — a whole panel silently empty, with nothing failing.

  Dependency satisfaction below still names terminal ids. That is a separate question from
  the hold role and is left alone deliberately: it needs `complete`/`mergeBlocker`/`archived`
  traits for the DEPENDENCY's column, which is another lookup and another unit of work.
  */
  // Find queued hold-lane tasks: cards in the hold column with all deps satisfied.
  const taskById = new Map(allTasks.map((t) => [t.id, t]));
  const isWaitingColumn = (column: string): boolean =>
    holdColumnIds ? holdColumnIds.has(column) : isHoldColumnRole(undefined, column);
  const todoTasks = allTasks.filter((t) => isWaitingColumn(t.column));
  const eligible = todoTasks.filter((t) =>
    !t.paused &&
    (t.dependencies || []).every((depId) => {
      const dep = taskById.get(depId);
      return dep && (dep.column === "done" || dep.column === "in-review" || dep.column === "archived");
    }),
  );

  // Order eligible tasks by dependency order
  const orderedIds = resolveDependencyOrder(eligible);
  const orderedEligible = orderedIds
    .map((id) => taskById.get(id))
    .filter((t): t is Task => t !== undefined && eligible.includes(t));

  // Build groups from worktree map
  const groups: WorktreeGroupData[] = [];
  const worktreeKeys = Array.from(worktreeMap.keys());

  for (const key of worktreeKeys) {
    groups.push({
      label: getWorktreeLabel(key),
      activeTasks: worktreeMap.get(key)!,
      queuedTasks: [],
    });
  }

  // Add unassigned group if needed
  if (unassigned.length > 0) {
    groups.push({
      label: "Unassigned",
      activeTasks: unassigned,
      queuedTasks: [],
    });
  }

  // All eligible queued tasks go into the "Up Next" group (capped at maxConcurrent)
  const queued = orderedEligible.slice(0, maxConcurrent);
  if (queued.length > 0) {
    groups.push({
      label: "Up Next",
      activeTasks: [],
      queuedTasks: queued,
    });
  }

  return groups;
}

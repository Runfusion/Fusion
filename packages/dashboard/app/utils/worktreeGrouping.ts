import type { Task } from "@fusion/core";

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
  // Take the last segment of the path
  const segments = worktreePath.replace(/\/+$/, "").split("/");
  return segments[segments.length - 1] || worktreePath;
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

  // Find queued todo tasks: "todo" tasks with all deps satisfied (done or in-review)
  const taskById = new Map(allTasks.map((t) => [t.id, t]));
  const todoTasks = allTasks.filter((t) => t.column === "todo");
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

import { isWorkspaceTask, type Task } from "@fusion/core";
import { getPathBasename } from "./pathDisplay";
import { isCompleteColumnRole, isHoldColumnRole, isReviewColumnRole } from "./columnRoles";

export interface WorktreeGroupData {
  /** Stable identity; display labels collide for separate worktree paths. */
  id: string;
  kind: "worktree" | "workspace" | "unassigned" | "up-next";
  label: string;
  repoCount?: number;
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
 * The number of queued tasks shown is capped at the execution-worktree ceiling.
 */
export function groupByWorktree(
  inProgressTasks: Task[],
  allTasks: Task[],
  worktreeLimit: number,
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  The ids of TASKS whose own column is a hold lane in their own workflow, when the caller
  resolved them.

  Task ids, not column ids (PR #2625 review — greptile). This helper scans `allTasks`, which
  can span workflows, and column ids are namespaced per workflow — two workflows may both
  declare `staging` with only one of them marking it `hold`. A unioned column-id set cannot
  tell those apart and would list every executing card of the second workflow as waiting.
  Only a card's own workflow can answer "is this waiting?", so the caller answers it per task
  and passes the result.

  Board resolves this; Lane does not pass it and keeps the legacy-id fallback.
  */
  holdTaskIds?: ReadonlySet<string>,
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-11:30 (batch-dashboard-app):
  Per-dependency column flags, mirroring the `holdTaskIds` seam directly above: the caller resolves,
  this stays pure. Omitted -> the legacy ids, i.e. today's behaviour for every unconverted caller.

  Without it, "are this card's dependencies satisfied?" was three legacy ids. On a renamed board a
  FINISHED dependency matched none of them, so the dependent never appeared in the worktree view's
  upcoming-work list — it looked like there was nothing ready to run while there was.
  */
  dependencyColumnFlags?: ReadonlyMap<string, Parameters<typeof isCompleteColumnRole>[0]>,
): WorktreeGroupData[] {
  /*
  FNXC:Workspace 2026-08-20-20:05:
  A populated workspaceWorktrees map is authoritative over a stale singular worktree delivered
  before asynchronous store normalization. Classify it as workspace first so a one-repository
  workspace cannot be hidden under an unrelated singular group; stable ids still prevent
  basename collisions between acquired repository paths.
  */
  const workspaceTasks = inProgressTasks.filter(isWorkspaceTask);
  const assigned = inProgressTasks.filter((task) => !isWorkspaceTask(task) && Boolean(task.worktree));
  const unassigned = inProgressTasks.filter((task) => !isWorkspaceTask(task) && !task.worktree);

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

  Dependency satisfaction below is a separate per-dependency question: completion and review
  roles come from the dependency's own workflow flags.
  */
  // Find queued hold-lane tasks: cards in the hold column with all deps satisfied.
  const taskById = new Map(allTasks.map((t) => [t.id, t]));
  const isWaitingTask = (task: Task): boolean =>
    holdTaskIds ? holdTaskIds.has(task.id) : isHoldColumnRole(undefined, task.column);
  const todoTasks = allTasks.filter(isWaitingTask);
  const eligible = todoTasks.filter((t) =>
    !t.paused &&
    (t.dependencies || []).every((depId) => {
      const dep = taskById.get(depId);
      if (!dep) return false;
      const depFlags = dependencyColumnFlags?.get(dep.id);
      /* Satisfied = the dependency rests in its OWN board's completion or review lane. */
      return isCompleteColumnRole(depFlags, dep.column)
        || isReviewColumnRole(depFlags, dep.column);
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
      id: key,
      kind: "worktree",
      label: getWorktreeLabel(key),
      activeTasks: worktreeMap.get(key)!,
      queuedTasks: [],
    });
  }

  for (const task of workspaceTasks) {
    const entries = task.workspaceWorktrees!;
    const firstRepo = Object.keys(entries).sort()[0]!;
    groups.push({
      id: `workspace:${task.id}`,
      kind: "workspace",
      label: getWorktreeLabel(entries[firstRepo]!.worktreePath),
      repoCount: Object.keys(entries).length,
      activeTasks: [task],
      queuedTasks: [],
    });
  }

  // Add unassigned group if needed
  if (unassigned.length > 0) {
    groups.push({
      id: "unassigned",
      kind: "unassigned",
      label: "Unassigned",
      activeTasks: unassigned,
      queuedTasks: [],
    });
  }

  // All eligible queued tasks go into the "Up Next" group (capped at worktree capacity).
  const queued = orderedEligible.slice(0, worktreeLimit);
  if (queued.length > 0) {
    groups.push({
      id: "up-next",
      kind: "up-next",
      label: "Up Next",
      activeTasks: [],
      queuedTasks: queued,
    });
  }

  return groups;
}

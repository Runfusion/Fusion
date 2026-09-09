import { isActiveMergeStatus } from "../merge/active-merge-status.js";
import { isCompleteColumnRole, isHoldColumnRole, isReviewColumnRole, type ColumnRoleTraitFlags } from "../column-roles.js";
import { computeBlockerFanoutMap } from "./blocker-fanout.js";
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES } from "../types.js";
import type { ProjectSettings, Task, TaskPriority } from "../types.js";

export interface TaskPrioritySortable {
  id: string;
  createdAt: string;
  priority?: TaskPriority | null;
}

export interface TaskColumnSortable extends TaskPrioritySortable {
  column: string;
  status?: string | null;
  columnMovedAt?: string;
  updatedAt?: string;
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Normalize an optional/legacy task priority value to the bounded core contract.
 * Missing or invalid values map to DEFAULT_TASK_PRIORITY (`normal`).
 */
export function normalizeTaskPriority(priority: unknown): TaskPriority {
  return isTaskPriority(priority) ? priority : DEFAULT_TASK_PRIORITY;
}

/**
 * Return a numeric rank where higher values indicate higher priority.
 */
export function getTaskPriorityRank(priority: unknown): number {
  return PRIORITY_RANK[normalizeTaskPriority(priority)];
}

/**
 * Compare priorities so higher-priority tasks sort first.
 */
export function compareTaskPriority(a: unknown, b: unknown): number {
  return getTaskPriorityRank(b) - getTaskPriorityRank(a);
}

function getTaskIdNumericToken(id: string): number | null {
  const token = id.slice(id.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(token)) return null;
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function compareTaskIdNumeric(a: string, b: string): number {
  const aNum = getTaskIdNumericToken(a);
  const bNum = getTaskIdNumericToken(b);

  if (aNum !== null && bNum !== null && aNum !== bNum) {
    return aNum - bNum;
  }

  return a.localeCompare(b);
}

function compareTaskIdNumericDesc(a: string, b: string): number {
  const aNum = getTaskIdNumericToken(a);
  const bNum = getTaskIdNumericToken(b);

  if (aNum !== null && bNum !== null && aNum !== bNum) {
    return bNum - aNum;
  }

  return b.localeCompare(a);
}

/**
 * Deterministic comparator for priority-aware task ordering:
 * 1) priority (urgent → low), 2) createdAt ASC, 3) id ASC.
 */
export function compareTasksByPriorityThenAgeAndId<T extends TaskPrioritySortable>(a: T, b: T): number {
  const priorityCmp = compareTaskPriority(a.priority, b.priority);
  if (priorityCmp !== 0) {
    return priorityCmp;
  }

  if (a.createdAt !== b.createdAt) {
    return a.createdAt.localeCompare(b.createdAt);
  }

  return compareTaskIdNumeric(a.id, b.id);
}

/**
 * Return a sorted copy (input remains unchanged).
 */
export function sortTasksByPriorityThenAgeAndId<T extends TaskPrioritySortable>(
  tasks: readonly T[],
): T[] {
  return [...tasks].sort(compareTasksByPriorityThenAgeAndId);
}

const FANOUT_SECONDARY_WEIGHT_MULTIPLIER = 1_000_000;
/*
FNXC:WorkflowLifecycleColumns 2026-07-27-22:10 (Phase B / U6):
`UNBLOCK_ACTIVE_COLUMNS` is DELETED. It enumerated the default workflow's
non-terminal columns, which is the same concept `DONE_COLUMNS` already expressed
by exclusion two lines below — one idea encoded twice, and the two halves
disagreed for any column a custom workflow adds: dependency counting treated a
`drafting` card as unmet (correct) while the active check treated it as inactive
(wrong), so the blocker's unblock weight silently scored 0. Both halves now read
the single terminal set.
*/
const DEFAULT_TERMINAL_COLUMNS: ReadonlySet<string> = new Set(["done"]);

export interface BuildUnblockWeightMapOptions {
  maxAutoMergeRetries?: ProjectSettings["maxAutoMergeRetries"];
  /** The workflow's Complete columns. Defaults to the built-in `{done}`. */
  terminalColumns?: ReadonlySet<string>;
  /** The workflow's review lane, forwarded to the fan-out's staleness classification.
   *  Defaults to the built-in `{in-review}` so existing callers are unchanged. */
  reviewColumns?: ReadonlySet<string>;
}

function countUnmetDependencies(
  task: Task,
  taskById: Map<string, Task>,
  terminalColumns: ReadonlySet<string>,
): number {
  let unmet = 0;
  for (const dependencyId of task.dependencies ?? []) {
    const dependency = taskById.get(dependencyId);
    if (!dependency) {
      unmet += 1;
      continue;
    }
    if (terminalColumns.has(dependency.column)) {
      continue;
    }
    unmet += 1;
  }
  return unmet;
}

export function buildUnblockWeightMap(
  tasks: readonly Task[],
  options: BuildUnblockWeightMapOptions = {},
): Map<string, number> {
  const taskList = [...tasks];
  const terminalColumns = options.terminalColumns ?? DEFAULT_TERMINAL_COLUMNS;
  /* FNXC:WorkflowLifecycleColumns 2026-07-31-10:00: forward the review lane too — this is the one
     production caller, so an option it does not pass is an option that never fires. */
  const fanout = computeBlockerFanoutMap(taskList, options.maxAutoMergeRetries ?? 0, {
    terminalColumns,
    ...(options.reviewColumns ? { reviewColumns: options.reviewColumns } : {}),
  });
  const taskById = new Map(taskList.map((task) => [task.id, task]));
  const weights = new Map<string, number>();

  for (const [blockerId, entry] of fanout) {
    let primaryOnlyUnmetCount = 0;
    let secondaryActiveDependentCount = 0;

    for (const dependentId of entry.dependencyDependentIds) {
      const dependent = taskById.get(dependentId);
      // Active by exclusion — the same terminal set the dependency count uses.
      if (!dependent || terminalColumns.has(dependent.column)) {
        continue;
      }
      secondaryActiveDependentCount += 1;
      if (countUnmetDependencies(dependent, taskById, terminalColumns) === 1) {
        primaryOnlyUnmetCount += 1;
      }
    }

    const weight = primaryOnlyUnmetCount * FANOUT_SECONDARY_WEIGHT_MULTIPLIER + secondaryActiveDependentCount;
    weights.set(blockerId, weight);
  }

  return weights;
}

export interface PriorityFanoutComparatorContext {
  unblockWeights: ReadonlyMap<string, number>;
}

/**
 * FN-4969: within the same priority class, prefer tasks that unblock the most dependency-bound work.
 * This must never reorder across priority classes — urgent user work always outranks fanout.
 */
export function compareTasksByPriorityFanoutThenAgeAndId<T extends TaskPrioritySortable>(
  a: T,
  b: T,
  ctx: PriorityFanoutComparatorContext,
): number {
  const priorityCmp = compareTaskPriority(a.priority, b.priority);
  if (priorityCmp !== 0) {
    return priorityCmp;
  }

  const aWeight = ctx.unblockWeights.get(a.id) ?? 0;
  const bWeight = ctx.unblockWeights.get(b.id) ?? 0;
  if (aWeight !== bWeight) {
    return bWeight - aWeight;
  }

  if (a.createdAt !== b.createdAt) {
    return a.createdAt.localeCompare(b.createdAt);
  }

  return compareTaskIdNumeric(a.id, b.id);
}

export function sortTasksByPriorityFanoutThenAgeAndId<T extends TaskPrioritySortable>(
  tasks: readonly T[],
  unblockWeights: ReadonlyMap<string, number>,
): T[] {
  return [...tasks].sort((a, b) => compareTasksByPriorityFanoutThenAgeAndId(a, b, { unblockWeights }));
}

function getDoneSortTimestamp(task: TaskColumnSortable): number {
  const timestamp = task.columnMovedAt ?? task.updatedAt ?? task.createdAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMergeActiveStatus(status: string | null | undefined): boolean {
  return isActiveMergeStatus(status);
}

export type TaskColumnSortMode = "completion-date-desc" | "task-id-desc";
/** Generic alias for callers that do not need the Task-prefixed name. */
export type ColumnSortMode = TaskColumnSortMode;
/** Kept as the public compatibility name for existing Done-column callers. */
export type DoneColumnSortMode = TaskColumnSortMode;

/** Resolved display policy for one workflow column. */
export interface DisplayColumnSortOptions {
  /** Resolved column traits; omitted only while retaining legacy-id compatibility. */
  columnFlags?: ColumnRoleTraitFlags;
  /** Generic Board-local ordering for any visible workflow column. */
  sortMode?: TaskColumnSortMode;
  /** Compatibility alias used by existing Done-column callers. */
  doneSortMode?: DoneColumnSortMode;
}

/*
FNXC:TaskColumnSorting 2026-08-18-21:24:
Core owns the sole task-display sorter so every Board lane shares one comparator. An explicitly
selected mode deliberately wins over lifecycle priority, merge, and hold FIFO semantics; when no
mode is selected those role-specific defaults remain unchanged. Arrival is the durable column move
timestamp with legacy updatedAt/createdAt fallbacks. Complete rows use newest-first ordering by default.
*/
/**
 * Return a sorted display copy for a workflow column without mutating its input.
 * Explicit arrival or task-ID mode applies to every role; omitted mode retains Complete newest-first,
 * hold priority/FIFO, and review active-merge ordering.
 */
export function sortTasksForDisplayColumn<T extends TaskColumnSortable>(
  tasks: readonly T[],
  column: string,
  displayColumnOptions: DisplayColumnSortOptions = {},
): T[] {
  const { columnFlags, sortMode, doneSortMode } = displayColumnOptions;
  const selectedSortMode = sortMode ?? doneSortMode;

  if (selectedSortMode !== undefined) {
    return [...tasks].sort((a, b) => {
      if (selectedSortMode === "task-id-desc") {
        return compareTaskIdNumericDesc(a.id, b.id);
      }
      const timestampCmp = getDoneSortTimestamp(b) - getDoneSortTimestamp(a);
      if (timestampCmp !== 0) return timestampCmp;
      return compareTaskIdNumeric(a.id, b.id);
    });
  }

  if (isHoldColumnRole(columnFlags, column)) {
    return sortTasksByPriorityThenAgeAndId(tasks);
  }

  return [...tasks].sort((a, b) => {
    if (isCompleteColumnRole(columnFlags, column)) {
      const timestampCmp = getDoneSortTimestamp(b) - getDoneSortTimestamp(a);
      if (timestampCmp !== 0) return timestampCmp;
      return compareTaskIdNumeric(a.id, b.id);
    }

    if (isReviewColumnRole(columnFlags, column)) {
      const aIsMerging = isMergeActiveStatus(a.status);
      const bIsMerging = isMergeActiveStatus(b.status);
      if (aIsMerging !== bIsMerging) return aIsMerging ? -1 : 1;
    }

    const priorityCmp = compareTaskPriority(a.priority, b.priority);
    if (priorityCmp !== 0) return priorityCmp;
    return compareTaskIdNumeric(a.id, b.id);
  });
}

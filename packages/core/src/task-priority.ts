import { DEFAULT_TASK_PRIORITY, TASK_PRIORITIES } from "./types.js";
import type { TaskPriority } from "./types.js";

export interface TaskPrioritySortable {
  id: string;
  createdAt: string;
  priority?: TaskPriority | null;
  expediteRequestedAt?: string | null;
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

export function compareTaskIdNumeric(a: string, b: string): number {
  const aNum = Number.parseInt(a.slice(a.lastIndexOf("-") + 1), 10);
  const bNum = Number.parseInt(b.slice(b.lastIndexOf("-") + 1), 10);

  if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) {
    return aNum - bNum;
  }

  return a.localeCompare(b);
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

  const aExpedite = a.expediteRequestedAt;
  const bExpedite = b.expediteRequestedAt;
  if (aExpedite || bExpedite) {
    if (aExpedite && !bExpedite) return -1;
    if (!aExpedite && bExpedite) return 1;
    if (aExpedite && bExpedite && aExpedite !== bExpedite) {
      return bExpedite.localeCompare(aExpedite);
    }
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

function getDoneSortTimestamp(task: TaskColumnSortable): number {
  const timestamp = task.columnMovedAt ?? task.updatedAt ?? task.createdAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isMergeActiveStatus(status: string | null | undefined): boolean {
  return status === "merging" || status === "merging-pr" || status === "merging-fix";
}

/**
 * Column-aware default ordering shared by board and list surfaces.
 */
export function sortTasksForDisplayColumn<T extends TaskColumnSortable>(tasks: readonly T[], column: string): T[] {
  if (column === "todo") {
    return sortTasksByPriorityThenAgeAndId(tasks);
  }

  return [...tasks].sort((a, b) => {
    if (column === "done") {
      const timestampCmp = getDoneSortTimestamp(b) - getDoneSortTimestamp(a);
      if (timestampCmp !== 0) {
        return timestampCmp;
      }
      return compareTaskIdNumeric(a.id, b.id);
    }

    if (column === "in-review") {
      const aIsMerging = isMergeActiveStatus(a.status);
      const bIsMerging = isMergeActiveStatus(b.status);
      if (aIsMerging !== bIsMerging) {
        return aIsMerging ? -1 : 1;
      }
    }

    const priorityCmp = compareTaskPriority(a.priority, b.priority);
    if (priorityCmp !== 0) {
      return priorityCmp;
    }

    return compareTaskIdNumeric(a.id, b.id);
  });
}

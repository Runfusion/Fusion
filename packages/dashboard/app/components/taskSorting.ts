import type { Task, Column } from "@fusion/core";
import { isActiveMergeStatus as isMergeActiveStatus } from "../../../core/src/active-merge-status";

export type DoneColumnSortMode = "completion-date-desc" | "task-id-desc";

function getTaskPriorityRank(priority: Task["priority"] | null | undefined): number {
  if (priority === "urgent") return 3;
  if (priority === "high") return 2;
  if (priority === "low") return 0;
  return 1;
}

function compareTaskPriority(a: Task["priority"] | null | undefined, b: Task["priority"] | null | undefined): number {
  return getTaskPriorityRank(b) - getTaskPriorityRank(a);
}

function getTaskIdNumericToken(id: string): number | null {
  const token = id.slice(id.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(token)) return null;
  const parsed = Number.parseInt(token, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareTaskIdNumeric(a: string, b: string): number {
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

function getDoneSortTimestamp(task: Task): number {
  const timestamp = task.columnMovedAt ?? task.updatedAt ?? task.createdAt;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortTasksForDisplayColumn(
  tasks: readonly Task[],
  column: Column,
  doneSortMode: DoneColumnSortMode = "completion-date-desc",
  isArchivedColumn: boolean = column === "archived",
): Task[] {
  /*
  FNXC:ArchivePagination 2026-07-08-00:00:
  FN-7659 — the Archived column must render newest-first (`archivedAt DESC`),
  the exact order the paginated `GET /tasks/archived` read and useTasks'
  page-merge already produce. The generic priority+task-id sort below would
  silently undo that ordering (it ran for every non-todo/non-done column,
  including archived, before this fix), so archived columns pass through
  unsorted — both the legacy literal `"archived"` column id and, for
  workflow-mode custom archived columns, the caller-supplied
  `isArchivedColumn` flag (derived from the column's `archived` trait flag).
  */
  if (isArchivedColumn) {
    return [...tasks];
  }

  if (column === "todo") {
    return [...tasks].sort((a, b) => {
      const priorityCmp = compareTaskPriority(a.priority, b.priority);
      if (priorityCmp !== 0) return priorityCmp;
      if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
      return compareTaskIdNumeric(a.id, b.id);
    });
  }

  return [...tasks].sort((a, b) => {
    if (column === "done") {
      /*
      FNXC:DoneColumnSorting 2026-06-29-14:48:
      Done keeps completion-date descending as the default for existing board, lane, and list callers while supporting an explicit task-id descending mode for users who need newest FN ids first.
      */
      if (doneSortMode === "task-id-desc") {
        return compareTaskIdNumericDesc(a.id, b.id);
      }
      const timestampCmp = getDoneSortTimestamp(b) - getDoneSortTimestamp(a);
      if (timestampCmp !== 0) return timestampCmp;
      return compareTaskIdNumeric(a.id, b.id);
    }

    if (column === "in-review") {
      const aIsMerging = isMergeActiveStatus(a.status);
      const bIsMerging = isMergeActiveStatus(b.status);
      if (aIsMerging !== bIsMerging) return aIsMerging ? -1 : 1;
    }

    const priorityCmp = compareTaskPriority(a.priority, b.priority);
    if (priorityCmp !== 0) return priorityCmp;
    return compareTaskIdNumeric(a.id, b.id);
  });
}

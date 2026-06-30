import type { Task, Column } from "@fusion/core";

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

function isMergeActiveStatus(status: string | null | undefined): boolean {
  return status === "merging" || status === "merging-pr" || status === "merging-fix";
}

export function sortTasksForDisplayColumn(
  tasks: readonly Task[],
  column: Column,
  doneSortMode: DoneColumnSortMode = "completion-date-desc",
): Task[] {
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

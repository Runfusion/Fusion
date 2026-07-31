import type { Task, Column } from "@fusion/core";
import { isActiveMergeStatus as isMergeActiveStatus } from "../../../core/src/active-merge-status";
import { isArchivedColumnRole, isCompleteColumnRole, isHoldColumnRole, isReviewColumnRole } from "../utils/columnRoles";

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
  isArchivedColumn: boolean = isArchivedColumnRole(undefined, column),
  /*
  FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
  Does this column HOLD planned work waiting for capacity? Follows the same
  caller-supplies-the-trait shape `isArchivedColumn` already established, and defaults to
  the legacy id so the callers that do not resolve flags (Lane, ListView) keep today's
  behaviour exactly.

  The priority-then-FIFO order below is the hold lane's queue order — it is what makes a
  high-priority card visibly next. Keyed on the id, it silently degrades to the generic
  sort on any board whose hold column is not named `todo`, so a renamed lineage loses
  priority ordering with nothing failing. Not a rename: `todo` gained the hold trait in
  U11, so the id and the role stopped being the same question.
  */
  isHoldColumn: boolean = isHoldColumnRole(undefined, column),
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-07:10 (fleet phase — completing the caller-supplies-the-trait shape):
  The last two questions this function asked by id. Same contract as the two params above: the caller
  passes the resolved trait, and the default is the legacy id so callers that do not resolve flags keep
  today's behaviour exactly.

  `isCompleteColumn` also retires a caller-side hack. Board.tsx forced done-sorting by passing the
  LITERAL "done" as the column argument for any complete-flagged lane — a synthetic id standing in for a
  trait, so a custom complete lane sorted correctly only because its caller lied about its name. It can
  now pass the real column id and say `isCompleteColumn: true`.

  `isReviewColumn` decides whether merging cards float to the top of the lane. Keyed on the id it
  silently stopped doing that on any renamed review lane — the operator loses the "what is merging right
  now" ordering with nothing failing.
  */
  isCompleteColumn: boolean = isCompleteColumnRole(undefined, column),
  isReviewColumn: boolean = isReviewColumnRole(undefined, column),
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

  if (isHoldColumn) {
    return [...tasks].sort((a, b) => {
      const priorityCmp = compareTaskPriority(a.priority, b.priority);
      if (priorityCmp !== 0) return priorityCmp;
      if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
      return compareTaskIdNumeric(a.id, b.id);
    });
  }

  return [...tasks].sort((a, b) => {
    if (isCompleteColumn) {
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

    if (isReviewColumn) {
      const aIsMerging = isMergeActiveStatus(a.status);
      const bIsMerging = isMergeActiveStatus(b.status);
      if (aIsMerging !== bIsMerging) return aIsMerging ? -1 : 1;
    }

    const priorityCmp = compareTaskPriority(a.priority, b.priority);
    if (priorityCmp !== 0) return priorityCmp;
    return compareTaskIdNumeric(a.id, b.id);
  });
}

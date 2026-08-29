import type { Task, ColumnId } from "@fusion/core";
import type { NotificationEvent, Snapshot } from "./types.js";

export function diffSnapshots(
  prev: Snapshot,
  next: ReadonlyArray<Task>,
  opts: { notifyOnColumns: ReadonlySet<ColumnId>; alsoNotifyOnDone?: boolean; completeColumnsByTaskId?: ReadonlyMap<string, ReadonlySet<string>> },
): NotificationEvent[] {
  const events: NotificationEvent[] = [];

  for (const task of next) {
    const previous = prev.get(task.id);
    if (!previous) {
      if (opts.notifyOnColumns.has(task.column)) {
        events.push({
          taskId: task.id,
          reason: "new-task",
          column: task.column,
          previousColumn: null,
          updatedAt: task.updatedAt,
        });
      }
      continue;
    }

    if (previous.lastColumn === task.column) continue;

    if (opts.notifyOnColumns.has(task.column)) {
      events.push({
        taskId: task.id,
        reason: "entered-column",
        column: task.column,
        previousColumn: previous.lastColumn,
        updatedAt: task.updatedAt,
      });
    } else if (opts.notifyOnColumns.has(previous.lastColumn)) {
      events.push({
        taskId: task.id,
        reason: "left-column",
        column: task.column,
        previousColumn: previous.lastColumn,
        updatedAt: task.updatedAt,
      });
    }

    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-03:05 (supersedes the 2026-07-30-22:25 and -01:20 notes):
    The completion notification asks each card's OWN complete column, and the caller now builds it.

    Keyed on the literal, a renamed board would never fire a "completed" card to the glasses — the
    wearer is notified of every column transition EXCEPT the one they care about.

    PER TASK, not a flat project set, and this shape has now been argued twice. The original note
    gave the reason and it is correct: the poll spans the whole board, so one workflow's complete
    column id can be another workflow's WIP id. I briefly replaced it with a flat set from
    `resolveProjectColumnsForRoles` because that is one read instead of N — but that helper always
    unions the legacy `done` in, which is inert for a query and a FALSE POSITIVE for a per-card
    decision: a workflow declaring `shipped` as complete while reusing `done` as an ordinary lane
    would fire "completed" for live work (#2852 review, greptile P2).

    What the original note got wrong was not the shape but the wiring — no caller ever built the map,
    so this literal decided every real notification. `notifier.ts` now builds it, and builds it only
    when `alsoNotifyOnDone` is on, so the per-task cost is paid only by a caller that consumes it.
    */
    const completeColumns = opts.completeColumnsByTaskId?.get(task.id);
    /* DELIBERATE-LITERAL — the degraded default for a card the caller could not resolve. */
    const isComplete = completeColumns ? completeColumns.has(task.column) : task.column === "done";
    if (isComplete && opts.alsoNotifyOnDone) {
      events.push({
        taskId: task.id,
        reason: "completed",
        column: task.column,
        previousColumn: previous.lastColumn,
        updatedAt: task.updatedAt,
      });
    }
  }

  return events.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt.localeCompare(b.updatedAt);
    if (a.taskId !== b.taskId) return a.taskId.localeCompare(b.taskId);
    return reasonOrder(a.reason) - reasonOrder(b.reason);
  });
}

function reasonOrder(reason: NotificationEvent["reason"]): number {
  switch (reason) {
    case "entered-column":
      return 0;
    case "new-task":
      return 1;
    case "left-column":
      return 2;
    case "completed":
      return 3;
    default:
      return 9;
  }
}

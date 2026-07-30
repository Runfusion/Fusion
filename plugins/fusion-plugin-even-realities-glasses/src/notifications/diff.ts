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
    FNXC:WorkflowLifecycleColumns 2026-07-30-22:25 (batch-cli-plugins):
    The completion notification asks each card's OWN complete column.

    Keyed on the literal, a renamed board would never fire a "completed" card to the glasses — the
    wearer would be notified of every column transition EXCEPT the one they care about. The map is
    per task, not a flat set, because the poll spans the whole board and one workflow's complete
    column id can be another workflow's WIP id.

    CURRENTLY UNREACHABLE, stated plainly: the only production caller (`notifier.ts`) passes
    `alsoNotifyOnDone: false`, so this branch does not run today and this change is not observable at
    runtime. It is converted rather than marked DELIBERATE-LITERAL because the literal is not
    deliberate — it is simply wrong, and would ship the bug the day someone turns the flag on.

    DELIBERATE-LITERAL — the unresolved-workflow default, reviewed 2026-07-30-22:25.
    */
    const completeColumns = opts.completeColumnsByTaskId?.get(task.id);
    /* DELIBERATE-LITERAL — the unresolved-workflow default documented above, reviewed 2026-07-30-22:25. */
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

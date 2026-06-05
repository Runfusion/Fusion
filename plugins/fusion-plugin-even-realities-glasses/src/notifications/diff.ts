import type { Task, ColumnId } from "@fusion/core";
import type { NotificationEvent, Snapshot } from "./types.js";

export function diffSnapshots(
  prev: Snapshot,
  next: ReadonlyArray<Task>,
  opts: { notifyOnColumns: ReadonlySet<ColumnId>; alsoNotifyOnDone?: boolean },
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

    if (task.column === "done" && opts.alsoNotifyOnDone) {
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

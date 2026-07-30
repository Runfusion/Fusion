import type { Task, ColumnId } from "@fusion/core";
import type { NotificationEvent, Snapshot } from "./types.js";

export function diffSnapshots(
  prev: Snapshot,
  next: ReadonlyArray<Task>,
  opts: { notifyOnColumns: ReadonlySet<ColumnId>; alsoNotifyOnDone?: boolean; completeColumns?: ReadonlySet<string> },
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
    FNXC:WorkflowLifecycleColumns 2026-07-31-01:20 (supersedes the 2026-07-30-22:25 note):
    The completion notification asks the PROJECT's complete lanes, and the caller now supplies them.

    Keyed on the literal, a renamed board would never fire a "completed" card to the glasses — the
    wearer would be notified of every column transition EXCEPT the one they care about.

    WHY THE SHAPE CHANGED, and it is the point of this edit. The previous version took a per-task
    `completeColumnsByTaskId` map and NO caller ever built one, so the conversion was decorative:
    the literal below still decided every real notification. That is the unwired-lane-parameter
    class, and it escaped `scripts/lib/unwired-lane-parameter.mjs` twice over — the guard did not
    scan `plugins/`, and it did not walk inline options-object types. Both are fixed in the same
    change, and the guard now reports this declaration if the wiring is ever removed.

    A flat set matches the sibling `notifyOnColumns` in this same options object, and it is what the
    caller can afford: `notifier.ts` resolves it ONCE per poll from the project's workflows, where a
    per-task map would mean a workflow read per card on a polling loop. The plugin's notification
    model is already board-flat; a per-task map beside a flat set was the inconsistency, not the
    rigour.

    The branch is still gated by `alsoNotifyOnDone`, which the production caller passes as `false`
    today — so this remains unobservable at runtime. It is wired anyway, because the day someone
    enables the flag the resolution must already be correct.
    */
    /* DELIBERATE-LITERAL — the degraded default when the caller resolved no lanes. */
    const isComplete = opts.completeColumns ? opts.completeColumns.has(task.column) : task.column === "done";
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

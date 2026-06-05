import type { ColumnId, Task } from "@fusion/core";

export const INCLUDED_COLUMNS: ReadonlySet<ColumnId> = new Set(["triage", "todo", "in-progress", "in-review"]);
export const EXCLUDED_COLUMNS: ReadonlySet<ColumnId> = new Set(["done", "archived"]);

export function filterGraphTasks(tasks: Task[]): Task[] {
  return tasks.filter((task) => INCLUDED_COLUMNS.has(task.column));
}

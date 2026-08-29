import type { ColumnId, Task } from "@fusion/core";

/**
 * The legacy default board's active lanes.
 *
 * Retained as the documented default-board vocabulary (and used by tests to enumerate it), but it is
 * NO LONGER the gate — see {@link filterGraphTasks} for why an allowlist was the wrong shape here.
 */
export const INCLUDED_COLUMNS: ReadonlySet<ColumnId> = new Set(["triage", "todo", "in-progress", "in-review"]);

/** Lanes whose cards are finished, and so are not dependency-graph nodes. */
export const EXCLUDED_COLUMNS: ReadonlySet<ColumnId> = new Set(["done", "archived"]);

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:05:
Gate on the FINISHED lanes, not on a fixed list of active ones — an allowlist blacked out the graph.

This filtered `INCLUDED_COLUMNS.has(task.column)`, an allowlist of four legacy ids. On a board whose
lanes are named anything else — `backlog`, `building`, `checking` — NO task matches and the dependency
graph renders COMPLETELY EMPTY. Not a mislabelled node or a missing edge: the whole feature is blank,
and it reads as "this project has no dependencies" rather than as a bug.

Inverting to a denylist makes the default the safe one. An unrecognised lane is active work by
assumption, so a renamed or custom lane renders; only lanes that genuinely mean "finished" drop out.
An allowlist fails closed (hide everything unknown), a denylist fails open (show it) — and for a
graph, showing a node that could have been omitted is a far smaller error than showing nothing.

`EXCLUDED_COLUMNS` is still two literals: this is a client React component that receives plain `Task`
rows as a prop and has no async seam to resolve a workflow IR, so a board that renames its DONE lane
still shows finished cards here. That is the residual, and it is deliberately the mild failure — the
direction of the remaining error is "one extra node", not "no graph".

The invalid-column guard is now explicit. Under the allowlist, `column: undefined` was excluded as a
side effect of not being in the set; under a denylist it would sail through, so it is checked directly.
*/
export function filterGraphTasks(tasks: Task[]): Task[] {
  return tasks.filter(
    (task) => typeof task.column === "string" && task.column.length > 0 && !EXCLUDED_COLUMNS.has(task.column),
  );
}

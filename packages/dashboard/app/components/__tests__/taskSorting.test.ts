import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { sortTasksForDisplayColumn } from "../taskSorting";

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? "",
    column: overrides.column ?? "done",
    status: overrides.status ?? "idle",
    priority: overrides.priority ?? "normal",
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-01T00:00:00.000Z",
    columnMovedAt: overrides.columnMovedAt,
    dependencies: overrides.dependencies ?? [],
    ...overrides,
  } as Task;
}

function ids(tasks: Task[]): string[] {
  return tasks.map((entry) => entry.id);
}

describe("sortTasksForDisplayColumn", () => {
  it("keeps the shared helper safe for empty done arrays", () => {
    expect(sortTasksForDisplayColumn([], "done")).toEqual([]);
  });

  /*
  FNXC:ArchivePagination 2026-07-08-00:00:
  FN-7659 — the Archived column's server-fetched order (`archivedAt DESC`,
  newest-first) must not be re-sorted by priority/task-id like every other
  non-todo/non-done column. Both the legacy literal "archived" column id and
  the explicit isArchivedColumn flag (for workflow-mode custom archived
  columns) must pass the incoming order through unchanged.
  */
  it("passes through the incoming order unchanged for the legacy 'archived' column id", () => {
    const tasks = [
      task({ id: "FN-3", priority: "low" }),
      task({ id: "FN-1", priority: "urgent" }),
      task({ id: "FN-2", priority: "normal" }),
    ];

    expect(ids(sortTasksForDisplayColumn(tasks, "archived"))).toEqual(["FN-3", "FN-1", "FN-2"]);
  });

  it("passes through the incoming order unchanged when isArchivedColumn is explicitly true", () => {
    const tasks = [
      task({ id: "FN-9", priority: "low" }),
      task({ id: "FN-5", priority: "urgent" }),
    ];

    expect(ids(sortTasksForDisplayColumn(tasks, "todo", "completion-date-desc", true))).toEqual(["FN-9", "FN-5"]);
  });

  it("defaults Done to completion-date descending with numeric task-id ascending ties", () => {
    const tasks = [
      task({ id: "FN-7240", columnMovedAt: "2026-06-01T00:00:00.000Z" }),
      task({ id: "FN-7239", columnMovedAt: "2026-06-03T00:00:00.000Z" }),
      task({ id: "FN-7238", columnMovedAt: "2026-06-03T00:00:00.000Z" }),
    ];

    expect(ids(sortTasksForDisplayColumn(tasks, "done"))).toEqual(["FN-7238", "FN-7239", "FN-7240"]);
  });

  it("matches the default when Done completion-date descending is explicit", () => {
    const tasks = [
      task({ id: "FN-7238", columnMovedAt: "2026-06-01T00:00:00.000Z" }),
      task({ id: "FN-7239", columnMovedAt: "2026-06-02T00:00:00.000Z" }),
      task({ id: "FN-7240", columnMovedAt: "2026-06-03T00:00:00.000Z" }),
    ];

    expect(ids(sortTasksForDisplayColumn(tasks, "done", "completion-date-desc"))).toEqual([
      "FN-7240",
      "FN-7239",
      "FN-7238",
    ]);
  });

  it("sorts Done by numeric task id descending when requested", () => {
    const tasks = [
      task({ id: "FN-7239", columnMovedAt: "2026-06-03T00:00:00.000Z" }),
      task({ id: "FN-7240", columnMovedAt: "2026-06-01T00:00:00.000Z" }),
      task({ id: "FN-7238", columnMovedAt: "2026-06-04T00:00:00.000Z" }),
    ];

    expect(ids(sortTasksForDisplayColumn(tasks, "done", "task-id-desc"))).toEqual([
      "FN-7240",
      "FN-7239",
      "FN-7238",
    ]);
  });

  it("uses lexical descending fallback for non-numeric Done task ids", () => {
    const tasks = [
      task({ id: "TASK-alpha" }),
      task({ id: "TASK-charlie" }),
      task({ id: "TASK-bravo" }),
    ];

    expect(ids(sortTasksForDisplayColumn(tasks, "done", "task-id-desc"))).toEqual([
      "TASK-charlie",
      "TASK-bravo",
      "TASK-alpha",
    ]);
  });

  it("falls back from missing or invalid Done dates to deterministic task-id ties", () => {
    const tasks = [
      task({ id: "FN-7240", createdAt: "not-a-date", updatedAt: undefined, columnMovedAt: undefined }),
      task({ id: "FN-7238", createdAt: "also-not-a-date", updatedAt: undefined, columnMovedAt: undefined }),
      task({
        id: "FN-7239",
        createdAt: "2026-06-02T00:00:00.000Z",
        updatedAt: undefined,
        columnMovedAt: undefined,
      }),
    ];

    expect(ids(sortTasksForDisplayColumn(tasks, "done", "completion-date-desc"))).toEqual([
      "FN-7239",
      "FN-7238",
      "FN-7240",
    ]);
  });

  it("does not apply the Done sort mode to other display columns", () => {
    const tasks = [
      task({ id: "FN-7240", column: "todo", priority: "low", createdAt: "2026-06-03T00:00:00.000Z" }),
      task({ id: "FN-7238", column: "todo", priority: "urgent", createdAt: "2026-06-02T00:00:00.000Z" }),
      task({ id: "FN-7239", column: "todo", priority: "normal", createdAt: "2026-06-01T00:00:00.000Z" }),
    ];

    expect(ids(sortTasksForDisplayColumn(tasks, "todo", "task-id-desc"))).toEqual([
      "FN-7238",
      "FN-7239",
      "FN-7240",
    ]);
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-29-00:00 (U12 — R8 drift conversion):
The hold lane's QUEUE ORDER must follow the hold trait, not the id `todo`.

Priority-then-FIFO is what makes a high-priority card visibly next in the lane where work
waits for capacity. Keyed on the id it degrades to the generic sort on any board whose
hold column is renamed — the card order is simply wrong, and nothing fails. U11 is what
separated the two questions: `todo` GAINED the hold trait, so "is this column named todo"
and "is this the lane work waits in" stopped being the same test.

REVERT CHECK, measured: restoring `if (column === "todo")` fails the renamed case below —
the high-priority card comes back second instead of first.
*/
describe("hold-lane queue order follows the hold TRAIT", () => {
  const mk = (id: string, priority: string, createdAt: string, column = "backlog") =>
    ({ id, title: id, priority, createdAt, column, steps: [], dependencies: [], log: [] } as never);

  /*
  THE DISCRIMINATOR IS THE TIEBREAK, not the priority. Both branches sort by priority
  first, so a priority difference proves nothing about which branch ran — my first attempt
  at this asserted exactly that and passed for the wrong reason.

  What is unique to the hold lane is FIFO: equal priority tiebreaks on `createdAt`, where
  the generic sort tiebreaks on task id. So these two carry the same priority and have
  createdAt order DISAGREEING with id order — FN-9 is older, FN-2 has the lower id.
    hold branch    -> FIFO      -> FN-9 first
    generic branch -> id ascending -> FN-2 first
  */
  const older = mk("FN-9", "normal", "2026-07-01T00:00:00.000Z");
  const newer = mk("FN-2", "normal", "2026-07-05T00:00:00.000Z");

  it("applies FIFO order on a RENAMED hold column when the trait is supplied", () => {
    const sorted = sortTasksForDisplayColumn([newer, older], "backlog" as never, undefined, false, true);
    expect(sorted.map((task) => task.id)).toEqual(["FN-9", "FN-2"]);
  });

  it("still applies it to the legacy `todo` id by default, for callers that resolve no flags", () => {
    // Lane and ListView do not pass flags; the default keeps their behaviour unchanged.
    const sorted = sortTasksForDisplayColumn(
      [mk("FN-2", "normal", "2026-07-05T00:00:00.000Z", "todo"), mk("FN-9", "normal", "2026-07-01T00:00:00.000Z", "todo")],
      "todo" as never,
    );
    expect(sorted.map((task) => task.id)).toEqual(["FN-9", "FN-2"]);
  });

  it("does NOT apply FIFO to a non-hold column, which sorts by id", () => {
    // The narrowing guard: without it, a function that FIFO-sorted everything would pass
    // the cases above while silently reordering the in-progress and review lanes.
    const sorted = sortTasksForDisplayColumn([newer, older], "building" as never, undefined, false, false);
    expect(sorted.map((task) => task.id)).toEqual(["FN-2", "FN-9"]);
  });

  it("keeps priority ahead of FIFO in the hold lane", () => {
    // FIFO is the tiebreak, not the primary key: a newer high-priority card still leads.
    const high = mk("FN-3", "high", "2026-07-09T00:00:00.000Z");
    const sorted = sortTasksForDisplayColumn([older, high], "backlog" as never, undefined, false, true);
    expect(sorted.map((task) => task.id)).toEqual(["FN-3", "FN-9"]);
  });
});

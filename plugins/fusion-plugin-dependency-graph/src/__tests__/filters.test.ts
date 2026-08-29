import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { EXCLUDED_COLUMNS, filterGraphTasks, INCLUDED_COLUMNS } from "../filters";

function createTask(id: string, column: Task["column"], dependencies: string[] = []): Task {
  return {
    id,
    description: `Task ${id}`,
    column,
    dependencies,
    steps: [],
    currentStep: 0,
    log: [],
  } as Task;
}

describe("filterGraphTasks", () => {
  it("returns empty for empty input", () => {
    expect(filterGraphTasks([])).toEqual([]);
  });

  it("includes tasks from all included columns", () => {
    const tasks = Array.from(INCLUDED_COLUMNS).map((column, index) => createTask(`FN-${index + 1}`, column));

    expect(filterGraphTasks(tasks)).toEqual(tasks);
  });

  it("returns empty when only excluded columns are present", () => {
    const tasks = Array.from(EXCLUDED_COLUMNS).map((column, index) => createTask(`FN-${index + 1}`, column));

    expect(filterGraphTasks(tasks)).toEqual([]);
  });

  it("includes and excludes exact columns for mixed input", () => {
    const tasks = [
      createTask("FN-1", "triage"),
      createTask("FN-2", "todo"),
      createTask("FN-3", "in-progress"),
      createTask("FN-4", "in-review"),
      createTask("FN-5", "done"),
      createTask("FN-6", "archived"),
    ];

    expect(filterGraphTasks(tasks).map((task) => task.id)).toEqual(["FN-1", "FN-2", "FN-3", "FN-4"]);
  });

  it.each([
    ["triage", true],
    ["todo", true],
    ["in-progress", true],
    ["in-review", true],
    ["done", false],
    ["archived", false],
  ] as const)("column %s inclusion=%s", (column, included) => {
    const task = createTask("FN-1", column);
    const result = filterGraphTasks([task]);

    expect(result.length > 0).toBe(included);
  });

  it("gracefully excludes tasks with invalid columns", () => {
    const invalidTask = {
      ...createTask("FN-invalid", "todo"),
      column: undefined,
    } as unknown as Task;

    expect(filterGraphTasks([invalidTask])).toEqual([]);
  });

  /*
  FNXC:WorkflowLifecycleColumns 2026-07-30-23:05:
  THE INVARIANT: a card in a lane this filter has never heard of is still a graph node.

  Reverted to the `INCLUDED_COLUMNS` allowlist, this case returns `[]` for three live cards — which is
  what a renamed board got: an entirely blank dependency graph, indistinguishable from "no dependencies".

  Every case above stays green either way, which is the point: they only ever enumerate the six legacy
  ids, so the allowlist and the denylist agree on all of them. Nothing here could see the blackout.
  */
  it("renders cards from lanes it does not recognise, instead of blanking the graph", () => {
    const renamed = [
      createTask("FN-1", "backlog" as Task["column"]),
      createTask("FN-2", "building" as Task["column"]),
      createTask("FN-3", "checking" as Task["column"]),
    ];

    expect(filterGraphTasks(renamed).map((task) => task.id)).toEqual(["FN-1", "FN-2", "FN-3"]);
  });

  it("still drops finished lanes when the rest of the board is renamed", () => {
    const mixed = [
      createTask("FN-1", "building" as Task["column"]),
      createTask("FN-2", "done"),
      createTask("FN-3", "archived"),
    ];

    expect(filterGraphTasks(mixed).map((task) => task.id)).toEqual(["FN-1"]);
  });

  it("excludes an empty-string column, which names no lane at all", () => {
    expect(filterGraphTasks([createTask("FN-1", "" as Task["column"])])).toEqual([]);
  });

  it("preserves task object identity", () => {
    const taskA = createTask("FN-1", "todo");
    const taskB = createTask("FN-2", "in-review");
    const result = filterGraphTasks([taskA, taskB]);

    expect(result[0]).toBe(taskA);
    expect(result[1]).toBe(taskB);
  });
});

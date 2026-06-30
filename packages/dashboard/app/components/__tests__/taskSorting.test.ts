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

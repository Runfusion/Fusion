import { describe, expect, it } from "vitest";
import {
  compareTaskPriority,
  compareTasksByPriorityThenAgeAndId,
  getTaskPriorityRank,
  isTaskPriority,
  normalizeTaskPriority,
  sortTasksByPriorityThenAgeAndId,
  sortTasksByPriorityFanoutThenAgeAndId,
  compareTasksByPriorityFanoutThenAgeAndId,
  buildUnblockWeightMap,
  compareTaskIdNumeric,
  sortTasksForDisplayColumn,
} from "../tasks/task-priority.js";
import {
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITIES,
  type Task,
  type TaskPriority,
} from "../types.js";
import type { PrCheckState, PrCheckStatus } from "../index.js";
import * as core from "../index.js";

describe("task-priority", () => {
  it("defines the bounded priority contract in order", () => {
    expect(TASK_PRIORITIES).toEqual(["low", "normal", "high", "urgent"]);
    expect(DEFAULT_TASK_PRIORITY).toBe("normal");
  });

  it("normalizes missing or invalid values to default", () => {
    expect(normalizeTaskPriority(undefined)).toBe("normal");
    expect(normalizeTaskPriority(null)).toBe("normal");
    expect(normalizeTaskPriority("")).toBe("normal");
  });

  it("identifies valid task priorities", () => {
    for (const value of TASK_PRIORITIES) {
      expect(isTaskPriority(value)).toBe(true);
    }
    expect(isTaskPriority("in_progress")).toBe(false);
  });

  it("provides deterministic ranks and priority comparator", () => {
    const orderedByRank: TaskPriority[] = ["low", "normal", "high", "urgent"];
    expect(orderedByRank.map((priority) => getTaskPriorityRank(priority))).toEqual([0, 1, 2, 3]);
    expect(compareTaskPriority("urgent", "low")).toBeLessThan(0);
    expect(compareTaskPriority(undefined, "normal")).toBe(0);
  });

  it("sorts tasks by priority desc then createdAt asc then id asc", () => {
    const tasks = [
      { id: "FN-002", createdAt: "2026-01-01T00:00:00.000Z", priority: "high" as TaskPriority },
      { id: "FN-001", createdAt: "2026-01-01T00:00:00.000Z", priority: "high" as TaskPriority },
      { id: "FN-009", createdAt: "2026-01-02T00:00:00.000Z", priority: "urgent" as TaskPriority },
      { id: "FN-003", createdAt: "2026-01-01T00:00:00.000Z", priority: undefined },
    ];

    const sorted = sortTasksByPriorityThenAgeAndId(tasks);
    expect(sorted.map((task) => task.id)).toEqual(["FN-009", "FN-001", "FN-002", "FN-003"]);

    // comparator function should match sorted behavior
    expect(compareTasksByPriorityThenAgeAndId(tasks[0], tasks[1])).toBeGreaterThan(0);
  });

  it("compares numeric IDs with locale fallback", () => {
    expect(compareTaskIdNumeric("FN-2", "FN-10")).toBeLessThan(0);
    expect(compareTaskIdNumeric("TASK-B", "TASK-A")).toBeGreaterThan(0);
  });

  it("prefers higher fanout tasks within the same priority", () => {
    const tasks = [
      { id: "FN-2", createdAt: "2026-01-01T00:00:00.000Z", priority: "normal" as const },
      { id: "FN-1", createdAt: "2026-01-01T00:00:00.000Z", priority: "normal" as const },
    ];

    const sorted = sortTasksByPriorityFanoutThenAgeAndId(tasks, new Map([["FN-2", 3], ["FN-1", 1]]));
    expect(sorted.map((task) => task.id)).toEqual(["FN-2", "FN-1"]);
  });

  it("keeps urgent ahead of lower priority regardless of fanout", () => {
    const urgent = { id: "FN-10", createdAt: "2026-01-01T00:00:00.000Z", priority: "urgent" as const };
    const high = { id: "FN-11", createdAt: "2026-01-01T00:00:00.000Z", priority: "high" as const };

    const cmp = compareTasksByPriorityFanoutThenAgeAndId(urgent, high, {
      unblockWeights: new Map([["FN-11", 9_999]]),
    });
    expect(cmp).toBeLessThan(0);
  });

  it("falls back to createdAt then id when fanout ties", () => {
    const tasks = [
      { id: "FN-9", createdAt: "2026-01-01T00:00:00.000Z", priority: "normal" as const },
      { id: "FN-8", createdAt: "2026-01-01T00:00:00.000Z", priority: "normal" as const },
      { id: "FN-7", createdAt: "2025-12-31T00:00:00.000Z", priority: "normal" as const },
    ];

    const sorted = sortTasksByPriorityFanoutThenAgeAndId(tasks, new Map([["FN-9", 2], ["FN-8", 2], ["FN-7", 2]]));
    expect(sorted.map((task) => task.id)).toEqual(["FN-7", "FN-8", "FN-9"]);
  });

  it("uses zero weight for tasks without dependents and preserves legacy tie behavior", () => {
    const tasks = [
      { id: "FN-2", createdAt: "2026-01-01T00:00:00.000Z", priority: "normal" as const },
      { id: "FN-1", createdAt: "2026-01-01T00:00:00.000Z", priority: "normal" as const },
    ];

    const sorted = sortTasksByPriorityFanoutThenAgeAndId(tasks, new Map());
    expect(sorted.map((task) => task.id)).toEqual(["FN-1", "FN-2"]);
  });

  it("buildUnblockWeightMap ignores done/archived dependents", () => {
    const makeTask = (task: Partial<Task> & Pick<Task, "id" | "column" | "createdAt" | "updatedAt" | "description">): Task => ({
      id: task.id,
      description: task.description,
      column: task.column,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      dependencies: task.dependencies ?? [],
      steps: [],
      currentStep: 1,
      log: [],
      ...task,
    });

    const tasks: Task[] = [
      makeTask({ id: "FN-1", description: "blocker", column: "todo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeTask({ id: "FN-2", description: "active dependent", column: "todo", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", dependencies: ["FN-1"] }),
      makeTask({ id: "FN-3", description: "done dependent", column: "done", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", dependencies: ["FN-1"] }),
      makeTask({ id: "FN-4", description: "archived dependent", column: "archived", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", dependencies: ["FN-1"] }),
    ];

    const weights = buildUnblockWeightMap(tasks);
    expect(weights.get("FN-1")).toBe(1_000_001);
  });

  it("applies board/list default ordering semantics by column", () => {
    const base = {
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      columnMovedAt: "2026-01-01T00:00:00.000Z",
    };

    const todoSorted = sortTasksForDisplayColumn([
      { ...base, id: "FN-003", column: "todo", priority: "low" as TaskPriority, createdAt: "2026-01-01T00:00:00.000Z" },
      { ...base, id: "FN-001", column: "todo", priority: "urgent" as TaskPriority, createdAt: "2026-01-02T00:00:00.000Z" },
      { ...base, id: "FN-002", column: "todo", priority: "high" as TaskPriority, createdAt: "2026-01-01T12:00:00.000Z" },
    ], "todo");
    expect(todoSorted.map((task) => task.id)).toEqual(["FN-001", "FN-002", "FN-003"]);

    const inReviewSorted = sortTasksForDisplayColumn([
      { ...base, id: "FN-010", column: "in-review", status: "review-ready", priority: "urgent" as TaskPriority },
      { ...base, id: "FN-011", column: "in-review", status: "merging-fix", priority: "high" as TaskPriority },
    ], "in-review");
    expect(inReviewSorted.map((task) => task.id)).toEqual(["FN-011", "FN-010"]);

    const doneSorted = sortTasksForDisplayColumn([
      { ...base, id: "FN-020", column: "done", priority: "urgent" as TaskPriority, columnMovedAt: "2026-01-01T08:00:00.000Z" },
      { ...base, id: "FN-021", column: "done", priority: "low" as TaskPriority, columnMovedAt: "2026-01-01T09:00:00.000Z" },
    ], "done");
    expect(doneSorted.map((task) => task.id)).toEqual(["FN-021", "FN-020"]);
  });

  it("re-exports PR check types from the core index", () => {
    const state: PrCheckState = "success";
    const check: PrCheckStatus = { name: "build", required: true, state };
    expect(check.state).toBe("success");
  });

  it("re-exports priority helpers from the core index", () => {
    expect(core.TASK_PRIORITIES).toEqual(TASK_PRIORITIES);
    expect(core.DEFAULT_TASK_PRIORITY).toBe("normal");
    expect(core.normalizeTaskPriority("bogus")).toBe(DEFAULT_TASK_PRIORITY);
    expect(typeof core.sortTasksForDisplayColumn).toBe("function");
  });
});

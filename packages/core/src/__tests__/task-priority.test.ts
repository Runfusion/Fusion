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

  it("buildUnblockWeightMap ignores completed dependents", () => {
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

/*
FNXC:TaskDisplaySorting 2026-08-03-22:53:
These cases are the shared contract formerly split between core-only and dashboard-only sorters.
Every board surface now supplies this API with resolved flags, while missing workflow metadata falls
back to legacy ids. Complete history is newest-first without mutating the server page.
*/
describe("sortTasksForDisplayColumn shared display contract", () => {
  const task = (id: string, overrides: Partial<Task> = {}) => ({
    id,
    column: "building",
    status: "idle",
    priority: "normal" as TaskPriority,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  });
  const ids = (tasks: readonly { id: string }[]) => tasks.map((entry) => entry.id);

  it("returns a new empty array and sorts Complete history newest-first without mutation", () => {
    const empty: Array<ReturnType<typeof task>> = [];
    expect(sortTasksForDisplayColumn(empty, "done", { columnFlags: { complete: true } })).toEqual([]);
    expect(sortTasksForDisplayColumn(empty, "done", { columnFlags: { complete: true } })).not.toBe(empty);

    const completed = [
      task("FN-3", { priority: "urgent", columnMovedAt: "2026-06-01T00:00:00.000Z" }),
      task("FN-1", { priority: "low", columnMovedAt: "2026-06-02T00:00:00.000Z" }),
    ];
    const snapshot = [...completed];
    expect(ids(sortTasksForDisplayColumn(completed, "done", { columnFlags: { complete: true } }))).toEqual(["FN-1", "FN-3"]);
    expect(completed).toEqual(snapshot);
  });

  it("uses priority then FIFO for legacy and custom hold columns", () => {
    const tasks = [
      task("FN-2", { createdAt: "2026-06-02T00:00:00.000Z" }),
      task("FN-9", { createdAt: "2026-06-01T00:00:00.000Z" }),
      task("FN-1", { priority: "urgent", createdAt: "2026-06-03T00:00:00.000Z" }),
    ];
    expect(ids(sortTasksForDisplayColumn(tasks, "todo"))).toEqual(["FN-1", "FN-9", "FN-2"]);
    expect(ids(sortTasksForDisplayColumn(tasks, "backlog", { columnFlags: { hold: true } }))).toEqual(["FN-1", "FN-9", "FN-2"]);
  });

  it("applies an explicit generic mode to hold, review, and custom columns without mutation", () => {
    const tasks = [
      task("FN-2", { priority: "urgent", status: "merging-fix", columnMovedAt: "2026-06-02T00:00:00.000Z" }),
      task("FN-10", { priority: "low", status: "idle", columnMovedAt: "2026-06-03T00:00:00.000Z" }),
      task("TASK-alpha", { priority: "high", status: "idle", updatedAt: "2026-06-04T00:00:00.000Z", columnMovedAt: undefined }),
      task("TASK-beta", { priority: "normal", status: "idle", updatedAt: undefined, createdAt: "2026-06-05T00:00:00.000Z", columnMovedAt: undefined }),
    ];
    const snapshot = structuredClone(tasks);
    expect(ids(sortTasksForDisplayColumn(tasks, "todo", { columnFlags: { hold: true }, sortMode: "completion-date-desc" }))).toEqual(["TASK-beta", "TASK-alpha", "FN-10", "FN-2"]);
    expect(ids(sortTasksForDisplayColumn(tasks, "review", { columnFlags: { humanReview: true }, sortMode: "task-id-desc" }))).toEqual(["TASK-beta", "TASK-alpha", "FN-10", "FN-2"]);
    expect(tasks).toEqual(snapshot);
  });

  it("supports both complete-column modes with deterministic invalid-date and nonnumeric-id ties", () => {
    const tasks = [
      task("TASK-alpha", { createdAt: "not-a-date", updatedAt: undefined }),
      task("FN-10", { columnMovedAt: "2026-06-03T00:00:00.000Z" }),
      task("FN-2", { columnMovedAt: "2026-06-03T00:00:00.000Z" }),
      task("TASK-charlie", { createdAt: "also-not-a-date", updatedAt: undefined }),
    ];
    const options = { columnFlags: { complete: true } };
    expect(ids(sortTasksForDisplayColumn(tasks, "shipped", options))).toEqual(["FN-2", "FN-10", "TASK-alpha", "TASK-charlie"]);
    expect(ids(sortTasksForDisplayColumn(tasks, "shipped", { ...options, doneSortMode: "task-id-desc" }))).toEqual(["TASK-charlie", "TASK-alpha", "FN-10", "FN-2"]);
  });

  it("floats active merges in review columns and otherwise uses priority then numeric id", () => {
    const reviewTasks = [
      task("FN-10", { priority: "urgent", status: "review-ready" }),
      task("FN-11", { priority: "low", status: "merging-fix" }),
    ];
    expect(ids(sortTasksForDisplayColumn(reviewTasks, "signoff", { columnFlags: { mergeBlocker: true } }))).toEqual(["FN-11", "FN-10"]);

    const ordinary = [task("FN-10", { priority: "normal" }), task("FN-2", { priority: "normal" })];
    expect(ids(sortTasksForDisplayColumn(ordinary, "building", { columnFlags: {} }))).toEqual(["FN-2", "FN-10"]);
  });
});

/*
FNXC:WorkflowLifecycleColumns 2026-07-27-22:05 (Phase B / U6 — vocabulary conversion):
RED-GREEN PROOF for `UNBLOCK_ACTIVE_COLUMNS` in `buildUnblockWeightMap`, written
before the conversion. Same enumeration bug as blocker-fanout's ACTIVE_COLUMNS,
same fix: active is NOT complete and NOT archived. The module already had a
`DONE_COLUMNS` set expressing exactly that exclusion for dependency counting, so
the two halves of one concept were encoded twice and disagreed for any custom
column — an unblock weight silently scored 0 for a renamed workflow.
*/
describe("buildUnblockWeightMap — active is 'not terminal', not an enumeration (U6)", () => {
  function t(id: string, column: string, dependencies: string[] = []): Task {
    return {
      id, column, dependencies,
      title: id, description: "", priority: "normal", steps: [],
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
      columnMovedAt: "2026-07-01T00:00:00.000Z",
    } as unknown as Task;
  }

  it("weights a blocker with a DEFAULT-workflow active dependent (regression floor)", () => {
    const weights = buildUnblockWeightMap([t("FN-1", "in-review"), t("FN-2", "todo", ["FN-1"])]);
    expect(weights.get("FN-1")).toBeGreaterThan(0);
  });

  it("weights a blocker whose dependent sits in a RENAMED active column", () => {
    // Against the enumeration this scored 0: `drafting` is in no legacy set, so
    // the blocker looked like it was unblocking nobody.
    const weights = buildUnblockWeightMap(
      [t("FN-1", "editorial-review"), t("FN-2", "drafting", ["FN-1"])],
      { terminalColumns: new Set(["published", "shelved"]) },
    );
    expect(weights.get("FN-1")).toBeGreaterThan(0);
  });

  it("does NOT weight a dependent sitting in the renamed workflow's terminal column", () => {
    const weights = buildUnblockWeightMap(
      [t("FN-1", "editorial-review"), t("FN-2", "published", ["FN-1"])],
      { terminalColumns: new Set(["published", "shelved"]) },
    );
    expect(weights.get("FN-1") ?? 0).toBe(0);
  });
});

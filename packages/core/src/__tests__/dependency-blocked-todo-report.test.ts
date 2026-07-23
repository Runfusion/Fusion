import { describe, expect, it } from "vitest";
import {
  computeDependencyBlockedTodoReport,
  DEFAULT_DEPENDENCY_BLOCKED_TODO_FRESH_MS,
} from "../tasks/dependency-blocked-todo-report.js";
import type { Task } from "../types.js";

const MAX_AUTO_MERGE_RETRIES = 3;
const NOW_ISO = "2026-01-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function createTask(id: string, column: Task["column"], overrides: Partial<Task> = {}): Task {
  return {
    id,
    description: id,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeDependencyBlockedTodoReport", () => {
  it("returns an empty report for empty input", () => {
    const report = computeDependencyBlockedTodoReport([], MAX_AUTO_MERGE_RETRIES, { now: NOW_MS });
    expect(report.totalBlockedTodoCount).toBe(0);
    expect(report.uniqueBlockerCount).toBe(0);
    expect(report.groups).toEqual([]);
  });

  it("reports dependency-linked todo tasks under one blocker", () => {
    const tasks = [
      createTask("FN-5090", "in-progress"),
      createTask("FN-5034", "todo", { dependencies: ["FN-5090"] }),
      createTask("FN-5085", "todo", { dependencies: ["FN-5090"] }),
      createTask("FN-5089", "todo", { dependencies: ["FN-5090"] }),
    ];

    const report = computeDependencyBlockedTodoReport(tasks, MAX_AUTO_MERGE_RETRIES, { now: NOW_MS });
    expect(report.uniqueBlockerCount).toBe(1);
    expect(report.groups[0]).toMatchObject({
      blockerId: "FN-5090",
      blockedTodoCount: 3,
      viaDependencies: ["FN-5034", "FN-5085", "FN-5089"],
      viaBlockedBy: [],
      blockedTodoIds: ["FN-5034", "FN-5085", "FN-5089"],
    });
  });

  it("dedupes todos across dependencies and blockedBy overlap", () => {
    const tasks = [
      createTask("B", "in-progress"),
      createTask("T1", "todo", { dependencies: ["B"] }),
      createTask("T2", "todo", { blockedBy: "B", dependencies: ["B"] }),
    ];

    const report = computeDependencyBlockedTodoReport(tasks, MAX_AUTO_MERGE_RETRIES, { now: NOW_MS });
    expect(report.groups[0]?.viaDependencies).toEqual(["T1", "T2"]);
    expect(report.groups[0]?.viaBlockedBy).toEqual(["T2"]);
    expect(report.groups[0]?.blockedTodoIds).toEqual(["T1", "T2"]);
    expect(report.groups[0]?.blockedTodoCount).toBe(2);
  });

  it("classifies age buckets as fresh, aging, and stale", () => {
    const tasks = [
      createTask("fresh", "in-progress", { columnMovedAt: "2026-01-01T11:55:00.000Z" }),
      createTask("aging", "in-progress", { columnMovedAt: "2026-01-01T11:00:00.000Z" }),
      createTask("stale", "in-progress", { columnMovedAt: "2026-01-01T06:00:00.000Z" }),
      createTask("tf", "todo", { dependencies: ["fresh"] }),
      createTask("ta", "todo", { dependencies: ["aging"] }),
      createTask("ts", "todo", { dependencies: ["stale"] }),
    ];

    const report = computeDependencyBlockedTodoReport(tasks, MAX_AUTO_MERGE_RETRIES, { now: NOW_MS });
    const byId = new Map(report.groups.map((group) => [group.blockerId, group.ageBucket]));
    expect(byId.get("fresh")).toBe("fresh");
    expect(byId.get("aging")).toBe("aging");
    expect(byId.get("stale")).toBe("stale");
  });

  it("sorts by age bucket priority then count then age then id", () => {
    const tasks = [
      createTask("A-stale-older", "in-progress", { columnMovedAt: "2026-01-01T03:00:00.000Z" }),
      createTask("B-stale-more", "in-progress", { columnMovedAt: "2026-01-01T05:00:00.000Z" }),
      createTask("C-aging", "in-progress", { columnMovedAt: "2026-01-01T11:00:00.000Z" }),
      createTask("D-fresh", "in-progress", { columnMovedAt: "2026-01-01T11:50:00.000Z" }),
      createTask("t1", "todo", { dependencies: ["A-stale-older"] }),
      createTask("t2", "todo", { dependencies: ["B-stale-more"] }),
      createTask("t3", "todo", { dependencies: ["B-stale-more"] }),
      createTask("t4", "todo", { dependencies: ["C-aging"] }),
      createTask("t5", "todo", { dependencies: ["D-fresh"] }),
    ];

    const report = computeDependencyBlockedTodoReport(tasks, MAX_AUTO_MERGE_RETRIES, { now: NOW_MS });
    expect(report.groups.map((group) => group.blockerId)).toEqual(["B-stale-more", "A-stale-older", "C-aging", "D-fresh"]);
  });

  it("applies minBlockedTodoCount and maxGroups limits", () => {
    const tasks = [
      createTask("B1", "in-progress"),
      createTask("B2", "in-progress"),
      createTask("T1", "todo", { dependencies: ["B1"] }),
      createTask("T2", "todo", { dependencies: ["B1"] }),
      createTask("T3", "todo", { dependencies: ["B2"] }),
    ];

    const filtered = computeDependencyBlockedTodoReport(tasks, MAX_AUTO_MERGE_RETRIES, {
      now: NOW_MS,
      minBlockedTodoCount: 2,
    });
    expect(filtered.groups.map((group) => group.blockerId)).toEqual(["B1"]);

    const capped = computeDependencyBlockedTodoReport(tasks, MAX_AUTO_MERGE_RETRIES, {
      now: NOW_MS,
      maxGroups: 1,
    });
    expect(capped.groups).toHaveLength(1);
  });

  it("excludes done and archived blockers", () => {
    const tasks = [
      createTask("done-blocker", "done"),
      createTask("archived-blocker", "archived"),
      createTask("td", "todo", { dependencies: ["done-blocker"] }),
      createTask("ta", "todo", { dependencies: ["archived-blocker"] }),
    ];

    const report = computeDependencyBlockedTodoReport(tasks, MAX_AUTO_MERGE_RETRIES, { now: NOW_MS });
    expect(report.groups).toEqual([]);
  });

  it("sanitizes invalid thresholds", () => {
    const tasks = [
      createTask("B", "in-progress", { columnMovedAt: "2026-01-01T11:40:00.000Z" }),
      createTask("T", "todo", { dependencies: ["B"] }),
    ];

    const report = computeDependencyBlockedTodoReport(tasks, MAX_AUTO_MERGE_RETRIES, {
      now: NOW_MS,
      freshAgeMs: -100,
      staleAgeMs: 10,
      minBlockedTodoCount: 0,
      maxGroups: 0,
    });

    expect(report.thresholds.freshMs).toBe(DEFAULT_DEPENDENCY_BLOCKED_TODO_FRESH_MS);
    expect(report.thresholds.staleMs).toBe(DEFAULT_DEPENDENCY_BLOCKED_TODO_FRESH_MS + 1);
    expect(report.thresholds.minBlockedTodoCount).toBe(1);
    expect(report.groups).toHaveLength(1);
  });

  it("reproduces FN-5091 motivating fixture", () => {
    const tasks = [
      createTask("FN-5090", "in-progress"),
      createTask("FN-5034", "todo", { dependencies: ["FN-5090"] }),
      createTask("FN-5085", "todo", { dependencies: ["FN-5090"] }),
      createTask("FN-5089", "todo", { dependencies: ["FN-5090"] }),
    ];

    const report = computeDependencyBlockedTodoReport(tasks, MAX_AUTO_MERGE_RETRIES, { now: NOW_MS });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.blockerId).toBe("FN-5090");
    expect(report.groups[0]?.blockedTodoCount).toBe(3);
    expect(report.groups[0]?.blockedTodoIds).toEqual(["FN-5034", "FN-5085", "FN-5089"]);
    expect(report.observedAt).toBe(NOW_ISO);
  });
});

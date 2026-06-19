import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { computeBlockerFanoutMap, MAX_AUTO_MERGE_RETRIES } from "../useBlockerFanout";

function createTask(id: string, column: Task["column"], overrides: Partial<Task> = {}): Task {
  return {
    id,
    description: `Task ${id}`,
    column,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("computeBlockerFanoutMap", () => {
  it("returns an empty map for an empty task list", () => {
    expect(computeBlockerFanoutMap([]).size).toBe(0);
  });

  it("returns an empty map when no downstream dependencies exist", () => {
    const tasks = [createTask("FN-1", "todo"), createTask("FN-2", "done")];
    expect(computeBlockerFanoutMap(tasks).size).toBe(0);
  });

  it("tracks a single dependent via dependencies[]", () => {
    const tasks = [
      createTask("FN-1", "in-progress"),
      createTask("FN-2", "todo", { dependencies: ["FN-1"] }),
    ];

    expect(computeBlockerFanoutMap(tasks).get("FN-1")).toEqual({
      totalCount: 1,
      activeTodoCount: 1,
      dependentIds: ["FN-2"],
      dependencyDependentIds: ["FN-2"],
      overlapBlockedDependentIds: [],
      overlapBlockedActiveCount: 0,
      overlapBlockedTodoCount: 0,
      staleBlockedByDependentIds: [],
      isHighFanout: false,
      escalation: undefined,
    });
  });

  it("tracks mixed dependencies[] and blockedBy edges", () => {
    const tasks = [
      createTask("FN-1", "in-progress"),
      createTask("FN-2", "todo", { dependencies: ["FN-1"] }),
      createTask("FN-3", "in-review", { blockedBy: "FN-1" }),
    ];

    expect(computeBlockerFanoutMap(tasks).get("FN-1")).toEqual({
      totalCount: 2,
      activeTodoCount: 1,
      dependentIds: ["FN-2", "FN-3"],
      dependencyDependentIds: ["FN-2"],
      overlapBlockedDependentIds: ["FN-3"],
      overlapBlockedActiveCount: 1,
      overlapBlockedTodoCount: 0,
      staleBlockedByDependentIds: [],
      isHighFanout: false,
      escalation: undefined,
    });
  });

  it("marks stale blockedBy dependents only for blockedBy edges, not dependencies[]", () => {
    const tasks = [
      createTask("FN-2", "todo", { dependencies: ["MISSING"] }),
      createTask("FN-3", "todo", { blockedBy: "MISSING" }),
    ];

    expect(computeBlockerFanoutMap(tasks).get("MISSING")?.staleBlockedByDependentIds).toEqual(["FN-3"]);
  });

  it("flags overlap fan-out blockers with at least 5 blockedBy todo dependents as high fan-out", () => {
    const tasks = [
      createTask("B", "in-progress"),
      createTask("D1", "todo", { dependencies: ["B"] }),
      createTask("D2", "todo", { blockedBy: "B" }),
      createTask("D3", "todo", { blockedBy: "B" }),
      createTask("D4", "todo", { blockedBy: "B" }),
      createTask("D5", "todo", { blockedBy: "B" }),
      createTask("D6", "todo", { blockedBy: "B" }),
    ];

    expect(computeBlockerFanoutMap(tasks).get("B")?.isHighFanout).toBe(true);
  });

  it("does not flag dependency-only chains as overlap high fan-out", () => {
    const tasks = [
      createTask("B", "in-progress"),
      createTask("D1", "todo", { dependencies: ["B"] }),
      createTask("D2", "todo", { dependencies: ["B"] }),
      createTask("D3", "todo", { dependencies: ["B"] }),
      createTask("D4", "todo", { dependencies: ["B"] }),
      createTask("D5", "todo", { dependencies: ["B"] }),
    ];

    const entry = computeBlockerFanoutMap(tasks).get("B");
    expect(entry?.activeTodoCount).toBe(5);
    expect(entry?.overlapBlockedTodoCount).toBe(0);
    expect(entry?.isHighFanout).toBe(false);
  });

  it("escalates aged overlap high fan-out blockers only when old enough", () => {
    const tasks = [
      createTask("B", "in-progress", { columnMovedAt: "2026-01-01T00:00:00.000Z" }),
      createTask("D1", "todo", { blockedBy: "B" }),
      createTask("D2", "todo", { blockedBy: "B" }),
      createTask("D3", "todo", { blockedBy: "B" }),
      createTask("D4", "todo", { blockedBy: "B" }),
      createTask("D5", "todo", { blockedBy: "B" }),
    ];

    const entry = computeBlockerFanoutMap(tasks, {
      staleHighFanoutAgeThresholdMs: 60 * 60 * 1000,
    }).get("B");

    expect(entry?.isHighFanout).toBe(true);
    expect(entry?.escalation?.activeTodoCount).toBe(5);
  });

  it("keeps the dashboard fallback aligned with the documented self-healing default seed", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(testDir, "../../../../engine/src/self-healing.ts"), "utf8");
    const match = source.match(/export const MAX_AUTO_MERGE_RETRIES = (\d+);/);
    expect(match?.[1]).toBe(String(MAX_AUTO_MERGE_RETRIES));
    expect(source).toContain("SelfHealingManager must call resolveMaxAutoMergeRetries(settings)");
  });
});

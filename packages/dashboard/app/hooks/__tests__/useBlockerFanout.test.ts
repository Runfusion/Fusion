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
      staleBlockedByDependentIds: [],
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
      staleBlockedByDependentIds: [],
    });
  });

  it("excludes done/archived dependents from totalCount but keeps dependentIds", () => {
    const tasks = [
      createTask("FN-1", "in-progress"),
      createTask("FN-2", "done", { dependencies: ["FN-1"] }),
      createTask("FN-3", "archived", { blockedBy: "FN-1" }),
      createTask("FN-4", "todo", { dependencies: ["FN-1"] }),
    ];

    expect(computeBlockerFanoutMap(tasks).get("FN-1")).toEqual({
      totalCount: 1,
      activeTodoCount: 1,
      dependentIds: ["FN-2", "FN-3", "FN-4"],
      staleBlockedByDependentIds: [],
    });
  });

  it("marks stale blockedBy dependents only for blockedBy edges, not dependencies[]", () => {
    const tasks = [
      createTask("FN-2", "todo", { dependencies: ["MISSING"] }),
      createTask("FN-3", "todo", { blockedBy: "MISSING" }),
    ];

    expect(computeBlockerFanoutMap(tasks).get("MISSING")).toEqual({
      totalCount: 2,
      activeTodoCount: 2,
      dependentIds: ["FN-2", "FN-3"],
      staleBlockedByDependentIds: ["FN-3"],
    });
  });

  it("marks blockedBy edges stale when blocker is done", () => {
    const tasks = [createTask("B", "done"), createTask("D", "todo", { blockedBy: "B" })];
    expect(computeBlockerFanoutMap(tasks).get("B")?.staleBlockedByDependentIds).toEqual(["D"]);
  });

  it("marks blockedBy edges stale when blocker is archived", () => {
    const tasks = [createTask("B", "archived"), createTask("D", "todo", { blockedBy: "B" })];
    expect(computeBlockerFanoutMap(tasks).get("B")?.staleBlockedByDependentIds).toEqual(["D"]);
  });

  it("marks blockedBy edges stale when blocker is in-review and paused", () => {
    const tasks = [createTask("B", "in-review", { paused: true }), createTask("D", "todo", { blockedBy: "B" })];
    expect(computeBlockerFanoutMap(tasks).get("B")?.staleBlockedByDependentIds).toEqual(["D"]);
  });

  it("marks blockedBy edges stale when blocker failed in-review at max retries", () => {
    const tasks = [
      createTask("B", "in-review", { status: "failed", mergeRetries: MAX_AUTO_MERGE_RETRIES }),
      createTask("D", "todo", { blockedBy: "B" }),
    ];
    expect(computeBlockerFanoutMap(tasks).get("B")?.staleBlockedByDependentIds).toEqual(["D"]);
  });

  it("FN-3897 regression: reports active and todo downstream counts for high fan-out blockers", () => {
    const tasks = [
      createTask("B", "in-progress"),
      createTask("D1", "todo", { dependencies: ["B"] }),
      createTask("D2", "todo", { blockedBy: "B" }),
      createTask("D3", "in-review", { dependencies: ["B"] }),
      createTask("D4", "done", { dependencies: ["B"] }),
    ];

    expect(computeBlockerFanoutMap(tasks).get("B")).toEqual({
      totalCount: 3,
      activeTodoCount: 2,
      dependentIds: ["D1", "D2", "D3", "D4"],
      staleBlockedByDependentIds: [],
    });
  });

  it("keeps MAX_AUTO_MERGE_RETRIES aligned with engine self-healing source", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(testDir, "../../../../engine/src/self-healing.ts"), "utf8");
    const match = source.match(/const MAX_AUTO_MERGE_RETRIES = (\d+);/);
    expect(match?.[1]).toBe(String(MAX_AUTO_MERGE_RETRIES));
  });
});

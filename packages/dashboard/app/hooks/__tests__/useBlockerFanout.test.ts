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
    /*
    FNXC:DashboardTests 2026-07-17-11:45:
    Wave-8 peeled MAX_AUTO_MERGE_RETRIES into self-healing-constants.ts (re-exported
    from self-healing.ts). Read the constant definition file so this alignment
    guard still pins the dashboard seed to the engine default of 3.
    */
    const constantsSource = readFileSync(resolve(testDir, "../../../../engine/src/self-healing-constants.ts"), "utf8");
    const match = constantsSource.match(/export const MAX_AUTO_MERGE_RETRIES = (\d+);/);
    expect(match?.[1]).toBe(String(MAX_AUTO_MERGE_RETRIES));
    const source = readFileSync(resolve(testDir, "../../../../engine/src/self-healing.ts"), "utf8");
    expect(source).toContain("SelfHealingManager must call resolveMaxAutoMergeRetries(settings)");
  });
});


/*
FNXC:WorkflowResolvedColumns 2026-07-30-23:30:
The dashboard wrapper passed core NO lane answers, so every fan-out surface classified against
`todo` / `in-review` / `done`. Core defines ACTIVE by exclusion — not terminal — so on a renamed
board a FINISHED card never became terminal and stayed an active blocker forever.

The board below is the built-in vocabulary renamed and nothing else, which is the point: every case
above passes either way because `done` satisfies the literal default.
*/
describe("computeBlockerFanoutMap on a RENAMED board", () => {
  const shippedFlags = { complete: true };
  const draftingFlags = { hold: true };
  const buildingFlags = { countsTowardWip: true };

  it("does NOT count a dependent of a FINISHED card as active", () => {
    const blocker = createTask("FN-BLOCKER", "shipped");
    const dependent = createTask("FN-DEPENDENT", "drafting", { dependencies: ["FN-BLOCKER"] });
    const flags = new Map([
      ["FN-BLOCKER", shippedFlags],
      ["FN-DEPENDENT", draftingFlags],
    ]);

    const withLanes = computeBlockerFanoutMap([blocker, dependent], { columnFlagsByTaskId: flags });
    const withoutLanes = computeBlockerFanoutMap([blocker, dependent]);

    /* The dependent rests in the board's HOLD lane, so it is counted there — not as a legacy todo. */
    expect(withLanes.get("FN-BLOCKER")?.activeTodoCount).toBe(1);
    /* Unresolved, `drafting` is not `todo`, so the same card lands in neither bucket correctly. */
    expect(withoutLanes.get("FN-BLOCKER")?.activeTodoCount).toBe(0);
  });

  it("counts a dependent in a renamed WIP lane as active", () => {
    const blocker = createTask("FN-BLOCKER", "building");
    const dependent = createTask("FN-DEPENDENT", "building", { dependencies: ["FN-BLOCKER"] });
    const flags = new Map([
      ["FN-BLOCKER", buildingFlags],
      ["FN-DEPENDENT", buildingFlags],
    ]);

    /* `totalCount` is the ACTIVE count — active is "not terminal". */
    expect(computeBlockerFanoutMap([blocker, dependent], { columnFlagsByTaskId: flags })
      .get("FN-BLOCKER")?.totalCount).toBe(1);
  });

  it("escalates a stale high-fan-out blocker resting in a renamed WIP lane", () => {
    /*
    The sharpest consequence: `shouldEscalate` requires the blocker to be in an ESCALATION lane
    (wip ∪ review). Unresolved, `building` is neither `in-progress` nor `in-review`, so escalation
    was false for every blocker on a renamed board — a stale blocker holding up many cards never
    escalated. The fan-out numbers stayed correct, which is what makes it easy to miss: the metric
    says there is a problem and the mechanism that acts on it is switched off.
    */
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const blocker = createTask("FN-BLOCKER", "building", {
      columnMovedAt: threeHoursAgo,
      updatedAt: threeHoursAgo,
    });
    /* HIGH_FANOUT_BLOCKER_TODO_THRESHOLD is 5, counted via `blockedBy` in the HOLD lane. */
    const dependents = Array.from({ length: 5 }, (_, i) =>
      createTask(`FN-DEP-${i}`, "drafting", { blockedBy: "FN-BLOCKER" }));
    const flags = new Map<string, { complete?: boolean; hold?: boolean; countsTowardWip?: boolean }>([
      ["FN-BLOCKER", buildingFlags],
      ...dependents.map((task) => [task.id, draftingFlags] as const),
    ]);
    const tasks = [blocker, ...dependents];

    expect(computeBlockerFanoutMap(tasks, { columnFlagsByTaskId: flags }).get("FN-BLOCKER")?.escalation)
      .toBeDefined();
    /* Same board, no resolved traits: not high fan-out (nothing is in `todo`) and never escalates. */
    expect(computeBlockerFanoutMap(tasks).get("FN-BLOCKER")?.escalation).toBeUndefined();
  });

  it("is byte-identical when no traits resolved (the pre-load window)", () => {
    const tasks = [
      createTask("FN-1", "in-progress"),
      createTask("FN-2", "todo", { dependencies: ["FN-1"] }),
    ];

    expect(computeBlockerFanoutMap(tasks, { columnFlagsByTaskId: new Map() }).get("FN-1"))
      .toEqual(computeBlockerFanoutMap(tasks).get("FN-1"));
  });
});

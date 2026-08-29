/**
 * FNXC:GoalStore 2026-06-27-18:30:
 * PostgreSQL integration coverage for the GoalStore port. `store.getGoalStore()`
 * previously THREW / 503'd in PG backend mode (the dashboard /api/goals routes
 * degraded); it now returns the AsyncDataLayer-backed AsyncGoalStore. This drives
 * the real wiring (getGoalStoreImpl → AsyncGoalStore) through the shared PG harness
 * and asserts the full goal lifecycle: create → get → list({status}), archive
 * moves a goal out of the active set and into the archived set, unarchive restores
 * it, updateGoal patches the title, and the ACTIVE_GOAL_LIMIT hard cap rejects an
 * over-limit create. Runs in the blocking gate (test:pg-gate).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { ACTIVE_GOAL_LIMIT } from "../../goals/goal-types.js";
import type { AsyncGoalStore } from "../../async-stores/async-goal-store.js";

const pgTest = pgDescribe;

pgTest("GoalStore (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_goal_store",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // In backend mode getGoalStore() returns AsyncGoalStore (async methods).
  const goals = (): AsyncGoalStore => h.store().getGoalStore() as AsyncGoalStore;

  it("does not throw when resolving the store in backend mode", () => {
    expect(h.store().backendMode).toBe(true);
    expect(() => goals()).not.toThrow();
  });

  it("create → get → list({status:'active'}) round-trip persists to project.goals", async () => {
    const g = goals();
    const created = await g.createGoal({ title: "Ship the product", description: "v1 launch" });
    expect(created.id).toMatch(/^G-/);
    expect(created.status).toBe("active");

    const fetched = await g.getGoal(created.id);
    expect(fetched?.title).toBe("Ship the product");
    expect(fetched?.description).toBe("v1 launch");

    const active = await g.listGoals({ status: "active" });
    expect(active.map((goal) => goal.id)).toContain(created.id);
  });

  it("archive moves a goal out of active and into archived; unarchive restores it", async () => {
    const g = goals();
    const created = await g.createGoal({ title: "Archivable" });

    const archived = await g.archiveGoal(created.id);
    expect(archived.status).toBe("archived");

    const activeIds = (await g.listGoals({ status: "active" })).map((goal) => goal.id);
    expect(activeIds).not.toContain(created.id);
    const archivedIds = (await g.listGoals({ status: "archived" })).map((goal) => goal.id);
    expect(archivedIds).toContain(created.id);

    const unarchived = await g.unarchiveGoal(created.id);
    expect(unarchived.status).toBe("active");
    const activeAfter = (await g.listGoals({ status: "active" })).map((goal) => goal.id);
    expect(activeAfter).toContain(created.id);
  });

  it("updateGoal patches the title", async () => {
    const g = goals();
    const created = await g.createGoal({ title: "Old title" });
    const updated = await g.updateGoal(created.id, { title: "New title" });
    expect(updated.title).toBe("New title");
    expect((await g.getGoal(created.id))?.title).toBe("New title");
  });

  it("enforces ACTIVE_GOAL_LIMIT — creating beyond the cap rejects", async () => {
    const g = goals();
    // One create already counts; fill the remaining active slots, then expect a reject.
    for (let i = 0; i < ACTIVE_GOAL_LIMIT; i++) {
      await g.createGoal({ title: `Goal ${i}` });
    }
    const activeCount = (await g.listGoals({ status: "active" })).length;
    expect(activeCount).toBe(ACTIVE_GOAL_LIMIT);
    await expect(g.createGoal({ title: "Over the cap" })).rejects.toThrow();
  });
});

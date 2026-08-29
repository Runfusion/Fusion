/**
 * FNXC:SqliteFinalRemoval 2026-06-26-10:10:
 * PostgreSQL-backed counterpart of store-task-age-staleness.test.ts.
 *
 * Validates that ageStaleness hydration works against PostgreSQL when listing
 * tasks. The original SQLite test seeded rows via createTaskWithReservedId +
 * raw db.prepare() UPDATE (to backdate columnMovedAt). createTaskWithReservedId
 * is not yet backend-mode-ready (deep SQLite dependency chain), so this PG twin
 * uses createTask (backend-ready) + adminDb UPDATE to backdate columnMovedAt.
 *
 * Advances VAL-CROSS-001 (task lifecycle on PostgreSQL).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";

const pgTest = pgDescribe;

pgTest("TaskStore ageStaleness hydration (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_age_staleness",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  /**
   * Create a task in the given column, then backdate its columnMovedAt +
   * createdAt via direct DB update so the ageStaleness hydration computes
   * the desired age. paused/mergeConfirmed are set via updateTask.
   */
  async function seedTask(
    suffix: string,
    overrides: { column: "in-progress" | "in-review" | "todo"; paused?: boolean; ageMs: number; mergeConfirmed?: boolean },
  ) {
    const now = Date.now();
    const movedAt = new Date(now - overrides.ageMs).toISOString();
    const store = h.store();
    const task = await store.createTask({ description: `staleness-${suffix}`, column: overrides.column });
    if (overrides.paused || overrides.mergeConfirmed) {
      await store.updateTask(task.id, {
        paused: overrides.paused ?? undefined,
        mergeDetails: overrides.mergeConfirmed ? { mergeConfirmed: true } : undefined,
      });
    }
    // Backdate the row directly AFTER any updateTask calls (which would reset
    // columnMovedAt from the in-memory cache). Clear the cache so listTasks
    // re-reads from the DB.
    await h
      .adminDb()
      .update(schema.project.tasks)
      .set({ columnMovedAt: movedAt, createdAt: movedAt, updatedAt: movedAt })
      .where(eq(schema.project.tasks.id, task.id));
    store.taskCache.delete(task.id);
    return task.id;
  }

  it("hydrates warning for stale in-progress", async () => {
    const id = await seedTask("warn", { column: "in-progress", ageMs: 4 * 60 * 60_000 + 1_000 });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === id);
    expect(task?.ageStaleness?.level).toBe("warning");
  });

  it("hydrates critical when over critical threshold", async () => {
    const id = await seedTask("crit", { column: "in-progress", ageMs: 24 * 60 * 60_000 + 1_000 });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === id);
    expect(task?.ageStaleness?.level).toBe("critical");
  });

  it("hydrates for paused in-review tasks", async () => {
    const id = await seedTask("paused", { column: "in-review", paused: true, ageMs: 24 * 60 * 60_000 + 1_000 });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === id);
    expect(task?.ageStaleness?.level).toBe("warning");
    expect(task?.ageStaleness?.paused).toBe(true);
  });

  it("omits signal for todo", async () => {
    const id = await seedTask("todo", { column: "todo", ageMs: 7 * 24 * 60 * 60_000 });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === id);
    expect(task?.ageStaleness).toBeUndefined();
  });

  it("respects settings overrides", async () => {
    const store = h.store();
    await store.updateSettings({ staleInProgressWarningMs: 1_000, staleInProgressCriticalMs: 2_000 });
    const id = await seedTask("override", { column: "in-progress", ageMs: 2_500 });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === id);
    expect(task?.ageStaleness?.level).toBe("critical");
  });

  it("omits signal when both levels are disabled", async () => {
    const store = h.store();
    await store.updateSettings({ staleInProgressWarningMs: 0, staleInProgressCriticalMs: 0 });
    const id = await seedTask("disabled", { column: "in-progress", ageMs: 48 * 60 * 60_000 });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === id);
    expect(task?.ageStaleness).toBeUndefined();
  });
});

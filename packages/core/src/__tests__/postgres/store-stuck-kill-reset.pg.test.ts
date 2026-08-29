/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of store-stuck-kill-reset.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness`. Validates stuck-kill streak reset
 * semantics work identically against PostgreSQL backend mode.
 */
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore.updateStep stuck-kill streak reset on forward progress (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_stuck_kill",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  const withStreak = async (streak: number) => {
    const store = h.store();
    const task = await h.createTaskWithSteps();
    await store.updateTask(task.id, { stuckKillCount: streak });
    return { store, task };
  };

  it("done clears the streak and logs the reset", async () => {
    const { store, task } = await withStreak(4);
    const updated = await store.updateStep(task.id, 0, "done");
    expect(updated.stuckKillCount ?? 0).toBe(0);
  });

  it("skipped clears the streak", async () => {
    const { store, task } = await withStreak(5);
    const updated = await store.updateStep(task.id, 0, "skipped");
    expect(updated.stuckKillCount ?? 0).toBe(0);
  });

  it("in-progress (step advance) does NOT clear the streak — only terminal forward progress does", async () => {
    const { store, task } = await withStreak(3);
    const updated = await store.updateStep(task.id, 0, "in-progress");
    expect(updated.stuckKillCount ?? 0).toBe(3);
  });

  it("an IGNORED out-of-order done does NOT clear the streak (no real progress)", async () => {
    const { store, task } = await withStreak(2);
    const updated = await store.updateStep(task.id, 2, "done");
    expect(updated.steps[2].status).toBe("pending");
    expect(updated.stuckKillCount ?? 0).toBe(2);
  });
});

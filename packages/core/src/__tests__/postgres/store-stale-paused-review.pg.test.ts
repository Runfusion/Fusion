/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of store-stale-paused-review.test.ts.
 *
 * Uses adminDb UPDATE to seed paused/mergeDetails/columnMovedAt (same pattern
 * as store-task-age-staleness.pg.test.ts). The original SQLite test remains
 * until SQLite is fully removed; this PG twin is auto-skipped in CI without
 * PostgreSQL (pgDescribe).
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

pgTest("TaskStore stalePausedReview hydration (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_stale_paused_review",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedTask(
    id: string,
    overrides: { paused?: boolean; ageMs?: number; column?: "in-review" | "todo"; mergeConfirmed?: boolean },
  ) {
    const store = h.store();
    const now = Date.now();
    const ageMs = overrides.ageMs ?? 24 * 60 * 60_000 + 1_000;
    const movedAt = new Date(now - ageMs).toISOString();
    const column = overrides.column ?? "in-review";
    await store.createTaskWithReservedId(
      { description: id, column },
      { taskId: id, createdAt: movedAt, updatedAt: movedAt, applyDefaultWorkflowSteps: false },
    );
    await h
      .adminDb()
      .update(schema.project.tasks)
      .set({
        paused: overrides.paused ? 1 : 0,
        mergeDetails: JSON.stringify(overrides.mergeConfirmed ? { mergeConfirmed: true } : {}),
        columnMovedAt: movedAt,
        updatedAt: movedAt,
      })
      .where(eq(schema.project.tasks.id, id));
    store.taskCache.delete(id);
  }

  it("hydrates stalePausedReview for paused in-review past threshold", async () => {
    await seedTask("FN-4452-A", { paused: true });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-4452-A");
    expect(task?.stalePausedReview?.code).toBe("stale-paused-review");
  });

  it("omits stalePausedReview under threshold", async () => {
    await seedTask("FN-4452-B", { paused: true, ageMs: 1_000 });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-4452-B");
    expect(task?.stalePausedReview).toBeUndefined();
  });

  it("omits stalePausedReview for non-paused tasks", async () => {
    await seedTask("FN-4452-C", { paused: false });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-4452-C");
    expect(task?.stalePausedReview).toBeUndefined();
  });

  it("respects stalePausedReviewThresholdMs setting override", async () => {
    const store = h.store();
    await store.updateSettings({ stalePausedReviewThresholdMs: 2_000 });
    await seedTask("FN-4452-D", { paused: true, ageMs: 2_500 });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-4452-D");
    expect(task?.stalePausedReview?.thresholdMs).toBe(2_000);
  });
});

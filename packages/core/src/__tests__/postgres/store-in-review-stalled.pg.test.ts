/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of store-in-review-stalled.test.ts.
 *
 * The SQLite version seeds paused/mergeDetails/columnMovedAt/log via raw
 * db.prepare('UPDATE tasks ...'). This PG twin uses createTaskWithReservedId +
 * adminDb UPDATE to set the exact internal state, since updateTask doesn't
 * accept all of these fields directly and columnMovedAt needs to be backdated.
 *
 * The original SQLite test remains until SQLite is fully removed; this PG twin
 * is auto-skipped in CI without PostgreSQL (pgDescribe).
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

pgTest("TaskStore inReviewStalled hydration (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_inreview_stalled",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedTask(
    id: string,
    overrides: {
      paused?: boolean;
      ageMs?: number;
      column?: "in-review" | "todo";
      mergeConfirmed?: boolean;
    },
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

  it("hydrates inReviewStalled for unpaused in-review task quiet beyond threshold", async () => {
    await seedTask("FN-5093-S1", { paused: false });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S1");
    expect(task?.inReviewStalled?.code).toBe("in-review-stalled");
  });

  it("respects inReviewStalledThresholdMs override", async () => {
    const store = h.store();
    await store.updateSettings({ inReviewStalledThresholdMs: 2_000 });
    await seedTask("FN-5093-S2", { paused: false, ageMs: 2_500 });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S2");
    expect(task?.inReviewStalled?.thresholdMs).toBe(2_000);
  });

  it("disables hydration when inReviewStalledThresholdMs is zero", async () => {
    const store = h.store();
    await store.updateSettings({ inReviewStalledThresholdMs: 0 });
    await seedTask("FN-5093-S3", { paused: false });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S3");
    expect(task?.inReviewStalled).toBeUndefined();
  });

  it("suppresses hydration when autoMerge is false", async () => {
    const store = h.store();
    await store.updateSettings({ autoMerge: false });
    await seedTask("FN-5093-S4", { paused: false });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S4");
    expect(task?.inReviewStalled).toBeUndefined();
  });

  it("does not overlap with stalePausedReview for paused in-review tasks", async () => {
    await seedTask("FN-5093-S5", { paused: true });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5093-S5");
    expect(task?.inReviewStalled).toBeUndefined();
    expect(task?.stalePausedReview?.code).toBe("stale-paused-review");
  });
});

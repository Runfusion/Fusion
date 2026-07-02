/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of store-stalled-review.test.ts.
 *
 * Exercises the stalledReview hydration signal on slim/full listings and
 * detail fetches, plus the merge-queue suppression path. All operations
 * (createTask, logEntry, listTasks, getTask, enqueueMergeQueue) go through
 * backend-mode async helpers.
 *
 * The original SQLite test remains until SQLite is fully removed; this PG twin
 * is auto-skipped in CI without PostgreSQL (pgDescribe).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore stalledReview hydration (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_stalled_review",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedStalledInReviewTask() {
    const store = h.store();
    const task = await store.createTask({
      description: "stalled review candidate",
      column: "in-review",
    });

    for (let i = 0; i < 3; i += 1) {
      await store.logEntry(task.id, "Auto-recovered: eligible in-review task re-enqueued for merge");
    }

    return task;
  }

  it("populates stalledReview on slim listings when reenqueue churn threshold is met", async () => {
    const task = await seedStalledInReviewTask();
    const store = h.store();

    const slimTasks = await store.listTasks({ slim: true, column: "in-review" });
    const hydrated = slimTasks.find((entry) => entry.id === task.id);

    expect(hydrated?.stalledReview?.heuristic).toBe("reenqueue-churn");
    expect(hydrated?.stalledReview?.matchCount).toBe(3);
  });

  it("populates stalledReview on full listings and detail fetches", async () => {
    const task = await seedStalledInReviewTask();
    const store = h.store();

    const fullTasks = await store.listTasks({ slim: false, column: "in-review" });
    const hydrated = fullTasks.find((entry) => entry.id === task.id);
    expect(hydrated?.stalledReview?.heuristic).toBe("reenqueue-churn");

    const detail = await store.getTask(task.id);
    expect(detail.stalledReview?.heuristic).toBe("reenqueue-churn");
    expect(detail.stalledReview?.matchCount).toBe(3);
  });

  it("omits stalledReview while fresh agent-log activity is streaming", async () => {
    const task = await seedStalledInReviewTask();
    const oldUpdatedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } } }).db;
    db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(oldUpdatedAt, task.id);
    await store.appendAgentLog(task.id, "reviewer is comparing the squash against the branch", "thinking", undefined, "merger");

    const slimTasks = await store.listTasks({ slim: true, column: "in-review" });
    expect(slimTasks.find((entry) => entry.id === task.id)?.stalledReview).toBeUndefined();

    const fullTasks = await store.listTasks({ slim: false, column: "in-review" });
    expect(fullTasks.find((entry) => entry.id === task.id)?.stalledReview).toBeUndefined();

    const detail = await store.getTask(task.id);
    expect(detail.stalledReview).toBeUndefined();
  });

  it("omits stalledReview for tasks already queued for merge", async () => {
    const task = await seedStalledInReviewTask();
    const store = h.store();
    await store.enqueueMergeQueue(task.id);

    const slimTasks = await store.listTasks({ slim: true, column: "in-review" });
    expect(slimTasks.find((entry) => entry.id === task.id)?.stalledReview).toBeUndefined();

    const fullTasks = await store.listTasks({ slim: false, column: "in-review" });
    expect(fullTasks.find((entry) => entry.id === task.id)?.stalledReview).toBeUndefined();

    const detail = await store.getTask(task.id);
    expect(detail.stalledReview).toBeUndefined();
  });
});

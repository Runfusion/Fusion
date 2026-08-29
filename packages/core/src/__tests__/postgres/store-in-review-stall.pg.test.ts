/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of store-in-review-stall.test.ts.
 *
 * The SQLite version seeds status/paused/mergeRetries/mergeDetails/worktree
 * via raw db.prepare('UPDATE tasks ...'). This PG twin uses createTask +
 * adminDb UPDATE to set the exact internal state the hydration logic expects
 * (status='merging', worktree set, etc.), since updateTask doesn't accept
 * all of these fields directly.
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

pgTest("TaskStore inReviewStall hydration (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_inreview_stall",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedTask(
    id: string,
    overrides: {
      paused?: boolean;
      mergeDetails?: Record<string, unknown>;
      status?: string;
    },
  ) {
    const store = h.store();
    const now = Date.now();
    const updatedAt = new Date(now - 6 * 60_000).toISOString();
    await store.createTaskWithReservedId(
      { description: id, column: "in-review" },
      { taskId: id, createdAt: updatedAt, updatedAt, applyDefaultWorkflowSteps: false },
    );
    // Directly seed the internal state that the inReviewStall hydration checks.
    // status='merging' + worktree set + no mergeDetails triggers the
    // "transient-merge-status-no-owner" stall signal.
    await h
      .adminDb()
      .update(schema.project.tasks)
      .set({
        status: overrides.status ?? "merging",
        paused: overrides.paused ? 1 : 0,
        mergeDetails: JSON.stringify(overrides.mergeDetails ?? {}),
        worktree: `/tmp/${id}`,
        updatedAt,
      })
      .where(eq(schema.project.tasks.id, id));
    store.taskCache.delete(id);
  }

  it("hydrates transient stall for FN-4110 shape in slim list", async () => {
    await seedTask("FN-4110", {});
    const store = h.store();

    const tasks = await store.listTasks({ slim: true });
    const task = tasks.find((entry) => entry.id === "FN-4110");

    expect(task?.inReviewStall?.code).toBe("transient-merge-status-no-owner");
    expect(task?.inReviewStall?.reason).toContain("no active merger");
  });

  it("omits merge-stalled hydration while fresh agent-log activity is streaming", async () => {
    await seedTask("FN-7344", {});
    const store = h.store();
    await store.appendAgentLog("FN-7344", "rerunning merge verification", "thinking", undefined, "merger");

    const listed = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-7344");
    expect(listed?.inReviewStall).toBeUndefined();
    expect(listed?.inReviewStalled).toBeUndefined();

    const detailed = await store.getTask("FN-7344");
    expect(detailed.inReviewStall).toBeUndefined();
    expect(detailed.inReviewStalled).toBeUndefined();
  });

  it("omits merge-stalled hydration while the task is already queued for merge", async () => {
    await seedTask("FN-6088", {});
    const store = h.store();
    await store.enqueueMergeQueue("FN-6088");

    const listed = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-6088");
    expect(listed?.inReviewStall).toBeUndefined();
    expect(listed?.inReviewStalled).toBeUndefined();

    const detailed = await store.getTask("FN-6088");
    expect(detailed.inReviewStall).toBeUndefined();
    expect(detailed.inReviewStalled).toBeUndefined();

    const modified = (await store.listTasksModifiedSince("1970-01-01T00:00:00.000Z")).tasks.find(
      (entry) => entry.id === "FN-6088",
    );
    expect(modified?.inReviewStall).toBeUndefined();
    expect(modified?.inReviewStalled).toBeUndefined();

    const searched = (await store.searchTasks("FN-6088", { slim: true })).find((entry) => entry.id === "FN-6088");
    expect(searched?.inReviewStall).toBeUndefined();
    expect(searched?.inReviewStalled).toBeUndefined();
  });

  it("omits inReviewStall for paused in-review task", async () => {
    await seedTask("FN-4217-PAUSED", { paused: true });
    const store = h.store();

    const tasks = await store.listTasks({ slim: true });
    const task = tasks.find((entry) => entry.id === "FN-4217-PAUSED");

    expect(task?.inReviewStall).toBeUndefined();
  });

  it("omits inReviewStall when merge is confirmed", async () => {
    await seedTask("FN-4217-CONFIRMED", { mergeDetails: { mergeConfirmed: true } });
    const store = h.store();

    const tasks = await store.listTasks({ slim: true });
    const task = tasks.find((entry) => entry.id === "FN-4217-CONFIRMED");

    expect(task?.inReviewStall).toBeUndefined();
  });
});

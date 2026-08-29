/**
 * FNXC:SqliteFinalRemoval 2026-06-25:
 * PostgreSQL-backed counterpart of store-stale-paused-todo.test.ts.
 *
 * Uses adminDb UPDATE to seed paused/columnMovedAt. The original SQLite test
 * remains until SQLite is fully removed; this PG twin is auto-skipped in CI
 * without PostgreSQL (pgDescribe).
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

pgTest("TaskStore stalePausedTodo hydration (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_stale_paused_todo",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  async function seedTask(
    id: string,
    overrides: { paused?: boolean; ageMs?: number; column?: "todo" | "in-review" },
  ) {
    const store = h.store();
    const now = Date.now();
    const ageMs = overrides.ageMs ?? 24 * 60 * 60_000 + 1_000;
    const movedAt = new Date(now - ageMs).toISOString();
    const column = overrides.column ?? "todo";
    await store.createTaskWithReservedId(
      { description: id, column },
      { taskId: id, createdAt: movedAt, updatedAt: movedAt, applyDefaultWorkflowSteps: false },
    );
    await h
      .adminDb()
      .update(schema.project.tasks)
      .set({
        paused: overrides.paused ? 1 : 0,
        columnMovedAt: movedAt,
        updatedAt: movedAt,
      })
      .where(eq(schema.project.tasks.id, id));
    store.taskCache.delete(id);
  }

  it("hydrates stalePausedTodo for paused todo past threshold", async () => {
    await seedTask("FN-5034-A", { paused: true });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5034-A");
    expect(task?.stalePausedTodo?.code).toBe("stale-paused-todo");
  });

  it("respects stalePausedTodoThresholdMs setting override", async () => {
    const store = h.store();
    await store.updateSettings({ stalePausedTodoThresholdMs: 2_000 });
    await seedTask("FN-5034-B", { paused: true, ageMs: 2_500 });
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5034-B");
    expect(task?.stalePausedTodo?.thresholdMs).toBe(2_000);
  });

  it("does not hydrate stalePausedTodo for paused in-review tasks", async () => {
    await seedTask("FN-5034-C", { paused: true, column: "in-review" });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5034-C");
    expect(task?.stalePausedTodo).toBeUndefined();
  });

  it("does not hydrate stalePausedTodo for unpaused todo tasks", async () => {
    await seedTask("FN-5034-D", { paused: false });
    const store = h.store();
    const task = (await store.listTasks({ slim: true })).find((entry) => entry.id === "FN-5034-D");
    expect(task?.stalePausedTodo).toBeUndefined();
  });
});

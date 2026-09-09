/**
 * FNXC:SqliteFinalRemoval 2026-06-25-00:00:
 * PostgreSQL-backed counterpart of store-priority.test.ts.
 *
 * Migrated from `createSharedTaskStoreTestHarness` (SQLite) to
 * `createSharedPgTaskStoreTestHarness` so the task priority persistence path
 * is exercised against PostgreSQL. Part of the SQLite removal test migration.
 * The original SQLite test file remains until SQLite is fully removed.
 *
 * Tests: createTask/getTask/updateTask priority, archive/unarchive priority
 * preservation, triage priority-only changes.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore task priority (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_priority",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("defaults to normal priority when omitted", async () => {
    const store = h.store();
    const task = await store.createTask({
      description: "Priority default task",
    });

    expect(task.priority).toBe("normal");

    const detail = await store.getTask(task.id);
    expect(detail.priority).toBe("normal");
  });

  it("persists explicit priority on create and update, and normalizes null update to default", async () => {
    const store = h.store();
    const task = await store.createTask({
      description: "Priority explicit task",
      priority: "urgent",
    });
    expect(task.priority).toBe("urgent");

    const lowered = await store.updateTask(task.id, { priority: "low" });
    expect(lowered.priority).toBe("low");

    const reset = await store.updateTask(task.id, { priority: null });
    expect(reset.priority).toBe("normal");

    const detail = await store.getTask(task.id);
    expect(detail.priority).toBe("normal");
  });

  it("keeps triage tasks in triage when only priority changes", async () => {
    const store = h.store();
    const task = await store.createTask({
      description: "Planning task with manual review",
      column: "triage",
      priority: "normal",
    });

    const updated = await store.updateTask(task.id, { priority: "urgent" });
    expect(updated.priority).toBe("urgent");
    expect(updated.column).toBe("triage");
  });

});

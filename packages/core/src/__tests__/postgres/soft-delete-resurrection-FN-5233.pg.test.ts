/**
 * FNXC:FixPgTestsAndCi 2026-06-26-09:20:
 * PostgreSQL twin of the deleted `soft-delete-resurrection-FN-5233.test.ts`.
 *
 * The original SQLite test was removed during the migration squash because it
 * used the `inMemoryDb` constructor option that no longer exists. The
 * invariant it protected (FN-5208 / FN-5233) — a tombstoned task id cannot be
 * recreated without forceResurrect — had ZERO PostgreSQL coverage afterward.
 * This is the AGENTS.md "deleted the repro, kept the bug" failure mode
 * (review finding #28) and the exact test that would have caught P0 #7
 * (soft-delete resurrection via unguarded backend branch).
 *
 * This twin exercises the tombstone invariant against the real PostgreSQL
 * backend path so the soft-delete-stickiness contract holds in backend mode.
 */

import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { TombstonedTaskResurrectionError } from "../../task-store/errors.js";
import * as schema from "../../postgres/schema/index.js";

const pgTest = pgDescribe;

pgTest("FN-5233 tombstoned createTask behavior (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_resurrect",
  });

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });
  afterAll(h.afterAll);

  it("throws TombstonedTaskResurrectionError when recreating a tombstoned id", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "a", description: "alpha", column: "todo" });
    await store.deleteTask(task.id);
    const created: string[] = [];
    store.on("task:created", (event: { id: string }) => created.push(event.id));

    await expect(
      store.createTaskWithReservedId(
        { title: "b", description: "beta", column: "todo" },
        { taskId: task.id },
      ),
    ).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);

    // The tombstoned row must remain soft-deleted and resurrection-blocked.
    const row = await h
      .adminDb()
      .select({
        deletedAt: schema.project.tasks.deletedAt,
        allowResurrection: schema.project.tasks.allowResurrection,
      })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id))
      .limit(1);
    expect(row[0]?.deletedAt).toBeTruthy();
    expect(row[0]?.allowResurrection).toBe(0);
    // No task:created event fired — the recreate was rejected.
    expect(created).toEqual([]);
  });

  it("allows forceResurrect recreation and clears allowResurrection", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "a", description: "alpha", column: "todo" });
    await store.deleteTask(task.id, { allowResurrection: true });

    const created: string[] = [];
    store.on("task:created", (event: { id: string }) => created.push(event.id));
    const recreated = await store.createTaskWithReservedId(
      { title: "c", description: "charlie", forceResurrect: true, column: "todo" },
      { taskId: task.id },
    );
    expect(recreated.id).toBe(task.id);
    expect(created).toEqual([task.id]);

    const row = await h
      .adminDb()
      .select({
        deletedAt: schema.project.tasks.deletedAt,
        allowResurrection: schema.project.tasks.allowResurrection,
      })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id))
      .limit(1);
    expect(row[0]?.deletedAt).toBeNull();
    expect(row[0]?.allowResurrection).toBe(0);
  });

  it("allows recreation when the tombstone row has allowResurrection=1", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "a", description: "alpha", column: "todo" });
    await store.deleteTask(task.id, { allowResurrection: true });

    const recreated = await store.createTaskWithReservedId(
      { title: "d", description: "delta", column: "todo" },
      { taskId: task.id },
    );
    expect(recreated.id).toBe(task.id);
    const row = await h
      .adminDb()
      .select({
        deletedAt: schema.project.tasks.deletedAt,
        allowResurrection: schema.project.tasks.allowResurrection,
      })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, task.id))
      .limit(1);
    expect(row[0]?.deletedAt).toBeNull();
    expect(row[0]?.allowResurrection).toBe(0);
  });

  it("records task:resurrection-blocked audit for createTask refusal", async () => {
    const store = h.store();
    const task = await store.createTask({ title: "a", description: "alpha", column: "todo" });
    await store.deleteTask(task.id);

    await expect(
      store.createTaskWithReservedId(
        { title: "b", description: "beta", column: "todo" },
        { taskId: task.id },
      ),
    ).rejects.toBeInstanceOf(TombstonedTaskResurrectionError);

    const events = await h
      .adminDb()
      .select({
        mutationType: schema.project.runAuditEvents.mutationType,
        metadata: schema.project.runAuditEvents.metadata,
      })
      .from(schema.project.runAuditEvents)
      .where(eq(schema.project.runAuditEvents.taskId, task.id));
    const blocked = events.filter((e) => e.mutationType === "task:resurrection-blocked");
    expect(blocked.length).toBeGreaterThan(0);
    // metadata is jsonb — drizzle returns it as a parsed object. The
    // resurrection-blocked audit records operation: "createTask".
    const lastMeta = blocked[blocked.length - 1]?.metadata as Record<string, unknown> | string | null;
    const metaObj = typeof lastMeta === "string" ? (JSON.parse(lastMeta) as Record<string, unknown>) : (lastMeta ?? {});
    expect(metaObj.operation).toBe("createTask");
  });

  it("a soft-deleted task is absent from live readers (VAL-DATA-005)", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "live then deleted", column: "todo" });
    await store.deleteTask(task.id);

    const list = await store.listTasks();
    expect(list.map((t) => t.id)).not.toContain(task.id);
    const slim = await store.listTasks({ slim: true });
    expect(slim.map((t) => t.id)).not.toContain(task.id);
  });
});

// Keep `describe` referenced so the import is not flagged as unused if the
// pgDescribe.skip path is taken in CI (no PG available).
void describe;

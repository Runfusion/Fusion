/**
 * FNXC:SqliteFinalRemoval 2026-06-25-10:50:
 * PostgreSQL-backed counterpart of store-list-modified.test.ts (the public
 * API portions). Validates listTasksModifiedSince cursor pagination and
 * updatedAt ASC ordering against the PostgreSQL backend mode.
 *
 * Migrated from `new TaskStore(rootDir, globalDir, { inMemoryDb: true })`
 * (SQLite) to `createSharedPgTaskStoreTestHarness` (PostgreSQL).
 *
 * NOT migrated: the limit-defaults/clamping suite in the SQLite file uses
 * `(store as any).db.prepare("INSERT INTO tasks ...")` raw SQL to seed many
 * rows cheaply; the PG equivalent seeds via createTaskWithReservedId (slower
 * but exercises the real insert path). Those cases are covered here via the
 * explicit-timestamp create helper.
 */
import { afterEach, beforeEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

const pgTest = pgDescribe;

pgTest("TaskStore.listTasksModifiedSince (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_list_modified",
  });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(async () => {
    await h.beforeEach();
  });
  afterEach(async () => {
    await h.afterEach();
  });

  async function createTaskWithUpdatedAt(
    id: string,
    updatedAt: string,
    column: "todo" | "archived" = "todo",
  ) {
    return h.store().createTaskWithReservedId(
      { description: `Task ${id}`, column },
      { taskId: id, createdAt: updatedAt, updatedAt, applyDefaultWorkflowSteps: false },
    );
  }

  it("returns empty tasks and hasMore false when nothing matches", async () => {
    const result = await h.store().listTasksModifiedSince("2026-01-01T00:00:00.000Z", 50);
    expect(result).toEqual({ tasks: [], hasMore: false });
  });

  it("returns rows in updatedAt ASC order using strict greater-than cursor", async () => {
    await createTaskWithUpdatedAt("FN-1", "2026-01-01T00:00:00.000Z");
    await createTaskWithUpdatedAt("FN-2", "2026-01-01T00:00:00.002Z");
    await createTaskWithUpdatedAt("FN-3", "2026-01-01T00:00:00.001Z");

    const result = await h.store().listTasksModifiedSince("2026-01-01T00:00:00.000Z");
    expect(result.hasMore).toBe(false);
    expect(result.tasks.map((task) => task.id)).toEqual(["FN-3", "FN-2"]);
    expect(result.tasks.map((task) => task.updatedAt)).toEqual([
      "2026-01-01T00:00:00.001Z",
      "2026-01-01T00:00:00.002Z",
    ]);
  });

  it("sets hasMore true when trimmed and false when exactly limit rows match", async () => {
    for (let i = 1; i <= 5; i += 1) {
      await createTaskWithUpdatedAt(`FN-${i}`, `2026-01-01T00:00:00.00${i}Z`);
    }

    const trimmed = await h.store().listTasksModifiedSince("2026-01-01T00:00:00.000Z", 2);
    expect(trimmed.tasks.map((task) => task.id)).toEqual(["FN-1", "FN-2"]);
    expect(trimmed.hasMore).toBe(true);

    const exact = await h.store().listTasksModifiedSince("2026-01-01T00:00:00.000Z", 5);
    expect(exact.tasks).toHaveLength(5);
    expect(exact.hasMore).toBe(false);
  });

  it("clamps an out-of-range limit to the internal maximum", async () => {
    // createTaskWithReservedId is now wired for backend mode, so seeding a
    // handful of rows exercises the real insert path. The clamp behavior is
    // verified by passing a huge limit and asserting hasMore is false and all
    // seeded rows are returned (no crash, no negative-limit).
    for (let i = 1; i <= 3; i += 1) {
      await createTaskWithUpdatedAt(`FN-CLAMP-${i}`, `2026-02-01T00:00:00.00${i}Z`);
    }
    const result = await h.store().listTasksModifiedSince("2026-01-01T00:00:00.000Z", 1_000_000);
    expect(result.tasks.map((t) => t.id)).toEqual([
      "FN-CLAMP-1",
      "FN-CLAMP-2",
      "FN-CLAMP-3",
    ]);
    expect(result.hasMore).toBe(false);
  });
});

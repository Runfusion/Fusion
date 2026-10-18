/**
 * FNXC:ArchivedTaskListCache 2026-10-17-18:30:
 * listArchivedTasks serves an unchanged archive from memory and re-reads task_json as soon as any
 * row is inserted, updated or deleted, so callers never see a stale snapshot. Skipped when
 * PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1).
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  deleteArchivedTask,
  getArchivedTaskListFullReadCount,
  listArchivedTasks,
  upsertArchivedTask,
} from "../../async-stores/async-archive-db.js";
import type { ArchivedTaskEntry } from "../../types.js";

const PROJECT = "proj_cache_a";
const OTHER_PROJECT = "proj_cache_b";

function makeEntry(id: string, archivedAt: string, title = `Task ${id}`): ArchivedTaskEntry {
  return {
    id,
    title,
    description: "desc",
    comments: [],
    createdAt: archivedAt,
    updatedAt: archivedAt,
    archivedAt,
    columnMovedAt: archivedAt,
  } as unknown as ArchivedTaskEntry;
}

pgDescribe("archived-task list cache (PostgreSQL)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_archive_list_cache_test",
  });
  let layer: AsyncDataLayer;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    layer = h.layer();
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("serves an unchanged archive without re-reading task_json", async () => {
    await upsertArchivedTask(layer.db, makeEntry("FN-1", "2026-01-01T00:00:00.000Z"), PROJECT);
    await upsertArchivedTask(layer.db, makeEntry("FN-2", "2026-01-02T00:00:00.000Z"), PROJECT);
    const before = getArchivedTaskListFullReadCount(layer.db, PROJECT);

    const first = await listArchivedTasks(layer.db, PROJECT);
    const second = await listArchivedTasks(layer.db, PROJECT);

    expect(first.map((e) => e.id)).toEqual(["FN-2", "FN-1"]);
    expect(second).toEqual(first);
    expect(getArchivedTaskListFullReadCount(layer.db, PROJECT)).toBe(before + 1);
  });

  it("returns fresh objects, so a caller mutation does not leak into the next read", async () => {
    await upsertArchivedTask(layer.db, makeEntry("FN-1", "2026-01-01T00:00:00.000Z"), PROJECT);
    const first = await listArchivedTasks(layer.db, PROJECT);
    (first[0] as { title?: string }).title = "mutated by caller";

    const second = await listArchivedTasks(layer.db, PROJECT);
    expect(second[0]?.title).toBe("Task FN-1");
  });

  it("re-reads after an insert, an in-place upsert and a delete", async () => {
    await upsertArchivedTask(layer.db, makeEntry("FN-1", "2026-01-01T00:00:00.000Z"), PROJECT);
    expect((await listArchivedTasks(layer.db, PROJECT)).map((e) => e.id)).toEqual(["FN-1"]);

    await upsertArchivedTask(layer.db, makeEntry("FN-2", "2026-01-02T00:00:00.000Z"), PROJECT);
    expect((await listArchivedTasks(layer.db, PROJECT)).map((e) => e.id)).toEqual(["FN-2", "FN-1"]);

    // Same id, same timestamps, same row count: only the row version changes.
    await upsertArchivedTask(layer.db, makeEntry("FN-2", "2026-01-02T00:00:00.000Z", "Renamed"), PROJECT);
    expect((await listArchivedTasks(layer.db, PROJECT))[0]?.title).toBe("Renamed");

    await deleteArchivedTask(layer.db, "FN-2");
    expect((await listArchivedTasks(layer.db, PROJECT)).map((e) => e.id)).toEqual(["FN-1"]);
  });

  it("keeps project scopes apart", async () => {
    await upsertArchivedTask(layer.db, makeEntry("FN-1", "2026-01-01T00:00:00.000Z"), PROJECT);
    await upsertArchivedTask(layer.db, makeEntry("FN-9", "2026-01-03T00:00:00.000Z"), OTHER_PROJECT);

    expect((await listArchivedTasks(layer.db, PROJECT)).map((e) => e.id)).toEqual(["FN-1"]);
    expect((await listArchivedTasks(layer.db, OTHER_PROJECT)).map((e) => e.id)).toEqual(["FN-9"]);

    await upsertArchivedTask(layer.db, makeEntry("FN-10", "2026-01-04T00:00:00.000Z"), OTHER_PROJECT);
    expect((await listArchivedTasks(layer.db, PROJECT)).map((e) => e.id)).toEqual(["FN-1"]);
    expect((await listArchivedTasks(layer.db, OTHER_PROJECT)).map((e) => e.id)).toEqual(["FN-10", "FN-9"]);
  });
});

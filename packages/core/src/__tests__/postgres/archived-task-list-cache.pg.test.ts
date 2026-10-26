/**
 * FNXC:ArchivedTaskListCache 2026-10-17-18:30:
 * listArchivedTasks serves an unchanged archive from memory and re-reads task_json as soon as any
 * row is inserted, updated or deleted, so callers never see a stale snapshot. Skipped when
 * PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1).
 */

import { it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
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

/** Wrap a query handle so a write runs right before the next full archive read (the ordered query). */
function writeBeforeNextFullRead(db: AsyncDataLayer["db"], write: () => Promise<unknown>) {
  let pending: (() => Promise<unknown>) | undefined = write;
  let fullReads = 0;
  const wrapBuilder = (builder: object): object => new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "orderBy") {
        return (...args: unknown[]) => {
          fullReads += 1;
          const query = (value as (...a: unknown[]) => PromiseLike<unknown>).apply(target, args);
          const before = pending;
          pending = undefined;
          if (!before) return query;
          return { then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => before().then(() => query).then(ok, fail) };
        };
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        return result && typeof result === "object" ? wrapBuilder(result) : result;
      };
    },
  });
  const handle = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "select" && typeof value === "function") {
        return (...args: unknown[]) => wrapBuilder((value as (...a: unknown[]) => object).apply(target, args));
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { handle: handle as AsyncDataLayer["db"], fullReads: () => fullReads };
}

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

  it("never caches a full read under a fingerprint taken before a concurrent write", async () => {
    await upsertArchivedTask(layer.db, makeEntry("FN-1", "2026-01-01T00:00:00.000Z"), PROJECT);
    const { handle } = writeBeforeNextFullRead(layer.db, () =>
      upsertArchivedTask(layer.db, makeEntry("FN-2", "2026-01-02T00:00:00.000Z"), PROJECT));

    // The fingerprint sees FN-1 only; FN-2 lands before the full read.
    expect((await listArchivedTasks(handle, PROJECT)).map((e) => e.id)).toEqual(["FN-2", "FN-1"]);

    // Deleting FN-2 restores the earlier fingerprint, so a mis-keyed cache would still return it.
    await deleteArchivedTask(layer.db, "FN-2");
    expect((await listArchivedTasks(handle, PROJECT)).map((e) => e.id)).toEqual(["FN-1"]);
  });

  it("shares one full read between overlapping misses and counts every full read", async () => {
    await upsertArchivedTask(layer.db, makeEntry("FN-1", "2026-01-01T00:00:00.000Z"), PROJECT);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Hold the first full read open until the second call has read its fingerprint.
    const { handle, fullReads } = writeBeforeNextFullRead(layer.db, () => gate);

    const first = listArchivedTasks(handle, PROJECT);
    await vi.waitFor(() => expect(fullReads()).toBe(1));
    const second = listArchivedTasks(handle, PROJECT);
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual(b);
    expect(fullReads()).toBe(1);
    expect(getArchivedTaskListFullReadCount(handle, PROJECT)).toBe(1);
  });
});

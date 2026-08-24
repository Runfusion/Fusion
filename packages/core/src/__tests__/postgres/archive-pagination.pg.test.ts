/**
 * FNXC:ArchivePagination 2026-07-08-00:00:
 * PostgreSQL port of upstream's sqlite archive-db-pagination.test.ts (FN-7659):
 * the archived read path must return rows ordered `archivedAt DESC` (with an
 * `id DESC` tie-break — Postgres has no rowid) and support bounded
 * LIMIT/OFFSET windowing so the dashboard never loads the whole archive in a
 * single pass. Exercises listArchivedTaskEntriesPage + getArchivedRowCount
 * against a real PostgreSQL archive schema. Skipped when PostgreSQL is
 * unreachable (FUSION_PG_TEST_SKIP=1) so the merge gate stays green.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  getArchivedRowCount,
  listArchivedTaskEntriesPage,
  upsertArchivedTask,
} from "../../async-stores/async-archive-db.js";
import type { ArchivedTaskEntry } from "../../types.js";

/*
FNXC:PgTestHarnessAdoption 2026-08-16-03:45:
Migrated off the hand-rolled per-test CREATE DATABASE + applySchemaBaseline scaffolding
(~3-4s of DDL per test) onto the shared PG harness: one template-cloned database per file
with TRUNCATE-based reset per test. The database setup here was scaffolding, not the
subject under test (FN-7659 pagination ordering is), and every assertion is unchanged.
*/
interface Ctx {
  layer: AsyncDataLayer;
}

function makeEntry(id: string, archivedAt: string): ArchivedTaskEntry {
  return {
    id,
    title: `Task ${id}`,
    description: "desc",
    comments: [],
    createdAt: archivedAt,
    updatedAt: archivedAt,
    archivedAt,
    columnMovedAt: archivedAt,
  } as unknown as ArchivedTaskEntry;
}

pgDescribe("archive pagination (PostgreSQL, FN-7659)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_archive_page_test",
  });
  let ctx: Ctx;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    ctx = { layer: h.layer() };
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("returns [] and total 0 for an empty archive", async () => {
    expect(await listArchivedTaskEntriesPage(ctx.layer.db, 100, 0)).toEqual([]);
    expect(await getArchivedRowCount(ctx.layer.db)).toBe(0);
  });

  it("orders results by archivedAt DESC (newest first)", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 10; i++) {
      await upsertArchivedTask(ctx.layer.db, makeEntry(`FN-${i}`, new Date(base + i * 60_000).toISOString()));
    }
    const page = await listArchivedTaskEntriesPage(ctx.layer.db, 100, 0);
    expect(page.map((e) => e.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `FN-${9 - i}`),
    );
  });

  it("windows correctly with LIMIT/OFFSET across page boundaries", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const total = 250;
    for (let i = 0; i < total; i++) {
      await upsertArchivedTask(ctx.layer.db, makeEntry(`FN-${i}`, new Date(base + i * 60_000).toISOString()));
    }
    expect(await getArchivedRowCount(ctx.layer.db)).toBe(total);

    const page1 = await listArchivedTaskEntriesPage(ctx.layer.db, 100, 0);
    const page2 = await listArchivedTaskEntriesPage(ctx.layer.db, 100, 100);
    const page3 = await listArchivedTaskEntriesPage(ctx.layer.db, 100, 200);

    expect(page1).toHaveLength(100);
    expect(page2).toHaveLength(100);
    expect(page3).toHaveLength(50);

    // Newest first: FN-249 is the last-archived (highest archivedAt).
    expect(page1[0]!.id).toBe("FN-249");
    expect(page1[99]!.id).toBe("FN-150");
    expect(page2[0]!.id).toBe("FN-149");
    expect(page2[99]!.id).toBe("FN-50");
    expect(page3[0]!.id).toBe("FN-49");
    expect(page3[49]!.id).toBe("FN-0");

    // No duplicates/gaps across the concatenated pages.
    const allIds = [...page1, ...page2, ...page3].map((e) => e.id);
    expect(new Set(allIds).size).toBe(total);
  });

  /*
  FNXC:ArchivePagination 2026-08-23-16:45:
  The isolation half of this case needs a REAL partition key. The shared harness runs
  project-agnostic (`layer.projectId` is undefined), and an empty/undefined project id means
  "unscoped" everywhere in the data layer (`projectScopeFor`), so reading with it returned the
  other project's rows too. Write and read this page under an explicit project id instead of the
  harness's agnostic one; the ordering assertions are unchanged.
  */
  it("sorts task IDs numerically before slicing and isolates project pages", async () => {
    const projectId = "archive-pagination-project";
    for (let i = 0; i < 105; i++) {
      const entry = makeEntry(`FN-${i}`, new Date(Date.parse("2026-02-01T00:00:00.000Z") + (104 - i) * 60_000).toISOString());
      await upsertArchivedTask(ctx.layer.db, entry, projectId);
      await upsertArchivedTask(ctx.layer.db, makeEntry(`FN-${1000 + i}`, entry.archivedAt), "other-project");
    }

    const page1 = await listArchivedTaskEntriesPage(ctx.layer.db, 100, 0, projectId, "task-id-desc");
    const page2 = await listArchivedTaskEntriesPage(ctx.layer.db, 100, 100, projectId, "task-id-desc");
    expect(page1).toHaveLength(100);
    expect(page2).toHaveLength(5);
    expect(page1[0]!.id).toBe("FN-104");
    expect(page1[1]!.id).toBe("FN-103");
    expect(page2[0]!.id).toBe("FN-4");
    expect(new Set([...page1, ...page2].map((entry) => entry.id)).size).toBe(105);
    expect([...page1, ...page2].every((entry) => Number(entry.id.slice(3)) < 105)).toBe(true);
  });

  it("handles the exact page-boundary cases (total === 100 and 101)", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 101; i++) {
      await upsertArchivedTask(ctx.layer.db, makeEntry(`FN-${i}`, new Date(base + i * 60_000).toISOString()));
    }
    expect(await listArchivedTaskEntriesPage(ctx.layer.db, 100, 0)).toHaveLength(100);
    expect(await listArchivedTaskEntriesPage(ctx.layer.db, 100, 100)).toHaveLength(1);
    expect(await listArchivedTaskEntriesPage(ctx.layer.db, 100, 101)).toHaveLength(0);
  });
});

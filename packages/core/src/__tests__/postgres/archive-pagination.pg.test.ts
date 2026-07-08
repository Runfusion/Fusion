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

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  getArchivedRowCount,
  listArchivedTaskEntriesPage,
  upsertArchivedTask,
} from "../../async-archive-db.js";
import type { ArchivedTaskEntry } from "../../types.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_archive_page_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

function adminExec(statement: string): void {
  execSync(
    `psql -h localhost -p 5432 -U ${process.env.USER ?? "postgres"} -d postgres -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface Ctx {
  dbName: string;
  layer: AsyncDataLayer;
}

async function setupCtx(): Promise<Ctx> {
  const dbName = uniqueDbName();
  try { adminExec(`DROP DATABASE IF EXISTS "${dbName}"`); } catch { /* may not exist */ }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
  const { createConnectionSetFromUrl } = await import("../../postgres/connection.js");
  const { applySchemaBaseline } = await import("../../postgres/schema-applier.js");
  const { resolveBackendWithOptions } = await import("../../postgres/backend-resolver.js");
  const backend = resolveBackendWithOptions({ databaseUrl: testUrl, databaseMigrationUrl: testUrl });
  const connections = await createConnectionSetFromUrl(backend, { poolMax: 3, connectTimeoutSeconds: 5 });
  await applySchemaBaseline(connections.migration);
  const layer = createAsyncDataLayer(connections);
  return { dbName, layer };
}

async function teardownCtx(ctx: Ctx | null): Promise<void> {
  if (!ctx) return;
  try { await ctx.layer.close(); } catch { /* best-effort */ }
  try { adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`); } catch { /* best-effort */ }
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
  let ctx: Ctx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("returns [] and total 0 for an empty archive", async () => {
    ctx = await setupCtx();
    expect(await listArchivedTaskEntriesPage(ctx.layer.db, 100, 0)).toEqual([]);
    expect(await getArchivedRowCount(ctx.layer.db)).toBe(0);
  });

  it("orders results by archivedAt DESC (newest first)", async () => {
    ctx = await setupCtx();
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
    ctx = await setupCtx();
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

  it("handles the exact page-boundary cases (total === 100 and 101)", async () => {
    ctx = await setupCtx();
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 101; i++) {
      await upsertArchivedTask(ctx.layer.db, makeEntry(`FN-${i}`, new Date(base + i * 60_000).toISOString()));
    }
    expect(await listArchivedTaskEntriesPage(ctx.layer.db, 100, 0)).toHaveLength(100);
    expect(await listArchivedTaskEntriesPage(ctx.layer.db, 100, 100)).toHaveLength(1);
    expect(await listArchivedTaskEntriesPage(ctx.layer.db, 100, 101)).toHaveLength(0);
  });
});

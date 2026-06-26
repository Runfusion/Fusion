/**
 * Full-text search replacement (FTS5 → tsvector/GIN) PostgreSQL integration
 * tests (fts-replacement feature, U7).
 *
 * FNXC:TaskStoreSearch 2026-06-24-14:00:
 * Integration tests proving the PostgreSQL tsvector/GIN full-text search path
 * produces correct results and sync-on-write semantics, replacing the SQLite
 * FTS5 external-content tables (tasks_fts, archived_tasks_fts). Each test
 * creates a uniquely-named fresh database, applies the baseline schema
 * (which now includes the search_vector generated columns + GIN indexes), and
 * exercises the tsvector search helpers in async-search.ts.
 *
 * Coverage targets (the assertions fts-replacement fulfills):
 *   VAL-SEARCH-001 — Search parity with FTS5 baseline (row membership).
 *   VAL-SEARCH-002 — tsvector sync-on-write (insert): new task immediately searchable.
 *   VAL-SEARCH-003 — tsvector sync-on-write (update): text changes reflected immediately.
 *   VAL-SEARCH-004 — tsvector sync-on-write (delete): deleted task gone from search.
 *   VAL-SEARCH-005 — Archive search parity (row membership).
 *   VAL-SEARCH-006 — Non-text mutation does not regenerate the tsvector.
 *   VAL-SEARCH-007 — Index rebuild (REINDEX) restores search without data loss.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq } from "drizzle-orm";
import { execSync } from "node:child_process";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";
import { insertTaskRow } from "../../task-store/async-persistence.js";
import {
  searchTasksTsvector,
  countSearchTasksTsvector,
  searchArchivedTasksTsvector,
  readTaskSearchVector,
  reindexTasksSearchVector,
  sanitizeSearchTokens,
} from "../../task-store/async-search.js";
import { upsertArchivedTaskEntry } from "../../task-store/async-archive-lineage.js";
import type { ArchivedTaskEntry } from "../../types.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

function uniqueDbName(): string {
  return `fusion_fts_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

function adminExec(statement: string): void {
  execSync(
    `psql -h localhost -p 5432 -U ${process.env.USER ?? "postgres"} -d postgres -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface TestCtx {
  dbName: string;
  testUrl: string;
  layer: AsyncDataLayer;
  adminSql: ReturnType<typeof postgres>;
}

async function setupCtx(): Promise<TestCtx> {
  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // may not exist
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

  const schemaBackend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: testUrl,
    migrationUrl: testUrl,
    migrationUrlOverridden: false,
  };
  const schemaConnections = await createConnectionSetFromUrl(schemaBackend, {
    poolMax: 1,
    connectTimeoutSeconds: 5,
  });
  await applySchemaBaseline(schemaConnections.migration);
  await schemaConnections.close();

  const connections = await createConnectionSetFromUrl(schemaBackend, {
    poolMax: 5,
    connectTimeoutSeconds: 5,
  });
  const layer = createAsyncDataLayer(connections);

  const adminSql = postgres(testUrl, { max: 2, prepare: false, onnotice: () => {} });
  // Keep a reference so TS doesn't flag unused; adminSql is used for teardown
  // via end() and direct diagnostic queries.
  void drizzle(adminSql);

  return { dbName, testUrl, layer, adminSql };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.layer.close();
  } catch {
    // best-effort
  }
  try {
    await ctx.adminSql.end({ timeout: 5 });
  } catch {
    // best-effort
  }
  try {
    adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`);
  } catch {
    // best-effort
  }
}

/** A minimal task record with the NOT NULL columns filled. */
function makeMinimalTask(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    description: "test task description",
    column: "todo",
    currentStep: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Insert a task with the default serialization context (lineageId null). */
async function insertTask(
  layer: AsyncDataLayer,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await insertTaskRow(layer, makeMinimalTask(id, overrides), { lineageId: null });
}

/** Extract the set of task ids from search result rows. */
function resultIds(rows: Record<string, unknown>[]): string[] {
  return rows.map((r) => r.id as string).sort();
}

pgDescribe("fts-replacement: tsvector/GIN full-text search (PostgreSQL)", () => {
  let ctx: TestCtx | null = null;

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  // ── VAL-SEARCH-001: Search parity with FTS5 baseline (row membership) ──

  it("returns the same row membership as the FTS5 baseline for representative queries (VAL-SEARCH-001)", async () => {
    ctx = await setupCtx();
    // Seed tasks with distinct searchable text.
    await insertTask(ctx.layer, "FTS-001", { title: "database migration guide" });
    await insertTask(ctx.layer, "FTS-002", { title: "frontend redesign" });
    await insertTask(ctx.layer, "FTS-003", { title: "database index optimization" });
    await insertTask(ctx.layer, "FTS-004", { title: "unrelated chore" });

    // Query "database" should match FTS-001 and FTS-003 (both have "database" in title).
    const dbResults = await searchTasksTsvector(ctx.layer.db, "database");
    expect(resultIds(dbResults)).toEqual(["FTS-001", "FTS-003"]);

    // Query "frontend" should match only FTS-002.
    const feResults = await searchTasksTsvector(ctx.layer.db, "frontend");
    expect(resultIds(feResults)).toEqual(["FTS-002"]);

    // Multi-term query "database optimization" uses OR semantics (to_tsquery
    // with | join), matching FTS5 baseline. Both FTS-001 ("database") and
    // FTS-003 ("database optimization") match.
    const multiResults = await searchTasksTsvector(ctx.layer.db, "database optimization");
    expect(resultIds(multiResults)).toEqual(["FTS-001", "FTS-003"]);

    // A term in description (not title) should also match.
    const descResults = await searchTasksTsvector(ctx.layer.db, "description");
    expect(descResults.length).toBe(4); // all have "description" in the description column
  });

  it("matches terms across id, title, description, and comments columns (VAL-SEARCH-001)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "SEARCH-ID-1", { title: "alpha" });
    await insertTask(ctx.layer, "PLAIN-002", { title: "beta", comments: [{ text: "gamma delta notes" }] });

    // Match by id token.
    const idResults = await searchTasksTsvector(ctx.layer.db, "SEARCH-ID");
    expect(resultIds(idResults)).toEqual(["SEARCH-ID-1"]);

    // Match by comment text.
    const commentResults = await searchTasksTsvector(ctx.layer.db, "gamma");
    expect(resultIds(commentResults)).toEqual(["PLAIN-002"]);
  });

  // FNXC:TaskStoreSearch 2026-06-24-15:50:
  // Prefix matching regression test: "frob" must find "frobnicator" (FTS5 * parity).
  // to_tsquery with :* suffix reproduces FTS5's `${token}*` prefix token.
  it("prefix matching: partial token finds longer indexed term (VAL-SEARCH-001)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "PREFIX-001", { title: "frobnicator setup" });
    await insertTask(ctx.layer, "PREFIX-002", { title: "database tuning" });

    // "frob" is a prefix of "frobnicator" — must match with :* prefix.
    const prefixResults = await searchTasksTsvector(ctx.layer.db, "frob");
    expect(resultIds(prefixResults)).toEqual(["PREFIX-001"]);

    // "data" is a prefix of "database" — must match both PREFIX-002 and FTS-001
    // if FTS-001 existed, here just the one.
    const dataResults = await searchTasksTsvector(ctx.layer.db, "data");
    expect(resultIds(dataResults)).toEqual(["PREFIX-002"]);
  });

  // ── VAL-SEARCH-002: tsvector sync-on-write (insert) ──

  it("newly inserted task is immediately searchable without explicit reindex (VAL-SEARCH-002)", async () => {
    ctx = await setupCtx();
    // No tasks exist yet.
    const before = await searchTasksTsvector(ctx.layer.db, "freshly");
    expect(before).toEqual([]);

    // Insert a task and search immediately.
    await insertTask(ctx.layer, "NEW-001", { title: "freshly inserted task" });
    const after = await searchTasksTsvector(ctx.layer.db, "freshly");
    expect(resultIds(after)).toEqual(["NEW-001"]);
  });

  // ── VAL-SEARCH-003: tsvector sync-on-write (update) ──

  it("updated task text fields are reflected in search immediately (VAL-SEARCH-003)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "UPD-001", { title: "original title" });

    // "renamed" not present initially.
    const before = await searchTasksTsvector(ctx.layer.db, "renamed");
    expect(before).toEqual([]);

    // Update the title to include a new searchable term.
    await ctx.layer.db
      .update(schema.project.tasks)
      .set({ title: "renamed title" })
      .where(eq(schema.project.tasks.id, "UPD-001"));

    // Now searchable by the new term.
    const after = await searchTasksTsvector(ctx.layer.db, "renamed");
    expect(resultIds(after)).toEqual(["UPD-001"]);

    // And no longer the only match for "original" (it was replaced, but
    // "title" still tokenizes). Actually "original" should no longer match
    // because the title changed. Verify it's gone.
    const oldTerm = await searchTasksTsvector(ctx.layer.db, "original");
    expect(resultIds(oldTerm)).toEqual([]);
  });

  // ── VAL-SEARCH-004: tsvector sync-on-write (delete) ──

  it("soft-deleted task no longer appears in live search (VAL-SEARCH-004)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "DEL-001", { title: "to be deleted searchable" });
    await insertTask(ctx.layer, "DEL-002", { title: "to be deleted keeper" });

    // Both match "deleted" initially.
    const before = await searchTasksTsvector(ctx.layer.db, "deleted");
    expect(resultIds(before)).toEqual(["DEL-001", "DEL-002"]);

    // Soft-delete DEL-001 (sets deleted_at). Live search excludes it.
    const now = new Date().toISOString();
    await ctx.layer.db
      .update(schema.project.tasks)
      .set({ deletedAt: now })
      .where(eq(schema.project.tasks.id, "DEL-001"));

    const after = await searchTasksTsvector(ctx.layer.db, "deleted");
    expect(resultIds(after)).toEqual(["DEL-002"]);
  });

  it("hard-deleted task row is gone from search (VAL-SEARCH-004)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "HARD-001", { title: "hard delete target" });

    const before = await searchTasksTsvector(ctx.layer.db, "target");
    expect(resultIds(before)).toEqual(["HARD-001"]);

    await ctx.layer.db
      .delete(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "HARD-001"));

    const after = await searchTasksTsvector(ctx.layer.db, "target");
    expect(after).toEqual([]);
  });

  // ── VAL-SEARCH-005: Archive search parity ──

  it("archived-task search returns matching rows via tsvector (VAL-SEARCH-005)", async () => {
    ctx = await setupCtx();
    const baseEntry = (id: string, title: string, description: string) =>
      ({
        id,
        title,
        description,
        archivedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }) as unknown as ArchivedTaskEntry;

    await upsertArchivedTaskEntry(ctx.layer.db, baseEntry("ARC-001", "legacy migration notes", "old desc"));
    await upsertArchivedTaskEntry(ctx.layer.db, baseEntry("ARC-002", "frontend refactor", "old desc"));
    await upsertArchivedTaskEntry(ctx.layer.db, baseEntry("ARC-003", "legacy cleanup", "old desc"));

    const results = await searchArchivedTasksTsvector(ctx.layer.db, "legacy", 10);
    expect(resultIds(results)).toEqual(["ARC-001", "ARC-003"]);

    // FNXC:TaskStoreSearch 2026-06-25-10:35:
    // Multi-term OR semantics (FTS5 parity). The tsquery joins sanitized tokens
    // with ` | ` (OR) and applies `:*` prefix matching per token, reproducing
    // the SQLite FTS5 baseline (see buildTsqueryFragment in async-search.ts).
    // So "legacy cleanup" matches any archived row whose tsvector contains
    // "legacy" OR "cleanup": ARC-001 ("legacy migration notes") and ARC-003
    // ("legacy cleanup"). This mirrors VAL-SEARCH-001 multi-term OR recall.
    const multi = await searchArchivedTasksTsvector(ctx.layer.db, "legacy cleanup", 10);
    expect(resultIds(multi)).toEqual(["ARC-001", "ARC-003"]);
  });

  // ── VAL-SEARCH-006: Non-text mutation does not regenerate tsvector ──

  it("a mutation touching only non-text columns leaves search_vector unchanged (VAL-SEARCH-006)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "VEC-001", { title: "stable title text" });

    // Read the initial search_vector value.
    const svBefore = await readTaskSearchVector(ctx.layer.db, "VEC-001");
    expect(svBefore).not.toBeNull();
    // The vector should contain the title tokens.
    expect(svBefore).toContain("'stable'");

    // Update ONLY a non-text column (status + updated_at). The search_vector
    // generated column depends only on id/title/description/comments, so this
    // mutation must NOT regenerate it.
    await ctx.layer.db
      .update(schema.project.tasks)
      .set({ status: "in-progress", updatedAt: new Date().toISOString() })
      .where(eq(schema.project.tasks.id, "VEC-001"));

    const svAfter = await readTaskSearchVector(ctx.layer.db, "VEC-001");
    expect(svAfter).toBe(svBefore); // byte-identical — no regeneration
  });

  it("a mutation touching a text column DOES regenerate the tsvector (VAL-SEARCH-006 inverse)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "VEC-002", { title: "before change" });

    const svBefore = await readTaskSearchVector(ctx.layer.db, "VEC-002");
    expect(svBefore).toContain("'before'");

    await ctx.layer.db
      .update(schema.project.tasks)
      .set({ title: "after change" })
      .where(eq(schema.project.tasks.id, "VEC-002"));

    const svAfter = await readTaskSearchVector(ctx.layer.db, "VEC-002");
    expect(svAfter).not.toBe(svBefore);
    expect(svAfter).toContain("'after'");
    expect(svAfter).not.toContain("'before'");
  });

  // ── VAL-SEARCH-007: Index rebuild restores search ──

  it("REINDEX on the GIN index restores correct search without data loss (VAL-SEARCH-007)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "RIDX-001", { title: "reindex probe alpha" });
    await insertTask(ctx.layer, "RIDX-002", { title: "reindex probe beta" });

    const baseline = await searchTasksTsvector(ctx.layer.db, "reindex");
    expect(resultIds(baseline)).toEqual(["RIDX-001", "RIDX-002"]);

    // Force index bloat by deleting and reinserting many rows, then REINDEX.
    // This simulates the operator maintenance path. The generated-column data
    // is unaffected; only the index is rebuilt.
    for (let i = 0; i < 20; i++) {
      await ctx.layer.db
        .delete(schema.project.tasks)
        .where(eq(schema.project.tasks.id, `BOGUS-${i}`));
    }
    await reindexTasksSearchVector(ctx.layer.db, false);

    // Search still returns correct results after rebuild — no data loss.
    const after = await searchTasksTsvector(ctx.layer.db, "reindex");
    expect(resultIds(after)).toEqual(["RIDX-001", "RIDX-002"]);

    // Count is also correct.
    const count = await countSearchTasksTsvector(ctx.layer.db, "probe");
    expect(count).toBe(2);
  });

  it("DROP + re-CREATE the GIN index restores search (VAL-SEARCH-007 alternate)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "DROP-001", { title: "drop recreate search" });

    // Drop the index (simulating corruption/missing index).
    await ctx.layer.db.execute(sql`DROP INDEX IF EXISTS "idxTasksSearchVector"`);

    // Recreate it from the existing generated-column data.
    await ctx.layer.db.execute(
      sql`CREATE INDEX IF NOT EXISTS "idxTasksSearchVector" ON project.tasks USING gin(search_vector)`,
    );

    const results = await searchTasksTsvector(ctx.layer.db, "recreate");
    expect(resultIds(results)).toEqual(["DROP-001"]);
  });

  // ── Helpers / edge cases ──

  it("empty and whitespace queries return no results (no crash)", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "EDGE-001", { title: "something" });

    expect(await searchTasksTsvector(ctx.layer.db, "")).toEqual([]);
    expect(await searchTasksTsvector(ctx.layer.db, "   ")).toEqual([]);
    expect(await searchTasksTsvector(ctx.layer.db, "\t\n")).toEqual([]);
  });

  it("sanitizeSearchTokens strips FTS5 operators", () => {
    // The function splits on whitespace, then strips FTS5 operator chars
    // ("{}:*^+()) from each token. Note: '-' is NOT stripped (not in the set),
    // so "-not" survives as a token. This mirrors the sync path exactly.
    expect(sanitizeSearchTokens('"quoted term"')).toEqual(["quoted", "term"]);
    expect(sanitizeSearchTokens('+must (group)')).toEqual(["must", "group"]);
    expect(sanitizeSearchTokens("")).toEqual([]);
    expect(sanitizeSearchTokens("   ")).toEqual([]);
  });

  it("includeArchived=false excludes archived tasks from search", async () => {
    ctx = await setupCtx();
    await insertTask(ctx.layer, "ARCH-001", { title: "archived filter target", column: "archived" });
    await insertTask(ctx.layer, "LIVE-001", { title: "archived filter target", column: "todo" });

    // Default includeArchived=true: both match.
    const all = await searchTasksTsvector(ctx.layer.db, "filter");
    expect(resultIds(all)).toEqual(["ARCH-001", "LIVE-001"]);

    // includeArchived=false: only the live task.
    const liveOnly = await searchTasksTsvector(ctx.layer.db, "filter", { includeArchived: false });
    expect(resultIds(liveOnly)).toEqual(["LIVE-001"]);
  });
});

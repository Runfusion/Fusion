/**
 * SQLite-to-PostgreSQL migration tool tests (U9 / VAL-MIGRATE-001..006).
 *
 * FNXC:PostgresMigration 2026-06-24-09:00:
 * Integration tests against a real PostgreSQL instance for the
 * SQLite-to-PostgreSQL data migration tool. Each test creates a uniquely-named
 * fresh PostgreSQL database, applies the baseline schema, populates a SQLite
 * source with representative rows (including JSON, bytea, identity, generated,
 * and soft-deleted columns), runs the migrator, and verifies the migrated data
 * round-trips with identical shape and the assertions VAL-MIGRATE-001..006.
 *
 * Coverage targets:
 *   VAL-MIGRATE-001 — row-count verified migration (per-table counts match)
 *   VAL-MIGRATE-002 — idempotent re-run (no-op / clean re-sync)
 *   VAL-MIGRATE-003 — JSON column fidelity (text-JSON → jsonb round-trip)
 *   VAL-MIGRATE-004 — sequence continuity (identity sequences bumped to max+1)
 *   VAL-MIGRATE-005 — dry-run reports without writing
 *   VAL-MIGRATE-006 — migrated DB passes store-shape queries (the migrator
 *     produces a target a native store can read — verified by direct column
 *     shape queries here; the full store-test parity is exercised in the
 *     cutover milestone end-to-end tests)
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "../../sqlite-adapter.js";
import {
  migrateSqliteToPostgres,
  toSnakeCase,
} from "../../postgres/sqlite-migrator.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

/**
 * FNXC:PostgresMigration 2026-06-24-09:05:
 * Create a uniquely-named fresh PostgreSQL database. Mirrors the
 * schema-applier test harness.
 */
function uniqueDbName(): string {
  return `fusion_migrate_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

function adminExec(statement: string): void {
  execSync(
    `psql -h localhost -p 5432 -U ${process.env.USER ?? "postgres"} -d postgres -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

/** A subset of the tasks table schema (the columns the migration tests touch). */
const TASKS_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT,
  description TEXT NOT NULL,
  "column" TEXT NOT NULL,
  dependencies TEXT DEFAULT '[]',
  steps TEXT DEFAULT '[]',
  comments TEXT DEFAULT '[]',
  customFields TEXT DEFAULT '{}',
  deletedAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`;

const SECRETS_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  key TEXT,
  valueCiphertext BLOB,
  nonce BLOB,
  description TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`;

const AGENT_HEARTBEATS_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentId TEXT,
  timestamp TEXT,
  status TEXT,
  runId TEXT
);
`;

const CONFIG_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings TEXT DEFAULT '{}',
  updatedAt TEXT
);
`;

/*
FNXC:PostgresMigration 2026-07-13-20:30:
Legacy camelCase-named table. Older SQLite tables are camelCase (activityLog,
runAuditEvents, mergeQueue, projectNodePathMappings, …) while every PostgreSQL
table is snake_case. The migrator must snake_case the TABLE name too — a bug
where only column names were converted silently skipped all 22 such tables
("no PostgreSQL counterpart") and surfaced post-cutover as
`Project/node path mapping not found`.
*/
const ACTIVITY_LOG_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS activityLog (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  taskId TEXT,
  taskTitle TEXT,
  details TEXT NOT NULL,
  metadata TEXT
);
`;

/** Legacy research rows allowed NULL before PostgreSQL made these JSON fields required. */
const RESEARCH_RUNS_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS researchRuns (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  status TEXT NOT NULL,
  sources TEXT,
  events TEXT,
  tags TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`;

/**
 * A minimal agents table so agent_heartbeats has a parent row to satisfy the
 * FK constraint that is re-enabled after the migration completes. Includes
 * the NOT NULL columns (role, state) the PostgreSQL schema requires.
 */
const AGENTS_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle',
  taskId TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastHeartbeatAt TEXT,
  metadata TEXT DEFAULT '{}',
  data TEXT DEFAULT '{}'
);
`;

/**
 * Build a populated SQLite project database (fusion.db) inside a temp dir.
 * Inserts representative rows across tasks, secrets, agent_heartbeats, config.
 */
function buildPopulatedSqliteProject(fusionDir: string): void {
  const db = new DatabaseSync(join(fusionDir, "fusion.db"));
  try {
    db.exec(TASKS_SQLITE_DDL);
    db.exec(SECRETS_SQLITE_DDL);
    db.exec(AGENT_HEARTBEATS_SQLITE_DDL);
    db.exec(CONFIG_SQLITE_DDL);
    db.exec(AGENTS_SQLITE_DDL);
    db.exec(ACTIVITY_LOG_SQLITE_DDL);
    db.exec(RESEARCH_RUNS_SQLITE_DDL);

    // Legacy camelCase table rows — must land in project.activity_log.
    const insertActivity = db.prepare(
      `INSERT INTO activityLog (id, timestamp, type, taskId, taskTitle, details, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertActivity.run("act-1", "2026-06-01T00:00:00Z", "task:created", "FN-100", "First task", "created", JSON.stringify({ source: "test" }));
    insertActivity.run("act-2", "2026-06-01T01:00:00Z", "task:moved", "FN-100", "First task", "todo -> in-progress", null);

    db.prepare(
      `INSERT INTO researchRuns (id, query, status, sources, events, tags, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "RR-legacy-null-json",
      "legacy research",
      "failed",
      null,
      "",
      null,
      "2026-06-01T00:00:00Z",
      "2026-06-01T00:01:00Z",
    );

    // Insert agents so agent_heartbeats FK is satisfiable post-migration.
    const insertAgent = db.prepare(`INSERT INTO agents (id, name, role, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`);
    insertAgent.run("agent-1", "Agent One", "coder", "idle", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
    insertAgent.run("agent-2", "Agent Two", "coder", "idle", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
    insertAgent.run("agent-3", "Agent Three", "coder", "idle", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");

    // Insert tasks — including JSON columns and a soft-deleted row.
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, title, description, "column", dependencies, steps, comments, customFields, deletedAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertTask.run(
      "FN-100",
      "First task",
      "desc",
      "todo",
      JSON.stringify([{ taskId: "FN-99", type: "blocks" }]),
      JSON.stringify([{ id: "s1", name: "step one" }]),
      JSON.stringify([{ author: "agent", body: "hello" }]),
      JSON.stringify({ priority: "high", labels: ["a", "b"] }),
      null,
      "2026-06-01T00:00:00Z",
      "2026-06-01T00:00:00Z",
    );
    insertTask.run(
      "FN-101",
      "Soft-deleted task",
      "desc",
      "todo",
      "[]",
      "[]",
      "[]",
      "{}",
      "2026-06-02T00:00:00Z", // deletedAt set — soft-deleted row
      "2026-06-01T00:00:00Z",
      "2026-06-02T00:00:00Z",
    );

    // Insert secrets with BLOB columns.
    const insertSecret = db.prepare(
      `INSERT INTO secrets (id, key, valueCiphertext, nonce, description, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSecret.run("sec-1", "API_KEY", Buffer.from([1, 2, 3, 4, 5]), Buffer.from([9, 8, 7]), "a secret", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");

    // Insert agent_heartbeats with AUTOINCREMENT.
    const insertHb = db.prepare(
      `INSERT INTO agent_heartbeats (agentId, timestamp, status, runId) VALUES (?, ?, ?, ?)`,
    );
    insertHb.run("agent-1", "2026-06-01T00:00:00Z", "alive", "run-1");
    insertHb.run("agent-1", "2026-06-01T00:01:00Z", "alive", "run-1");
    insertHb.run("agent-2", "2026-06-01T00:02:00Z", "dead", "run-2");

    // Insert config row.
    db.prepare(
      `INSERT INTO config (id, settings, updatedAt) VALUES (1, ?, ?)`,
    ).run(JSON.stringify({ autoMerge: true }), "2026-06-01T00:00:00Z");
  } finally {
    db.close();
  }
}

/** Build a populated SQLite archive database. */
function buildPopulatedSqliteArchive(fusionDir: string): void {
  const db = new DatabaseSync(join(fusionDir, "archive.db"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS archived_tasks (
        id TEXT PRIMARY KEY,
        taskJson TEXT NOT NULL,
        prompt TEXT,
        archivedAt TEXT NOT NULL,
        title TEXT,
        description TEXT NOT NULL,
        comments TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        columnMovedAt TEXT
      );
    `);
    db.prepare(
      `INSERT INTO archived_tasks (id, taskJson, prompt, archivedAt, title, description, comments, createdAt, updatedAt, columnMovedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "ARCH-1",
      JSON.stringify({ id: "ARCH-1", title: "archived" }),
      "do thing",
      "2026-06-01T00:00:00Z",
      "Archived task",
      "desc",
      JSON.stringify([{ note: "done" }]),
      "2026-05-01T00:00:00Z",
      "2026-05-02T00:00:00Z",
      "2026-06-01T00:00:00Z",
    );
  } finally {
    db.close();
  }
}

interface TestCtx {
  dbName: string;
  sqlConn: ReturnType<typeof postgres>;
  db: ReturnType<typeof drizzle>;
  fusionDir: string;
}

async function setupCtx(): Promise<TestCtx> {
  const fusionDir = mkdtempSync(join(tmpdir(), "fusion-migrate-"));
  buildPopulatedSqliteProject(fusionDir);
  buildPopulatedSqliteArchive(fusionDir);

  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // ignore
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;
  const sqlConn = postgres(testUrl, { max: 3, prepare: false, onnotice: () => {} });
  const db = drizzle(sqlConn);
  return { dbName, sqlConn, db, fusionDir };
}

async function teardownCtx(ctx: TestCtx | null): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.sqlConn.end({ timeout: 5 });
  } catch {
    // best-effort
  }
  try {
    adminExec(`DROP DATABASE IF EXISTS "${ctx.dbName}"`);
  } catch {
    // best-effort
  }
  try {
    rmSync(ctx.fusionDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

pgDescribe("SQLite-to-PostgreSQL migrator", () => {
  let ctx: TestCtx | null = null;

  beforeEach(async () => {
    ctx = await setupCtx();
  });

  afterEach(async () => {
    await teardownCtx(ctx);
    ctx = null;
  });

  it("toSnakeCase maps camelCase to snake_case correctly", () => {
    expect(toSnakeCase("lineageId")).toBe("lineage_id");
    expect(toSnakeCase("deletedAt")).toBe("deleted_at");
    expect(toSnakeCase("id")).toBe("id");
    expect(toSnakeCase("valueCiphertext")).toBe("value_ciphertext");
    expect(toSnakeCase("tokenUsagePerModel")).toBe("token_usage_per_model");
    expect(toSnakeCase("customFields")).toBe("custom_fields");
  });

  // VAL-MIGRATE-001 — row-count verified migration
  it("migrates all rows with matching per-table row counts", async () => {
    const report = await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "archive.db"), pgSchema: "archive" as const },
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    expect(report.dryRun).toBe(false);
    const byTable = new Map(report.tables.map((t) => [`${t.schema}.${t.table}`, t]));

    const tasks = byTable.get("project.tasks")!;
    expect(tasks.sourceRows).toBe(2);
    expect(tasks.targetRows).toBe(2);
    expect(tasks.verified).toBe(true);

    const secrets = byTable.get("project.secrets")!;
    expect(secrets.sourceRows).toBe(1);
    expect(secrets.targetRows).toBe(1);
    expect(secrets.verified).toBe(true);

    const hbs = byTable.get("project.agent_heartbeats")!;
    expect(hbs.sourceRows).toBe(3);
    expect(hbs.targetRows).toBe(3);
    expect(hbs.verified).toBe(true);

    const config = byTable.get("project.config")!;
    expect(config.sourceRows).toBe(1);
    expect(config.targetRows).toBe(1);

    const archived = byTable.get("archive.archived_tasks")!;
    expect(archived.sourceRows).toBe(1);
    expect(archived.targetRows).toBe(1);
  });

  // FNXC:PostgresMigration 2026-07-13-20:30:
  // Legacy camelCase TABLE names (activityLog, runAuditEvents, mergeQueue,
  // projectNodePathMappings, …) must be snake_cased when matched against
  // PostgreSQL, exactly like column names. A bug that matched table names
  // verbatim silently skipped all 22 legacy camelCase tables ("no PostgreSQL
  // counterpart"), surfacing post-cutover as
  // `Project/node path mapping not found` on engine start.
  it("migrates legacy camelCase-named tables into their snake_case PostgreSQL counterparts", async () => {
    const report = await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    const activity = report.tables.find((t) => t.table === "activity_log");
    expect(activity, "activityLog must not be silently skipped").toBeDefined();
    expect(activity!.sourceRows).toBe(2);
    expect(activity!.targetRows).toBe(2);
    expect(activity!.verified).toBe(true);

    const rows = (await ctx!.db.execute(sql`
      SELECT id, task_id, metadata FROM project.activity_log ORDER BY id
    `)) as unknown as Array<{ id: string; task_id: string | null; metadata: unknown }>;
    expect(rows.map((r) => r.id)).toEqual(["act-1", "act-2"]);
    expect(rows[0].task_id).toBe("FN-100");
    expect(rows[0].metadata).toEqual({ source: "test" });
  });

  // FNXC:PostgresMigration 2026-06-26-16:00 (fix migration-review P1 #14):
  // The `data` column appears in MULTIPLE tables with DIFFERENT types: it is
  // `jsonb` in agents/workflow_work_items/etc but would be `text` in a
  // hypothetical archived_tasks.data. The OLD resolveColumnMapping joined
  // information_schema by column name only, so `data` picked up an arbitrary
  // row from any table, producing a nondeterministic type classification and
  // breaking the batch on `::jsonb` mismatch. This test verifies the column
  // mapping is now table-scoped: the agents.data column is classified as
  // jsonb (its type in the agents table specifically), not text.
  it("classifies the jsonb `data` column correctly per-table (P1 #14 collision fix)", async () => {
    const report = await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    // The agents table was migrated with the `data` column treated as jsonb.
    // If the collision bug were present, the batch would abort on the
    // `::jsonb` cast against a text-classified column, and agents would NOT
    // verify. Verify it succeeded and the data round-trips as jsonb.
    const agents = report.tables.find((t) => t.table === "agents");
    expect(agents, "agents table should be in the migration report").toBeDefined();
    expect(agents!.verified).toBe(true);
    expect(agents!.sourceRows).toBe(3);
    expect(agents!.targetRows).toBe(3);

    // Confirm the column is actually jsonb in the target (not text).
    const colType = (await ctx!.db.execute(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'agents' AND column_name = 'data'
    `)) as unknown as Array<{ data_type: string }>;
    expect(colType[0].data_type).toBe("jsonb");
  });

  // FNXC:PostgresMigration 2026-06-26-16:05 (fix migration-review P1 #15):
  // Verification now includes a content checksum (MD5 over the canonical,
  // type-normalized row stream), not just a row count. The old `targetRows >=
  // sourceRows` check could not detect content divergence on re-run (ON
  // CONFLICT DO NOTHING always "succeeded") or under-migration masked by
  // pre-existing rows. This test corrupts a target row AFTER migration and
  // verifies a re-run still reports `verified: true` only when content
  // actually matches (the idempotent re-run should re-sync and verify).
  it("content verification detects divergence and re-sync corrects it (P1 #15)", async () => {
    const sources = [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ];

    // First migration: clean.
    const first = await migrateSqliteToPostgres(ctx!.db, sources);
    const tasksFirst = first.tables.find((t) => t.table === "tasks")!;
    expect(tasksFirst.verified).toBe(true);

    // Corrupt a target row's title (content divergence the row-count check
    // would miss — same number of rows).
    await ctx!.db.execute(sql`UPDATE project.tasks SET title = 'CORRUPTED' WHERE id = 'FN-100'`);

    // Re-run: ON CONFLICT DO NOTHING means the corrupt row is NOT overwritten
    // (same PK), so the content checksum MUST now mismatch and report
    // verified: false for tasks. This proves the content check catches what
    // the row-count check could not.
    const second = await migrateSqliteToPostgres(ctx!.db, sources);
    const tasksSecond = second.tables.find((t) => t.table === "tasks")!;
    expect(tasksSecond.verified).toBe(false);
    expect(tasksSecond.targetRows).toBe(tasksSecond.sourceRows); // counts still match
  });

  // VAL-MIGRATE-003 — JSON column fidelity
  it("round-trips JSON columns with identical shape (text-JSON → jsonb)", async () => {
    await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    const tasks = (await ctx!.db.execute(sql`
      SELECT id, dependencies, steps, comments, custom_fields FROM project.tasks WHERE id = 'FN-100'
    `)) as unknown as Array<Record<string, unknown>>;
    const t = tasks[0];
    expect(t.dependencies).toEqual([{ taskId: "FN-99", type: "blocks" }]);
    expect(t.steps).toEqual([{ id: "s1", name: "step one" }]);
    expect(t.comments).toEqual([{ author: "agent", body: "hello" }]);
    expect(t.custom_fields).toEqual({ priority: "high", labels: ["a", "b"] });

    // Verify the column type is actually jsonb.
    const colInfo = (await ctx!.db.execute(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'dependencies'
    `)) as unknown as Array<{ data_type: string }>;
    expect(colInfo[0].data_type).toBe("jsonb");
  });

  it("materializes defaults for legacy NULL values targeting required jsonb columns", async () => {
    await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    const rows = (await ctx!.db.execute(sql`
      SELECT sources, events, tags
      FROM project.research_runs WHERE id = 'RR-legacy-null-json'
    `)) as unknown as Array<{ sources: unknown; events: unknown; tags: unknown }>;
    expect(rows[0]).toEqual({ sources: [], events: [], tags: [] });
  });

  // VAL-MIGRATE-003 — bytea fidelity
  it("round-trips bytea columns (BLOB → bytea) byte-identical", async () => {
    await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    const rows = (await ctx!.db.execute(sql`
      SELECT key, value_ciphertext, nonce FROM project.secrets WHERE id = 'sec-1'
    `)) as unknown as Array<{ key: string; value_ciphertext: Buffer; nonce: Buffer }>;
    expect(rows[0].key).toBe("API_KEY");
    expect(Buffer.isBuffer(rows[0].value_ciphertext)).toBe(true);
    expect(Array.from(rows[0].value_ciphertext)).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(rows[0].nonce)).toEqual([9, 8, 7]);
  });

  // VAL-DATA-005/006 + soft-delete handling: deletedAt rows are migrated verbatim
  it("migrates soft-deleted rows verbatim (deletedAt preserved)", async () => {
    await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    const deleted = (await ctx!.db.execute(sql`
      SELECT id, deleted_at FROM project.tasks WHERE deleted_at IS NOT NULL
    `)) as unknown as Array<{ id: string; deleted_at: string }>;
    expect(deleted).toHaveLength(1);
    expect(deleted[0].id).toBe("FN-101");
    expect(deleted[0].deleted_at).toBe("2026-06-02T00:00:00Z");
  });

  // VAL-MIGRATE-004 — sequence continuity
  it("bumps identity sequences to max(id)+1 so new inserts do not collide", async () => {
    const report = await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    // The agent_heartbeats table has an identity column. After migration,
    // the sequence should be bumped so the next insert continues past max(id).
    const bump = report.sequenceBumps.find(
      (b) => b.table === "agent_heartbeats" && b.column === "id",
    );
    expect(bump, "agent_heartbeats.id sequence should be bumped").toBeTruthy();
    expect(bump!.maxValue).toBe(3);
    expect(bump!.newValue).toBe(4);

    // Insert a new row without specifying id — it should get id=4, not collide.
    await ctx!.db.execute(sql`
      INSERT INTO project.agent_heartbeats (agent_id, timestamp, status, run_id)
      VALUES ('agent-3', '2026-06-03', 'alive', 'run-3')
    `);
    const rows = (await ctx!.db.execute(sql`
      SELECT id, agent_id FROM project.agent_heartbeats WHERE agent_id = 'agent-3'
    `)) as unknown as Array<{ id: number; agent_id: string }>;
    expect(rows[0].id).toBe(4);
  });

  // VAL-MIGRATE-002 — idempotent re-run
  it("is idempotent: re-running does not duplicate or lose rows", async () => {
    const sources = [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ];

    const first = await migrateSqliteToPostgres(ctx!.db, sources);
    const firstCounts = new Map(first.tables.map((t) => [`${t.schema}.${t.table}`, t.targetRows]));

    // FNXC:PostgresMigration 2026-07-13-21:05:
    // insertedRows must report rows ACTUALLY inserted (RETURNING-based count):
    // every copied row on the first run, zero on the idempotent re-run. The
    // old driver-wrapper count read 0 even when every row landed.
    for (const t of first.tables) {
      if (!t.skipped) {
        expect(t.insertedRows, `${t.schema}.${t.table} first-run insertedRows`).toBe(t.sourceRows);
      }
    }

    // Second run — should be a clean re-sync (ON CONFLICT DO NOTHING).
    const second = await migrateSqliteToPostgres(ctx!.db, sources);
    for (const t of second.tables) {
      const key = `${t.schema}.${t.table}`;
      expect(t.targetRows, `${key} row count should be unchanged on re-run`).toBe(firstCounts.get(key));
      expect(t.verified, `${key} should still verify`).toBe(true);
      expect(t.insertedRows, `${key} re-run should insert nothing`).toBe(0);
    }
  });

  // VAL-MIGRATE-005 — dry-run reports without writing
  it("dry-run reports the plan without modifying PostgreSQL", async () => {
    const report = await migrateSqliteToPostgres(
      ctx!.db,
      [{ sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const }],
      { dryRun: true },
    );

    expect(report.dryRun).toBe(true);
    // The dry-run should report source rows.
    const tasks = report.tables.find((t) => t.table === "tasks")!;
    expect(tasks.sourceRows).toBe(2);
    expect(tasks.skipped).toBe(true);

    // PostgreSQL target should have ZERO rows (baseline applied but no data copied).
    const pgTasks = (await ctx!.db.execute(sql`SELECT COUNT(*)::int AS n FROM project.tasks`)) as unknown as Array<{ n: number }>;
    expect(pgTasks[0].n).toBe(0);

    const pgSecrets = (await ctx!.db.execute(sql`SELECT COUNT(*)::int AS n FROM project.secrets`)) as unknown as Array<{ n: number }>;
    expect(pgSecrets[0].n).toBe(0);

    // No sequences should have been bumped in dry-run.
    expect(report.sequenceBumps).toHaveLength(0);
  });

  // VAL-SEARCH-002 (search_vector population) — generated column auto-populates
  it("populates the search_vector generated column after migration", async () => {
    await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    // The search_vector column is GENERATED ALWAYS; it should auto-populate from
    // the inserted title/description columns.
    const rows = (await ctx!.db.execute(sql`
      SELECT id, search_vector IS NOT NULL AS has_vec FROM project.tasks ORDER BY id
    `)) as unknown as Array<{ id: string; has_vec: boolean }>;
    expect(rows.every((r) => r.has_vec)).toBe(true);
  });

  // VAL-MIGRATE-006 — migrated DB shape matches native store expectations
  it("produces a target whose columns match the native schema shape", async () => {
    await migrateSqliteToPostgres(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    // Verify the migrated data is readable with the same query shape a native
    // store would use — this is the VAL-MIGRATE-006 contract at the data level.
    const tasksCount = (await ctx!.db.execute(sql`
      SELECT COUNT(*)::int AS n FROM project.tasks WHERE deleted_at IS NULL
    `)) as unknown as Array<{ n: number }>;
    // One live task (FN-100), one soft-deleted (FN-101).
    expect(tasksCount[0].n).toBe(1);

    const configSettings = (await ctx!.db.execute(sql`
      SELECT settings FROM project.config WHERE id = 1
    `)) as unknown as Array<{ settings: { autoMerge: boolean } }>;
    expect(configSettings[0].settings).toEqual({ autoMerge: true });
  });
});

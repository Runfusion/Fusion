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
import { join, resolve } from "node:path";
import { DatabaseSync } from "../../sqlite-adapter.js";
import {
  formatMigrationProgress,
  migrateLegacyProjectPluginRows,
  migrateSqliteToPostgres,
  toSnakeCase,
  type MigrationProgressEvent,
} from "../../postgres/sqlite-migrator.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";

const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

describe("SQLite migration CLI progress", () => {
  it("formats table copy progress with position, row counts, and percentage", () => {
    expect(formatMigrationProgress({
      phase: "table-progress",
      sourceSchema: "project",
      table: "run_audit_events",
      tableIndex: 42,
      tableCount: 124,
      processedRows: 63_400,
      sourceRows: 252_947,
    })).toBe("[42/124] project.run_audit_events: processed 63,400/252,947 rows (25%)");
  });

  it("makes transaction rollback explicit on failure", () => {
    expect(formatMigrationProgress({
      phase: "failed",
      error: "project.tasks failed verification",
    })).toBe("FAILED — migration transaction rolled back: project.tasks failed verification");
  });

  it("distinguishes committed verification failures from transaction rollbacks", () => {
    expect(formatMigrationProgress({
      phase: "failed",
      tableCount: 124,
      failedTables: 2,
    })).toBe("FAILED — 2/124 tables failed verification; migration will not be marked complete.");
  });
});

/**
 * FNXC:PostgresMigration 2026-06-24-09:05:
 * Create a uniquely-named fresh PostgreSQL database. Mirrors the
 * schema-applier test harness.
 */
function uniqueDbName(): string {
  return `fusion_migrate_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/*
FNXC:PgTestAuthFix 2026-07-14-00:00:
The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
*/
function adminExec(statement: string): void {
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
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
  updatedAt TEXT NOT NULL,
  projectId TEXT,
  -- FNXC:EphemeralAgentTaskCreation 2026-07-30-16:00: legacy SQLite cutover sources preserve the durable proposal key so a migrated task remains the idempotency anchor.
  proposalClaimId TEXT
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

const LEGACY_PLUGINS_SQLITE_DDL = `
CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  author TEXT,
  homepage TEXT,
  path TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'installed',
  settings TEXT DEFAULT '{}',
  settingsSchema TEXT,
  error TEXT,
  dependencies TEXT DEFAULT '[]',
  aiScanOnLoad INTEGER NOT NULL DEFAULT 0,
  lastSecurityScan TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`;

function insertLegacyPlugin(
  db: DatabaseSync,
  input: {
    id: string;
    name: string;
    version: string;
    enabled: number;
    state: string;
    error?: string | null;
    updatedAt: string;
  },
): void {
  db.prepare(`
    INSERT INTO plugins
      (id, name, version, description, author, homepage, path, enabled, state,
       settings, settingsSchema, error, dependencies, aiScanOnLoad,
       lastSecurityScan, createdAt, updatedAt)
    VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)
  `).run(
    input.id,
    input.name,
    input.version,
    `/plugins/${input.id}`,
    input.enabled,
    input.state,
    JSON.stringify({ source: input.name }),
    JSON.stringify({ source: { type: "string" } }),
    input.error ?? null,
    JSON.stringify([`${input.id}-dependency`]),
    "2026-01-01T00:00:00.000Z",
    input.updatedAt,
  );
}

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

/** Legacy workflow rows could persist an empty IR before write validation tightened. */
const WORKFLOWS_SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ir TEXT NOT NULL,
  layout TEXT NOT NULL DEFAULT '{}',
  kind TEXT NOT NULL DEFAULT 'workflow',
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
    db.exec(WORKFLOWS_SQLITE_DDL);

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

    const insertWorkflow = db.prepare(
      `INSERT INTO workflows (id, name, description, ir, layout, kind, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const workflowRows = [
      ["WF-legacy-empty-ir", "Legacy empty IR", ""],
      ["WF-legacy-whitespace-ir", "Legacy whitespace IR", " \t "],
      ["WF-legacy-malformed-ir", "Legacy malformed IR", "not-json"],
      ["WF-legacy-scalar-ir", "Legacy scalar IR", "42"],
    ] as const;
    for (const [id, name, ir] of workflowRows) {
      insertWorkflow.run(
        id,
        name,
        "",
        ir,
        "{}",
        "workflow",
        "2026-06-01T00:00:00Z",
        "2026-06-01T00:01:00Z",
      );
    }

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

  const migrateTest = (
    db: Parameters<typeof migrateSqliteToPostgres>[0],
    sources: Parameters<typeof migrateSqliteToPostgres>[1],
    options: Parameters<typeof migrateSqliteToPostgres>[2] = {},
  ) => migrateSqliteToPostgres(db, sources, { projectId: "migration-test", ...options });

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
    const report = await migrateTest(ctx!.db, [
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

  /*
  FNXC:CliMigrationProgress 2026-07-14-13:47:
  CLI-triggered first-boot migrations must expose schema preparation, source discovery, per-table copy/verification, and terminal success so operators can distinguish a long-running copy from a stalled or failed startup.
  */
  it("reports structured progress through planning, table verification, and completion", async () => {
    const progress: MigrationProgressEvent[] = [];
    let rejectFirstCallback = true;
    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const }],
      {
        onProgress: (event) => {
          progress.push(event);
          if (rejectFirstCallback) {
            rejectFirstCallback = false;
            return Promise.reject(new Error("test progress sink failure"));
          }
        },
      },
    );

    expect(progress[0]?.phase).toBe("preparing-schema");
    expect(progress.some((event) => event.phase === "scanning-source")).toBe(true);
    expect(progress.some((event) => event.phase === "copy-started" && event.tableCount === report.tables.length)).toBe(true);
    expect(progress.some((event) => event.phase === "table-started" && event.table === "tasks")).toBe(true);
    expect(progress.some((event) => event.phase === "table-verifying" && event.table === "tasks")).toBe(true);
    expect(progress.some((event) => event.phase === "table-complete" && event.table === "tasks")).toBe(true);
    expect(progress.at(-1)?.phase).toBe("copy-complete");
    expect(progress.filter((event) => event.phase === "table-complete")).toHaveLength(report.tables.length);
  });

  it("reports bounded quarter progress for a multi-batch table without a redundant 100% event", async () => {
    const sqlitePath = join(ctx!.fusionDir, "fusion.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      const insert = legacy.prepare(
        `INSERT INTO tasks (id, title, description, "column", createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (let index = 0; index < 648; index += 1) {
        insert.run(
          `FN-PROGRESS-${index}`,
          `Progress ${index}`,
          "progress fixture",
          "todo",
          "2026-07-14T00:00:00Z",
          "2026-07-14T00:00:00Z",
        );
      }
    } finally {
      legacy.close();
    }

    const progress: MigrationProgressEvent[] = [];
    await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { onProgress: (event) => { progress.push(event); } },
    );
    const taskProgress = progress.filter(
      (event): event is Extract<MigrationProgressEvent, { phase: "table-progress" }> =>
        event.phase === "table-progress" && event.table === "tasks",
    );

    expect(taskProgress.map((event) => Math.floor((event.processedRows / event.sourceRows) * 4))).toEqual([1, 2, 3]);
    expect(taskProgress.every((event) => event.processedRows < event.sourceRows)).toBe(true);
  });

  it("reports a terminal dry-run plan without implying that data was written", async () => {
    const progress: MigrationProgressEvent[] = [];
    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const }],
      { dryRun: true, onProgress: (event) => { progress.push(event); } },
    );

    expect(report.dryRun).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      phase: "dry-run-complete",
      tableCount: report.tables.length,
    });
    expect(formatMigrationProgress(progress.at(-1)!)).toContain("no data written");
  });

  /*
  FNXC:PostgresMigration 2026-07-13-22:37:
  Every user table in a legacy SQLite database must be represented in the migration report. An unknown table is retained as an explicit failed verification so startup cannot claim a complete cutover while silently abandoning operator data.
  */
  it("reports an unmapped SQLite user table as a verification failure", async () => {
    const sqlitePath = join(ctx!.fusionDir, "fusion.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`CREATE TABLE operator_extension_data (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`);
      legacy.prepare(`INSERT INTO operator_extension_data (id, payload) VALUES (?, ?)`).run("row-1", "must-not-disappear");
    } finally {
      legacy.close();
    }

    const progress: MigrationProgressEvent[] = [];
    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { onProgress: (event) => { progress.push(event); } },
    );

    expect(report.tables).toContainEqual(
      expect.objectContaining({
        schema: "project",
        table: "operator_extension_data",
        sourceRows: 1,
        insertedRows: 0,
        verified: false,
        skipped: false,
      }),
    );
    expect(progress.at(-1)).toMatchObject({
      phase: "failed",
      failedTables: 1,
    });
  });

  /*
  FNXC:PostgresLegacyPreservation 2026-07-14-12:10:
  Unknown historical mission evidence rows are operator data, not disposable schema drift. Preserve every typed SQLite cell under the resolved project partition, including BLOB bytes, and make retries idempotent without allowing identical legacy IDs from separate projects to collide.
  */
  it("losslessly preserves opaque mission evidence rows per project and on retry", async () => {
    const makeLegacyProject = (filename: string): string => {
      const sqlitePath = join(ctx!.fusionDir, filename);
      const legacy = new DatabaseSync(sqlitePath);
      try {
        legacy.exec(`
          CREATE TABLE mission_feature_evidence_links (
            id TEXT NOT NULL,
            featureId TEXT,
            confidence REAL,
            payload BLOB,
            nullableValue TEXT
          )
        `);
        legacy.prepare(`INSERT INTO mission_feature_evidence_links VALUES (?, ?, ?, ?, ?)`)
          .run("shared-id", "feature-1", 0.75, Buffer.from([0, 255, 16]), null);
      } finally {
        legacy.close();
      }
      return sqlitePath;
    };
    const projectAPath = makeLegacyProject("mission-project-a.db");
    const projectBPath = makeLegacyProject("mission-project-b.db");

    const first = await migrateTest(
      ctx!.db,
      [{ sqlitePath: projectAPath, pgSchema: "project" as const }],
      { projectId: "project-a" },
    );
    const retry = await migrateTest(
      ctx!.db,
      [{ sqlitePath: projectAPath, pgSchema: "project" as const }],
      { projectId: "project-a" },
    );
    const secondProject = await migrateTest(
      ctx!.db,
      [{ sqlitePath: projectBPath, pgSchema: "project" as const }],
      { projectId: "project-b" },
    );

    for (const report of [first, retry, secondProject]) {
      expect(report.tables).toContainEqual(expect.objectContaining({
        table: "mission_feature_evidence_links",
        sourceRows: 1,
        verified: true,
        skipped: false,
      }));
    }
    expect(retry.tables.find((table) => table.table === "mission_feature_evidence_links")?.insertedRows).toBe(0);
    const rows = await ctx!.db.execute(sql`
      SELECT project_id, legacy_row_hash, legacy_row, source_schema_sql
      FROM project.mission_feature_evidence_links
      ORDER BY project_id
    `) as unknown as Array<{
      project_id: string;
      legacy_row_hash: string;
      legacy_row: Record<string, unknown>;
      source_schema_sql: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows.map(({ project_id }) => project_id)).toEqual(["project-a", "project-b"]);
    expect(rows[0].legacy_row).toEqual({
      confidence: { type: "number", value: "0.75" },
      featureId: { type: "text", value: "feature-1" },
      id: { type: "text", value: "shared-id" },
      nullableValue: { type: "null" },
      payload: { type: "blob", value: "AP8Q" },
    });
    expect(rows[0].legacy_row_hash).toBe(rows[1].legacy_row_hash);
    expect(rows[0].source_schema_sql).toContain("CREATE TABLE mission_feature_evidence_links");
  });

  /*
  FNXC:PostgresMigrationNulSanitize 2026-07-17-10:05:
  Legacy SQLite data can contain U+0000 in TEXT cells and inside stored JSON documents. PostgreSQL rejects NUL in text and jsonb columns ("unsupported Unicode escape sequence" / "\u0000 cannot be converted to text"), which aborted the first-boot auto-migration. The migrator must strip NUL from plain text cells, JSON string values and object keys, malformed-JSON scalars, and opaque legacy-preservation cells — and the content-checksum verification must still pass on the sanitized rows.
  */
  it("strips U+0000 from legacy text and JSON values so the migration succeeds and verifies", async () => {
    const sqlitePath = join(ctx!.fusionDir, "fusion.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      const insert = legacy.prepare(
        `INSERT INTO tasks (id, title, description, "column", customFields, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        "FN-NUL-1",
        "nul\u0000title",
        "desc\u0000ription",
        "todo",
        JSON.stringify({ ["key\u0000nul"]: "value\u0000nul", nested: ["a\u0000b"] }),
        "2026-07-17T00:00:00Z",
        "2026-07-17T00:00:00Z",
      );
      insert.run(
        "FN-NUL-2",
        "clean title",
        "malformed json cell",
        "todo",
        "not-json\u0000tail",
        "2026-07-17T00:00:00Z",
        "2026-07-17T00:00:00Z",
      );
    } finally {
      legacy.close();
    }

    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
    );
    const tasks = report.tables.find((table) => table.table === "tasks")!;
    expect(tasks.verified).toBe(true);

    const rows = await ctx!.db.execute(sql`
      SELECT id, title, description, custom_fields
      FROM project.tasks
      WHERE id IN ('FN-NUL-1', 'FN-NUL-2')
      ORDER BY id
    `) as unknown as Array<{
      id: string;
      title: string | null;
      description: string;
      custom_fields: unknown;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("nultitle");
    expect(rows[0].description).toBe("description");
    expect(rows[0].custom_fields).toEqual({ keynul: "valuenul", nested: ["ab"] });
    // Malformed JSON is preserved as a jsonb string scalar, minus the NUL.
    expect(rows[1].custom_fields).toBe("not-jsontail");
  });

  it("strips U+0000 from opaque legacy-preservation text cells", async () => {
    const sqlitePath = join(ctx!.fusionDir, "mission-nul.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`CREATE TABLE mission_feature_evidence_links (id TEXT, featureId TEXT)`);
      legacy.prepare(`INSERT INTO mission_feature_evidence_links VALUES (?, ?)`)
        .run("nul\u0000id", "feat\u0000ure");
    } finally {
      legacy.close();
    }

    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { projectId: "project-nul" },
    );
    expect(report.tables).toContainEqual(expect.objectContaining({
      table: "mission_feature_evidence_links",
      sourceRows: 1,
      verified: true,
      skipped: false,
    }));

    const rows = await ctx!.db.execute(sql`
      SELECT legacy_row FROM project.mission_feature_evidence_links
      WHERE project_id = 'project-nul'
    `) as unknown as Array<{ legacy_row: Record<string, unknown> }>;
    expect(rows).toEqual([{
      legacy_row: {
        featureId: { type: "text", value: "feature" },
        id: { type: "text", value: "nulid" },
      },
    }]);
  });

  it("requires a project identity before preserving opaque project rows", async () => {
    const sqlitePath = join(ctx!.fusionDir, "mission-unbound.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`CREATE TABLE mission_feature_evidence_links (id TEXT, payload BLOB)`);
      legacy.prepare(`INSERT INTO mission_feature_evidence_links VALUES (?, ?)`)
        .run("row-1", Buffer.from([1, 2, 3]));
    } finally {
      legacy.close();
    }

    await expect(migrateSqliteToPostgres(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { migrationKey: "unbound-mission" },
    )).rejects.toThrow(/projectId.*required/i);
  });

  it("losslessly preserves historical agentLogEntries rows", async () => {
    const sqlitePath = join(ctx!.fusionDir, "legacy-agent-log.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`CREATE TABLE agentLogEntries (id INTEGER, taskId TEXT, text TEXT, detail BLOB, agent TEXT)`);
      legacy.prepare(`INSERT INTO agentLogEntries VALUES (?, ?, ?, ?, ?)`)
        .run(7, "FN-7", "worked", Buffer.from([4, 5, 6]), "agent-7");
    } finally {
      legacy.close();
    }

    const first = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { projectId: "project-agent-log" },
    );
    const retry = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { projectId: "project-agent-log" },
    );

    expect(first.tables).toContainEqual(expect.objectContaining({
      table: "agent_log_entries_legacy",
      sourceRows: 1,
      targetRows: 1,
      verified: true,
    }));
    expect(retry.tables.find((table) => table.table === "agent_log_entries_legacy")?.insertedRows).toBe(0);
    const rows = await ctx!.db.execute(sql`
      SELECT project_id, legacy_row FROM project.agent_log_entries_legacy
    `) as unknown as Array<{ project_id: string; legacy_row: Record<string, unknown> }>;
    expect(rows).toEqual([{
      project_id: "project-agent-log",
      legacy_row: {
        agent: { type: "text", value: "agent-7" },
        detail: { type: "blob", value: "BAUG" },
        id: { type: "number", value: "7" },
        taskId: { type: "text", value: "FN-7" },
        text: { type: "text", value: "worked" },
      },
    }]);
  });

  /*
  FNXC:PostgresMigrationColumnCoverage 2026-07-14-12:10:
  A normally mapped table is verified only when every source column has an explicit PostgreSQL destination. Silently dropping a newly discovered legacy column would make matching row counts conceal data loss.
  */
  it("fails verification when a mapped table has an unhandled SQLite column", async () => {
    const sqlitePath = join(ctx!.fusionDir, "fusion.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`ALTER TABLE tasks ADD COLUMN operatorOnlyPayload BLOB`);
      legacy.prepare(`UPDATE tasks SET operatorOnlyPayload = ? WHERE id = ?`)
        .run(Buffer.from([9, 9, 9]), "FN-100");
    } finally {
      legacy.close();
    }

    const report = await migrateTest(ctx!.db, [
      { sqlitePath, pgSchema: "project" as const },
    ]);

    expect(report.tables).toContainEqual(expect.objectContaining({
      table: "tasks",
      sourceRows: 2,
      insertedRows: 0,
      verified: false,
      skipped: false,
      skipReason: expect.stringContaining("operatorOnlyPayload"),
    }));
  });

  /*
  FNXC:PostgresMigrationColumnCoverage 2026-07-14-13:17:
  The PostgreSQL cutover schema must retain every column in the current SQLite task, workflow, and mission assertion surfaces. These late SQLite migrations previously post-dated the PostgreSQL baseline, so first boot correctly refused to discard their values but could never initialize the task store.
  */
  it("migrates every late-added task, workflow, and mission assertion column", async () => {
    const sqlitePath = join(ctx!.fusionDir, "late-schema-columns.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, description TEXT NOT NULL, "column" TEXT NOT NULL,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
          boardId TEXT, taskQuestionInterrupt TEXT, columnDwellMs TEXT,
          workflowTransitionNotification TEXT, plannerOversightLevel TEXT,
          awaitingApprovalReason TEXT, approvedPlanFingerprint TEXT
        );
        CREATE TABLE workflows (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          ir TEXT NOT NULL, layout TEXT NOT NULL DEFAULT '{}', kind TEXT NOT NULL DEFAULT 'workflow',
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, icon TEXT
        );
        CREATE TABLE mission_contract_assertions (
          id TEXT PRIMARY KEY, milestoneId TEXT NOT NULL, title TEXT NOT NULL,
          assertion TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          type TEXT NOT NULL DEFAULT 'static', orderIndex INTEGER NOT NULL DEFAULT 0,
          sourceFeatureId TEXT, scope TEXT NOT NULL DEFAULT 'feature',
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
        );
      `);
      legacy.prepare(`INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "FN-LATE", "preserve late columns", "todo", "2026-07-14", "2026-07-14",
          "board-a", JSON.stringify({ question: "Proceed?" }), JSON.stringify({ todo: 42 }),
          JSON.stringify({ transitionId: "move-a" }), "observe", "plan-review-replan-cap", "sha256:a",
        );
      legacy.prepare(`INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("workflow-a", "Workflow A", "", "{}", "{}", "workflow", "2026-07-14", "2026-07-14", "gear");
      legacy.prepare(`INSERT INTO mission_contract_assertions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("assertion-a", "milestone-a", "Assertion A", "It holds", "pending", "static", 0, null, "feature", "2026-07-14", "2026-07-14");
    } finally {
      legacy.close();
    }

    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { projectId: "project-schema-parity" },
    );

    expect(report.tables.filter((table) => !table.skipped && !table.verified)).toEqual([]);
    const tasks = await ctx!.db.execute(sql`
      SELECT board_id, task_question_interrupt, column_dwell_ms,
        workflow_transition_notification, planner_oversight_level,
        awaiting_approval_reason, approved_plan_fingerprint
      FROM project.tasks
      WHERE project_id = 'project-schema-parity' AND id = 'FN-LATE'
    `) as unknown as Array<Record<string, unknown>>;
    expect(tasks).toEqual([{
      board_id: "board-a",
      task_question_interrupt: JSON.stringify({ question: "Proceed?" }),
      column_dwell_ms: { todo: 42 },
      workflow_transition_notification: { transitionId: "move-a" },
      planner_oversight_level: "observe",
      awaiting_approval_reason: "plan-review-replan-cap",
      approved_plan_fingerprint: "sha256:a",
    }]);
    const workflows = await ctx!.db.execute(sql`
      SELECT icon FROM project.workflows
      WHERE project_id = 'project-schema-parity' AND id = 'workflow-a'
    `) as unknown as Array<{ icon: string }>;
    expect(workflows).toEqual([{ icon: "gear" }]);
    const assertions = await ctx!.db.execute(sql`
      SELECT scope FROM project.mission_contract_assertions
      WHERE project_id = 'project-schema-parity' AND id = 'assertion-a'
    `) as unknown as Array<{ scope: string }>;
    expect(assertions).toEqual([{ scope: "feature" }]);
  });

  /*
  FNXC:PostgresMigration 2026-07-13-23:08:
  FTS5 shadow tables are disposable implementation details, but the virtual table is the user-visible search dataset. Verification must distinguish the two so an unmapped search surface fails cutover while its internal indexes remain intentional skips.
  */
  it("fails an unmapped FTS5 virtual table while allowing only its shadow tables to skip", async () => {
    const sqlitePath = join(ctx!.fusionDir, "fusion.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`CREATE VIRTUAL TABLE operator_notes_fts USING fts5(body)`);
      legacy.prepare(`INSERT INTO operator_notes_fts (body) VALUES (?)`).run("retain searchable content");
    } finally {
      legacy.close();
    }

    const report = await migrateTest(ctx!.db, [
      { sqlitePath, pgSchema: "project" as const },
    ]);

    expect(report.tables).toContainEqual(expect.objectContaining({
      table: "operator_notes_fts",
      sourceRows: 1,
      verified: false,
      skipped: false,
    }));
    expect(report.tables).toContainEqual(expect.objectContaining({
      table: "operator_notes_fts_data",
      verified: true,
      skipped: true,
    }));
  });

  /*
  FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
  The built-in task and archive FTS5 tables are derived indexes whose searchable content is regenerated from the migrated task rows by PostgreSQL generated tsvectors. Only these two named virtual tables may be skipped; arbitrary extension-owned FTS data must continue to fail closed.
  */
  it("treats the two replaced built-in FTS indexes as verified derived data", async () => {
    const projectPath = join(ctx!.fusionDir, "fusion.db");
    const archivePath = join(ctx!.fusionDir, "archive.db");
    const project = new DatabaseSync(projectPath);
    const archive = new DatabaseSync(archivePath);
    try {
      project.exec(`CREATE VIRTUAL TABLE tasks_fts USING fts5(title, description)`);
      project.prepare(`INSERT INTO tasks_fts (title, description) VALUES (?, ?)`).run("First task", "desc");
      archive.exec(`CREATE VIRTUAL TABLE archived_tasks_fts USING fts5(title, description)`);
      archive.prepare(`INSERT INTO archived_tasks_fts (title, description) VALUES (?, ?)`).run("Archived task", "desc");
    } finally {
      project.close();
      archive.close();
    }

    const report = await migrateTest(ctx!.db, [
      { sqlitePath: projectPath, pgSchema: "project" as const },
      { sqlitePath: archivePath, pgSchema: "archive" as const },
    ]);

    for (const table of ["tasks_fts", "archived_tasks_fts"]) {
      expect(report.tables).toContainEqual(expect.objectContaining({
        table,
        verified: true,
        skipped: true,
      }));
    }
  });

  /*
  FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
  SQLite cutover must preserve retired company-board, project-auth, and task-reviewer datasets even though current runtime code no longer reads them. These tables remain project-partitioned in shared PostgreSQL so later projects cannot collide with legacy IDs.
  */
  it("preserves every retired project table under the resolved project partition", async () => {
    const sqlitePath = join(ctx!.fusionDir, "retired-project-data.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`
        CREATE TABLE boards (id TEXT PRIMARY KEY, projectId TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', workflowId TEXT NOT NULL, ordering INTEGER NOT NULL DEFAULT 0, requirePlanApproval INTEGER NOT NULL DEFAULT 0, lfgMode INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE project_auth_users (id TEXT PRIMARY KEY, email TEXT NOT NULL, displayName TEXT, active INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE project_auth_memberships (id TEXT PRIMARY KEY, userId TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE project_auth_providers (id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL, providerUserId TEXT NOT NULL, metadata TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE project_auth_sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, membershipId TEXT NOT NULL, sessionToken TEXT NOT NULL, expiresAt TEXT NOT NULL, revokedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE task_reviewer_runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, boardId TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', summary TEXT, failureReasons TEXT, reviewerAgentId TEXT, reworkRound INTEGER NOT NULL DEFAULT 0, startedAt TEXT NOT NULL, completedAt TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, invalidatedAt TEXT);
      `);
      legacy.prepare(`INSERT INTO boards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("board-1", "stale", "Legacy board", "desc", "builtin:coding", 0, 0, 0, "2026-06-01", "2026-06-01");
      legacy.prepare(`INSERT INTO project_auth_users VALUES (?, ?, ?, ?, ?, ?)`).run("user-1", "operator@example.com", "Operator", 1, "2026-06-01", "2026-06-01");
      legacy.prepare(`INSERT INTO project_auth_memberships VALUES (?, ?, ?, ?, ?, ?)`).run("member-1", "user-1", "owner", 1, "2026-06-01", "2026-06-01");
      legacy.prepare(`INSERT INTO project_auth_providers VALUES (?, ?, ?, ?, ?, ?, ?)`).run("provider-1", "user-1", "local", "operator", "{}", "2026-06-01", "2026-06-01");
      legacy.prepare(`INSERT INTO project_auth_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("session-1", "user-1", "member-1", "token", "2026-07-01", null, "2026-06-01", "2026-06-01");
      legacy.prepare(`INSERT INTO task_reviewer_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("review-1", "FN-1", "board-1", "passed", "ok", "[]", "agent-1", 0, "2026-06-01", "2026-06-01", "2026-06-01", "2026-06-01", null);
    } finally {
      legacy.close();
    }

    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { projectId: "project-retired" },
    );
    const retiredTables = [
      "boards",
      "project_auth_users",
      "project_auth_memberships",
      "project_auth_providers",
      "project_auth_sessions",
      "task_reviewer_runs",
    ];
    for (const table of retiredTables) {
      expect(report.tables).toContainEqual(expect.objectContaining({
        table,
        sourceRows: 1,
        targetRows: 1,
        verified: true,
      }));
    }
    const partitions = await ctx!.db.execute(sql`
      SELECT project_id FROM project.boards
      UNION ALL SELECT project_id FROM project.project_auth_users
      UNION ALL SELECT project_id FROM project.project_auth_memberships
      UNION ALL SELECT project_id FROM project.project_auth_providers
      UNION ALL SELECT project_id FROM project.project_auth_sessions
      UNION ALL SELECT project_id FROM project.task_reviewer_runs
    `) as unknown as Array<{ project_id: string }>;
    expect(partitions).toHaveLength(6);
    expect(partitions.every(({ project_id }) => project_id === "project-retired")).toBe(true);
  });

  /*
  FNXC:PostgresMigrationCompleteness 2026-07-14-09:27:
  Central singleton values from SQLite must replace baseline seed defaults during first-boot cutover, and content verification must be independent of SQLite versus PostgreSQL text collation so mixed-case filesystem paths verify consistently.
  */
  it("migrates seeded central singletons and verifies rows across database collations", async () => {
    const sqlitePath = join(ctx!.fusionDir, "fusion-central.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`
        CREATE TABLE centralSettings (id INTEGER PRIMARY KEY, defaultProjectId TEXT, updatedAt TEXT NOT NULL);
        CREATE TABLE globalConcurrency (id INTEGER PRIMARY KEY, globalMaxConcurrent INTEGER, currentlyActive INTEGER, queuedCount INTEGER, updatedAt TEXT);
        CREATE TABLE plugin_installs (id TEXT PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL, path TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE project_plugin_states (projectPath TEXT NOT NULL, pluginId TEXT NOT NULL, enabled INTEGER NOT NULL, state TEXT NOT NULL, error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (projectPath, pluginId));
      `);
      legacy.prepare(`INSERT INTO centralSettings VALUES (?, ?, ?)`).run(1, "project-default", "2026-06-01");
      legacy.prepare(`INSERT INTO globalConcurrency VALUES (?, ?, ?, ?, ?)`).run(1, 10, 0, 0, "2026-06-02");
      legacy.prepare(`INSERT INTO plugin_installs VALUES (?, ?, ?, ?, ?, ?)`).run("plugin-a", "A", "1.0.0", "/a", "2026-06-01", "2026-06-01");
      legacy.prepare(`INSERT INTO plugin_installs VALUES (?, ?, ?, ?, ?, ?)`).run("plugin-b", "B", "1.0.0", "/b", "2026-06-01", "2026-06-01");
      const insertState = legacy.prepare(`INSERT INTO project_plugin_states VALUES (?, ?, ?, ?, ?, ?, ?)`);
      insertState.run("/Users/operator/project", "plugin-a", 1, "started", null, "2026-06-01", "2026-06-01");
      insertState.run("/private/tmp/project", "plugin-b", 1, "stopped", null, "2026-06-01", "2026-06-01");
    } finally {
      legacy.close();
    }

    const report = await migrateTest(ctx!.db, [
      { sqlitePath, pgSchema: "central" as const },
    ]);
    for (const table of ["central_settings", "global_concurrency", "project_plugin_states"]) {
      expect(report.tables).toContainEqual(expect.objectContaining({ table, verified: true }));
    }
    const settings = await ctx!.db.execute(sql`
      SELECT default_project_id, updated_at FROM central.central_settings WHERE id = 1
    `) as unknown as Array<{ default_project_id: string; updated_at: string }>;
    expect(settings).toEqual([{ default_project_id: "project-default", updated_at: "2026-06-01" }]);
    const concurrency = await ctx!.db.execute(sql`
      SELECT global_max_concurrent, updated_at FROM central.global_concurrency WHERE id = 1
    `) as unknown as Array<{ global_max_concurrent: number; updated_at: string }>;
    expect(concurrency).toEqual([{ global_max_concurrent: 10, updated_at: "2026-06-02" }]);
  });

  /*
  FNXC:PluginLegacyMigration 2026-07-14-22:50:
  PostgreSQL cutover must split each retained project plugin row into one newer-wins global installation and an independent project-path state. The same plugin ID may be enabled in one project and disabled in another; repeated migration and older SQLite backups must never overwrite newer central operator changes.
  */
  it("redirects legacy plugins into idempotent global installs and per-project states", async () => {
    const projectA = resolve(join(ctx!.fusionDir, "project-a"));
    const projectB = resolve(join(ctx!.fusionDir, "project-b"));
    const sqliteA = join(ctx!.fusionDir, "plugins-a.db");
    const sqliteB = join(ctx!.fusionDir, "plugins-b.db");
    for (const sqlitePath of [sqliteA, sqliteB]) {
      const legacy = new DatabaseSync(sqlitePath);
      legacy.exec(LEGACY_PLUGINS_SQLITE_DDL);
      if (sqlitePath === sqliteA) {
        insertLegacyPlugin(legacy, {
          id: "shared-plugin",
          name: "Shared from A",
          version: "1.0.0",
          enabled: 1,
          state: "started",
          updatedAt: "2026-02-01T00:00:00.000Z",
        });
        insertLegacyPlugin(legacy, {
          id: "central-wins",
          name: "Old local metadata",
          version: "1.0.0",
          enabled: 0,
          state: "stopped",
          error: "old local error",
          updatedAt: "2026-02-01T00:00:00.000Z",
        });
      } else {
        insertLegacyPlugin(legacy, {
          id: "shared-plugin",
          name: "Shared from B",
          version: "2.0.0",
          enabled: 0,
          state: "stopped",
          error: "disabled in B",
          updatedAt: "2026-03-01T00:00:00.000Z",
        });
      }
      legacy.close();
    }

    await applySchemaBaseline(ctx!.db);
    await ctx!.db.execute(sql`
      INSERT INTO central.plugin_installs
        (id, name, version, path, settings, dependencies, ai_scan_on_load, created_at, updated_at)
      VALUES
        ('central-wins', 'New central metadata', '9.0.0', '/central/plugin', '{}'::jsonb, '[]'::jsonb, 0,
         '2026-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `);
    await ctx!.db.execute(sql`
      INSERT INTO central.project_plugin_states
        (project_path, plugin_id, enabled, state, error, created_at, updated_at)
      VALUES
        (${projectA}, 'central-wins', 1, 'started', NULL,
         '2026-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    `);

    const reportA = await migrateTest(
      ctx!.db,
      [{ sqlitePath: sqliteA, pgSchema: "project", projectPath: projectA }],
      { projectId: "plugin-project-a", migrationKey: "plugin-project-a", projectPath: projectA },
    );
    const reportB = await migrateTest(
      ctx!.db,
      [{ sqlitePath: sqliteB, pgSchema: "project", projectPath: projectB }],
      { projectId: "plugin-project-b", migrationKey: "plugin-project-b", projectPath: projectB },
    );
    await migrateTest(
      ctx!.db,
      [{ sqlitePath: sqliteA, pgSchema: "project", projectPath: projectA }],
      { projectId: "plugin-project-a", migrationKey: "plugin-project-a", projectPath: projectA },
    );

    for (const report of [reportA, reportB]) {
      expect(report.tables).toContainEqual(expect.objectContaining({
        table: "plugins",
        verified: true,
        skipped: true,
        skipReason: "redirected to central plugin registry and project state",
      }));
    }
    const compatibilityRows = await ctx!.db.execute(sql`SELECT id FROM project.plugins`);
    expect(compatibilityRows).toHaveLength(0);

    const installs = await ctx!.db.execute(sql`
      SELECT id, name, version, updated_at FROM central.plugin_installs ORDER BY id
    `) as unknown as Array<{ id: string; name: string; version: string; updated_at: string }>;
    expect(installs).toEqual([
      { id: "central-wins", name: "New central metadata", version: "9.0.0", updated_at: "2026-09-01T00:00:00.000Z" },
      { id: "shared-plugin", name: "Shared from B", version: "2.0.0", updated_at: "2026-03-01T00:00:00.000Z" },
    ]);

    const states = await ctx!.db.execute(sql`
      SELECT project_path, plugin_id, enabled, state, error, updated_at
      FROM central.project_plugin_states
      ORDER BY project_path, plugin_id
    `) as unknown as Array<{
      project_path: string;
      plugin_id: string;
      enabled: number;
      state: string;
      error: string | null;
      updated_at: string;
    }>;
    expect(states).toEqual([
      { project_path: projectA, plugin_id: "central-wins", enabled: 1, state: "started", error: null, updated_at: "2026-09-01T00:00:00.000Z" },
      { project_path: projectA, plugin_id: "shared-plugin", enabled: 1, state: "started", error: null, updated_at: "2026-02-01T00:00:00.000Z" },
      { project_path: projectB, plugin_id: "shared-plugin", enabled: 0, state: "stopped", error: "disabled in B", updated_at: "2026-03-01T00:00:00.000Z" },
    ]);

    /*
    FNXC:PluginLegacyMigration 2026-07-14-23:51:
    After the first successful bridge, retained SQLite cannot regain authority even if its timestamps are edited to look newer. Backend restarts consult the durable project marker and preserve PostgreSQL operator state.
    */
    const retained = new DatabaseSync(sqliteA);
    retained.prepare(`UPDATE plugins SET name = ?, enabled = ?, updatedAt = ? WHERE id = ?`).run(
      "Retained SQLite must not win",
      0,
      "2027-01-01T00:00:00.000Z",
      "shared-plugin",
    );
    retained.close();
    await migrateLegacyProjectPluginRows(ctx!.db, sqliteA, projectA);
    const preserved = (await ctx!.db.execute(sql`
      SELECT install.name, state.enabled
      FROM central.plugin_installs install
      JOIN central.project_plugin_states state ON state.plugin_id = install.id
      WHERE install.id = 'shared-plugin' AND state.project_path = ${projectA}
    `)) as unknown as Array<{ name: string; enabled: number }>;
    expect(preserved).toEqual([{ name: "Shared from B", enabled: 1 }]);
  });

  it("treats missing SQLite files and databases without plugins as a no-op", async () => {
    await applySchemaBaseline(ctx!.db);
    await expect(migrateLegacyProjectPluginRows(
      ctx!.db,
      join(ctx!.fusionDir, "missing.db"),
      join(ctx!.fusionDir, "project-missing"),
    )).resolves.toBeUndefined();

    const sqlitePath = join(ctx!.fusionDir, "without-plugins.db");
    const legacy = new DatabaseSync(sqlitePath);
    legacy.exec(`CREATE TABLE config (id INTEGER PRIMARY KEY, settings TEXT)`);
    legacy.close();
    await expect(migrateLegacyProjectPluginRows(
      ctx!.db,
      sqlitePath,
      join(ctx!.fusionDir, "project-empty"),
    )).resolves.toBeUndefined();

    const installs = await ctx!.db.execute(sql`SELECT id FROM central.plugin_installs`);
    const states = await ctx!.db.execute(sql`SELECT plugin_id FROM central.project_plugin_states`);
    expect(installs).toHaveLength(0);
    expect(states).toHaveLength(0);
  });

  /*
  FNXC:AutomationIsolation 2026-07-13-22:37:
  Legacy project databases do not carry project_id on automation rows. Migration must inject the resolved registry identity before verification so bound automation stores and cron runners see only their project's schedules, including when legacy automation IDs overlap.

  FNXC:AutomationIsolation 2026-07-14-08:52:
  Real upgraded SQLite databases already have a nullable projectId column whose legacy rows can still be NULL. The resolved registry identity remains authoritative during the one-project-file cutover; migration must override that nullable source column instead of copying NULL into PostgreSQL's required project_id partition.
  */
  it("injects and verifies the project partition for migrated automations", async () => {
    const sqlitePath = join(ctx!.fusionDir, "fusion.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`CREATE TABLE automations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, scheduleType TEXT NOT NULL,
        cronExpression TEXT NOT NULL, command TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        projectId TEXT
      )`);
      legacy.prepare(`INSERT INTO automations VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "auto-shared", "Nightly", "cron", "0 0 * * *", "pnpm check", "2026-06-01", "2026-06-01", null,
      );
      legacy.prepare(`INSERT INTO automations VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "auto-stale", "Weekly", "cron", "0 0 * * 0", "pnpm audit", "2026-06-01", "2026-06-01", "stale-project",
      );
    } finally {
      legacy.close();
    }

    await applySchemaBaseline(ctx!.db);
    await ctx!.db.execute(sql`
      INSERT INTO project.automations
        (project_id, id, name, schedule_type, cron_expression, command, created_at, updated_at)
      VALUES
        ('stale-project', 'auto-stale', 'Weekly', 'cron', '0 0 * * 0', 'pnpm audit', '2026-06-01', '2026-06-01'),
        ('project-a', 'auto-stale', 'Weekly', 'cron', '0 0 * * 0', 'pnpm audit', '2026-06-01', '2026-06-01')
    `);

    for (const projectId of ["project-a", "project-b"]) {
      const report = await migrateTest(
        ctx!.db,
        [{ sqlitePath, pgSchema: "project" as const }],
        { projectId },
      );
      expect(report.tables.find((table) => table.table === "automations")).toEqual(
        expect.objectContaining({ sourceRows: 2, targetRows: 2, verified: true }),
      );
    }

    const rows = (await ctx!.db.execute(sql`
      SELECT project_id, id FROM project.automations
      WHERE id IN ('auto-shared', 'auto-stale')
      ORDER BY project_id, id
    `)) as unknown as Array<{ project_id: string; id: string }>;
    expect(rows).toEqual([
      { project_id: "project-a", id: "auto-shared" },
      { project_id: "project-a", id: "auto-stale" },
      { project_id: "project-b", id: "auto-shared" },
      { project_id: "project-b", id: "auto-stale" },
    ]);
  });

  /*
  FNXC:PostgresMultiProjectCutover 2026-07-14-11:18:
  Sequential project cutovers share one PostgreSQL schema. Verification must count project-owned rows only, keep agents and __meta isolated by project, and generate a new task-revision identity when both SQLite files start their local sequence at 1.
  */
  it("converges sequential project migrations in one shared PostgreSQL database", async () => {
    const makeProjectDb = (name: string, projectId: string, taskId: string): string => {
      const sqlitePath = join(ctx!.fusionDir, name);
      const legacy = new DatabaseSync(sqlitePath);
      try {
        legacy.exec(`
          CREATE TABLE agents (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL,
            state TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
          );
          CREATE TABLE task_document_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, key TEXT NOT NULL,
            content TEXT NOT NULL, revision INTEGER NOT NULL, author TEXT NOT NULL,
            metadata TEXT, createdAt TEXT NOT NULL
          );
          CREATE TABLE __meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);
        legacy.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?)").run(
          "shared-agent", `Agent ${projectId}`, "worker", "idle", "2026-07-14", "2026-07-14",
        );
        legacy.prepare("INSERT INTO task_document_revisions VALUES (1, ?, 'docs', ?, 1, 'agent', '{}', '2026-07-14')").run(
          taskId, `content-${projectId}`,
        );
        legacy.prepare("INSERT INTO __meta VALUES ('projectId', ?)").run(projectId);
      } finally {
        legacy.close();
      }
      return sqlitePath;
    };

    const firstPath = makeProjectDb("project-a.db", "project-a", "FN-1");
    const secondPath = makeProjectDb("project-b.db", "project-b", "FN-1");
    const first = await migrateTest(
      ctx!.db, [{ sqlitePath: firstPath, pgSchema: "project" as const }], { projectId: "project-a" },
    );
    const second = await migrateTest(
      ctx!.db, [{ sqlitePath: secondPath, pgSchema: "project" as const }], { projectId: "project-b" },
    );

    expect(first.tables.every((table) => table.verified)).toBe(true);
    expect(second.tables.every((table) => table.verified)).toBe(true);
    expect(second.tables.find((table) => table.table === "agents")).toEqual(
      expect.objectContaining({ sourceRows: 1, targetRows: 1, verified: true }),
    );
    const agents = await ctx!.db.execute(sql`
      SELECT project_id, id FROM project.agents ORDER BY project_id
    `) as unknown as Array<{ project_id: string; id: string }>;
    expect(agents).toEqual([
      { project_id: "project-a", id: "shared-agent" },
      { project_id: "project-b", id: "shared-agent" },
    ]);
    const revisions = await ctx!.db.execute(sql`
      SELECT id, legacy_sqlite_id, task_id FROM project.task_document_revisions ORDER BY project_id
    `) as unknown as Array<{ id: number; legacy_sqlite_id: number; task_id: string }>;
    expect(revisions.map(({ task_id }) => task_id)).toEqual(["FN-1", "FN-1"]);
    expect(revisions.map(({ legacy_sqlite_id }) => legacy_sqlite_id)).toEqual([1, 1]);
    const metadata = await ctx!.db.execute(sql`
      SELECT project_id, key, value FROM project.__meta ORDER BY project_id
    `) as unknown as Array<{ project_id: string; key: string; value: string }>;
    expect(metadata).toEqual([
      { project_id: "project-a", key: "projectId", value: "project-a" },
      { project_id: "project-b", key: "projectId", value: "project-b" },
    ]);
  });

  /*
  FNXC:PostgresMigrationRetry 2026-07-14-09:06:
  Retrying after the former non-transactional migrator must repair a row copied under a stale project partition. Current ownership constraints reject NULL, so reconciliation proves the exact stale non-NULL owner is replaced without touching unrelated project state.
  */
  it("re-keys an exact row left under a stale project partition", async () => {
    const sqlitePath = join(ctx!.fusionDir, "fusion.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.prepare(`UPDATE tasks SET projectId = ? WHERE id = ?`).run("stale-project", "FN-100");
    } finally {
      legacy.close();
    }
    await applySchemaBaseline(ctx!.db);
    await ctx!.db.execute(sql`
      INSERT INTO project.tasks
        (id, project_id, title, description, "column", dependencies, steps, comments,
         custom_fields, deleted_at, created_at, updated_at)
      VALUES
        ('FN-100', 'stale-project', 'First task', 'desc', 'todo',
         '[{"taskId":"FN-99","type":"blocks"}]'::jsonb,
         '[{"id":"s1","name":"step one"}]'::jsonb,
         '[{"author":"agent","body":"hello"}]'::jsonb,
         '{"priority":"high","labels":["a","b"]}'::jsonb,
         NULL, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')
    `);

    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { projectId: "project-retry" },
    );

    expect(report.tables.find((table) => table.table === "tasks")).toEqual(
      expect.objectContaining({ sourceRows: 2, targetRows: 2, verified: true }),
    );
    const rows = await ctx!.db.execute(sql`
      SELECT id, project_id FROM project.tasks ORDER BY id
    `) as unknown as Array<{ id: string; project_id: string }>;
    expect(rows).toEqual([
      { id: "FN-100", project_id: "project-retry" },
      { id: "FN-101", project_id: "project-retry" },
    ]);
  });

  it("re-keys quarantined retry rows when project_id was injected", async () => {
    const sqlitePath = join(ctx!.fusionDir, "retry-injected.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`CREATE TABLE agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      )`);
      legacy.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?)").run(
        "retry-agent", "Retry Agent", "worker", "idle", "2026-07-14", "2026-07-14",
      );
    } finally {
      legacy.close();
    }
    await applySchemaBaseline(ctx!.db);
    await ctx!.db.execute(sql`
      INSERT INTO project.agents(project_id, id, name, role, state, created_at, updated_at)
      VALUES ('__legacy_unscoped__', 'retry-agent', 'Retry Agent', 'worker', 'idle', '2026-07-14', '2026-07-14')
    `);

    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { projectId: "project-retry-injected" },
    );

    expect(report.tables.find((table) => table.table === "agents")).toEqual(
      expect.objectContaining({ sourceRows: 1, targetRows: 1, verified: true }),
    );
    await expect(ctx!.db.execute(sql`
      SELECT project_id FROM project.agents WHERE id = 'retry-agent'
    `)).resolves.toEqual([{ project_id: "project-retry-injected" }]);
  });

  /*
  FNXC:WhatsAppPostgres 2026-07-13-23:29:
  Existing WhatsApp history, dedupe markers, credentials, and Signal keys must survive cutover. The generic camelCase mapper must target all four plugin hook tables and inject the registered project partition before verification.
  */
  it("migrates every legacy WhatsApp persistence table into the bound project", async () => {
    const sqlitePath = join(ctx!.fusionDir, "fusion.db");
    const legacy = new DatabaseSync(sqlitePath);
    try {
      legacy.exec(`
        CREATE TABLE whatsapp_chat_sessions (sender TEXT PRIMARY KEY, history TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE whatsapp_chat_dedupe (messageId TEXT PRIMARY KEY, sender TEXT NOT NULL, receivedAt TEXT NOT NULL);
        CREATE TABLE whatsapp_auth_creds (id TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt TEXT NOT NULL);
        CREATE TABLE whatsapp_auth_keys (category TEXT NOT NULL, keyId TEXT NOT NULL, value TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (category, keyId));
      `);
      legacy.prepare(`INSERT INTO whatsapp_chat_sessions VALUES (?, ?, ?)`).run("+1555", "[]", "2026-07-01");
      legacy.prepare(`INSERT INTO whatsapp_chat_dedupe VALUES (?, ?, ?)`).run("msg-1", "+1555", "2026-07-01");
      legacy.prepare(`INSERT INTO whatsapp_auth_creds VALUES (?, ?, ?)`).run("creds", "{}", "2026-07-01");
      legacy.prepare(`INSERT INTO whatsapp_auth_keys VALUES (?, ?, ?, ?)`).run("session", "key-1", "{}", "2026-07-01");
    } finally {
      legacy.close();
    }

    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath, pgSchema: "project" as const }],
      { projectId: "project-whatsapp" },
    );

    for (const table of ["whatsapp_chat_sessions", "whatsapp_chat_dedupe", "whatsapp_auth_creds", "whatsapp_auth_keys"]) {
      expect(report.tables).toContainEqual(expect.objectContaining({ table, sourceRows: 1, targetRows: 1, verified: true }));
    }
    const partitions = await ctx!.db.execute(sql`
      SELECT project_id FROM project.whatsapp_chat_sessions
      UNION ALL SELECT project_id FROM project.whatsapp_chat_dedupe
      UNION ALL SELECT project_id FROM project.whatsapp_auth_creds
      UNION ALL SELECT project_id FROM project.whatsapp_auth_keys
    `) as unknown as Array<{ project_id: string }>;
    expect(partitions).toHaveLength(4);
    expect(partitions.every(({ project_id }) => project_id === "project-whatsapp")).toBe(true);
  });

  // FNXC:PostgresMigration 2026-07-13-20:30:
  // Legacy camelCase TABLE names (activityLog, runAuditEvents, mergeQueue,
  // projectNodePathMappings, …) must be snake_cased when matched against
  // PostgreSQL, exactly like column names. A bug that matched table names
  // verbatim silently skipped all 22 legacy camelCase tables ("no PostgreSQL
  // counterpart"), surfacing post-cutover as
  // `Project/node path mapping not found` on engine start.
  it("migrates legacy camelCase-named tables into their snake_case PostgreSQL counterparts", async () => {
    const report = await migrateTest(ctx!.db, [
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
    expect(rows[1].metadata).toBeNull();
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
    const report = await migrateTest(ctx!.db, [
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
    const first = await migrateTest(ctx!.db, sources);
    const tasksFirst = first.tables.find((t) => t.table === "tasks")!;
    expect(tasksFirst.verified).toBe(true);

    // Corrupt a target row's title (content divergence the row-count check
    // would miss — same number of rows).
    await ctx!.db.execute(sql`UPDATE project.tasks SET title = 'CORRUPTED' WHERE id = 'FN-100'`);

    // Re-run: ON CONFLICT DO NOTHING means the corrupt row is NOT overwritten
    // (same PK), so the content checksum MUST now mismatch and report
    // verified: false for tasks. This proves the content check catches what
    // the row-count check could not.
    const second = await migrateTest(ctx!.db, sources);
    const tasksSecond = second.tables.find((t) => t.table === "tasks")!;
    expect(tasksSecond.verified).toBe(false);
    expect(tasksSecond.targetRows).toBe(tasksSecond.sourceRows); // counts still match
  });

  // VAL-MIGRATE-003 — JSON column fidelity
  it("round-trips JSON columns with identical shape (text-JSON → jsonb)", async () => {
    const legacy = new DatabaseSync(join(ctx!.fusionDir, "fusion.db"));
    try {
      legacy.prepare("UPDATE tasks SET proposalClaimId = ? WHERE id = ?").run("legacy-proposal-claim", "FN-100");
    } finally {
      legacy.close();
    }
    await migrateTest(ctx!.db, [
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
    const proposalClaim = (await ctx!.db.execute(sql`
      SELECT proposal_claim_id FROM project.tasks WHERE id = 'FN-100'
    `)) as unknown as Array<{ proposal_claim_id: string | null }>;
    expect(proposalClaim[0].proposal_claim_id).toBe("legacy-proposal-claim");

    // Verify the column type is actually jsonb.
    const colInfo = (await ctx!.db.execute(sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'project' AND table_name = 'tasks' AND column_name = 'dependencies'
    `)) as unknown as Array<{ data_type: string }>;
    expect(colInfo[0].data_type).toBe("jsonb");
  });

  it("materializes defaults for legacy NULL values targeting required jsonb columns", async () => {
    await migrateTest(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    const rows = (await ctx!.db.execute(sql`
      SELECT sources, events, tags
      FROM project.research_runs WHERE id = 'RR-legacy-null-json'
    `)) as unknown as Array<{ sources: unknown; events: unknown; tags: unknown }>;
    expect(rows[0]).toEqual({ sources: [], events: [], tags: [] });
  });

  it("preserves empty, whitespace, malformed, and scalar values in required jsonb without a default", async () => {
    const report = await migrateTest(ctx!.db, [
      { sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const },
    ]);

    expect(report.tables.find((table) => table.table === "workflows")?.verified).toBe(true);
    const rows = (await ctx!.db.execute(sql`
      SELECT id, ir FROM project.workflows WHERE id LIKE 'WF-legacy-%' ORDER BY id
    `)) as unknown as Array<{ id: string; ir: unknown }>;
    expect(Object.fromEntries(rows.map(({ id, ir }) => [id, ir]))).toEqual({
      "WF-legacy-empty-ir": "",
      "WF-legacy-malformed-ir": "not-json",
      "WF-legacy-scalar-ir": 42,
      "WF-legacy-whitespace-ir": " \t ",
    });
  });

  it("fails closed when a required jsonb default is declared but cannot be validated", async () => {
    /*
    FNXC:PostgresMigration 2026-07-14-10:43:
    Function-style jsonb defaults are valid PostgreSQL expressions but are intentionally outside the migrator's literal fallback parser. Empty legacy text must not be stored as data when such a default exists.
    */
    await applySchemaBaseline(ctx!.db);
    await ctx!.db.execute(sql`
      ALTER TABLE project.workflows
      ALTER COLUMN ir SET DEFAULT jsonb_build_object()
    `);

    await expect(migrateTest(
      ctx!.db,
      [{ sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const }],
      { skipBaseline: true },
    )).rejects.toThrow(/declared default could not be validated/);
  });

  // VAL-MIGRATE-003 — bytea fidelity
  it("round-trips bytea columns (BLOB → bytea) byte-identical", async () => {
    await migrateTest(ctx!.db, [
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
    await migrateTest(ctx!.db, [
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
    const report = await migrateTest(ctx!.db, [
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
      INSERT INTO project.agent_heartbeats (project_id, agent_id, timestamp, status, run_id)
      VALUES ('migration-test', 'agent-3', '2026-06-03', 'alive', 'run-3')
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

    const first = await migrateTest(ctx!.db, sources);
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
    const second = await migrateTest(ctx!.db, sources);
    for (const t of second.tables) {
      const key = `${t.schema}.${t.table}`;
      expect(t.targetRows, `${key} row count should be unchanged on re-run`).toBe(firstCounts.get(key));
      expect(t.verified, `${key} should still verify`).toBe(true);
      expect(t.insertedRows, `${key} re-run should insert nothing`).toBe(0);
    }
  });

  it("serializes concurrent cutovers on a multi-connection migration pool", async () => {
    /*
     * FNXC:PostgresMigration 2026-07-13-23:35:
     * Exercise session pinning independently of the bulk-copy matrix so the
     * concurrency invariant stays inside the merge-gate budget.
     */
    const sqlitePath = join(ctx!.fusionDir, "concurrent.db");
    const sqliteDb = new DatabaseSync(sqlitePath);
    sqliteDb.close();
    const sources = [
      { sqlitePath, pgSchema: "project" as const },
    ];
    const reports = await Promise.all([
      migrateTest(ctx!.db, sources, { migrationKey: "concurrent-project", skipBaseline: true }),
      migrateTest(ctx!.db, sources, { migrationKey: "concurrent-project", skipBaseline: true }),
    ]);

    for (const report of reports) {
      expect(report.tables).toEqual([]);
    }
    const rows = (await ctx!.db.execute(sql`
      SELECT status, project_id FROM public.fusion_sqlite_migrations
      WHERE migration_key = 'concurrent-project'
    `)) as unknown as Array<{ status: string; project_id: string }>;
    expect(rows).toEqual([{ status: "complete", project_id: "migration-test" }]);
  });

  // VAL-MIGRATE-005 — dry-run reports without writing
  it("dry-run reports the plan without modifying PostgreSQL", async () => {
    const report = await migrateTest(
      ctx!.db,
      [{ sqlitePath: join(ctx!.fusionDir, "fusion.db"), pgSchema: "project" as const }],
      { dryRun: true },
    );

    expect(report.dryRun).toBe(true);
    // The dry-run should report source rows.
    const tasks = report.tables.find((t) => t.table === "tasks")!;
    expect(tasks.sourceRows).toBe(2);
    expect(tasks.skipped).toBe(true);

    /*
    FNXC:PostgresMigration 2026-07-14-23:47:
    VAL-MIGRATE-005 applies to catalog state as well as copied rows. A preview against a pristine external target must leave no schemas, tables, or migration marker behind after it reports the plan.
    */
    const catalog = (await ctx!.db.execute(sql`
      SELECT
        to_regnamespace('project')::text AS project_schema,
        to_regclass('project.tasks')::text AS tasks_table,
        to_regclass('project.secrets')::text AS secrets_table,
        to_regclass('public.fusion_sqlite_migrations')::text AS migration_table
    `)) as unknown as Array<{
      project_schema: string | null;
      tasks_table: string | null;
      secrets_table: string | null;
      migration_table: string | null;
    }>;
    expect(catalog).toEqual([{
      project_schema: null,
      tasks_table: null,
      secrets_table: null,
      migration_table: null,
    }]);

    // No sequences should have been bumped in dry-run.
    expect(report.sequenceBumps).toHaveLength(0);
  });

  // VAL-SEARCH-002 (search_vector population) — generated column auto-populates
  it("populates the search_vector generated column after migration", async () => {
    await migrateTest(ctx!.db, [
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
    await migrateTest(ctx!.db, [
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

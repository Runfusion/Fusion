/**
 * Async data-layer foundation tests (U4 / VAL-DATA-001..004).
 *
 * FNXC:AsyncDataLayer 2026-06-24-10:00:
 * Integration tests against a real PostgreSQL instance for the async
 * data-layer foundation that replaces the synchronous DatabaseSync adapter.
 * Each test creates a uniquely-named fresh database, applies the baseline
 * migration, and exercises the transaction primitives that the migrating
 * stores (U12-U14) will depend on.
 *
 * Coverage targets:
 *   VAL-DATA-001 — async data layer has no synchronous bridge (verified by
 *     grep in a separate static check; these tests confirm the async path works)
 *   VAL-DATA-002 — transaction atomicity (commit): a multi-statement mutation
 *     commits all writes together
 *   VAL-DATA-003 — transaction atomicity (rollback): a failing mutation rolls
 *     back all writes including the audit row
 *   VAL-DATA-004 — concurrent transactions do not observe partial writes
 *
 * Also verifies:
 *   - transactionImmediate() preserves the SQLite BEGIN IMMEDIATE atomicity
 *     contract (multi-statement mutations commit/rollback together)
 *   - recordRunAuditEventWithinTransaction writes the audit row inside the
 *     shared transaction (run-audit-event-within-transaction behavior)
 *   - the AsyncDataLayer interface compiles against the stable contract
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { execSync } from "node:child_process";
import {
  createAsyncDataLayer,
  recordRunAuditEvent,
  recordRunAuditEventWithinTransaction,
  type AsyncDataLayer,
  type RunAuditEventInput,
} from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import * as schema from "../../postgres/schema/index.js";

const PG_ADMIN_URL =
  process.env.FUSION_PG_TEST_ADMIN_URL ?? "postgresql://localhost:5432/postgres";
const PG_TEST_URL_BASE =
  process.env.FUSION_PG_TEST_URL_BASE ?? "postgresql://localhost:5432";
const PG_AVAILABLE =
  process.env.FUSION_PG_TEST_SKIP !== "1" && Boolean(PG_TEST_URL_BASE);

const pgDescribe = PG_AVAILABLE ? describe : describe.skip;

/**
 * FNXC:AsyncDataLayer 2026-06-24-10:00:
 * Create a uniquely-named fresh database for each test so tests are hermetic
 * and never touch existing data. Mirrors the schema-applier test harness.
 */
function uniqueDbName(): string {
  return `fusion_data_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

/*
FNXC:PgTestAuthFix 2026-07-14-00:00:
The inline adminExec used process.env.USER for the psql -U flag, which is 'runner' on GitHub Actions (not 'postgres'). Use the PG_TEST_URL_BASE connection string instead so credentials are always correct.
*/
function adminExec(statement: string): void {
  // psql via execSync for DDL that the postgres.js connection pool can't run
  // (CREATE/DROP DATABASE cannot run inside a transaction). Short deterministic
  // DDL — the acceptable execSync use per AGENTS.md.
  execSync(
    `psql "${PG_TEST_URL_BASE}/postgres" -v ON_ERROR_STOP=1 -c "${statement.replace(/"/g, '\\"')}"`,
    { stdio: "pipe", env: process.env },
  );
}

interface TestLayer {
  dbName: string;
  testUrl: string;
  layer: AsyncDataLayer;
  adminSql: ReturnType<typeof postgres>;
  adminDb: ReturnType<typeof drizzle>;
}

async function setupFreshLayer(): Promise<TestLayer> {
  const dbName = uniqueDbName();
  try {
    adminExec(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch {
    // ignore — may not exist
  }
  adminExec(`CREATE DATABASE "${dbName}"`);
  const testUrl = `${PG_TEST_URL_BASE}/${dbName}`;

  // Apply the baseline schema so run_audit_events + tasks exist.
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

  // Now build the data layer against the migrated database.
  const dataBackend: ResolvedBackend = {
    mode: "external",
    runtimeUrl: testUrl,
    migrationUrl: testUrl,
    migrationUrlOverridden: false,
  };
  const connections = await createConnectionSetFromUrl(dataBackend, {
    poolMax: 5,
    connectTimeoutSeconds: 5,
  });
  const layer = createAsyncDataLayer(connections);

  // Admin connection for direct row inspection (outside the data layer).
  const adminSql = postgres(testUrl, { max: 2, prepare: false, onnotice: () => {} });
  const adminDb = drizzle(adminSql);

  return { dbName, testUrl, layer, adminSql, adminDb };
}

async function teardownLayer(ctx: TestLayer | null): Promise<void> {
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

/** Count rows in project.run_audit_events via the admin connection. */
async function countAuditRows(adminDb: TestLayer["adminDb"]): Promise<number> {
  const result = (await adminDb.execute(
    sql`SELECT count(*)::int AS n FROM project.run_audit_events`,
  )) as unknown as Array<{ n: number }>;
  return result[0]?.n ?? 0;
}

/** Read all audit rows for a runId via the admin connection. */
async function readAuditRows(
  adminDb: TestLayer["adminDb"],
  runId: string,
): Promise<unknown[]> {
  const result = (await adminDb.execute(
    sql`SELECT * FROM project.run_audit_events WHERE run_id = ${runId} ORDER BY timestamp`,
  )) as unknown as Array<Record<string, unknown>>;
  return result;
}

pgDescribe("AsyncDataLayer: VAL-DATA-002 — transaction atomicity (commit)", () => {
  let ctx: TestLayer | null = null;

  afterEach(async () => {
    await teardownLayer(ctx);
    ctx = null;
  });

  it("commits a multi-statement mutation with all writes visible after commit", async () => {
    ctx = await setupFreshLayer();
    const runId = "run-commit-multi";
    const auditA: RunAuditEventInput = {
      runId,
      agentId: "agent-commit",
      domain: "database",
      mutationType: "task:create",
      target: "FN-COMMIT-A",
    };
    const auditB: RunAuditEventInput = {
      runId,
      agentId: "agent-commit",
      domain: "database",
      mutationType: "task:update",
      target: "FN-COMMIT-B",
    };

    // Two audit inserts inside one transactionImmediate — both should commit.
    await ctx.layer.transactionImmediate(async (tx) => {
      await recordRunAuditEventWithinTransaction(tx, auditA);
      await recordRunAuditEventWithinTransaction(tx, auditB);
    });

    const rows = await readAuditRows(ctx.adminDb, runId);
    expect(rows).toHaveLength(2);
    const targets = rows.map((r) => (r as { target: string }).target);
    expect(targets).toContain("FN-COMMIT-A");
    expect(targets).toContain("FN-COMMIT-B");
  });

  it("transactionImmediate with a single write commits it", async () => {
    ctx = await setupFreshLayer();
    const runId = "run-commit-single";
    await ctx.layer.transactionImmediate(async (tx) => {
      await recordRunAuditEventWithinTransaction(tx, {
        runId,
        agentId: "agent-solo",
        domain: "database",
        mutationType: "task:log",
        target: "FN-SOLO",
      });
    });

    const count = await countAuditRows(ctx.adminDb);
    expect(count).toBe(1);
  });
});

pgDescribe("AsyncDataLayer: VAL-DATA-003 — transaction atomicity (rollback)", () => {
  let ctx: TestLayer | null = null;

  afterEach(async () => {
    await teardownLayer(ctx);
    ctx = null;
  });

  it("rolls back all writes when the callback throws, including the audit row", async () => {
    ctx = await setupFreshLayer();
    const runId = "run-rollback-throw";
    const before = await countAuditRows(ctx.adminDb);
    expect(before).toBe(0);

    await expect(
      ctx.layer.transactionImmediate(async (tx) => {
        // First write succeeds inside the transaction...
        await recordRunAuditEventWithinTransaction(tx, {
          runId,
          agentId: "agent-rollback",
          domain: "database",
          mutationType: "task:update",
          target: "FN-ROLLBACK",
        });
        // ...but then the callback throws, so everything rolls back.
        throw new Error("intentional mid-transaction failure");
      }),
    ).rejects.toThrow("intentional mid-transaction failure");

    // No partial writes — the audit row is absent.
    const after = await countAuditRows(ctx.adminDb);
    expect(after).toBe(0);
  });

  it("rolls back when a constraint is violated mid-transaction (primary-key collision)", async () => {
    ctx = await setupFreshLayer();
    const runId = "run-rollback-pk";
    const before = await countAuditRows(ctx.adminDb);
    expect(before).toBe(0);

    // Insert a valid row, then attempt a second insert with the SAME id (a
    // primary-key collision) — the whole transaction must roll back,
    // including the valid first row.
    const dupId = "11111111-1111-4111-8111-111111111111";
    await expect(
      ctx.layer.transactionImmediate(async (tx) => {
        // First insert: succeeds (generates a random id internally).
        await recordRunAuditEventWithinTransaction(tx, {
          runId,
          agentId: "agent-pk",
          domain: "database",
          mutationType: "task:create",
          target: "FN-VALID-FIRST",
        });
        // Second insert with an explicit duplicate id via raw insert to force
        // a primary-key collision. We bypass the helper and insert directly
        // so we control the id.
        await tx.insert(schema.project.runAuditEvents).values({
          id: dupId,
          timestamp: new Date().toISOString(),
          taskId: null,
          agentId: "agent-pk",
          runId,
          domain: "database",
          mutationType: "task:update",
          target: "FN-DUP",
          metadata: null,
        });
        // Now insert AGAIN with the same dupId → primary-key violation.
        await tx.insert(schema.project.runAuditEvents).values({
          id: dupId,
          timestamp: new Date().toISOString(),
          taskId: null,
          agentId: "agent-pk",
          runId,
          domain: "database",
          mutationType: "task:update",
          target: "FN-DUP-AGAIN",
          metadata: null,
        });
      }),
    ).rejects.toThrow();

    const after = await countAuditRows(ctx.adminDb);
    expect(after).toBe(0);
  });
});

pgDescribe("AsyncDataLayer: VAL-DATA-004 — concurrent transactions do not observe partial writes", () => {
  let ctx: TestLayer | null = null;

  afterEach(async () => {
    await teardownLayer(ctx);
    ctx = null;
  });

  it("a concurrent reader outside the writer's transaction does not see uncommitted writes", async () => {
    ctx = await setupFreshLayer();
    const runId = "run-concurrent-iso";

    // Hold a transaction open with an uncommitted write, then verify a
    // separate concurrent connection (the admin connection, which is outside
    // this transaction) does NOT see it.
    await ctx.layer.transactionImmediate(async (tx) => {
      await recordRunAuditEventWithinTransaction(tx, {
        runId,
        agentId: "agent-writer",
        domain: "database",
        mutationType: "task:create",
        target: "FN-UNCOMMITTED",
      });

      // While this transaction is open, read from a SEPARATE connection
      // (the admin connection, which is outside this transaction). The
      // uncommitted row must NOT be visible under READ COMMITTED isolation.
      const midCount = await countAuditRows(ctx!.adminDb);
      expect(midCount).toBe(0);
    });

    // After the writer commits, the row is visible to everyone.
    const afterCount = await countAuditRows(ctx.adminDb);
    expect(afterCount).toBe(1);
  });

  it("a concurrent read via a separate pool transaction does not see uncommitted writes", async () => {
    ctx = await setupFreshLayer();
    const runId = "run-concurrent-iso-2";

    // Use a barrier to coordinate: the writer holds its transaction open until
    // the reader has confirmed it cannot see the uncommitted row.
    let readerSawUncommitted = "not-run";
    const writerPromise = ctx.layer.transactionImmediate(async (tx) => {
      await recordRunAuditEventWithinTransaction(tx, {
        runId,
        agentId: "agent-writer-2",
        domain: "database",
        mutationType: "task:create",
        target: "FN-UNCOMMITTED-2",
      });
      // The reader runs on a separate pooled connection (the admin pool) so
      // it cannot see the writer's uncommitted row.
      readerSawUncommitted = String(await countAuditRows(ctx!.adminDb));
    });

    await writerPromise;

    // While the writer was mid-transaction, the reader saw zero rows.
    expect(readerSawUncommitted).toBe("0");
    // After commit, the row is visible.
    const afterCount = await countAuditRows(ctx.adminDb);
    expect(afterCount).toBe(1);
  });

  it("two concurrent writers both commit their own rows without cross-contamination", async () => {
    ctx = await setupFreshLayer();
    const runA = "run-concurrent-A";
    const runB = "run-concurrent-B";

    await Promise.all([
      ctx.layer.transactionImmediate(async (tx) => {
        await recordRunAuditEventWithinTransaction(tx, {
          runId: runA,
          agentId: "agent-A",
          domain: "database",
          mutationType: "task:create",
          target: "FN-A",
        });
      }),
      ctx.layer.transactionImmediate(async (tx) => {
        await recordRunAuditEventWithinTransaction(tx, {
          runId: runB,
          agentId: "agent-B",
          domain: "database",
          mutationType: "task:create",
          target: "FN-B",
        });
      }),
    ]);

    const rowsA = await readAuditRows(ctx.adminDb, runA);
    const rowsB = await readAuditRows(ctx.adminDb, runB);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect((rowsA[0] as { target: string }).target).toBe("FN-A");
    expect((rowsB[0] as { target: string }).target).toBe("FN-B");
  });
});

pgDescribe("AsyncDataLayer: run-audit-event-within-transaction behavior", () => {
  let ctx: TestLayer | null = null;

  afterEach(async () => {
    await teardownLayer(ctx);
    ctx = null;
  });

  it("the standalone recordRunAuditEvent wraps the insert in its own transaction", async () => {
    ctx = await setupFreshLayer();
    const event = await recordRunAuditEvent(ctx.layer, {
      runId: "run-standalone",
      agentId: "agent-standalone",
      domain: "database",
      mutationType: "task:log",
      target: "FN-STANDALONE",
    });

    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeDefined();
    expect(event.runId).toBe("run-standalone");

    const rows = await readAuditRows(ctx.adminDb, "run-standalone");
    expect(rows).toHaveLength(1);
    expect((rows[0] as { id: string }).id).toBe(event.id);
  });

  it("records metadata as jsonb and round-trips it", async () => {
    ctx = await setupFreshLayer();
    const metadata = { filesChanged: 5, nested: { deep: [1, 2, 3] }, flag: true };
    await recordRunAuditEvent(ctx.layer, {
      runId: "run-metadata",
      agentId: "agent-meta",
      domain: "database",
      mutationType: "task:update",
      target: "FN-META",
      metadata,
    });

    const rows = (await readAuditRows(ctx.adminDb, "run-metadata")) as Array<{
      metadata: unknown;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual(metadata);
  });

  it("an audit row paired with a task-like mutation rolls back together", async () => {
    ctx = await setupFreshLayer();
    const runId = "run-paired-rollback";

    // Simulate the atomicWriteTaskJsonWithAudit pattern: a "task mutation"
    // followed by an audit insert in the same transaction, then a failure.
    await expect(
      ctx.layer.transactionImmediate(async (tx) => {
        // Simulate the task write (here, an audit row stands in for the mutation).
        await recordRunAuditEventWithinTransaction(tx, {
          runId,
          agentId: "agent-paired",
          domain: "database",
          mutationType: "task:update",
          target: "FN-PAIRED",
          metadata: { phase: "mutation" },
        });
        // The audit row that accompanies the mutation.
        await recordRunAuditEventWithinTransaction(tx, {
          runId,
          agentId: "agent-paired",
          domain: "database",
          mutationType: "task:update",
          target: "FN-PAIRED",
          metadata: { phase: "audit" },
        });
        // Simulate a post-mutation failure.
        throw new Error("post-mutation failure rolls back mutation + audit");
      }),
    ).rejects.toThrow("post-mutation failure");

    const count = await countAuditRows(ctx.adminDb);
    expect(count).toBe(0);
  });
});

pgDescribe("AsyncDataLayer: interface stability and connectivity", () => {
  let ctx: TestLayer | null = null;

  afterEach(async () => {
    await teardownLayer(ctx);
    ctx = null;
  });

  it("ping() succeeds against a healthy backend", async () => {
    ctx = await setupFreshLayer();
    await expect(ctx.layer.ping()).resolves.toBeUndefined();
  });

  it("the db member executes a raw query", async () => {
    ctx = await setupFreshLayer();
    const result = (await ctx.layer.db.execute(
      sql`SELECT 1 AS val`,
    )) as unknown as Array<{ val: number }>;
    expect(result[0]?.val).toBe(1);
  });

  it("close() releases the pool without error", async () => {
    ctx = await setupFreshLayer();
    await expect(ctx.layer.close()).resolves.toBeUndefined();
    // Prevent teardownLayer from double-closing.
    const captured = ctx;
    ctx = null;
    // The admin connection is still ours to close.
    try {
      await captured!.adminSql.end({ timeout: 5 });
    } catch {
      // best-effort
    }
    try {
      adminExec(`DROP DATABASE IF EXISTS "${captured!.dbName}"`);
    } catch {
      // best-effort
    }
  });

  it("exposes the stable AsyncDataLayer contract (db, transaction, transactionImmediate, ping, close)", async () => {
    ctx = await setupFreshLayer();
    expect(typeof ctx.layer.db).toBe("object");
    expect(typeof ctx.layer.transaction).toBe("function");
    expect(typeof ctx.layer.transactionImmediate).toBe("function");
    expect(typeof ctx.layer.ping).toBe("function");
    expect(typeof ctx.layer.close).toBe("function");
  });
});

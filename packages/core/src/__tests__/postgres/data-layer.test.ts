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

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  createAsyncDataLayer,
  recordRunAuditEvent,
  recordRunAuditEventWithinTransaction,
  type AsyncDataLayer,
  type RunAuditEventInput,
} from "../../postgres/data-layer.js";
import { createConnectionSetFromUrl } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import * as schema from "../../postgres/schema/index.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";

/*
FNXC:AsyncDataLayer 2026-08-15-03:52:
Slow-test fix: this file hand-rolled CREATE DATABASE + full applySchemaBaseline
PER TEST (~4.6s/test, 65s for the file). The transaction primitives under test
write only data, so each describe block now shares one golden-template database
with the harness's per-test reset. Transaction-visibility semantics are
unchanged: the layer pool and the harness adminDb connection remain SEPARATE
sessions, which is what the VAL-DATA-004 concurrent-reader assertions rely on.
The close() lifecycle test builds a PRIVATE layer against the shared database
so closing it cannot break the harness's pooled layer for later tests.
`ctx` keeps its original shape so test bodies stay byte-identical.
*/
interface TestLayer {
  readonly layer: AsyncDataLayer;
  readonly adminDb: ReturnType<SharedPgTaskStoreHarness["adminDb"]>;
}

const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_data" });

/**
 * Register the shared-harness lifecycle inside a pgDescribe block and return a
 * `ctx` whose `layer`/`adminDb` getters resolve live from the harness, so the
 * original `ctx.layer` / `ctx.adminDb` test bodies read unchanged.
 */
function useSharedLayer(): TestLayer {
  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);
  return {
    get layer() {
      return h.layer();
    },
    get adminDb() {
      return h.adminDb();
    },
  };
}

/** Build a private AsyncDataLayer against the shared harness database. */
async function createPrivateLayer(): Promise<AsyncDataLayer> {
  const testUrl = h.testUrl();
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
  return createAsyncDataLayer(connections);
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
  const ctx = useSharedLayer();

  it("commits a multi-statement mutation with all writes visible after commit", async () => {
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
  const ctx = useSharedLayer();

  it("rolls back all writes when the callback throws, including the audit row", async () => {
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
  const ctx = useSharedLayer();

  it("a concurrent reader outside the writer's transaction does not see uncommitted writes", async () => {
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
  const ctx = useSharedLayer();

  it("the standalone recordRunAuditEvent wraps the insert in its own transaction", async () => {
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
  const ctx = useSharedLayer();

  it("ping() succeeds against a healthy backend", async () => {
    await expect(ctx.layer.ping()).resolves.toBeUndefined();
  });

  it("the db member executes a raw query", async () => {
    const result = (await ctx.layer.db.execute(
      sql`SELECT 1 AS val`,
    )) as unknown as Array<{ val: number }>;
    expect(result[0]?.val).toBe(1);
  });

  it("close() releases the pool without error", async () => {
    // FNXC:AsyncDataLayer 2026-08-15-03:52: close a PRIVATE layer built
    // against the shared database — closing the harness's pooled layer would
    // break every later test in the file.
    const layer = await createPrivateLayer();
    await expect(layer.close()).resolves.toBeUndefined();
  });

  it("exposes the stable AsyncDataLayer contract (db, transaction, transactionImmediate, ping, close)", async () => {
    expect(typeof ctx.layer.db).toBe("object");
    expect(typeof ctx.layer.transaction).toBe("function");
    expect(typeof ctx.layer.transactionImmediate).toBe("function");
    expect(typeof ctx.layer.ping).toBe("function");
    expect(typeof ctx.layer.close).toBe("function");
  });
});

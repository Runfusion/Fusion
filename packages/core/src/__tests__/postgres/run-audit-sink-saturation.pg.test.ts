/**
 * RUFU-453 — the run-audit sink loses rows under ordinary pool contention.
 *
 * Measured 2026-09-30 21:35Z on production: 1332 `[run-audit] timed out recording` lines in the last
 * 20 MB of the redeploy log, and RUFU-451's `task:reconcile-workspace-partial-land-no-action` proof
 * row never existed even though the sweep demonstrably ran. The bounded seam (FN-9172/FN-9175/FN-9177)
 * kept its contract exactly — no lifecycle effect, nothing blocked — and the evidence vanished
 * without a trace, a counter, or a surface.
 *
 * This file is the symptom fixture. It saturates the REAL runtime pool of a REAL pg-backed TaskStore
 * with `pg_sleep` holders, so an audit insert genuinely queues behind live work instead of pretending
 * to be slow.
 *
 *   Test 1 (`characterizes`) is green BEFORE and AFTER the fix. It pins what an AWAITED bounded write
 *     does on a saturated pool: the 2 s timer wins, the caller is told `timed-out`, and — the detail
 *     that made the incident unreadable — the abandoned insert usually still commits moments later.
 *     `timed-out` is therefore a statement about the caller's patience, never about whether the row
 *     exists. `emitBoundedRunAuditWithOutcome` keeps its direct write after the fix precisely because
 *     its callers branch on that answer, so this test stays honest either way.
 *
 *   Test 2 is the `## Symptom Verification` "assertion it is gone": red before the fix for exactly the
 *     reported reason (the warn line is captured, the row never arrives), green after it — an accepted
 *     emit that does not wait, no `timed out recording` line, and the row readable once the drain lands it.
 *
 *   Test 3 names the operator-mandated mutation type end to end — drain writer AND dead-letter spill
 *     AND replay back into the real table — so "the sweep emitted nothing" and "the sweep's rows were
 *     dropped" stay distinguishable (RUFU-616).
 *
 * Bounded on purpose (no-slow-tests rule): two pool slots, one short `pg_sleep` burst per test, no
 * polling loops (a queued barrier query instead), and every holder awaited before the case returns.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  emitBoundedRunAudit,
  emitBoundedRunAuditWithOutcome,
} from "../../run-audit/emit-bounded-run-audit.js";

/*
Two slots instead of production's `DEFAULT_POOL_MAX = 3` (`resolvePoolMax()` in
`postgres/connection.ts` returns 3 unconfigured): the saturation SHAPE — every slot held, so an audit
insert must queue — is identical at 2, and 2 holders is a smaller share of the cluster connection
budget that `docs/solutions/test-failures/pg-harness-connection-budget.md` measures as the harness
failure mode under fan-out.
*/
const RUNTIME_POOL_MAX = 2;
/** Long enough that the 2000 ms emit bound demonstrably loses the race, short enough to stay cheap. */
const SATURATION_SECONDS = 3;

const pgHarness: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusion_rufu453_sink",
  poolMax: RUNTIME_POOL_MAX,
});

const RECONCILE_STRANDED_NO_ACTION = "workflowWorkItem:reconcile-stranded-no-action";

/** Queries a relation this schema does not have, so any write through it rejects server-side. */
const RELATION_MISSING_QUERY = sql`SELECT id FROM project.rufu453_relation_missing`;

/** The metadata the `reconcile-stranded-workflow-continuations` sweep really writes (ids/counts only). */
function strandedRow(workItemId: string) {
  return {
    agentId: "self-healing",
    runId: `synthetic:reconcile-stranded-continuation:${workItemId}`,
    domain: "database" as const,
    mutationType: RECONCILE_STRANDED_NO_ACTION,
    target: workItemId,
    metadata: {
      taskId: "RUFU-616",
      workItemId,
      nodeId: "step-execute",
      kind: "task",
      priorState: "held",
      reason: "lease-expired",
      stalenessMs: 9_000,
    },
  };
}

function logSpy() {
  const lines: string[] = [];
  return { lines, log: { warn: (message: string) => { lines.push(message); } } };
}

/**
 * Reads on the harness's own admin pool: `store.getRunAuditEventsAsync` would queue on the runtime
 * pool that the test has just deliberately saturated, which measures the harness, not the sink.
 */
async function rowsFor(workItemId: string): Promise<{ id: string; mutation_type: string }[]> {
  const admin = pgHarness.adminSql();
  const rows = await admin`
    SELECT id, mutation_type FROM project.run_audit_events WHERE target = ${workItemId}
  `;
  return rows as unknown as { id: string; mutation_type: string }[];
}

/**
 * FIFO barrier, not a poll: postgres.js queues requests per pool, so a request enqueued AFTER the
 * audit insert is served after it. Awaiting it proves the queued insert has settled without sleeping
 * or retrying.
 */
async function runtimePoolBarrier(): Promise<void> {
  await pgHarness.layer().db.execute(sql`SELECT 1`);
}

pgDescribe("run-audit sink saturation (PostgreSQL)", () => {
  beforeAll(pgHarness.beforeAll);
  beforeEach(pgHarness.beforeEach);
  afterAll(pgHarness.afterAll);

  /** Occupy every runtime-pool slot; the returned function awaits the holders home. */
  async function saturateRuntimePool(): Promise<() => Promise<void>> {
    /*
    The holder queries run inside an immediately-invoked async function because a drizzle `execute()`
    is a LAZY thenable: holding the un-awaited promise would start nothing, and the emit would then
    sail through an idle pool and report the wrong world.
    */
    const holderPool = pgHarness.layer().db;
    const holders = Array.from({ length: RUNTIME_POOL_MAX }, () =>
      (async () => {
        try {
          await holderPool.execute(sql`SELECT pg_sleep(${SATURATION_SECONDS})`);
        } catch {
          // A holder that dies early would un-saturate the pool; the premise check below catches that.
        }
      })(),
    );

    /*
    Prove the premise instead of assuming it: the server itself reports every slot busy. A fixture
    that quietly failed to saturate would make every downstream assertion measure nothing.
    */
    const admin = pgHarness.adminSql();
    await vi.waitFor(
      async () => {
        const [row] = await admin<[{ held: string }]>`
          SELECT count(*)::text AS held
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND query ~ 'pg_sleep'
        `;
        expect(Number(row?.held ?? 0)).toBeGreaterThanOrEqual(RUNTIME_POOL_MAX);
      },
      { timeout: 2_000, interval: 50 },
    );

    return async () => {
      await Promise.allSettled(holders);
    };
  }

  it("characterizes an awaited bounded write: timed-out while the abandoned insert still lands", async () => {
    const release = await saturateRuntimePool();
    const spy = logSpy();
    const workItemId = "wi-rufu453-characterize";

    const startedAt = Date.now();
    const result = await emitBoundedRunAuditWithOutcome(
      pgHarness.store(),
      strandedRow(workItemId),
      { log: spy.log },
    );
    const elapsedMs = Date.now() - startedAt;

    try {
      expect(result.outcome).toBe("timed-out");
      expect(spy.lines.join("\n")).toContain("timed out recording");
      // The caller gave up long before the queued insert could reach a connection.
      expect(elapsedMs).toBeLessThan(SATURATION_SECONDS * 1000);
      expect(await rowsFor(workItemId)).toHaveLength(0);
      await runtimePoolBarrier();
    } finally {
      await release();
    }

    /*
    The half that made the incident unreadable: `timed-out` never meant "no row". Once a slot freed,
    the write the seam had stopped watching completed on its own. The log says the sweep did nothing;
    the table says otherwise. That divergence — not the timeout — is the defect, and it is why the fix
    must ACCOUNT for rows instead of trading one unobserved outcome for another.
    */
    expect(await rowsFor(workItemId)).toHaveLength(1);
  });

  it("keeps the fire-and-forget emit accepted on a saturated sink and lands the row", async () => {
    const release = await saturateRuntimePool();
    const spy = logSpy();
    const workItemId = "wi-rufu453-survives";

    const startedAt = Date.now();
    await emitBoundedRunAudit(pgHarness.store(), strandedRow(workItemId), { log: spy.log });
    const elapsedMs = Date.now() - startedAt;

    // The emit itself must never spend a database round-trip on a sink that is merely busy.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(spy.lines.join("\n")).not.toContain("timed out recording");

    await release();

    // A bounded drain, not a poll: the queued batch is served after the holders let go.
    const sink = pgHarness.store() as unknown as {
      flushRunAuditSink?: () => Promise<void>;
      getRunAuditSinkStats?: () => Record<string, unknown>;
    };
    expect(typeof sink.flushRunAuditSink, "the store must expose its sink drain").toBe("function");
    await sink.flushRunAuditSink?.();

    expect(await rowsFor(workItemId)).toHaveLength(1);

    const stats = sink.getRunAuditSinkStats?.() ?? {};
    expect(Number(stats.written ?? 0)).toBeGreaterThan(0);
    expect(Number(stats.spilledToDeadLetter ?? -1)).toBe(0);
  });

  it("spills a refused batch to the dead letter and replays it into the real table", async () => {
    // Imported lazily: the writer, the dead letter, and the batched insert are what Steps 2-4 add, and
    // this file must stay loadable (keeping test 1's honest green) before they exist.
    const { createRunAuditSinkWriter } = await import("../../run-audit/audit-sink-writer.js");
    const {
      createRunAuditDeadLetterSink,
      readRunAuditDeadLetter,
      replayRunAuditDeadLetter,
    } = await import("../../run-audit/run-audit-dead-letter.js");
    const { insertRunAuditEventsBatched } = await import("../../postgres/data-layer.js");
    const spy = logSpy();
    const workItemId = "wi-rufu453-dead-letter";
    const rootDir = pgHarness.rootDir();

    const deadLetter = createRunAuditDeadLetterSink({ rootDir });
    const sink = createRunAuditSinkWriter({
      // A genuine PostgreSQL refusal: the relation does not exist, so the batch insert really rejects
      // on the server instead of being told to fail.
      write: async () => {
        await pgHarness.layer().db.execute(RELATION_MISSING_QUERY);
      },
      deadLetter,
      log: spy.log,
    });

    sink.submit(strandedRow(workItemId));
    await sink.flush();

    const spilled = sink.stats();
    expect(Number(spilled.batchFailures ?? 0)).toBeGreaterThan(0);
    expect(Number(spilled.spilledToDeadLetter ?? -1)).toBe(1);
    expect(Number(spilled.written ?? -1)).toBe(0);
    // Losing the row to a refusal is accounted for, never announced as a lifecycle failure.
    expect(spy.lines.join("\n")).not.toContain("timed out recording");

    const spilledRows = await readRunAuditDeadLetter({ rootDir });
    expect(spilledRows.rows).toHaveLength(1);
    expect(spilledRows.rows[0]).toMatchObject({
      mutationType: RECONCILE_STRANDED_NO_ACTION,
      target: workItemId,
      metadata: { workItemId },
    });

    /*
    Replay through the SAME batched insert the drain uses, so the recovered row is the row the emitters
    promise and the `(project_id, id)` primary key — the idempotency a submit-time id buys — decides
    whether it is new. A second pass must land nothing rather than duplicate the evidence.
    */
    const replayOnce = () =>
      replayRunAuditDeadLetter({
        rootDir,
        insert: (rows: Parameters<typeof insertRunAuditEventsBatched>[1]) =>
          insertRunAuditEventsBatched(pgHarness.layer(), rows),
      });

    expect(Number((await replayOnce()).replayed ?? -1)).toBe(1);
    expect(await rowsFor(workItemId)).toHaveLength(1);

    expect(Number((await replayOnce()).replayed ?? -1)).toBe(0);
    expect(await rowsFor(workItemId)).toHaveLength(1);

    await sink.stop();
  });
});

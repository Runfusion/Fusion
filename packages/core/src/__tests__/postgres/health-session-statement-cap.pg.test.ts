/**
 * FNXC:PostgresHealthTransport 2026-09-26-03:12 (RUFU-301):
 * Executable version of the symptom measurement. The integrity canary published
 * `corruptionDetected: false` while its probe never finished, because the probe's
 * own reads outlived the client deadline on a `max: 1` session: `pg_stat_activity`
 * showed `SELECT id FROM project.tasks` still running 5.0 s after `/api/health`
 * had already answered, and the next two polls then failed in the *earlier*
 * connectivity stage as their `SELECT 1` queued behind that orphan.
 *
 * The fix is a server-side `statement_timeout` on the health session, strictly
 * below the probe budget, so PostgreSQL cancels its own work at the deadline.
 * Only a real server can prove that mechanism, so this file asserts it against
 * PostgreSQL directly: the wiring, the cancellation, the immediate re-usability
 * of the session, and — as the negative control — that without the cap the same
 * statement runs past the deadline instead of being cancelled.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PG_TEST_URL_BASE, pgDescribe } from "../../__test-utils__/pg-test-harness.js";
import {
  createConnectionSet,
  type PostgresConnections,
} from "../../postgres/connection.js";
import {
  DEFAULT_HEALTH_PROBE_BUDGET_MS,
  HEALTH_SESSION_STATEMENT_SAFETY_MARGIN_MS,
  healthSessionStatementTimeoutMs,
} from "../../postgres/health-probe-budget.js";

const pgTest = pgDescribe;

/** A budget short enough that the cancellation test costs ~150 ms, not 5 s. */
const SHORT_PROBE_BUDGET_MS = 400;

pgTest("health session statement cap (RUFU-301 transport)", () => {
  let connections: PostgresConnections | undefined;

  beforeAll(async () => {
    connections = await createConnectionSet({ DATABASE_URL: PG_TEST_URL_BASE });
  });

  afterAll(async () => {
    await connections?.close();
  });

  async function statementTimeoutOf(db: PostgresConnections["health"]): Promise<string> {
    const rows = await db.execute(sql`select current_setting('statement_timeout') as value`);
    return String((rows as unknown as Array<{ value: string }>)[0]!.value);
  }

  /**
   * Drizzle wraps the server error ("Failed query: …") and keeps PostgreSQL's
   * cancellation notice as `cause`, so the assertion has to read the chain —
   * the cancel is the whole point and must be named, not merely "it rejected".
   */
  async function expectServerCancellation(run: Promise<unknown>): Promise<void> {
    let failure: unknown;
    try {
      await run;
    } catch (error) {
      failure = error;
    }
    expect(failure, "the server must cancel its own statement").toBeInstanceOf(Error);
    const messages: string[] = [];
    let current: unknown = failure;
    while (current instanceof Error) {
      messages.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    expect(messages.join("\n")).toMatch(/canceling statement due to statement timeout/i);
  }

  function applyTimeout(db: PostgresConnections["health"], ms: number): Promise<unknown> {
    // `SET` takes no parameter placeholder, so the value must be a validated
    // integer before it reaches raw SQL.
    if (!Number.isInteger(ms) || ms < 0) {
      throw new Error(`Refusing to interpolate a non-integer statement_timeout: ${ms}`);
    }
    return db.execute(sql.raw(`set statement_timeout to '${ms}'`));
  }

  it("caps the health session's own statements strictly below the probe budget", async () => {
    const cap = healthSessionStatementTimeoutMs();
    expect(cap).toBeGreaterThan(0);
    expect(DEFAULT_HEALTH_PROBE_BUDGET_MS - cap).toBeGreaterThanOrEqual(
      HEALTH_SESSION_STATEMENT_SAFETY_MARGIN_MS,
    );

    // The server reports the cap it will enforce, in its own units — the wiring
    // is only real if PostgreSQL itself agrees with the computed value.
    expect(await statementTimeoutOf(connections!.health)).toBe(`${cap}ms`);
  });

  it("leaves the runtime pool uncapped so health policy cannot cancel scheduler work", async () => {
    // `0` is PostgreSQL's "never cancel". Correct for runtime work, and the
    // exact value that was fatal on the health session.
    expect(await statementTimeoutOf(connections!.runtime)).toBe("0");
  });

  it("cancels a past-deadline statement inside the budget and keeps the max-one session usable", async () => {
    const health = connections!.health;
    const cap = healthSessionStatementTimeoutMs(SHORT_PROBE_BUDGET_MS);
    try {
      await applyTimeout(health, cap);

      const startedAt = performance.now();
      await expectServerCancellation(health.execute(sql`select pg_sleep(1)`));
      const elapsedMs = performance.now() - startedAt;
      // The database quits ahead of the caller's deadline instead of leaving the
      // read running, which is what made the abandoned probe invisible.
      expect(elapsedMs).toBeLessThan(SHORT_PROBE_BUDGET_MS);

      // And the next readiness read is served immediately — no queue behind an
      // orphan, which is the failure that moved the symptom to the connectivity
      // stage in the original capture.
      const followUpStartedAt = performance.now();
      await health.execute(sql`select 1`);
      expect(performance.now() - followUpStartedAt).toBeLessThan(500);
    } finally {
      await applyTimeout(health, healthSessionStatementTimeoutMs());
    }
  });

  it("control: without the cap the same statement survives the deadline on the same session", async () => {
    const health = connections!.health;
    try {
      await applyTimeout(health, 0);
      const startedAt = performance.now();
      await health.execute(sql`select pg_sleep(0.5)`);
      const elapsedMs = performance.now() - startedAt;
      // Uncapped, the server never cancels: a 400 ms client deadline would have
      // expired while this statement kept executing on the single health
      // connection. Without the cap above, the fix would be a no-op.
      expect(elapsedMs).toBeGreaterThanOrEqual(450);
    } finally {
      await applyTimeout(health, healthSessionStatementTimeoutMs());
    }

    // Restoring the health policy must not touch the runtime pool's session.
    expect(await statementTimeoutOf(health)).toBe(`${healthSessionStatementTimeoutMs()}ms`);
    expect(await statementTimeoutOf(connections!.runtime)).toBe("0");
  });
});

/**
 * RUFU-301: the health probe's deadline and the transport's server-side cap are
 * two views of ONE budget, so they are pinned together here.
 *
 * FNXC:PostgresHealthTransport 2026-09-26-02:05 (RUFU-301):
 * The measured failure was not a slow query (60k-task corpus: 21.6 ms scoped /
 * 68.4 ms unscoped against a 5 s budget) but a wedged `max: 1` health session:
 * a read the caller abandoned at its deadline kept executing on that session and
 * starved the next polls. The session therefore cancels its own statements
 * strictly below the caller's budget. These tests guard the three properties the
 * fix depends on: the cap is strictly below the budget (so the caller learns
 * *why* it failed instead of losing the session), it stays positive for any
 * caller-supplied budget, and it is not widened by a bogus budget.
 */

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HEALTH_PROBE_BUDGET_MS,
  HEALTH_SESSION_STATEMENT_SAFETY_MARGIN_MS,
  healthSessionStatementTimeoutMs,
} from "../../postgres/health-probe-budget.js";

const postgresSessions: Array<{ url: string; options: Record<string, any> }> = [];

vi.mock("postgres", () => ({
  default: (url: string, options: Record<string, any>) => {
    postgresSessions.push({ url, options });
    // drizzle() reads the client's codec maps at construction time, so the
    // double must expose the shape postgres.js instances carry. No query is run:
    // this test asserts which options each session was opened with.
    const client = (() => undefined) as unknown as Record<string, any>;
    client.options = { parsers: {}, serializers: {} };
    client.unsafe = () => undefined;
    client.end = async () => {};
    return client;
  },
}));

describe("healthSessionStatementTimeoutMs", () => {
  it("sits strictly below the default probe budget so the caller sees the cancellation", () => {
    const cap = healthSessionStatementTimeoutMs();

    expect(cap).toBe(DEFAULT_HEALTH_PROBE_BUDGET_MS - HEALTH_SESSION_STATEMENT_SAFETY_MARGIN_MS);
    expect(cap).toBeLessThan(DEFAULT_HEALTH_PROBE_BUDGET_MS);
    expect(cap).toBeGreaterThan(0);
  });

  it("keeps the cap below any caller-supplied budget instead of inheriting the deadline", () => {
    for (const budget of [5_000, 2_000, 300, 60, 25, 10, 2]) {
      expect(healthSessionStatementTimeoutMs(budget)).toBeLessThan(budget);
      expect(healthSessionStatementTimeoutMs(budget)).toBeGreaterThan(0);
    }
  });

  it("prefers a positive cap over the margin when the budget cannot spare one", () => {
    // A 1 ms budget physically cannot host a sub-millisecond cancellation, so the
    // honest answer is the smallest positive timeout, never 0 = "never cancel".
    expect(healthSessionStatementTimeoutMs(1)).toBe(1);
  });

  it("falls back to the default-derived cap for a nonsense budget", () => {
    // A 0/NaN/negative budget must not produce a zero or negative server cap:
    // Postgres reads `statement_timeout = 0` as "never cancel", which is the
    // exact wedge this fix exists to prevent.
    const fallback = healthSessionStatementTimeoutMs();

    expect(healthSessionStatementTimeoutMs(0)).toBe(fallback);
    expect(healthSessionStatementTimeoutMs(-25)).toBe(fallback);
    expect(healthSessionStatementTimeoutMs(Number.NaN)).toBe(fallback);
    expect(healthSessionStatementTimeoutMs(Number.POSITIVE_INFINITY)).toBe(fallback);
  });

  it("never floors at zero when the budget is smaller than the safety margin", () => {
    expect(healthSessionStatementTimeoutMs(10)).toBeGreaterThan(0);
  });
});

/*
FNXC:PostgresHealthTransport 2026-09-26-02:06 (RUFU-301):
The budget module is only worth anything if the session that actually runs health
statements receives it, so this asserts the wiring at the construction seam: the
dedicated `max: 1` health session gets the derived server-side cap, and the
runtime pool does NOT — imposing the health budget on normal traffic would turn a
readiness bound into a query killer.
*/
describe("health session statement timeout wiring", () => {
  it("applies the derived cap to the dedicated health session only", async () => {
    postgresSessions.length = 0;
    const { createConnectionSetFromUrl } = await import("../../postgres/connection.js");

    const connections = await createConnectionSetFromUrl(
      {
        mode: "external",
        runtimeUrl: "postgres://localhost:5432/fusion_health_budget_test",
        migrationUrl: null,
        migrationUrlOverridden: false,
      } as any,
      { poolMax: 3, bypassProjectIsolation: true },
    );
    expect(connections).toBeTruthy();

    const health = postgresSessions.find((s) => s.options.max === 1 && s.options.connection?.statement_timeout !== undefined);
    const runtime = postgresSessions.find((s) => s.options.max === 3);

    expect(health).toBeTruthy();
    expect(health!.options.connection.statement_timeout).toBe(healthSessionStatementTimeoutMs());
    expect(runtime).toBeTruthy();
    expect(runtime!.options.connection?.statement_timeout).toBeUndefined();
  });
});

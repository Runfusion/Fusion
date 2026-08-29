import { afterEach, expect, it } from "vitest";
import {
  __resetPgConnectionBudgetForTest,
  observePgConnectionBudget,
  resolvePgConnectionBudget,
} from "../../__test-utils__/pg-connection-budget.js";
import {
  PG_AVAILABLE,
  PG_TEST_URL_BASE,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";

/**
 * FNXC:PgTestConnectionBudget 2026-08-17-01:36:
 * The primitive is deliberately unwired after loaded measurements showed that
 * harness-side admission regressed broad PostgreSQL suites. Keep a focused
 * server-backed check of its advisory-lock allocation while successor work
 * finds a setup-safe place to apply aggregate admission.
 */
const describeWhenPg = PG_AVAILABLE ? pgDescribe : pgDescribe.skip;

describeWhenPg("PostgreSQL connection-budget primitive", () => {
  afterEach(async () => {
    await __resetPgConnectionBudgetForTest();
  });

  it("allocates a closed advisory-lock reserve against the reachable cluster", async () => {
    await resolvePgConnectionBudget({ available: PG_AVAILABLE, urlBase: PG_TEST_URL_BASE });

    const observation = observePgConnectionBudget();
    expect(observation.slotCount).toBeGreaterThanOrEqual(observation.forkWorkReserve + 1);
    expect(observation.heldWorkSlots).toBe(observation.forkWorkReserve);
    expect(observation.leaseHeld).toBe(true);
    expect(observation.degradedCount["capacity-unreadable"]).toBe(0);
  }, 15_000);
});

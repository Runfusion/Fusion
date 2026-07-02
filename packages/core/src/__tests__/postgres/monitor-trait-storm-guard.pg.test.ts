/**
 * FNXC:Monitor 2026-06-28-10:30:
 * PostgreSQL-backed coverage for the async storm-guard helpers that the
 * dashboard `runMonitorOnRegression` now drives in PG backend mode (it no longer
 * early-returns "absorbed"). These are the ported surface: the create→link→
 * (release-on-failure) sequence around `project.incidents`. The dashboard trait
 * itself is dashboard-only, so this exercises the async-monitor helpers directly
 * against embedded Postgres — the exact code path the trait now calls with
 * `store.getAsyncLayer().db`.
 *
 * Auto-skipped via pgDescribe when PostgreSQL is absent.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  ingestIncidentSignalAsync,
  getIncidentAsync,
  countRecentAutoFixTasksAsync,
  claimIncidentForFixTaskAsync,
  attachFixTaskAsync,
  releaseIncidentFixTaskClaimAsync,
} from "../../task-store/async-monitor.js";

const pgTest = pgDescribe;

pgTest("monitor storm-guard async helpers (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_monitor_storm_guard",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("claim → createTask → attach happy path persists the linkage", async () => {
    const db = h.layer().db;

    // Ingest the same grouping key three times to pass the default threshold gate.
    const signal = { groupingKey: "svc/checkout-5xx", title: "Checkout 5xx", severity: "critical" };
    const first = await ingestIncidentSignalAsync(db, signal);
    expect(first.created).toBe(true);
    await ingestIncidentSignalAsync(db, signal);
    const { incident } = await ingestIncidentSignalAsync(db, signal);
    const incidentId = incident.incidentId;

    // No auto-fix tasks linked yet (the breaker count ignores everything).
    expect(await countRecentAutoFixTasksAsync(db)).toBe(0);

    // Exactly one caller wins the atomic claim.
    expect(await claimIncidentForFixTaskAsync(db, incidentId)).toBe(true);
    expect(await claimIncidentForFixTaskAsync(db, incidentId)).toBe(false);

    // Link the real fix-task id (mirrors store.createTask → attach).
    await attachFixTaskAsync(db, incidentId, "FN-FIX-1");

    const linked = await getIncidentAsync(db, incidentId);
    expect(linked?.fixTaskId).toBe("FN-FIX-1");

    // The linked incident now counts against the circuit breaker; the sentinel
    // never did.
    expect(await countRecentAutoFixTasksAsync(db)).toBe(1);
  });

  it("release-on-failure path clears the stranded claim back to NULL", async () => {
    const db = h.layer().db;

    const signal = { groupingKey: "svc/payments-timeout", title: "Payments timeout", severity: "high" };
    await ingestIncidentSignalAsync(db, signal);
    await ingestIncidentSignalAsync(db, signal);
    const { incident } = await ingestIncidentSignalAsync(db, signal);
    const incidentId = incident.incidentId;

    // Claim, then simulate createTask failure → release the sentinel.
    expect(await claimIncidentForFixTaskAsync(db, incidentId)).toBe(true);

    // The sentinel is not a real link, so it must NOT count against the breaker.
    expect(await countRecentAutoFixTasksAsync(db)).toBe(0);

    expect(await releaseIncidentFixTaskClaimAsync(db, incidentId)).toBe(true);

    const released = await getIncidentAsync(db, incidentId);
    expect(released?.fixTaskId).toBeNull();

    // Releasing again is a no-op (only clears when still the exact sentinel), so a
    // later real attach can never be clobbered.
    expect(await releaseIncidentFixTaskClaimAsync(db, incidentId)).toBe(false);

    // After release the incident is claimable again — a later regression can open
    // a fix task instead of being permanently absorbed.
    expect(await claimIncidentForFixTaskAsync(db, incidentId)).toBe(true);
  });
});

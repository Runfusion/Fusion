/**
 * FNXC:PostgresCutover 2026-06-28-09:10:
 * PostgreSQL-backed coverage for incident-signal ingestion (FN-6706 PG cutover).
 * The dashboard `ingestIncidentSignal` was sync-SQLite-only and skipped in backend
 * mode (signals dropped, recorded only via the resolveIncident path). It is now a
 * backend dual-path that, in PG mode, delegates to `ingestIncidentSignalAsync`
 * here — writing the schema-qualified `project.incidents` table (snake_case
 * columns) via Drizzle.
 *
 * This exercises the exact async branch the dashboard wrapper calls, asserting the
 * upsert/dedup invariant: the first firing for a grouping key OPENS one incident
 * row; a second firing with the SAME grouping key ABSORBS into it (no duplicate
 * row, occurrence count + updatedAt bumped, first-fired preserved). A distinct
 * grouping key opens a separate incident. Auto-skipped via pgDescribe when
 * PostgreSQL is absent.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import {
  ingestIncidentSignalAsync,
  getOpenIncidentByGroupingKeyAsync,
} from "../../task-store/async-monitor.js";
import * as schema from "../../postgres/schema/index.js";

const pgTest = pgDescribe;

pgTest("incident-signal ingestion (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_signal_ingestion",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("first firing opens an incident row in project.incidents", async () => {
    const db = h.layer().db;
    const { incident, created } = await ingestIncidentSignalAsync(db, {
      groupingKey: "svc:api:500",
      title: "API 500s",
      severity: "critical",
      source: "datadog",
      link: "https://example.test/alert/1",
      at: "2026-06-28T00:00:00.000Z",
    });

    expect(created).toBe(true);
    expect(incident.groupingKey).toBe("svc:api:500");
    expect(incident.status).toBe("open");
    expect(incident.severity).toBe("critical");
    expect(incident.source).toBe("datadog");
    // occurrences starts at 1; first-fired anchored to the firing timestamp.
    expect(incident.meta?.occurrences).toBe(1);
    expect(incident.meta?.firstFiredAt).toBe("2026-06-28T00:00:00.000Z");

    // The row is durably readable as the open incident for the grouping key.
    const open = await getOpenIncidentByGroupingKeyAsync(db, "svc:api:500");
    expect(open?.incidentId).toBe(incident.incidentId);
  });

  it("a second firing with the same grouping key absorbs rather than duplicates", async () => {
    const db = h.layer().db;
    const first = await ingestIncidentSignalAsync(db, {
      groupingKey: "svc:web:latency",
      title: "Web latency",
      severity: "high",
      at: "2026-06-28T01:00:00.000Z",
    });
    expect(first.created).toBe(true);

    const second = await ingestIncidentSignalAsync(db, {
      groupingKey: "svc:web:latency",
      title: "Web latency (re-fired)",
      severity: "high",
      at: "2026-06-28T01:05:00.000Z",
    });

    // Absorbed: same incident id, not a new open incident.
    expect(second.created).toBe(false);
    expect(second.incident.incidentId).toBe(first.incident.incidentId);
    // Occurrence count bumped; first-fired anchor preserved; updatedAt advanced.
    expect(second.incident.meta?.occurrences).toBe(2);
    expect(second.incident.meta?.firstFiredAt).toBe("2026-06-28T01:00:00.000Z");
    expect(second.incident.updatedAt).toBe("2026-06-28T01:05:00.000Z");

    // Exactly one open incident exists for this grouping key (no duplicate row).
    const rows = await db.select().from(schema.project.incidents);
    const matching = rows.filter((r) => r.groupingKey === "svc:web:latency");
    expect(matching).toHaveLength(1);
  });

  it("a distinct grouping key opens a separate incident", async () => {
    const db = h.layer().db;
    const a = await ingestIncidentSignalAsync(db, {
      groupingKey: "svc:db:conn",
      title: "DB connections",
      at: "2026-06-28T02:00:00.000Z",
    });
    const b = await ingestIncidentSignalAsync(db, {
      groupingKey: "svc:queue:lag",
      title: "Queue lag",
      at: "2026-06-28T02:01:00.000Z",
    });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.incident.incidentId).not.toBe(b.incident.incidentId);
  });
});

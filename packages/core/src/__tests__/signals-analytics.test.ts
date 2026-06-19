import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Database } from "../db.js";
import { aggregateSignalsAnalytics } from "../signals-analytics.js";

const RANGE = { from: "2026-03-01T00:00:00.000Z", to: "2026-03-31T23:59:59.999Z" };

let incidentSeq = 0;
function insertIncident(
  db: Database,
  fields: {
    status: "open" | "resolved";
    openedAt: string;
    resolvedAt?: string | null;
    source?: string | null;
    severity?: string | null;
  },
): void {
  const incidentId = `sig-${incidentSeq++}`;
  const now = "2026-03-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO incidents
       (incidentId, groupingKey, title, severity, status, source, openedAt, resolvedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    incidentId,
    `group-${incidentId}`,
    `Signal ${incidentId}`,
    fields.severity ?? "error",
    fields.status,
    fields.source ?? "webhook",
    fields.openedAt,
    fields.resolvedAt ?? null,
    now,
    now,
  );
}

describe("signals-analytics", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(() => {
    incidentSeq = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "kb-signals-analytics-"));
    db = new Database(join(tmpDir, ".fusion"));
    db.init();
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("aggregates real incident signals by source, severity, status, and MTTR", () => {
    insertIncident(db, {
      status: "open",
      openedAt: "2026-03-02T10:00:00.000Z",
      source: "sentry",
      severity: "critical",
    });
    insertIncident(db, {
      status: "resolved",
      openedAt: "2026-03-03T10:00:00.000Z",
      resolvedAt: "2026-03-03T10:45:00.000Z",
      source: "pagerduty",
      severity: "warning",
    });
    insertIncident(db, {
      status: "resolved",
      openedAt: "2026-02-01T10:00:00.000Z",
      resolvedAt: "2026-02-01T10:30:00.000Z",
      source: "outside",
      severity: "info",
    });

    const result = aggregateSignalsAnalytics(db, RANGE);

    expect(result.totalSignals).toBe(2);
    expect(result.open).toBe(1);
    expect(result.resolved).toBe(1);
    expect(result.mttr).toEqual({ value: 45, unavailable: false, sampleCount: 1 });
    expect(result.bySource).toEqual([
      { source: "pagerduty", count: 1 },
      { source: "sentry", count: 1 },
    ]);
    expect(result.bySeverity).toEqual([
      { severity: "critical", count: 1 },
      { severity: "warning", count: 1 },
    ]);
    expect(result.byStatus).toEqual([
      { status: "open", count: 1 },
      { status: "resolved", count: 1 },
    ]);
  });

  it("keeps MTTR as the unavailable sentinel when no incident resolved in range", () => {
    insertIncident(db, {
      status: "open",
      openedAt: "2026-03-02T10:00:00.000Z",
      source: "webhook",
      severity: "error",
    });

    const result = aggregateSignalsAnalytics(db, RANGE);

    expect(result.totalSignals).toBe(1);
    expect(result.mttr).toEqual({ value: null, unavailable: true, sampleCount: 0 });
  });
});

/**
 * RUFU-301: `/api/health` may never publish "no corruption" about a check that
 * produced blocking evidence.
 *
 * FNXC:TaskIdIntegrityCanary 2026-09-26-02:13 (RUFU-301):
 * The canary's blindness lived at the publication seam: `corruptionDetected:
 * false` was forwarded unchanged even when the same payload carried a blocking
 * error and `taskIdIntegrity.status: "error"`, so every boolean consumer read a
 * completed-clean verdict out of a measurement that never finished. These tests
 * pin the gate itself — including a deliberately contradictory upstream input —
 * and keep the anomaly case's pre-existing contract (the anomaly banner owns that
 * state, the generic corruption canary stays false) visible rather than accidental.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import { buildHealthPayload } from "../server.js";
import type {
  DashboardDatabaseHealth,
  DashboardTaskIdIntegrityHealth,
} from "../dashboard-postgres-health.js";

const CHECKED_AT = new Date("2026-09-26T02:13:00.000Z");

function database(overrides: Partial<DashboardDatabaseHealth> = {}): DashboardDatabaseHealth {
  return {
    healthy: true,
    corruptionDetected: false,
    corruptionErrors: [],
    lastCheckedAt: CHECKED_AT,
    isRunning: false,
    ...overrides,
  };
}

const CLEAN_INTEGRITY: DashboardTaskIdIntegrityHealth = {
  status: "ok",
  checkedAt: CHECKED_AT.toISOString(),
  anomalies: [],
};

function errorIntegrity(
  failure: "unconfigured" | "unreachable" | "incomplete",
  error: string,
): DashboardTaskIdIntegrityHealth {
  return { status: "error", checkedAt: CHECKED_AT.toISOString(), anomalies: [], error, failure };
}

function payload(
  databaseHealth: DashboardDatabaseHealth,
  integrity: DashboardTaskIdIntegrityHealth,
) {
  return buildHealthPayload({
    database: databaseHealth,
    taskIdIntegrityReport: integrity,
    cliPackageVersion: "0.0.0-test",
    engineAvailable: true,
  });
}

describe("buildHealthPayload pair invariant", () => {
  it("publishes false only for a completed clean measurement", () => {
    const result = payload(database(), CLEAN_INTEGRITY);

    expect(result.database.corruptionDetected).toBe(false);
    expect(result.database.corruptionErrors).toEqual([]);
    expect(result.taskIdIntegrity.status).toBe("ok");
    expect(result.status).toBe("ok");
  });

  it("never publishes a blocking error alongside a false-clean canary", () => {
    const cases: Array<{ name: string; database: DashboardDatabaseHealth; integrity: DashboardTaskIdIntegrityHealth }> = [
      {
        name: "integrity stage timed out",
        database: database({
          healthy: false,
          corruptionDetected: false,
          corruptionErrors: ["PostgreSQL task-ID integrity probe did not complete within its 4750ms stage budget"],
        }),
        integrity: errorIntegrity("incomplete", "PostgreSQL task-ID integrity probe did not complete"),
      },
      {
        name: "no layer configured",
        database: database({
          healthy: false,
          corruptionDetected: false,
          corruptionErrors: ["PostgreSQL health layer unavailable"],
        }),
        integrity: errorIntegrity("unconfigured", "PostgreSQL health layer unavailable"),
      },
      {
        name: "server unreachable",
        database: database({
          healthy: false,
          corruptionDetected: false,
          corruptionErrors: ["PostgreSQL health check failed: connect ECONNREFUSED 127.0.0.1:5432"],
        }),
        integrity: errorIntegrity("unreachable", "PostgreSQL health check failed: connect ECONNREFUSED"),
      },
      {
        name: "upstream builder drift: errors present but the boolean says clean",
        database: database({ corruptionErrors: ["corruptionDetails: duplicate task id FN-1"] }),
        integrity: CLEAN_INTEGRITY,
      },
    ];

    for (const testCase of cases) {
      const result = payload(testCase.database, testCase.integrity);

      expect(result.database.corruptionDetected, testCase.name).toBe(true);
      expect(result.status, testCase.name).toBe("degraded");
    }
  });

  it("keeps a measured anomaly on the integrity banner without flipping the generic canary", () => {
    // Pre-existing contract, made explicit: `corruptionDetected` reports storage
    // corruption evidence, while a measured ID-allocator anomaly is carried by
    // `taskIdIntegrity.status` and its own banner/recommended action.
    const result = payload(database(), {
      status: "anomaly",
      checkedAt: CHECKED_AT.toISOString(),
      anomalies: [{ kind: "duplicate_active_id", prefix: "FN", affectedIds: ["FN-1"], details: "duplicate" }],
    });

    expect(result.taskIdIntegrity.status).toBe("anomaly");
    expect(result.status).toBe("degraded");
    expect(result.taskIdIntegrity.recommendedAction).toContain("Pause task delegation");
  });

  it("names the evidence class it has in the recommended action", () => {
    const action = (failure: "unconfigured" | "unreachable" | "incomplete") =>
      payload(
        database({ healthy: false, corruptionErrors: [`stage ${failure} failed`] }),
        errorIntegrity(failure, `stage ${failure} failed`),
      ).taskIdIntegrity.recommendedAction;

    expect(action("unreachable")).toContain("Restore PostgreSQL connectivity");
    expect(action("unconfigured")).toContain("database configuration");
    // The measured wedge case must NOT send the operator to restore connectivity.
    const incomplete = action("incomplete");
    expect(incomplete).toContain("did not finish");
    expect(incomplete).not.toContain("Restore PostgreSQL connectivity");
  });

  it("carries the fields that let the UI tell unmeasured apart from clean and corrupt", () => {
    // RUFU-301 acceptance: three states must be distinguishable even though the
    // canary boolean only has two values. Measured-clean and unmeasured share
    // `status: "degraded"`-free or degraded wording, so the machine-readable pair
    // (`status` + `failure`) is what the banner keys on.
    const clean = payload(database(), CLEAN_INTEGRITY);
    const unmeasured = payload(
      database({ healthy: false, corruptionErrors: ["measurement cancelled"] }),
      errorIntegrity("incomplete", "measurement cancelled"),
    );
    const corrupt = payload(database(), {
      status: "anomaly",
      checkedAt: CHECKED_AT.toISOString(),
      anomalies: [{ kind: "duplicate_active_id", prefix: "FN", affectedIds: ["FN-1"], details: "duplicate" }],
    });

    expect(clean.taskIdIntegrity).not.toHaveProperty("failure");
    expect(clean.taskIdIntegrity.status).toBe("ok");
    expect(unmeasured.taskIdIntegrity).toMatchObject({ status: "error", failure: "incomplete" });
    expect(corrupt.taskIdIntegrity.status).toBe("anomaly");
    expect(corrupt.taskIdIntegrity).not.toHaveProperty("failure");
  });

  it("keeps the published canary a non-nullable boolean so unmeasured cannot read as clean", () => {
    /*
    FNXC:TaskIdIntegrityCanary 2026-09-26-02:14 (RUFU-301):
    The tri-state option (`corruptionDetected: null`) was rejected deliberately:
    every consumer truthiness-checks a corruption canary, so `null` would read as
    falsy-clean and relocate the blindness instead of removing it. Compile-time
    pin — a nullable wire field fails typecheck, not this test body.
    */
    const published = payload(database(), CLEAN_INTEGRITY);

    expectTypeOf(published.database.corruptionDetected).toEqualTypeOf<boolean>();
    expectTypeOf<DashboardDatabaseHealth["corruptionDetected"]>().toEqualTypeOf<boolean>();
    expect(typeof published.database.corruptionDetected).toBe("boolean");
  });
});
